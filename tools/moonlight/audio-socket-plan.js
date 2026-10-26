/**
 * Native call plans for socket audio: PCM arrives on a console TCP socket and is received
 * straight into two AudioOut buffers, so the host never writes sample data over the bridge.
 *
 * Playback starts with a prime: one receive per slot, then, only when both receives filled a
 * whole buffer, one append per slot. After that a repeating worker recycles each slot in turn:
 * wait for the AudioOut release event, take the released buffer, receive the next chunk into
 * it and append it again. The checked* functions validate the native results so a short
 * receive never reaches AudioOut.
 */
import {build, SENTINEL} from '../../../hbl-platform/smilebasic/engine/shared/frames.js';
import * as repeating from '../../../hbl-platform/sdk/native/repeating.js';
import {CODE} from '../../../hbl-platform/sdk/native/thread.js';
import SYNC from '../../../hbl-platform/sdk/native/os-sync-functions.json' with {type: 'json'};

/** recv() flag: block until the whole buffer has arrived. */
const MSG_WAITALL = 0x40;
/** Largest PCM chunk one AudioOut slot holds. */
const MAX_PCM_BYTES = 0x4000;
/** One interleaved stereo s16 sample frame; chunks are whole frames. */
const FRAME_BYTES = 4;
const SLOT_COUNT = 2;
/** Each slot's recycle row: wait, take the released buffer, receive, append. */
const CALLS_PER_SLOT = 4;
const CYCLE_CALLS = SLOT_COUNT * CALLS_PER_SLOT;
/** Native results are 64-bit words. */
const RESULT_BYTES = 8;
/** AppendAudioOutBuffer returns true when it queued the buffer. */
const APPENDED = 1n;

/**
 * @typedef {object} Slot
 * @property {number} descriptor Address of the AudioOut buffer descriptor.
 * @property {number} data Address of the PCM data the descriptor points at.
 */

/**
 * @typedef {object} SocketAudioOptions
 * @property {number} fd Console socket descriptor carrying the PCM.
 * @property {number} audio Address of the opened AudioOut object.
 * @property {number} event Address of the AudioOut release SystemEvent.
 * @property {number} recv Address of the socket recv function.
 * @property {number} append Address of AppendAudioOutBuffer.
 * @property {number} getReleased Address of GetReleasedAudioOutBuffer.
 * @property {Slot[]} slots Exactly two distinct slots.
 * @property {number} bufferBytes Bytes per chunk, a whole number of frames.
 */

/**
 * @typedef {object} PlanAddresses
 * @property {number} sdk SDK image address.
 * @property {number} base Page-aligned address the worker frame is written to.
 */

/**
 * @typedef {object} CycleRow
 * @property {number} index The slot this row recycles.
 * @property {number} wait Call index of the release event wait.
 * @property {number} released Call index of GetReleasedAudioOutBuffer.
 * @property {number} receive Call index of the recv.
 * @property {number} append Call index of AppendAudioOutBuffer.
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isAddress(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0;
}

/**
 * @param {Slot} slot
 * @returns {boolean}
 */
function isSlot(slot) {
  return Boolean(slot) && isAddress(slot.data) && isAddress(slot.descriptor);
}

/**
 * @param {number} bufferBytes
 * @returns {boolean}
 */
function isChunkSize(bufferBytes) {
  return (
    Number.isInteger(bufferBytes) &&
    bufferBytes >= FRAME_BYTES &&
    bufferBytes <= MAX_PCM_BYTES &&
    !(bufferBytes % FRAME_BYTES)
  );
}

/**
 * @param {Slot[]} slots
 * @returns {boolean}
 */
function areDistinctSlots(slots) {
  return (
    Array.isArray(slots) &&
    slots.length === SLOT_COUNT &&
    slots.every(isSlot) &&
    slots[0].data !== slots[1].data &&
    slots[0].descriptor !== slots[1].descriptor
  );
}

/** @param {SocketAudioOptions} options */
function validate(options) {
  const {fd, audio, event, recv, append, getReleased, slots, bufferBytes} = options;
  const valid =
    Number.isInteger(fd) &&
    fd >= 0 &&
    isAddress(audio) &&
    isAddress(event) &&
    isAddress(recv) &&
    isAddress(append) &&
    isAddress(getReleased) &&
    isChunkSize(bufferBytes) &&
    areDistinctSlots(slots);
  if (!valid) throw Error('Socket audio needs two distinct bounded AudioOut slots');
}

/**
 * @param {SocketAudioOptions} options
 * @param {Slot} slot
 */
function receiveCall({fd, recv, bufferBytes}, slot) {
  return {function: recv, args: [fd, slot.data, bufferBytes, MSG_WAITALL]};
}

/**
 * @param {SocketAudioOptions} options
 * @param {Slot} slot
 */
function appendCall({audio, append}, slot) {
  return {function: append, args: [audio, slot.descriptor, 0, 0]};
}

/**
 * The prime's first frame: receive one whole chunk into each slot.
 * @param {PlanAddresses & SocketAudioOptions} options
 */
function primeReceive({sdk, base, ...options}) {
  validate(options);
  const calls = options.slots.map(slot => receiveCall(options, slot));
  return build(base, sdk, calls, CODE, false, new Set([options.recv]));
}

/**
 * Reads the prime receive counts and refuses any short or missing receive.
 * @param {{proof: {resultOffsets: number[], logicalResultIndices: number[]}}} program
 *   The primeReceive frame.
 * @param {Buffer} results Every native call's result slot.
 * @param {number} bufferBytes
 * @returns {number[]} The two byte counts, each equal to bufferBytes.
 */
function checkedPrimeCounts(program, results, bufferBytes) {
  if (
    !Buffer.isBuffer(results) ||
    results.length !== program.proof.resultOffsets.length * RESULT_BYTES
  )
    throw Error('Invalid socket audio prime results');
  return program.proof.logicalResultIndices.map((nativeIndex, index) => {
    const value = results.readBigUInt64LE(nativeIndex * RESULT_BYTES);
    const count = Number(BigInt.asIntN(64, value));
    if (value === SENTINEL || count !== bufferBytes)
      throw Error(`Socket audio prime receive ${index} was short; append gate remains closed`);
    return count;
  });
}

/**
 * The prime's second frame: append both slots, only after both receives were whole.
 * @param {PlanAddresses & SocketAudioOptions & {receivedCounts: number[]}} options
 */
function primeAppend({sdk, base, receivedCounts, ...options}) {
  validate(options);
  const {append, slots, bufferBytes} = options;
  if (
    !Array.isArray(receivedCounts) ||
    receivedCounts.length !== SLOT_COUNT ||
    receivedCounts.some(count => count !== bufferBytes)
  )
    throw Error('Socket audio prime receive was short; append gate remains closed');
  const calls = slots.map(slot => appendCall(options, slot));
  return build(base, sdk, calls, CODE, false, new Set([append]));
}

/**
 * The repeating recycle frame: per slot, wait for a release, take the released buffer,
 * receive the next chunk into it and append it.
 * @param {PlanAddresses & SocketAudioOptions} options
 * @returns {{program: ReturnType<typeof repeating.frame>, rows: CycleRow[], calls: object[],
 *   verified: Set<number>}} rows hold each slot's call indices into calls.
 */
function cycle({sdk, base, ...options}) {
  validate(options);
  const {audio, event, recv, append, getReleased, slots} = options;
  const calls = [];
  const add = call => calls.push(call) - 1;
  /** @type {CycleRow[]} */
  const rows = [];
  for (const [index, slot] of slots.entries()) {
    rows.push({
      index,
      wait: add({function: sdk + SYNC.waitSystemEvent.offset, args: [event, 0, 0, 0]}),
      released: add({function: getReleased, args: [audio, 0, 0, 0]}),
      receive: add(receiveCall(options, slot)),
      append: add(appendCall(options, slot))
    });
  }
  const verified = new Set([recv, append, getReleased]);
  const program = repeating.frame({base, sdk, calls, code: CODE, verified});
  return {program, rows, calls, verified};
}

/**
 * Checks a stopped recycle worker's last results: each slot released its own descriptor,
 * received a whole chunk and was appended again.
 * @param {bigint[]} results The cycle's result words, in call order.
 * @param {CycleRow[]} rows
 * @param {Slot[]} slots
 * @param {number} bufferBytes
 */
function checkedCycle(results, rows, slots, bufferBytes) {
  if (
    !Array.isArray(results) ||
    results.length < CYCLE_CALLS ||
    !Array.isArray(rows) ||
    rows.length !== SLOT_COUNT
  )
    throw Error('Invalid socket audio recycle results');
  for (const row of rows) {
    const released = results[row.released];
    const received = results[row.receive];
    const appended = results[row.append];
    if (
      typeof released !== 'bigint' ||
      typeof received !== 'bigint' ||
      typeof appended !== 'bigint' ||
      released !== BigInt(slots[row.index].descriptor) ||
      Number(BigInt.asIntN(64, received)) !== bufferBytes ||
      appended !== APPENDED
    )
      throw Error(`Socket audio recycle ${row.index} returned an invalid descriptor or count`);
  }
}

export {primeReceive, checkedPrimeCounts, primeAppend, cycle, checkedCycle};
