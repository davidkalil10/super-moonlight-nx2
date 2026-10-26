/**
 * Frames of the paired loop, the one long-lived console thread that acquires, fetches and
 * publishes decoder outputs two at a time (or one, for an odd tail).
 *
 * Each pass parks in the gate frame on the start gate, then jumps through the dispatch words:
 * the acquire frame waits on the decoder output event and acquires each output, stamps the job
 * sequence and parks on the fetch gate; the first frame fetches, releases and publishes output
 * 0, stamps the job and parks on the second gate; the second frame does the same for output 1,
 * restores every frame of the pass from its snapshot and jumps back to the gate. The single
 * frames do one output in the same shape, and the host picks a pair or a single pass by
 * rewriting the first two dispatch words. Stopping points every dispatch word at the exit
 * frame, a longjmp context into thread exit.
 *
 * The host reads each stage's native results and job stamp from the control page; a stage's
 * results are only meaningful once its stamp matches the job the host wrote.
 */
import {build} from '../../../hbl-platform/smilebasic/engine/shared/frames.js';
import {
  CALL4_X19,
  CONTEXT_X30,
  CONTEXT_SP
} from '../../../hbl-platform/smilebasic/engine/shared/gadgets.js';
import {CODE, IPC_COPY} from '../../../hbl-platform/sdk/native/thread.js';
import SYNC from '../../../hbl-platform/sdk/native/os-sync-functions.json' with {type: 'json'};
import * as ring from './ring.js';

/**
 * Offsets in the control page: the start, fetch and second light events, the job sequence,
 * the two acquired output slots (see SLOT), the two output descriptors (see DESCRIPTOR), the
 * acquire, first and second results (see ACQUIRE_RESULTS and FETCH_RESULTS) and the dispatch
 * words the gate, acquire, first and second frames jump through, in that order.
 */
const CONTROL = {
  startGate: 0x00,
  fetchGate: 0x10,
  secondGate: 0x20,
  job: 0x100,
  acquired: [0x140, 0x180],
  destinations: [0x200, 0x240],
  acquireResults: 0x300,
  firstResults: 0x330,
  secondResults: 0x360,
  dispatch: [0x400, 0x408, 0x410, 0x418]
};

/** An acquired output slot: AcquireOutputBufferIndex's index, PTS, flags and count. */
const SLOT = {
  index: 0,
  pts: 8,
  flags: 16,
  count: 20,
  bytes: 32
};

/**
 * An output descriptor the host writes before opening the fetch gate: the ring surface's
 * address and size, then the publication metadata of paired-output-frame.js, whose sequence
 * word is `commit`.
 */
const DESCRIPTOR = {
  address: 0,
  bytes: 8,
  metadata: 16,
  commit: 44,
  size: 48
};

/** The acquire stage's results: each AcquireOutputBufferIndex status, then the job stamp. */
const ACQUIRE_RESULTS = {
  status: [0, 8],
  sequence: 16
};

/** A fetch stage's results: SetData, GetOutputBuffer and ReleaseOutputBuffer, then the job. */
const FETCH_RESULTS = {
  set: 0,
  get: 8,
  release: 16,
  sequence: 24
};

/** Offsets in the worker's allocation of each frame, its snapshot and the exit context. */
const REGIONS = {
  gate: 0x10000,
  gateSnapshot: 0x80000,
  singleAcquire: 0x9a000,
  acquire: 0x110000,
  acquireSnapshot: 0x180000,
  singleAcquireSnapshot: 0x1a0000,
  first: 0x210000,
  firstSnapshot: 0x280000,
  singleFirst: 0x2a0000,
  second: 0x300000,
  secondSnapshot: 0x380000,
  singleFirstSnapshot: 0x3a0000,
  exit: 0x3f0000
};
/** Room for one frame before the next region starts. */
const MAX_FRAME_BYTES = 0x70000;
/** The exit frame is a longjmp context into thread exit, on its own stack. */
const EXIT_CONTEXT_BYTES = 0xb0;
const EXIT_STACK_OFFSET = 0x370000;

const SEQUENCE_BYTES = 4;
/** The metadata the shader reads from ring.CONTROL.nativeIndex through nativeCommit. */
const PUBLISHED_BYTES = ring.CONTROL.nativeCommit + SEQUENCE_BYTES - ring.CONTROL.nativeIndex;
/** longjmp's return value; any nonzero value resumes the target frame. */
const JUMP_VALUE = 1;

/**
 * @param {number} base The worker's allocation.
 * @returns {Record<keyof typeof REGIONS, number>}
 */
function locations(base) {
  return /** @type {any} */ (
    Object.fromEntries(Object.entries(REGIONS).map(([name, offset]) => [name, base + offset]))
  );
}

/**
 * Logical call index to control offset for a fetch stage's three native results.
 * @param {number} results
 * @returns {Record<number, number>}
 */
function fetchResults(results) {
  return {
    0: results + FETCH_RESULTS.set,
    1: results + FETCH_RESULTS.get,
    2: results + FETCH_RESULTS.release
  };
}

/**
 * The longjmp context that enters thread exit.
 * @param {number} sdk
 * @param {number} base
 * @returns {Buffer}
 */
function exitContext(sdk, base) {
  const stop = Buffer.alloc(EXIT_CONTEXT_BYTES);
  stop.writeBigUInt64LE(BigInt(sdk + CODE.exit.offset), CONTEXT_X30);
  stop.writeBigUInt64LE(BigInt(base + EXIT_STACK_OFFSET), CONTEXT_SP);
  return stop;
}

/**
 * Plans every frame of the loop.
 * @param {object} options
 * @param {number} options.sdk
 * @param {number} options.base The worker's allocation.
 * @param {number} options.control The control page.
 * @param {number} options.event The decoder output event.
 * @param {Record<string, number>} options.functions Movie decoder function addresses.
 * @param {number} options.decoder
 * @param {number} options.output The movie Buffer GetOutputBuffer fills.
 * @param {number} options.format The MediaData GetOutputBuffer fills.
 * @param {{mapped: number}} options.publication
 */
function plan({sdk, base, control, event, functions, decoder, output, format, publication}) {
  if (
    !Number.isSafeInteger(sdk) ||
    !Number.isSafeInteger(base) ||
    !Number.isSafeInteger(control) ||
    !Number.isSafeInteger(event) ||
    !Number.isSafeInteger(decoder) ||
    !Number.isSafeInteger(output) ||
    !Number.isSafeInteger(format) ||
    !Number.isSafeInteger(publication?.mapped) ||
    [sdk, base, control, event, decoder, output, format, publication.mapped].some(
      value => value <= 0
    ) ||
    ['acquireOutput', 'bufferSetData', 'getOutput', 'releaseOutput'].some(
      name => !Number.isSafeInteger(functions?.[name]) || functions[name] <= 0
    )
  )
    throw Error('Invalid paired loop addresses');
  const at = offset => control + offset;
  const loc = locations(base);
  const copy = sdk + IPC_COPY.offset;
  const jump = sdk + CODE.longjmp.offset;
  const sync = name => sdk + SYNC[name].offset;
  const verified = new Set(Object.values(functions));

  const frame = (address, calls, results = {}) => {
    const built = build(address, sdk, calls, CODE, false, verified);
    for (const [logical, destination] of Object.entries(results)) {
      const native = built.proof.logicalResultIndices[Number(logical)];
      built.frame.writeBigUInt64LE(
        BigInt(at(destination)),
        built.proof.stackOffsets[native] + CALL4_X19
      );
    }
    if (built.frame.length > MAX_FRAME_BYTES) throw Error('Paired loop frame exceeds its region');
    return built;
  };
  const restoringFrame = (address, calls, results) => {
    const draft = frame(address, calls, results);
    calls[calls.length - 2].args[2] = draft.frame.length;
    return frame(address, calls, results);
  };

  const waitGate = gate => ({function: sync('waitLightEvent'), args: [at(gate), 0, 0, 0]});
  const jumpThrough = dispatch => ({
    function: jump,
    args: [{u64: at(CONTROL.dispatch[dispatch])}, JUMP_VALUE, 0, 0]
  });
  const waitOutput = () => ({function: sync('waitEvent'), args: [event, 0, 0, 0]});
  const acquireInto = slot => ({
    function: functions.acquireOutput,
    args: [
      decoder,
      at(slot + SLOT.index),
      at(slot + SLOT.pts),
      at(slot + SLOT.flags),
      at(slot + SLOT.count)
    ]
  });
  const stampJob = results => ({
    function: copy,
    args: [at(results), at(CONTROL.job), SEQUENCE_BYTES, 0]
  });
  const restoreCalls = restores =>
    restores.map(([destination, source, bytes]) => ({
      function: copy,
      args: [destination, source, bytes, 0]
    }));
  const fetchCalls = (index, results) => {
    const descriptor = CONTROL.destinations[index];
    const slot = CONTROL.acquired[index];
    return [
      {
        function: functions.bufferSetData,
        args: [
          output,
          {u64: at(descriptor + DESCRIPTOR.address)},
          {u64: at(descriptor + DESCRIPTOR.bytes)},
          0
        ]
      },
      {
        function: functions.getOutput,
        args: [decoder, {u32: at(slot + SLOT.index)}, output, format]
      },
      {function: functions.releaseOutput, args: [decoder, {u32: at(slot + SLOT.index)}, 0, 0]},
      {
        function: copy,
        args: [
          publication.mapped + ring.CONTROL.nativeIndex,
          at(descriptor + DESCRIPTOR.metadata),
          PUBLISHED_BYTES,
          0
        ]
      },
      {
        function: copy,
        args: [
          publication.mapped + ring.CONTROL.nativeSequence,
          at(descriptor + DESCRIPTOR.commit),
          SEQUENCE_BYTES,
          0
        ]
      },
      stampJob(results + FETCH_RESULTS.sequence)
    ];
  };

  const gateCalls = [waitGate(CONTROL.startGate), jumpThrough(0)];
  const gate = frame(loc.gate, gateCalls);

  const acquireCalls = [];
  for (const slot of CONTROL.acquired) {
    acquireCalls.push(waitOutput());
    acquireCalls.push(acquireInto(slot));
  }
  acquireCalls.push(stampJob(CONTROL.acquireResults + ACQUIRE_RESULTS.sequence));
  acquireCalls.push(waitGate(CONTROL.fetchGate));
  acquireCalls.push(jumpThrough(1));
  const acquire = frame(loc.acquire, acquireCalls, {
    1: CONTROL.acquireResults + ACQUIRE_RESULTS.status[0],
    3: CONTROL.acquireResults + ACQUIRE_RESULTS.status[1]
  });

  const singleAcquireCalls = [
    waitOutput(),
    acquireInto(CONTROL.acquired[0]),
    stampJob(CONTROL.acquireResults + ACQUIRE_RESULTS.sequence),
    waitGate(CONTROL.fetchGate),
    jumpThrough(1)
  ];
  const singleAcquire = frame(loc.singleAcquire, singleAcquireCalls, {
    1: CONTROL.acquireResults + ACQUIRE_RESULTS.status[0]
  });

  const firstCalls = [
    ...fetchCalls(0, CONTROL.firstResults),
    waitGate(CONTROL.secondGate),
    jumpThrough(2)
  ];
  const first = frame(loc.first, firstCalls, fetchResults(CONTROL.firstResults));

  const secondCalls = [
    ...fetchCalls(1, CONTROL.secondResults),
    ...restoreCalls([
      [loc.gate, loc.gateSnapshot, gate.frame.length],
      [loc.acquire, loc.acquireSnapshot, acquire.frame.length],
      [loc.first, loc.firstSnapshot, first.frame.length],
      [loc.second, loc.secondSnapshot, 0]
    ]),
    jumpThrough(3)
  ];
  const second = restoringFrame(loc.second, secondCalls, fetchResults(CONTROL.secondResults));

  const singleFirstCalls = [
    ...fetchCalls(0, CONTROL.firstResults),
    ...restoreCalls([
      [loc.gate, loc.gateSnapshot, gate.frame.length],
      [loc.singleAcquire, loc.singleAcquireSnapshot, singleAcquire.frame.length],
      [loc.singleFirst, loc.singleFirstSnapshot, 0]
    ]),
    jumpThrough(3)
  ];
  const singleFirst = restoringFrame(
    loc.singleFirst,
    singleFirstCalls,
    fetchResults(CONTROL.firstResults)
  );

  if (
    loc.singleAcquire + singleAcquire.frame.length > loc.acquire ||
    loc.singleAcquireSnapshot + singleAcquire.frame.length > loc.first ||
    loc.singleFirst + singleFirst.frame.length > loc.second ||
    loc.singleFirstSnapshot + singleFirst.frame.length > loc.exit
  )
    throw Error('Paired single-output frame exceeds its reserved region');
  return {
    control: CONTROL,
    locations: loc,
    gate,
    acquire,
    singleAcquire,
    first,
    second,
    singleFirst,
    stop: exitContext(sdk, base),
    calls: {
      gate: gateCalls,
      acquire: acquireCalls,
      singleAcquire: singleAcquireCalls,
      first: firstCalls,
      second: secondCalls,
      singleFirst: singleFirstCalls
    }
  };
}

export {CONTROL, SLOT, DESCRIPTOR, ACQUIRE_RESULTS, FETCH_RESULTS, locations, plan};
