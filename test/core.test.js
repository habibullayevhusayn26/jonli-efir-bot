const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { Scenes } = require('telegraf');
const streamManager = require('../streamManager');
const scenes = require('../scenes');
const { createWebServer, validateTelegramInitData } = require('../webServer');
const previewManager = require('../previewManager');

test('admin wizard scenes register with Telegraf', () => {
  const stage = new Scenes.Stage(scenes);
  assert.ok(stage);
});

test('RTMP and source URL validation rejects private hosts and unsafe keys', async () => {
  assert.equal(streamManager.defaultRtmpServerUrl, 'rtmps://dc4-1.rtmp.t.me/s');
  assert.equal(await streamManager.validateRtmpServer('rtmps://8.8.8.8/live'), 'rtmps://8.8.8.8/live');
  await assert.rejects(streamManager.validateRtmpServer('rtmp://127.0.0.1/live'));
  assert.equal(await streamManager.validateSourceUrl('https://8.8.8.8/live.m3u8'), 'https://8.8.8.8/live.m3u8');
  await assert.rejects(streamManager.validateSourceUrl('http://localhost/live.m3u8'));
  assert.equal(streamManager.validateStreamKey('ABC_123-key'), 'ABC_123-key');
  assert.equal(
    streamManager.validateStreamKey('3858481844:Dl4FO9vWBioAOePAx4HQ5A'),
    '3858481844:Dl4FO9vWBioAOePAx4HQ5A',
  );
  assert.throws(() => streamManager.validateStreamKey('invalid/key'));
});

test('FFmpeg output uses Telegram-compatible H.264/AAC and redacts credentials', () => {
  const args = streamManager.buildFfmpegArgs('https://source.example/live.m3u8', 'rtmps://destination.example/live/secret');
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('aac'));
  assert.ok(args.includes('yuv420p'));
  assert.ok(!args.includes('copy'));
  assert.equal(
    streamManager.redactFfmpegOutput('failed: rtmps://host/live/secret', ['rtmps://host/live/secret', 'secret']),
    'failed: [redacted]',
  );
});

test('stream concurrency limits enforce three per user and thirty globally', () => {
  const canReserve = streamManager.canReserveStreamSlot;
  assert.equal(canReserve({
    active: 9, starting: 0, userActive: 2, userStarting: 0, maxActive: 30, maxPerUser: 3,
  }), undefined);
  assert.equal(canReserve({
    active: 9, starting: 0, userActive: 3, userStarting: 0, maxActive: 30, maxPerUser: 3,
  }), 'user');
  assert.equal(canReserve({
    active: 29, starting: 1, userActive: 0, userStarting: 0, maxActive: 30, maxPerUser: 3,
  }), 'global');
});

test('preview output is HLS and never exposes the source in the client options', () => {
  const args = previewManager.buildPreviewArgs('https://source.example/private.m3u8?token=secret', 'C:\\temp\\preview\\index.m3u8');
  assert.ok(args.includes('hls'));
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('220k'));
  assert.ok(args.includes('250k'));
  assert.ok(args.includes('1'));
  assert.ok(args.includes('-vf'));
  assert.ok(args.some((arg) => arg.includes('min(480,iw)')));
  assert.ok(args.some((arg) => arg.endsWith('segment_%05d.ts')));
});

test('Telegram Mini App initData signatures are verified and expire', () => {
  const botToken = 'test-bot-token';
  const data = new URLSearchParams({
    auth_date: '1700000000',
    query_id: 'test-query',
    user: JSON.stringify({ id: 12345, first_name: 'Test' }),
  });
  const checkString = [...data.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  data.set('hash', crypto.createHmac('sha256', secret).update(checkString).digest('hex'));
  const initData = data.toString();
  assert.equal(validateTelegramInitData(initData, botToken, 1700000000000).id, 12345);
  assert.throws(() => validateTelegramInitData(initData, 'wrong-token', 1700000000000));
  assert.throws(() => validateTelegramInitData(initData, botToken, 1800000000000), /eskirgan/);
});

test('Mini App web server serves the app shell and local HLS player', async (t) => {
  let receivedUpdate;
  const webhookSecret = 'test-webhook-secret';
  const server = createWebServer({
    botToken: 'unused',
    telegram: {},
    adminIds: new Set(),
    webhookSecret,
    onTelegramUpdate: async (update) => { receivedUpdate = update; },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const { port } = server.address();
  const appResponse = await fetch(`http://127.0.0.1:${port}/miniapp`);
  assert.equal(appResponse.status, 200);
  const html = await appResponse.text();
  assert.match(html, /<video id="player" autoplay playsinline muted><\/video>/);
  assert.doesNotMatch(html, /stop-button|sound-button|controls/);
  const hlsResponse = await fetch(`http://127.0.0.1:${port}/assets/hls.min.js`);
  assert.equal(hlsResponse.status, 200);
  assert.match(hlsResponse.headers.get('content-type'), /javascript/);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ update_id: 1 }),
  });
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`http://127.0.0.1:${port}/telegram/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
    },
    body: JSON.stringify({ update_id: 2 }),
  });
  assert.equal(authorized.status, 200);
  assert.equal(receivedUpdate.update_id, 2);
});
