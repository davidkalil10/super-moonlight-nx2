/**
 * Host scheduler for the staggered lag-2 live path. The input worker receives each access
 * unit over native TCP and the output worker fetches the unit two behind it, so a steady
 * frame costs one checked status read and one combined gate write. Every gate goes through
 * the worker's checked writes (staggered-gate / staggered-status); call order, the odd tail
 * drain and stop are the ones the removed probe-staggered-ladder.cjs proved on the console.
 *
 * Skip and catch-up: with more than skipBacklog units (SKIP_BACKLOG by default) queued on the
 * host, an output is still decoded, fetched and released but copied to a free surface behind a
 * replay of the last applied publication, so the shader keeps it off screen and the next gate
 * does not wait for a present. At most MAX_SKIPS outputs in a row are skipped this way.
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
import {create as createStaggeredWorker} from './staggered-worker.js';

const RESTART = 'Staggered worker native objects retained; restart SmileBASIC';
/** Host backlog above which an output is fetched off screen instead of presented. */
const SKIP_BACKLOG = 2;
/** Most outputs skipped in a row before one is presented again. */
const MAX_SKIPS = 4;
const SKIP_RULES = ['backlog', 'vsync'];
/** AcquireInputBufferIndex results that only mean no input slot is free yet. */
const PENDING_INPUT = [0x100en, 0x1011n];
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PRESENT_HZ = 60;
const POLL_MS = 5;
/** Least time between host retries of the input worker's next-slot acquire. */
const INPUT_RETRY_MS = 20;
/** Serial-number arithmetic: a u32 distance below this means "at or after". */
const HALF_SEQUENCE_RANGE = 0x80000000;
/** The tail drains outputs from this many units before the last. */
const TAIL_UNITS = 2;

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
  while (Date.now() < until) {
    await beforeRead();
    const startedAt = now();
    const snapshot = await worker.readStatus();
    onRead(snapshot, startedAt);
    try {
      checked.check(snapshot, expected);
      return snapshot;
    } catch (error) {
      if (!error.retryable) throw error;
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
 * @param {{timeoutMs?: number, pause?: (ms: number) => Promise<unknown>}} [options]
 * @returns {Promise<Snapshot>}
 */
async function waitOutput(worker, expected, {timeoutMs = DEFAULT_TIMEOUT_MS, pause = delay} = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const snapshot = await worker.readStatus();
    try {
      checked.checkOutput(snapshot, expected);
      return snapshot;
    } catch (error) {
      if (!error.retryable) throw error;
    }
    await pause(POLL_MS);
  }
  throw Error('Staggered tail output timed out');
}

/**
 * What the gate after access unit `sequence` expects: its receive, the submit of the unit
 * before it, the output two behind it and, from the fourth gate, the fetch of the output three
 * behind and the publication that fetch presented unless it was skipped.
 * @param {number} sequence
 * @param {Map<number, {length: number, pts: bigint}>} units
 * @param {Map<number, any>} destinations Output sequence to the surface it was fetched into.
 * @returns {Expected}
 */
function expectedFor(sequence, units, destinations) {
  const value = {receive: {sequence, bytes: units.get(sequence).length}};
  if (sequence >= 2) value.input = {sequence: sequence - 1};
  if (sequence >= 3) value.acquire = {sequence: sequence - 2, pts: units.get(sequence - 2).pts};
  if (sequence >= 4) {
    const destination = destinations.get(sequence - 3);
    if (!destination) throw Error('Missing prior staggered output destination');
    value.fetch = {sequence: sequence - 3};
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
 * the time its gate write starts and onSent with the time its unit went out.
 * @param {object} [options]
 * @param {(options: any) => Promise<any>} [options.createWorker]
 * @param {number} [options.timeoutMs]
 * @param {(ms: number) => Promise<unknown>} [options.pause]
 * @param {number} [options.presentHz]
 * @param {number} [options.skipBacklog] host backlog above which an output is skipped
 * @param {'backlog' | 'vsync'} [options.skipRule]
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
  decodeWait = false,
  receiveWait = false,
  avoid = null,
  now = Date.now
} = {}) {
  if (!SKIP_RULES.includes(skipRule)) throw Error('Unknown staggered skip rule ' + skipRule);
  const vsyncRule = skipRule === 'vsync';
  if (decodeWait && !vsyncRule) throw Error('The decode wait needs the vsync skip rule');
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
    appliedPeriodMs: periodMs
  };
  let published = null;
  let pending = null;
  let skips = 0;
  const waiting = {};
  const waits = {timeoutMs, pause};
  const pacer = presentPacer.create({periodMs, now, sleep: ms => pause(ms)});
  const decode = decodeWait ? decodeWaits.create({now, sleep: ms => pause(ms)}) : null;
  const receive = receiveWait ? receiveWaits.create({now, sleep: ms => pause(ms)}) : null;
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
   * Picks the surface the next output is fetched into: a discard surface while the backlog
   * calls for a skip and the skip run is short enough, else a published one. Under the vsync
   * rule it is a discard surface while a publication is pending.
   */
  async function target(sink, snapshot, backlog) {
    const presentation = {current: snapshot.current, applied: snapshot.nativeApplied};
    if (vsyncRule) {
      if (pending) return sink.discardDestination(presentation);
      published = await sink.workerDestination(presentation);
      pending = {sequence: published.sequence, index: published.index, openedAt: null};
      return published;
    }
    if (published && backlog > skipBacklog && skips < MAX_SKIPS) {
      const discard = await sink.discardDestination(presentation);
      if (discard) {
        skips++;
        return discard;
      }
    }
    skips = 0;
    published = await sink.workerDestination(presentation);
    return published;
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
    {sink, enter = () => {}, onDecoded, onPresented, onSkipped, onGate, backlog = 0}
  ) {
    enter('staggered-status');
    const expected = expectedFor(sequence, units, destinations);
    if (vsyncRule) pendingAck(expected, backlog);
    if (expected.ack && !expected.ack.optional)
      await pacer.beforeRead(vsyncRule ? pending.openedAt : fetchOpened);
    const watch = acquireWatch(expected);
    const link = receiveWatch(expected);
    let snapshot = await waitChecked(worker, expected, rereadsFor(expected, watch, link));
    if (expected.acquire) {
      counts.decoded++;
      onDecoded?.(1);
    }
    if (vsyncRule) {
      if (expected.fetch && destinations.get(sequence - 3).skip) {
        counts.skipped++;
        onSkipped?.(1);
      }
      confirm(snapshot, onPresented);
    } else shown(expected, onPresented, onSkipped);
    enter('staggered-input');
    const inputSlot = await worker.inputSlot(
      sequence === 1 ? firstInput.index : snapshot.input.nextIndex
    );
    let destination = null;
    if (sequence >= 3) {
      enter('destination');
      destination = await target(sink, snapshot, backlog);
      if (!destination && vsyncRule) {
        expected.ack = {
          sequence: pending.sequence,
          index: pending.index,
          openedAt: pending.openedAt
        };
        await pacer.beforeRead(pending.openedAt);
        snapshot = await waitChecked(worker, expected, rereadsFor(expected, watch, link));
        confirm(snapshot, onPresented);
        destination = await target(sink, snapshot, backlog);
      }
      destinations.set(sequence - 2, destination);
    }
    enter('staggered-gate');
    const gateStarted = now();
    onGate?.(gateStarted);
    await worker.openGates({
      snapshot,
      expected,
      inputSlot,
      current: {sequence, length: current.length, pts: current.pts},
      next: {sequence: sequence + 1, length: next.length, pts: next.pts},
      destination,
      published,
      frame: layout
    });
    timing.record('gate', gateStarted, now(), references(expected));
    lastGate = now();
    decode?.opened(sequence, lastGate);
    if (destination) fetchOpened = lastGate;
    if (pending && destination === published) pending.openedAt = fetchOpened;
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
      worker = await createWorker(options);
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
     * then sends `unit` and holds it.
     * @param {{data: Buffer, pts: number | bigint}} unit
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
        await gate(held.sequence, held, next, hooks);
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
      held = {sequence, ...next};
      counts.submitted++;
    },

    /**
     * Gates the last unit, stops the input worker and drains the last two outputs.
     * @param {any} [hooks]
     * @returns {Promise<{drained: number}>}
     */
    async finish(hooks = {}) {
      if (!held || finished || retained) return {drained: 0};
      finished = true;
      const {sink, enter = () => {}, onDecoded, onPresented, onSkipped} = hooks;
      const last = held.sequence;
      await gate(last, held, {length: 1, pts: held.pts + 1n}, {...hooks, backlog: 0});
      held = null;
      enter('staggered-tail');
      await waitFinalInput(last);
      await worker.stopInput();
      for (let sequence = Math.max(1, last - TAIL_UNITS + 1); sequence <= last; sequence++) {
        const expected = tailExpected(sequence, units, destinations);
        const snapshot = await waitOutput(worker, expected, waits);
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
      );
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
      return {...counts, pacer: pacer.counters, waiting: {...waiting}, exchanges: timing.counts};
    },

    get retained() {
      return retained || Boolean(worker?.diagnostics.retained);
    }
  };
}

export {create, waitChecked, waitOutput, expectedFor, RESTART};
