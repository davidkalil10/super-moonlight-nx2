/**
 * Output worker frames for the staggered lag-2 path.
 *
 * The acquire frame waits once on the auto-clear decoder output event, acquires one output,
 * stamps its status and sequence, then signals the input worker's acquisition acknowledgement
 * before it parks on the fetch gate. The acknowledgement comes only after the stamps, so the
 * input worker's next SendInput can never race the host-visible acquire status.
 *
 * The fetch frame copies the held output into the descriptor's ring surface, releases it,
 * publishes the descriptor's metadata to the shader (the native sequence last) and stamps the
 * fetch status. Like the input frames, each fetch frame restores both of its slot's frames from
 * their snapshots and jumps through a dispatch word to the other frame.
 */
import {build, CALL4_X19} from '../../../hbl-platform/smilebasic/engine/shared/frames.js';
import {CODE, IPC_COPY} from '../../../hbl-platform/sdk/native/thread.js';
import SYNC from '../../../hbl-platform/sdk/native/os-sync-functions.json' with {type: 'json'};
import {metadata} from './publication-metadata.js';
import * as status from './staggered-status.js';
import * as ring from '../../tools/moonlight/ring.js';

/** Offsets in the shared control page owned by the output worker. */
const CONTROL = {
  fetchGate: 0x20,
  fetchDispatch: [0x60, 0x68],
  acquireDispatch: [0x70, 0x78],
  descriptors: [0x200, 0x280]
};

/**
 * Field offsets of an output descriptor: the access unit sequence, the destination surface's
 * address and size, and the publication metadata the shader reads; `size` is its size.
 */
const DESCRIPTOR = {
  sequence: 0,
  address: 8,
  bytes: 16,
  metadata: 24,
  size: 0x80
};

/** Offsets in the worker's allocation of each slot's frames, their snapshots and the exit. */
const REGIONS = {
  acquire: [0x10000, 0x210000],
  acquireSnapshot: [0x80000, 0x280000],
  fetch: [0x110000, 0x300000],
  fetchSnapshot: [0x180000, 0x380000],
  exit: 0x3f0000
};
/** Room for one frame before the next region starts. */
const MAX_FRAME_BYTES = 0x70000;
/** Outputs alternate between this many descriptor and frame slots by sequence. */
const SLOTS = 2;

/**
 * Ring offsets of the status words the output worker stamps (see staggered-status.js), plus
 * AcquireOutputBufferIndex's flags and count, which only the worker uses.
 */
const STAMP = {
  acquireStatus: status.STATUS.acquire,
  outputIndex: status.STATUS.acquire + 8,
  pts: status.STATUS.acquire + 16,
  acquireSequence: status.STATUS.acquire + 24,
  flags: status.STATUS.acquire + 32,
  outputCount: status.STATUS.acquire + 36,
  setStatus: status.STATUS.fetch,
  getStatus: status.STATUS.fetch + 8,
  releaseStatus: status.STATUS.fetch + 16,
  fetchSequence: status.STATUS.fetch + 24
};
const SEQUENCE_BYTES = 4;
/** The metadata the shader reads from ring.CONTROL.nativeIndex through nativeCommit. */
const PUBLICATION_BYTES = ring.CONTROL.nativeCommit + 4 - ring.CONTROL.nativeIndex;
const MAX_SEQUENCE = 0xffffffff;

/**
 * @param {number} base
 * @returns {{acquire: number[], acquireSnapshot: number[], fetch: number[],
 *   fetchSnapshot: number[], exit: number}}
 */
function locations(base) {
  return {
    acquire: REGIONS.acquire.map(offset => base + offset),
    acquireSnapshot: REGIONS.acquireSnapshot.map(offset => base + offset),
    fetch: REGIONS.fetch.map(offset => base + offset),
    fetchSnapshot: REGIONS.fetchSnapshot.map(offset => base + offset),
    exit: base + REGIONS.exit
  };
}

/**
 * @param {number} auSequence
 * @returns {boolean}
 */
function isSequence(auSequence) {
  return Number.isInteger(auSequence) && auSequence >= 1 && auSequence <= MAX_SEQUENCE;
}

/**
 * The descriptor that fetches output `auSequence` into `destination` and publishes
 * `published`, which is the destination itself unless the output is being skipped.
 * @param {object} options
 * @param {number} options.auSequence
 * @param {any} options.destination A ring surface of the publication.
 * @param {any} options.frame The decoded frame layout.
 * @param {{mapped: number, color: number}} options.publication
 * @param {any} [options.published]
 * @returns {Buffer}
 */
function outputDescriptor({auSequence, destination, frame, publication, published = destination}) {
  const target = surface =>
    surface &&
    surface.address === publication.mapped + ring.frameOffset(surface.index) &&
    surface.color === publication.color;
  if (
    !isSequence(auSequence) ||
    !Number.isSafeInteger(publication?.mapped) ||
    !target(destination) ||
    !target(published)
  )
    throw Error('Invalid staggered output publication target');
  const bytes = Buffer.alloc(DESCRIPTOR.size);
  bytes.writeUInt32LE(auSequence, DESCRIPTOR.sequence);
  bytes.writeBigUInt64LE(BigInt(destination.address), DESCRIPTOR.address);
  bytes.writeBigUInt64LE(BigInt(destination.bytes), DESCRIPTOR.bytes);
  metadata(published, frame).copy(bytes, DESCRIPTOR.metadata);
  return bytes;
}

/**
 * A descriptor that only carries the sequence, for an output not acquired yet.
 * @param {number} auSequence
 * @returns {Buffer}
 */
function placeholderDescriptor(auSequence) {
  if (!isSequence(auSequence)) throw Error('Invalid staggered output sequence');
  const bytes = Buffer.alloc(DESCRIPTOR.size);
  bytes.writeUInt32LE(auSequence, DESCRIPTOR.sequence);
  return bytes;
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
  if (built.frame.length > MAX_FRAME_BYTES)
    throw Error('Staggered output frame exceeds its region');
  return built;
}

/** Native results each fetch frame stamps: SetData, GetOutputBuffer and Release status. */
const FETCH_RESULTS = {0: STAMP.setStatus, 1: STAMP.getStatus, 2: STAMP.releaseStatus};

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
 * The acquire frame of `slot`: wait for an output, acquire and stamp it, acknowledge the
 * acquisition, park on the fetch gate, then jump to the fetch frame.
 * @param {ReturnType<typeof addressing>} a
 * @param {number} slot
 * @param {{functions: Record<string, number>, decoder: number, event: number,
 *   acquireAck: number}} options
 */
function acquireCalls(
  {at, ringAt, copy, jump, sync},
  slot,
  {functions, decoder, event, acquireAck}
) {
  const descriptor = at(CONTROL.descriptors[slot]);
  return [
    {function: sync('waitEvent'), args: [event, 0, 0, 0]},
    {
      function: functions.acquireOutput,
      args: [
        decoder,
        ringAt(STAMP.outputIndex),
        ringAt(STAMP.pts),
        ringAt(STAMP.flags),
        ringAt(STAMP.outputCount)
      ]
    },
    {
      function: copy,
      args: [ringAt(STAMP.acquireSequence), descriptor + DESCRIPTOR.sequence, SEQUENCE_BYTES, 0]
    },
    {function: sync('signalLightEvent'), args: [acquireAck, 0, 0, 0]},
    {function: sync('waitLightEvent'), args: [at(CONTROL.fetchGate), 0, 0, 0]},
    {function: jump, args: [{u64: at(CONTROL.fetchDispatch[slot])}, 1, 0, 0]}
  ];
}

/**
 * The copies that restore both frames of `slot` from their snapshots. The fetch frame's own
 * length is 0 until sizedFrame() knows it.
 * @param {ReturnType<typeof addressing>} a
 * @param {number} slot
 * @param {number} acquireBytes
 */
function restoreCalls({loc, copy}, slot, acquireBytes) {
  return [
    {
      function: copy,
      args: [loc.acquire[slot], loc.acquireSnapshot[slot], acquireBytes, 0]
    },
    {
      function: copy,
      args: [loc.fetch[slot], loc.fetchSnapshot[slot], 0, 0]
    }
  ];
}

/**
 * The fetch frame of `slot`: copy the held output into the descriptor's surface, release it,
 * publish the metadata and then the sequence, stamp the fetch, restore, jump to the acquire
 * frame.
 * @param {ReturnType<typeof addressing>} a
 * @param {number} slot
 * @param {{functions: Record<string, number>, decoder: number, output: number,
 *   format: number}} options
 * @param {ReturnType<typeof restoreCalls>} restore
 */
function fetchCalls({at, ringAt, copy, jump}, slot, {functions, decoder, output, format}, restore) {
  const descriptor = at(CONTROL.descriptors[slot]);
  return [
    {
      function: functions.bufferSetData,
      args: [
        output,
        {u64: descriptor + DESCRIPTOR.address},
        {u64: descriptor + DESCRIPTOR.bytes},
        0
      ]
    },
    {
      function: functions.getOutput,
      args: [decoder, {u32: ringAt(STAMP.outputIndex)}, output, format]
    },
    {
      function: functions.releaseOutput,
      args: [decoder, {u32: ringAt(STAMP.outputIndex)}, 0, 0]
    },
    {
      function: copy,
      args: [
        ringAt(ring.CONTROL.nativeIndex),
        descriptor + DESCRIPTOR.metadata,
        PUBLICATION_BYTES,
        0
      ]
    },
    {
      function: copy,
      args: [
        ringAt(ring.CONTROL.nativeSequence),
        descriptor + DESCRIPTOR.metadata + PUBLICATION_BYTES,
        SEQUENCE_BYTES,
        0
      ]
    },
    {
      function: copy,
      args: [ringAt(STAMP.fetchSequence), descriptor + DESCRIPTOR.sequence, SEQUENCE_BYTES, 0]
    },
    ...restore,
    {function: jump, args: [{u64: at(CONTROL.acquireDispatch[slot])}, 1, 0, 0]}
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
 * Plans both slots' acquire and fetch frames.
 * @param {object} options
 * @param {number} options.sdk
 * @param {number} options.base The worker's allocation.
 * @param {number} options.control The shared control page.
 * @param {number} options.mapped The mapped ring.
 * @param {number} options.event The auto-clear decoder output event.
 * @param {number} options.acquireAck The acquisition acknowledgement the input worker awaits.
 * @param {Record<string, number>} options.functions Movie decoder function addresses.
 * @param {number} options.decoder
 * @param {number} options.output The movie Buffer GetOutputBuffer fills.
 * @param {number} options.format The MediaData GetOutputBuffer fills.
 */
function plan({sdk, base, control, mapped, event, acquireAck, functions, decoder, output, format}) {
  const addresses = [sdk, base, control, mapped, event, acquireAck, decoder, output, format];
  if (
    addresses.some(value => !Number.isSafeInteger(value) || value <= 0) ||
    ['acquireOutput', 'bufferSetData', 'getOutput', 'releaseOutput'].some(
      name => !Number.isSafeInteger(functions?.[name]) || functions[name] <= 0
    )
  )
    throw Error('Invalid staggered output frame addresses');
  const a = addressing({sdk, base, control, mapped});
  const verified = new Set(Object.values(functions));
  const frame = (address, calls, results = {}) =>
    buildFrame(address, sdk, calls, verified, mapped, results);
  const units = {functions, decoder, event, acquireAck, output, format};
  const acquire = [];
  const fetch = [];
  const calls = {acquire: [], fetch: []};
  for (let slot = 0; slot < SLOTS; slot++) {
    const list = acquireCalls(a, slot, units);
    acquire.push(frame(a.loc.acquire[slot], list, {1: STAMP.acquireStatus}));
    calls.acquire.push(list);
  }
  for (let slot = 0; slot < SLOTS; slot++) {
    const restore = restoreCalls(a, slot, acquire[slot].frame.length);
    const list = fetchCalls(a, slot, units, restore);
    fetch.push(sizedFrame(frame, a.loc.fetch[slot], list, restore, FETCH_RESULTS));
    calls.fetch.push(list);
  }
  return {control: CONTROL, descriptor: DESCRIPTOR, locations: a.loc, acquire, fetch, calls};
}

export {CONTROL, DESCRIPTOR, locations, outputDescriptor, placeholderDescriptor, plan};
