/**
 * Input worker frames for the staggered lag-2 path: receive N, wait on the decode gate, open
 * the fetch gate, wait for N-1's acquire ack, then SendInput N (Invariants 5-7).
 */
import {build, CALL4_X19} from '../../../../../hbl-platform/smilebasic/engine/shared/frames.js';
import {CODE, IPC_COPY} from '../../../../../hbl-platform/sdk/native/thread.js';
import SYNC from '../../../../../hbl-platform/sdk/native/os-sync-functions.json' with {type: 'json'};
import * as status from './staggered-status.js';

/** Offsets in the shared control page owned by the input worker. */
const CONTROL = {
  decodeGate: 0x00,
  ignoredFetchGate: 0x10,
  lengthGate: 0x80,
  sendDispatch: [0x40, 0x48],
  receiveDispatch: [0x50, 0x58],
  descriptors: [0x100, 0x180]
};

/** Field offsets of an input descriptor; `bytes` is its size. */
const DESCRIPTOR = {
  sequence: 0,
  length: 4,
  pts: 8,
  inputAddress: 16,
  inputIndex: 24,
  fetchGate: 32,
  bytes: 0x80
};

/** Offsets in the worker's allocation of each slot's frames, their snapshots and the exit. */
const REGIONS = {
  receive: [0x10000, 0x210000],
  receiveSnapshot: [0x80000, 0x280000],
  send: [0x110000, 0x300000],
  sendSnapshot: [0x180000, 0x380000],
  exit: 0x3f0000
};
/** Room for one frame before the next region starts. */
const MAX_FRAME_BYTES = 0x70000;
/** Access units alternate between this many descriptor and frame slots by sequence. */
const SLOTS = 2;

/** Ring offsets of the status words the input worker stamps (see staggered-status.js). */
const STAMP = {
  receiveCount: status.STATUS.receive,
  receiveSequence: status.STATUS.receive + 8,
  sendStatus: status.STATUS.input,
  nextSlotStatus: status.STATUS.input + 8,
  nextIndex: status.STATUS.input + 16,
  inputSequence: status.STATUS.input + 20,
  inputCount: status.STATUS.input + 24
};
const SEQUENCE_BYTES = 4;

/** recv() flag: block until the whole access unit has arrived. */
const MSG_WAITALL = 0x40;
const MAX_ACCESS_UNIT_BYTES = 0x100000;
/** PTS travel as u64. */
const MAX_PTS = 0xffffffffffffffffn;

/**
 * @typedef {object} AccessUnit
 * @property {number} sequence
 * @property {number} length
 * @property {bigint} pts
 */

/**
 * @typedef {object} InputSlot
 * @property {number} index Decoder input buffer index.
 * @property {number} address Address of the buffer's data.
 * @property {number} capacity
 */

/**
 * @param {number} base
 * @returns {{receive: number[], receiveSnapshot: number[], send: number[],
 *   sendSnapshot: number[], exit: number}}
 */
function locations(base) {
  return {
    receive: REGIONS.receive.map(offset => base + offset),
    receiveSnapshot: REGIONS.receiveSnapshot.map(offset => base + offset),
    send: REGIONS.send.map(offset => base + offset),
    sendSnapshot: REGIONS.sendSnapshot.map(offset => base + offset),
    exit: base + REGIONS.exit
  };
}

/**
 * @param {any} value
 * @returns {boolean} True for a positive safe integer.
 */
function isAddress(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * @param {any} length
 * @returns {boolean}
 */
function isUnitLength(length) {
  return Number.isInteger(length) && length >= 1 && length <= MAX_ACCESS_UNIT_BYTES;
}

/**
 * @param {any} pts
 * @returns {boolean} True for a bigint that fits a u64.
 */
function isPts(pts) {
  return typeof pts === 'bigint' && pts >= 0n && pts <= MAX_PTS;
}

/**
 * @param {InputSlot} input
 * @param {import('./staggered-status.js').Expected} expected
 * @param {number | null} checkedIndex
 * @returns {boolean} True unless `input` is the decoder buffer the status checked.
 */
function isUncheckedSlot(input, expected, checkedIndex) {
  if (!Number.isInteger(input?.index) || input.index < 0) return true;
  if (!isAddress(input.address)) return true;
  if (!Number.isInteger(input.capacity) || input.capacity < expected.receive.bytes) return true;
  return checkedIndex !== null && checkedIndex !== input.index;
}

/**
 * @returns {boolean} True unless `next` follows `current` with a later PTS.
 */
function isInvalidNext(current, next) {
  if (!next || next.sequence !== current.sequence + 1) return true;
  if (!isUnitLength(next.length)) return true;
  return typeof next.pts !== 'bigint' || next.pts <= current.pts || next.pts > MAX_PTS;
}

/**
 * @returns {boolean} True unless `current` is the checked access unit, `next` follows it with
 *   a later PTS (or is null, under gate on receive) and both gates are addresses.
 */
function isInvalidGate(current, next, expected, fetchGate, ignoredFetchGate) {
  if (!current || current.sequence !== expected.receive.sequence) return true;
  if (current.length !== expected.receive.bytes || current.length > MAX_ACCESS_UNIT_BYTES)
    return true;
  if (!isPts(current.pts)) return true;
  if (next !== null && isInvalidNext(current, next)) return true;
  return !isAddress(fetchGate) || !isAddress(ignoredFetchGate);
}

/**
 * @param {Buffer} descriptors
 * @param {number} slot
 * @param {AccessUnit} unit
 * @param {number} address Input buffer address, 0 while the unit has none yet.
 * @param {number} index Input buffer index.
 * @param {number} fetchGate Address of the gate the receive frame signals.
 */
function putDescriptor(descriptors, slot, unit, address, index, fetchGate) {
  const offset = slot * DESCRIPTOR.bytes;
  descriptors.writeUInt32LE(unit.sequence, offset + DESCRIPTOR.sequence);
  descriptors.writeUInt32LE(unit.length, offset + DESCRIPTOR.length);
  descriptors.writeBigUInt64LE(unit.pts, offset + DESCRIPTOR.pts);
  descriptors.writeBigUInt64LE(BigInt(address), offset + DESCRIPTOR.inputAddress);
  descriptors.writeUInt32LE(index, offset + DESCRIPTOR.inputIndex);
  descriptors.writeBigUInt64LE(BigInt(fetchGate), offset + DESCRIPTOR.fetchGate);
}

/**
 * Both input descriptors for the gate that submits `current`: its own, naming the checked
 * input slot and the fetch gate (the ignored one until an output is acquired, unless
 * `fetchCurrent` fetches the output of `current` itself), and the next unit's, which stays on
 * the ignored gate until its own gate write. A null `next` leaves the next descriptor a zero
 * placeholder for its prime.
 * @param {object} options
 * @param {import('./staggered-status.js').Snapshot} options.snapshot
 * @param {import('./staggered-status.js').Expected} options.expected
 * @param {InputSlot} options.input
 * @param {AccessUnit} options.current
 * @param {AccessUnit} options.next
 * @param {number} options.fetchGate
 * @param {number} options.ignoredFetchGate
 * @param {boolean} [options.fetchCurrent]
 * @returns {Buffer}
 */
function gateWrite({
  snapshot,
  expected,
  input,
  current,
  next,
  fetchGate,
  ignoredFetchGate,
  fetchCurrent = false
}) {
  const checked = status.check(snapshot, expected);
  if (isUncheckedSlot(input, expected, checked.inputIndex))
    throw Error('Staggered input slot is not the checked decoder buffer');
  if (isInvalidGate(current, next, expected, fetchGate, ignoredFetchGate))
    throw Error('Invalid staggered current or next access unit');

  const descriptors = Buffer.alloc(SLOTS * DESCRIPTOR.bytes);
  const currentSlot = (current.sequence - 1) % SLOTS;
  const fetches = fetchCurrent || expected.acquire;
  const currentFetchGate = fetches ? fetchGate : ignoredFetchGate;
  putDescriptor(descriptors, currentSlot, current, input.address, input.index, currentFetchGate);

  const nextUnit = next ?? {sequence: 0, length: 0, pts: 0n};
  putDescriptor(descriptors, 1 - currentSlot, nextUnit, 0, 0, ignoredFetchGate);
  return descriptors;
}

/**
 * @param {AccessUnit} unit
 * @returns {boolean} True for a unit after the first with a valid length and PTS.
 */
function isPrimable(unit) {
  if (!Number.isInteger(unit?.sequence) || unit.sequence < 2) return false;
  return isUnitLength(unit.length) && isPts(unit.pts);
}

/**
 * The descriptor that primes access unit `unit` under gate on receive, written over its slot
 * once the unit two before it is submitted.
 * @param {AccessUnit} unit
 * @param {number} ignoredFetchGate
 * @returns {{offset: number, bytes: Buffer}}
 */
function primeWrite(unit, ignoredFetchGate) {
  if (!isPrimable(unit) || !isAddress(ignoredFetchGate))
    throw Error('Invalid staggered primed access unit');

  const bytes = Buffer.alloc(DESCRIPTOR.bytes);
  putDescriptor(bytes, 0, unit, 0, 0, ignoredFetchGate);
  return {offset: CONTROL.descriptors[(unit.sequence - 1) % SLOTS], bytes};
}

/**
 * Builds one frame and points each listed native result at its ring status word.
 * @param {number} address
 * @param {number} sdk
 * @param {any[]} calls
 * @param {Set<number>} verified
 * @param {number} mapped
 * @param {Record<number, number>} results Logical call index to ring offset.
 */
function buildFrame(address, sdk, calls, verified, mapped, results) {
  const built = build(address, sdk, calls, CODE, false, verified);

  for (const [logical, destination] of Object.entries(results)) {
    const native = built.proof.logicalResultIndices[Number(logical)];
    built.frame.writeBigUInt64LE(
      BigInt(mapped + destination),
      built.proof.stackOffsets[native] + CALL4_X19
    );
  }

  if (built.frame.length > MAX_FRAME_BYTES) throw Error('Staggered input frame exceeds its region');
  return built;
}

/** Native results each send frame stamps: SendInput and the next AcquireInput status. */
const SEND_RESULTS = {1: STAMP.sendStatus, 2: STAMP.nextSlotStatus};

/**
 * Address helpers for one plan: the worker's regions, control page and ring words, and the
 * sdk entry points every frame calls.
 * @param {{sdk: number, base: number, control: number, mapped: number}} options
 */
function addressing({sdk, base, control, mapped}) {
  return {
    loc: locations(base),
    at: offset => control + offset,
    ringAt: offset => mapped + offset,
    copy: sdk + IPC_COPY.offset,
    jump: sdk + CODE.longjmp.offset,
    sync: name => sdk + SYNC[name].offset
  };
}

/**
 * The receive frame of `slot`: wait on the length gate if there is one, read the unit, stamp
 * its sequence, park on the decode gate, open the descriptor's fetch gate, wait for the
 * acquisition acknowledgement, then jump to the send frame.
 * @param {ReturnType<typeof addressing>} a
 * @param {number} slot
 * @param {{scratch: number, fd: number, recvFunction: number, acquireAck: number,
 *   lengthGate: number | null}} options
 */
function receiveCalls(
  {at, ringAt, copy, jump, sync},
  slot,
  {scratch, fd, recvFunction, acquireAck, lengthGate}
) {
  const descriptor = at(CONTROL.descriptors[slot]);
  const lengthWait = [];
  if (lengthGate !== null)
    lengthWait.push({function: sync('waitLightEvent'), args: [lengthGate, 0, 0, 0]});

  return [
    ...lengthWait,
    {
      function: recvFunction,
      args: [fd, scratch, {u32: descriptor + DESCRIPTOR.length}, MSG_WAITALL]
    },
    {
      function: copy,
      args: [ringAt(STAMP.receiveSequence), descriptor + DESCRIPTOR.sequence, SEQUENCE_BYTES, 0]
    },
    {function: sync('waitLightEvent'), args: [at(CONTROL.decodeGate), 0, 0, 0]},
    {
      function: sync('signalLightEvent'),
      args: [{u64: descriptor + DESCRIPTOR.fetchGate}, 0, 0, 0]
    },
    {function: sync('waitLightEvent'), args: [acquireAck, 0, 0, 0]},
    {function: jump, args: [{u64: at(CONTROL.sendDispatch[slot])}, 1, 0, 0]}
  ];
}

/**
 * The copies that restore both frames of `slot` from their snapshots. The send frame's own
 * length is 0 until sizedFrame() knows it.
 * @param {ReturnType<typeof addressing>} a
 * @param {number} slot
 * @param {number} receiveBytes
 */
function restoreCalls({loc, copy}, slot, receiveBytes) {
  return [
    {
      function: copy,
      args: [loc.receive[slot], loc.receiveSnapshot[slot], receiveBytes, 0]
    },
    {
      function: copy,
      args: [loc.send[slot], loc.sendSnapshot[slot], 0, 0]
    }
  ];
}

/**
 * The send frame of `slot`: copy the unit into its input buffer, submit it, acquire the next
 * input buffer, stamp the sequence, restore, jump to the receive frame.
 * @param {ReturnType<typeof addressing>} a
 * @param {number} slot
 * @param {{scratch: number, functions: Record<string, number>, decoder: number}} options
 * @param {ReturnType<typeof restoreCalls>} restore
 */
function sendCalls({at, ringAt, copy, jump}, slot, {scratch, functions, decoder}, restore) {
  const descriptor = at(CONTROL.descriptors[slot]);
  return [
    {
      function: copy,
      args: [
        {u64: descriptor + DESCRIPTOR.inputAddress},
        scratch,
        {u32: descriptor + DESCRIPTOR.length},
        0
      ]
    },
    {
      function: functions.sendInput,
      args: [
        decoder,
        {u32: descriptor + DESCRIPTOR.inputIndex},
        0,
        {u32: descriptor + DESCRIPTOR.length},
        {u64: descriptor + DESCRIPTOR.pts},
        0
      ]
    },
    {
      function: functions.acquireInput,
      args: [decoder, ringAt(STAMP.nextIndex), ringAt(STAMP.inputCount), 0]
    },
    {
      function: copy,
      args: [ringAt(STAMP.inputSequence), descriptor + DESCRIPTOR.sequence, SEQUENCE_BYTES, 0]
    },
    ...restore,
    {function: jump, args: [{u64: at(CONTROL.receiveDispatch[slot])}, 1, 0, 0]}
  ];
}

/**
 * Builds a frame that restores itself: a first build gives its length, which goes into its
 * own restore copy before the final build.
 * @param {(address: number, calls: any[], results: Record<number, number>) =>
 *   ReturnType<typeof buildFrame>} frame
 * @param {number} address
 * @param {any[]} calls
 * @param {ReturnType<typeof restoreCalls>} restore
 * @param {Record<number, number>} results
 * @returns {ReturnType<typeof buildFrame>}
 */
function sizedFrame(frame, address, calls, restore, results) {
  restore[1].args[2] = frame(address, calls, results).frame.length;
  return frame(address, calls, results);
}

/**
 * @param {number[]} addresses
 * @param {number | null} lengthGate
 * @param {number} fd
 * @param {Record<string, number>} functions
 * @returns {boolean} True when every address, the length gate if any, fd and the decoder
 *   functions are valid.
 */
function isPlannable(addresses, lengthGate, fd, functions) {
  if (!addresses.every(isAddress)) return false;
  if (lengthGate !== null && !isAddress(lengthGate)) return false;
  if (!Number.isInteger(fd) || fd < 0) return false;
  return ['sendInput', 'acquireInput'].every(name => isAddress(functions?.[name]));
}

/**
 * Plans both slots' receive and send frames.
 * @param {object} options
 * @param {number} options.sdk
 * @param {number} options.base The worker's allocation.
 * @param {number} options.control The shared control page.
 * @param {number} options.mapped The mapped ring, where status words are stamped.
 * @param {number} options.scratch Receive buffer of the largest access unit.
 * @param {number} options.fd Console socket the access units arrive on.
 * @param {number} options.recvFunction
 * @param {Record<string, number>} options.functions Movie decoder function addresses.
 * @param {number} options.decoder
 * @param {number} options.acquireAck The output worker's acquisition acknowledgement event.
 * @param {number | null} [options.lengthGate] The event each receive waits on first, under gate
 *   on receive.
 */
function plan({
  sdk,
  base,
  control,
  mapped,
  scratch,
  fd,
  recvFunction,
  functions,
  decoder,
  acquireAck,
  lengthGate = null
}) {
  const addresses = [sdk, base, control, mapped, scratch, recvFunction, decoder, acquireAck];
  if (!isPlannable(addresses, lengthGate, fd, functions))
    throw Error('Invalid staggered input frame addresses');

  const a = addressing({sdk, base, control, mapped});
  const verified = new Set([recvFunction, functions.sendInput, functions.acquireInput]);
  const frame = (address, calls, results = {}) =>
    buildFrame(address, sdk, calls, verified, mapped, results);
  const units = {scratch, fd, recvFunction, functions, decoder, acquireAck, lengthGate};
  /** The recv call's logical index: after the length-gate wait when there is one. */
  const recvCall = lengthGate === null ? 0 : 1;

  const receive = [];
  const send = [];
  const calls = {receive: [], send: []};
  for (let slot = 0; slot < SLOTS; slot++) {
    const list = receiveCalls(a, slot, units);
    receive.push(frame(a.loc.receive[slot], list, {[recvCall]: STAMP.receiveCount}));
    calls.receive.push(list);
  }

  for (let slot = 0; slot < SLOTS; slot++) {
    const restore = restoreCalls(a, slot, receive[slot].frame.length);
    const list = sendCalls(a, slot, units, restore);
    send.push(sizedFrame(frame, a.loc.send[slot], list, restore, SEND_RESULTS));
    calls.send.push(list);
  }

  return {control: CONTROL, descriptor: DESCRIPTOR, locations: a.loc, receive, send, calls};
}

export {CONTROL, DESCRIPTOR, locations, gateWrite, primeWrite, plan};
