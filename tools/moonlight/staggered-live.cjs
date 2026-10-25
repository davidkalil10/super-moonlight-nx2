// Host scheduler for the staggered lag-2 live path. The input worker receives each access
// unit over native TCP and the output worker fetches the unit two behind it, so a steady
// frame costs one checked status read and one combined gate write. Every gate goes through
// the worker's checked writes (staggered-gate / staggered-status); call order, the odd tail
// drain and stop follow sdk/tools/probe-staggered-ladder.cjs.
// With more than SKIP_BACKLOG units queued on the host, an output is still fetched and
// released but copied to a free surface behind a replay of the last applied publication,
// so the shader keeps it off screen and the next gate does not wait for a present.
const checked = require('./staggered-status.cjs');
const presentPacer = require('./present-pacer.cjs');

const RESTART = 'Staggered worker native objects retained; restart SmileBASIC';
const SKIP_BACKLOG = 2;
const MAX_SKIPS = 4;
const PENDING_INPUT = [0x100en, 0x1011n];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const immediate = () => new Promise(resolve => setImmediate(resolve));

async function waitChecked(
  worker,
  expected,
  {timeoutMs = 5000, pause = delay, onReread = () => {}, onRead = () => {}, now = Date.now} = {}
) {
  const until = Date.now() + timeoutMs;
  let nextInputRetry = 0;
  let pending = null;
  while (Date.now() < until) {
    const startedAt = now();
    const snapshot = await worker.readStatus();
    onRead(snapshot, startedAt);
    try {
      checked.check(snapshot, expected);
      return snapshot;
    } catch (error) {
      if (!error.retryable) throw error;
      if (
        Date.now() >= nextInputRetry &&
        expected.input &&
        snapshot.receive.sequence === expected.receive.sequence &&
        snapshot.receive.count === BigInt(expected.receive.bytes) &&
        snapshot.input.sequence === expected.input.sequence &&
        snapshot.input.nextIndex < 0 &&
        PENDING_INPUT.includes(snapshot.input.nextSlotStatus)
      ) {
        await worker.retryInputSlot(expected.input.sequence);
        nextInputRetry = Date.now() + 20;
      }
      onReread(error.pending);
      pending = error.pending;
    }
    await pause(5, pending);
  }
  throw Error('Staggered checked status timed out');
}

async function waitOutput(worker, expected, {timeoutMs = 5000, pause = delay} = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const snapshot = await worker.readStatus();
    try {
      checked.checkOutput(snapshot, expected);
      return snapshot;
    } catch (error) {
      if (!error.retryable) throw error;
    }
    await pause(5);
  }
  throw Error('Staggered tail output timed out');
}

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

function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item))
  );
}

function create({
  createWorker = require('./staggered-worker.cjs').create,
  timeoutMs = 5000,
  pause = delay,
  presentHz = 60,
  now = Date.now
} = {}) {
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
    rereads: 0
  };
  let published = null;
  let skips = 0;
  const waiting = {};
  const waits = {timeoutMs, pause};
  // A gate late on receive, acquire or fetch rereads back to back: a pause costs the
  // frame its vsync slot (request-budget.cjs staggeredRetryWait). A gate waiting for the
  // renderer to apply a publication sleeps to the predicted vsync instead, since polling
  // there only fills the bridge. The deadline bounds both.
  const pacer = presentPacer.create({periodMs: 1000 / presentHz, now, sleep: ms => pause(ms)});
  let fetchOpened = null;
  const rereadsFor = expected => ({
    timeoutMs,
    now,
    pause: (_ms, pending) => (pending === 'applied' ? pacer.pending() : immediate()),
    onRead: (snapshot, startedAt) => {
      if (expected.ack)
        pacer.observe(
          startedAt,
          (snapshot.nativeApplied - expected.ack.sequence) >>> 0 < 0x80000000
        );
    },
    onReread: pending => {
      counts.rereads++;
      waiting[pending] = (waiting[pending] || 0) + 1;
    }
  });

  function remember(sequence, unit) {
    units.set(sequence, unit);
    units.delete(sequence - 3);
    destinations.delete(sequence - 4);
  }

  function shown(expected, onPresented, onSkipped) {
    if (expected.ack) {
      counts.presented++;
      onPresented?.(1);
    } else if (expected.fetch) {
      counts.skipped++;
      onSkipped?.(1);
    }
  }

  async function target(sink, snapshot, backlog) {
    const presentation = {current: snapshot.current, applied: snapshot.nativeApplied};
    if (published && backlog > SKIP_BACKLOG && skips < MAX_SKIPS) {
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

  async function gate(
    sequence,
    current,
    next,
    {sink, enter = () => {}, onDecoded, onPresented, onSkipped, backlog = 0}
  ) {
    enter('staggered-status');
    const expected = expectedFor(sequence, units, destinations);
    if (expected.ack) await pacer.beforeRead(fetchOpened);
    const snapshot = await waitChecked(worker, expected, rereadsFor(expected));
    if (expected.acquire) {
      counts.decoded++;
      onDecoded?.(1);
    }
    shown(expected, onPresented, onSkipped);
    enter('staggered-input');
    const inputSlot = await worker.inputSlot(
      sequence === 1 ? firstInput.index : snapshot.input.nextIndex
    );
    let destination = null;
    if (sequence >= 3) {
      enter('destination');
      destination = await target(sink, snapshot, backlog);
      destinations.set(sequence - 2, destination);
    }
    enter('staggered-gate');
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
    if (destination) fetchOpened = now();
  }

  async function waitFinalInput(sequence) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const snapshot = await worker.readStatus();
      if (snapshot.input.sequence === sequence) {
        if (snapshot.input.sendStatus !== 0n) throw Error('Final staggered decoder submit failed');
        return;
      }
      await pause(5);
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
      held = {sequence, ...next};
      counts.submitted++;
    },

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
      for (let sequence = Math.max(1, last - 1); sequence <= last; sequence++) {
        const prior = destinations.get(sequence - 1);
        const expected = {acquire: {sequence, pts: units.get(sequence).pts}};
        if (prior) {
          expected.fetch = {sequence: sequence - 1};
          if (!prior.skip) expected.ack = {sequence: prior.sequence, index: prior.index};
        }
        const snapshot = await waitOutput(worker, expected, waits);
        counts.decoded++;
        onDecoded?.(1);
        shown(expected, onPresented, onSkipped);
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
      return {...counts, waiting: {...waiting}};
    },

    get retained() {
      return retained || Boolean(worker?.diagnostics.retained);
    }
  };
}

module.exports = {create, waitChecked, waitOutput, expectedFor, RESTART};
