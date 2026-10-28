// The staggered scheduler, and the gate and status checks it runs every frame.
const test = require('node:test');
const assert = require('node:assert/strict');
const definitions = require('../../../sdk/native/movie-functions.json');
const registration = require('../../../sdk/native/movie-event-functions.json').registerClientEvents;
const {CODE} = require('../../../../hbl-platform/sdk/native/thread.js');
const ring = require('../../../tools/moonlight/ring.js');
const status = require('../../../host/stream/staggered-status.js');
const gates = require('../../../host/stream/staggered-gate.js');
const outputPlan = require('../../../host/stream/staggered-output-plan.js');
const inputPlan = require('../../../host/stream/staggered-input-plan.js');
const {MODEL, simulate} = require('./request-budget.cjs');
const {create: createWorker} = require('../../../host/stream/staggered-worker.js');
const {
  create,
  RESTART,
  TRIM_FRAMES,
  expectedFor,
  waitChecked,
  waitOutput,
  createAcquireWaits
} = require('../../../host/stream/staggered-live.js');
const gate = require('../../../host/stream/staggered-gate.js');
const input = require('../../../host/stream/staggered-input-plan.js');
const output = require('../../../host/stream/staggered-output-plan.js');
const {
  STATUS,
  READ_START,
  READ_END,
  parse,
  check,
  checkOutput
} = require('../../../host/stream/staggered-status.js');
const {create: createGateQueue} = require('../../../host/stream/gate-queue.js');
const withoutPacer = require('./test-helpers.cjs').withoutPacer('status');

// staggered-live.js
test('acquire waits book both bounds, the pending reads and the immediate acquires', () => {
  const waits = createAcquireWaits();
  // One wait: reads of [start, end] ms, `true` while the acquire is pending.
  const wait = (unit, bytes, reads) => {
    for (const [startedAt, endedAt, pending] of reads)
      waits.observe(unit, pending, startedAt, endedAt, bytes);
  };
  wait(1, 30000, [[0, 2, false]]);
  wait(2, 30000, [
    [0, 2, true],
    [7, 9, false],
    [14, 16, false]
  ]);
  wait(3, 30000, [
    [0, 2, true],
    [7, 9, true],
    [14, 16, false]
  ]);
  wait(4, 210000, [
    [0, 2, true],
    [7, 9, true],
    [14, 16, true],
    [21, 23, true],
    [28, 30, true],
    [35, 41, false]
  ]);
  assert.deepEqual(waits.counts, {
    small: {
      immediate: 1,
      count: 2,
      reads: [1, 1, 0, 0],
      bins: [0, 0, 0, 2, 0, 0],
      lowerBins: [1, 0, 1, 0, 0, 0],
      maxMs: 16
    },
    large: {
      immediate: 0,
      count: 1,
      reads: [0, 0, 0, 1],
      bins: [0, 0, 0, 0, 0, 1],
      lowerBins: [0, 0, 0, 0, 1, 0],
      maxMs: 41
    }
  });
  waits.counts.small.bins[3] = 9;
  assert.equal(waits.counts.small.bins[3], 2, 'counts is a copy');
});

const layout = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
const noPause = async () => {};
/** sha256 of every write, gate payload, request and send of defaultStreamDigest() on 14e29df. */
const DEFAULT_STREAM_DIGEST = 'a1a04bafef4771fcdd4cedcea9e2466fe0b49598972df79293e9c9540419af34';
const unitAt = sequence => ({data: Buffer.alloc(100 + sequence), pts: sequence * 1000});

// A console stand-in for the real staggered worker: TCP sends land in the receive status,
// the combined gate write decodes the gated unit and fetches the descriptor's output, and the
// output worker holds one decoded unit back until the input worker stops.
// With clock set, a fetched frame is applied on the next vsync of clock.vsyncMs and every
// bridge read takes clock.readMs, like the renderer and bridge on the console. A stalled
// renderer never applies a publication, and the discard calls in noFreeSurface find no
// free surface. With decodeMs set as well, a gated unit is acquirable decodeMs after both its
// gate and the previous unit's decode, and with receiveMs a sent unit lands in the receive
// status receiveMs after its send.
function simulatedDevice({
  late = new Set(),
  clock = null,
  stalled = false,
  noFreeSurface = new Set(),
  decodeMs = 0,
  receiveMs = 0
} = {}) {
  const sdk = 0x40000000;
  const moduleBase = 0x50000000;
  const mapped = 0x80000000;
  const regions = [{base: mapped, bytes: Buffer.alloc(ring.CONTROL_BYTES)}];
  const requests = [];
  const pts = new Map();
  let allocations = 0;
  let received = 0;
  let decoded = 0;
  let fetched = 0;
  let applied = 0;
  let acquired = 0;
  const decodeDone = [];
  const onScreenWrites = [];
  let staleReceive = null;
  let slowReceive = null;
  const presents = [];
  const regionAt = address =>
    regions.find(region => address >= region.base && address < region.base + region.bytes.length);
  const read = (address, length) => {
    const region = regionAt(address);
    assert.ok(region, `unmapped read at ${address.toString(16)}`);
    return Buffer.from(
      region.bytes.subarray(address - region.base, address - region.base + length)
    );
  };
  const write = (address, bytes) => {
    const region = regionAt(address);
    assert.ok(region, `unmapped write at ${address.toString(16)}`);
    bytes.copy(region.bytes, address - region.base);
  };
  const ringWord = (offset, size, value) => {
    const bytes = Buffer.alloc(size);
    if (size === 8) bytes.writeBigInt64LE(BigInt(value));
    else bytes.writeInt32LE(value);
    write(mapped + offset, bytes);
  };
  const setReceive = (count, sequence) => {
    ringWord(status.STATUS.receive, 8, count);
    ringWord(status.STATUS.receive + 8, 4, sequence);
  };
  const transport = {
    fd: 12,
    maxAccessUnit: 0x100000,
    recvFunction: sdk + 0x1234,
    aborted: false,
    sent: [],
    async send(data) {
      transport.sent.push(data.length);
      received++;
      if (late.has(received)) staleReceive = [data.length, received];
      else if (clock && receiveMs)
        slowReceive = {count: data.length, sequence: received, at: clock.now + receiveMs};
      else setReceive(data.length, received);
    },
    abort() {
      transport.aborted = true;
    }
  };
  function acquireNext() {
    let sequence = Math.min(fetched + 1, transport.aborted ? decoded : decoded - 1);
    if (clock && decodeMs)
      while (sequence > acquired && decodeDone[sequence] > clock.now) sequence--;
    if (sequence < 1 || sequence < acquired) return;
    acquired = sequence;
    ringWord(status.STATUS.acquire, 8, 0);
    ringWord(status.STATUS.acquire + 8, 4, sequence % 4);
    ringWord(status.STATUS.acquire + 16, 8, pts.get(sequence));
    ringWord(status.STATUS.acquire + 24, 4, sequence);
  }
  function fetch(descriptor) {
    const address = Number(descriptor.readBigUInt64LE(outputPlan.DESCRIPTOR.address));
    if (!address) return;
    fetched = descriptor.readUInt32LE(outputPlan.DESCRIPTOR.sequence);
    ringWord(status.STATUS.fetch + 24, 4, fetched);
    const shown = read(mapped + ring.CONTROL.current, 4).readUInt32LE();
    if (address === mapped + ring.frameOffset(shown)) onScreenWrites.push(fetched);
    const published = outputPlan.DESCRIPTOR.metadata;
    const sequence = descriptor.readUInt32LE(published + 28);
    if (sequence === applied) return;
    const index = descriptor.readUInt32LE(published);
    const present = (value => () => {
      ringWord(ring.CONTROL.current, 4, index);
      ringWord(ring.CONTROL.nativeApplied, 4, value);
    })((applied = sequence));
    if (!clock) return present();
    const vsync = Math.floor(clock.now / clock.vsyncMs + 1) * clock.vsyncMs;
    presents.push({at: Math.max(vsync, (presents.at(-1)?.at ?? 0) + clock.vsyncMs), present});
  }
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
      requests.push('call');
      if (address === sdk + CODE.create.offset) {
        const thread = Buffer.alloc(8);
        thread.writeBigUInt64LE(0x1234n + BigInt(requests.length));
        write(args[0], thread);
      }
      if (address === sdk + CODE.tryWait.offset) return {result: 1n};
      if (address === moduleBase + definitions.bufferData.offset) return {result: 0x7900000000n};
      if (address === moduleBase + definitions.bufferCapacity.offset) return {result: 0x100000n};
      return {result: 0n};
    },
    async read(address, length) {
      requests.push('read');
      if (clock) {
        clock.now += clock.readMs;
        if (slowReceive && slowReceive.at <= clock.now) {
          setReceive(slowReceive.count, slowReceive.sequence);
          slowReceive = null;
        }
        while (!stalled && presents.length && presents[0].at <= clock.now)
          presents.shift().present();
        if (decodeMs) acquireNext();
      }
      const bytes = read(address, length);
      if (staleReceive && address === mapped + status.READ_START) {
        setReceive(...staleReceive);
        staleReceive = null;
      }
      return bytes;
    },
    async write(address, bytes) {
      requests.push('write');
      write(address, bytes);
    },
    async writeAndCall(address, bytes) {
      if (bytes.length === inputPlan.DESCRIPTOR.bytes) {
        requests.push('prime');
        write(address, bytes);
        return {result: 0n};
      }
      requests.push(bytes.length === gates.WRITE_BYTES ? 'gate' : 'drain');
      write(address, bytes);
      if (bytes.length === gates.WRITE_BYTES) {
        decoded = received;
        if (clock && decodeMs)
          decodeDone[decoded] = Math.max(clock.now, decodeDone[decoded - 1] ?? 0) + decodeMs;
        ringWord(status.STATUS.input, 8, 0);
        ringWord(status.STATUS.input + 8, 8, 0);
        ringWord(status.STATUS.input + 16, 4, decoded % 3);
        ringWord(status.STATUS.input + 20, 4, decoded);
        const slot = outputPlan.CONTROL.descriptors[(Math.max(1, decoded - 2) - 1) % 2];
        fetch(bytes.subarray(slot - gates.WRITE_OFFSET, slot - gates.WRITE_OFFSET + 0x80));
      } else
        for (let offset = 0; offset < bytes.length; offset += outputPlan.DESCRIPTOR.size)
          fetch(bytes.subarray(offset, offset + outputPlan.DESCRIPTOR.size));
      acquireNext();
      return {result: 0n};
    }
  };
  const module = {
    base: moduleBase,
    symbols: [
      {
        name: registration.symbol,
        section: '.text',
        offset: registration.offset,
        size: registration.size
      }
    ]
  };
  const functions = Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [name, moduleBase + definition.offset])
  );
  const publication = {mapped, color: 1};
  let sequence = 0;
  const unapplied = [];
  let discards = 0;
  const sink = {
    async workerDestination(presentation) {
      assert.ok(Number.isInteger(presentation.current));
      if (sequence) unapplied.push(sequence !== applied || presentation.applied !== sequence);
      sequence++;
      const index = sequence % 3;
      return {
        index,
        address: mapped + ring.frameOffset(index),
        bytes: ring.FRAME_BYTES,
        sequence,
        color: 1
      };
    },
    async discardDestination(presentation) {
      if (noFreeSurface.delete(++discards)) return null;
      const index = [0, 1, 2].find(item => item !== presentation.current);
      return {
        index,
        address: mapped + ring.frameOffset(index),
        bytes: ring.FRAME_BYTES,
        color: 1,
        skip: true
      };
    }
  };
  return {
    rpc,
    transport,
    module,
    functions,
    publication,
    sink,
    requests,
    pts,
    onScreenWrites,
    unapplied,
    applied: () => applied
  };
}

async function liveOn(device, pause = noPause, clock = null, options = {}) {
  const live = create({
    createWorker,
    pause,
    ...options,
    ...(clock ? {now: () => clock.now, presentHz: 1000 / clock.vsyncMs} : {})
  });
  const worker = await live.factory({
    rpc: device.rpc,
    module: device.module,
    functions: device.functions,
    decoder: 0x70000000,
    output: 0x70000300,
    format: 0x70000180,
    transport: device.transport,
    publication: device.publication
  });
  await worker.register();
  live.start({input: {status: 0, index: 2}, frame: layout});
  return live;
}

async function stream(device, live, count, onFrame = () => {}) {
  for (let sequence = 1; sequence <= count; sequence++) {
    const unit = unitAt(sequence);
    device.pts.set(sequence, BigInt(unit.pts));
    const before = device.requests.length;
    await live.push(unit, {sink: device.sink});
    onFrame(sequence, device.requests.slice(before));
  }
}

async function modelRequestsPerFrame(retryRate) {
  const result = await simulate({
    frames: 240,
    presentHz: 120,
    retryRate,
    lag: 2,
    model: {...MODEL, sourceFps: 120}
  });
  const audioReads = Math.floor((result.frames * result.msPerFrame) / 1000) + 1;
  return result.requestsPerFrame - audioReads / result.frames;
}

test('a short stream drains its lag-2 tail and stops both workers before finalize', async () => {
  const device = simulatedDevice();
  const live = await liveOn(device);
  const gated = [];
  await stream(device, live, 5, (_sequence, requests) =>
    gated.push(requests.filter(item => item === 'gate').length)
  );
  assert.deepEqual(gated, [0, 1, 1, 1, 1]);
  assert.deepEqual(device.transport.sent, [101, 102, 103, 104, 105]);
  const before = device.requests.length;
  const tail = await live.finish({sink: device.sink});
  assert.deepEqual(tail, {drained: 2});
  assert.deepEqual(
    device.requests.slice(before).filter(item => item === 'gate' || item === 'drain'),
    ['gate', 'drain', 'drain']
  );
  assert.equal(device.transport.aborted, true);
  assert.deepEqual(withoutPacer(live.counts), {
    submitted: 5,
    decoded: 5,
    presented: 5,
    skipped: 0,
    tailDrained: 2,
    rereads: 0,
    appliedPeriodMs: 1000 / 60,
    waiting: {}
  });
  await live.stop();
  assert.equal(live.retained, false);
});

test('steady frames cost the request-budget staggered lag-2 reference', async () => {
  const device = simulatedDevice();
  const live = await liveOn(device);
  const steady = [];
  await stream(device, live, 24, (sequence, requests) => {
    if (sequence > 8) steady.push(requests);
  });
  for (const requests of steady) assert.deepEqual(requests, ['read', 'gate']);
  const measured = steady.reduce((sum, value) => sum + value.length, 0) / steady.length;
  const reference = await modelRequestsPerFrame(0);
  assert.ok(
    Math.abs(measured - reference) < 0.01,
    `scheduler ${measured} vs model ${reference} requests/frame`
  );
  await live.finish({sink: device.sink});
  await live.stop();
});

test('a late receive costs the one reread the request budget models', async () => {
  const late = new Set([10, 12, 14, 16, 18, 20, 22, 24]);
  const device = simulatedDevice({late});
  const pauses = [];
  const live = await liveOn(device, async ms => pauses.push(ms));
  const steady = [];
  await stream(device, live, 25, (sequence, requests) => {
    if (sequence > 9) steady.push(requests.length);
  });
  const measured = steady.reduce((sum, value) => sum + value, 0) / steady.length;
  const reference = await modelRequestsPerFrame(late.size / steady.length);
  assert.ok(
    Math.abs(measured - reference) < 0.02,
    `scheduler ${measured} vs model ${reference} requests/frame`
  );
  assert.equal(live.counts.rereads, late.size);
  assert.deepEqual(live.counts.waiting, {receive: late.size});
  assert.deepEqual(pauses, [], 'late gate statuses are reread without a pause');
  await live.finish({sink: device.sink});
  await live.stop();
});

test('a host backlog skips older presents but decodes and fetches every unit', async () => {
  const device = simulatedDevice();
  const live = await liveOn(device);
  const backlog = new Map([6, 7, 8, 9, 10, 11, 12].map(sequence => [sequence, 5]));
  const shown = [];
  for (let sequence = 1; sequence <= 16; sequence++) {
    const unit = unitAt(sequence);
    device.pts.set(sequence, BigInt(unit.pts));
    await live.push(unit, {
      sink: device.sink,
      backlog: backlog.get(sequence) ?? 0,
      onSkipped: () => shown.push('skip'),
      onPresented: () => shown.push('show')
    });
  }
  assert.deepEqual(shown.slice(0, 10), [
    'show',
    'show',
    'skip',
    'skip',
    'skip',
    'skip',
    'show',
    'skip',
    'skip',
    'show'
  ]);
  assert.deepEqual(await live.finish({sink: device.sink}), {drained: 2});
  const counts = live.counts;
  assert.equal(counts.decoded, 16);
  assert.equal(counts.presented + counts.skipped, 16);
  assert.equal(counts.skipped, 6);
  assert.equal(device.applied(), counts.presented);
  assert.deepEqual(device.onScreenWrites, []);
  await live.stop();
});

test('a backlogged stream skips presents without sleeping to the vsync', async () => {
  const clock = {now: 0, vsyncMs: 1000 / 60, readMs: 2.24};
  const device = simulatedDevice({clock});
  const sleeps = [];
  const live = await liveOn(
    device,
    async ms => {
      sleeps.push(ms);
      clock.now += ms;
    },
    clock
  );
  const frames = 60;
  for (let sequence = 1; sequence <= frames; sequence++) {
    const unit = unitAt(sequence);
    device.pts.set(sequence, BigInt(unit.pts));
    await live.push(unit, {sink: device.sink, backlog: 5});
  }
  const {presented, skipped, decoded} = live.counts;
  assert.equal(decoded, frames - 3);
  assert.equal(presented + skipped, frames - 4);
  assert.ok(skipped >= 4 * presented - 4, `${skipped} skipped, ${presented} presented`);
  assert.ok(sleeps.length <= presented + 1, `${sleeps.length} vsync sleeps`);
  assert.ok(clock.now < (frames * clock.vsyncMs) / 2, `${clock.now} ms for ${frames} units`);
  assert.deepEqual(device.onScreenWrites, []);
  await live.finish({sink: device.sink});
  await live.stop();
});

function fakeWorker(events, {receive = n => n, stopFails = false, retained = false} = {}) {
  const transport = {
    maxAccessUnit: 0x100000,
    async send(data) {
      events.push('send-' + data.length);
    }
  };
  let last = 0;
  const worker = {
    diagnostics: {retained},
    async start(initial) {
      events.push('start-' + initial.sequence);
    },
    async readStatus() {
      events.push('status');
      return {
        current: 0,
        nativeApplied: last,
        receive: {sequence: last + 1, count: BigInt(receive(100 + last + 1))},
        input: {sendStatus: 0n, nextSlotStatus: 0n, nextIndex: 1, sequence: last},
        acquire: {
          status: 0n,
          index: 0,
          pts: BigInt(Math.max(1, last - 1) * 1000),
          sequence: last - 1
        },
        fetch: {setStatus: 0n, getStatus: 0n, releaseStatus: 0n, sequence: last - 2}
      };
    },
    async inputSlot(index) {
      return {index, address: 0x7900000000, capacity: 0x100000};
    },
    async openGates({snapshot, expected}) {
      status.check(snapshot, expected);
      events.push('gate-' + expected.receive.sequence);
      last = expected.receive.sequence;
    },
    async drainOutput() {
      events.push('drain');
    },
    async stop() {
      events.push('worker-stop');
      if (stopFails) throw Error('Staggered output did not stop; restart SmileBASIC');
    }
  };
  return {worker, transport};
}

async function fakeLive(events, options) {
  const {worker, transport} = fakeWorker(events, options);
  const live = create({createWorker: async () => worker, pause: noPause, timeoutMs: 50});
  await live.factory({transport});
  live.start({input: {status: 0, index: 2}, frame: layout});
  return live;
}

test('a short receive fails the check and never opens a gate', async () => {
  const events = [];
  const live = await fakeLive(events, {receive: bytes => bytes - 1});
  const sink = {
    async workerDestination() {
      events.push('destination');
    }
  };
  await live.push(unitAt(1), {sink});
  await assert.rejects(live.push(unitAt(2), {sink}), /Short receive/);
  assert.deepEqual(events, ['start-1', 'send-101', 'status']);
  await live.stop();
  assert.deepEqual(events.slice(-1), ['worker-stop']);
});

test('a failed check carries what it expected and the status it read', async () => {
  const live = await fakeLive([], {receive: bytes => bytes - 1});
  const sink = {async workerDestination() {}};
  await live.push(unitAt(1), {sink});
  await assert.rejects(live.push(unitAt(2), {sink}), error => {
    assert.deepEqual(error.expected, {receive: {sequence: 1, bytes: 101}});
    assert.equal(error.checked.receive.count, '100');
    assert.equal(error.checked.nativeApplied, 0);
    assert.equal(error.previous, null, 'nothing was published before the first gate');
    return /Short receive/.test(error.message);
  });
});

test('a retained or failed worker stop asks for a SmileBASIC restart once', async () => {
  for (const options of [{stopFails: true}, {retained: true}]) {
    const events = [];
    const live = await fakeLive(events, options);
    await assert.rejects(live.stop(), error => error.message.includes(RESTART));
    assert.equal(live.retained, true);
    await assert.rejects(live.stop(), error => error.message === RESTART);
    assert.deepEqual(events, ['worker-stop']);
  }
});

test('the scheduler refuses access units without increasing PTS', async () => {
  const events = [];
  const live = await fakeLive(events);
  await live.push(unitAt(2), {sink: {}});
  await assert.rejects(live.push(unitAt(1), {sink: {}}), /increasing access-unit PTS/);
  assert.deepEqual(events, ['start-1', 'send-102']);
});

test('a gate waiting for present sleeps to the vsync instead of polling', async () => {
  const clock = {now: 0, vsyncMs: 1000 / 60, readMs: 2.24};
  const device = simulatedDevice({clock});
  const live = await liveOn(
    device,
    async ms => {
      clock.now += ms;
    },
    clock
  );
  const reads = [];
  await stream(device, live, 60, (sequence, requests) => {
    if (sequence > 10) reads.push(requests.filter(item => item === 'read').length);
  });
  const perFrame = reads.reduce((sum, value) => sum + value, 0) / reads.length;
  assert.ok(perFrame <= 1.2, `${perFrame} status reads per frame`);
  assert.ok(live.counts.waiting.applied > 0, 'the stream waited for present');
  assert.ok((clock.now / 1000) * 60 <= 62, `${clock.now} ms for 60 frames`);
  await live.finish({sink: device.sink});
  await live.stop();
});

test('skipBacklog Infinity presents every unit under a backlog', async () => {
  const device = simulatedDevice();
  const live = await liveOn(device, noPause, null, {skipBacklog: Infinity});
  for (let sequence = 1; sequence <= 12; sequence++) {
    const unit = unitAt(sequence);
    device.pts.set(sequence, BigInt(unit.pts));
    await live.push(unit, {sink: device.sink, backlog: 5});
  }
  await live.finish({sink: device.sink});
  assert.equal(live.counts.skipped, 0);
  assert.equal(live.counts.presented, 12);
  assert.equal(device.applied(), 12);
  await live.stop();
});

const vsyncClock = () => ({now: 0, vsyncMs: 1000 / 60, readMs: 2.24});
const clockPause = clock => async ms => {
  clock.now += ms;
};

test('the vsync rule publishes once per vsync under a backlog and decodes every unit', async () => {
  const clock = vsyncClock();
  const device = simulatedDevice({clock});
  const live = await liveOn(device, clockPause(clock), clock, {skipRule: 'vsync', skipBacklog: 1});
  const frames = 60;
  for (let sequence = 1; sequence <= frames; sequence++) {
    const unit = unitAt(sequence);
    device.pts.set(sequence, BigInt(unit.pts));
    await live.push(unit, {sink: device.sink, backlog: 5});
  }
  const vsyncs = clock.now / clock.vsyncMs;
  const {presented, waiting} = live.counts;
  assert.ok(Math.abs(presented - vsyncs) <= 2, `${presented} presented over ${vsyncs} vsyncs`);
  assert.equal(waiting.applied, undefined, 'no gate waited for present under the backlog');
  assert.deepEqual(await live.finish({sink: device.sink}), {drained: 2});
  const counts = live.counts;
  assert.equal(counts.decoded, frames);
  assert.equal(counts.presented + counts.skipped, frames);
  assert.equal(device.applied(), counts.presented);
  assert.ok(!device.unapplied.includes(true), 'never two publications pending');
  assert.deepEqual(device.onScreenWrites, []);
  await live.stop();
});

test('the vsync rule waits for a publication pending for two vsync periods', async () => {
  const clock = vsyncClock();
  const device = simulatedDevice({clock, stalled: true});
  const live = await liveOn(device, clockPause(clock), clock, {
    skipRule: 'vsync',
    skipBacklog: 1,
    timeoutMs: 50
  });
  let failure = null;
  for (let sequence = 1; sequence <= 40 && !failure; sequence++) {
    const unit = unitAt(sequence);
    device.pts.set(sequence, BigInt(unit.pts));
    failure = await live.push(unit, {sink: device.sink, backlog: 5}).then(
      () => null,
      error => error
    );
  }
  assert.match(failure?.message ?? '', /checked status timed out/);
  assert.ok(live.counts.skipped > 0, 'outputs went off screen before the deadline');
  assert.ok(live.counts.waiting.applied > 0, 'the stale publication was waited for');
  assert.equal(live.counts.presented, 0);
  assert.ok(clock.now >= (2 * 1000) / 60, `${clock.now} ms before the wait`);
});

test('without a backlog the vsync rule costs and presents like the T23 rule', async () => {
  const runRule = async skipRule => {
    const device = simulatedDevice();
    const live = await liveOn(device, noPause, null, {skipRule, skipBacklog: 1});
    const steady = [];
    await stream(device, live, 24, (sequence, requests) => {
      if (sequence > 8) steady.push(requests);
    });
    await live.finish({sink: device.sink});
    await live.stop();
    return {steady, counts: live.counts, applied: device.applied()};
  };
  const legacy = await runRule('backlog');
  const vsync = await runRule('vsync');
  for (const requests of vsync.steady) assert.deepEqual(requests, ['read', 'gate']);
  assert.deepEqual(withoutPacer(vsync.counts), withoutPacer(legacy.counts));
  assert.equal(vsync.applied, 24);
});

test('an unknown skip rule is refused', () => {
  assert.throws(() => create({skipRule: 'newest'}), /Unknown staggered skip rule/);
});

test('the vsync rule waits for the pending publication when no surface is free', async () => {
  const clock = vsyncClock();
  const noFreeSurface = new Set([3, 8]);
  const device = simulatedDevice({clock, noFreeSurface});
  const live = await liveOn(device, clockPause(clock), clock, {skipRule: 'vsync', skipBacklog: 1});
  const frames = 40;
  for (let sequence = 1; sequence <= frames; sequence++) {
    const unit = unitAt(sequence);
    device.pts.set(sequence, BigInt(unit.pts));
    await live.push(unit, {sink: device.sink, backlog: 5});
  }
  await live.finish({sink: device.sink});
  const counts = live.counts;
  assert.equal(noFreeSurface.size, 0, 'both discards found no free surface');
  assert.equal(counts.decoded, frames);
  assert.equal(counts.presented + counts.skipped, frames);
  assert.equal(device.applied(), counts.presented);
  assert.ok(!device.unapplied.includes(true), 'never two publications pending');
  await live.stop();
});

async function decodeBound(decodeWait, {decodeMs = 8.5, frames = 60, avoid = null} = {}) {
  const clock = vsyncClock();
  const device = simulatedDevice({clock, decodeMs});
  const live = await liveOn(device, clockPause(clock), clock, {
    skipRule: 'vsync',
    skipBacklog: 1,
    decodeWait,
    avoid
  });
  const requests = [];
  for (let sequence = 1; sequence <= frames; sequence++) {
    const unit = unitAt(sequence);
    device.pts.set(sequence, BigInt(unit.pts));
    const before = device.requests.length;
    await live.push(unit, {sink: device.sink, backlog: 5});
    requests.push(device.requests.slice(before));
  }
  const elapsed = clock.now;
  await live.finish({sink: device.sink});
  await live.stop();
  return {counts: live.counts, requests, elapsed};
}

test('the decode wait sleeps through a pending acquire instead of rereading', async () => {
  const reread = await decodeBound(false);
  const waited = await decodeBound(true);
  assert.ok(reread.counts.waiting.acquire > 60, `${reread.counts.waiting.acquire} acquire rereads`);
  assert.ok(
    waited.counts.waiting.acquire < reread.counts.waiting.acquire / 4,
    `${waited.counts.waiting.acquire} acquire rereads with the wait`
  );
  assert.equal(waited.counts.decoded, reread.counts.decoded);
  assert.ok(waited.elapsed <= reread.elapsed * 1.03, `${waited.elapsed}/${reread.elapsed} ms`);
  assert.ok(
    Math.abs(waited.counts.presented - reread.counts.presented) <= 2,
    `${waited.counts.presented}/${reread.counts.presented} presented`
  );
});

test('status reads are binned against the predicted decode-done they aim at', async () => {
  const {counts} = await decodeBound(true);
  const status = counts.exchanges.status;
  const gate = counts.exchanges.gate;
  assert.equal(status.exchanges + gate.exchanges > 100, true, 'every exchange is counted');
  assert.equal(+(status.ms / status.exchanges).toFixed(2), 2.24, 'the sim charges readMs a read');
  const bins = status.offsets.decodeDone;
  const total = Object.values(bins).reduce((sum, bin) => sum + bin.n, 0);
  const aimed = (bins['-3']?.n ?? 0) + (bins['-2']?.n ?? 0);
  assert.ok(aimed > total / 2, `${aimed} of ${total} reads start a readMs before decode-done`);
  assert.ok(status.offsets.gate && status.offsets.send, 'gate and send offsets are always binned');
  assert.equal(status.offsets.receiveDone, undefined, 'no receive predictor, no receive bins');
});

test('the avoid window moves status reads past the predicted decode-done', async () => {
  const plain = await decodeBound(true);
  const avoided = await decodeBound(true, {avoid: {beforeMs: 3, afterMs: 2}});
  const bins = avoided.counts.exchanges.status.offsets.decodeDone;
  const inside = ['-3', '-2', '-1', '0', '1'].reduce((sum, bin) => sum + (bins[bin]?.n ?? 0), 0);
  assert.equal(inside, 0, JSON.stringify(bins));
  assert.ok(bins['2']?.n > 0, 'reads land right after the window');
  assert.equal(avoided.counts.decoded, plain.counts.decoded);
  assert.ok(
    Math.abs(avoided.counts.presented - plain.counts.presented) <= 2,
    `${avoided.counts.presented}/${plain.counts.presented} presented`
  );
  const off = await decodeBound(true, {avoid: null});
  assert.deepEqual(off.requests, plain.requests, 'no window changes nothing');
});

test('the decode wait changes nothing while decode keeps up', async () => {
  const reread = await decodeBound(false, {decodeMs: 0});
  const waited = await decodeBound(true, {decodeMs: 0});
  assert.deepEqual(waited.requests, reread.requests);
  assert.deepEqual(withoutPacer(waited.counts), withoutPacer(reread.counts));
  assert.equal(waited.elapsed, reread.elapsed);
});

test('the decode wait needs the vsync skip rule', () => {
  assert.throws(() => create({decodeWait: true}), /decode wait needs the vsync skip rule/);
});

async function receiveBound(receiveWait, {receiveMs = 7, frames = 60} = {}) {
  const clock = vsyncClock();
  const device = simulatedDevice({clock, receiveMs});
  const live = await liveOn(device, clockPause(clock), clock, {
    skipRule: 'vsync',
    skipBacklog: 1,
    receiveWait
  });
  const requests = [];
  for (let sequence = 1; sequence <= frames; sequence++) {
    const unit = unitAt(sequence);
    device.pts.set(sequence, BigInt(unit.pts));
    const before = device.requests.length;
    await live.push(unit, {sink: device.sink, backlog: 5});
    requests.push(device.requests.slice(before));
  }
  const elapsed = clock.now;
  await live.finish({sink: device.sink});
  await live.stop();
  return {counts: live.counts, requests, elapsed};
}

// A receive-bound loop gets faster without the rereads, so it sees fewer vsyncs for the same
// units; what must hold is the presented share of those vsyncs.
test('the receive wait sleeps through a slow receive instead of rereading', async () => {
  const reread = await receiveBound(false);
  const waited = await receiveBound(true);
  assert.ok(reread.counts.waiting.receive > 60, `${reread.counts.waiting.receive} receive rereads`);
  assert.ok(
    waited.counts.waiting.receive < reread.counts.waiting.receive / 4,
    `${waited.counts.waiting.receive} receive rereads with the wait`
  );
  assert.equal(waited.counts.decoded, reread.counts.decoded);
  assert.ok(waited.elapsed <= reread.elapsed, `${waited.elapsed}/${reread.elapsed} ms`);
  const perVsync = run => (run.counts.presented * (1000 / 60)) / run.elapsed;
  assert.ok(
    Math.abs(perVsync(waited) - perVsync(reread)) <= 0.05,
    `${perVsync(waited)}/${perVsync(reread)} presented per vsync`
  );
});

test('the receive wait changes nothing while the receive keeps up', async () => {
  const reread = await receiveBound(false, {receiveMs: 0});
  const waited = await receiveBound(true, {receiveMs: 0});
  assert.deepEqual(waited.requests, reread.requests);
  const {receive, ...waitedCounts} = withoutPacer(waited.counts);
  assert.equal(receive.sleeps, 0);
  assert.deepEqual(waitedCounts, withoutPacer(reread.counts));
  assert.equal(waited.elapsed, reread.elapsed);
});

test('push reports its gate write and its send on the scheduler clock', async () => {
  const clock = vsyncClock();
  const device = simulatedDevice({clock});
  const live = await liveOn(device, clockPause(clock), clock);
  const times = [];
  for (let sequence = 1; sequence <= 12; sequence++) {
    const unit = unitAt(sequence);
    device.pts.set(sequence, BigInt(unit.pts));
    const seen = {sequence};
    await live.push(unit, {
      sink: device.sink,
      onGate: at => {
        seen.gate = at;
        seen.reads = device.requests.filter(item => item === 'read').length;
      },
      onSent: at => {
        seen.sent = at;
      }
    });
    times.push(seen);
  }
  assert.equal(times[0].gate, undefined, 'the first unit starts the workers without a gate');
  for (const seen of times.slice(1)) {
    assert.ok(seen.gate <= seen.sent, `unit ${seen.sequence} sent before its gate`);
    assert.ok(seen.reads > 0);
  }
  for (let index = 1; index < times.length; index++)
    assert.ok(times[index].sent > times[index - 1].sent || index < 3);
  assert.equal(times.at(-1).sent, clock.now);
  await live.finish({sink: device.sink});
  await live.stop();
});

async function trimRun(stale, options, backlog = 1) {
  const device = simulatedDevice();
  const discard = device.sink.discardDestination;
  const discards = [];
  device.sink.discardDestination = async presentation => {
    discards.push(presentation);
    return discard(presentation);
  };
  const live = await liveOn(device, noPause, null, options);
  const shown = [];
  const trims = [];
  for (let sequence = 1; sequence <= 16; sequence++) {
    const unit = {
      ...unitAt(sequence),
      arrivedAt: stale.has(sequence) ? Date.now() - 1000 : Date.now() + 1e6
    };
    device.pts.set(sequence, BigInt(unit.pts));
    await live.push(unit, {
      sink: device.sink,
      backlog: typeof backlog === 'function' ? backlog(sequence) : backlog,
      onSkipped: () => shown.push(sequence + ':skip'),
      onTrimmed: ageMs => trims.push({sequence, ageMs})
    });
  }
  await live.finish({sink: device.sink});
  const counts = live.counts;
  assert.equal(counts.decoded, 16);
  assert.equal(counts.presented + counts.skipped, 16);
  assert.deepEqual(device.onScreenWrites, []);
  await live.stop();
  return {counts, shown, trims, discards};
}

test('a unit stale at three gates in a row trims one output through the skip path', async () => {
  assert.equal(TRIM_FRAMES, 3);
  const {counts, shown, trims, discards} = await trimRun(new Set([6, 7, 8, 9]), {
    trimBacklogMs: 20
  });
  assert.deepEqual(
    trims.map(trim => trim.sequence),
    [8]
  );
  assert.ok(trims[0].ageMs >= 1000);
  assert.equal(discards.length, 1);
  assert.equal(counts.trimmed, 1);
  assert.equal(counts.skipped, 1);
  assert.equal(shown.length, 1);
});

test('a stale run broken by a fresh unit never trims', async () => {
  const {counts, trims, discards} = await trimRun(new Set([4, 5, 7, 8, 10, 11]), {
    trimBacklogMs: 20
  });
  assert.deepEqual(trims, []);
  assert.deepEqual(discards, []);
  assert.equal(counts.trimmed, 0);
  assert.equal(counts.skipped, 0);
});

test('without trimBacklogMs stale units present every output', async () => {
  const {counts, trims, discards} = await trimRun(new Set([4, 5, 6, 7, 8, 9, 10, 11]));
  assert.deepEqual(trims, []);
  assert.deepEqual(discards, []);
  assert.equal(counts.skipped, 0);
  assert.equal('trimmed' in counts, false);
});

const everyUnit = new Set(Array.from({length: 16}, (_, index) => index + 1));

test('stale units with nothing queued behind them never trim', async () => {
  const {counts, trims, discards} = await trimRun(everyUnit, {trimBacklogMs: 20}, 0);
  assert.deepEqual(trims, []);
  assert.deepEqual(discards, []);
  assert.equal(counts.trimmed, 0);
  assert.equal(counts.presented, 16);
});

test('a standing stale queue trims at most once per six gates', async () => {
  const {counts, trims} = await trimRun(everyUnit, {trimBacklogMs: 20});
  assert.deepEqual(
    trims.map(trim => trim.sequence),
    [6, 12]
  );
  assert.equal(counts.trimmed, 2);
  assert.equal(counts.skipped, 2);
});

test('an empty-queue gate in a stale run restarts the count', async () => {
  const {counts, trims} = await trimRun(everyUnit, {trimBacklogMs: 20}, sequence =>
    sequence === 5 ? 0 : 1
  );
  assert.deepEqual(
    trims.map(trim => trim.sequence),
    [8, 14]
  );
  assert.equal(counts.trimmed, 2);
});

test('the backlog trim needs a skip backlog of at least 1', () => {
  assert.throws(
    () => create({skipBacklog: 0, trimBacklogMs: 20}),
    /backlog trim needs a skip backlog of at least 1/
  );
  assert.doesNotThrow(() => create({skipBacklog: Infinity, trimBacklogMs: 20}));
});

test('the backlog trim needs the backlog skip rule', () => {
  assert.throws(
    () => create({skipRule: 'vsync', skipBacklog: 1, trimBacklogMs: 20}),
    /backlog trim needs the backlog rule/
  );
});

async function defaultStreamDigest() {
  const device = simulatedDevice();
  const hash = require('node:crypto').createHash('sha256');
  const {write, writeAndCall} = device.rpc;
  device.rpc.write = async (address, bytes) => {
    hash.update(`write ${address} `).update(bytes);
    return write(address, bytes);
  };
  device.rpc.writeAndCall = async (address, bytes, ...rest) => {
    hash.update(`gate ${address} `).update(bytes);
    return writeAndCall(address, bytes, ...rest);
  };
  const live = await liveOn(device);
  for (let sequence = 1; sequence <= 16; sequence++) {
    const unit = {...unitAt(sequence), arrivedAt: Date.now() - 1000};
    device.pts.set(sequence, BigInt(unit.pts));
    await live.push(unit, {sink: device.sink, backlog: [6, 7, 8].includes(sequence) ? 5 : 0});
  }
  await live.finish({sink: device.sink});
  await live.stop();
  hash.update(device.requests.join(',')).update(device.transport.sent.join(','));
  return hash.digest('hex');
}

test('with every flag off a stream writes the same bytes as before the latency cuts', async () => {
  assert.equal(await defaultStreamDigest(), DEFAULT_STREAM_DIGEST);
});

test('gate on receive primes, sends and gates each unit in its own push', async () => {
  const device = simulatedDevice();
  const live = await liveOn(device, noPause, null, {gateOnReceive: true});
  const perPush = [];
  await stream(device, live, 24, (_sequence, requests) => perPush.push(requests));
  assert.ok(perPush[0].includes('gate'), 'the first unit is gated in its own push');
  for (const requests of perPush.slice(8)) assert.deepEqual(requests, ['prime', 'read', 'gate']);
  const before = device.requests.length;
  assert.deepEqual(await live.finish({sink: device.sink}), {drained: 2});
  const tail = device.requests.slice(before);
  assert.ok(!tail.includes('gate') && !tail.includes('prime'), 'the tail opens no further gate');
  const counts = live.counts;
  assert.equal(counts.decoded, 24);
  assert.equal(counts.presented, 24);
  assert.equal(device.applied(), 24);
  await live.stop();
});

test('lag 1 times out, bounded, on a decoder that holds an output back', async () => {
  const device = simulatedDevice();
  const live = await liveOn(device, noPause, null, {lag: 1, timeoutMs: 100});
  await assert.rejects(stream(device, live, 6), /checked status timed out/);
  assert.equal(device.applied(), 0);
  await live.stop();
});

test('the output lag is 1 or 2', () => {
  assert.throws(() => create({createWorker, lag: 3}), /output lag is 1 or 2/);
});

test('at lag 1 a gate expects the output one behind and the fetch before it', () => {
  const units = new Map(
    [1, 2, 3, 4, 5].map(sequence => [sequence, {length: 10, pts: BigInt(sequence)}])
  );
  const destinations = new Map([[3, {sequence: 7, index: 1}]]);
  assert.deepEqual(expectedFor(5, units, destinations, 1), {
    receive: {sequence: 5, bytes: 10},
    input: {sequence: 4},
    acquire: {sequence: 4, pts: 4n},
    fetch: {sequence: 3},
    ack: {sequence: 7, index: 1}
  });
  assert.deepEqual(expectedFor(2, units, destinations, 1), {
    receive: {sequence: 2, bytes: 10},
    input: {sequence: 1},
    acquire: {sequence: 1, pts: 1n}
  });
  assert.deepEqual(Object.keys(expectedFor(5, units, new Map([[2, {skip: true}]]))), [
    'receive',
    'input',
    'acquire',
    'fetch'
  ]);
});

// staggered-gate.js
function snapshot() {
  return {
    current: 2,
    nativeApplied: 11,
    receive: {count: 40000n, sequence: 5},
    input: {sendStatus: 0n, nextSlotStatus: 0n, nextIndex: 1, sequence: 4},
    acquire: {status: 0n, index: 0, pts: 3n, sequence: 3},
    fetch: {setStatus: 0n, getStatus: 0n, releaseStatus: 0n, sequence: 2}
  };
}

const publication = {mapped: 0x7400000000, color: 1};
const destination = {
  index: 0,
  address: publication.mapped + ring.frameOffset(0),
  bytes: ring.FRAME_BYTES,
  sequence: 12,
  color: 1
};
const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
const request = {
  expected: {
    receive: {sequence: 5, bytes: 40000},
    input: {sequence: 4},
    acquire: {sequence: 3, pts: 3n},
    fetch: {sequence: 2},
    ack: {sequence: 11, index: 2}
  },
  inputSlot: {index: 1, address: 0x7900000000, capacity: 0x100000},
  current: {sequence: 5, length: 40000, pts: 5n},
  next: {sequence: 6, length: 41000, pts: 6n},
  fetchGate: 0x7300000020,
  ignoredFetchGate: 0x7300000010,
  publication,
  destination,
  frame
};

test('one checked write carries current decode, next receive and lag-two fetch', () => {
  const {offset, bytes} = gate.gateWrite({snapshot: snapshot(), ...request});
  assert.equal(offset, input.CONTROL.descriptors[0]);
  assert.equal(bytes.length, gate.WRITE_BYTES);
  assert.equal(bytes.readUInt32LE(0), 5);
  assert.equal(bytes.readUInt32LE(input.DESCRIPTOR.bytes), 6);
  const outputSlot0 = output.CONTROL.descriptors[0] - offset;
  const outputSlot1 = output.CONTROL.descriptors[1] - offset;
  assert.equal(bytes.readUInt32LE(outputSlot0), 3);
  assert.equal(bytes.readBigUInt64LE(outputSlot0 + 8), BigInt(destination.address));
  assert.equal(bytes.readUInt32LE(outputSlot0 + 24 + 28), destination.sequence);
  assert.equal(bytes.readUInt32LE(outputSlot1), 4);
  assert.equal(bytes.readBigUInt64LE(outputSlot1 + 8), 0n);
});

test('fetch remains closed when the acquired output or publication target differs', () => {
  const wrong = snapshot();
  wrong.acquire.pts = 4n;
  assert.throws(() => gate.gateWrite({snapshot: wrong, ...request}), /output status/);
  assert.throws(
    () =>
      gate.gateWrite({snapshot: snapshot(), ...request, destination: {...destination, index: 1}}),
    /target/
  );
  const shifted = snapshot();
  shifted.acquire.sequence = 4;
  assert.throws(
    () =>
      gate.gateWrite({
        snapshot: shifted,
        ...request,
        expected: {...request.expected, acquire: {sequence: 4, pts: 3n}}
      }),
    /two AUs/
  );
});

test('bootstrap writes sequence tags without opening an unchecked fetch', () => {
  const initial = snapshot();
  initial.receive = {count: 40000n, sequence: 1};
  const {offset, bytes} = gate.gateWrite({
    snapshot: initial,
    ...request,
    expected: {receive: {sequence: 1, bytes: 40000}},
    current: {sequence: 1, length: 40000, pts: 1n},
    next: {sequence: 2, length: 41000, pts: 2n},
    destination: null
  });
  assert.equal(bytes.readBigUInt64LE(input.DESCRIPTOR.fetchGate), BigInt(request.ignoredFetchGate));
  assert.equal(bytes.readUInt32LE(output.CONTROL.descriptors[0] - offset), 1);
  assert.equal(bytes.readUInt32LE(output.CONTROL.descriptors[1] - offset), 2);
  assert.equal(bytes.readBigUInt64LE(output.CONTROL.descriptors[0] - offset + 8), 0n);
});

test('at lag 1 the write fetches the output one behind decode', () => {
  const lagOne = snapshot();
  lagOne.acquire = {...lagOne.acquire, sequence: 4, pts: 4n};
  lagOne.fetch = {...lagOne.fetch, sequence: 3};
  const expected = {...request.expected, acquire: {sequence: 4, pts: 4n}, fetch: {sequence: 3}};
  const {offset, bytes} = gate.gateWrite({snapshot: lagOne, ...request, expected, lag: 1});
  const outputSlot0 = output.CONTROL.descriptors[0] - offset;
  const outputSlot1 = output.CONTROL.descriptors[1] - offset;
  assert.equal(bytes.readUInt32LE(outputSlot1), 4);
  assert.equal(bytes.readBigUInt64LE(outputSlot1 + 8), BigInt(destination.address));
  assert.equal(bytes.readUInt32LE(outputSlot0), 5);
  assert.equal(bytes.readBigUInt64LE(outputSlot0 + 8), 0n);
  assert.throws(() => gate.gateWrite({snapshot: snapshot(), ...request, lag: 1}), /one AU behind/);
  assert.throws(() => gate.gateWrite({snapshot: snapshot(), ...request, lag: 3}), /lag is 1 or 2/);
});

// gate-queue.js
const tick = () => new Promise(resolve => setImmediate(resolve));

test('queued gates run one at a time in order and drain waits for them', async () => {
  const queue = createGateQueue();
  const log = [];
  const ends = [];
  const gate = sequence => () =>
    new Promise(resolve => {
      log.push(`start ${sequence}`);
      ends.push(() => (log.push(`end ${sequence}`), resolve()));
    });
  await queue.admit(1);
  queue.push(1, gate(1));
  queue.observeReceive(1);
  await queue.admit(2);
  queue.push(2, gate(2));
  assert.equal(queue.depth, 2);
  let drained = false;
  const drain = queue.drain().then(() => (drained = true));
  await tick();
  assert.deepEqual(log, ['start 1']);
  ends.shift()();
  await tick();
  assert.deepEqual(log, ['start 1', 'end 1', 'start 2']);
  assert.equal(drained, false);
  ends.shift()();
  await drain;
  assert.equal(queue.depth, 0);
});

test('a prime waits for the previous receive and for room in the queue', async () => {
  const queue = createGateQueue({received: 1});
  const ends = [];
  const gate = () => new Promise(resolve => ends.push(resolve));
  await queue.admit(2);
  queue.push(2, gate);
  let admitted = false;
  const third = queue.admit(3).then(() => (admitted = true));
  await tick();
  assert.equal(admitted, false, 'unit 2 is not seen received yet');
  queue.observeReceive(2);
  await third;
  queue.push(3, gate);
  queue.observeReceive(3);
  admitted = false;
  const fourth = queue.admit(4).then(() => (admitted = true));
  await tick();
  assert.equal(admitted, false, 'two gates are already queued or running');
  ends.shift()();
  await fourth;
  ends.shift()();
  await queue.drain();
});

test('the first gate error stops the queue and reaches the producer', async () => {
  const queue = createGateQueue();
  const ran = [];
  queue.push(1, async () => {
    ran.push(1);
    throw Error('gate 1');
  });
  queue.push(2, async () => ran.push(2));
  await assert.rejects(queue.admit(3), /gate 1/);
  await assert.rejects(queue.drain(), /gate 1/);
  assert.throws(() => queue.push(3, async () => {}), /gate 1/);
  await assert.rejects(queue.admit(3), /gate 1/);
  assert.deepEqual(ran, [1]);
});

test('clear drops the gates that have not started and refuses further primes', async () => {
  const queue = createGateQueue({depth: 3});
  let release;
  queue.push(1, () => new Promise(resolve => (release = resolve)));
  queue.push(2, async () => assert.fail('a dropped gate ran'));
  const waiting = queue.admit(3);
  assert.deepEqual(queue.clear(), [2]);
  assert.equal(queue.depth, 1);
  await assert.rejects(waiting, /Gate queue stopped/);
  await assert.rejects(queue.admit(3), /Gate queue stopped/);
  release();
  await queue.drain();
});

test('push refuses a gate beyond the depth', async () => {
  const queue = createGateQueue();
  const releases = [];
  const gate = () => new Promise(resolve => releases.push(resolve));
  queue.push(1, gate);
  queue.push(2, gate);
  assert.throws(() => queue.push(3, gate), /Gate queue is full/);
  assert.equal(queue.depth, 2);
  releases.shift()();
  await tick();
  releases.shift()();
  await queue.drain();
});

// The console's two descriptor slots and auto-clear length gate: a prime that finds the gate
// still signalled merges its wake into the earlier one, and a prime into a slot the console has
// not taken yet overwrites a unit.
test('admitted primes never merge length-gate wakes over 200 units', async () => {
  const last = 201;
  const queue = createGateQueue({received: 1});
  const slots = [0, 0];
  let lengthGate = false;
  let merged = 0;
  let received = 1;
  const prime = sequence => {
    slots[(sequence - 1) % 2] = sequence;
    if (lengthGate) merged++;
    lengthGate = true;
  };
  const consoleSide = (async () => {
    for (let next = 2; next <= last; next++) {
      while (!lengthGate) await tick();
      lengthGate = false;
      assert.equal(slots[(next - 1) % 2], next, `descriptor ${next} was overwritten`);
      for (let read = 0; read < next % 3; read++) await tick();
      received = next;
    }
  })();
  const gate = sequence => async () => {
    for (;;) {
      await tick();
      queue.observeReceive(received);
      if (received >= sequence) return;
    }
  };
  for (let sequence = 2; sequence <= last; sequence++) {
    await queue.admit(sequence);
    prime(sequence);
    queue.push(sequence, gate(sequence));
  }
  await queue.drain();
  await consoleSide;
  assert.equal(merged, 0);
  assert.equal(received, last);
});

// staggered-status.js
function statusSnapshot() {
  const bytes = Buffer.alloc(READ_END - READ_START);
  const u32 = (offset, value) => bytes.writeUInt32LE(value, offset - READ_START);
  const i32 = (offset, value) => bytes.writeInt32LE(value, offset - READ_START);
  const u64 = (offset, value) => bytes.writeBigUInt64LE(BigInt(value), offset - READ_START);
  u32(ring.CONTROL.current, 1);
  u32(ring.CONTROL.nativeApplied, 14);
  u64(STATUS.receive, 40000);
  u32(STATUS.receive + 8, 9);
  u64(STATUS.input, 0);
  u64(STATUS.input + 8, 0);
  i32(STATUS.input + 16, 2);
  u32(STATUS.input + 20, 8);
  u64(STATUS.acquire, 0);
  i32(STATUS.acquire + 8, 3);
  u64(STATUS.acquire + 16, 7000);
  u32(STATUS.acquire + 24, 7);
  u64(STATUS.fetch, 0);
  u64(STATUS.fetch + 8, 0);
  u64(STATUS.fetch + 16, 0);
  u32(STATUS.fetch + 24, 6);
  return bytes;
}

const expected = {
  receive: {sequence: 9, bytes: 40000},
  input: {sequence: 8},
  acquire: {sequence: 7, pts: 7000},
  fetch: {sequence: 6},
  ack: {sequence: 14, index: 1}
};

test('staggered host gate accepts one complete checked status snapshot', () => {
  assert.deepEqual(check(parse(statusSnapshot()), expected), {
    inputIndex: 2,
    outputIndex: 3,
    current: 1,
    nativeApplied: 14
  });
});

test('staggered host gate keeps decode and fetch closed on incomplete or wrong results', () => {
  const bytes = statusSnapshot();
  bytes.writeUInt32LE(8, STATUS.receive + 8 - READ_START);
  assert.throws(() => check(parse(bytes), expected), {retryable: true, pending: 'receive'});
  bytes.writeUInt32LE(9, STATUS.receive + 8 - READ_START);
  bytes.writeBigInt64LE(39999n, STATUS.receive - READ_START);
  assert.throws(() => check(parse(bytes), expected), /Short receive/);
  bytes.writeBigInt64LE(40000n, STATUS.receive - READ_START);
  bytes.writeBigUInt64LE(1n, STATUS.acquire - READ_START);
  assert.throws(() => check(parse(bytes), expected), /output status/);
  bytes.writeBigUInt64LE(0n, STATUS.acquire - READ_START);
  bytes.writeUInt32LE(13, ring.CONTROL.nativeApplied - READ_START);
  assert.throws(() => check(parse(bytes), expected), {retryable: true, pending: 'applied'});
});

test('staggered gate treats temporary lack of an input slot as retryable', () => {
  const bytes = statusSnapshot();
  bytes.writeBigUInt64LE(0x100en, STATUS.input + 8 - READ_START);
  bytes.writeInt32LE(-1, STATUS.input + 16 - READ_START);
  assert.throws(() => check(parse(bytes), expected), {retryable: true, pending: 'slot'});
});

test('tail output check requires acquisition and prior publication without a new receive', () => {
  const state = parse(statusSnapshot());
  state.receive.count = 0n;
  assert.deepEqual(
    checkOutput(state, {
      acquire: {sequence: 7, pts: 7000n},
      fetch: {sequence: 6},
      ack: {sequence: 14, index: 1}
    }),
    {outputIndex: 3, current: 1, nativeApplied: 14}
  );
  state.acquire.pts = 7001n;
  assert.throws(
    () => checkOutput(state, {acquire: {sequence: 7, pts: 7000n}}),
    /output status/
  );
});

// A torn read: the status shows the ack applied (nativeApplied 14) but the previous surface.
const TAIL = {
  acquire: {sequence: 7, pts: 7000n},
  fetch: {sequence: 6},
  ack: {sequence: 14, index: 1}
};

/** A worker whose status reads present `currents` in turn, then the last one for good. */
function tearing(currents) {
  const worker = {
    reads: 0,
    async readStatus() {
      const state = parse(statusSnapshot());
      state.current = currents[Math.min(worker.reads++, currents.length - 1)];
      return state;
    }
  };
  return worker;
}

test('an applied publication on another surface is retried as a torn read', () => {
  const state = parse(statusSnapshot());
  state.current = 0;
  assert.throws(() => checkOutput(state, TAIL), {
    message: 'Applied publication surface differs',
    retryable: true,
    pending: 'torn'
  });
});

test('a torn read passes on the next read and is counted', async () => {
  const torn = [];
  const tail = tearing([0, 1]);
  const snapshot = await waitOutput(tail, TAIL, {pause: noPause, onReread: p => torn.push(p)});
  assert.equal(snapshot.current, 1);
  assert.equal(tail.reads, 2);
  assert.deepEqual(torn, ['torn']);

  const rereads = [];
  const full = tearing([0, 1]);
  await waitChecked(full, expected, {pause: noPause, onReread: p => rereads.push(p)});
  assert.equal(full.reads, 2);
  assert.deepEqual(rereads, ['torn']);
});

test('the same mismatch on two reads in a row is a wrong surface', async () => {
  for (const wait of [waitOutput, waitChecked]) {
    const worker = tearing([0]);
    await assert.rejects(
      wait(worker, wait === waitOutput ? TAIL : expected, {pause: noPause}),
      error => {
        assert.equal(error.checked.current, 0);
        assert.equal(error.checked.nativeApplied, 14);
        assert.equal(error.expected.ack.index, 1);
        return /surface differs/.test(error.message);
      }
    );
    assert.equal(worker.reads, 2);
  }
  const worker = tearing([0, 2, 2]);
  await assert.rejects(waitOutput(worker, TAIL, {pause: noPause}), /surface differs/);
  assert.equal(worker.reads, 3, 'a different mismatch starts over');
});
