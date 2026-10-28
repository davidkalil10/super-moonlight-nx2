const test = require('node:test');
const assert = require('node:assert/strict');
const ring = require('../../../hbl-moonlight/tools/moonlight/ring.js');
const {metadata} = require('../../../hbl-moonlight/host/stream/publication-metadata.js');

const mapped = 0x40000000;
const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
const destination = {
  index: 1,
  address: mapped + ring.frameOffset(1),
  bytes: ring.FRAME_BYTES,
  sequence: 10,
  color: 1
};

test('publication metadata packs the surface, layout, checksum and sequence', () => {
  const bytes = metadata(destination, frame);
  assert.equal(bytes.length, 32);
  assert.deepEqual(
    [0, 4, 8, 12, 16, 20].map(offset => bytes.readUInt32LE(offset)),
    [1, 1920, 1080, 1920, 1088, 1]
  );
  assert.equal(bytes.readUInt32LE(24), ring.nativeChecksum(10, [1, 1920, 1080, 1920, 1088, 1]));
  assert.equal(bytes.readUInt32LE(28), 10);
});

test('publication metadata rejects an unknown surface and an oversized layout', () => {
  assert.throws(() => metadata({...destination, index: 3}, frame), /Invalid native output/);
  assert.throws(() => metadata({...destination, sequence: 0}, frame), /Invalid native output/);
  assert.throws(
    () => metadata(destination, {...frame, sliceHeight: 2000}),
    /Invalid native output/
  );
});
