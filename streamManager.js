const { spawn } = require('node:child_process');
const dns = require('node:dns').promises;
const net = require('node:net');
const ipaddr = require('ipaddr.js');
const db = require('./database');

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
const processes = new Map();

function parseHttpUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} URL formati noto‘g‘ri.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${label} faqat foydalanuvchi nomi/parolsiz HTTP yoki HTTPS URL bo‘lishi kerak.`);
  }
  return parsed;
}

function isPublicAddress(address) {
  try {
    const parsed = ipaddr.parse(address);
    const normalized = parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()
      ? parsed.toIPv4Address()
      : parsed;
    return normalized.range() === 'unicast';
  } catch {
    return false;
  }
}

async function assertPublicHost(hostname) {
  const records = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!records.length || records.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('URL ommaviy internetdagi manzilga yechilishi kerak.');
  }
}

async function validateSourceUrl(value) {
  const parsed = parseHttpUrl(value, 'Manba');
  const isYoutube = parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com') ||
    parsed.hostname === 'youtu.be' || parsed.hostname.endsWith('.youtu.be');
  await assertPublicHost(parsed.hostname);
  if (isYoutube && !['youtube.com', 'youtu.be'].includes(parsed.hostname)) {
    throw new Error('Faqat youtube.com yoki youtu.be manbalari qabul qilinadi.');
  }
  return parsed.toString();
}

async function validateRtmpServer(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('RTMP Server URL formati noto‘g‘ri.');
  }
  if (!['rtmp:', 'rtmps:'].includes(parsed.protocol) || !parsed.hostname ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Faqat rtmp:// or rtmps:// server URL qabul qilinadi.');
  }
  await assertPublicHost(parsed.hostname);
  return parsed.toString().replace(/\/$/, '');
}

function validateStreamKey(value) {
  if (!/^[A-Za-z0-9:_-]{4,256}$/.test(value)) {
    throw new Error('Stream Key 4–256 ta harf, raqam, ikki nuqta, chiziqcha yoki pastki chiziqdan iborat bo‘lishi kerak.');
  }
  return value;
}

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(ytdlpPath, [
      '--no-warnings', '--no-playlist', '--format', 'best', '--get-url', url,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('YouTube manbasini ochish vaqti tugadi.'));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk.slice(0, 1000); });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(error.code === 'ENOENT' ? 'YouTube manbalari uchun yt-dlp o‘rnatilishi kerak.' : 'YouTube manbasini ochib bo‘lmadi.'));
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      const resolved = stdout.trim().split(/\r?\n/)[0];
      if (code !== 0 || !resolved) {
        reject(new Error(`YouTube manbasini ochib bo‘lmadi${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : '.'}`));
        return;
      }
      resolve(resolved);
    });
  });
}

async function resolveSource(sourceUrl) {
  const parsed = new URL(sourceUrl);
  const isYoutube = parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com') ||
    parsed.hostname === 'youtu.be' || parsed.hostname.endsWith('.youtu.be');
  const resolved = isYoutube ? await runYtDlp(sourceUrl) : sourceUrl;
  const safeUrl = parseHttpUrl(resolved, 'Manba');
  await assertPublicHost(safeUrl.hostname);
  return safeUrl.toString();
}

function buildFfmpegArgs(sourceUrl, outputUrl) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-re', '-reconnect', '1', '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', sourceUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60',
    '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-f', 'flv', outputUrl,
  ];
}

function redactFfmpegOutput(output, secrets) {
  return secrets.reduce((result, secret) => {
    if (!secret) return result;
    return result.replaceAll(secret, '[redacted]');
  }, output);
}

function start({ userId, template, serverUrl, streamKey, onExit }) {
  return resolveSource(template.source_url).then((sourceUrl) => new Promise((resolve, reject) => {
    const outputUrl = `${serverUrl}/${streamKey}`;
    const args = buildFfmpegArgs(sourceUrl, outputUrl);
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false;
    let exited = false;
    let broadcast;
    let cleanupPromise = Promise.resolve();
    let errorTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errorTail = `${errorTail}${chunk}`.slice(-2000);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (error.code === 'ENOENT') reject(new Error('FFmpeg topilmadi. Uni o‘rnating yoki FFMPEG_PATH ni sozlang.'));
      else reject(new Error('FFmpeg jarayonini ishga tushirib bo‘lmadi.'));
    });
    child.once('exit', (code, signal) => {
      exited = true;
      if (!broadcast) return;
      cleanupPromise = db.deleteBroadcast(broadcast.id).then(() => {
        processes.delete(child.pid);
        const intentionalStop = signal === 'SIGTERM' || signal === 'SIGINT';
        const diagnostic = redactFfmpegOutput(errorTail.trim(), [outputUrl, streamKey, sourceUrl]).slice(-700);
        if (code !== 0 && !intentionalStop) {
          console.error(`FFmpeg exited for broadcast ${broadcast.id} (code ${code}, signal ${signal}): ${diagnostic}`);
        }
        if (onExit && !intentionalStop) {
          return onExit({ clean: code === 0, diagnostic }).catch((error) => {
            console.error(`Stream exit notification failed for broadcast ${broadcast.id}: ${error.message}`);
          });
        }
      }).catch((error) => {
        console.error(`Broadcast cleanup failed for ${broadcast.id}: ${error.message}`);
      });
      const running = processes.get(child.pid);
      if (running) running.cleanup = cleanupPromise;
    });
    child.once('spawn', async () => {
      try {
        const id = await db.addBroadcast(userId, template.id, child.pid);
        broadcast = { id: Number(id), pid: child.pid, userId };
        if (exited) {
          await db.deleteBroadcast(broadcast.id);
          if (!settled) {
            settled = true;
            reject(new Error('FFmpeg ishga tushishi bilan to‘xtab qoldi.'));
          }
          return;
        }
        processes.set(child.pid, { child, broadcast, cleanup: cleanupPromise });
        if (settled) return;
        settled = true;
        resolve(broadcast);
      } catch (error) {
        child.kill();
        if (!settled) {
          settled = true;
          reject(error);
        } else {
          console.error(`Could not save active broadcast for PID ${child.pid}: ${error.message}`);
        }
      }
    });
  }));
}

async function stop(broadcastId, userId) {
  const record = await db.getBroadcast(Number(broadcastId));
  if (!record || record.user_id !== userId) return false;
  const running = processes.get(record.pid);
  if (!running) {
    await db.deleteBroadcast(record.id);
    return false;
  }
  running.child.kill('SIGTERM');
  return true;
}

function stopAll() {
  const activeChildren = [...processes.values()].map(({ child }) => child);
  return Promise.all(activeChildren.map((child) => new Promise((resolve, reject) => {
    const running = processes.get(child.pid);
    if (child.exitCode !== null || child.signalCode !== null) {
      Promise.resolve(running ? running.cleanup : undefined).then(resolve, reject);
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      const cleanup = processes.get(child.pid);
      Promise.resolve(cleanup ? cleanup.cleanup : undefined).then(resolve, reject);
    });
    try {
      child.kill('SIGTERM');
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  })));
}

function clearStaleRecords() {
  return db.clearStaleBroadcasts();
}

module.exports = {
  start,
  stop,
  stopAll,
  clearStaleRecords,
  validateSourceUrl,
  validateRtmpServer,
  validateStreamKey,
  buildFfmpegArgs,
  redactFfmpegOutput,
  resolveSource,
};
