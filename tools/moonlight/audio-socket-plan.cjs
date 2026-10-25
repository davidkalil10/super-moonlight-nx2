const {build, SENTINEL} = require('../../../hbl-platform/smilebasic/engine/shared/frames.cjs');
const repeating = require('../../../hbl-platform/sdk/native/repeating.cjs');
const {CODE} = require('../../../hbl-platform/sdk/native/thread.cjs');
const SYNC = require('../../../hbl-platform/sdk/native/os-sync-functions.json');

const MSG_WAITALL = 0x40;
const MAX_PCM_BYTES = 0x4000;

function validate(options) {
  const {fd, audio, event, recv, append, getReleased, slots, bufferBytes} = options;
  if (
    !Number.isInteger(fd) ||
    fd < 0 ||
    !Number.isSafeInteger(audio) ||
    audio <= 0 ||
    !Number.isSafeInteger(event) ||
    event <= 0 ||
    !Number.isSafeInteger(recv) ||
    recv <= 0 ||
    !Number.isSafeInteger(append) ||
    append <= 0 ||
    !Number.isSafeInteger(getReleased) ||
    getReleased <= 0 ||
    !Number.isInteger(bufferBytes) ||
    bufferBytes < 4 ||
    bufferBytes > MAX_PCM_BYTES ||
    bufferBytes % 4 ||
    !Array.isArray(slots) ||
    slots.length !== 2 ||
    slots.some(
      slot =>
        !slot ||
        !Number.isSafeInteger(slot.data) ||
        slot.data <= 0 ||
        !Number.isSafeInteger(slot.descriptor) ||
        slot.descriptor <= 0
    ) ||
    slots[0].data === slots[1].data ||
    slots[0].descriptor === slots[1].descriptor
  )
    throw Error('Socket audio needs two distinct bounded AudioOut slots');
}

function primeReceive({sdk, base, ...options}) {
  validate(options);
  const {fd, recv, slots, bufferBytes} = options;
  const calls = slots.map(slot => ({
    function: recv,
    args: [fd, slot.data, bufferBytes, MSG_WAITALL]
  }));
  return build(base, sdk, calls, CODE, false, new Set([recv]));
}

function checkedPrimeCounts(program, results, bufferBytes) {
  if (!Buffer.isBuffer(results) || results.length !== program.proof.resultOffsets.length * 8)
    throw Error('Invalid socket audio prime results');
  return program.proof.logicalResultIndices.map((nativeIndex, index) => {
    const value = results.readBigUInt64LE(nativeIndex * 8);
    const count = Number(BigInt.asIntN(64, value));
    if (value === SENTINEL || count !== bufferBytes)
      throw Error(`Socket audio prime receive ${index} was short; append gate remains closed`);
    return count;
  });
}

function primeAppend({sdk, base, receivedCounts, ...options}) {
  validate(options);
  const {audio, append, slots, bufferBytes} = options;
  if (
    !Array.isArray(receivedCounts) ||
    receivedCounts.length !== 2 ||
    receivedCounts.some(count => count !== bufferBytes)
  )
    throw Error('Socket audio prime receive was short; append gate remains closed');
  const calls = slots.map(slot => ({
    function: append,
    args: [audio, slot.descriptor, 0, 0]
  }));
  return build(base, sdk, calls, CODE, false, new Set([append]));
}

function cycle({sdk, base, ...options}) {
  validate(options);
  const {fd, audio, event, recv, append, getReleased, slots, bufferBytes} = options;
  const calls = [];
  const rows = [];
  for (const [index, slot] of slots.entries()) {
    const row = {index};
    row.wait =
      calls.push({function: sdk + SYNC.waitSystemEvent.offset, args: [event, 0, 0, 0]}) - 1;
    row.released = calls.push({function: getReleased, args: [audio, 0, 0, 0]}) - 1;
    row.receive = calls.push({function: recv, args: [fd, slot.data, bufferBytes, MSG_WAITALL]}) - 1;
    row.append = calls.push({function: append, args: [audio, slot.descriptor, 0, 0]}) - 1;
    rows.push(row);
  }
  const verified = new Set([recv, append, getReleased]);
  const program = repeating.frame({base, sdk, calls, code: CODE, verified});
  return {program, rows, calls, verified};
}

function checkedCycle(results, rows, slots, bufferBytes) {
  if (!Array.isArray(results) || results.length < 8 || !Array.isArray(rows) || rows.length !== 2)
    throw Error('Invalid socket audio recycle results');
  for (const row of rows) {
    if (
      typeof results[row.released] !== 'bigint' ||
      typeof results[row.receive] !== 'bigint' ||
      typeof results[row.append] !== 'bigint' ||
      results[row.released] !== BigInt(slots[row.index].descriptor) ||
      Number(BigInt.asIntN(64, results[row.receive])) !== bufferBytes ||
      results[row.append] !== 1n
    )
      throw Error(`Socket audio recycle ${row.index} returned an invalid descriptor or count`);
  }
}

module.exports = {primeReceive, checkedPrimeCounts, primeAppend, cycle, checkedCycle};
