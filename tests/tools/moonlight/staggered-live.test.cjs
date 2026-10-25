const test = require('node:test');
const assert = require('node:assert/strict');
const definitions = require('../../sdk/native/movie-functions.json');
const registration = require('../../sdk/native/movie-event-functions.json').registerClientEvents;
const {CODE} = require('../../sdk/native/thread.cjs');
const ring = require('./ring.cjs');
const status = require('./staggered-status.cjs');
const gates = require('./staggered-gate.cjs');
const outputPlan = require('./staggered-output-plan.cjs');
const {MODEL, simulate} = require('./request-budget.cjs');
const {create: createWorker} = require('./staggered-worker.cjs');
const {create, RESTART} = require('./staggered-live.cjs');

const layout = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
const noPause = async () => {};
const unitAt = sequence => ({data: Buffer.alloc(100 + sequence), pts: sequence * 1000});

// A console stand-in for the real staggered worker: TCP sends land in the receive status,
// the combined gate write decodes the gated unit and fetches the descriptor's output, and the
// output worker holds one decoded unit back until the input worker stops.
function simulatedDevice({late = new Set()} = {}) {
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
  let staleReceive = null;
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
      else setReceive(data.length, received);
    },
    abort() {
      transport.aborted = true;
    }
  };
  function acquireNext() {
    const sequence = Math.min(fetched + 1, transport.aborted ? decoded : decoded - 1);
    if (sequence < 1) return;
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
    const index = [0, 1, 2].find(item => mapped + ring.frameOffset(item) === address);
    ringWord(ring.CONTROL.current, 4, index);
    ringWord(ring.CONTROL.nativeApplied, 4, ++applied);
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
  const sink = {
    async workerDestination(presentation) {
      assert.ok(Number.isInteger(presentation.current));
      sequence++;
      const index = sequence % 3;
      return {
        index,
        address: mapped + ring.frameOffset(index),
        bytes: ring.FRAME_BYTES,
        sequence,
        color: 1
      };
    }
  };
  return {rpc, transport, module, functions, publication, sink, requests, pts};
}

async function liveOn(device) {
  const live = create({createWorker, pause: noPause});
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
  assert.deepEqual(live.counts, {submitted: 5, decoded: 5, presented: 5, tailDrained: 2});
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
  const live = await liveOn(device);
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
