/**
 * Host scheduler for the staggered live path. The input worker receives each access unit over
 * native TCP and the output worker fetches the unit two behind it (one with lag 1), so a steady
 * frame costs one checked status read and one combined gate write. Every gate goes through
 * the worker's checked writes (staggered-gate / staggered-status); call order, the odd tail
 * drain and stop are the ones the removed probe-staggered-ladder.cjs proved on the console.
 *
 * Skip and catch-up: with more than skipBacklog units (SKIP_BACKLOG by default) queued on the
 * host, an output is still decoded, fetched and released but copied to a free surface behind a
 * replay of the last applied publication, so the shader keeps it off screen and the next gate
 * does not wait for a present. At most MAX_SKIPS outputs in a row are skipped this way.
 * trimBacklogMs (backlog rule only) skips one output the same way once the unit in hand has
 * been older than that, with another unit queued behind it, at TRIM_FRAMES gates in a row.
 * That drops a standing delay at or below skipBacklog that the backlog skip leaves alone, so
 * it needs a skipBacklog of at least 1. With nothing queued the age is arrival phase and a trim
 * cannot lower it. After a trim the next TRIM_FRAMES gates do not count, so trims stay at most
 * one per 2 * TRIM_FRAMES gates.
 *
 * skipRule 'vsync' instead keeps at most one publication pending: the newest output is
 * published once the previous publication is applied and the outputs in between go off
 * screen. A gate waits for the pending publication only with at most skipBacklog units
 * queued, or once it has been pending for two vsync periods (request-budget.cjs). With
 * no free surface to discard into, the gate waits for the pending publication first.
 * decodeWait (vsync rule only) sleeps through a pending acquire to the time decode-wait.js
 * predicts instead of rereading back to back; receiveWait does the same for a pending
 * receive with receive-wait.js.
 *
 * Gate on receive: by default the gate write for unit N carries N+1's length, so it waits for
 * N+1 to arrive. gateOnReceive instead primes each unit's descriptor in its own exchange as it
 * arrives (staggered-input-plan.js), sends it and gates it at once, so decode N opens a frame
 * earlier for one more exchange per unit.
 *
 * Rereads: a gate late on receive, input, acquire or fetch reads the status again right away,
 * since a pause costs the frame its vsync slot (request-budget.cjs staggeredRetryWait). A gate
 * waiting for the renderer to apply a publication sleeps to the vsync present-pacer predicts
 * instead, since polling there only fills the bridge. The deadline bounds both.
 *
 * Exchange timing: every status read and gate write is binned by exchange-timing.js against
 * the last gate, the last send and the predicted decode-done and receive-done, and reported
 * in counts.exchanges. `avoid` ({beforeMs, afterMs}) keeps a status read from starting
 * inside that span around a predicted event, delaying it to afterMs past the event, so a
 * live run can move reads off the console's busy window once the bins show where it is.
 */
import * as checked from './staggered-status.js';
import * as presentPacer from './present-pacer.js';
import * as decodeWaits from './decode-wait.js';
import * as receiveWaits from './receive-wait.js';
import * as exchangeTiming from './exchange-timing.js';
import * as gates from './staggered-gate.js';
import {create as createStaggeredWorker} from './staggered-worker.js';

const RESTART = 'Staggered worker native objects retained; restart SmileBASIC';
/** Host backlog above which an output is fetched off screen instead of presented. */
const SKIP_BACKLOG = 2;
/** Most outputs skipped in a row before one is presented again. */
const MAX_SKIPS = 4;
/** Gates in a row the unit in hand must be stale at before one output is trimmed. */
const TRIM_FRAMES = 3;
const SKIP_RULES = ['backlog', 'vsync'];
/** AcquireInputBufferIndex results that only mean no input slot is free yet. */
const PENDING_INPUT = [0x100en, 0x1011n];
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PRESENT_HZ = 60;
const POLL_MS = 5;
/** Upper edges in ms of the acquire-wait bins: 2, 4, 8 ms, one and two frames; the last is open. */
const ACQUIRE_BINS_MS = [2, 4, 8, 1000 / 60, 2000 / 60];
/** Units at or above this size count as large: keyframes run about 210 KB, P-frames about 30. */
const LARGE_UNIT_BYTES = 64 * 1024;

/** Pending reads per acquire: 1, 2, 3, then 4 or more. */
const PENDING_READ_BINS = 4;

/**
 * How long gates waited for the output worker's acquire, split by the size of the unit. Reads
 * are about 5 ms apart, so a wait is only known between two bounds:
 * - upper (`bins`, `maxMs`): from the start of the first read that found the acquire pending to
 *   the end of the read that found it done;
 * - lower (`lowerBins`): from the end of the first pending read to the start of the last one,
 *   so 0 with a single pending read.
 * `immediate` counts the acquires a gate's first read already found done, and `reads` how many
 * pending reads each wait took. The fetch waits are booked the same way.
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

/** @typedef {import('./staggered-status.js').Snapshot} Snapshot */
/** @typedef {import('./staggered-status.js').Expected} Expected */

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
  return (
    Boolean(expected.input) &&
    snapshot.receive.sequence === expected.receive.sequence &&
    snapshot.receive.count === BigInt(expected.receive.bytes) &&
    snapshot.input.sequence === expected.input.sequence &&
    snapshot.input.nextIndex < 0 &&
    PENDING_INPUT.includes(snapshot.input.nextSlotStatus)
  );
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
 * The mismatch a torn read leaves, or null for any other failure. A torn read cannot repeat,
 * since the shader stores current before nativeApplied, so the same one twice is a wrong
 * surface.
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
  while (Date.now() < until) {
    await beforeRead();
    const startedAt = now();
    const snapshot = await worker.readStatus();
    onRead(snapshot, startedAt);
    try {
      checked.check(snapshot, expected);
      return snapshot;
    } catch (error) {
      const tear = tearOf(error, snapshot);
      if (!error.retryable || (tear !== null && tear === torn))
        throw failedCheck(error, expected, snapshot);
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
  throw Error('Staggered checked status timed out');
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
      if (!error.retryable || (tear !== null && tear === torn))
        throw failedCheck(error, expected, snapshot);
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
 * @param {number} sequence
 * @param {Map<number, {length: number, pts: bigint}>} units
 * @param {Map<number, any>} destinations Output sequence to the surface it was fetched into.
 * @param {number} [lag]
 * @returns {Expected}
 */
function expectedFor(sequence, units, destinations, lag = gates.OUTPUT_LAG) {
  const value = {receive: {sequence, bytes: units.get(sequence).length}};
  if (sequence >= 2) value.input = {sequence: sequence - 1};
  const acquired = sequence - lag;
  if (acquired >= 1) value.acquire = {sequence: acquired, pts: units.get(acquired).pts};
  if (acquired >= 2) {
    const destination = destinations.get(acquired - 1);
    if (!destination) throw Error('Missing prior staggered output destination');
    value.fetch = {sequence: acquired - 1};
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

/**
 * The staggered scheduler. push() and finish() take hooks: `sink` gives each output a
 * destination (workerDestination, or discardDestination when skipping), `enter` names each
 * step, and onDecoded, onPresented and onSkipped count outputs. push() also calls onGate with
 * the time its gate write starts, onSent with the time its unit went out and onTrimmed with
 * the age of the unit in hand when a trim skips an output.
 * @param {object} [options]
 * @param {(options: any) => Promise<any>} [options.createWorker]
 * @param {number} [options.timeoutMs]
 * @param {(ms: number) => Promise<unknown>} [options.pause]
 * @param {number} [options.presentHz]
 * @param {number} [options.skipBacklog] host backlog above which an output is skipped
 * @param {'backlog' | 'vsync'} [options.skipRule]
 * @param {number | null} [options.trimBacklogMs] age of the unit in hand that counts as stale
 * @param {boolean} [options.gateOnReceive] gate each unit as soon as it is sent
 * @param {1 | 2} [options.lag] fetch each output this many gates after its decode opened
 * @param {boolean} [options.decodeWait] sleep through a pending acquire (vsync rule only)
 * @param {boolean} [options.receiveWait] sleep through a pending receive
 * @param {{beforeMs: number, afterMs: number} | null} [options.avoid] span around a predicted
 *   decode-done or receive-done no status read starts in
 * @param {() => number} [options.now]
 */
function create({
  createWorker = createStaggeredWorker,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pause = delay,
  presentHz = DEFAULT_PRESENT_HZ,
  skipBacklog = SKIP_BACKLOG,
  skipRule = 'backlog',
  trimBacklogMs = null,
  gateOnReceive = false,
  lag = gates.OUTPUT_LAG,
  decodeWait = false,
  receiveWait = false,
  avoid = null,
  now = Date.now
} = {}) {
  if (!SKIP_RULES.includes(skipRule)) throw Error('Unknown staggered skip rule ' + skipRule);
  const vsyncRule = skipRule === 'vsync';
  if (decodeWait && !vsyncRule) throw Error('The decode wait needs the vsync skip rule');
  if (trimBacklogMs !== null && vsyncRule) throw Error('The backlog trim needs the backlog rule');
  if (trimBacklogMs !== null && skipBacklog < 1)
    throw Error('The backlog trim needs a skip backlog of at least 1');
  if (lag !== 1 && lag !== gates.OUTPUT_LAG) throw Error('The staggered output lag is 1 or 2');
  const periodMs = 1000 / presentHz;
  let worker = null;
  let transport = null;
  let firstInput = null;
  let layout = null;
  let ready = false;
  let finished = false;
  let retained = false;
  let held = null;
  const units = new Map();
  const destinations = new Map();
  const counts = {
    submitted: 0,
    decoded: 0,
    presented: 0,
    skipped: 0,
    tailDrained: 0,
    rereads: 0,
    appliedPeriodMs: periodMs,
    ...(trimBacklogMs !== null && {trimmed: 0})
  };
  let published = null;
  /** The publication before `published`, logged with a failed check. */
  let previous = null;
  let pending = null;
  let skips = 0;
  let stale = 0;
  let cooling = 0;
  const waiting = {};
  const acquireWaits = createAcquireWaits();
  const fetchWaits = createAcquireWaits();
  const waits = {
    timeoutMs,
    pause,
    onReread: pending => {
      if (pending === 'torn') waiting.torn = (waiting.torn || 0) + 1;
    }
  };
  const pacer = presentPacer.create({periodMs, now, sleep: ms => pause(ms)});
  const decode = decodeWait ? decodeWaits.create({now, sleep: ms => pause(ms)}) : null;
  /** Receive-wait sleeps since the start, for the stats rows. */
  const receiveSlept = {sleeps: 0, ms: 0};
  const receive = receiveWait
    ? receiveWaits.create({
        maxSleepMs: periodMs,
        now,
        sleep: ms => {
          receiveSlept.sleeps++;
          receiveSlept.ms += ms;
          return pause(ms);
        }
      })
    : null;
  /** How long the last status read took, for the decode wait. */
  let readMs = 0;
  /** When the last gate opened a fetch, for the pacer's vsync prediction. */
  let fetchOpened = null;
  const timing = exchangeTiming.create();
  /** When the last gate opened and the last unit went out, for the exchange bins. */
  let lastGate = null;
  let lastSend = null;
  /**
   * One per gate: the acquire it expects and what its reads have seen of it.
   * @param {Expected} expected
   */
  const acquireWatch = expected =>
    decode && expected.acquire
      ? {unit: expected.acquire.sequence, pendingSeen: false, acquired: false, waited: false}
      : null;
  /**
   * One per gate: the receive it expects and what its reads have seen of it.
   * @param {Expected} expected
   */
  const receiveWatch = expected =>
    receive
      ? {
          unit: expected.receive.sequence,
          bytes: expected.receive.bytes,
          pendingSeen: false,
          received: false,
          waited: false
        }
      : null;
  /**
   * @param {Expected} expected
   * @param {ReturnType<typeof acquireWatch>} [watch]
   * @param {ReturnType<typeof receiveWatch>} [link]
   * @returns {WaitOptions}
   */
  const rereadsFor = (expected, watch = null, link = null) => ({
    timeoutMs,
    now,
    pause: (_ms, pending) => (pending === 'applied' ? pacer.pending() : immediate()),
    beforeRead: async () => {
      if (link && !link.received)
        link.waited = await receive.beforeRead(link.unit, link.pendingSeen, readMs);
      if (watch && !watch.acquired)
        watch.waited = await decode.beforeRead(watch.unit, watch.pendingSeen, readMs);
      const delay = exchangeTiming.delayFor(now(), predictions(expected), avoid);
      if (delay > 0) await pause(delay);
    },
    onRead: (snapshot, startedAt) => {
      readMs = now() - startedAt;
      timing.record('status', startedAt, now(), references(expected));
      if (link && !link.received) {
        link.received =
          snapshot.receive.sequence === link.unit && snapshot.receive.count === BigInt(link.bytes);
        receive.observe(link.unit, now(), link.received, link);
        link.pendingSeen ||= !link.received;
      }
      if (watch && !watch.acquired) {
        watch.acquired = snapshot.acquire.sequence >= watch.unit;
        decode.observe(watch.unit, now(), watch.acquired, watch);
        watch.pendingSeen ||= !watch.acquired;
      }
      if (expected.acquire) {
        const unit = expected.acquire.sequence;
        const pending = snapshot.acquire.sequence < unit;
        acquireWaits.observe(unit, pending, startedAt, now(), units.get(unit)?.length ?? 0);
      }
      if (expected.fetch) {
        const unit = expected.fetch.sequence;
        const pending = snapshot.fetch.sequence < unit;
        fetchWaits.observe(unit, pending, startedAt, now(), units.get(unit)?.length ?? 0);
      }
      if (expected.ack) {
        const applied = isApplied(snapshot.nativeApplied, expected.ack.sequence);
        pacer.observe(startedAt, applied, expected.ack.openedAt ?? null);
        counts.appliedPeriodMs = pacer.periodMs;
      }
    },
    onReread: pending => {
      counts.rereads++;
      waiting[pending] = (waiting[pending] || 0) + 1;
    }
  });

  /**
   * The predicted decode-done and receive-done for a gate's expected units.
   * @param {Expected} expected
   */
  const predictions = expected => [
    expected.acquire ? decode?.predictedAt(expected.acquire.sequence) : null,
    receive?.predictedAt(expected.receive.sequence)
  ];
  /**
   * The event times an exchange of a gate is binned against.
   * @param {Expected} expected
   */
  const references = expected => {
    const [decodeDone, receiveDone] = predictions(expected);
    return {gate: lastGate, send: lastSend, decodeDone, receiveDone};
  };

  /** Keeps the units and destinations later gates still check, and drops older ones. */
  function remember(sequence, unit) {
    units.set(sequence, unit);
    units.delete(sequence - 3);
    destinations.delete(sequence - 4);
  }

  /** Counts the output the gate's fetch check covered as presented or skipped. */
  function shown(expected, onPresented, onSkipped) {
    if (expected.ack) {
      counts.presented++;
      onPresented?.(1);
    } else if (expected.fetch) {
      counts.skipped++;
      onSkipped?.(1);
    }
  }

  /** The pending publication as this gate's ack, optional while the host has a backlog. */
  function pendingAck(expected, backlog) {
    delete expected.ack;
    if (!pending) return;
    const optional = backlog > skipBacklog && now() - pending.openedAt <= 2 * pacer.periodMs;
    expected.ack = {
      sequence: pending.sequence,
      index: pending.index,
      openedAt: pending.openedAt,
      ...(optional && {optional})
    };
  }

  function confirm(snapshot, onPresented) {
    if (!pending || !isApplied(snapshot.nativeApplied, pending.sequence)) return;
    pending = null;
    counts.presented++;
    onPresented?.(1);
  }

  /**
   * Whether the unit in hand has been stale, with a unit queued, at TRIM_FRAMES gates in a
   * row since the last trim's cooldown.
   * @param {number | undefined} arrivedAt
   * @param {number} backlog
   */
  function trimDue(arrivedAt, backlog) {
    if (trimBacklogMs === null || arrivedAt === undefined) return false;
    if (cooling > 0) {
      cooling--;
      return false;
    }
    stale = backlog >= 1 && now() - arrivedAt > trimBacklogMs ? stale + 1 : 0;
    return stale >= TRIM_FRAMES;
  }

  /** Reserves the next publication and keeps the one before it. */
  async function nextPublication(sink, presentation) {
    const next = await sink.workerDestination(presentation);
    previous = published;
    published = next;
    return next;
  }

  /**
   * A failed check also logs the publication before the last one: a current on it points at a
   * stale status read rather than a wrong surface.
   * @param {any} error
   * @returns {never}
   */
  function withPrevious(error) {
    if (error.expected)
      error.previous = previous && {sequence: previous.sequence, index: previous.index};
    throw error;
  }

  /**
   * Picks the surface the next output is fetched into: a discard surface while the backlog
   * or a due trim calls for a skip and the skip run is short enough, else a published one.
   * Under the vsync rule it is a discard surface while a publication is pending.
   */
  async function target(sink, snapshot, backlog, arrivedAt, onTrimmed) {
    const presentation = {current: snapshot.current, applied: snapshot.nativeApplied};
    if (vsyncRule) {
      if (pending) return sink.discardDestination(presentation);
      await nextPublication(sink, presentation);
      pending = {sequence: published.sequence, index: published.index, openedAt: null};
      return published;
    }
    const trim = trimDue(arrivedAt, backlog);
    if (published && (backlog > skipBacklog || trim) && skips < MAX_SKIPS) {
      const discard = await sink.discardDestination(presentation);
      if (discard) {
        skips++;
        stale = 0;
        if (backlog <= skipBacklog) {
          cooling = TRIM_FRAMES;
          counts.trimmed++;
          onTrimmed?.(now() - arrivedAt);
        }
        return discard;
      }
    }
    skips = 0;
    await nextPublication(sink, presentation);
    return published;
  }

  /**
   * Counts what a gate's status read covered: the decode it expected and the output its fetch
   * check settled, presented or skipped.
   */
  function countRead(expected, snapshot, onDecoded, onPresented, onSkipped) {
    if (expected.acquire) {
      counts.decoded++;
      onDecoded?.(1);
    }
    if (!vsyncRule) {
      shown(expected, onPresented, onSkipped);
      return;
    }
    if (expected.fetch && destinations.get(expected.fetch.sequence).skip) {
      counts.skipped++;
      onSkipped?.(1);
    }
    confirm(snapshot, onPresented);
  }

  /**
   * Picks the destination of the output `lag` units behind `sequence`. Under the vsync rule a
   * missing discard surface waits for the pending publication to apply, then picks again.
   * @returns {Promise<{destination: any, snapshot: any}>} The status the gate opens on too.
   */
  async function pickDestination(sequence, snapshot, expected, watch, link, hooks) {
    const {sink, onPresented, onTrimmed, arrivedAt, backlog} = hooks;
    let destination = await target(sink, snapshot, backlog, arrivedAt, onTrimmed);
    if (!destination && vsyncRule) {
      expected.ack = {
        sequence: pending.sequence,
        index: pending.index,
        openedAt: pending.openedAt
      };
      await pacer.beforeRead(pending.openedAt);
      snapshot = await waitChecked(worker, expected, rereadsFor(expected, watch, link)).catch(
        withPrevious
      );
      confirm(snapshot, onPresented);
      destination = await target(sink, snapshot, backlog);
    }
    destinations.set(sequence - lag, destination);
    return {destination, snapshot};
  }

  /**
   * Opens the gate that submits `sequence`, receives `next` and fetches into `destination`,
   * then notes when it opened for the exchange bins, the decode wait and the pacer.
   */
  async function openGate(
    gateStarted,
    {sequence, current, next, snapshot, expected, inputSlot, destination}
  ) {
    await worker.openGates({
      snapshot,
      expected,
      inputSlot,
      current: {sequence, length: current.length, pts: current.pts},
      next: next && {sequence: sequence + 1, length: next.length, pts: next.pts},
      destination,
      published,
      frame: layout,
      ...(lag !== gates.OUTPUT_LAG && {lag})
    });
    timing.record('gate', gateStarted, now(), references(expected));
    lastGate = now();
    decode?.opened(sequence, lastGate);
    if (destination) fetchOpened = lastGate;
    if (pending && destination === published) pending.openedAt = fetchOpened;
  }

  /**
   * Checks the status after access unit `sequence`, then opens the gate that submits it,
   * receives `next` and fetches the output two behind it.
   * @param {number} sequence
   * @param {{length: number, pts: bigint}} current
   * @param {{length: number, pts: bigint}} next
   * @param {any} hooks
   */
  async function gate(
    sequence,
    current,
    next,
    {
      sink,
      enter = () => {},
      onDecoded,
      onPresented,
      onSkipped,
      onGate,
      onTrimmed,
      arrivedAt,
      backlog = 0
    }
  ) {
    enter('staggered-status');
    const expected = expectedFor(sequence, units, destinations, lag);
    if (vsyncRule) pendingAck(expected, backlog);
    if (expected.ack && !expected.ack.optional)
      await pacer.beforeRead(vsyncRule ? pending.openedAt : fetchOpened);
    const watch = acquireWatch(expected);
    const link = receiveWatch(expected);
    let snapshot = await waitChecked(worker, expected, rereadsFor(expected, watch, link)).catch(
      withPrevious
    );
    countRead(expected, snapshot, onDecoded, onPresented, onSkipped);
    enter('staggered-input');
    const inputSlot = await worker.inputSlot(
      sequence === 1 ? firstInput.index : snapshot.input.nextIndex
    );
    let destination = null;
    if (sequence > lag) {
      enter('destination');
      const hooks = {sink, onPresented, onTrimmed, arrivedAt, backlog};
      ({destination, snapshot} = await pickDestination(
        sequence,
        snapshot,
        expected,
        watch,
        link,
        hooks
      ));
    }
    enter('staggered-gate');
    const gateStarted = now();
    onGate?.(gateStarted);
    await openGate(gateStarted, {
      sequence,
      current,
      next,
      snapshot,
      expected,
      inputSlot,
      destination
    });
  }

  /**
   * Waits for the input worker to submit the last unit.
   * @param {number} sequence
   */
  async function waitFinalInput(sequence) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const snapshot = await worker.readStatus();
      if (snapshot.input.sequence === sequence) {
        if (snapshot.input.sendStatus !== 0n) throw Error('Final staggered decoder submit failed');
        return;
      }
      await pause(POLL_MS);
    }
    throw Error('Final staggered input submit timed out');
  }

  return {
    async factory(options) {
      if (worker || retained) throw Error('Staggered worker already exists');
      transport = options.transport;
      worker = await createWorker(gateOnReceive ? {...options, gateOnReceive} : options);
      return worker;
    },

    start({input, frame}) {
      if (!worker || ready || retained) throw Error('Staggered worker is not ready to start');
      if (input?.status !== 0 || !Number.isInteger(input.index) || input.index < 0)
        throw Error('Staggered host IDR did not prime an input slot');
      if (!frame) throw Error('Staggered worker needs the host IDR frame layout');
      firstInput = input;
      layout = frame;
      ready = true;
    },

    /**
     * Gates the held unit with `unit` as its next, or starts the workers with the first unit,
     * then sends `unit` and holds it. Under gateOnReceive it primes `unit` instead, sends it
     * and gates it with no next.
     * @param {{data: Buffer, pts: number | bigint, arrivedAt?: number}} unit
     * @param {any} [hooks]
     */
    async push(unit, hooks = {}) {
      if (!ready || finished || retained) throw Error('Staggered worker is not running');
      const next = {length: unit.data.length, pts: BigInt(unit.pts)};
      if (next.length < 1 || next.length > transport.maxAccessUnit)
        throw Error('Access unit does not fit the staggered receive buffer');
      const enter = hooks.enter || (() => {});
      if (held) {
        if (!(next.pts > held.pts)) throw Error('Staggered loop needs increasing access-unit PTS');
        if (gateOnReceive) {
          enter('staggered-prime');
          await worker.primeInput({sequence: held.sequence + 1, ...next});
        } else await gate(held.sequence, held, next, {...hooks, arrivedAt: unit.arrivedAt});
      } else {
        enter('staggered-start');
        await worker.start({sequence: 1, ...next});
      }
      const sequence = held ? held.sequence + 1 : 1;
      remember(sequence, next);
      enter('staggered-send');
      await transport.send(unit.data);
      lastSend = now();
      hooks.onSent?.(lastSend);
      receive?.sent(sequence, next.length, lastSend);
      if (gateOnReceive) await gate(sequence, next, null, {...hooks, arrivedAt: unit.arrivedAt});
      held = {sequence, ...next};
      counts.submitted++;
    },

    /**
     * Gates the last unit (already gated under gateOnReceive), stops the input worker and
     * drains the last `lag` outputs.
     * @param {any} [hooks]
     * @returns {Promise<{drained: number}>}
     */
    async finish(hooks = {}) {
      if (!held || finished || retained) return {drained: 0};
      finished = true;
      const {sink, enter = () => {}, onDecoded, onPresented, onSkipped} = hooks;
      const last = held.sequence;
      if (!gateOnReceive)
        await gate(last, held, {length: 1, pts: held.pts + 1n}, {...hooks, backlog: 0});
      held = null;
      enter('staggered-tail');
      await waitFinalInput(last);
      await worker.stopInput();
      for (let sequence = Math.max(1, last - lag + 1); sequence <= last; sequence++) {
        const expected = tailExpected(sequence, units, destinations);
        const snapshot = await waitOutput(worker, expected, waits).catch(withPrevious);
        counts.decoded++;
        onDecoded?.(1);
        shown(expected, onPresented, onSkipped);
        if (expected.ack) pending = null;
        enter('destination');
        const destination = await target(sink, snapshot, 0);
        enter('staggered-tail');
        await worker.drainOutput({snapshot, expected, destination, frame: layout});
        destinations.set(sequence, destination);
        counts.tailDrained++;
      }
      const final = destinations.get(last);
      await waitOutput(
        worker,
        {
          acquire: {sequence: last, pts: units.get(last).pts},
          fetch: {sequence: last},
          ack: {sequence: final.sequence, index: final.index}
        },
        waits
      ).catch(withPrevious);
      counts.presented++;
      onPresented?.(1);
      await worker.stopOutput();
      return {drained: counts.tailDrained};
    },

    async snapshot() {
      return worker ? jsonSafe(await worker.readStatus()) : null;
    },

    async stop() {
      if (retained) throw Error(RESTART);
      if (!worker) return;
      try {
        await worker.stop();
      } catch (error) {
        retained = true;
        throw Error(`${RESTART} (${error.message})`, {cause: error});
      }
      if (worker.diagnostics.retained) {
        retained = true;
        throw Error(RESTART);
      }
      ready = false;
    },

    get exists() {
      return worker !== null;
    },

    get pending() {
      return held !== null && !finished;
    },

    get counts() {
      return {
        ...counts,
        pacer: pacer.counters,
        waiting: {...waiting},
        exchanges: timing.counts,
        ...(receive && {receive: {...receiveSlept, fixedMs: receive.fixedMs}}),
        acquireWaits: acquireWaits.counts,
        fetchWaits: fetchWaits.counts
      };
    },

    get retained() {
      return retained || Boolean(worker?.diagnostics.retained);
    }
  };
}

export {create, waitChecked, waitOutput, expectedFor, createAcquireWaits, RESTART, TRIM_FRAMES};
