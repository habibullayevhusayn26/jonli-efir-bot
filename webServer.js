const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const db = require('./database');
const previewManager = require('./previewManager');

const publicDirectory = path.join(__dirname, 'public');
const maxBodyBytes = 16 * 1024;
const maxAuthAgeSeconds = 24 * 60 * 60;

function validateTelegramInitData(initData, botToken, now = Date.now()) {
  if (typeof initData !== 'string' || !initData || initData.length > 8192) {
    throw new Error('Telegram Mini App tasdiqlash ma’lumoti yo‘q.');
  }
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const userValue = params.get('user');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) ||
      !Number.isSafeInteger(authDate) || !userValue) {
    throw new Error('Telegram Mini App tasdiqlash ma’lumoti noto‘g‘ri.');
  }
  if (authDate > Math.floor(now / 1000) + 60 ||
      Math.floor(now / 1000) - authDate > maxAuthAgeSeconds) {
    throw new Error('Telegram Mini App sessiyasi eskirgan. Botdan qayta oching.');
  }
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  const actualHash = Buffer.from(receivedHash, 'hex');
  if (actualHash.length !== expectedHash.length || !crypto.timingSafeEqual(actualHash, expectedHash)) {
    throw new Error('Telegram Mini App imzosi tasdiqlanmadi.');
  }
  let user;
  try {
    user = JSON.parse(userValue);
  } catch {
    throw new Error('Telegram foydalanuvchi ma’lumoti noto‘g‘ri.');
  }
  if (!Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new Error('Telegram foydalanuvchi ID’si noto‘g‘ri.');
  }
  return user;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('So‘rov hajmi juda katta.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('JSON obyekt bo‘lishi kerak.');
    }
    return value;
  } catch {
    throw new Error('JSON so‘rovi noto‘g‘ri.');
  }
}

async function isSubscribed(telegram, userId, adminIds) {
  if (adminIds.has(userId)) return true;
  for (const channel of await db.getRequiredChannels()) {
    try {
      const member = await telegram.getChatMember(channel.chat_id, userId);
      if (!['creator', 'administrator', 'member'].includes(member.status) &&
          !(member.status === 'restricted' && member.is_member)) return false;
    } catch (error) {
      console.error(`Preview membership check failed for ${channel.chat_id}: ${error.message}`);
      return false;
    }
  }
  return true;
}

async function serveStatic(response, filename, contentType) {
  try {
    const content = await fs.readFile(path.join(publicDirectory, filename));
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src blob:; img-src 'self' data:",
      'Referrer-Policy': 'no-referrer',
    });
    response.end(content);
  } catch (error) {
    console.error(`Could not serve Mini App asset ${filename}: ${error.message}`);
    sendJson(response, 500, { error: 'Mini App faylini yuklab bo‘lmadi.' });
  }
}

function createWebServer({ botToken, telegram, adminIds, onTelegramUpdate, webhookSecret }) {
  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && (requestUrl.pathname === '/health' || requestUrl.pathname === '/')) {
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('ok');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/miniapp') {
        await serveStatic(response, 'index.html', 'text/html; charset=utf-8');
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/telegram/webhook') {
        const providedSecret = request.headers['x-telegram-bot-api-secret-token'];
        const expected = Buffer.from(webhookSecret || '');
        const provided = Buffer.from(typeof providedSecret === 'string' ? providedSecret : '');
        if (!expected.length || expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
          sendJson(response, 401, { error: 'Webhook tasdiqlanmadi.' });
          return;
        }
        let update;
        try {
          update = await readJson(request);
        } catch (error) {
          sendJson(response, 400, { error: error.message });
          return;
        }
        await onTelegramUpdate(update);
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('ok');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/assets/app.css') {
        await serveStatic(response, 'app.css', 'text/css; charset=utf-8');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/assets/app.js') {
        await serveStatic(response, 'app.js', 'application/javascript; charset=utf-8');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/assets/hls.min.js') {
        const hlsPath = require.resolve('hls.js/dist/hls.min.js');
        response.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        });
        require('node:fs').createReadStream(hlsPath).pipe(response);
        return;
      }

      const previewFileMatch = requestUrl.pathname.match(/^\/previews\/([a-f0-9]{64})\/(index\.m3u8|segment_\d{5}\.ts)$/);
      if (request.method === 'GET' && previewFileMatch) {
        const file = await previewManager.readFile(previewFileMatch[1], previewFileMatch[2]);
        if (!file) {
          response.writeHead(404, { 'Cache-Control': 'no-store' });
          response.end();
          return;
        }
        response.writeHead(200, {
          'Content-Type': file.contentType,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(file.content);
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/previews') {
        let body;
        body = await readJson(request).catch((error) => {
          sendJson(response, 400, { error: error.message });
          return undefined;
        });
        if (!body) return;
        let user;
        try {
          user = validateTelegramInitData(body.initData, botToken);
        } catch (error) {
          sendJson(response, 401, { error: error.message });
          return;
        }
        if (!(await isSubscribed(telegram, user.id, adminIds))) {
          sendJson(response, 403, { error: 'Preview ko‘rish uchun botdagi majburiy kanallarga obuna bo‘ling.' });
          return;
        }
        const templateId = Number(body.templateId);
        if (!Number.isSafeInteger(templateId) || templateId <= 0) {
          sendJson(response, 400, { error: 'Stream shabloni noto‘g‘ri.' });
          return;
        }
        const template = await db.getTemplate(templateId);
        if (!template) {
          sendJson(response, 404, { error: 'Stream shabloni topilmadi.' });
          return;
        }
        try {
          const preview = await previewManager.start({ userId: user.id, template });
          sendJson(response, 201, {
            playlistUrl: `/previews/${preview.id}/index.m3u8`,
            expiresAt: preview.expiresAt,
          });
        } catch (error) {
          console.error(`Preview startup failed for template ${templateId}: ${error.message}`);
          sendJson(response, 502, { error: error.message });
        }
        return;
      }

      const stopMatch = requestUrl.pathname.match(/^\/api\/previews\/([a-f0-9]{64})$/);
      if (request.method === 'DELETE' && stopMatch) {
        let body;
        body = await readJson(request).catch((error) => {
          sendJson(response, 400, { error: error.message });
          return undefined;
        });
        if (!body) return;
        let user;
        try {
          user = validateTelegramInitData(body.initData, botToken);
        } catch (error) {
          sendJson(response, 401, { error: error.message });
          return;
        }
        const stopped = await previewManager.stop(stopMatch[1], user.id);
        sendJson(response, stopped ? 200 : 404, stopped ? { stopped: true } : { error: 'Preview topilmadi.' });
        return;
      }

      sendJson(response, 404, { error: 'Sahifa topilmadi.' });
    } catch (error) {
      console.error(`Mini App request failed: ${error.message}`);
      if (!response.headersSent) sendJson(response, 500, { error: 'Serverda kutilmagan xatolik yuz berdi.' });
      else response.destroy();
    }
  });
}

module.exports = { createWebServer, validateTelegramInitData };
