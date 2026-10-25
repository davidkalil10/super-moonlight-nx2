const input = require('./staggered-input-plan.cjs');
const output = require('./staggered-output-plan.cjs');

const WRITE_OFFSET = input.CONTROL.descriptors[0];
const WRITE_BYTES = output.CONTROL.descriptors[1] + output.DESCRIPTOR.size - WRITE_OFFSET;

function gateWrite({
  snapshot,
  expected,
  inputSlot,
  current,
  next,
  fetchGate,
  ignoredFetchGate,
  publication,
  destination,
  frame
}) {
  const inputBytes = input.gateWrite({
    snapshot,
    expected,
    input: inputSlot,
    current,
    next,
    fetchGate,
    ignoredFetchGate
  });
  const bytes = Buffer.alloc(WRITE_BYTES);
  inputBytes.copy(bytes, 0);
  const outputSequence = current.sequence <= 2 ? 1 : current.sequence - 2;
  if (expected.acquire && expected.acquire.sequence !== outputSequence)
    throw Error('Staggered acquire is not two AUs behind decode');
  if (!expected.acquire && current.sequence > 2)
    throw Error('Staggered output acquisition is missing');
  const first = expected.acquire
    ? output.outputDescriptor({auSequence: outputSequence, destination, frame, publication})
    : output.placeholderDescriptor(outputSequence);
  const second = output.placeholderDescriptor(outputSequence + 1);
  for (const descriptor of [first, second]) {
    const auSequence = descriptor.readUInt32LE(0);
    const slot = (auSequence - 1) % 2;
    descriptor.copy(bytes, output.CONTROL.descriptors[slot] - WRITE_OFFSET);
  }
  return {offset: WRITE_OFFSET, bytes};
}

module.exports = {WRITE_OFFSET, WRITE_BYTES, gateWrite};
