const test = require('node:test');
const assert = require('node:assert/strict');
const output = require('./staggered-output-plan.cjs');
const status = require('./staggered-status.cjs');
const ring = require('./ring.cjs');
const SYNC = require('../../sdk/native/os-sync-functions.json');

const addresses = {
  sdk: 0x7100000000,
  base: 0x7200000000,
  control: 0x7300000000,
  mapped: 0x7400000000,
  event: 0x7500000000,
  functions: {
    acquireOutput: 0x7600000000,
    bufferSetData: 0x7600001000,
    getOutput: 0x7600002000,
    releaseOutput: 0x7600003000
  },
  decoder: 0x7700000000,
  output: 0x7700001000,
  format: 0x7700002000
};

test('staggered output frames acquire before a host fetch gate and publish once', () => {
  const built = output.plan(addresses);
  for (let slot = 0; slot < 2; slot++) {
    assert.ok(built.acquire[slot].frame.length < 0x70000);
    assert.ok(built.fetch[slot].frame.length < 0x70000);
    assert.equal(built.calls.acquire[slot][0].function, addresses.sdk + SYNC.waitEvent.offset);
    assert.equal(built.calls.acquire[slot][1].function, addresses.functions.acquireOutput);
    assert.equal(
      built.calls.acquire[slot][4].args[0].u64,
      addresses.control + output.CONTROL.fetchDispatch[slot]
    );
    assert.equal(built.calls.fetch[slot][1].function, addresses.functions.getOutput);
    assert.equal(built.calls.fetch[slot][2].function, addresses.functions.releaseOutput);
    assert.equal(
      built.calls.fetch[slot].at(-1).args[0].u64,
      addresses.control + output.CONTROL.acquireDispatch[slot]
    );
  }
  assert.equal(
    built.calls.acquire[0][1].args[1],
    addresses.mapped + status.STATUS.acquire + 8
  );
  assert.equal(
    built.calls.fetch[0][4].args[0],
    addresses.mapped + ring.CONTROL.nativeSequence
  );
});

test('staggered output descriptor checks ring surface and commits matching metadata', () => {
  const publication = {mapped: addresses.mapped, color: 1};
  const destination = {
    index: 2,
    address: addresses.mapped + ring.frameOffset(2),
    bytes: ring.FRAME_BYTES,
    sequence: 12,
    color: 1
  };
  const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
  const bytes = output.outputDescriptor({auSequence: 7, destination, frame, publication});
  assert.equal(bytes.length, 0x80);
  assert.equal(bytes.readUInt32LE(0), 7);
  assert.equal(bytes.readBigUInt64LE(8), BigInt(destination.address));
  assert.equal(bytes.readUInt32LE(24), 2);
  assert.equal(bytes.readUInt32LE(24 + 28), 12);
  assert.throws(
    () =>
      output.outputDescriptor({
        auSequence: 7,
        destination: {...destination, index: 1},
        frame,
        publication
      }),
    /target/
  );
});
