// The staggered console workers: the barrier, the input and output plans and the worker.
const test = require('node:test');
const assert = require('node:assert/strict');
const {ADDRESS} = require('../../../../hbl-platform/tests/recording-rpc.cjs');
const {gateConsole, BLOCK} = require('../../../../hbl-platform/tests/gate-worker-mock.cjs');
const definitions = require('../../../sdk/native/movie-functions.json');
const registration = require('../../../sdk/native/movie-event-functions.json').registerClientEvents;
const ring = require('../../../tools/moonlight/ring.js');
const inputPlan = require('../../../host/stream/staggered-input-plan.js');
const outputPlan = require('../../../host/stream/staggered-output-plan.js');
const {
  create: createWorker,
  ACQUIRE_ACK,
  create
} = require('../../../host/stream/staggered-worker.js');
const {create: createLive} = require('../../../host/stream/staggered-live.js');
const input = require('../../../host/stream/staggered-input-plan.js');
const status = require('../../../host/stream/staggered-status.js');
const SYNC = require('../../../../hbl-platform/sdk/native/os-sync-functions.json');
const {CODE} = require('../../../../hbl-platform/sdk/native/thread.js');
const output = require('../../../host/stream/staggered-output-plan.js');
const withoutPacer = require('./test-helpers.cjs').withoutPacer('gate');

// The staggered workers' real frames on the gadget-level fake console, against a fake decoder
// whose output event is auto-clear like the device's: one bit, however many outputs are ready.
// The host side is the real staggered-live scheduler and the held-fetch checks below.
const layout = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
const noWait = async () => {};
const RECV = ADDRESS.module + 0x800;
const NO_OUTPUT = 0x2a0n;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Decode N was gated with the fetch of output N-2 held back: for the whole window the input
// worker must stay parked on the N-1 acquisition acknowledgement, so N stays unsubmitted and
// output N-2 stays the acquired one.
async function proveHeld(worker, sequence, {polls = 40, wait = pause} = {}) {
  let snapshot = null;
  for (let poll = 0; poll < polls; poll++) {
    snapshot = await worker.readStatus();
    if (snapshot.input.sequence !== sequence - 1 || snapshot.acquire.sequence !== sequence - 2)
      throw Error(`Decode ${sequence} opened while output ${sequence - 2} was held`);
    await wait(5);
  }
  return {polls, input: snapshot.input.sequence, acquire: snapshot.acquire.sequence};
}

// After the held fetch opens, every snapshot that shows decode N submitted must already show
// output N-1 acquired.
async function proveRelease(worker, sequence, {timeoutMs = 5000, wait = pause} = {}) {
  const until = Date.now() + timeoutMs;
  let polls = 0;
  while (Date.now() < until) {
    const snapshot = await worker.readStatus();
    polls++;
    if (snapshot.input.sequence >= sequence && snapshot.acquire.sequence < sequence - 1)
      throw Error(`Decode ${sequence} was submitted before output ${sequence - 1} was acquired`);
    if (snapshot.input.sequence === sequence) {
      if (snapshot.input.sendStatus !== 0n) throw Error(`Decode ${sequence} submit failed`);
      if (snapshot.fetch.sequence !== sequence - 2)
        throw Error(`Output ${sequence - 2} fetch is missing after release`);
      return {polls, acquire: snapshot.acquire.sequence};
    }
    await wait(5);
  }
  throw Error(`Decode ${sequence} did not open after output ${sequence - 2} was fetched`);
}

function device() {
  const log = [];
  const queue = [];
  const decoder = {event: null, ready: [], maxReady: 0, coalesced: 0, released: []};
  // Lag 0 probes: `holding` keeps submitted outputs back from the event, `slowFetch` blocks
  // GetOutputBuffer of one unit for some worker steps, and `fetched` and `published` log what
  // each fetch copied and each publication the shader applied.
  Object.assign(decoder, {holding: false, held: [], slowFetch: null, fetched: [], published: []});
  // `double` names a unit that decodes into two outputs under one event set.
  decoder.double = null;
  const outputs = new Map();
  let setData = null;
  let aborted = false;
  let nextInput = 0;
  let nextOutput = 0;
  let bufferIndex = 0;
  let worker = null;
  const mapped = ADDRESS.mapped;
  const sequenceOf = pts => Number(pts) / 1000;
  const natives = {
    'net.recv'([, buffer, length], memory) {
      if (queue.length) {
        const data = queue.shift();
        memory.write(buffer, data.subarray(0, length));
        return Math.min(length, data.length);
      }
      return aborted ? -1n : BLOCK;
    },
    'movie.sendInput'([, , , , pts]) {
      log.push(`submit ${sequenceOf(pts)}`);
      if (decoder.holding) {
        decoder.held.push({index: nextOutput++ % 4, pts});
        return 0;
      }
      const event = fake.events.get(decoder.event);
      if (event.set) decoder.coalesced++;
      decoder.ready.push({index: nextOutput++ % 4, pts});
      if (decoder.double === sequenceOf(pts)) decoder.ready.push({index: nextOutput++ % 4, pts});
      decoder.maxReady = Math.max(decoder.maxReady, decoder.ready.length);
      event.set = true;
      return 0;
    },
    'movie.acquireInput'([, index], memory) {
      memory.write32(index, nextInput++ % 3);
      return 0;
    },
    'movie.acquireOutput'([, index, pts], memory) {
      const output = decoder.ready.shift();
      // The SDK sets the index to -1 before it finds the list empty (lag0-re.md).
      if (!output) {
        memory.write32(index, 0xffffffff);
        return NO_OUTPUT;
      }
      log.push(`acquire ${sequenceOf(output.pts)}`);
      outputs.set(output.index, sequenceOf(output.pts));
      memory.write32(index, output.index);
      memory.write64(pts, output.pts);
      return 0;
    },
    'movie.bufferSetData'([, address]) {
      setData = Number(address);
      return 0;
    },
    'movie.getOutput'([, index]) {
      const unit = outputs.get(Number(index));
      if (unit === undefined) return NO_OUTPUT;
      const slow = decoder.slowFetch;
      if (slow?.unit === unit && slow.steps-- > 0) return BLOCK;
      decoder.fetched.push({unit, address: setData});
      return 0;
    },
    'movie.releaseOutput'([, index]) {
      decoder.released.push(index);
      return 0;
    }
  };
  const fake = gateConsole({
    advanceOnRead: true,
    natives,
    onRead(_address, _length, memory) {
      const sequence = memory.read(mapped + ring.CONTROL.nativeSequence, 4).readUInt32LE();
      if (!sequence) return;
      if (decoder.published.at(-1)?.publication !== sequence) {
        const unit = memory.read(mapped + status.STATUS.fetch + 24, 4).readUInt32LE();
        decoder.published.push({publication: sequence, unit});
      }
      memory.write32(
        mapped + ring.CONTROL.current,
        memory.read(mapped + ring.CONTROL.nativeIndex, 4).readUInt32LE()
      );
      memory.write32(mapped + ring.CONTROL.nativeApplied, sequence);
    }
  });
  const names = fake.rpc.names;
  const functions = {};
  for (const [name, definition] of Object.entries(definitions)) {
    functions[name] = ADDRESS.module + definition.offset;
    names.set(functions[name], 'movie.' + name);
  }
  names.set(ADDRESS.module + registration.offset, 'movie.register');
  names.set(RECV, 'net.recv');
  Object.assign(fake.handlers, {
    'movie.register'([, events], memory) {
      decoder.event = Number(memory.read64(events + 8n));
    },
    'movie.getInput'([, index]) {
      bufferIndex = Number(index);
    },
    'movie.bufferData': () => BigInt(ADDRESS.main + bufferIndex * 0x100000),
    'movie.bufferCapacity': () => 0x100000n,
    'movie.releaseOutput'([, index]) {
      decoder.released.push(Number(index));
    }
  });
  const transport = {
    fd: 12,
    maxAccessUnit: 0x100000,
    recvFunction: RECV,
    async send(data) {
      queue.push(Buffer.from(data));
    },
    abort() {
      aborted = true;
    }
  };
  let surfaces = 0;
  const sink = {
    async workerDestination() {
      const index = ++surfaces % 3;
      return {
        index,
        address: mapped + ring.frameOffset(index),
        bytes: ring.FRAME_BYTES,
        sequence: surfaces,
        color: 1
      };
    }
  };
  const options = {
    rpc: fake.rpc,
    module: {
      base: ADDRESS.module,
      symbols: [
        {
          name: registration.symbol,
          section: '.text',
          offset: registration.offset,
          size: registration.size
        }
      ]
    },
    functions,
    decoder: ADDRESS.heap - 0x10000,
    output: ADDRESS.heap - 0x8000,
    format: ADDRESS.heap - 0x4000,
    transport,
    publication: {mapped, color: 1}
  };
  /** Hands the held outputs to the decoder event, as a late decode would. */
  decoder.deliver = () => {
    decoder.ready.push(...decoder.held.splice(0));
    decoder.maxReady = Math.max(decoder.maxReady, decoder.ready.length);
    fake.signal(decoder.event);
  };
  return {
    fake,
    log,
    decoder,
    sink,
    get worker() {
      return worker;
    },
    async live(wrap = value => value, schedule = {}) {
      const live = createLive({
        ...schedule,
        createWorker: async settings => {
          worker = await createWorker(settings);
          return wrap(worker);
        },
        timeoutMs: 500,
        pause: noWait
      });
      await (await live.factory(options)).register();
      live.start({input: {status: 0, index: 2}, frame: layout});
      return live;
    }
  };
}

const unitAt = sequence => ({data: Buffer.alloc(100 + sequence, sequence), pts: sequence * 1000});

async function stream(live, sink, count) {
  for (let sequence = 1; sequence <= count; sequence++) await live.push(unitAt(sequence), {sink});
}

function submittedAfterAcquired(log) {
  for (const [at, entry] of log.entries()) {
    const sequence = Number(entry.split(' ')[1]);
    if (entry.startsWith('submit') && sequence > 1)
      assert.ok(log.indexOf(`acquire ${sequence - 1}`) < at, `submit ${sequence} before acquire`);
  }
}

// Gate `sequence` is opened with the N-2 fetch held; `release` then fetches it late.
function holdingAt(sequence, {release}) {
  return worker =>
    Object.create(worker, {
      openGates: {
        async value(gate) {
          if (gate.current.sequence !== sequence) return worker.openGates(gate);
          await worker.openGates({...gate, holdFetch: true});
          await release(worker, gate);
        }
      }
    });
}

test('every submit waits for the previous acquisition, so no output wake is lost', async () => {
  const d = device();
  const live = await d.live();
  await stream(live, d.sink, 9);
  assert.deepEqual(await live.finish({sink: d.sink}), {drained: 2});
  assert.deepEqual(withoutPacer(live.counts), {
    submitted: 9,
    decoded: 9,
    presented: 9,
    skipped: 0,
    tailDrained: 2,
    rereads: 6,
    appliedPeriodMs: 1000 / 60,
    waiting: {receive: 6}
  });
  assert.equal(d.decoder.coalesced, 0);
  assert.equal(d.decoder.maxReady, 1);
  submittedAfterAcquired(d.log);
  assert.deepEqual(
    d.log.filter(entry => entry.startsWith('acquire')),
    Array.from({length: 9}, (_, index) => `acquire ${index + 1}`)
  );
  await live.stop();
  await d.worker.finalize();
  assert.equal(live.retained, false);
});

test('a delayed N-2 fetch keeps decode N closed until N-1 is acquired', async () => {
  const d = device();
  const observed = {};
  const live = await d.live(
    holdingAt(4, {
      async release(worker, gate) {
        observed.held = await proveHeld(worker, 4, {polls: 10, wait: noWait});
        observed.parked = {
          log: d.log.slice(),
          ready: d.decoder.ready.length,
          gates: worker.diagnostics.decodeGateSignals
        };
        await worker.drainOutput({
          snapshot: await worker.readStatus(),
          expected: gate.expected,
          destination: gate.destination,
          frame: gate.frame
        });
        observed.released = await proveRelease(worker, 4, {timeoutMs: 500, wait: noWait});
      }
    })
  );
  await stream(live, d.sink, 7);
  assert.deepEqual(observed.held, {polls: 10, input: 3, acquire: 2});
  assert.equal(observed.parked.log.at(-1), 'submit 3');
  assert.ok(!observed.parked.log.includes('submit 4'));
  assert.equal(observed.parked.ready, 1);
  assert.equal(observed.parked.gates, 4);
  assert.equal(observed.released.acquire, 3);
  assert.deepEqual(await live.finish({sink: d.sink}), {drained: 2});
  assert.deepEqual(withoutPacer(live.counts), {
    submitted: 7,
    decoded: 7,
    presented: 7,
    skipped: 0,
    tailDrained: 2,
    rereads: 3,
    appliedPeriodMs: 1000 / 60,
    waiting: {receive: 3}
  });
  assert.equal(d.decoder.coalesced, 0);
  submittedAfterAcquired(d.log);
  await live.stop();
  await d.worker.finalize();
});

test('stopping the input worker parked on the acknowledgement submits nothing more', async () => {
  const d = device();
  let parked = null;
  const live = await d.live(
    holdingAt(4, {
      async release(worker) {
        parked = await proveHeld(worker, 4, {polls: 5, wait: noWait});
      }
    })
  );
  await stream(live, d.sink, 5);
  assert.deepEqual(parked, {polls: 5, input: 3, acquire: 2});
  const submitted = d.log.filter(entry => entry.startsWith('submit'));
  await live.stop();
  assert.equal(live.retained, false);
  assert.deepEqual(d.worker.diagnostics.joined, [true, true]);
  assert.deepEqual(
    d.log.filter(entry => entry.startsWith('submit')),
    submitted
  );
  assert.deepEqual(submitted, ['submit 1', 'submit 2', 'submit 3']);
  assert.equal((await d.worker.readStatus()).input.sequence, 3);
  assert.deepEqual(d.decoder.released.slice(-1), [1]);
  await d.worker.finalize();
});

test('a stop before the first gate wakes no fetch and submits nothing', async () => {
  const d = device();
  const live = await d.live();
  await live.push(unitAt(1), {sink: d.sink});
  await d.worker.readStatus();
  await d.worker.stopInput();
  const control = d.worker.outputEvent - 0x400;
  assert.equal(d.fake.events.get(control + outputPlan.CONTROL.fetchGate).set, false);
  assert.equal(d.fake.events.get(control + inputPlan.CONTROL.ignoredFetchGate).set, true);
  await live.stop();
  await d.worker.finalize();
  assert.deepEqual(d.log, []);
  assert.equal(live.retained, false);
});

test('gate on receive submits each unit before the next one arrives, with no lost wake', async () => {
  const d = device();
  const live = await d.live(undefined, {gateOnReceive: true});
  const submittedAtPush = [];
  for (let sequence = 1; sequence <= 9; sequence++) {
    await live.push(unitAt(sequence), {sink: d.sink});
    for (let poll = 0; poll < 5; poll++) await d.worker.readStatus();
    submittedAtPush.push((await d.worker.readStatus()).input.sequence);
  }
  assert.deepEqual(submittedAtPush, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(await live.finish({sink: d.sink}), {drained: 2});
  const counts = withoutPacer(live.counts);
  assert.equal(counts.decoded, 9);
  assert.equal(counts.presented, 9);
  assert.equal(d.decoder.coalesced, 0);
  assert.equal(d.decoder.maxReady, 1);
  submittedAfterAcquired(d.log);
  assert.deepEqual(
    d.log.filter(entry => entry.startsWith('acquire')),
    Array.from({length: 9}, (_, index) => `acquire ${index + 1}`)
  );
  await live.stop();
  await d.worker.finalize();
  assert.equal(live.retained, false);
});

test('by default decode N waits for unit N+1', async () => {
  const d = device();
  const live = await d.live();
  const submittedAtPush = [];
  for (let sequence = 1; sequence <= 5; sequence++) {
    await live.push(unitAt(sequence), {sink: d.sink});
    for (let poll = 0; poll < 5; poll++) await d.worker.readStatus();
    submittedAtPush.push((await d.worker.readStatus()).input.sequence);
  }
  assert.deepEqual(submittedAtPush, [0, 1, 2, 3, 4]);
  await live.finish({sink: d.sink});
  await live.stop();
  await d.worker.finalize();
});

test('stopping a worker parked on the length gate submits nothing more', async () => {
  const d = device();
  const live = await d.live(undefined, {gateOnReceive: true});
  await stream(live, d.sink, 4);
  for (let poll = 0; poll < 5; poll++) await d.worker.readStatus();
  const submitted = d.log.filter(entry => entry.startsWith('submit'));
  assert.deepEqual(submitted, ['submit 1', 'submit 2', 'submit 3', 'submit 4']);
  await live.stop();
  assert.equal(live.retained, false);
  assert.deepEqual(d.worker.diagnostics.joined, [true, true]);
  assert.deepEqual(
    d.log.filter(entry => entry.startsWith('submit')),
    submitted
  );
  await d.worker.finalize();
});

async function fetchedAtPush(d, live, units) {
  const fetched = [];
  for (let sequence = 1; sequence <= units; sequence++) {
    await live.push(unitAt(sequence), {sink: d.sink});
    for (let poll = 0; poll < 5; poll++) await d.worker.readStatus();
    fetched.push((await d.worker.readStatus()).fetch.sequence);
  }
  return fetched;
}

test('by default each output is fetched two gates after its decode opened', async () => {
  const d = device();
  const live = await d.live();
  assert.deepEqual(await fetchedAtPush(d, live, 9), [0, 0, 0, 1, 2, 3, 4, 5, 6]);
  await live.finish({sink: d.sink});
  await live.stop();
  await d.worker.finalize();
});

test(
  'at lag 1 each output is fetched one gate after its decode opened',
  {timeout: 2000},
  async () => {
    const d = device();
    const live = await d.live(undefined, {lag: 1});
    assert.deepEqual(await fetchedAtPush(d, live, 9), [0, 0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(await live.finish({sink: d.sink}), {drained: 1});
    const counts = withoutPacer(live.counts);
    assert.equal(counts.decoded, 9);
    assert.equal(counts.presented, 9);
    assert.equal(counts.tailDrained, 1);
    assert.equal(d.decoder.coalesced, 0);
    assert.equal(d.decoder.maxReady, 1);
    submittedAfterAcquired(d.log);
    assert.deepEqual(
      d.log.filter(entry => entry.startsWith('acquire')),
      Array.from({length: 9}, (_, index) => `acquire ${index + 1}`)
    );
    await live.stop();
    await d.worker.finalize();
    assert.equal(live.retained, false);
  }
);

test('lag 1 and gate on receive together keep the barrier', {timeout: 2000}, async () => {
  const d = device();
  const live = await d.live(undefined, {lag: 1, gateOnReceive: true});
  assert.deepEqual(await fetchedAtPush(d, live, 9), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(await live.finish({sink: d.sink}), {drained: 1});
  assert.equal(withoutPacer(live.counts).presented, 9);
  assert.equal(d.decoder.coalesced, 0);
  assert.equal(d.decoder.maxReady, 1);
  submittedAfterAcquired(d.log);
  await live.stop();
  await d.worker.finalize();
  assert.equal(live.retained, false);
});

// Each prime is checked against the furthest receive a gate read saw: never two units ahead.
test('the gate queue keeps every length-gate wake and descriptor over 200 units', async () => {
  const d = device();
  let live = null;
  let seen = 0;
  let overlapped = 0;
  const watch = worker =>
    Object.create(worker, {
      readStatus: {
        async value() {
          const snapshot = await worker.readStatus();
          seen = Math.max(seen, snapshot.receive.sequence);
          return snapshot;
        }
      },
      primeInput: {
        async value(unit) {
          assert.ok(unit.sequence - seen <= 1, `unit ${unit.sequence} primed two ahead`);
          assert.ok(live.queued < 2, `unit ${unit.sequence} primed past the queue depth`);
          if (live.queued) overlapped++;
          return worker.primeInput(unit);
        }
      }
    });
  live = await d.live(watch, {gateOnReceive: true, gateQueue: true});
  await stream(live, d.sink, 200);
  assert.deepEqual(await live.finish({sink: d.sink}), {drained: 2});
  assert.ok(overlapped > 0, 'some primes went out while the gate before them still ran');
  const counts = withoutPacer(live.counts);
  assert.equal(counts.decoded, 200);
  assert.equal(counts.presented, 200);
  assert.equal(d.decoder.coalesced, 0);
  assert.equal(d.decoder.maxReady, 1);
  submittedAfterAcquired(d.log);
  assert.deepEqual(
    d.log.filter(entry => entry.startsWith('acquire')),
    Array.from({length: 200}, (_, index) => `acquire ${index + 1}`)
  );
  await live.stop();
  await d.worker.finalize();
  assert.equal(live.retained, false);
});

// Each rpc is its own POST, so a gate write that reaches the bridge late would land after a prime
// sent behind it and zero the primed descriptor. Here every gate write is held before it lands,
// and each prime waits a little for one to be in flight, the order that loses it.
test('a queued gate write that lands late never lets a prime overtake it', async () => {
  const d = device();
  let gating = 0;
  let overtaken = 0;
  let primes = 0;
  const watch = worker =>
    Object.create(worker, {
      openGates: {
        async value(options) {
          gating++;
          try {
            await new Promise(resolve => setTimeout(resolve, 2));
            return await worker.openGates(options);
          } finally {
            gating--;
          }
        }
      },
      primeInput: {
        async value(unit) {
          primes++;
          const until = performance.now() + 5;
          while (!gating && performance.now() < until)
            await new Promise(resolve => setImmediate(resolve));
          if (gating) overtaken++;
          return worker.primeInput(unit);
        }
      }
    });
  const live = await d.live(watch, {gateOnReceive: true, gateQueue: true});
  await stream(live, d.sink, 50);
  assert.deepEqual(await live.finish({sink: d.sink}), {drained: 2});
  assert.equal(primes, 49);
  assert.equal(overtaken, 0, 'a prime went out while a gate write was still in flight');
  const counts = withoutPacer(live.counts);
  assert.equal(counts.decoded, 50);
  assert.equal(counts.presented, 50);
  await live.stop();
  await d.worker.finalize();
  assert.equal(live.retained, false);
});

// Counts the signals of the output worker's fetch gate, and those that found it still set and
// so merged with one not yet waited for. The worker frames and the host both set it here.
function watchFetchGate(d) {
  const control = d.worker.outputEvent - 0x400;
  const state = d.fake.events.get(control + outputPlan.CONTROL.fetchGate);
  assert.ok(state, 'fetch gate initialized');
  const watched = {signals: 0, merged: 0, state};
  let set = state.set;
  Object.defineProperty(state, 'set', {
    get: () => set,
    set(value) {
      if (value) {
        watched.signals++;
        if (set) watched.merged++;
      }
      set = value;
    }
  });
  return watched;
}

// At lag 0 every publication is the fetch of its own unit, into the surface reserved for it.
function ownUnits(d, units) {
  assert.deepEqual(
    d.decoder.fetched,
    Array.from({length: units}, (_, index) => ({
      unit: index + 1,
      address: ADDRESS.mapped + ring.frameOffset((index + 1) % 3)
    }))
  );
  assert.ok(d.decoder.published.length > 0);
  for (const {publication, unit} of d.decoder.published) assert.equal(unit, publication);
}

test('at lag 0 each output is fetched by its own gate', {timeout: 2000}, async () => {
  const d = device();
  const live = await d.live(undefined, {lag: 0});
  const fetchGate = watchFetchGate(d);
  assert.deepEqual(await fetchedAtPush(d, live, 9), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(await live.finish({sink: d.sink}), {drained: 0});
  const counts = withoutPacer(live.counts);
  assert.equal(counts.decoded, 9);
  assert.equal(counts.presented, 9);
  assert.equal(counts.tailDrained, 0);
  // One signal per gate, plus the stop wake of the output worker.
  assert.deepEqual(fetchGate, {signals: 10, merged: 0, state: fetchGate.state});
  ownUnits(d, 9);
  await live.stop();
  await d.worker.finalize();
  assert.equal(live.retained, false);
});

test('200 units at lag 0 never stall or merge a fetch signal', {timeout: 60000}, async () => {
  const d = device();
  const live = await d.live(undefined, {lag: 0});
  const fetchGate = watchFetchGate(d);
  await stream(live, d.sink, 200);
  assert.deepEqual(await live.finish({sink: d.sink}), {drained: 0});
  const counts = withoutPacer(live.counts);
  assert.equal(counts.submitted, 200);
  assert.equal(counts.decoded, 200);
  assert.equal(counts.presented, 200);
  assert.equal(counts.skipped, 0);
  assert.equal(fetchGate.signals, 201);
  assert.equal(fetchGate.merged, 0);
  assert.equal(d.decoder.coalesced, 0);
  assert.equal(d.decoder.maxReady, 1);
  submittedAfterAcquired(d.log);
  assert.deepEqual(
    d.log.filter(entry => entry.startsWith('acquire')),
    Array.from({length: 200}, (_, index) => `acquire ${index + 1}`)
  );
  ownUnits(d, 200);
  assert.equal(d.decoder.published.at(-1).unit, 200);
  await live.stop();
  await d.worker.finalize();
  assert.equal(live.retained, false);
});

test('a slow lag 0 fetch of N-1 makes gate N reread rather than signal again', async () => {
  const d = device();
  const live = await d.live(undefined, {lag: 0});
  const fetchGate = watchFetchGate(d);
  // What each gate write found: no fetch signal left for the worker, and the fetch it checked.
  const atGate = [];
  const onGate = () => atGate.push({set: fetchGate.state.set, fetched: d.decoder.fetched.length});
  d.decoder.slowFetch = {unit: 4, steps: 6};
  for (let sequence = 1; sequence <= 9; sequence++)
    await live.push(unitAt(sequence), {sink: d.sink, onGate});
  assert.deepEqual(
    atGate,
    Array.from({length: 8}, (_, index) => ({set: false, fetched: index}))
  );
  assert.equal(d.decoder.slowFetch.steps, -1);
  assert.deepEqual(await live.finish({sink: d.sink}), {drained: 0});
  const counts = withoutPacer(live.counts);
  assert.ok(counts.waiting.fetch >= 1, 'gate 5 reread the pending fetch');
  assert.equal(live.counts.fetchWaits.small.count, 1);
  assert.equal(counts.decoded, 9);
  assert.equal(counts.presented, 9);
  assert.equal(fetchGate.merged, 0);
  ownUnits(d, 9);
  await live.stop();
  await d.worker.finalize();
});

test('two outputs under one event stop the run on the extra one', async () => {
  // At lag 1 the gate that checks the extra acquire also holds its fetch; at lag 0 the gate
  // before it already opened that fetch, so the extra is published once before the stop.
  const fetchedUnits = {1: [1, 2, 3, 4], 0: [1, 2, 3, 4, 4]};
  for (const lag of [1, 0]) {
    const d = device();
    d.decoder.double = 4;
    const live = await d.live(undefined, {lag});
    const failure = await stream(live, d.sink, 9).then(
      () => null,
      error => error
    );
    assert.match(failure?.message ?? '', /Decoder output PTS 4000 is not the expected 5000/);
    assert.equal(d.decoder.maxReady, 2, `lag ${lag}`);
    assert.deepEqual(
      d.log.filter(entry => entry.startsWith('acquire')),
      ['acquire 1', 'acquire 2', 'acquire 3', 'acquire 4', 'acquire 4'],
      `lag ${lag}`
    );
    assert.deepEqual(
      d.decoder.fetched.map(fetch => fetch.unit),
      fetchedUnits[lag],
      `lag ${lag}`
    );
    await live.stop();
    assert.equal(live.retained, false, `lag ${lag}`);
    assert.deepEqual(d.worker.diagnostics.joined, [true, true], `lag ${lag}`);
    assert.ok(
      d.decoder.ready.every(output => output.pts === 5000),
      'only output 5 is left'
    );
    await d.worker.finalize();
  }
});

test('an output event wake with nothing ready stops the run on the empty result', async () => {
  for (const lag of [1, 0]) {
    const d = device();
    const live = await d.live(undefined, {lag});
    // Output 3 is held back from the event, so the stray wake finds the list empty.
    await stream(live, d.sink, 3);
    while ((await d.worker.readStatus()).acquire.sequence < 2);
    d.decoder.holding = true;
    await live.push(unitAt(4), {sink: d.sink});
    for (let poll = 0; poll < 5; poll++) await d.worker.readStatus();
    d.fake.signal(d.decoder.event);
    const failure = await live.push(unitAt(5), {sink: d.sink}).then(
      () => null,
      error => error
    );
    assert.deepEqual(
      d.decoder.held.map(output => output.pts),
      [3000]
    );
    assert.match(failure?.message ?? '', /output event woke with no output ready \(0x2a0\)/);
    // Nothing is fetched for the empty acquire, but at lag 0 its gate already opened the fetch
    // frame, which publishes the surface GetOutputBuffer failed to fill.
    assert.deepEqual(
      d.decoder.fetched.map(fetch => fetch.unit),
      [1, 2]
    );
    assert.deepEqual(
      d.decoder.published.map(publication => publication.unit),
      lag ? [1, 2] : [1, 2, 3]
    );
    await live.stop();
    assert.equal(live.retained, false, `lag ${lag}`);
    await d.worker.finalize();
  }
});

test('a lag 0 stop in each phase ends both workers at their exit', async () => {
  // Units pushed, then what the stop finds: submits, the last fetch, the fetch gate latched.
  const phases = {
    'before the first gate': {units: 1, submitted: 0, fetched: 0, latched: false},
    'before the gate': {units: 5, submitted: 4, fetched: 4, latched: false},
    'after the signal': {units: 6, submitted: 5, fetched: 4, latched: true},
    'during the fetch': {units: 6, submitted: 5, fetched: 5, latched: false}
  };
  for (const [phase, want] of Object.entries(phases)) {
    const d = device();
    const live = await d.live(undefined, {lag: 0});
    const fetchGate = watchFetchGate(d);
    for (let sequence = 1; sequence <= want.units; sequence++) {
      if (sequence === 6) {
        for (let poll = 0; poll < 5; poll++) await d.worker.readStatus();
        if (phase === 'after the signal') d.decoder.holding = true;
        else d.decoder.slowFetch = {unit: 5, steps: 40};
      }
      await live.push(unitAt(sequence), {sink: d.sink});
    }
    for (let poll = 0; poll < 5; poll++) await d.worker.readStatus();
    const parked = await d.worker.readStatus();
    assert.equal(parked.input.sequence, want.submitted, phase);
    assert.equal(fetchGate.state.set, want.latched, phase);
    if (phase === 'during the fetch') {
      assert.equal(parked.acquire.sequence, 5, phase);
      assert.equal(parked.fetch.sequence, 4, phase);
      assert.ok(d.decoder.slowFetch.steps > 0, phase);
    } else assert.equal(parked.fetch.sequence, want.fetched, phase);
    assert.equal(fetchGate.merged, 0, phase);
    const submitted = d.log.filter(entry => entry.startsWith('submit'));
    await live.stop();
    assert.equal(live.retained, false, phase);
    assert.deepEqual(d.worker.diagnostics.joined, [true, true], phase);
    assert.deepEqual(
      d.log.filter(entry => entry.startsWith('submit')),
      submitted,
      phase
    );
    assert.equal((await d.worker.readStatus()).fetch.sequence, want.fetched, phase);
    await d.worker.finalize();
  }
});

// staggered-input-plan.js
const addresses = {
  sdk: 0x7100000000,
  base: 0x7200000000,
  control: 0x7300000000,
  mapped: 0x7400000000,
  scratch: 0x7500000000,
  fd: 4,
  recvFunction: 0x7600000000,
  functions: {sendInput: 0x7700000000, acquireInput: 0x7700001000},
  decoder: 0x7800000000,
  acquireAck: 0x7300000030
};

function checkedSnapshot() {
  const bytes = Buffer.alloc(status.READ_END - status.READ_START);
  const at = offset => offset - status.READ_START;
  bytes.writeUInt32LE(2, at(ring.CONTROL.current));
  bytes.writeUInt32LE(11, at(ring.CONTROL.nativeApplied));
  bytes.writeBigInt64LE(40000n, at(status.STATUS.receive));
  bytes.writeUInt32LE(5, at(status.STATUS.receive + 8));
  bytes.writeBigUInt64LE(0n, at(status.STATUS.input));
  bytes.writeBigUInt64LE(0n, at(status.STATUS.input + 8));
  bytes.writeInt32LE(1, at(status.STATUS.input + 16));
  bytes.writeUInt32LE(4, at(status.STATUS.input + 20));
  bytes.writeBigUInt64LE(0n, at(status.STATUS.acquire));
  bytes.writeInt32LE(0, at(status.STATUS.acquire + 8));
  bytes.writeBigUInt64LE(3n, at(status.STATUS.acquire + 16));
  bytes.writeUInt32LE(3, at(status.STATUS.acquire + 24));
  bytes.writeBigUInt64LE(0n, at(status.STATUS.fetch));
  bytes.writeBigUInt64LE(0n, at(status.STATUS.fetch + 8));
  bytes.writeBigUInt64LE(0n, at(status.STATUS.fetch + 16));
  bytes.writeUInt32LE(2, at(status.STATUS.fetch + 24));
  return status.parse(bytes);
}

const gate = {
  expected: {
    receive: {sequence: 5, bytes: 40000},
    input: {sequence: 4},
    acquire: {sequence: 3, pts: 3n},
    fetch: {sequence: 2},
    ack: {sequence: 11, index: 2}
  },
  input: {index: 1, address: 0x7900000000, capacity: 0x100000},
  current: {sequence: 5, length: 40000, pts: 5n},
  next: {sequence: 6, length: 41000, pts: 6n},
  fetchGate: 0x7300000040,
  ignoredFetchGate: 0x7300000010
};

test('staggered input frames alternate receive and send while stamping checked status', () => {
  const built = input.plan(addresses);
  for (let slot = 0; slot < 2; slot++) {
    assert.ok(built.receive[slot].frame.length < 0x70000);
    assert.ok(built.send[slot].frame.length < 0x70000);
    assert.equal(built.calls.receive[slot][0].args[1], addresses.scratch);
    assert.equal(built.calls.receive[slot][0].args[3], 0x40);
    assert.equal(
      built.calls.receive[slot].at(-1).args[0].u64,
      addresses.control + input.CONTROL.sendDispatch[slot]
    );
    assert.equal(
      built.calls.send[slot].at(-1).args[0].u64,
      addresses.control + input.CONTROL.receiveDispatch[slot]
    );
    assert.equal(built.calls.send[slot][1].function, addresses.functions.sendInput);
    assert.equal(built.calls.send[slot][2].function, addresses.functions.acquireInput);
  }
  assert.equal(built.calls.receive[0][3].args[0].u64, addresses.control + 0x120);
  assert.equal(built.calls.receive[1][3].args[0].u64, addresses.control + 0x1a0);
});

test('the input worker releases N-2, waits for the N-1 acquisition, then submits N', () => {
  const built = input.plan(addresses);
  const sync = name => addresses.sdk + SYNC[name].offset;
  for (let slot = 0; slot < 2; slot++) {
    const descriptor = addresses.control + input.CONTROL.descriptors[slot];
    const [, , gate, fetch, ack, dispatch] = built.calls.receive[slot];
    assert.equal(built.calls.receive[slot].length, 6);
    assert.deepEqual(gate, {
      function: sync('waitLightEvent'),
      args: [addresses.control + input.CONTROL.decodeGate, 0, 0, 0]
    });
    assert.deepEqual(fetch, {
      function: sync('signalLightEvent'),
      args: [{u64: descriptor + input.DESCRIPTOR.fetchGate}, 0, 0, 0]
    });
    assert.deepEqual(ack, {
      function: sync('waitLightEvent'),
      args: [addresses.acquireAck, 0, 0, 0]
    });
    assert.equal(dispatch.function, addresses.sdk + CODE.longjmp.offset);
    assert.deepEqual(dispatch.args[0], {u64: addresses.control + input.CONTROL.sendDispatch[slot]});
    const send = built.calls.send[slot].map(call => call.function);
    assert.equal(send.indexOf(addresses.functions.sendInput), 1);
    assert.ok(!send.includes(sync('signalLightEvent')));
    assert.ok(!send.includes(sync('waitLightEvent')));
  }
  assert.throws(() => input.plan({...addresses, acquireAck: 0}), /addresses/);
});

test('one gate write carries checked current input and next receive descriptor', () => {
  const bytes = input.gateWrite({snapshot: checkedSnapshot(), ...gate});
  assert.equal(bytes.length, 0x100);
  assert.equal(bytes.readUInt32LE(0), 5);
  assert.equal(bytes.readUInt32LE(4), 40000);
  assert.equal(bytes.readBigUInt64LE(16), BigInt(gate.input.address));
  assert.equal(bytes.readUInt32LE(24), 1);
  assert.equal(bytes.readBigUInt64LE(32), BigInt(gate.fetchGate));
  assert.equal(bytes.readUInt32LE(0x80), 6);
  assert.equal(bytes.readUInt32LE(0x80 + 4), 41000);
  assert.equal(bytes.readBigUInt64LE(0x80 + 16), 0n);
});

test('a failed receive or unchecked input slot cannot produce a decode gate write', () => {
  const short = checkedSnapshot();
  short.receive.count = 39999n;
  assert.throws(() => input.gateWrite({snapshot: short, ...gate}), /Short receive/);
  assert.throws(
    () => input.gateWrite({snapshot: checkedSnapshot(), ...gate, input: {...gate.input, index: 2}}),
    /checked decoder buffer/
  );
  assert.throws(
    () => input.gateWrite({snapshot: checkedSnapshot(), ...gate, input: {...gate.input, capacity: 30000}}),
    /checked decoder buffer/
  );
});

test('with a length gate each receive waits on it first and stamps the recv count', () => {
  const lengthGate = addresses.control + input.CONTROL.lengthGate;
  const plain = input.plan(addresses);
  const gated = input.plan({...addresses, lengthGate});
  const sync = name => addresses.sdk + SYNC[name].offset;
  for (let slot = 0; slot < 2; slot++) {
    assert.deepEqual(gated.calls.receive[slot][0], {
      function: sync('waitLightEvent'),
      args: [lengthGate, 0, 0, 0]
    });
    assert.deepEqual(gated.calls.receive[slot].slice(1), plain.calls.receive[slot]);
    assert.deepEqual(gated.calls.send[slot], plain.calls.send[slot]);
    assert.equal(plain.calls.receive[slot][0].function, addresses.recvFunction);
  }
  assert.throws(() => input.plan({...addresses, lengthGate: -1}), /addresses/);
});

test('a gate write with no next leaves a zero placeholder on the ignored fetch gate', () => {
  const bytes = input.gateWrite({snapshot: checkedSnapshot(), ...gate, next: null});
  assert.equal(bytes.readUInt32LE(0), 5);
  assert.equal(bytes.readUInt32LE(4), 40000);
  assert.equal(bytes.readUInt32LE(0x80), 0);
  assert.equal(bytes.readUInt32LE(0x80 + 4), 0);
  assert.equal(bytes.readBigUInt64LE(0x80 + 32), BigInt(gate.ignoredFetchGate));
});

test('a primed descriptor fills its own slot and refuses an unbounded unit', () => {
  const ignored = addresses.control + input.CONTROL.ignoredFetchGate;
  const primed = input.primeWrite({sequence: 6, length: 41000, pts: 6000n}, ignored);
  assert.equal(primed.offset, input.CONTROL.descriptors[1]);
  assert.equal(primed.bytes.length, input.DESCRIPTOR.bytes);
  assert.equal(primed.bytes.readUInt32LE(input.DESCRIPTOR.sequence), 6);
  assert.equal(primed.bytes.readUInt32LE(input.DESCRIPTOR.length), 41000);
  assert.equal(primed.bytes.readBigUInt64LE(input.DESCRIPTOR.pts), 6000n);
  assert.equal(primed.bytes.readBigUInt64LE(input.DESCRIPTOR.inputAddress), 0n);
  assert.equal(primed.bytes.readBigUInt64LE(input.DESCRIPTOR.fetchGate), BigInt(ignored));
  assert.equal(input.primeWrite({sequence: 7, length: 1, pts: 1n}, ignored).offset, 0x100);
  for (const unit of [
    {sequence: 1, length: 10, pts: 1n},
    {sequence: 6, length: 0, pts: 1n},
    {sequence: 6, length: 0x100001, pts: 1n},
    {sequence: 6, length: 10, pts: 1}
  ])
    assert.throws(() => input.primeWrite(unit, ignored), /Invalid staggered primed/);
});

// staggered-output-plan.js
const outAddresses = {
  sdk: 0x7100000000,
  base: 0x7200000000,
  control: 0x7300000000,
  mapped: 0x7400000000,
  event: 0x7500000000,
  functions: {
    acquireOutput: 0x7600000000,
    bufferSetData: 0x7600001000,
    getOutput: 0x7600002000,
    releaseOutput: 0x7600003000
  },
  decoder: 0x7700000000,
  output: 0x7700001000,
  format: 0x7700002000,
  acquireAck: 0x7300000030
};

test('staggered output frames acquire before a host fetch gate and publish once', () => {
  const built = output.plan(outAddresses);
  for (let slot = 0; slot < 2; slot++) {
    assert.ok(built.acquire[slot].frame.length < 0x70000);
    assert.ok(built.fetch[slot].frame.length < 0x70000);
    assert.equal(built.calls.acquire[slot][0].function, outAddresses.sdk + SYNC.waitEvent.offset);
    assert.equal(built.calls.acquire[slot][1].function, outAddresses.functions.acquireOutput);
    assert.equal(
      built.calls.acquire[slot][5].args[0].u64,
      outAddresses.control + output.CONTROL.fetchDispatch[slot]
    );
    assert.equal(built.calls.fetch[slot][1].function, outAddresses.functions.getOutput);
    assert.equal(built.calls.fetch[slot][2].function, outAddresses.functions.releaseOutput);
    assert.equal(
      built.calls.fetch[slot].at(-1).args[0].u64,
      outAddresses.control + output.CONTROL.acquireDispatch[slot]
    );
  }
  assert.equal(
    built.calls.acquire[0][1].args[1],
    outAddresses.mapped + status.STATUS.acquire + 8
  );
  assert.equal(
    built.calls.fetch[0][4].args[0],
    outAddresses.mapped + ring.CONTROL.nativeSequence
  );
});

test('the output worker acknowledges an acquisition only after stamping it', () => {
  const built = output.plan(outAddresses);
  for (let slot = 0; slot < 2; slot++) {
    const descriptor = outAddresses.control + output.CONTROL.descriptors[slot];
    const [wait, acquire, stamp, ack, fetch] = built.calls.acquire[slot];
    assert.equal(wait.function, outAddresses.sdk + SYNC.waitEvent.offset);
    assert.equal(acquire.function, outAddresses.functions.acquireOutput);
    assert.deepEqual(stamp.args.slice(0, 3), [
      outAddresses.mapped + status.STATUS.acquire + 24,
      descriptor + output.DESCRIPTOR.sequence,
      4
    ]);
    assert.deepEqual(ack, {
      function: outAddresses.sdk + SYNC.signalLightEvent.offset,
      args: [outAddresses.acquireAck, 0, 0, 0]
    });
    assert.deepEqual(fetch, {
      function: outAddresses.sdk + SYNC.waitLightEvent.offset,
      args: [outAddresses.control + output.CONTROL.fetchGate, 0, 0, 0]
    });
  }
  assert.throws(() => output.plan({...outAddresses, acquireAck: 0}), /addresses/);
});

test('staggered output descriptor checks ring surface and commits matching metadata', () => {
  const publication = {mapped: outAddresses.mapped, color: 1};
  const destination = {
    index: 2,
    address: outAddresses.mapped + ring.frameOffset(2),
    bytes: ring.FRAME_BYTES,
    sequence: 12,
    color: 1
  };
  const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
  const bytes = output.outputDescriptor({auSequence: 7, destination, frame, publication});
  assert.equal(bytes.length, 0x80);
  assert.equal(bytes.readUInt32LE(0), 7);
  assert.equal(bytes.readBigUInt64LE(8), BigInt(destination.address));
  assert.equal(bytes.readUInt32LE(24), 2);
  assert.equal(bytes.readUInt32LE(24 + 28), 12);
  assert.throws(
    () =>
      output.outputDescriptor({
        auSequence: 7,
        destination: {...destination, index: 1},
        frame,
        publication
      }),
    /target/
  );
});

test('a skipped output is copied off screen behind the last publication', () => {
  const publication = {mapped: outAddresses.mapped, color: 1};
  const surface = index => ({
    index,
    address: outAddresses.mapped + ring.frameOffset(index),
    bytes: ring.FRAME_BYTES,
    color: 1
  });
  const published = {...surface(1), sequence: 12};
  const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
  const skip = output.outputDescriptor({
    auSequence: 8,
    destination: {...surface(2), skip: true},
    frame,
    publication,
    published
  });
  const shown = output.outputDescriptor({
    auSequence: 7,
    destination: published,
    frame,
    publication
  });
  assert.equal(skip.readBigUInt64LE(8), BigInt(surface(2).address));
  assert.deepEqual(skip.subarray(24, 56), shown.subarray(24, 56));
  assert.throws(
    () =>
      output.outputDescriptor({
        auSequence: 8,
        destination: surface(2),
        frame,
        publication,
        published: {...published, address: surface(0).address}
      }),
    /target/
  );
});

// staggered-worker.js
function fixture() {
  const sdk = 0x40000000;
  const moduleBase = 0x50000000;
  const mapped = 0x80000000;
  const regions = [{base: mapped, bytes: Buffer.alloc(ring.CONTROL_BYTES)}];
  const calls = [];
  let allocations = 0;
  const regionAt = address =>
    regions.find(region => address >= region.base && address < region.base + region.bytes.length);
  const read = (address, length) => {
    const region = regionAt(address);
    assert.ok(region, `unmapped read at ${address.toString(16)}`);
    return Buffer.from(region.bytes.subarray(address - region.base, address - region.base + length));
  };
  const write = (address, bytes) => {
    const region = regionAt(address);
    assert.ok(region, `unmapped write at ${address.toString(16)}`);
    bytes.copy(region.bytes, address - region.base);
  };
  const rpc = {
    a: {sdk},
    output: 0x20000000,
    async request() {
      return {verified: true};
    },
    async call(_offset, args) {
      const base = 0x60000000 + allocations++ * 0x1000000;
      regions.push({base, bytes: Buffer.alloc(args[2])});
      const output = Buffer.alloc(8);
      output.writeBigUInt64LE(BigInt(base));
      return {result: 0n, output};
    },
    async callAddress(address, args) {
      calls.push({address, args});
      if (address === sdk + CODE.create.offset) {
        const thread = Buffer.alloc(8);
        thread.writeBigUInt64LE(BigInt(0x1234 + calls.length));
        write(args[0], thread);
      }
      if (address === sdk + CODE.tryWait.offset) return {result: 1n};
      if (address === moduleBase + definitions.bufferData.offset)
        return {result: 0x7900000000n};
      if (address === moduleBase + definitions.bufferCapacity.offset)
        return {result: 0x100000n};
      if (address === moduleBase + definitions.acquireInput.offset) {
        const index = Buffer.alloc(4);
        index.writeInt32LE(1);
        write(args[1], index);
      }
      return {result: 0n};
    },
    read: async (address, length) => read(address, length),
    write: async (address, bytes) => write(address, bytes),
    async writeAndCall(address, bytes, target, args) {
      write(address, bytes);
      calls.push({address: target, args, combined: true});
      return {result: 0n};
    }
  };
  const transport = {
    fd: 12,
    maxAccessUnit: 0x100000,
    recvFunction: sdk + 0x1234,
    aborted: false,
    async send() {},
    abort() {
      this.aborted = true;
    }
  };
  const module = {
    base: moduleBase,
    symbols: [{
      name: registration.symbol,
      section: '.text',
      offset: registration.offset,
      size: registration.size
    }]
  };
  const functions = Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [name, moduleBase + definition.offset])
  );
  const publication = {mapped, color: 1};
  return {rpc, transport, module, functions, publication, read, write, calls, sdk};
}

async function started(fixture) {
  const worker = await create({
    rpc: fixture.rpc,
    module: fixture.module,
    functions: fixture.functions,
    decoder: 0x70000000,
    output: 0x70000300,
    format: 0x70000180,
    transport: fixture.transport,
    publication: fixture.publication
  });
  await worker.register();
  await worker.start({sequence: 1, length: 40000, pts: 1n});
  return worker;
}

test('staggered workers install two alternating frames and can stop both waits', async () => {
  const f = fixture();
  const worker = await started(f);
  assert.equal(worker.diagnostics.started, true);
  assert.equal(worker.diagnostics.decodeGateSignals, 0);
  await worker.stopInput();
  assert.equal(f.transport.aborted, true);
  await worker.stopOutput();
  assert.deepEqual(worker.diagnostics.joined, [true, true]);
  await worker.stop();
  await worker.finalize();
  assert.equal(worker.diagnostics.retained, false);
  const control = 0x62000000;
  const inputExit = 0x60000000 + 0x3f0000;
  const outputExit = 0x61000000 + 0x3f0000;
  for (const offset of [
    ...inputPlan.CONTROL.sendDispatch,
    ...inputPlan.CONTROL.receiveDispatch
  ])
    assert.equal(f.read(control + offset, 8).readBigUInt64LE(), BigInt(inputExit));
  for (const offset of [
    ...outputPlan.CONTROL.fetchDispatch,
    ...outputPlan.CONTROL.acquireDispatch
  ])
    assert.equal(f.read(control + offset, 8).readBigUInt64LE(), BigInt(outputExit));
});

test('short receive keeps staggered decode and fetch gates closed', async () => {
  const f = fixture();
  const worker = await started(f);
  const receive = Buffer.alloc(12);
  receive.writeBigInt64LE(39999n);
  receive.writeUInt32LE(1, 8);
  f.write(f.publication.mapped + status.STATUS.receive, receive);
  const before = f.calls.filter(call => call.combined).length;
  await assert.rejects(
    () => worker.openGates({
      snapshot: status.parse(f.read(
        f.publication.mapped + status.READ_START,
        status.READ_END - status.READ_START
      )),
      expected: {receive: {sequence: 1, bytes: 40000}},
      inputSlot: {index: 0, address: 0x7900000000, capacity: 0x100000},
      current: {sequence: 1, length: 40000, pts: 1n},
      next: {sequence: 2, length: 40000, pts: 2n}
    }),
    /Short receive/
  );
  assert.equal(f.calls.filter(call => call.combined).length, before);
  assert.equal(worker.diagnostics.decodeGateSignals, 0);
  await worker.stop();
  await worker.finalize();
});

test('a checked bootstrap receive opens exactly one combined native gate write', async () => {
  const f = fixture();
  const worker = await started(f);
  const receive = Buffer.alloc(12);
  receive.writeBigInt64LE(40000n);
  receive.writeUInt32LE(1, 8);
  f.write(f.publication.mapped + status.STATUS.receive, receive);
  await worker.openGates({
    snapshot: await worker.readStatus(),
    expected: {receive: {sequence: 1, bytes: 40000}},
    inputSlot: {index: 0, address: 0x7900000000, capacity: 0x100000},
    current: {sequence: 1, length: 40000, pts: 1n},
    next: {sequence: 2, length: 40000, pts: 2n}
  });
  const combined = f.calls.filter(call => call.combined);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].args[0], 0x62000000 + inputPlan.CONTROL.decodeGate);
  assert.equal(worker.diagnostics.decodeGateSignals, 1);
  await worker.stop();
  await worker.finalize();
});

test('stopping a held output releases the checked decoder slot once', async () => {
  const f = fixture();
  const worker = await started(f);
  const acquired = Buffer.alloc(28);
  acquired.writeInt32LE(2, 8);
  acquired.writeBigUInt64LE(3n, 16);
  acquired.writeUInt32LE(3, 24);
  f.write(f.publication.mapped + status.STATUS.acquire, acquired);
  await worker.stop();
  await worker.stop();
  const releases = f.calls.filter(call => call.address === f.functions.releaseOutput);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].args[1], 2);
  await worker.finalize();
});

test('input buffers are cached and a missing slot can be reacquired exceptionally', async () => {
  const f = fixture();
  const worker = await started(f);
  assert.deepEqual(await worker.inputSlot(1), {
    index: 1,
    address: 0x7900000000,
    capacity: 0x100000
  });
  await worker.inputSlot(1);
  assert.equal(f.calls.filter(call => call.address === f.functions.getInput).length, 1);
  const pending = Buffer.alloc(16);
  pending.writeBigUInt64LE(0x100en);
  pending.writeInt32LE(-1, 8);
  pending.writeUInt32LE(1, 12);
  f.write(f.publication.mapped + status.STATUS.input + 8, pending);
  assert.deepEqual(await worker.retryInputSlot(1), {status: 0, index: 1});
  assert.equal(
    f.read(f.publication.mapped + status.STATUS.input + 8, 8).readBigUInt64LE(),
    0n
  );
  await worker.stop();
  await worker.finalize();
  assert.equal(f.calls.filter(call => call.address === f.functions.bufferDestroy).length, 1);
});

test('tail output drain opens only a checked fetch gate', async () => {
  const f = fixture();
  const worker = await started(f);
  const acquired = Buffer.alloc(28);
  acquired.writeInt32LE(2, 8);
  acquired.writeBigUInt64LE(1n, 16);
  acquired.writeUInt32LE(1, 24);
  f.write(f.publication.mapped + status.STATUS.acquire, acquired);
  const destination = {
    index: 0,
    address: f.publication.mapped + ring.frameOffset(0),
    bytes: ring.FRAME_BYTES,
    sequence: 2,
    color: 1
  };
  const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
  const wrong = await worker.readStatus();
  wrong.acquire.pts = 2n;
  await assert.rejects(
    () => worker.drainOutput({
      snapshot: wrong,
      expected: {acquire: {sequence: 1, pts: 1n}},
      destination,
      frame
    }),
    /Decoder output PTS 2 is not the expected 1/
  );
  assert.equal(f.calls.filter(call => call.combined).length, 0);
  await worker.drainOutput({
    snapshot: await worker.readStatus(),
    expected: {acquire: {sequence: 1, pts: 1n}},
    destination,
    frame
  });
  assert.equal(f.calls.filter(call => call.combined).length, 1);
  const control = 0x62000000;
  assert.equal(f.read(control + outputPlan.CONTROL.descriptors[0], 4).readUInt32LE(), 1);
  assert.equal(f.read(control + outputPlan.CONTROL.descriptors[1], 4).readUInt32LE(), 2);
  assert.equal(f.read(control + outputPlan.CONTROL.descriptors[1] + 8, 8).readBigUInt64LE(), 0n);
  assert.equal(worker.diagnostics.decodeGateSignals, 0);
  await worker.stop();
  await worker.finalize();
});

test('the acquisition acknowledgement starts signalled and stop wakes it behind the exit', async () => {
  const f = fixture();
  const writes = [];
  const write = f.rpc.write;
  f.rpc.write = async (address, bytes) => {
    writes.push({address, at: f.calls.length});
    return write(address, bytes);
  };
  const control = 0x62000000;
  const ack = control + ACQUIRE_ACK;
  const worker = await started(f);
  const sdk = f.sdk;
  const init = f.calls.find(
    call => call.address === sdk + SYNC.initializeLightEvent.offset && call.args[0] === ack
  );
  assert.deepEqual(init.args, [ack, 1, 1, 0]);
  for (const slot of inputPlan.CONTROL.descriptors)
    assert.equal(
      f.read(control + slot + inputPlan.DESCRIPTOR.fetchGate, 8).readBigUInt64LE(),
      BigInt(control + inputPlan.CONTROL.ignoredFetchGate)
    );
  const before = f.calls.length;
  await worker.stopInput();
  const signals = f.calls
    .map((call, index) => ({...call, index}))
    .filter(call => call.index >= before && call.address === sdk + SYNC.signalLightEvent.offset);
  assert.deepEqual(
    signals.map(call => call.args[0]),
    [control + inputPlan.CONTROL.decodeGate, ack]
  );
  const exits = writes.filter(
    item =>
      item.at >= before &&
      [...inputPlan.CONTROL.sendDispatch, ...inputPlan.CONTROL.receiveDispatch].includes(
        item.address - control
      )
  );
  assert.equal(exits.length, 4);
  assert.ok(exits.every(item => item.at <= signals[0].index));
  await worker.stopOutput();
  await worker.stop();
  await worker.finalize();
  const finalized = f.calls.filter(call => call.address === sdk + SYNC.finalizeLightEvent.offset);
  assert.equal(finalized[0].args[0], ack);
});

test('a held fetch opens decode N with the ignored fetch gate in its descriptor', async () => {
  const control = 0x62000000;
  const fetchPointer = async holdFetch => {
    const f = fixture();
    const worker = await started(f);
    const ringWord = (offset, size, value) => {
      const bytes = Buffer.alloc(size);
      if (size === 8) bytes.writeBigInt64LE(BigInt(value));
      else bytes.writeInt32LE(value);
      f.write(f.publication.mapped + offset, bytes);
    };
    ringWord(status.STATUS.receive, 8, 40000);
    ringWord(status.STATUS.receive + 8, 4, 3);
    ringWord(status.STATUS.input + 16, 4, 1);
    ringWord(status.STATUS.input + 20, 4, 2);
    ringWord(status.STATUS.acquire + 8, 4, 0);
    ringWord(status.STATUS.acquire + 16, 8, 1);
    ringWord(status.STATUS.acquire + 24, 4, 1);
    await worker.openGates({
      holdFetch,
      snapshot: await worker.readStatus(),
      expected: {
        receive: {sequence: 3, bytes: 40000},
        input: {sequence: 2},
        acquire: {sequence: 1, pts: 1n}
      },
      inputSlot: {index: 1, address: 0x7900000000, capacity: 0x100000},
      current: {sequence: 3, length: 40000, pts: 3n},
      next: {sequence: 4, length: 40000, pts: 4n},
      destination: {
        index: 1,
        address: f.publication.mapped + ring.frameOffset(1),
        bytes: ring.FRAME_BYTES,
        sequence: 2,
        color: 1
      },
      frame: {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088}
    });
    assert.equal(worker.diagnostics.decodeGateSignals, 1);
    const pointer = f
      .read(control + inputPlan.CONTROL.descriptors[0] + inputPlan.DESCRIPTOR.fetchGate, 8)
      .readBigUInt64LE();
    await worker.stop();
    await worker.finalize();
    return pointer;
  };
  assert.equal(await fetchPointer(false), BigInt(control + outputPlan.CONTROL.fetchGate));
  assert.equal(await fetchPointer(true), BigInt(control + inputPlan.CONTROL.ignoredFetchGate));
});
