// Worker thread for live HBV1 encoding; one frame per message.
const {parentPort} = require('node:worker_threads');
const hbv = require('./hbv.cjs');

parentPort.on('message', ({rgb, width, height, sequence}) => {
  const slot = hbv.encode(Buffer.from(rgb), width, height, sequence);
  parentPort.postMessage({sequence, slot: slot.buffer}, [slot.buffer]);
});
