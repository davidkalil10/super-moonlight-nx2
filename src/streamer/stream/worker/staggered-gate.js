/**
 * The host's checked gate write: one exchange opens decode of unit N and names the next two
 * outputs, N-2 (or a placeholder) and N-1 at lag 2, N and N+1 at lag 0.
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
 * decode is `lag` units in, the unit itself with lag 0.
 * @param {number} auSequence
 * @param {number} lag
 * @returns {number}
 */
function lagged(auSequence, lag) {
  return auSequence <= lag ? 1 : auSequence - lag;
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
 * matches what the host expects, including an acquired output exactly `lag` units back
 * (OUTPUT_LAG, or 1 to fetch each output one gate after its decode opened). Lag 0 names the
 * unit's own output, behind an acquired and fetched N-1.
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
  frame,
  lag = OUTPUT_LAG
}) {
  if (lag !== 0 && lag !== 1 && lag !== OUTPUT_LAG)
    throw Error('Staggered output lag is 0, 1 or 2');
  const inputBytes = input.gateWrite({
    snapshot,
    expected,
    input: inputSlot,
    current,
    next,
    fetchGate,
    ignoredFetchGate,
    fetchCurrent: lag === 0
  });
  const bytes = Buffer.alloc(WRITE_BYTES);
  inputBytes.copy(bytes, 0);

  const outputSequence = lagged(current.sequence, lag);
  const acquired = lag === 0 ? current.sequence - 1 : outputSequence;
  const behind = lag === OUTPUT_LAG ? 'two AUs' : 'one AU';
  if (expected.acquire && expected.acquire.sequence !== acquired)
    throw Error(`Staggered acquire is not ${behind} behind decode`);
  if (!expected.acquire && current.sequence > Math.max(lag, 1))
    throw Error('Staggered output acquisition is missing');
  // Invariant 3.
  const fetchChecked = expected.fetch?.sequence === acquired;
  if (lag === 0 && expected.acquire && !fetchChecked)
    throw Error('Staggered fetch of the acquired output is not checked');

  const named = lag === 0 || expected.acquire;
  const first = named
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

export {WRITE_OFFSET, WRITE_BYTES, OUTPUT_LAG, gateWrite};
