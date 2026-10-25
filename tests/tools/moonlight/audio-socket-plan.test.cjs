const test = require('node:test');
const assert = require('node:assert/strict');
const {
  primeReceive,
  checkedPrimeCounts,
  primeAppend,
  cycle,
  checkedCycle
} = require('../../../hbl-moonlight/tools/moonlight/audio-socket-plan.cjs');

const options = {
  sdk: 0x10000000,
  base: 0x50000000,
  fd: 11,
  audio: 0x30000000,
  event: 0x30000100,
  recv: 0x10020000,
  append: 0x10030000,
  getReleased: 0x10040000,
  slots: [
    {descriptor: 0x30000400, data: 0x30010000},
    {descriptor: 0x30000440, data: 0x30014000}
  ],
  bufferBytes: 3840
};

test('socket audio primes two buffers and recycles only after release events', () => {
  const received = primeReceive({...options, base: options.base + 0x10000});
  assert.equal(received.proof.logicalCalls, 2);
  const results = Buffer.alloc(received.proof.resultOffsets.length * 8);
  for (const native of received.proof.logicalResultIndices)
    results.writeBigUInt64LE(3840n, native * 8);
  const counts = checkedPrimeCounts(received, results, 3840);
  assert.deepEqual(counts, [3840, 3840]);
  const appended = primeAppend({...options, receivedCounts: counts, base: options.base + 0x10000});
  assert.equal(appended.proof.logicalCalls, 2);
  const recycled = cycle(options);
  assert.equal(recycled.program.proof.logicalCalls, 10);
  for (const row of recycled.rows) {
    assert.ok(row.wait < row.released);
    assert.ok(row.released < row.receive);
    assert.ok(row.receive < row.append);
  }
  assert.ok(recycled.rows[0].append < recycled.rows[1].wait);
  assert.ok(recycled.program.frame.length < 0x100000);
  const cycleResults = Array.from({length: recycled.calls.length}, () => 0n);
  for (const row of recycled.rows) {
    cycleResults[row.released] = BigInt(options.slots[row.index].descriptor);
    cycleResults[row.receive] = 3840n;
    cycleResults[row.append] = 1n;
  }
  assert.doesNotThrow(() => checkedCycle(cycleResults, recycled.rows, options.slots, 3840));
  cycleResults[recycled.rows[1].released] = BigInt(options.slots[0].descriptor);
  assert.throws(
    () => checkedCycle(cycleResults, recycled.rows, options.slots, 3840),
    /invalid descriptor or count/
  );
});

test('socket audio refuses overlapping descriptors and oversized PCM chunks', () => {
  assert.throws(
    () => cycle({...options, slots: [options.slots[0], options.slots[0]]}),
    /distinct bounded/
  );
  assert.throws(() => primeReceive({...options, bufferBytes: 0x4004}), /distinct bounded/);
  const received = primeReceive({...options, base: options.base + 0x10000});
  const results = Buffer.alloc(received.proof.resultOffsets.length * 8);
  results.writeBigUInt64LE(3840n, received.proof.logicalResultIndices[0] * 8);
  results.writeBigUInt64LE(3839n, received.proof.logicalResultIndices[1] * 8);
  assert.throws(() => checkedPrimeCounts(received, results, 3840), /append gate remains closed/);
  assert.throws(
    () => primeAppend({...options, receivedCounts: [3840, 3839], base: options.base + 0x10000}),
    /append gate remains closed/
  );
});
