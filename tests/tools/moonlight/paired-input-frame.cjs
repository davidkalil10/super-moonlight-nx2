const {build} = require('../../../hbl-platform/smilebasic/engine/shared/frames.js');
const {CODE} = require('../../../hbl-platform/sdk/native/thread.js');

const MAX_ACCESS_UNIT = 0x100000;
const MSG_WAITALL = 0x40;
const MAX_FRAME_BYTES = 0x300000;

function validatePair(inputs) {
  if (
    !Array.isArray(inputs) ||
    inputs.length !== 2 ||
    inputs.some(
      item =>
        !item ||
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        !Number.isSafeInteger(item.address) ||
        item.address <= 0 ||
        !Number.isInteger(item.capacity) ||
        item.capacity < 1 ||
        !Number.isInteger(item.length) ||
        item.length < 1 ||
        item.length > Math.min(item.capacity, MAX_ACCESS_UNIT) ||
        typeof item.pts !== 'bigint' ||
        item.pts < 0n
    ) ||
    inputs[0].index === inputs[1].index ||
    inputs[1].pts <= inputs[0].pts
  )
    throw Error('Paired input needs two distinct bounded ordered decoder slots');
}

function receivePlan({sdk, recv, fd, inputs, base}) {
  validatePair(inputs);
  if (!Number.isInteger(fd) || fd < 0 || !Number.isSafeInteger(recv) || recv <= 0)
    throw Error('Paired input needs a qualified TCP receive function');
  const calls = inputs.map(item => ({
    function: recv,
    args: [fd, item.address, item.length, MSG_WAITALL]
  }));
  const program = build(base, sdk, calls, CODE, false, new Set([recv]));
  if (program.frame.length > MAX_FRAME_BYTES)
    throw Error('Paired input receive frame exceeds its worker allocation');
  return {program, expectedCounts: inputs.map(item => item.length)};
}

function submitPlan({sdk, functions, decoder, inputs, receivedCounts, base}) {
  validatePair(inputs);
  if (
    !Array.isArray(receivedCounts) ||
    receivedCounts.length !== 2 ||
    receivedCounts.some((count, index) => count !== inputs[index].length)
  )
    throw Error('Paired input receive count differs; decode gate remains closed');
  const calls = inputs.map(item => ({
    function: functions.sendInput,
    args: [decoder, item.index, 0, item.length, item.pts, 0]
  }));
  const program = build(base, sdk, calls, CODE, false, new Set([functions.sendInput]));
  if (program.frame.length > MAX_FRAME_BYTES)
    throw Error('Paired input submit frame exceeds its worker allocation');
  return {program};
}

module.exports = {receivePlan, submitPlan, validatePair};
