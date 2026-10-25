const {build} = require('../../../hbl-platform/smilebasic/engine/shared/frames.cjs');
const {CODE, IPC_COPY} = require('../../../hbl-platform/sdk/native/thread.cjs');
const ring = require('./ring.cjs');

const MAX_FRAME_BYTES = 0x300000;

function metadata(destination, frame) {
  if (
    !destination ||
    ![0, 1, 2].includes(destination.index) ||
    !Number.isSafeInteger(destination.address) ||
    destination.address <= 0 ||
    !Number.isInteger(destination.bytes) ||
    destination.bytes < ring.FRAME_BYTES ||
    !Number.isInteger(destination.sequence) ||
    destination.sequence < 1 ||
    destination.sequence > 0xffffffff ||
    ![1, 2].includes(destination.color) ||
    !frame ||
    !Number.isInteger(frame.width) ||
    frame.width < 2 ||
    frame.width > 1920 ||
    !Number.isInteger(frame.height) ||
    frame.height < 2 ||
    frame.height > 1088 ||
    !Number.isInteger(frame.stride) ||
    frame.stride < frame.width ||
    !Number.isInteger(frame.sliceHeight) ||
    frame.sliceHeight < frame.height ||
    (frame.stride * frame.sliceHeight * 3) / 2 > destination.bytes
  )
    throw Error('Invalid paired output surface or frame layout');
  const fields = [
    destination.index,
    frame.width,
    frame.height,
    frame.stride,
    frame.sliceHeight,
    destination.color
  ];
  const value = Buffer.alloc(32);
  fields.forEach((word, index) => value.writeUInt32LE(word, index * 4));
  value.writeUInt32LE(ring.nativeChecksum(destination.sequence, fields), 24);
  value.writeUInt32LE(destination.sequence, 28);
  return value;
}

function plan({
  sdk,
  functions,
  decoder,
  output,
  format,
  publication,
  acquired,
  acquiredSlots,
  metadataSlots,
  destinations,
  frame,
  base,
  index
}) {
  const validAcquired =
    Array.isArray(acquired) &&
    acquired.length === 2 &&
    acquired.every(
      item =>
        item &&
        item.status === 0 &&
        Number.isInteger(item.index) &&
        item.index >= 0 &&
        typeof item.pts === 'bigint' &&
        item.pts > 0n
    ) &&
    acquired[1].pts > acquired[0].pts;
  if (
    !Number.isSafeInteger(publication?.mapped) ||
    publication.mapped <= 0 ||
    !validAcquired ||
    !Array.isArray(acquiredSlots) ||
    acquiredSlots.length !== 2 ||
    !Array.isArray(metadataSlots) ||
    metadataSlots.length !== 2 ||
    !Array.isArray(destinations) ||
    destinations.length !== 2 ||
    destinations[0].index === destinations[1].index ||
    destinations[1].sequence !== destinations[0].sequence + 1 ||
    ![0, 1].includes(index)
  )
    throw Error('Paired output needs two checked acquisitions and distinct ordered surfaces');
  const metadataBytes = destinations.map(destination => metadata(destination, frame));
  const calls = [];
  const rows = [];
  {
    const destination = destinations[index];
    if (destination.color !== publication.color) throw Error('Paired output color differs');
    if (destination.address !== publication.mapped + ring.frameOffset(destination.index))
      throw Error('Paired output destination differs from the native ring surface');
    const row = {index};
    row.set =
      calls.push({
        function: functions.bufferSetData,
        args: [output, destination.address, destination.bytes, 0]
      }) - 1;
    row.fetch =
      calls.push({
        function: functions.getOutput,
        args: [decoder, {u32: acquiredSlots[index]}, output, format]
      }) - 1;
    row.release =
      calls.push({
        function: functions.releaseOutput,
        args: [decoder, {u32: acquiredSlots[index]}, 0, 0]
      }) - 1;
    row.metadata =
      calls.push({
        function: sdk + IPC_COPY.offset,
        args: [publication.mapped + ring.CONTROL.nativeIndex, metadataSlots[index], 28, 0]
      }) - 1;
    row.commit =
      calls.push({
        function: sdk + IPC_COPY.offset,
        args: [publication.mapped + ring.CONTROL.nativeSequence, metadataSlots[index] + 28, 4, 0]
      }) - 1;
    rows.push(row);
  }
  const program = build(base, sdk, calls, CODE, false, new Set(Object.values(functions)));
  if (program.frame.length > MAX_FRAME_BYTES)
    throw Error('Paired output frame exceeds its worker allocation');
  return {program, rows, metadataBytes};
}

module.exports = {plan, metadata};
