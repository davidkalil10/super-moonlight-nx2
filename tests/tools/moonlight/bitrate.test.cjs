const test = require('node:test');
const assert = require('node:assert/strict');
const {defaultBitrate, bitrate} = require('../../../hbl-moonlight/tools/moonlight/bitrate.js');

test('default bitrate follows Moonlight for common modes', () => {
  assert.equal(defaultBitrate(1280, 720, 60), 10000);
  assert.equal(defaultBitrate(1920, 1080, 30), 10000);
  assert.equal(defaultBitrate(1920, 1080, 60), 20000);
  assert.equal(defaultBitrate(1920, 1080, 120), 28000);
  assert.equal(defaultBitrate(1280, 720, 120), 14000);
  assert.equal(defaultBitrate(1600, 900, 60), 15000);
});

test('an explicit bitrate wins and auto or absent computes one', () => {
  assert.equal(bitrate(['--bitrate', '8000'], 1920, 1080, 60), '8000');
  assert.equal(bitrate(['--bitrate', 'auto'], 1920, 1080, 90), '24000');
  assert.equal(bitrate([], 1920, 1080, 60), '20000');
  assert.throws(() => bitrate(['--bitrate', 'fast'], 1920, 1080, 60));
});
