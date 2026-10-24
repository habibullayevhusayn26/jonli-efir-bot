const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveSource } = require('./streamManager');

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const requestedMaxPreviews = Number.parseInt(process.env.MAX_PREVIEWS || '2', 10);
const maxPreviews = Number.isSafeInteger(requestedMaxPreviews) ? Math.max(1, requestedMaxPreviews) : 2;
const previewDurationMs = 5 * 60 * 1000;
const userStartCooldownMs = 15_000;
const sessions = new Map();
const userStarts = new Map();

function buildPreviewArgs(sourceUrl, outputPath) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-re', '-reconnect', '1', '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', sourceUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-r', '25', '-g', '50',
    '-b:v', '1200k', '-maxrate', '1200k', '-bufsize', '2400k',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '2',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_filename', path.join(path.dirname(outputPath), 'segment_%05d.ts'),
    outputPath,
  ];
}

async function waitForPlaylist(session) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (session.exitError) throw session.exitError;
    try {
      const stat = await fs.stat(session.playlistPath);
      if (stat.size > 0) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Preview videosi 30 soniyada tayyor bo‘lmadi. Manba ishlayotganini tekshiring.');
}

async function start({ userId, template }) {
  for (const [startedBy, startedAt] of userStarts) {
    if (Date.now() - startedAt >= userStartCooldownMs) userStarts.delete(startedBy);
  }
  const lastStartedAt = userStarts.get(userId) || 0;
  if (Date.now() - lastStartedAt < userStartCooldownMs) {
    throw new Error('Previewni qayta boshlashdan oldin 15 soniya kuting.');
  }
  const currentUserSession = [...sessions.values()].find((session) => session.userId === userId);
  if (currentUserSession) await stop(currentUserSession.id);
  if (sessions.size >= maxPreviews) {
    throw new Error('Hozir preview serveri band. Boshqa foydalanuvchi previewni tugatishini kutib qayta urinib ko‘ring.');
  }
  userStarts.set(userId, Date.now());

  let sourceUrl;
  try {
    sourceUrl = await resolveSource(template.source_url);
  } catch (error) {
    throw new Error(error.message.replaceAll(template.source_url, '[manba URL yashirildi]'));
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-stream-preview-'));
  const id = crypto.randomBytes(32).toString('hex');
  const playlistPath = path.join(directory, 'index.m3u8');
  const child = spawn(ffmpegPath, buildPreviewArgs(sourceUrl, playlistPath), {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const session = {
    id,
    userId,
    child,
    directory,
    playlistPath,
    expiresAt: Date.now() + previewDurationMs,
    stderr: '',
    exitError: undefined,
    stopPromise: undefined,
    expiryTimer: undefined,
  };
  sessions.set(id, session);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    session.stderr = `${session.stderr}${chunk}`.slice(-1200);
  });
  child.once('error', (error) => {
    session.exitError = new Error(error.code === 'ENOENT'
      ? 'Preview uchun FFmpeg topilmadi.'
      : 'Preview FFmpeg jarayonini ishga tushirib bo‘lmadi.');
  });
  child.once('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      const diagnostic = session.stderr.replaceAll(sourceUrl, '[manba yashirildi]').trim().slice(-350);
      session.exitError = new Error(`Preview FFmpeg to‘xtadi: ${diagnostic || `code ${code}`}`);
    }
    if (!session.stopPromise) void stop(id);
  });

  session.expiryTimer = setTimeout(() => {
    void stop(id);
  }, previewDurationMs);
  session.expiryTimer.unref();

  try {
    await waitForPlaylist(session);
    if (!sessions.has(id)) throw new Error('Preview jarayoni to‘xtatildi.');
    return { id, expiresAt: session.expiresAt };
  } catch (error) {
    await stop(id);
    throw new Error(error.message.replaceAll(sourceUrl, '[manba URL yashirildi]'));
  }
}

async function readFile(id, filename) {
  if (!/^[a-f0-9]{64}$/.test(id) || !/^(index\.m3u8|segment_\d{5}\.ts)$/.test(filename)) {
    return undefined;
  }
  const session = sessions.get(id);
  if (!session) return undefined;
  if (Date.now() >= session.expiresAt || session.child.exitCode !== null || session.child.signalCode !== null) {
    await stop(id);
    return undefined;
  }
  const filePath = path.join(session.directory, filename);
  try {
    const content = await fs.readFile(filePath);
    return {
      content,
      contentType: filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      expiresAt: session.expiresAt,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function stop(id, userId) {
  const session = sessions.get(id);
  if (!session || (userId !== undefined && session.userId !== userId)) return false;
  if (session.stopPromise) return session.stopPromise;

  session.stopPromise = (async () => {
    clearTimeout(session.expiryTimer);
    if (session.child.exitCode === null && session.child.signalCode === null) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          session.child.kill('SIGKILL');
        }, 3000);
        session.child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        session.child.kill('SIGTERM');
      });
    }
    sessions.delete(id);
    await fs.rm(session.directory, { recursive: true, force: true });
    return true;
  })();
  return session.stopPromise;
}

async function stopAll() {
  await Promise.all([...sessions.keys()].map((id) => stop(id)));
}

module.exports = { start, readFile, stop, stopAll, buildPreviewArgs };
