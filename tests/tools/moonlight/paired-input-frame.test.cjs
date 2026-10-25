const test = require('node:test');
const assert = require('node:assert/strict');
const {receivePlan, submitPlan} = require('./paired-input-frame.cjs');

const sdk = 0x10000000;
const recv = sdk + 0x140000;
const sendInput = 0x30000000;
const decoder = 0x40000000;
const base = 0x50000000;
const inputs = [
  {index: 0, address: 0x60000000, capacity: 0x100000, length: 40529, pts: 1n},
  {index: 1, address: 0x60100000, capacity: 0x100000, length: 30272, pts: 2n}
];

test('paired input receives both bounded access units before creating a decode frame', () => {
  const receive = receivePlan({sdk, recv, fd: 11, inputs, base});
  assert.equal(receive.program.proof.logicalCalls, 2);
  assert.deepEqual(receive.expectedCounts, [40529, 30272]);
  assert.ok(receive.program.frame.length < 0x300000);
  const submit = submitPlan({
    sdk,
    functions: {sendInput},
    decoder,
    inputs,
    receivedCounts: [40529, 30272],
    base
  });
  assert.equal(submit.program.proof.logicalCalls, 2);
  assert.ok(submit.program.frame.length < 0x300000);
});

test('a short receive keeps the paired decode gate closed', () => {
  assert.throws(
    () =>
      submitPlan({
        sdk,
        functions: {sendInput},
        decoder,
        inputs,
        receivedCounts: [40529, 30271],
        base
      }),
    /decode gate remains closed/
  );
});

test('paired input rejects duplicate decoder slots and oversized access units', () => {
  assert.throws(
    () => receivePlan({sdk, recv, fd: 11, inputs: [inputs[0], {...inputs[1], index: 0}], base}),
    /distinct bounded ordered/
  );
  assert.throws(
    () =>
      receivePlan({sdk, recv, fd: 11, inputs: [inputs[0], {...inputs[1], length: 0x100001}], base}),
    /distinct bounded ordered/
  );
});
