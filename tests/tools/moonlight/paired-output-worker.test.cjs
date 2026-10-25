const test = require('node:test');
const assert = require('node:assert/strict');
const {CODE} = require('../../../hbl-platform/sdk/native/thread.cjs');
const SYNC = require('../../../hbl-platform/sdk/native/os-sync-functions.json');
const ring = require('../../../hbl-moonlight/tools/moonlight/ring.cjs');
const {create} = require('./paired-output-worker.cjs');

const SDK = 0x40000000;
const EVENT = 0x71000100;
const DECODER = 0x70000000;
const FUNCTIONS = {
  acquireOutput: 0x50000000,
  bufferSetData: 0x50000004,
  getOutput: 0x50000008,
  releaseOutput: 0x5000000c
};

function fixture() {
  const regions = [];
  const calls = [];
  let allocated = 0;
  let workerBase = 0;
  let control = 0;
  let plan = null;
  let signals = 0;
  let done = false;
  let presentation = null;
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
  const result = (logical, value) => {
    const native = plan.program.proof.logicalResultIndices[logical];
    const address = workerBase + 0x10000 + plan.program.proof.resultOffsets[native];
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(value));
    write(address, bytes);
  };
  const rpc = {
    a: {sdk: SDK},
    output: 0x20000000,
    async request() {
      return {verified: true};
    },
    async call(offset, args) {
      const base = 0x60000000 + allocated++ * 0x1000000;
      regions.push({base, data: Buffer.alloc(args[2])});
      if (args[2] === 0x400000) workerBase = base;
      else control = base;
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
      if (address === SDK + SYNC.signalEvent.offset) {
        signals++;
        result((signals - 1) * 2, 0);
        result((signals - 1) * 2 + 1, 0x100e);
        if (signals === 2) done = true;
      }
      if (address === SDK + CODE.tryWait.offset) return {result: done ? 1n : 0n};
      return {result: 0n};
    },
    read: async (address, length) => {
      if (address === 0x72000000 + ring.CONTROL.current && length === 24) {
        const state = Buffer.alloc(24);
        state.writeUInt32LE(presentation.index, 0);
        state.writeUInt32LE(presentation.sequence, 20);
        return state;
      }
      if (address >= workerBase + 0x10000 && length === 56) {
        const results = Buffer.alloc(56);
        results.writeBigUInt64LE(BigInt(0x72000000 + ring.CONTROL.nativeIndex), 5 * 8);
        results.writeBigUInt64LE(BigInt(0x72000000 + ring.CONTROL.nativeSequence), 6 * 8);
        return results;
      }
      return read(address, length);
    },
    write: async (address, bytes) => write(address, bytes)
  };
  return {
    rpc,
    calls,
    get control() {
      return control;
    },
    setPlan(value) {
      plan = value;
    },
    present(index, sequence) {
      presentation = {index, sequence};
    },
    completeAcquire(firstPts = 1) {
      for (let index = 0; index < 2; index++) {
        result(index * 2, 0);
        result(index * 2 + 1, 0);
        const slot = Buffer.alloc(32);
        slot.writeInt32LE(index, 0);
        slot.writeBigUInt64LE(BigInt(firstPts + index), 8);
        write(control + 0x100 + index * 0x40, slot);
      }
      done = true;
    }
  };
}

test('paired output stop wakes both event waits and joins without fetching', async () => {
  const f = fixture();
  const worker = await create({
    rpc: f.rpc,
    functions: FUNCTIONS,
    decoder: DECODER,
    output: DECODER + 0x300,
    format: DECODER + 0x180,
    event: EVENT,
    publication: {mapped: 0x72000000, color: 1}
  });
  f.setPlan(await worker.startAcquire());
  await worker.stop();
  assert.equal(worker.diagnostics.retained, false);
  assert.equal(worker.diagnostics.active, null);
  assert.equal(f.calls.filter(call => call.address === SDK + SYNC.signalEvent.offset).length, 2);
  assert.equal(f.calls.filter(call => call.address === SDK + CODE.join.offset).length, 1);
  assert.equal(f.calls.filter(call => call.address === FUNCTIONS.getOutput).length, 0);
});

test('paired output worker reuses its acquisition gate after two published frames', async () => {
  const f = fixture();
  const worker = await create({
    rpc: f.rpc,
    functions: FUNCTIONS,
    decoder: DECODER,
    output: DECODER + 0x300,
    format: DECODER + 0x180,
    event: EVENT,
    publication: {mapped: 0x72000000, color: 1}
  });
  const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
  for (let pair = 0; pair < 2; pair++) {
    const plan = await worker.startAcquire();
    f.setPlan(plan);
    f.completeAcquire(pair * 2 + 1);
    await worker.finishAcquire(plan, [BigInt(pair * 2 + 1), BigInt(pair * 2 + 2)]);
    await assert.rejects(worker.startAcquire(), /unavailable/);
    const destinations = [0, 1].map(index => ({
      index: index + 1,
      address: 0x72000000 + ring.frameOffset(index + 1),
      bytes: ring.FRAME_BYTES,
      color: 1,
      sequence: pair * 2 + index + 1
    }));
    for (let index = 0; index < 2; index++) {
      f.present(destinations[index].index, destinations[index].sequence);
      await worker.fetch(index, destinations, frame);
    }
  }
  await worker.stop();
  assert.equal(f.calls.filter(call => call.address === SDK + CODE.join.offset).length, 6);
  assert.equal(worker.diagnostics.retained, false);
});

test('paired output rejects a wrong second PTS before any output fetch', async () => {
  const f = fixture();
  const worker = await create({
    rpc: f.rpc,
    functions: FUNCTIONS,
    decoder: DECODER,
    output: DECODER + 0x300,
    format: DECODER + 0x180,
    event: EVENT,
    publication: {mapped: 0x72000000, color: 1}
  });
  const plan = await worker.startAcquire();
  f.setPlan(plan);
  f.completeAcquire();
  await assert.rejects(worker.finishAcquire(plan, [1n, 3n]), /PTS differs/);
  assert.equal(f.calls.filter(call => call.address === FUNCTIONS.releaseOutput).length, 2);
  assert.equal(f.calls.filter(call => call.address === FUNCTIONS.getOutput).length, 0);
  assert.equal(worker.diagnostics.retained, false);
  await worker.stop();
});
