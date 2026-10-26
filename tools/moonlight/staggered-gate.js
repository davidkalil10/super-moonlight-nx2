/**
 * The host's checked gate write for the staggered lag-2 path. One write covers the input
 * worker's descriptors and the output worker's descriptors, which sit together in the shared
 * control block, so a single exchange both opens decode of access unit N and names the outputs
 * the output worker handles next: N-2 (acquired, or a placeholder before it exists) and N-1.
 */
import * as input from './staggered-input-plan.js';
import * as output from './staggered-output-plan.js';

/** The write starts at the first input descriptor... */
const WRITE_OFFSET = input.CONTROL.descriptors[0];
/** ...and ends after the second output descriptor. */
const WRITE_BYTES = output.CONTROL.descriptors[1] + output.DESCRIPTOR.size - WRITE_OFFSET;
/** Decode runs this many access units ahead of the output it releases. */
const OUTPUT_LAG = 2;
/** The output descriptors alternate between this many slots by sequence. */
const OUTPUT_SLOTS = 2;

/**
 * The output sequence the gate write for an access unit names first; the first one until
 * decode is OUTPUT_LAG units in.
 * @param {number} auSequence
 * @returns {number}
 */
function lagged(auSequence) {
  return auSequence <= OUTPUT_LAG ? 1 : auSequence - OUTPUT_LAG;
}

/**
 * Copies an output descriptor into the gate write at the slot its sequence selects.
 * @param {Buffer} bytes
 * @param {Buffer} descriptor
 */
function placeOutput(bytes, descriptor) {
  const auSequence = descriptor.readUInt32LE(output.DESCRIPTOR.sequence);
  const slot = (auSequence - 1) % OUTPUT_SLOTS;
  descriptor.copy(bytes, output.CONTROL.descriptors[slot] - WRITE_OFFSET);
}

/**
 * Builds the gate write for the access unit `current`. Throws unless the status snapshot
 * matches what the host expects, including an acquired output exactly OUTPUT_LAG units back.
 * @returns {{offset: number, bytes: Buffer}}
 */
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
  published,
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
  const outputSequence = lagged(current.sequence);
  if (expected.acquire && expected.acquire.sequence !== outputSequence)
    throw Error('Staggered acquire is not two AUs behind decode');
  if (!expected.acquire && current.sequence > OUTPUT_LAG)
    throw Error('Staggered output acquisition is missing');
  const first = expected.acquire
    ? output.outputDescriptor({
        auSequence: outputSequence,
        destination,
        frame,
        publication,
        published
      })
    : output.placeholderDescriptor(outputSequence);
  const second = output.placeholderDescriptor(outputSequence + 1);
  placeOutput(bytes, first);
  placeOutput(bytes, second);
  return {offset: WRITE_OFFSET, bytes};
}

export {WRITE_OFFSET, WRITE_BYTES, gateWrite};
