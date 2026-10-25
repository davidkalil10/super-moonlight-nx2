const test = require('node:test');
const assert = require('node:assert/strict');
const {CODE} = require('../../sdk/native/thread.cjs');
const SYNC = require('../../sdk/native/os-sync-functions.json');
const ring = require('./ring.cjs');
const {CONTROL} = require('./paired-loop-plan.cjs');
const {create} = require('./paired-loop-worker.cjs');

const SDK = 0x40000000;
const MAPPED = 0x72000000;
const FUNCTIONS = {
  acquireOutput: 0x50000000,
  bufferSetData: 0x50000004,
  getOutput: 0x50000008,
  releaseOutput: 0x5000000c
};

function fixture({delayedSecondWake = false} = {}) {
  const regions = [];
  const calls = [];
  let allocations = 0;
  let control = 0;
  let presentation = null;
  let stopSignals = 0;
  const regionAt = address =>
    regions.find(region => address >= region.base && address < region.base + region.data.length);
  const write = (address, bytes) => {
    const region = regionAt(address);
    assert.ok(region, `unmapped write at ${address.toString(16)}`);
    bytes.copy(region.data, address - region.base);
  };
  const read = (address, length) => {
    const region = regionAt(address);
    assert.ok(region, `unmapped read at ${address.toString(16)}`);
    return Buffer.from(region.data.subarray(address - region.base, address - region.base + length));
  };
  const rpc = {
    a: {sdk: SDK},
    output: 0x20000000,
    async request() {
      return {verified: true};
    },
    async call(_offset, args) {
      const base = 0x60000000 + allocations++ * 0x1000000;
      regions.push({base, data: Buffer.alloc(args[2])});
      if (args[2] === 0x1000) control = base;
      const output = Buffer.alloc(8);
      output.writeBigUInt64LE(BigInt(base));
      return {result: 0n, output};
    },
    async callAddress(address, args) {
      calls.push({address, args});
      if (address === SDK + CODE.create.offset) {
        const thread = Buffer.alloc(8);
        thread.writeBigUInt64LE(0x1234n);
        write(args[0], thread);
      }
      if (address === SDK + SYNC.signalEvent.offset && delayedSecondWake) {
        stopSignals++;
        if (stopSignals === 1 || stopSignals === 3) {
          const result = Buffer.alloc(8);
          result.writeBigUInt64LE(0x100en);
          write(control + CONTROL.acquireResults + (stopSignals === 1 ? 0 : 8), result);
        }
      }
      if (address === SDK + CODE.tryWait.offset)
        return {result: !delayedSecondWake || stopSignals >= 3 ? 1n : 0n};
      return {result: 0n};
    },
    async read(address, length) {
      if (address === MAPPED + ring.CONTROL.current && length === 24) {
        const state = Buffer.alloc(24);
        state.writeUInt32LE(presentation.index, 0);
        state.writeUInt32LE(presentation.sequence, 20);
        return state;
      }
      return read(address, length);
    },
    async write(address, bytes) {
      write(address, bytes);
    },
    async writeAndCall(address, bytes, target, args) {
      write(address, bytes);
      calls.push({address: target, args, combined: true});
      return {result: 0n};
    }
  };
  return {
    rpc,
    calls,
    get control() {
      return control;
    },
    read,
    write,
    present(index, sequence) {
      presentation = {index, sequence};
    },
    acquire(sequence, pts) {
      pts.forEach((value, index) => {
        const slot = Buffer.alloc(32);
        slot.writeInt32LE(index, 0);
        slot.writeBigUInt64LE(BigInt(value), 8);
        write(control + CONTROL.acquired[index], slot);
        write(control + CONTROL.acquireResults + index * 8, Buffer.alloc(8));
      });
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32LE(sequence);
      write(control + CONTROL.acquireResults + 16, bytes);
    },
    fetched(offset, sequence) {
      const bytes = Buffer.alloc(28);
      bytes.writeUInt32LE(sequence, 24);
      write(control + offset, bytes);
    }
  };
}

async function workerFor(f) {
  return create({
    rpc: f.rpc,
    functions: FUNCTIONS,
    decoder: 0x52000000,
    output: 0x52000300,
    format: 0x52000180,
    event: 0x71000000,
    publication: {mapped: MAPPED, color: 1}
  });
}

test('paired loop stops its idle thread before finalizing light events', async () => {
  const f = fixture();
  const worker = await workerFor(f);
  await worker.start();
  await worker.stop();
  assert.equal(worker.diagnostics.joined, true);
  assert.equal(worker.diagnostics.retained, false);
  assert.equal(f.calls.filter(call => call.address === SDK + CODE.join.offset).length, 1);
  assert.equal(
    f.calls.filter(call => call.address === SDK + SYNC.finalizeLightEvent.offset).length,
    3
  );
  const exit = 0x60000000 + 0x3f0000;
  const dispatch = f.read(f.control + CONTROL.dispatch[0], 32);
  for (let index = 0; index < 4; index++)
    assert.equal(dispatch.readBigUInt64LE(index * 8), BigInt(exit));
});

test('paired loop repeats only after both checked acquisitions and publications', async () => {
  const f = fixture();
  const worker = await workerFor(f);
  await worker.start();
  const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
  for (let pair = 0; pair < 2; pair++) {
    const sequence = pair + 1;
    await worker.beginPair(sequence);
    const destinations = [0, 1].map(index => ({
      index: index + 1,
      address: MAPPED + ring.frameOffset(index + 1),
      bytes: ring.FRAME_BYTES,
      color: 1,
      sequence: pair * 2 + index + 1
    }));
    await assert.rejects(worker.openFetch(destinations, frame), /gate is unavailable/);
    f.acquire(sequence, [pair * 2 + 1, pair * 2 + 2]);
    const acquired = await worker.acquire([
      BigInt(pair * 2 + 1),
      BigInt(pair * 2 + 2)
    ]);
    assert.deepEqual(acquired.map(item => String(item.pts)), [
      String(pair * 2 + 1),
      String(pair * 2 + 2)
    ]);
    await worker.openFetch(destinations, frame);
    const commit = f.read(f.control + CONTROL.destinations[0] + 44, 4);
    assert.equal(commit.readUInt32LE(), destinations[0].sequence);
    f.fetched(CONTROL.firstResults, sequence);
    f.present(destinations[0].index, destinations[0].sequence);
    await worker.finishFirst();
    f.fetched(CONTROL.secondResults, sequence);
    f.present(destinations[1].index, destinations[1].sequence);
    await worker.finishSecond();
  }
  await worker.stop();
  assert.equal(worker.diagnostics.retained, false);
  assert.equal(f.calls.filter(call => call.address === SDK + CODE.create.offset).length, 1);
  assert.equal(f.calls.filter(call => call.address === SDK + CODE.join.offset).length, 1);
});

test('paired loop stop releases a first held output when the second never arrived', async () => {
  const f = fixture();
  const worker = await workerFor(f);
  await worker.start();
  await worker.beginPair(1);
  const slot = Buffer.alloc(32);
  slot.writeInt32LE(4);
  slot.writeBigUInt64LE(1n, 8);
  f.write(f.control + CONTROL.acquired[0], slot);
  f.write(f.control + CONTROL.acquireResults, Buffer.alloc(8));
  await worker.stop();
  const releases = f.calls.filter(call => call.address === FUNCTIONS.releaseOutput);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].args[1], 4);
  assert.equal(worker.diagnostics.retained, false);
});

test('paired loop stop retries a coalesced second output wake', async () => {
  const f = fixture({delayedSecondWake: true});
  const worker = await workerFor(f);
  await worker.start();
  await worker.beginPair(1);
  await worker.stop();
  assert.equal(worker.diagnostics.joined, true);
  assert.equal(worker.diagnostics.retained, false);
  assert.equal(
    f.calls.filter(call => call.address === SDK + SYNC.signalEvent.offset).length,
    3
  );
});
