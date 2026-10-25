const ring = require('./ring.cjs');

const STATUS = {
  receive: 0x200,
  input: 0x220,
  acquire: 0x260,
  fetch: 0x2a0
};
const READ_START = ring.CONTROL.current;
const READ_END = STATUS.fetch + 0x1c;

if (READ_END > ring.CONTROL.written) throw Error('Staggered status overlaps shader control memory');

function parse(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== READ_END - READ_START)
    throw Error('Invalid staggered status snapshot');
  const u32 = offset => bytes.readUInt32LE(offset - READ_START);
  const i32 = offset => bytes.readInt32LE(offset - READ_START);
  const u64 = offset => bytes.readBigUInt64LE(offset - READ_START);
  const i64 = offset => bytes.readBigInt64LE(offset - READ_START);
  return {
    current: u32(ring.CONTROL.current),
    nativeApplied: u32(ring.CONTROL.nativeApplied),
    receive: {
      count: i64(STATUS.receive),
      sequence: u32(STATUS.receive + 8)
    },
    input: {
      sendStatus: u64(STATUS.input),
      nextSlotStatus: u64(STATUS.input + 8),
      nextIndex: i32(STATUS.input + 16),
      sequence: u32(STATUS.input + 20)
    },
    acquire: {
      status: u64(STATUS.acquire),
      index: i32(STATUS.acquire + 8),
      pts: u64(STATUS.acquire + 16),
      sequence: u32(STATUS.acquire + 24)
    },
    fetch: {
      setStatus: u64(STATUS.fetch),
      getStatus: u64(STATUS.fetch + 8),
      releaseStatus: u64(STATUS.fetch + 16),
      sequence: u32(STATUS.fetch + 24)
    }
  };
}

function gateError(message, retryable = false, pending = null) {
  return Object.assign(Error(message), {retryable, pending});
}

function checkSequence(actual, expected, name) {
  if (!Number.isInteger(expected) || expected < 1 || expected > 0xffffffff)
    throw Error(`Invalid expected ${name} sequence`);
  if (actual < expected)
    throw gateError(`${name} ${expected} is pending`, true, name.toLowerCase());
  if (actual !== expected) throw gateError(`${name} sequence ${actual}/${expected} differs`);
}

function checkOutput(snapshot, expected) {
  if (!expected.acquire) throw Error('Missing expected staggered output acquire');
  checkSequence(snapshot.acquire.sequence, expected.acquire.sequence, 'Acquire');
  if (
    snapshot.acquire.status !== 0n ||
    snapshot.acquire.index < 0 ||
    snapshot.acquire.pts !== BigInt(expected.acquire.pts)
  )
    throw gateError('Decoder output status, index or PTS differs');

  if (expected.fetch) {
    checkSequence(snapshot.fetch.sequence, expected.fetch.sequence, 'Fetch');
    if (
      snapshot.fetch.setStatus !== 0n ||
      snapshot.fetch.getStatus !== 0n ||
      snapshot.fetch.releaseStatus !== 0n
    )
      throw gateError('Previous output fetch or release failed');
  }

  if (expected.ack) {
    const delta = (snapshot.nativeApplied - expected.ack.sequence) >>> 0;
    if (delta >= 0x80000000)
      throw gateError('Previous publication is not applied', true, 'applied');
    if (snapshot.current !== expected.ack.index)
      throw gateError('Applied publication surface differs');
  }
  return {
    outputIndex: snapshot.acquire.index,
    current: snapshot.current,
    nativeApplied: snapshot.nativeApplied
  };
}

function check(snapshot, expected) {
  const receive = expected.receive;
  if (!receive || !Number.isInteger(receive.bytes) || receive.bytes < 1)
    throw Error('Missing expected staggered receive');
  checkSequence(snapshot.receive.sequence, receive.sequence, 'Receive');
  if (snapshot.receive.count !== BigInt(receive.bytes))
    throw gateError(`Short receive ${snapshot.receive.count}/${receive.bytes}`);

  if (expected.input) {
    checkSequence(snapshot.input.sequence, expected.input.sequence, 'Input');
    if (snapshot.input.sendStatus !== 0n) throw gateError('Decoder input submit failed');
    if (snapshot.input.nextIndex < 0 && [0x100en, 0x1011n].includes(snapshot.input.nextSlotStatus))
      throw gateError('Decoder has no checked next input slot', true, 'slot');
    if (snapshot.input.nextSlotStatus !== 0n || snapshot.input.nextIndex < 0)
      throw gateError('Decoder next-slot acquire failed');
  }

  const output = expected.acquire
    ? checkOutput(snapshot, expected)
    : {outputIndex: null, current: snapshot.current, nativeApplied: snapshot.nativeApplied};
  if (!expected.acquire && (expected.fetch || expected.ack))
    throw Error('Staggered fetch/ack check requires an acquired output');
  return {
    inputIndex: expected.input ? snapshot.input.nextIndex : null,
    ...output
  };
}

module.exports = {STATUS, READ_START, READ_END, parse, check, checkOutput};
