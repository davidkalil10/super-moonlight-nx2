const test = require('node:test');
const assert = require('node:assert/strict');
const {plan, checkedAcquisitions} = require('./paired-acquire-frame.cjs');

const options = {
  sdk: 0x10000000,
  acquireOutput: 0x20000000,
  decoder: 0x30000000,
  event: 0x40000000,
  slots: [0x41000000, 0x41000040],
  base: 0x50000000
};

function completed(planned) {
  const results = Buffer.alloc(planned.program.proof.resultOffsets.length * 8);
  const slots = Buffer.alloc(64);
  for (const row of planned.rows) {
    slots.writeInt32LE(row.index, row.index * 32);
    slots.writeBigUInt64LE(BigInt(row.index + 1), row.index * 32 + 8);
  }
  return {results, slots};
}

test('paired acquire holds both outputs for one host-side status and PTS check', () => {
  const planned = plan(options);
  assert.equal(planned.program.proof.logicalCalls, 4);
  assert.equal(planned.rows[0].wait, 0);
  assert.equal(planned.rows[0].acquire, 1);
  assert.equal(planned.rows[1].wait, 2);
  assert.equal(planned.rows[1].acquire, 3);
  const {results, slots} = completed(planned);
  assert.deepEqual(checkedAcquisitions(planned, results, slots, [1n, 2n]), [
    {status: 0, index: 0, pts: 1n},
    {status: 0, index: 1, pts: 2n}
  ]);
});

test('failed or reordered paired acquire cannot open the fetch stage', () => {
  const planned = plan(options);
  const {results, slots} = completed(planned);
  const second = planned.program.proof.logicalResultIndices[planned.rows[1].acquire];
  results.writeBigUInt64LE(0x100en, second * 8);
  assert.throws(
    () => checkedAcquisitions(planned, results, slots, [1n, 2n]),
    /acquire failed or PTS differs/
  );
  results.writeBigUInt64LE(0n, second * 8);
  slots.writeBigUInt64LE(3n, 32 + 8);
  assert.throws(
    () => checkedAcquisitions(planned, results, slots, [1n, 2n]),
    /acquire failed or PTS differs/
  );
});
