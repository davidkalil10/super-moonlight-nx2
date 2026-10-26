/**
 * Publication metadata and the one-output fetch frame of the paired output path.
 *
 * metadata() packs the 32 bytes that tell the ring shader which native surface to show and
 * how the decoded frame is laid out in it: the surface index, the frame geometry and color
 * space, a checksum over all of them and the sequence. The paired loop, the staggered output
 * frames and the probes all publish through it.
 *
 * plan() builds a frame that copies one acquired output into its ring surface, releases it,
 * then publishes its metadata to the shader with the native sequence copied last, so the
 * shader never sees a sequence before the fields it covers.
 */
import {build} from '../../../hbl-platform/smilebasic/engine/shared/frames.js';
import {CODE, IPC_COPY} from '../../../hbl-platform/sdk/native/thread.js';
import * as ring from './ring.js';

const MAX_FRAME_BYTES = 0x300000;

/** Indices of the native ring surfaces. */
const SURFACES = [0, 1, 2];
/** Native video color spaces the ring shader can convert. */
const COLORS = [1, 2];
const MIN_DIMENSION = 2;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1088;
const MAX_SEQUENCE = 0xffffffff;

/**
 * Byte offsets of the metadata: six field words, then the checksum over the sequence and
 * those fields, then the sequence itself.
 */
const METADATA = {
  checksum: 24,
  sequence: 28,
  bytes: 32
};
const WORD_BYTES = 4;
/** The metadata the shader reads from ring.CONTROL.nativeIndex through nativeCommit. */
const PUBLISHED_BYTES = ring.CONTROL.nativeCommit + WORD_BYTES - ring.CONTROL.nativeIndex;

/**
 * @param {any} destination
 * @param {any} frame
 * @returns {boolean}
 */
function invalidLayout(destination, frame) {
  return (
    !destination ||
    !SURFACES.includes(destination.index) ||
    !Number.isSafeInteger(destination.address) ||
    destination.address <= 0 ||
    !Number.isInteger(destination.bytes) ||
    destination.bytes < ring.FRAME_BYTES ||
    !Number.isInteger(destination.sequence) ||
    destination.sequence < 1 ||
    destination.sequence > MAX_SEQUENCE ||
    !COLORS.includes(destination.color) ||
    !frame ||
    !Number.isInteger(frame.width) ||
    frame.width < MIN_DIMENSION ||
    frame.width > MAX_WIDTH ||
    !Number.isInteger(frame.height) ||
    frame.height < MIN_DIMENSION ||
    frame.height > MAX_HEIGHT ||
    !Number.isInteger(frame.stride) ||
    frame.stride < frame.width ||
    !Number.isInteger(frame.sliceHeight) ||
    frame.sliceHeight < frame.height ||
    (frame.stride * frame.sliceHeight * 3) / 2 > destination.bytes
  );
}

/**
 * The publication metadata that shows `frame` from ring surface `destination`.
 * @param {{index: number, address: number, bytes: number, sequence: number, color: number}}
 *   destination
 * @param {{width: number, height: number, stride: number, sliceHeight: number}} frame
 * @returns {Buffer}
 */
function metadata(destination, frame) {
  if (invalidLayout(destination, frame))
    throw Error('Invalid paired output surface or frame layout');
  const fields = [
    destination.index,
    frame.width,
    frame.height,
    frame.stride,
    frame.sliceHeight,
    destination.color
  ];
  const value = Buffer.alloc(METADATA.bytes);
  fields.forEach((word, index) => value.writeUInt32LE(word, index * WORD_BYTES));
  value.writeUInt32LE(ring.nativeChecksum(destination.sequence, fields), METADATA.checksum);
  value.writeUInt32LE(destination.sequence, METADATA.sequence);
  return value;
}

/**
 * @param {any} acquired
 * @returns {boolean}
 */
function validAcquisitions(acquired) {
  return (
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
    acquired[1].pts > acquired[0].pts
  );
}

/**
 * Plans the frame that fetches and publishes output `index` of a checked pair.
 * @param {object} options
 * @param {number} options.sdk
 * @param {Record<string, number>} options.functions Movie decoder function addresses.
 * @param {number} options.decoder
 * @param {number} options.output The movie Buffer GetOutputBuffer fills.
 * @param {number} options.format The MediaData GetOutputBuffer fills.
 * @param {{mapped: number, color: number}} options.publication
 * @param {any[]} options.acquired Both acquisitions, with ordered PTS.
 * @param {number[]} options.acquiredSlots Where each acquired output index is held.
 * @param {number[]} options.metadataSlots Where each output's metadata is held.
 * @param {any[]} options.destinations Two distinct ring surfaces with consecutive sequences.
 * @param {any} options.frame The decoded frame layout.
 * @param {number} options.base The frame's address.
 * @param {number} options.index The output to fetch, 0 or 1.
 * @returns {{program: any, rows: Array<{index: number, set: number, fetch: number,
 *   release: number, metadata: number, commit: number}>, metadataBytes: Buffer[]}}
 */
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
  if (
    !Number.isSafeInteger(publication?.mapped) ||
    publication.mapped <= 0 ||
    !validAcquisitions(acquired) ||
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
  const destination = destinations[index];
  if (destination.color !== publication.color) throw Error('Paired output color differs');
  if (destination.address !== publication.mapped + ring.frameOffset(destination.index))
    throw Error('Paired output destination differs from the native ring surface');
  const copy = sdk + IPC_COPY.offset;
  const slot = acquiredSlots[index];
  const calls = [
    {function: functions.bufferSetData, args: [output, destination.address, destination.bytes, 0]},
    {function: functions.getOutput, args: [decoder, {u32: slot}, output, format]},
    {function: functions.releaseOutput, args: [decoder, {u32: slot}, 0, 0]},
    {
      function: copy,
      args: [
        publication.mapped + ring.CONTROL.nativeIndex,
        metadataSlots[index],
        PUBLISHED_BYTES,
        0
      ]
    },
    {
      function: copy,
      args: [
        publication.mapped + ring.CONTROL.nativeSequence,
        metadataSlots[index] + METADATA.sequence,
        WORD_BYTES,
        0
      ]
    }
  ];
  const rows = [{index, set: 0, fetch: 1, release: 2, metadata: 3, commit: 4}];
  const program = build(base, sdk, calls, CODE, false, new Set(Object.values(functions)));
  if (program.frame.length > MAX_FRAME_BYTES)
    throw Error('Paired output frame exceeds its worker allocation');
  return {program, rows, metadataBytes};
}

export {plan, metadata};
