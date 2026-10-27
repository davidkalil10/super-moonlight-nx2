/**
 * The publication metadata of a native ring surface.
 *
 * metadata() packs the 32 bytes that tell the ring shader which native surface to show and
 * how the decoded frame is laid out in it: the surface index, the frame geometry and color
 * space, a checksum over all of them and the sequence. The staggered output frames publish
 * through it.
 */
import * as ring from '../../tools/moonlight/ring.js';

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
    throw Error('Invalid native output surface or frame layout');
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

export {metadata};
