const test = require('node:test');
const assert = require('node:assert/strict');
const {plan, summarize, pendingStep} = require('./probe-decoder-throughput.cjs');

const sdk = 0x10000000;
const fn = {
  acquireInput: 0x20000000,
  getInput: 0x20000004,
  bufferData: 0x20000008,
  sendInput: 0x2000000c,
  acquireOutput: 0x20000010,
  releaseOutput: 0x20000014
};
const sync = {
  acquireSemaphore: sdk + 0x125000,
  releaseSemaphore: sdk + 0x125100,
  waitEvent: sdk + 0x124000
};

function fixture(window, count = 6, holdOutputs = false) {
  return plan({
    sdk,
    fn,
    sync,
    tick: sdk + 0x120000,
    copy: sdk + 0x130000,
    decoder: 0x54000000,
    inputBuffer: 0x54000200,
    control: 0x52000000,
    payloads: Array.from({length: count}, (_, index) => ({
      address: 0x53000000 + index * 0x10000,
      length: 40000
    })),
    window,
    bases: {input: 0x50000000, output: 0x51000000},
    holdOutputs
  });
}

function results(program) {
  return Buffer.alloc(program.proof.resultOffsets.length * 8);
}

function put(program, bytes, call, value) {
  const native = program.proof.logicalResultIndices[call];
  bytes.writeBigUInt64LE(
    BigInt(value),
    program.proof.resultOffsets[native] - program.proof.resultOffsets[0]
  );
}

test('R3 frames fit and keep input copy behind its buffer pointer lookup', () => {
  for (const window of [2, 3]) {
    const planned = fixture(window, 120);
    assert.equal(planned.inputRows.length, 120);
    assert.equal(planned.outputRows.length, 120);
    assert.ok(planned.input.frame.length < 0x3f0000);
    assert.ok(planned.output.frame.length < 0x3f0000);
    for (const row of planned.inputRows) {
      assert.ok(row.copy > row.data);
      assert.ok(row.send > row.copy);
    }
    for (const row of planned.outputRows) {
      assert.ok(row.acquire > row.wait);
      assert.ok(row.release > row.acquire);
      assert.ok(row.credit > row.release);
    }
  }
});

test('R3 scores console output cadence and rejects reordered PTS', () => {
  const planned = fixture(3);
  const input = results(planned.input);
  const output = results(planned.output);
  const slots = Buffer.alloc(6 * 32);
  for (const row of planned.inputRows) {
    put(planned.input, input, row.data, 0x55000000);
    put(planned.input, input, row.copy, 0x55000000);
    put(
      planned.input,
      input,
      row.tick,
      row.index < 3 ? row.index * 100 : 1000 + (row.index - 3) * 100 + 50
    );
  }
  for (const row of planned.outputRows) {
    put(planned.output, output, row.tick, 1000 + row.index * 100);
    slots.writeInt32LE(row.index % 2, row.index * 32);
    slots.writeBigUInt64LE(BigInt(row.index + 1), row.index * 32 + 8);
  }
  const measured = summarize(planned, input, output, slots, 10000, 3);
  assert.equal(measured.consoleOutputFps, 100);
  assert.equal(measured.maxInFlight, 3);
  assert.equal(measured.outputPtsInOrder, true);
  assert.equal(measured.target120Met, null);
  slots.writeBigUInt64LE(99n, 3 * 32 + 8);
  assert.throws(() => summarize(planned, input, output, slots, 10000, 3), /Output PTS/);
});

test('R3 maps the window-three stalled call to the final output event wait', () => {
  const planned = fixture(3, 120);
  const output = results(planned.output);
  const wait = planned.output.proof.logicalResultIndices[planned.outputRows[119].wait];
  output.writeBigUInt64LE(0xfedcba9876543210n, wait * 8);
  assert.equal(wait, 714);
  assert.deepEqual(pendingStep(planned.output, planned.outputRows, output), {
    native: 714,
    logical: planned.outputRows[119].wait,
    au: 119,
    step: 'wait'
  });
});

test('held-output plan acquires two outputs before releasing either one', () => {
  const planned = fixture(2, 5, true);
  const rows = planned.outputRows;
  assert.ok(rows[0].acquire < rows[1].acquire);
  assert.ok(rows[1].acquire < rows[0].release);
  assert.ok(rows[0].release < rows[1].release);
  assert.ok(rows[1].credit < rows[2].wait);
  assert.ok(rows[3].acquire < rows[2].release);
  assert.ok(rows[4].release > rows[4].acquire);
});
