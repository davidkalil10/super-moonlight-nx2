// The staggered workers' real frames on the gadget-level fake console, against a fake decoder
// whose output event is auto-clear like the device's: one bit, however many outputs are ready.
// The host side is the real staggered-live scheduler and the held-fetch checks below.
const test = require('node:test');
const assert = require('node:assert/strict');

/** The staggered counts without the pacer's read counters, which the fake device does not pin. */
const withoutPacer = ({pacer, exchanges, ...counts}) => (
  assert.equal(typeof pacer.reads, 'number'),
  assert.equal(typeof exchanges.gate.ms, 'number'),
  counts
);
const {ADDRESS} = require('../../../hbl-platform-dev/sdk/tests/recording-rpc.cjs');
const {gateConsole, BLOCK} = require('../../../hbl-platform-dev/sdk/tests/gate-worker-mock.cjs');
const definitions = require('../../../hbl-moonlight/sdk/native/movie-functions.json');
const registration =
  require('../../../hbl-moonlight/sdk/native/movie-event-functions.json').registerClientEvents;
const ring = require('../../../hbl-moonlight/tools/moonlight/ring.js');
const inputPlan = require('../../../hbl-moonlight/tools/moonlight/staggered-input-plan.js');
const outputPlan = require('../../../hbl-moonlight/tools/moonlight/staggered-output-plan.js');
const {
  create: createWorker
} = require('../../../hbl-moonlight/tools/moonlight/staggered-worker.js');
const {create: createLive} = require('../../../hbl-moonlight/tools/moonlight/staggered-live.js');

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
      const event = fake.events.get(decoder.event);
      if (event.set) decoder.coalesced++;
      decoder.ready.push({index: nextOutput++ % 4, pts});
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
      if (!output) return NO_OUTPUT;
      log.push(`acquire ${sequenceOf(output.pts)}`);
      memory.write32(index, output.index);
      memory.write64(pts, output.pts);
      return 0;
    },
    'movie.bufferSetData': () => 0,
    'movie.getOutput': () => 0,
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
