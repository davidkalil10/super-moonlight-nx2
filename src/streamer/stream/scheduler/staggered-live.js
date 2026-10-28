/**
 * Host scheduler for the staggered live path: a steady frame costs one checked status read and
 * one combined gate write. Skip, trim, vsync rule, gate on receive, gate queue, rereads and
 * exchange timing follow the flags and invariants in src/streamer/stream/CLAUDE.md.
 */
import * as presentPacer from './present-pacer.js';
import * as decodeWaits from './decode-wait.js';
import * as receiveWaits from './receive-wait.js';
import * as surfaceChecks from './surface-check.js';
import * as exchangeTiming from './exchange-timing.js';
import * as gates from '../worker/staggered-gate.js';
import {create as createGateQueue} from './gate-queue.js';
import {create as createStaggeredWorker} from '../worker/staggered-worker.js';
import {
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
} from './staggered-checks.js';

const RESTART = 'Staggered worker native objects retained; restart SmileBASIC';
/** Host backlog above which an output is fetched off screen instead of presented. */
const SKIP_BACKLOG = 2;
/** Most outputs skipped in a row before one is presented again. */
const MAX_SKIPS = 4;
/** Gates in a row the unit in hand must be stale at before one output is trimmed. */
const TRIM_FRAMES = 3;
const SKIP_RULES = ['backlog', 'vsync'];
const DEFAULT_PRESENT_HZ = 60;

/** @typedef {import('../worker/staggered-status.js').Expected} Expected */
/** @typedef {import('./staggered-checks.js').WaitOptions} WaitOptions */

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
 * @param {boolean} [options.gateQueue] run those gates off push() (gate on receive only)
 * @param {0 | 1 | 2} [options.lag] fetch each output this many gates after its decode opened
 * @param {boolean} [options.decodeWait] sleep through a pending acquire (vsync rule only)
 * @param {boolean} [options.receiveWait] sleep through a pending receive
 * @param {number} [options.surfaceCheck] sample every this many published surfaces, 0 for off
 * @param {{beforeMs: number, afterMs: number} | null} [options.avoid] span around a predicted
 *   decode-done or receive-done no status read starts in
 * @param {boolean} [options.stageTicks] the workers stamp console ticks (HBL_STAGE_TICKS=1)
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
  gateQueue = false,
  lag = gates.OUTPUT_LAG,
  decodeWait = false,
  receiveWait = false,
  surfaceCheck = 0,
  avoid = null,
  stageTicks = false,
  now = Date.now
} = {}) {
  if (!SKIP_RULES.includes(skipRule)) throw Error('Unknown staggered skip rule ' + skipRule);
  const vsyncRule = skipRule === 'vsync';
  if (decodeWait && !vsyncRule) throw Error('The decode wait needs the vsync skip rule');
  if (trimBacklogMs !== null && vsyncRule) throw Error('The backlog trim needs the backlog rule');
  if (trimBacklogMs !== null && skipBacklog < 1)
    throw Error('The backlog trim needs a skip backlog of at least 1');
  if (lag !== 0 && lag !== 1 && lag !== gates.OUTPUT_LAG)
    throw Error('The staggered output lag is 0, 1 or 2');
  if (gateQueue && !gateOnReceive) throw Error('The gate queue needs gate on receive');

  const periodMs = 1000 / presentHz;
  let worker = null;
  let transport = null;
  let firstInput = null;
  let layout = null;
  let ready = false;
  let finished = false;
  let retained = false;
  let held = null;
  /** The held unit's gate queue, under gateQueue. */
  let queue = null;
  /** The last unit primed, which a queued gate before it carries (invariant 11). */
  let primed = 0;
  // The prime and gate writes, one at a time (invariant 10).
  /** @type {Promise<unknown>} */
  let writes = Promise.resolve();
  /** The error of a queued gate that stop() dropped, for the caller to log. */
  let gateError = null;
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
  /** The lag 0 gate that timed out on the decoder, see lagEnd(). */
  let fallback = null;
  let sampleSink = null;
  const surfaces = surfaceCheck
    ? surfaceChecks.create({
        every: surfaceCheck,
        read: (index, offset, bytes) => sampleSink.sample(index, offset, bytes)
      })
    : null;
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
  const acquireWatch = expected => {
    if (!decode || !expected.acquire) return null;
    return {unit: expected.acquire.sequence, pendingSeen: false, acquired: false, waited: false};
  };

  /**
   * One per gate: the receive it expects and what its reads have seen of it.
   * @param {Expected} expected
   */
  const receiveWatch = expected => {
    if (!receive) return null;
    return {
      unit: expected.receive.sequence,
      bytes: expected.receive.bytes,
      pendingSeen: false,
      received: false,
      waited: false
    };
  };

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
      queue?.observeReceive(snapshot.receive.sequence);
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

  /**
   * Keeps the units and destinations later gates still check, with one more for a queued gate
   * still running behind the producer, and drops older ones.
   */
  function remember(sequence, unit) {
    units.set(sequence, unit);
    units.delete(sequence - 5);
    destinations.delete(sequence - 5);
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
   * Ends a lag 0 run on a decoder timeout instead of switching lag (invariants 3 and 4).
   * @param {any} error
   * @param {number} sequence
   * @param {Expected} expected
   */
  function lagEnd(error, sequence, expected) {
    const waitedFor = expected[error.pending]?.sequence;
    const decoderTimeout = error.timedOut && ['acquire', 'fetch'].includes(error.pending);
    if (lag !== 0 || !decoderTimeout) return error;

    fallback = {
      at: sequence,
      waitedFor,
      reason: `${error.pending} ${waitedFor} timed out at lag 0`,
      recommendedLag: 1
    };
    error.lagEnd = {...fallback};
    return error;
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
    const wantsSkip = backlog > skipBacklog || trim;
    if (published && wantsSkip && skips < MAX_SKIPS) {
      const discard = await sink.discardDestination(presentation);
      if (discard) {
        skips++;
        stale = 0;
        // Not over the backlog, so the trim asked for this skip.
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
   * Runs `write` once the prime or gate write before it has its reply.
   * @template T
   * @param {() => Promise<T>} write
   * @returns {Promise<T>}
   */
  function inOrder(write) {
    const run = writes.then(write);
    writes = run.catch(() => {});
    return run;
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
      error => withPrevious(lagEnd(error, sequence, expected))
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

    // On the gate path, but only for a sampled surface: the re-read must beat the refill.
    sampleSink = sink;
    if (surfaces) await surfaces.reuse(destination);

    enter('staggered-gate');
    await inOrder(() => {
      if (primed > sequence) next = units.get(sequence + 1);
      const gateStarted = now();
      onGate?.(gateStarted);
      return openGate(gateStarted, {
        sequence,
        current,
        next,
        snapshot,
        expected,
        inputSlot,
        destination
      });
    });

    if (surfaces && expected.fetch)
      await surfaces.first(expected.fetch.sequence, destinations.get(expected.fetch.sequence));
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
      worker = await createWorker({
        ...options,
        ...(gateOnReceive && {gateOnReceive}),
        ...(stageTicks && {stageTicks})
      });
      return worker;
    },

    start({input, frame}) {
      if (!worker || ready || retained) throw Error('Staggered worker is not ready to start');
      if (input?.status !== 0 || !Number.isInteger(input.index) || input.index < 0)
        throw Error('Staggered host IDR did not prime an input slot');
      if (!frame) throw Error('Staggered worker needs the host IDR frame layout');
      firstInput = input;
      layout = frame;
      surfaces?.start(frame);
      ready = true;
    },

    /**
     * Gates the held unit with `unit` as its next, or starts the workers with the first unit,
     * then sends `unit` and holds it. Under gateOnReceive it primes `unit` instead, sends it
     * and gates it with no next; under gateQueue it waits for the queue to admit the prime and
     * queues the gate instead of awaiting it, and the queued gates count toward the backlog.
     * @param {{data: Buffer, pts: number | bigint, arrivedAt?: number}} unit
     * @param {any} [hooks]
     */
    async push(unit, hooks = {}) {
      if (!ready || finished || retained) throw Error('Staggered worker is not running');
      const next = {length: unit.data.length, pts: BigInt(unit.pts)};
      if (next.length < 1 || next.length > transport.maxAccessUnit)
        throw Error('Access unit does not fit the staggered receive buffer');

      const enter = hooks.enter || (() => {});
      const sequence = held ? held.sequence + 1 : 1;
      if (held && !(next.pts > held.pts))
        throw Error('Staggered loop needs increasing access-unit PTS');

      if (held && !gateOnReceive)
        await gate(held.sequence, held, next, {...hooks, arrivedAt: unit.arrivedAt});
      if (!held && gateQueue) queue = createGateQueue();
      if (queue) await queue.admit(sequence);

      remember(sequence, next);
      if (!held) {
        enter('staggered-start');
        await worker.start({sequence: 1, ...next});
      } else if (gateOnReceive) {
        enter('staggered-prime');
        await inOrder(() => {
          primed = sequence;
          return worker.primeInput({sequence, ...next});
        });
      }

      enter('staggered-send');
      await transport.send(unit.data);
      lastSend = now();
      hooks.onSent?.(lastSend);
      receive?.sent(sequence, next.length, lastSend);

      const gateHooks = {...hooks, arrivedAt: unit.arrivedAt};
      if (queue) {
        const backlog = (hooks.backlog ?? 0) + queue.depth;
        queue.push(sequence, () => gate(sequence, next, null, {...gateHooks, backlog}));
      } else if (gateOnReceive) await gate(sequence, next, null, gateHooks);

      held = {sequence, ...next};
      counts.submitted++;
    },

    /**
     * Gates the last unit (already gated under gateOnReceive, once the queue drained under
     * gateQueue), stops the input worker and drains the last `lag` outputs. With lag 0 the
     * last gate already opened the last fetch, so the tail drains none and only waits for it.
     * @param {any} [hooks]
     * @returns {Promise<{drained: number}>}
     */
    async finish(hooks = {}) {
      if (!held || finished || retained) return {drained: 0};
      finished = true;
      const {sink, enter = () => {}, onDecoded, onPresented, onSkipped} = hooks;
      const last = held.sequence;

      if (queue) await queue.drain();
      if (!gateOnReceive)
        await gate(last, held, {length: 1, pts: held.pts + 1n}, {...hooks, backlog: 0});
      held = null;
      queue = null;

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

      if (lag === 0) {
        counts.decoded++;
        onDecoded?.(1);
      }
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
      if (queue) {
        // Units already primed and sent; dropping their gates is safe (invariant 7).
        // The running one finishes.
        queue.clear();
        await queue.drain().catch(error => {
          gateError = error;
        });
      }

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

    /** The error of the last queued gate when stop() ran, or null. */
    get gateError() {
      return gateError;
    },

    get pending() {
      return held !== null && !finished;
    },

    /** Gates queued or running under gateQueue. */
    get queued() {
      return queue?.depth ?? 0;
    },

    get counts() {
      return {
        ...counts,
        pacer: pacer.counters,
        waiting: {...waiting},
        exchanges: timing.counts,
        ...(receive && {receive: {...receiveSlept, fixedMs: receive.fixedMs}}),
        acquireWaits: acquireWaits.counts,
        fetchWaits: fetchWaits.counts,
        ...(fallback && {lagEnd: {...fallback}}),
        ...(surfaces && {surfaceCheck: surfaces.counts})
      };
    },

    /** The surface samples re-read since the last call. */
    takeSurfaces() {
      return surfaces?.take() ?? [];
    },

    get retained() {
      return retained || Boolean(worker?.diagnostics.retained);
    }
  };
}

export {create, waitChecked, waitOutput, expectedFor, createAcquireWaits, RESTART, TRIM_FRAMES};
