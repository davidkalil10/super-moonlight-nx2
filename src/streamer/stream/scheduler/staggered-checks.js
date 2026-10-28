/**
 * Staggered status reads and their checks, the expectations they test and the acquire-wait bins.
 */
import * as checked from '../worker/staggered-status.js';
import * as gates from '../worker/staggered-gate.js';

/** AcquireInputBufferIndex results that only mean no input slot is free yet. */
const PENDING_INPUT = [0x100en, 0x1011n];
const DEFAULT_TIMEOUT_MS = 5000;
const POLL_MS = 5;
/** Upper edges in ms of the acquire-wait bins: 2, 4, 8 ms, one and two frames; the last is open. */
const ACQUIRE_BINS_MS = [2, 4, 8, 1000 / 60, 2000 / 60];
/** Units at or above this size count as large: keyframes run about 210 KB, P-frames about 30. */
const LARGE_UNIT_BYTES = 64 * 1024;

/** Pending reads per acquire: 1, 2, 3, then 4 or more. */
const PENDING_READ_BINS = 4;

/**
 * How long gates waited for the output worker's acquire (or fetch), by unit size. Reads are about
 * 5 ms apart, so a wait is booked between bounds: `bins`/`maxMs` from the first pending read's
 * start to the done read's end, `lowerBins` from the first pending read's end to the last's start.
 * `immediate` counts acquires the first read found done; `reads` bins pending reads per wait.
 */
function createAcquireWaits() {
  const bins = () => ACQUIRE_BINS_MS.map(() => 0).concat(0);
  const empty = () => ({
    immediate: 0,
    count: 0,
    reads: Array(PENDING_READ_BINS).fill(0),
    bins: bins(),
    lowerBins: bins(),
    maxMs: 0
  });
  const sizes = {small: empty(), large: empty()};
  /** @param {number[]} into @param {number} ms */
  const book = (into, ms) => {
    const bin = ACQUIRE_BINS_MS.findIndex(edge => ms < edge);
    into[bin === -1 ? ACQUIRE_BINS_MS.length : bin]++;
  };
  /** The acquire being timed. */
  let wait = {unit: 0, since: null, firstEnd: 0, lastStart: 0, reads: 0, done: true};
  return {
    /**
     * One gate status read of `unit`'s acquire; the wait is booked at the first read that finds
     * it done, and later reads of the same unit are ignored.
     * @param {number} unit
     * @param {boolean} pending
     * @param {number} startedAt
     * @param {number} endedAt
     * @param {number} bytes the unit's size
     */
    observe(unit, pending, startedAt, endedAt, bytes) {
      if (wait.unit !== unit)
        wait = {unit, since: null, firstEnd: 0, lastStart: 0, reads: 0, done: false};
      if (wait.done) return;

      if (pending) {
        if (wait.since === null) {
          wait.since = startedAt;
          wait.firstEnd = endedAt;
        }
        wait.lastStart = startedAt;
        wait.reads++;
        return;
      }

      wait.done = true;
      const size = sizes[bytes >= LARGE_UNIT_BYTES ? 'large' : 'small'];
      if (wait.since === null) {
        size.immediate++;
        return;
      }

      const upperMs = endedAt - wait.since;
      size.count++;
      size.reads[Math.min(wait.reads, PENDING_READ_BINS) - 1]++;
      book(size.bins, upperMs);
      book(size.lowerBins, Math.max(0, wait.lastStart - wait.firstEnd));
      size.maxMs = Math.max(size.maxMs, Math.round(upperMs * 10) / 10);
    },
    get counts() {
      const copy = size => ({
        ...size,
        reads: [...size.reads],
        bins: [...size.bins],
        lowerBins: [...size.lowerBins]
      });
      return {small: copy(sizes.small), large: copy(sizes.large)};
    }
  };
}

/** Least time between host retries of the input worker's next-slot acquire. */
const INPUT_RETRY_MS = 20;
/** Serial-number arithmetic: a u32 distance below this means "at or after". */
const HALF_SEQUENCE_RANGE = 0x80000000;

/** @typedef {import('../worker/staggered-status.js').Snapshot} Snapshot */
/** @typedef {import('../worker/staggered-status.js').Expected} Expected */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
/** @returns {Promise<void>} */
const immediate = () => new Promise(resolve => setImmediate(resolve));

/**
 * @param {Snapshot} snapshot
 * @param {Expected} expected
 * @returns {boolean} True when the gate only waits for the input worker to find a free slot
 *   after a complete receive and submit.
 */
function isPendingInputSlot(snapshot, expected) {
  if (!expected.input) return false;

  const received =
    snapshot.receive.sequence === expected.receive.sequence &&
    snapshot.receive.count === BigInt(expected.receive.bytes);
  if (!received) return false;

  const submitted = snapshot.input.sequence === expected.input.sequence;
  if (!submitted) return false;

  return snapshot.input.nextIndex < 0 && PENDING_INPUT.includes(snapshot.input.nextSlotStatus);
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
 * @typedef {object} WaitOptions
 * @property {number} [timeoutMs]
 * @property {(ms: number, pending?: string | null) => Promise<unknown>} [pause] Between reads;
 *   `pending` is what the last retryable check waited for.
 * @property {() => Promise<unknown>} [beforeRead] Before each read.
 * @property {(pending: string | null) => void} [onReread] After each retryable check.
 * @property {(snapshot: Snapshot, startedAt: number) => void} [onRead] After each read.
 * @property {() => number} [now] Clock for onRead's startedAt.
 */

/**
 * The mismatch a torn read leaves, or null for any other failure. The same one twice is a wrong
 * surface (invariant 14).
 * @param {any} error
 * @param {Snapshot} snapshot
 */
function tearOf(error, snapshot) {
  return error.pending === 'torn' ? snapshot.nativeApplied + '/' + snapshot.current : null;
}

/**
 * Reads the status until it passes check(), retrying the next-slot acquire from the host while
 * that is all the gate waits for.
 * @param {any} worker
 * @param {Expected} expected
 * @param {WaitOptions} [options]
 * @returns {Promise<Snapshot>}
 */
async function waitChecked(
  worker,
  expected,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pause = delay,
    beforeRead = async () => {},
    onReread = () => {},
    onRead = () => {},
    now = Date.now
  } = {}
) {
  const until = Date.now() + timeoutMs;
  let nextInputRetry = 0;
  let pending = null;
  let torn = null;
  let last = null;
  while (Date.now() < until) {
    await beforeRead();
    const startedAt = now();
    const snapshot = await worker.readStatus();
    last = snapshot;
    onRead(snapshot, startedAt);

    try {
      checked.check(snapshot, expected);
      return snapshot;
    } catch (error) {
      const tear = tearOf(error, snapshot);
      const repeatedTear = tear !== null && tear === torn;
      if (!error.retryable || repeatedTear) throw failedCheck(error, expected, snapshot);
      torn = tear;

      if (Date.now() >= nextInputRetry && isPendingInputSlot(snapshot, expected)) {
        await worker.retryInputSlot(expected.input.sequence);
        nextInputRetry = Date.now() + INPUT_RETRY_MS;
      }

      onReread(error.pending);
      pending = error.pending;
    }
    await pause(POLL_MS, pending);
  }
  // `pending` names what the gate still waited for when the deadline hit.
  const timeout = Object.assign(Error('Staggered checked status timed out'), {
    pending,
    timedOut: true
  });
  throw last ? failedCheck(timeout, expected, last) : timeout;
}

/**
 * Reads the status until its output half passes checkOutput(); used by the tail, after the
 * input worker stopped.
 * @param {any} worker
 * @param {Expected} expected
 * @param {{timeoutMs?: number, pause?: (ms: number) => Promise<unknown>,
 *   onReread?: (pending: string) => void}} [options]
 * @returns {Promise<Snapshot>}
 */
async function waitOutput(
  worker,
  expected,
  {timeoutMs = DEFAULT_TIMEOUT_MS, pause = delay, onReread = () => {}} = {}
) {
  const until = Date.now() + timeoutMs;
  let torn = null;
  while (Date.now() < until) {
    const snapshot = await worker.readStatus();
    try {
      checked.checkOutput(snapshot, expected);
      return snapshot;
    } catch (error) {
      const tear = tearOf(error, snapshot);
      const repeatedTear = tear !== null && tear === torn;
      if (!error.retryable || repeatedTear) throw failedCheck(error, expected, snapshot);
      torn = tear;
      onReread(error.pending);
    }
    await pause(POLL_MS);
  }
  throw Error('Staggered tail output timed out');
}

/**
 * What the gate after access unit `sequence` expects: its receive, the submit of the unit
 * before it, the output `lag` behind it (two by default) and, once there is one, the fetch of
 * the output before that and the publication that fetch presented unless it was skipped.
 * With lag 0 the gate names output `sequence` itself and expects `sequence - 1` acquired and
 * fetched (invariants 3 and 4).
 * @param {number} sequence
 * @param {Map<number, {length: number, pts: bigint}>} units
 * @param {Map<number, any>} destinations Output sequence to the surface it was fetched into.
 * @param {number} [lag]
 * @returns {Expected}
 */
function expectedFor(sequence, units, destinations, lag = gates.OUTPUT_LAG) {
  const value = {receive: {sequence, bytes: units.get(sequence).length}};
  if (sequence >= 2) value.input = {sequence: sequence - 1};

  const acquired = sequence - Math.max(lag, 1);
  const fetched = lag === 0 ? acquired : acquired - 1;
  if (acquired >= 1) value.acquire = {sequence: acquired, pts: units.get(acquired).pts};
  if (fetched >= 1) {
    const destination = destinations.get(fetched);
    if (!destination) throw Error('Missing prior staggered output destination');
    value.fetch = {sequence: fetched};
    if (!destination.skip) value.ack = {sequence: destination.sequence, index: destination.index};
  }
  return value;
}

/**
 * The tail's expectation for output `sequence`, fetched behind the output before it.
 * @param {number} sequence
 * @param {Map<number, {length: number, pts: bigint}>} units
 * @param {Map<number, any>} destinations
 * @returns {Expected}
 */
function tailExpected(sequence, units, destinations) {
  const prior = destinations.get(sequence - 1);
  const expected = {acquire: {sequence, pts: units.get(sequence).pts}};
  if (prior) {
    expected.fetch = {sequence: sequence - 1};
    if (!prior.skip) expected.ack = {sequence: prior.sequence, index: prior.index};
  }
  return expected;
}

/**
 * A failed status check with what it expected and the status it read, for the failure log.
 * @param {Error} error
 * @param {Expected} expected
 * @param {Snapshot} snapshot
 */
function failedCheck(error, expected, snapshot) {
  return Object.assign(error, {expected: jsonSafe(expected), checked: jsonSafe(snapshot)});
}

/**
 * @param {unknown} value
 * @returns {any} `value` with bigints as strings.
 */
function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item))
  );
}

export {
  createAcquireWaits,
  DEFAULT_TIMEOUT_MS,
  POLL_MS,
  delay,
  immediate,
  isApplied,
  waitChecked,
  waitOutput,
  expectedFor,
  tailExpected,
  jsonSafe
};
