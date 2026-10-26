// Worker thread for live HBV1 encoding; one frame per message.
import {parentPort} from 'node:worker_threads';
import * as hbv from './hbv.js';

function padRows(rgb, width, height, codedHeight) {
  if (codedHeight === height) return rgb;
  const row = width * 3,
    padded = Buffer.alloc(row * codedHeight);
  rgb.copy(padded);
  for (let y = height; y < codedHeight; y++) rgb.copy(padded, y * row, (height - 1) * row);
  return padded;
}

parentPort.on('message', ({rgb, width, height, sequence}) => {
  const codedHeight = Math.ceil(height / 16) * 16;
  const frame = padRows(Buffer.from(rgb), width, height, codedHeight);
  const slot = hbv.encode(frame, width, codedHeight, sequence);
  parentPort.postMessage({sequence, slot: slot.buffer}, [slot.buffer]);
});
