// Host scheduler for the staggered lag-2 live path. The input worker receives each access
// unit over native TCP and the output worker fetches the unit two behind it, so a steady
// frame costs one checked status read and one combined gate write. Every gate goes through
// the worker's checked writes (staggered-gate / staggered-status); call order, the odd tail
// drain and stop follow sdk/tools/probe-staggered-ladder.cjs.
const checked = require('./staggered-status.cjs');

const RESTART = 'Staggered worker native objects retained; restart SmileBASIC';
const PENDING_INPUT = [0x100en, 0x1011n];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const immediate = () => new Promise(resolve => setImmediate(resolve));

async function waitChecked(
  worker,
  expected,
  {timeoutMs = 5000, pause = delay, onReread = () => {}} = {}
) {
  const until = Date.now() + timeoutMs;
  let nextInputRetry = 0;
  while (Date.now() < until) {
    const snapshot = await worker.readStatus();
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
    }
    onReread();
    await pause(5);
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
    value.ack = {sequence: destination.sequence, index: destination.index};
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
  pause = delay
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
  const counts = {submitted: 0, decoded: 0, presented: 0, tailDrained: 0, rereads: 0};
  const waits = {timeoutMs, pause};
  // A late gate status is reread back to back: a pause costs the frame its vsync slot
  // (request-budget.cjs staggeredRetryWait). The deadline still bounds the wait.
  const rereads = {timeoutMs, pause: immediate, onReread: () => counts.rereads++};

  function remember(sequence, unit) {
    units.set(sequence, unit);
    units.delete(sequence - 3);
    destinations.delete(sequence - 4);
  }

  async function gate(sequence, current, next, {sink, enter = () => {}, onDecoded, onPresented}) {
    enter('staggered-status');
    const expected = expectedFor(sequence, units, destinations);
    const snapshot = await waitChecked(worker, expected, rereads);
    if (expected.acquire) {
      counts.decoded++;
      onDecoded?.(1);
    }
    if (expected.ack) {
      counts.presented++;
      onPresented?.(1);
    }
    enter('staggered-input');
    const inputSlot = await worker.inputSlot(
      sequence === 1 ? firstInput.index : snapshot.input.nextIndex
    );
    let destination = null;
    if (sequence >= 3) {
      enter('destination');
      destination = await sink.workerDestination({
        current: snapshot.current,
        applied: snapshot.nativeApplied
      });
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
      frame: layout
    });
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
      const {sink, enter = () => {}, onDecoded, onPresented} = hooks;
      const last = held.sequence;
      await gate(last, held, {length: 1, pts: held.pts + 1n}, hooks);
      held = null;
      enter('staggered-tail');
      await waitFinalInput(last);
      await worker.stopInput();
      for (let sequence = Math.max(1, last - 1); sequence <= last; sequence++) {
        const prior = destinations.get(sequence - 1);
        const expected = {acquire: {sequence, pts: units.get(sequence).pts}};
        if (prior) {
          expected.fetch = {sequence: sequence - 1};
          expected.ack = {sequence: prior.sequence, index: prior.index};
        }
        const snapshot = await waitOutput(worker, expected, waits);
        counts.decoded++;
        onDecoded?.(1);
        if (prior) {
          counts.presented++;
          onPresented?.(1);
        }
        enter('destination');
        const destination = await sink.workerDestination({
          current: snapshot.current,
          applied: snapshot.nativeApplied
        });
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
      return {...counts};
    },

    get retained() {
      return retained || Boolean(worker?.diagnostics.retained);
    }
  };
}

module.exports = {create, waitChecked, waitOutput, expectedFor, RESTART};
