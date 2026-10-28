/**
 * Status words both staggered workers stamp just past the shader's control words, so one read
 * covers an access unit. check() and checkOutput() test a snapshot against the next gate.
 */
import * as ring from '../../shared/ring.js';

/** Ring offsets of the status groups. */
const STATUS = {
  receive: 0x200,
  input: 0x220,
  acquire: 0x260,
  fetch: 0x2a0
};
/** Field offsets inside the receive group. */
const RECEIVE = {count: 0, sequence: 8};
/** Field offsets inside the input group. */
const INPUT = {sendStatus: 0, nextSlotStatus: 8, nextIndex: 16, sequence: 20};
/** Field offsets inside the acquire group. */
const ACQUIRE = {status: 0, index: 8, pts: 16, sequence: 24};
/** Field offsets inside the fetch group. */
const FETCH = {setStatus: 0, getStatus: 8, releaseStatus: 16, sequence: 24};
/**
 * Console ticks of the stage measurement (HBL_STAGE_TICKS=1), in free words inside the read:
 * received, submitted, decoder output ready and published.
 */
const TICKS = {receive: 0x210, submit: 0x240, ready: 0x288, publish: 0x290};
const SEQUENCE_BYTES = 4;

/**
 * The console tick call both plans stamp into TICKS of the stage measurement, or none while it is off.
 * @param {number | null} ticks
 */
function tickCall(ticks) {
  if (ticks === null) return [];
  return [{function: ticks, args: [0, 0, 0, 0]}];
}

const READ_START = ring.CONTROL.current;
const READ_END = STATUS.fetch + FETCH.sequence + SEQUENCE_BYTES;

if (READ_END > ring.CONTROL.written) throw Error('Staggered status overlaps shader control memory');

const MAX_SEQUENCE = 0xffffffff;
/** Serial-number arithmetic: a u32 distance below this means "at or after". */
const HALF_SEQUENCE_RANGE = 0x80000000;
/** AcquireInputBufferIndex results that only mean no input slot is free yet. */
const NO_INPUT_SLOT = [0x100en, 0x1011n];

/**
 * @typedef {object} Snapshot
 * @property {number} current Surface the shader presents.
 * @property {number} nativeApplied Last publication sequence the shader applied.
 * @property {{count: bigint, sequence: number}} receive
 * @property {{sendStatus: bigint, nextSlotStatus: bigint, nextIndex: number,
 *   sequence: number}} input
 * @property {{status: bigint, index: number, pts: bigint, sequence: number}} acquire
 * @property {{setStatus: bigint, getStatus: bigint, releaseStatus: bigint,
 *   sequence: number}} fetch
 * @property {{receive: bigint, submit: bigint, ready: bigint, publish: bigint}} [ticks] 0 unless
 *   the stage ticks are on.
 */

/**
 * What the host expects one gate's status to show. Only receive is always present; the
 * others join as the pipeline fills.
 * @typedef {object} Expected
 * @property {{sequence: number, bytes: number}} [receive]
 * @property {{sequence: number}} [input]
 * @property {{sequence: number, pts: number | bigint}} [acquire]
 * @property {{sequence: number}} [fetch]
 * @property {{sequence: number, index: number, openedAt?: number | null, optional?: boolean}} [ack]
 *   The publication that must be applied, with the time its fetch opened for the pacer; an
 *   optional one only has to match its surface once it is.
 */

/**
 * @typedef {object} CheckedOutput
 * @property {number | null} outputIndex
 * @property {number} current
 * @property {number} nativeApplied
 */

/**
 * @param {Buffer} bytes
 * @returns {Snapshot}
 */
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
      count: i64(STATUS.receive + RECEIVE.count),
      sequence: u32(STATUS.receive + RECEIVE.sequence)
    },
    input: {
      sendStatus: u64(STATUS.input + INPUT.sendStatus),
      nextSlotStatus: u64(STATUS.input + INPUT.nextSlotStatus),
      nextIndex: i32(STATUS.input + INPUT.nextIndex),
      sequence: u32(STATUS.input + INPUT.sequence)
    },
    acquire: {
      status: u64(STATUS.acquire + ACQUIRE.status),
      index: i32(STATUS.acquire + ACQUIRE.index),
      pts: u64(STATUS.acquire + ACQUIRE.pts),
      sequence: u32(STATUS.acquire + ACQUIRE.sequence)
    },
    fetch: {
      setStatus: u64(STATUS.fetch + FETCH.setStatus),
      getStatus: u64(STATUS.fetch + FETCH.getStatus),
      releaseStatus: u64(STATUS.fetch + FETCH.releaseStatus),
      sequence: u32(STATUS.fetch + FETCH.sequence)
    },
    ticks: {
      receive: u64(TICKS.receive),
      submit: u64(TICKS.submit),
      ready: u64(TICKS.ready),
      publish: u64(TICKS.publish)
    }
  };
}

/**
 * @param {string} message
 * @param {boolean} [retryable] The worker has not got there yet; reading again may pass.
 * @param {string | null} [pending] What the worker is still waiting for.
 */
function gateError(message, retryable = false, pending = null) {
  return Object.assign(Error(message), {retryable, pending});
}

/**
 * Throws a retryable error while `actual` is behind `expected`, a fatal one past it.
 * @param {number} actual
 * @param {number} expected
 * @param {string} name
 */
function checkSequence(actual, expected, name) {
  if (!Number.isInteger(expected) || expected < 1 || expected > MAX_SEQUENCE)
    throw Error(`Invalid expected ${name} sequence`);

  if (actual < expected)
    throw gateError(`${name} ${expected} is pending`, true, name.toLowerCase());

  if (actual !== expected) throw gateError(`${name} sequence ${actual}/${expected} differs`);
}

/**
 * @param {number} nativeApplied
 * @param {number} sequence
 * @returns {boolean} True once the shader applied `sequence` or a later publication.
 */
function isApplied(nativeApplied, sequence) {
  return (nativeApplied - sequence) >>> 0 < HALF_SEQUENCE_RANGE;
}

/**
 * Why an acquire stamp is not the output the gate expects. The acquire frame can't drain the
 * queue, so a wake with no output or two outputs under one wake shows here (lag0-re.md risk 2).
 * @param {Snapshot['acquire']} acquire
 * @param {number | bigint} pts
 * @returns {string | null}
 */
function acquireFault({status, index, pts: actual}, pts) {
  if (status !== 0n || index < 0) {
    const code = '0x' + status.toString(16);
    if (index < 0) return `Decoder output event woke with no output ready (${code})`;
    return `Decoder output acquire failed (${code})`;
  }

  if (actual !== BigInt(pts))
    return `Decoder output PTS ${actual} is not the expected ${pts}: an extra or held output`;
  return null;
}

/**
 * @param {Snapshot['fetch']} fetch
 * @returns {boolean} True when the set, get or release of the previous fetch failed.
 */
function fetchFailed(fetch) {
  if (fetch.setStatus !== 0n || fetch.getStatus !== 0n) return true;
  return fetch.releaseStatus !== 0n;
}

/**
 * Throws until the shader applied the expected publication on its surface. An optional one
 * only has to match its surface once it is applied.
 * @param {Snapshot} snapshot
 * @param {NonNullable<Expected['ack']>} ack
 */
function checkApplied(snapshot, ack) {
  if (!isApplied(snapshot.nativeApplied, ack.sequence)) {
    if (ack.optional) return;
    throw gateError('Previous publication is not applied', true, 'applied');
  }

  // Invariant 14 (staggered-checks.js tearOf retries it).
  if (snapshot.current !== ack.index)
    throw gateError('Applied publication surface differs', true, 'torn');
}

/**
 * Checks the output half of a snapshot: the acquired output, the previous fetch and the
 * publication it presented.
 * @param {Snapshot} snapshot
 * @param {Expected} expected
 * @returns {CheckedOutput}
 */
function checkOutput(snapshot, expected) {
  if (!expected.acquire) throw Error('Missing expected staggered output acquire');
  checkSequence(snapshot.acquire.sequence, expected.acquire.sequence, 'Acquire');

  const fault = acquireFault(snapshot.acquire, expected.acquire.pts);
  if (fault) throw gateError(fault);

  if (expected.fetch) {
    checkSequence(snapshot.fetch.sequence, expected.fetch.sequence, 'Fetch');
    if (fetchFailed(snapshot.fetch)) throw gateError('Previous output fetch or release failed');
  }

  if (expected.ack) checkApplied(snapshot, expected.ack);

  return {
    outputIndex: snapshot.acquire.index,
    current: snapshot.current,
    nativeApplied: snapshot.nativeApplied
  };
}

/**
 * Checks the input half of a snapshot: the submit and the next input slot it acquired.
 * @param {Snapshot} snapshot
 * @param {Expected} expected
 */
function checkInput(snapshot, expected) {
  checkSequence(snapshot.input.sequence, expected.input.sequence, 'Input');
  if (snapshot.input.sendStatus !== 0n) throw gateError('Decoder input submit failed');

  if (snapshot.input.nextIndex < 0 && NO_INPUT_SLOT.includes(snapshot.input.nextSlotStatus))
    throw gateError('Decoder has no checked next input slot', true, 'slot');
  if (snapshot.input.nextSlotStatus !== 0n || snapshot.input.nextIndex < 0)
    throw gateError('Decoder next-slot acquire failed');
}

/**
 * Checks a whole snapshot against the next gate's expectations.
 * @param {Snapshot} snapshot
 * @param {Expected} expected
 * @returns {CheckedOutput & {inputIndex: number | null}}
 */
function check(snapshot, expected) {
  const receive = expected.receive;
  if (!receive || !Number.isInteger(receive.bytes) || receive.bytes < 1)
    throw Error('Missing expected staggered receive');

  checkSequence(snapshot.receive.sequence, receive.sequence, 'Receive');
  if (snapshot.receive.count !== BigInt(receive.bytes))
    throw gateError(`Short receive ${snapshot.receive.count}/${receive.bytes}`);

  if (expected.input) checkInput(snapshot, expected);

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

export {STATUS, TICKS, READ_START, READ_END, parse, check, checkOutput, tickCall};
