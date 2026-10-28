const test = require('node:test');
const assert = require('node:assert/strict');
const ring = require('../../../tools/moonlight/ring.js');
const {create} = require('../../../host/stream/native-sink.js');

test('host publication fields occupy different cache lines from GPU-written control', () => {
  const gpu = [
    'applied',
    'applyCount',
    'mode',
    'current',
    'size',
    'hbv1Slot',
    'nativeReady',
    'nativeApplied',
    'currentStride',
    'currentSliceHeight',
    'currentColor'
  ];
  const host = [
    'nativeSequence',
    'nativeIndex',
    'nativeWidth',
    'nativeHeight',
    'nativeStride',
    'nativeSliceHeight',
    'nativeColor',
    'nativeCommit'
  ];
  const gpuLines = new Set(gpu.map(name => Math.floor(ring.CONTROL[name] / 128)));
  for (const name of host) assert.equal(gpuLines.has(Math.floor(ring.CONTROL[name] / 128)), false);
});

function fixture() {
  const memory = Buffer.alloc(ring.CONTROL_BYTES);
  const writes = [];
  const reads = [];
  const storage = {mapped: 0x1000000, bytes: ring.MEMORY_BYTES, memoryFlags: 7};
  memory.writeUInt32LE(ring.NATIVE_ABI, ring.CONTROL.nativeReady);
  const rpc = {
    async read(address, length) {
      reads.push({address, length});
      return Buffer.from(
        memory.subarray(address - storage.mapped, address - storage.mapped + length)
      );
    },
    async query() {
      return {address: storage.mapped, size: storage.bytes, permissions: 3, ipcReferences: 0};
    },
    async write(address, bytes) {
      const offset = address - storage.mapped;
      writes.push({offset, bytes: Buffer.from(bytes)});
      bytes.copy(memory, offset);
      if (offset === ring.CONTROL.nativeSequence && bytes.readUInt32LE()) {
        memory.writeUInt32LE(memory.readUInt32LE(ring.CONTROL.nativeIndex), ring.CONTROL.current);
        memory.writeUInt32LE(bytes.readUInt32LE(), ring.CONTROL.nativeApplied);
      }
    }
  };
  return {rpc, storage, memory, writes, reads};
}

test('empty output polls keep selecting the inactive surface, and commits publish metadata first', async () => {
  const f = fixture();
  const sink = await create(f.rpc, f.storage);
  const first = await sink.destination();
  const emptyPoll = await sink.destination();
  assert.equal(first.index, 1);
  assert.deepEqual(emptyPoll, first);
  await sink.publish(first, {format: 'nv12', width: 128, height: 96, stride: 128, sliceHeight: 96});
  assert.equal(f.writes[0].offset, ring.CONTROL.nativeIndex);
  assert.equal(f.writes[1].offset, ring.CONTROL.nativeSequence);
  await sink.wait();
  assert.equal((await sink.destination()).index, 0);
  await sink.close();
  assert.equal(f.memory.readUInt32LE(ring.CONTROL.nativeSequence), 0);
});

test('old shaders and noncoherent allocations are rejected before any frame is written', async () => {
  const f = fixture();
  await assert.rejects(create(f.rpc, {...f.storage, memoryFlags: 3}), /coherent/);
  f.memory.writeUInt32LE(0, ring.CONTROL.nativeReady);
  await assert.rejects(create(f.rpc, f.storage), /Relaunch Moonlight/);
  assert.deepEqual(f.writes, []);
});

test('worker destinations avoid the displayed and unpublished surfaces', async () => {
  const f = fixture();
  const sink = await create(f.rpc, f.storage);
  const first = await sink.workerDestination({current: 0, applied: 0});
  assert.deepEqual([first.index, first.sequence], [1, 1]);
  const reads = f.reads.length;
  const second = await sink.workerDestination({current: 0, applied: 0});
  assert.deepEqual([second.index, second.sequence], [2, 2]);
  assert.equal(f.reads.length, reads);
  const third = await sink.workerDestination({current: 1, applied: 1});
  assert.deepEqual([third.index, third.sequence], [0, 3]);
  assert.equal(f.reads.length, reads);
  assert.equal(sink.workerPublication.mapped, f.storage.mapped);
  assert.equal(sink.workerPublication.color, 1);
});

test('a discard surface avoids the displayed and unpublished surfaces without reserving one', async () => {
  const f = fixture();
  const sink = await create(f.rpc, f.storage);
  await assert.rejects(sink.discardDestination({current: 0, applied: 0}), /No worker publication/);
  const first = await sink.workerDestination({current: 0, applied: 0});
  const discard = await sink.discardDestination({current: 0, applied: 0});
  assert.deepEqual([discard.index, discard.skip, discard.sequence], [2, true, undefined]);
  assert.equal(discard.address, f.storage.mapped + ring.frameOffset(2));
  const second = await sink.workerDestination({current: 0, applied: 0});
  assert.deepEqual([second.index, second.sequence], [2, first.sequence + 1]);
  assert.equal(await sink.discardDestination({current: 0, applied: 0}), null);
});

test('a torn presentation snapshot is refreshed before recycling a surface', async () => {
  const f = fixture();
  const sink = await create(f.rpc, f.storage);
  await sink.workerDestination({current: 0, applied: 0});
  await sink.workerDestination({current: 0, applied: 0});
  f.memory.writeUInt32LE(2, ring.CONTROL.current);
  f.memory.writeUInt32LE(2, ring.CONTROL.nativeApplied);
  const before = f.reads.length;
  const destination = await sink.workerDestination({current: 0, applied: 2});
  assert.equal(destination.index, 0);
  assert.ok(f.reads.length > before);
});
