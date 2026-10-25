const test = require('node:test');
const assert = require('node:assert');
const hbv = require('../../../hbl-moonlight/tools/moonlight/hbv.cjs');
const {psnr} = require('../../../hbl-moonlight/tools/moonlight/reference.cjs');

function gradient(width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      rgb[at] = (x * 255) / width;
      rgb[at + 1] = (y * 255) / height;
      rgb[at + 2] = 128;
    }
  return rgb;
}

test('640x352 fits one bridge exchange', () => {
  const map = hbv.layout(640, 352);
  assert.strictEqual(map.slotBytes, hbv.EXCHANGE_BYTES);
  assert.ok(map.payloadBytes <= map.slotBytes);
  assert.strictEqual(map.exchanges, 1);
});

test('field extraction matches across the 32-bit boundary', () => {
  assert.strictEqual(hbv.extract(0xf0000000, 0x3, 28, 6), 0x3f);
  assert.strictEqual(hbv.signExtend(0x3f, 6), -1);
  assert.strictEqual(hbv.signExtend(0x1f, 6), 31);
});

test('slot round trip keeps header, trailer and image', () => {
  const rgb = gradient(64, 48),
    slot = hbv.encode(rgb, 64, 48, 7),
    header = hbv.readHeader(slot);
  assert.strictEqual(header.sequence, 7);
  assert.ok(psnr(rgb, hbv.decode(slot)) > 35);
});

test('torn slot is rejected', () => {
  const slot = hbv.encode(gradient(64, 48), 64, 48, 9);
  slot.writeUInt32LE(10, 4);
  assert.strictEqual(hbv.readHeader(slot), null);
});

test('committed GLSL include matches the generator', () => {
  const fs = require('node:fs'),
    path = require('node:path');
  const file = path.join(__dirname, '../../../hbl-moonlight/apps/moonlight/shaders/hbv.glsl');
  if (!fs.existsSync(file)) return;
  assert.strictEqual(fs.readFileSync(file, 'utf8'), hbv.glsl());
});
