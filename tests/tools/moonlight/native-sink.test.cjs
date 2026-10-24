const test = require('node:test');
const assert = require('node:assert/strict');
const ring = require('../../apps/moonlight/ring.cjs');
const {create} = require('./native-sink.cjs');

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
    'nativeColor'
  ];
  const gpuLines = new Set(gpu.map(name => Math.floor(ring.CONTROL[name] / 128)));
  for (const name of host) assert.equal(gpuLines.has(Math.floor(ring.CONTROL[name] / 128)), false);
});

function fixture() {
  const memory = Buffer.alloc(ring.CONTROL_BYTES);
  const writes = [];
  const storage = {mapped: 0x1000000, bytes: ring.MEMORY_BYTES, memoryFlags: 7};
  memory.writeUInt32LE(ring.NATIVE_ABI, ring.CONTROL.nativeReady);
  const rpc = {
    async read(address, length) {
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
  return {rpc, storage, memory, writes};
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
