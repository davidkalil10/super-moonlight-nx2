const {build, SENTINEL} = require('../../../hbl-platform/smilebasic/engine/shared/frames.js');
const {CODE} = require('../../../hbl-platform/sdk/native/thread.js');
const SYNC = require('../../../hbl-platform/sdk/native/os-sync-functions.json');

function plan({sdk, acquireOutput, decoder, event, slots, base}) {
  if (
    !Number.isSafeInteger(event) ||
    event <= 0 ||
    !Array.isArray(slots) ||
    slots.length !== 2 ||
    slots.some(slot => !Number.isSafeInteger(slot) || slot <= 0 || slot % 8)
  )
    throw Error('Paired acquire needs two aligned output slots');
  const calls = [];
  const rows = [];
  for (let index = 0; index < 2; index++) {
    const slot = slots[index];
    const row = {index, slot};
    row.wait = calls.push({function: sdk + SYNC.waitEvent.offset, args: [event, 0, 0, 0]}) - 1;
    row.acquire =
      calls.push({
        function: acquireOutput,
        args: [decoder, slot, slot + 8, slot + 16, slot + 20]
      }) - 1;
    rows.push(row);
  }
  const program = build(base, sdk, calls, CODE, false, new Set([acquireOutput]));
  return {program, rows};
}

function checkedAcquisitions(planned, results, slots, expectedPts) {
  if (
    !Array.isArray(expectedPts) ||
    expectedPts.length !== 2 ||
    expectedPts.some(pts => typeof pts !== 'bigint' || pts < 0n) ||
    expectedPts[1] <= expectedPts[0] ||
    !Buffer.isBuffer(results) ||
    results.length !== planned.program.proof.resultOffsets.length * 8 ||
    !Buffer.isBuffer(slots) ||
    slots.length !== 2 * 32
  )
    throw Error('Invalid paired acquire results');
  const acquired = [];
  for (const row of planned.rows) {
    const native = planned.program.proof.logicalResultIndices[row.acquire];
    const result = results.readBigUInt64LE(native * 8);
    const status = Number(BigInt.asUintN(32, result));
    const offset = row.index * 32;
    const index = slots.readInt32LE(offset);
    const pts = slots.readBigUInt64LE(offset + 8);
    if (result === SENTINEL || status !== 0 || index < 0 || pts !== expectedPts[row.index])
      throw Error(`Paired output ${row.index} acquire failed or PTS differs`);
    acquired.push({status, index, pts});
  }
  return acquired;
}

module.exports = {plan, checkedAcquisitions};
