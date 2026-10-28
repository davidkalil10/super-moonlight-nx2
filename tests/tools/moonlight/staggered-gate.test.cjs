const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../../../host/stream/staggered-gate.js');
const input = require('../../../host/stream/staggered-input-plan.js');
const output = require('../../../host/stream/staggered-output-plan.js');
const ring = require('../../../tools/moonlight/ring.js');

function snapshot() {
  return {
    current: 2,
    nativeApplied: 11,
    receive: {count: 40000n, sequence: 5},
    input: {sendStatus: 0n, nextSlotStatus: 0n, nextIndex: 1, sequence: 4},
    acquire: {status: 0n, index: 0, pts: 3n, sequence: 3},
    fetch: {setStatus: 0n, getStatus: 0n, releaseStatus: 0n, sequence: 2}
  };
}

const publication = {mapped: 0x7400000000, color: 1};
const destination = {
  index: 0,
  address: publication.mapped + ring.frameOffset(0),
  bytes: ring.FRAME_BYTES,
  sequence: 12,
  color: 1
};
const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
const request = {
  expected: {
    receive: {sequence: 5, bytes: 40000},
    input: {sequence: 4},
    acquire: {sequence: 3, pts: 3n},
    fetch: {sequence: 2},
    ack: {sequence: 11, index: 2}
  },
  inputSlot: {index: 1, address: 0x7900000000, capacity: 0x100000},
  current: {sequence: 5, length: 40000, pts: 5n},
  next: {sequence: 6, length: 41000, pts: 6n},
  fetchGate: 0x7300000020,
  ignoredFetchGate: 0x7300000010,
  publication,
  destination,
  frame
};

test('one checked write carries current decode, next receive and lag-two fetch', () => {
  const {offset, bytes} = gate.gateWrite({snapshot: snapshot(), ...request});
  assert.equal(offset, input.CONTROL.descriptors[0]);
  assert.equal(bytes.length, gate.WRITE_BYTES);
  assert.equal(bytes.readUInt32LE(0), 5);
  assert.equal(bytes.readUInt32LE(input.DESCRIPTOR.bytes), 6);
  const outputSlot0 = output.CONTROL.descriptors[0] - offset;
  const outputSlot1 = output.CONTROL.descriptors[1] - offset;
  assert.equal(bytes.readUInt32LE(outputSlot0), 3);
  assert.equal(bytes.readBigUInt64LE(outputSlot0 + 8), BigInt(destination.address));
  assert.equal(bytes.readUInt32LE(outputSlot0 + 24 + 28), destination.sequence);
  assert.equal(bytes.readUInt32LE(outputSlot1), 4);
  assert.equal(bytes.readBigUInt64LE(outputSlot1 + 8), 0n);
});

test('fetch remains closed when the acquired output or publication target differs', () => {
  const wrong = snapshot();
  wrong.acquire.pts = 4n;
  assert.throws(() => gate.gateWrite({snapshot: wrong, ...request}), /output status/);
  assert.throws(
    () =>
      gate.gateWrite({snapshot: snapshot(), ...request, destination: {...destination, index: 1}}),
    /target/
  );
  const shifted = snapshot();
  shifted.acquire.sequence = 4;
  assert.throws(
    () =>
      gate.gateWrite({
        snapshot: shifted,
        ...request,
        expected: {...request.expected, acquire: {sequence: 4, pts: 3n}}
      }),
    /two AUs/
  );
});

test('bootstrap writes sequence tags without opening an unchecked fetch', () => {
  const initial = snapshot();
  initial.receive = {count: 40000n, sequence: 1};
  const {offset, bytes} = gate.gateWrite({
    snapshot: initial,
    ...request,
    expected: {receive: {sequence: 1, bytes: 40000}},
    current: {sequence: 1, length: 40000, pts: 1n},
    next: {sequence: 2, length: 41000, pts: 2n},
    destination: null
  });
  assert.equal(bytes.readBigUInt64LE(input.DESCRIPTOR.fetchGate), BigInt(request.ignoredFetchGate));
  assert.equal(bytes.readUInt32LE(output.CONTROL.descriptors[0] - offset), 1);
  assert.equal(bytes.readUInt32LE(output.CONTROL.descriptors[1] - offset), 2);
  assert.equal(bytes.readBigUInt64LE(output.CONTROL.descriptors[0] - offset + 8), 0n);
});

test('at lag 1 the write fetches the output one behind decode', () => {
  const lagOne = snapshot();
  lagOne.acquire = {...lagOne.acquire, sequence: 4, pts: 4n};
  lagOne.fetch = {...lagOne.fetch, sequence: 3};
  const expected = {...request.expected, acquire: {sequence: 4, pts: 4n}, fetch: {sequence: 3}};
  const {offset, bytes} = gate.gateWrite({snapshot: lagOne, ...request, expected, lag: 1});
  const outputSlot0 = output.CONTROL.descriptors[0] - offset;
  const outputSlot1 = output.CONTROL.descriptors[1] - offset;
  assert.equal(bytes.readUInt32LE(outputSlot1), 4);
  assert.equal(bytes.readBigUInt64LE(outputSlot1 + 8), BigInt(destination.address));
  assert.equal(bytes.readUInt32LE(outputSlot0), 5);
  assert.equal(bytes.readBigUInt64LE(outputSlot0 + 8), 0n);
  assert.throws(() => gate.gateWrite({snapshot: snapshot(), ...request, lag: 1}), /one AU behind/);
  assert.throws(() => gate.gateWrite({snapshot: snapshot(), ...request, lag: 3}), /lag is 1 or 2/);
});
