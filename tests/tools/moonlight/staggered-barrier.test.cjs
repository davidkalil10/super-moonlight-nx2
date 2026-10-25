// The staggered workers' real frames on the gadget-level fake console, against a fake decoder
// whose output event is auto-clear like the device's: one bit, however many outputs are ready.
// The host side is the real staggered-live scheduler and the ladder's held-fetch checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const {ADDRESS} = require('../../../hbl-platform-dev/sdk/tests/recording-rpc.cjs');
const {gateConsole, BLOCK} = require('../../../hbl-platform-dev/sdk/tests/gate-worker-mock.cjs');
const definitions = require('../../../hbl-moonlight/sdk/native/movie-functions.json');
const registration =
  require('../../../hbl-moonlight/sdk/native/movie-event-functions.json').registerClientEvents;
const {proveHeld, proveRelease} = require('../../sdk/tools/probe-staggered-ladder.cjs');
const ring = require('../../../hbl-moonlight/tools/moonlight/ring.cjs');
const inputPlan = require('../../../hbl-moonlight/tools/moonlight/staggered-input-plan.cjs');
const outputPlan = require('../../../hbl-moonlight/tools/moonlight/staggered-output-plan.cjs');
const {
  create: createWorker
} = require('../../../hbl-moonlight/tools/moonlight/staggered-worker.cjs');
const {create: createLive} = require('../../../hbl-moonlight/tools/moonlight/staggered-live.cjs');

const layout = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
const noWait = async () => {};
const RECV = ADDRESS.module + 0x800;
const NO_OUTPUT = 0x2a0n;

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
    async live(wrap = value => value) {
      const live = createLive({
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
  assert.deepEqual(live.counts, {
    submitted: 9,
    decoded: 9,
    presented: 9,
    skipped: 0,
    tailDrained: 2,
    rereads: 6,
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
  assert.deepEqual(live.counts, {
    submitted: 7,
    decoded: 7,
    presented: 7,
    skipped: 0,
    tailDrained: 2,
    rereads: 3,
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
