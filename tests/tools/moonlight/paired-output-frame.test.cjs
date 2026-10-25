const test = require('node:test');
const assert = require('node:assert/strict');
const ring = require('../../../hbl-moonlight/tools/moonlight/ring.cjs');
const {plan, metadata} = require('../../../hbl-moonlight/tools/moonlight/paired-output-frame.cjs');

const sdk = 0x10000000;
const decoder = 0x30000000;
const output = decoder + 0x300;
const format = decoder + 0x180;
const mapped = 0x40000000;
const base = 0x50000000;
const functions = {
  bufferSetData: 0x60000000,
  getOutput: 0x60000004,
  releaseOutput: 0x60000008
};
const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
const destinations = [1, 2].map((index, offset) => ({
  index,
  address: mapped + ring.frameOffset(index),
  bytes: ring.FRAME_BYTES,
  sequence: offset + 10,
  color: 1
}));

test('paired output publishes one checked surface at a time', () => {
  const options = {
    sdk,
    functions,
    decoder,
    output,
    format,
    publication: {mapped, color: 1},
    acquired: [
      {status: 0, index: 0, pts: 1n},
      {status: 0, index: 1, pts: 2n}
    ],
    acquiredSlots: [0x70000000, 0x70000040],
    metadataSlots: [0x70000100, 0x70000140],
    destinations,
    frame,
    base
  };
  const first = plan({...options, index: 0});
  const second = plan({...options, index: 1});
  for (const result of [first, second]) {
    assert.equal(result.program.proof.logicalCalls, 5);
    assert.ok(result.program.frame.length < 0x300000);
    const row = result.rows[0];
    assert.ok(row.set < row.fetch && row.fetch < row.release);
    assert.ok(row.release < row.metadata && row.metadata < row.commit);
  }
  assert.equal(first.metadataBytes[0].readUInt32LE(0), 1);
  assert.equal(second.metadataBytes[1].readUInt32LE(0), 2);
  assert.equal(first.metadataBytes[0].readUInt32LE(28), 10);
  assert.equal(second.metadataBytes[1].readUInt32LE(28), 11);
  assert.equal(
    first.metadataBytes[0].readUInt32LE(24),
    ring.nativeChecksum(10, [1, 1920, 1080, 1920, 1088, 1])
  );
});

test('paired output rejects reuse of a surface and oversized decoded layout', () => {
  const options = {
    sdk,
    functions,
    decoder,
    output,
    format,
    publication: {mapped, color: 1},
    acquired: [
      {status: 0, index: 0, pts: 1n},
      {status: 0, index: 1, pts: 2n}
    ],
    acquiredSlots: [0x70000000, 0x70000040],
    metadataSlots: [0x70000100, 0x70000140],
    destinations,
    frame,
    base,
    index: 0
  };
  assert.throws(() => plan({...options, index: undefined}), /distinct ordered surfaces/);
  assert.throws(
    () => plan({...options, destinations: [destinations[0], destinations[0]]}),
    /distinct ordered surfaces/
  );
  assert.throws(
    () => metadata(destinations[0], {...frame, sliceHeight: 2000}),
    /Invalid paired output/
  );
  assert.throws(
    () =>
      plan({
        ...options,
        acquired: [
          {status: 0, index: 0, pts: 1n},
          {status: 0x100e, index: -1, pts: 2n}
        ]
      }),
    /distinct ordered surfaces/
  );
});
