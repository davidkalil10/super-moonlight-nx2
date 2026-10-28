/**
 * The 32-byte publication metadata that tells the ring shader which native surface to show
 * and how the frame is laid out in it. The staggered output frames publish through it.
 */
import * as ring from '../../shared/ring.js';

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
 * @param {any} value
 * @param {number} min
 * @param {number} max
 * @returns {boolean}
 */
function outsideRange(value, min, max) {
  return !Number.isInteger(value) || value < min || value > max;
}

/**
 * @param {any} destination
 * @returns {boolean}
 */
function invalidDestination(destination) {
  if (!destination) return true;
  if (!SURFACES.includes(destination.index)) return true;
  if (!Number.isSafeInteger(destination.address) || destination.address <= 0) return true;
  if (!Number.isInteger(destination.bytes) || destination.bytes < ring.FRAME_BYTES) return true;
  if (outsideRange(destination.sequence, 1, MAX_SEQUENCE)) return true;
  return !COLORS.includes(destination.color);
}

/**
 * @param {any} frame
 * @returns {boolean}
 */
function invalidFrame(frame) {
  if (!frame) return true;
  if (outsideRange(frame.width, MIN_DIMENSION, MAX_WIDTH)) return true;
  if (outsideRange(frame.height, MIN_DIMENSION, MAX_HEIGHT)) return true;
  if (!Number.isInteger(frame.stride) || frame.stride < frame.width) return true;
  return !Number.isInteger(frame.sliceHeight) || frame.sliceHeight < frame.height;
}

/**
 * @param {any} destination
 * @param {any} frame
 * @returns {boolean}
 */
function invalidLayout(destination, frame) {
  if (invalidDestination(destination) || invalidFrame(frame)) return true;
  return (frame.stride * frame.sliceHeight * 3) / 2 > destination.bytes;
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
