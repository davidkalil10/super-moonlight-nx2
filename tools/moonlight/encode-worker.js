/**
 * Worker thread for live HBV1 encoding, one frame per message. Frames are padded to whole
 * macroblock rows by repeating the last row, and the slot's buffer is transferred back.
 */
import {parentPort} from 'node:worker_threads';
import * as hbv from './hbv.js';

const MACROBLOCK_SIZE = 16;
const RGB_BYTES = 3;

/**
 * @param {Buffer} rgb
 * @param {number} width
 * @param {number} height
 * @param {number} codedHeight
 * @returns {Buffer} rgb itself when no padding is needed
 */
function padRows(rgb, width, height, codedHeight) {
  if (codedHeight === height) return rgb;
  const row = width * RGB_BYTES,
    padded = Buffer.alloc(row * codedHeight);
  rgb.copy(padded);
  for (let y = height; y < codedHeight; y++) rgb.copy(padded, y * row, (height - 1) * row);
  return padded;
}

parentPort.on('message', ({rgb, width, height, sequence}) => {
  const codedHeight = Math.ceil(height / MACROBLOCK_SIZE) * MACROBLOCK_SIZE;
  const frame = padRows(Buffer.from(rgb), width, height, codedHeight);
  const slot = hbv.encode(frame, width, codedHeight, sequence);
  parentPort.postMessage({sequence, slot: slot.buffer}, [slot.buffer]);
});
