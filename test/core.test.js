const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scenes } = require('telegraf');
const streamManager = require('../streamManager');
const scenes = require('../scenes');

test('admin wizard scenes register with Telegraf', () => {
  const stage = new Scenes.Stage(scenes);
  assert.ok(stage);
});

test('RTMP and source URL validation rejects private hosts and unsafe keys', async () => {
  assert.equal(await streamManager.validateRtmpServer('rtmps://8.8.8.8/live'), 'rtmps://8.8.8.8/live');
  await assert.rejects(streamManager.validateRtmpServer('rtmp://127.0.0.1/live'));
  assert.equal(await streamManager.validateSourceUrl('https://8.8.8.8/live.m3u8'), 'https://8.8.8.8/live.m3u8');
  await assert.rejects(streamManager.validateSourceUrl('http://localhost/live.m3u8'));
  assert.equal(streamManager.validateStreamKey('ABC_123-key'), 'ABC_123-key');
  assert.throws(() => streamManager.validateStreamKey('invalid/key'));
});
