const test = require('node:test');
const assert = require('node:assert/strict');
const definitions = require('../../sdk/native/movie-functions.json');
const registration = require('../../sdk/native/movie-event-functions.json').registerClientEvents;
const sync = require('../../sdk/native/os-sync-functions.json');
const {CODE} = require('../../sdk/native/thread.cjs');
const ring = require('./ring.cjs');
const {create} = require('./split-decoder-worker.cjs');

const SDK = 0x40000000;
const MODULE = 0x50000000;
const decoder = 0x70000000;

function fixture({receiveBytes = 4096, outputIndex = 2, autoQueue = false} = {}) {
  const regions = [];
  const calls = [];
  const transport = {
    fd: 12,
    maxAccessUnit: 0x100000,
    recvFunction: SDK + 0x1234,
    sent: [],
    aborted: false,
    async send(bytes) {
      this.sent.push(bytes);
      calls.push({transportSend: true});
    },
    abort() {
      this.aborted = true;
    }
  };
  let allocations = 0;
  let control = 0;
  const timestamps = new Map();
  const regionAt = address =>
    regions.find(region => address >= region.base && address < region.base + region.bytes.length);
  const write = (address, bytes) => {
    const region = regionAt(address);
    assert.ok(region, `unmapped write at 0x${address.toString(16)}`);
    bytes.copy(region.bytes, address - region.base);
  };
  const read = (address, length) => {
    const region = regionAt(address);
    assert.ok(region, `unmapped read at 0x${address.toString(16)}`);
    return Buffer.from(
      region.bytes.subarray(address - region.base, address - region.base + length)
    );
  };
  const rpc = {
    a: {sdk: SDK},
    output: 0x20000000,
    async request() {
      return {verified: true};
    },
    async call(offset, args) {
      assert.equal(args[1], 4096);
      const base = 0x60000000 + allocations++ * 0x1000000;
      regions.push({base, bytes: Buffer.alloc(args[2])});
      if (args[2] === 4096) control = base;
      const output = Buffer.alloc(8);
      output.writeBigUInt64LE(BigInt(base));
      return {result: 0n, output};
    },
    async callAddress(address, args) {
      calls.push({address, args});
      if (address === SDK + CODE.create.offset) {
        const thread = Buffer.alloc(8);
        thread.writeBigUInt64LE(BigInt(0x1234 + calls.length));
        write(args[0], thread);
      }
      if (address === SDK + CODE.tryWait.offset) return {result: 1n};
      return {result: 0n};
    },
    read: async (address, length) => {
      if (address === control + 0x180) calls.push({statusRead: true, length});
      return read(address, length);
    },
    write: async (address, bytes) => write(address, bytes),
    async pair(operations) {
      calls.push({address: operations[0].address, args: operations[0].args, paired: true});
      return {results: [1n, BigInt(rpc.output)], output: read(operations[1].args[1], 44)};
    },
    async writeAndCall(address, bytes, target, args) {
      write(address, bytes);
      calls.push({address: target, args, combined: true});
      const gate = args[0] - control;
      if (gate === 0) {
        const sequence = bytes.readUInt32LE();
        timestamps.set(sequence, bytes.readBigUInt64LE(16));
        const received = Buffer.alloc(16);
        received.writeBigInt64LE(BigInt(receiveBytes));
        received.writeUInt32LE(sequence, 8);
        write(control + 0x180, received);
        const input = Buffer.alloc(28);
        input.writeInt32LE(1, 16);
        input.writeUInt32LE(sequence, 24);
        write(control + 0x1a0, input);
      } else if (gate === 0x40) {
        const acquired = Buffer.alloc(36);
        acquired.writeInt32LE(outputIndex, 8);
        acquired.writeBigUInt64LE(timestamps.get(bytes.readUInt32LE()), 16);
        acquired.writeUInt32LE(bytes.readUInt32LE(), 32);
        write(control + 0x1c0, acquired);
      } else if (gate === 0x60) {
        const fetched = Buffer.alloc(28);
        fetched.writeUInt32LE(read(control + 0x300, 4).readUInt32LE(), 24);
        write(control + 0x1f0, fetched);
        if (autoQueue) {
          const next = read(control + 0x338, 4).readUInt32LE();
          if (next) {
            const sequence = Buffer.alloc(4);
            sequence.writeUInt32LE(next);
            write(control + 0x300, sequence);
            const acquired = Buffer.alloc(36);
            acquired.writeInt32LE(outputIndex, 8);
            acquired.writeBigUInt64LE(timestamps.get(next), 16);
            acquired.writeUInt32LE(next, 32);
            write(control + 0x1c0, acquired);
          }
        }
      } else assert.fail('unexpected split worker gate');
      return {result: 0n};
    }
  };
  const module = {
    base: MODULE,
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
    Object.entries(definitions).map(([name, definition]) => [name, MODULE + definition.offset])
  );
  return {
    rpc,
    module,
    functions,
    transport,
    calls,
    read,
    get control() {
      return control;
    }
  };
}

async function workerFor(f, options = {}) {
  const worker = await create({
    rpc: f.rpc,
    module: f.module,
    functions: f.functions,
    decoder,
    output: decoder + 0x300,
    format: decoder + 0x180,
    transport: f.transport,
    ...options
  });
  await worker.register();
  await worker.start();
  return worker;
}

test('split worker runs two input jobs before fetching the first output', async () => {
  const f = fixture();
  const worker = await workerFor(f);
  const payload = Buffer.alloc(4096);
  const first = await worker.input({
    index: 1,
    length: 4096,
    pts: 30,
    inputAddress: 0x72000000,
    payload
  });
  await worker.queueOutput(first);
  const second = await worker.input({
    index: 1,
    length: 4096,
    pts: 60,
    inputAddress: 0x72000000,
    payload
  });
  assert.equal(worker.diagnostics.decodeGateSignals, 2);
  assert.equal(f.transport.sent.length, 2);
  assert.equal(
    f.calls.filter(
      call =>
        call.address === SDK + sync.signalLightEvent.offset && call.args?.[0] === f.control + 0x60
    ).length,
    0
  );
  const output = await worker.finishOutput(first, {address: 0x73000000, bytes: 0x400000});
  assert.equal(output.pts, 30n);
  await worker.queueOutput(second);
  await worker.finishOutput(second, {address: 0x73000000, bytes: 0x400000});
  assert.ok(f.calls.some(call => call.statusRead));
  assert.ok(f.calls.filter(call => call.statusRead).every(call => call.length === 0x98));
  assert.equal(f.calls.filter(call => call.paired).length, 0);
  await worker.stop();
  await worker.finalize();
  assert.equal(f.calls.filter(call => call.address === SDK + CODE.join.offset).length, 2);
  assert.equal(f.calls.filter(call => call.address === SDK + sync.finalizeEvent.offset).length, 1);
});

test('one status scheduler reads input and output progress together', async () => {
  const f = fixture();
  const worker = await workerFor(f);
  const job = await worker.stageInput({
    index: 1,
    length: 4096,
    pts: 30,
    inputAddress: 0x72000000,
    payload: Buffer.alloc(4096)
  });
  await worker.queueOutput(job);
  const [completed, acquired] = await Promise.all([
    worker.completeInput(job),
    worker.waitForAcquired(job)
  ]);
  assert.equal(completed.sequence, job.sequence);
  assert.equal(acquired.index, 2);
  assert.ok(f.calls.filter(call => call.statusRead).length <= 3);
  await worker.stop();
  await worker.finalize();
});

test('live input sends TCP bytes before opening the input gate', async () => {
  const f = fixture();
  const worker = await workerFor(f);
  const job = await worker.stageInput({
    index: 1,
    length: 4096,
    pts: 30,
    inputAddress: 0x72000000,
    payload: Buffer.alloc(4096),
    sendFirst: true
  });
  await worker.completeInput(job);
  const sent = f.calls.findIndex(call => call.transportSend);
  const opened = f.calls.findIndex(
    call => call.combined && call.args[0] === f.control
  );
  assert.ok(sent >= 0 && opened > sent);
  assert.equal(f.transport.sent.length, 1);
  await worker.stop();
  await worker.finalize();
});

test('the first acquire status read waits for the expected decode time', async () => {
  const f = fixture();
  const worker = await workerFor(f);
  const job = await worker.input({
    index: 1,
    length: 4096,
    pts: 30,
    inputAddress: 0x72000000,
    payload: Buffer.alloc(4096)
  });
  await worker.queueOutput(job);
  const previousReads = f.calls.filter(call => call.statusRead).length;
  const acquired = worker.waitForAcquired(job);
  assert.equal(f.calls.filter(call => call.statusRead).length, previousReads);
  assert.equal((await acquired).index, 2);
  await worker.stop();
  await worker.finalize();
});

test('output publication stages bounded metadata and sequence behind the fetch gate', async () => {
  const f = fixture();
  const mapped = 0x30000000;
  const worker = await workerFor(f, {publication: {mapped, color: 1}});
  const job = await worker.input({
    index: 1,
    length: 4096,
    pts: 30,
    inputAddress: 0x72000000,
    payload: Buffer.alloc(4096)
  });
  assert.deepEqual(job.presentation, {current: 0, applied: 0});
  await worker.queueOutput(job);
  const destination = {
    index: 2,
    address: mapped + ring.frameOffset(2),
    bytes: ring.FRAME_BYTES,
    sequence: 7,
    color: 1
  };
  const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
  await worker.finishOutput(job, destination, frame);
  const staged = f.read(f.control + 0x308, 48);
  assert.equal(staged.readBigUInt64LE(0), BigInt(destination.address));
  assert.equal(staged.readBigUInt64LE(8), BigInt(ring.FRAME_BYTES));
  assert.deepEqual(
    Array.from({length: 8}, (_, word) => staged.readUInt32LE(16 + word * 4)),
    [2, 1920, 1080, 1920, 1088, 1, ring.nativeChecksum(7, [2, 1920, 1080, 1920, 1088, 1]), 7]
  );
  await worker.stop();
  await worker.finalize();
});

test('automatic output queue hands the next sequence to the output worker', async () => {
  const f = fixture({autoQueue: true});
  const mapped = 0x30000000;
  const worker = await workerFor(f, {publication: {mapped, color: 1}, autoQueue: true});
  const input = pts => ({
    index: 1,
    length: 4096,
    pts,
    inputAddress: 0x72000000,
    payload: Buffer.alloc(4096)
  });
  const first = await worker.input(input(30));
  await worker.queueOutput(first);
  const second = await worker.input(input(60));
  const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
  const destination = sequence => ({
    index: sequence % 3,
    address: mapped + ring.frameOffset(sequence % 3),
    bytes: ring.FRAME_BYTES,
    sequence,
    color: 1
  });
  await worker.finishOutput(first, destination(7), frame, second);
  const handoff = f.read(f.control + 0x308, 64);
  assert.equal(handoff.readUInt32LE(48), second.sequence);
  assert.equal(handoff.readBigUInt64LE(56), 0x61110000n);
  assert.equal(worker.diagnostics.activeOutput, second.sequence);
  await worker.finishOutput(second, destination(8), frame);
  const parked = f.read(f.control + 0x308, 64);
  assert.equal(parked.readUInt32LE(48), 0);
  assert.equal(parked.readBigUInt64LE(56), 0x61010000n);
  assert.equal(worker.diagnostics.activeOutput, undefined);
  assert.equal(
    f.calls.filter(call => call.combined && call.args?.[0] === f.control + 0x40).length,
    1
  );
  await worker.stop();
  await worker.finalize();
});

test('short receive cannot open the decode gate', async () => {
  const f = fixture({receiveBytes: 2048});
  const worker = await workerFor(f);
  const job = await worker.stageInput({
    index: 1,
    length: 4096,
    receiveLength: 2048,
    pts: 30,
    inputAddress: 0x72000000,
    payload: Buffer.alloc(4096)
  });
  const inputJob = f.read(f.control + 0x140, 16);
  assert.equal(inputJob.readUInt32LE(8), 4096);
  assert.equal(inputJob.readUInt32LE(12), 2048);
  await assert.rejects(
    worker.completeInput(job, Buffer.alloc(2048)),
    /Native TCP receive returned 2048\/4096/
  );
  assert.equal(f.transport.sent[0].length, 2048);
  assert.equal(worker.diagnostics.decodeGateSignals, 0);
  assert.equal(
    f.calls.filter(
      call =>
        call.address === SDK + sync.signalLightEvent.offset && call.args?.[0] === f.control + 0x20
    ).length,
    0
  );
  await worker.stop();
  await worker.finalize();
});

test('invalid acquire cannot open the fetch gate', async () => {
  const f = fixture({outputIndex: -1});
  const worker = await workerFor(f);
  const job = await worker.input({
    index: 1,
    length: 4096,
    pts: 30,
    inputAddress: 0x72000000,
    payload: Buffer.alloc(4096)
  });
  await worker.queueOutput(job);
  await assert.rejects(
    worker.finishOutput(job, {address: 0x73000000, bytes: 0x400000}),
    /acquire returned/
  );
  assert.equal(
    f.calls.filter(
      call =>
        call.address === SDK + sync.signalLightEvent.offset && call.args?.[0] === f.control + 0x60
    ).length,
    0
  );
  await worker.stop();
  await worker.finalize();
});
