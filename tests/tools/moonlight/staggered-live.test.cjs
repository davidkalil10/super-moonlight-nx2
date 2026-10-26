const test = require('node:test');
const assert = require('node:assert/strict');

/** The staggered counts without the pacer's read counters, which the fake device does not pin. */
// The pacer and the exchange bins carry run timing, so count comparisons leave them out.
const withoutPacer = ({pacer, exchanges, ...counts}) => (
  assert.equal(typeof pacer.reads, 'number'),
  assert.equal(typeof exchanges.status.ms, 'number'),
  counts
);
const definitions = require('../../../hbl-moonlight/sdk/native/movie-functions.json');
const registration =
  require('../../../hbl-moonlight/sdk/native/movie-event-functions.json').registerClientEvents;
const {CODE} = require('../../../hbl-platform/sdk/native/thread.js');
const ring = require('../../../hbl-moonlight/tools/moonlight/ring.js');
const status = require('../../../hbl-moonlight/tools/moonlight/staggered-status.js');
const gates = require('../../../hbl-moonlight/tools/moonlight/staggered-gate.js');
const outputPlan = require('../../../hbl-moonlight/tools/moonlight/staggered-output-plan.js');
const {MODEL, simulate} = require('./request-budget.cjs');
const {
  create: createWorker
} = require('../../../hbl-moonlight/tools/moonlight/staggered-worker.js');
const {create, RESTART} = require('../../../hbl-moonlight/tools/moonlight/staggered-live.js');

const layout = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
const noPause = async () => {};
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
    mode: 'staggered',
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
  assert.deepEqual(withoutPacer(waited.counts), withoutPacer(reread.counts));
  assert.equal(waited.elapsed, reread.elapsed);
});
