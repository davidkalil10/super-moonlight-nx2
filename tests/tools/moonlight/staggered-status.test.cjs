const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STATUS,
  READ_START,
  READ_END,
  parse,
  check,
  checkOutput
} = require('../../../hbl-moonlight/host/stream/staggered-status.js');
const ring = require('../../../hbl-moonlight/tools/moonlight/ring.js');

function snapshot() {
  const bytes = Buffer.alloc(READ_END - READ_START);
  const u32 = (offset, value) => bytes.writeUInt32LE(value, offset - READ_START);
  const i32 = (offset, value) => bytes.writeInt32LE(value, offset - READ_START);
  const u64 = (offset, value) => bytes.writeBigUInt64LE(BigInt(value), offset - READ_START);
  u32(ring.CONTROL.current, 1);
  u32(ring.CONTROL.nativeApplied, 14);
  u64(STATUS.receive, 40000);
  u32(STATUS.receive + 8, 9);
  u64(STATUS.input, 0);
  u64(STATUS.input + 8, 0);
  i32(STATUS.input + 16, 2);
  u32(STATUS.input + 20, 8);
  u64(STATUS.acquire, 0);
  i32(STATUS.acquire + 8, 3);
  u64(STATUS.acquire + 16, 7000);
  u32(STATUS.acquire + 24, 7);
  u64(STATUS.fetch, 0);
  u64(STATUS.fetch + 8, 0);
  u64(STATUS.fetch + 16, 0);
  u32(STATUS.fetch + 24, 6);
  return bytes;
}

const expected = {
  receive: {sequence: 9, bytes: 40000},
  input: {sequence: 8},
  acquire: {sequence: 7, pts: 7000},
  fetch: {sequence: 6},
  ack: {sequence: 14, index: 1}
};

test('staggered host gate accepts one complete checked status snapshot', () => {
  assert.deepEqual(check(parse(snapshot()), expected), {
    inputIndex: 2,
    outputIndex: 3,
    current: 1,
    nativeApplied: 14
  });
});

test('staggered host gate keeps decode and fetch closed on incomplete or wrong results', () => {
  const bytes = snapshot();
  bytes.writeUInt32LE(8, STATUS.receive + 8 - READ_START);
  assert.throws(() => check(parse(bytes), expected), {retryable: true, pending: 'receive'});
  bytes.writeUInt32LE(9, STATUS.receive + 8 - READ_START);
  bytes.writeBigInt64LE(39999n, STATUS.receive - READ_START);
  assert.throws(() => check(parse(bytes), expected), /Short receive/);
  bytes.writeBigInt64LE(40000n, STATUS.receive - READ_START);
  bytes.writeBigUInt64LE(1n, STATUS.acquire - READ_START);
  assert.throws(() => check(parse(bytes), expected), /output status/);
  bytes.writeBigUInt64LE(0n, STATUS.acquire - READ_START);
  bytes.writeUInt32LE(13, ring.CONTROL.nativeApplied - READ_START);
  assert.throws(() => check(parse(bytes), expected), {retryable: true, pending: 'applied'});
});

test('staggered gate treats temporary lack of an input slot as retryable', () => {
  const bytes = snapshot();
  bytes.writeBigUInt64LE(0x100en, STATUS.input + 8 - READ_START);
  bytes.writeInt32LE(-1, STATUS.input + 16 - READ_START);
  assert.throws(() => check(parse(bytes), expected), {retryable: true, pending: 'slot'});
});

test('tail output check requires acquisition and prior publication without a new receive', () => {
  const state = parse(snapshot());
  state.receive.count = 0n;
  assert.deepEqual(
    checkOutput(state, {
      acquire: {sequence: 7, pts: 7000n},
      fetch: {sequence: 6},
      ack: {sequence: 14, index: 1}
    }),
    {outputIndex: 3, current: 1, nativeApplied: 14}
  );
  state.acquire.pts = 7001n;
  assert.throws(
    () => checkOutput(state, {acquire: {sequence: 7, pts: 7000n}}),
    /output status/
  );
});
