/**
 * Split decoding on two console threads: an input worker that receives and submits access
 * units, and an output worker that acquires and fetches the decoded frames.
 *
 * Each worker loops through finite frames that jump into each other with longjmp, and every
 * frame restores the others from their snapshots, since running a frame consumes it.
 *
 * - Input worker: parks on the input gate, then receives the access unit from the native TCP
 *   transport straight into the decoder's input buffer and signals RECEIVE_DONE. Once the
 *   host opens the decode gate it runs SendInput and acquires the next input slot, then
 *   signals INPUT_DONE and returns to its gate.
 * - Output worker: parks on the output gate, waits for the decoder's output event, acquires
 *   the output and signals ACQUIRED, then parks on the fetch gate. The fetch frame points the
 *   output buffer at the destination, fetches and releases the output and, with a
 *   publication, publishes its metadata to the ring shader (the sequence last).
 *
 * With autoQueue the fetch frame queues the next output itself instead of returning to its
 * gate. With linkedGates the output worker also opens the next decode gate as it fetches, so
 * the next SendInput overlaps the fetch.
 *
 * Every stage stamps its results, then the job sequence, into the control page. One status
 * scheduler reads them all in one snapshot for every pending wait. Whenever a worker may
 * still be running, or its creation is uncertain, the decoder and events are retained:
 * nothing is finalized.
 */
import {
  build,
  CALL4_X19,
  CONTEXT_X30,
  CONTEXT_SP
} from '../../../hbl-platform/smilebasic/engine/shared/frames.js';
import {allocate} from '../../../hbl-platform/sdk/native/allocate.js';
import {verify} from '../../../hbl-platform/sdk/native/symbols.js';
import {
  CODE,
  IPC_COPY,
  verifyCode,
  verifyCopy,
  verifyPreamble,
  spawn,
  wait,
  join
} from '../../../hbl-platform/sdk/native/thread.js';
import SYNC from '../../../hbl-platform/sdk/native/os-sync-functions.json' with {type: 'json'};
import MOVIE_EVENTS from '../../sdk/native/movie-event-functions.json' with {type: 'json'};
import * as ring from './ring.js';

const CONTROL_BYTES = 0x1000;
/** Light events in the control page. */
const INPUT_GATE = 0x00;
const RECEIVE_DONE = 0x10;
const DECODE_GATE = 0x20;
const INPUT_DONE = 0x30;
const OUTPUT_GATE = 0x40;
const ACQUIRED = 0x50;
const FETCH_GATE = 0x60;
const OUTPUT_DONE = 0x70;
/** The auto-clear decoder output event. */
const OUTPUT_EVENT = 0x80;
/** The client events RegisterClientEvents hands the decoder. */
const DECODER_EVENTS = 0xc0;
/** Where the client events hold the output event's address. */
const DECODER_OUTPUT_EVENT = 8;
/** Dispatch words: each worker's two gate exits, input worker first. */
const INPUT_DISPATCH = 0x100;
const DECODE_DISPATCH = 0x108;
const OUTPUT_DISPATCH = 0x110;
const FETCH_DISPATCH = 0x118;

/** The input job the host writes for each access unit. */
const INPUT_JOB = 0x140;
const INPUT_JOB_FIELDS = {
  sequence: 0,
  index: 4,
  length: 8,
  receiveLength: 12,
  pts: 16,
  inputAddress: 24,
  bytes: 32
};
/** The output job: the sequence queueOutput writes, then the destination block. */
const OUTPUT_JOB = 0x300;
const DESTINATION = OUTPUT_JOB + 8;
/**
 * Fields of the destination block openOutputFetch writes: the surface's address and size,
 * the publication metadata, and with autoQueue the next output's sequence and the frame the
 * fetch returns to; with linkedGates, the fetch frame the acquire frame jumps to.
 */
const DESTINATION_FIELDS = {
  address: 0,
  bytes: 8,
  metadata: 16,
  nextSequence: 48,
  nextDispatch: 56,
  fetchDispatch: 64
};
/** The destination block's size for each mode. */
const DESTINATION_BYTES = {plain: 16, publication: 48, autoQueue: 64, linkedGates: 72};
/** The metadata words up to the checksum are published together, the sequence after them. */
const PUBLISHED_METADATA_BYTES = 28;
const METADATA_SEQUENCE = 28;

/** Results blocks, in the order of the status snapshot. */
const RECEIVE_RESULTS = 0x180;
const INPUT_RESULTS = 0x1a0;
const OUTPUT_RESULTS = 0x1c0;
const FETCH_RESULTS = 0x1f0;
const PRESENT_RESULTS = 0x210;
/** Receive results: the received byte count and the job sequence. */
const RECEIVE_FIELDS = {count: 0, sequence: 8};
/** Input results: SendInput and AcquireInput statuses and out-parameters, the sequence. */
const INPUT_FIELDS = {sendStatus: 0, inputStatus: 8, nextIndex: 16, inputCount: 20, sequence: 24};
/** Output results: AcquireOutput's status and out-parameters, the sequence. */
const OUTPUT_FIELDS = {
  acquireStatus: 0,
  outputIndex: 8,
  pts: 16,
  flags: 24,
  count: 28,
  sequence: 32
};
/** Fetch results: one status per call, the sequence. */
const FETCH_FIELDS = {setDataStatus: 0, getStatus: 8, releaseStatus: 16, sequence: 24};
/** @type {[string, number][]} The fetch calls whose failure fails the output. */
const FETCH_STATUSES = [
  ['getOutput', FETCH_FIELDS.getStatus],
  ['releaseOutput', FETCH_FIELDS.releaseStatus]
];
/** The ring's current and native applied words, copied next to the input or output results. */
const PRESENT_FIELDS = {current: 0, applied: 4};
const WORD_BYTES = 4;
/** The end of the last results block. */
const RESULTS_END = PRESENT_RESULTS + PRESENT_FIELDS.applied + WORD_BYTES;
/** The status snapshot covers every results block. */
const STATUS_BYTES = RESULTS_END - RECEIVE_RESULTS;
/** Where each waited-on status sits in the snapshot, its sequence and the bytes handed back. */
const STATUS_FIELDS = {
  receive: {
    offset: RECEIVE_RESULTS - RECEIVE_RESULTS,
    sequence: RECEIVE_FIELDS.sequence,
    bytes: 16
  },
  input: {
    offset: INPUT_RESULTS - RECEIVE_RESULTS,
    sequence: INPUT_FIELDS.sequence,
    bytes: RESULTS_END - INPUT_RESULTS
  },
  acquire: {
    offset: OUTPUT_RESULTS - RECEIVE_RESULTS,
    sequence: OUTPUT_FIELDS.sequence,
    bytes: RESULTS_END - OUTPUT_RESULTS
  },
  fetch: {
    offset: FETCH_RESULTS - RECEIVE_RESULTS,
    sequence: FETCH_FIELDS.sequence,
    bytes: FETCH_FIELDS.sequence + WORD_BYTES
  }
};

/** Offsets in each worker's allocation of its frames, their snapshots and the exit frame. */
const REGION = {
  gate: 0x10000,
  gateSnapshot: 0x80000,
  first: 0x110000,
  firstSnapshot: 0x180000,
  second: 0x210000,
  secondSnapshot: 0x280000,
  third: 0x300000,
  thirdSnapshot: 0x380000,
  exit: 0x3f0000
};
const WORKER_BYTES = 0x400000;
const MAX_FRAME_BYTES = 0x70000;
/** The exit frame is a longjmp context into thread exit, on its own stack. */
const EXIT_CONTEXT_BYTES = 0xb0;
const EXIT_STACK_OFFSET = 0x370000;
/** Where pthread_join stores the worker's exit value; spawn stores the thread at offset 0. */
const EXIT_SLOT_OFFSET = 8;
const STOP_POLL_MS = 5;
const STATUS_POLL_MS = 2;
/** How long a decode takes, so status reads do not start before the output can exist. */
const EXPECTED_DECODE_MS = 12;

/** Reply output bytes for native calls: too few to carry an output slot, only the result. */
const SHORT = 2;
const AUTO_CLEAR = 1;
const ADDRESS_BYTES = 8;
/** recv flag that waits for the whole access unit. */
const MSG_WAITALL = 0x40;
/** Queue results that only mean no buffer is ready yet, when the index is negative. */
const EMPTY_QUEUE_RESULTS = [0x100e, 0x1011];
/** The result reported for an output that came back without an index. */
const OUTPUT_NOT_READY = 0x100e;
/** Ring colour spaces a publication may name. */
const PUBLICATION_COLORS = [1, 2];
/** Indices of the native ring surfaces. */
const SURFACES = [0, 1, 2];
const MIN_DIMENSION = 2;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1088;
const MAX_SEQUENCE = 0xffffffff;
const SYNC_FUNCTIONS = [
  'initializeLightEvent',
  'waitLightEvent',
  'signalLightEvent',
  'tryWaitLightEvent',
  'finalizeLightEvent',
  'initializeEvent',
  'waitEvent',
  'signalEvent',
  'clearEvent',
  'finalizeEvent'
];

/** @param {bigint} value */
const status = value => Number(BigInt.asUintN(32, value));

/** @typedef {import('../../../hbl-platform/sdk/native/allocate.js').Rpc} Rpc */
/** @typedef {import('../../../hbl-platform/sdk/native/allocate.js').CallReply} CallReply */
/** @typedef {import('../../../hbl-platform/sdk/native/symbols.js').LoadedModule} LoadedModule */

/**
 * The bridge client, which here must also write and call in one exchange.
 * @typedef {Rpc & {writeAndCall: (address: number, bytes: Buffer, target: number,
 *   args: number[]) => Promise<CallReply>}} SplitRpc
 */

/**
 * @typedef {object} NativeTransport
 * @property {number} fd Console socket descriptor the access units arrive on.
 * @property {number} maxAccessUnit
 * @property {number} recvFunction Address of the console recv function.
 * @property {(bytes: Buffer) => Promise<void>} send
 * @property {() => void} abort Unblocks a pending recv.
 */

/**
 * @typedef {object} Publication
 * @property {number} mapped Address of the mapped ring.
 * @property {number} color
 */

/**
 * @typedef {object} SplitWorkerOptions
 * @property {SplitRpc} rpc
 * @property {LoadedModule} module The loaded movie module.
 * @property {Record<string, number>} functions Addresses of the movie functions.
 * @property {number} decoder
 * @property {number} output The movie Buffer the output is fetched into.
 * @property {number} format The output format media object.
 * @property {NativeTransport} transport
 * @property {Publication | null} [publication] The output worker publishes to this ring.
 * @property {boolean} [autoQueue] Each fetch queues the next output itself.
 * @property {boolean} [linkedGates] Each fetch opens the next decode gate.
 * @property {boolean} [inputOnly] Start only the input worker.
 * @property {() => boolean} [cancelled]
 * @property {number} [pollTimeoutMs]
 * @property {number} [stopTimeoutMs]
 */

/**
 * @typedef {object} WorkerState
 * @property {number} base
 * @property {bigint | null} thread
 * @property {boolean} joined
 * @property {boolean} uncertain Spawning may have created a thread nobody holds.
 */

/**
 * @typedef {object} StatusWaiter
 * @property {keyof typeof STATUS_FIELDS} kind
 * @property {number} sequence
 * @property {string} label
 * @property {number} readyAt Do not read the status before this time.
 * @property {number} until
 * @property {(status: Buffer) => void} resolve
 * @property {(error: Error) => void} reject
 */

/**
 * @typedef {object} OutputDestination
 * @property {number} address
 * @property {number} bytes
 * @property {number} [index] The ring surface, with a publication.
 * @property {number} [sequence]
 * @property {number} [color]
 */

/** @typedef {{width: number, height: number, stride: number, sliceHeight: number}} Layout */

/**
 * @param {NativeTransport} transport
 * @returns {boolean}
 */
function isInvalidTransport(transport) {
  return (
    !transport ||
    !Number.isInteger(transport.fd) ||
    transport.fd < 0 ||
    !Number.isInteger(transport.maxAccessUnit) ||
    transport.maxAccessUnit < 1 ||
    !Number.isSafeInteger(transport.recvFunction) ||
    typeof transport.send !== 'function' ||
    typeof transport.abort !== 'function'
  );
}

/**
 * @param {LoadedModule} module
 * @param {{symbol: string, offset: number, size: number}} registration
 * @returns {boolean} Whether the module has RegisterClientEvents where it was inspected.
 */
function hasRegistration(module, registration) {
  return module.symbols.some(
    symbol =>
      symbol.name === registration.symbol &&
      symbol.section &&
      symbol.offset === registration.offset &&
      symbol.size === registration.size
  );
}

/**
 * Whether a published output's surface or layout does not fit `publication`'s ring.
 * @param {Publication} publication
 * @param {OutputDestination} destination
 * @param {Layout} frame
 * @returns {boolean}
 */
function invalidPublication(publication, destination, frame) {
  return (
    !frame ||
    !SURFACES.includes(destination.index) ||
    destination.address !== publication.mapped + ring.frameOffset(destination.index) ||
    destination.bytes < ring.FRAME_BYTES ||
    !Number.isInteger(destination.sequence) ||
    destination.sequence < 1 ||
    destination.sequence > MAX_SEQUENCE ||
    destination.color !== publication.color ||
    !Number.isInteger(frame.width) ||
    frame.width < MIN_DIMENSION ||
    frame.width > MAX_WIDTH ||
    !Number.isInteger(frame.height) ||
    frame.height < MIN_DIMENSION ||
    frame.height > MAX_HEIGHT ||
    !Number.isInteger(frame.stride) ||
    frame.stride < frame.width ||
    !Number.isInteger(frame.sliceHeight) ||
    frame.sliceHeight < frame.height ||
    (frame.stride * frame.sliceHeight * 3) / 2 > ring.FRAME_BYTES
  );
}

/**
 * @param {...number} addresses
 * @returns {Buffer} The addresses as consecutive 64-bit words.
 */
function addressWords(...addresses) {
  const words = Buffer.alloc(addresses.length * ADDRESS_BYTES);
  addresses.forEach((address, index) =>
    words.writeBigUInt64LE(BigInt(address), index * ADDRESS_BYTES)
  );
  return words;
}

/**
 * An error carrying the raw 32-bit result of a failed call.
 * @param {string} message
 * @param {number} value
 */
const resultError = (message, value) => Object.assign(Error(message), {result: value});

/**
 * Where a worker's frames, snapshots and exit frame sit.
 * @param {number} base The worker's allocation.
 */
function locations(base) {
  return {
    gate: base + REGION.gate,
    gateSnapshot: base + REGION.gateSnapshot,
    first: base + REGION.first,
    firstSnapshot: base + REGION.firstSnapshot,
    second: base + REGION.second,
    secondSnapshot: base + REGION.secondSnapshot,
    third: base + REGION.third,
    thirdSnapshot: base + REGION.thirdSnapshot,
    exit: base + REGION.exit
  };
}

/** @param {SplitWorkerOptions} options */
async function create({
  rpc,
  module,
  functions,
  decoder,
  output,
  format,
  transport,
  publication = null,
  autoQueue = false,
  linkedGates = false,
  inputOnly = false,
  cancelled = () => false,
  pollTimeoutMs = 5000,
  stopTimeoutMs = 5000
}) {
  if (isInvalidTransport(transport)) throw Error('Split decoder needs a native TCP transport');
  if (
    publication &&
    (!Number.isSafeInteger(publication.mapped) ||
      publication.mapped <= 0 ||
      !PUBLICATION_COLORS.includes(publication.color))
  )
    throw Error('Invalid split decoder publication target');
  if (autoQueue && !publication) throw Error('Automatic output queue needs worker publication');
  if (linkedGates && !autoQueue) throw Error('Linked gates need automatic output queue');
  if (inputOnly && (autoQueue || linkedGates))
    throw Error('Input-only split worker cannot queue output');

  const sdk = rpc.a.sdk;
  /** @type {Record<string, number>} */
  const sync = {};
  await verifyCode(rpc);
  await verifyCopy(rpc);
  await verifyPreamble(rpc);
  for (const name of SYNC_FUNCTIONS) {
    await verify(rpc, sdk + SYNC[name].offset, SYNC[name].hex);
    sync[name] = sdk + SYNC[name].offset;
  }
  const registration = MOVIE_EVENTS.registerClientEvents;
  if (!hasRegistration(module, registration))
    throw Error('The loaded movie module has no matching RegisterClientEvents');
  const registerAddress = module.base + registration.offset;
  await verify(rpc, registerAddress, registration.hex);

  const inputBase = await allocate(rpc, WORKER_BYTES, {
    failed: 'Split input worker allocation failed',
    invalid: 'Invalid split input worker allocation'
  });
  const outputBase = await allocate(rpc, WORKER_BYTES, {
    failed: 'Split output worker allocation failed',
    invalid: 'Invalid split output worker allocation'
  });
  const control = await allocate(rpc, CONTROL_BYTES, {
    failed: 'Split decoder control allocation failed',
    invalid: 'Invalid split decoder control allocation'
  });
  /** @param {number} offset */
  const address = offset => control + offset;
  const page = Buffer.alloc(CONTROL_BYTES);
  page.writeBigUInt64LE(BigInt(address(OUTPUT_EVENT)), DECODER_EVENTS + DECODER_OUTPUT_EVENT);
  await rpc.write(control, page);
  /** @type {{offset: number, finalize: number}[]} Events to finalize, in creation order. */
  const initialized = [];
  for (const offset of [
    INPUT_GATE,
    RECEIVE_DONE,
    DECODE_GATE,
    INPUT_DONE,
    OUTPUT_GATE,
    ACQUIRED,
    FETCH_GATE,
    OUTPUT_DONE
  ]) {
    await rpc.callAddress(sync.initializeLightEvent, [address(offset), 0, AUTO_CLEAR, 0], SHORT);
    initialized.push({offset, finalize: sync.finalizeLightEvent});
  }
  await rpc.callAddress(sync.initializeEvent, [address(OUTPUT_EVENT), 0, AUTO_CLEAR, 0], SHORT);
  initialized.push({offset: OUTPUT_EVENT, finalize: sync.finalizeEvent});

  /** @type {WorkerState} */
  const input = {base: inputBase, thread: null, joined: false, uncertain: false};
  /** @type {WorkerState} */
  const video = {base: outputBase, thread: null, joined: false, uncertain: false};
  let nextSequence = 0;
  /** @type {any} The input job between stageInput and its completion. */
  let activeInput = null;
  /** @type {any} The output job between queueOutput and its fetch. */
  let activeOutput = null;
  let decodeGateSignals = 0;
  /** @type {Set<StatusWaiter>} */
  const statusWaiters = new Set();
  /** @type {Promise<void> | null} */
  let statusLoop = null;
  let statusClosing = false;
  /** @type {(() => void) | null} Ends the status loop's current sleep early. */
  let wakeStatusLoop = null;
  const jump = sdk + CODE.longjmp.offset;
  const copy = sdk + IPC_COPY.offset;
  const inputAt = locations(inputBase);
  const outputAt = locations(outputBase);

  /**
   * Builds a frame and points the stores of the calls in `results` at control page offsets.
   * @param {number} base Where the frame runs.
   * @param {object[]} calls
   * @param {Record<number, number>} [results] Call index to control page offset.
   * @returns {Buffer}
   */
  const frame = (base, calls, results = {}) => {
    const program = build(base, sdk, calls, CODE, false, new Set(Object.values(functions)));
    if (program.frame.length > MAX_FRAME_BYTES)
      throw Error('Split decoder frame exceeds its region');
    for (const [call, resultOffset] of Object.entries(results)) {
      const index = program.proof.logicalResultIndices[Number(call)];
      program.frame.writeBigUInt64LE(
        BigInt(address(resultOffset)),
        program.proof.stackOffsets[index] + CALL4_X19
      );
    }
    return program.frame;
  };

  /** @param {number} offset */
  const signal = offset => ({
    function: sync.signalLightEvent,
    args: [address(offset), 0, 0, 0]
  });
  /** @param {number} offset */
  const park = offset => ({function: sync.waitLightEvent, args: [address(offset), 0, 0, 0]});
  /** @param {number} dispatch The control page word holding the next frame. */
  const jumpThrough = dispatch => ({function: jump, args: [{u64: address(dispatch)}, 1, 0, 0]});
  /**
   * @param {number} destination
   * @param {number} source
   * @param {number} bytes
   */
  const copyCall = (destination, source, bytes) => ({
    function: copy,
    args: [destination, source, bytes, 0]
  });
  /** @returns {object[]} Copies of the ring's current and applied words into PRESENT_RESULTS. */
  const presentationCopies = () => [
    copyCall(
      address(PRESENT_RESULTS + PRESENT_FIELDS.current),
      publication.mapped + ring.CONTROL.current,
      WORD_BYTES
    ),
    copyCall(
      address(PRESENT_RESULTS + PRESENT_FIELDS.applied),
      publication.mapped + ring.CONTROL.nativeApplied,
      WORD_BYTES
    )
  ];

  /** @param {Error} error */
  function rejectStatusWaiters(error) {
    for (const waiter of statusWaiters) waiter.reject(error);
    statusWaiters.clear();
  }

  /**
   * Sleeps for `delay`, or until a new waiter wakes the loop.
   * @param {number} delay
   * @returns {Promise<void>}
   */
  function waitForStatusTick(delay) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        wakeStatusLoop = null;
        resolve();
      }, delay);
      wakeStatusLoop = () => {
        clearTimeout(timer);
        wakeStatusLoop = null;
        resolve();
      };
    });
  }

  /**
   * Runs the status loop while waiters are pending: one snapshot read of every results block
   * serves all waiters that are ready, each resolved, failed or left for the next tick.
   */
  function runStatusScheduler() {
    if (statusLoop || statusClosing) return;
    statusLoop = (async () => {
      try {
        while (statusWaiters.size && !statusClosing) {
          const readyAt = Math.min(
            ...Array.from(statusWaiters, waiter => Math.min(waiter.readyAt, waiter.until))
          );
          if (readyAt > Date.now()) {
            await waitForStatusTick(readyAt - Date.now());
            continue;
          }
          const snapshot = await rpc.read(address(RECEIVE_RESULTS), STATUS_BYTES);
          const now = Date.now();
          for (const waiter of statusWaiters) {
            if (now < waiter.readyAt && now < waiter.until) continue;
            const field = STATUS_FIELDS[waiter.kind];
            const sequence = snapshot.readUInt32LE(field.offset + field.sequence);
            if (sequence === waiter.sequence) {
              statusWaiters.delete(waiter);
              waiter.resolve(snapshot.subarray(field.offset, field.offset + field.bytes));
            } else if (sequence > waiter.sequence) {
              statusWaiters.delete(waiter);
              waiter.reject(Error(`Split decoder ${waiter.label} sequence differs`));
            } else if (now >= waiter.until) {
              statusWaiters.delete(waiter);
              waiter.reject(Error(`Split decoder ${waiter.label} timed out`));
            }
          }
          if (cancelled()) rejectStatusWaiters(Error('Native decoding cancelled'));
          if (statusWaiters.size) await waitForStatusTick(STATUS_POLL_MS);
        }
      } catch (error) {
        rejectStatusWaiters(error);
      } finally {
        statusLoop = null;
        if (statusWaiters.size && !statusClosing) runStatusScheduler();
      }
    })();
  }

  /**
   * @param {keyof typeof STATUS_FIELDS} kind
   * @param {number} sequence
   * @param {string} label
   * @param {number} [readyAt]
   * @returns {Promise<Buffer>} The status block once it carries `sequence`.
   */
  function waitStatus(kind, sequence, label, readyAt = Date.now()) {
    if (statusClosing) throw Error('Split decoder status scheduler is stopped');
    return new Promise((resolve, reject) => {
      const running = Boolean(statusLoop);
      statusWaiters.add({
        kind,
        sequence,
        label,
        readyAt,
        until: Date.now() + pollTimeoutMs,
        resolve,
        reject
      });
      runStatusScheduler();
      if (running) wakeStatusLoop?.();
    });
  }

  /**
   * Writes a worker's frames, their snapshots and its exit frame, then reads the snapshots
   * back.
   * @param {WorkerState} worker
   * @param {{gate: Buffer, first: Buffer, second: Buffer, third?: Buffer | null}} frames
   */
  async function install(worker, frames) {
    const at = locations(worker.base);
    const stop = Buffer.alloc(EXIT_CONTEXT_BYTES);
    stop.writeBigUInt64LE(BigInt(sdk + CODE.exit.offset), CONTEXT_X30);
    stop.writeBigUInt64LE(BigInt(worker.base + EXIT_STACK_OFFSET), CONTEXT_SP);
    /** @type {[number, number, Buffer][]} Each frame's address, its snapshot and its bytes. */
    const slots = [
      [at.gate, at.gateSnapshot, frames.gate],
      [at.first, at.firstSnapshot, frames.first],
      [at.second, at.secondSnapshot, frames.second]
    ];
    if (frames.third) slots.push([at.third, at.thirdSnapshot, frames.third]);
    for (const [live, snapshot, bytes] of slots) {
      await rpc.write(live, bytes);
      await rpc.write(snapshot, bytes);
    }
    await rpc.write(at.exit, stop);
    for (const [, snapshot, bytes] of slots)
      if (!(await rpc.read(snapshot, bytes.length)).equals(bytes))
        throw Error('Split decoder frame snapshot readback differs');
  }

  /**
   * The input worker's frames: the gate, the receive frame and the submit frame, which
   * restores all three.
   */
  function inputFrames() {
    const gate = frame(inputAt.gate, [park(INPUT_GATE), jumpThrough(INPUT_DISPATCH)]);
    const receive = frame(
      inputAt.first,
      [
        {
          function: transport.recvFunction,
          args: [
            transport.fd,
            {u64: address(INPUT_JOB + INPUT_JOB_FIELDS.inputAddress)},
            {u32: address(INPUT_JOB + INPUT_JOB_FIELDS.receiveLength)},
            MSG_WAITALL
          ]
        },
        copyCall(
          address(RECEIVE_RESULTS + RECEIVE_FIELDS.sequence),
          address(INPUT_JOB + INPUT_JOB_FIELDS.sequence),
          WORD_BYTES
        ),
        signal(RECEIVE_DONE),
        park(DECODE_GATE),
        jumpThrough(DECODE_DISPATCH)
      ],
      {0: RECEIVE_RESULTS + RECEIVE_FIELDS.count}
    );
    const restores = [
      copyCall(inputAt.gate, inputAt.gateSnapshot, gate.length),
      copyCall(inputAt.first, inputAt.firstSnapshot, receive.length),
      copyCall(inputAt.second, inputAt.secondSnapshot, 0)
    ];
    const submitCalls = [
      {
        function: functions.sendInput,
        args: [
          decoder,
          {u32: address(INPUT_JOB + INPUT_JOB_FIELDS.index)},
          0,
          {u32: address(INPUT_JOB + INPUT_JOB_FIELDS.length)},
          {u64: address(INPUT_JOB + INPUT_JOB_FIELDS.pts)},
          0
        ]
      },
      {
        function: functions.acquireInput,
        args: [
          decoder,
          address(INPUT_RESULTS + INPUT_FIELDS.nextIndex),
          address(INPUT_RESULTS + INPUT_FIELDS.inputCount),
          0
        ]
      },
      ...(publication ? presentationCopies() : []),
      copyCall(
        address(INPUT_RESULTS + INPUT_FIELDS.sequence),
        address(INPUT_JOB + INPUT_JOB_FIELDS.sequence),
        WORD_BYTES
      ),
      ...restores,
      signal(INPUT_DONE),
      {function: jump, args: [inputAt.gate, 1, 0, 0]}
    ];
    const submitResults = {
      0: INPUT_RESULTS + INPUT_FIELDS.sendStatus,
      1: INPUT_RESULTS + INPUT_FIELDS.inputStatus
    };
    let submit = frame(inputAt.second, submitCalls, submitResults);
    restores[2].args[2] = submit.length;
    submit = frame(inputAt.second, submitCalls, submitResults);
    return {gate, first: receive, second: submit};
  }

  /**
   * The output worker's frames: the gate, the acquire frame and the fetch frame, which
   * restores them. With linkedGates, a second fetch frame that first opens the next decode
   * gate, for outputs that have a next job.
   */
  function outputFrames() {
    const gate = frame(outputAt.gate, [park(OUTPUT_GATE), jumpThrough(OUTPUT_DISPATCH)]);
    const acquire = frame(
      outputAt.first,
      [
        {function: sync.waitEvent, args: [address(OUTPUT_EVENT), 0, 0, 0]},
        {
          function: functions.acquireOutput,
          args: [
            decoder,
            address(OUTPUT_RESULTS + OUTPUT_FIELDS.outputIndex),
            address(OUTPUT_RESULTS + OUTPUT_FIELDS.pts),
            address(OUTPUT_RESULTS + OUTPUT_FIELDS.flags),
            address(OUTPUT_RESULTS + OUTPUT_FIELDS.count)
          ]
        },
        copyCall(address(OUTPUT_RESULTS + OUTPUT_FIELDS.sequence), address(OUTPUT_JOB), WORD_BYTES),
        ...(linkedGates ? presentationCopies() : []),
        signal(ACQUIRED),
        park(FETCH_GATE),
        jumpThrough(linkedGates ? DESTINATION + DESTINATION_FIELDS.fetchDispatch : FETCH_DISPATCH)
      ],
      {1: OUTPUT_RESULTS + OUTPUT_FIELDS.acquireStatus}
    );
    const restores = [
      copyCall(outputAt.gate, outputAt.gateSnapshot, gate.length),
      copyCall(outputAt.first, outputAt.firstSnapshot, acquire.length),
      copyCall(outputAt.second, outputAt.secondSnapshot, 0),
      ...(linkedGates ? [copyCall(outputAt.third, outputAt.thirdSnapshot, 0)] : [])
    ];
    const metadata = DESTINATION + DESTINATION_FIELDS.metadata;
    const fetchCalls = [
      {
        function: functions.bufferSetData,
        args: [
          output,
          {u64: address(DESTINATION + DESTINATION_FIELDS.address)},
          {u64: address(DESTINATION + DESTINATION_FIELDS.bytes)},
          0
        ]
      },
      {
        function: functions.getOutput,
        args: [decoder, {u32: address(OUTPUT_RESULTS + OUTPUT_FIELDS.outputIndex)}, output, format]
      },
      {
        function: functions.releaseOutput,
        args: [decoder, {u32: address(OUTPUT_RESULTS + OUTPUT_FIELDS.outputIndex)}, 0, 0]
      },
      ...(publication
        ? [
            copyCall(
              publication.mapped + ring.CONTROL.nativeIndex,
              address(metadata),
              PUBLISHED_METADATA_BYTES
            ),
            copyCall(
              publication.mapped + ring.CONTROL.nativeSequence,
              address(metadata + METADATA_SEQUENCE),
              WORD_BYTES
            )
          ]
        : []),
      copyCall(address(FETCH_RESULTS + FETCH_FIELDS.sequence), address(OUTPUT_JOB), WORD_BYTES),
      ...(autoQueue
        ? [
            copyCall(
              address(OUTPUT_JOB),
              address(DESTINATION + DESTINATION_FIELDS.nextSequence),
              WORD_BYTES
            )
          ]
        : []),
      ...restores,
      signal(OUTPUT_DONE),
      {
        function: jump,
        args: [
          autoQueue ? {u64: address(DESTINATION + DESTINATION_FIELDS.nextDispatch)} : outputAt.gate,
          1,
          0,
          0
        ]
      }
    ];
    const fetchResults = {
      0: FETCH_RESULTS + FETCH_FIELDS.setDataStatus,
      1: FETCH_RESULTS + FETCH_FIELDS.getStatus,
      2: FETCH_RESULTS + FETCH_FIELDS.releaseStatus
    };
    let fetch = frame(outputAt.second, fetchCalls, fetchResults);
    restores[2].args[2] = fetch.length;
    fetch = frame(outputAt.second, fetchCalls, fetchResults);

    let linkedFetch = null;
    if (linkedGates) {
      const linkedCalls = [signal(DECODE_GATE), ...fetchCalls];
      const linkedResults = {
        1: FETCH_RESULTS + FETCH_FIELDS.setDataStatus,
        2: FETCH_RESULTS + FETCH_FIELDS.getStatus,
        3: FETCH_RESULTS + FETCH_FIELDS.releaseStatus
      };
      linkedFetch = frame(outputAt.third, linkedCalls, linkedResults);
      restores[3].args[2] = linkedFetch.length;
      linkedFetch = frame(outputAt.third, linkedCalls, linkedResults);
      fetch = frame(outputAt.second, fetchCalls, fetchResults);
    }
    return {gate, first: acquire, second: fetch, third: linkedFetch};
  }

  /**
   * Waits for the output worker to acquire `job`'s output, once per job.
   * @param {any} job
   */
  async function acquiredOutput(job) {
    if (!job || activeOutput !== job || !video.thread || video.joined)
      throw Error('Split output job is not ready');
    if (job.acquired) return job.acquired;
    const acquired = await waitStatus(
      'acquire',
      job.sequence,
      'output acquire',
      (job.decodeGateAt ?? Date.now()) + EXPECTED_DECODE_MS
    );
    const acquiredStatus = status(acquired.readBigUInt64LE(OUTPUT_FIELDS.acquireStatus));
    const outputIndex = acquired.readInt32LE(OUTPUT_FIELDS.outputIndex);
    if (acquiredStatus || outputIndex < 0) {
      const value = acquiredStatus || OUTPUT_NOT_READY;
      throw resultError('Split decoder acquire returned 0x' + value.toString(16), value);
    }
    job.acquired = {
      index: outputIndex,
      pts: acquired.readBigUInt64LE(OUTPUT_FIELDS.pts),
      ...(linkedGates
        ? {
            presentation: {
              current: acquired.readUInt32LE(
                PRESENT_RESULTS + PRESENT_FIELDS.current - OUTPUT_RESULTS
              ),
              applied: acquired.readUInt32LE(
                PRESENT_RESULTS + PRESENT_FIELDS.applied - OUTPUT_RESULTS
              )
            }
          }
        : {})
    };
    return job.acquired;
  }

  /**
   * Sends the job's payload unless it went already, then waits until the console received
   * all of it. With `pairedOutput`, the read waits for that output's decode to finish too.
   * @param {any} job
   * @param {Buffer} [payload]
   * @param {any} [pairedOutput]
   */
  async function verifyReceived(job, payload = job?.payload, pairedOutput = null) {
    if (!job || activeInput !== job || !input.thread || input.joined)
      throw Error('Split input job is not ready');
    if (job.received) return job;
    if (!job.sent) {
      await transport.send(payload);
      job.sent = true;
    }
    const readyAt = pairedOutput
      ? Math.max(Date.now(), (pairedOutput.decodeGateAt ?? 0) + EXPECTED_DECODE_MS)
      : Date.now();
    if (pairedOutput && (!linkedGates || activeOutput !== pairedOutput))
      throw Error('Split receive has no paired output job');
    const received = await waitStatus('receive', job.sequence, 'TCP receive', readyAt);
    const count = received.readBigInt64LE(RECEIVE_FIELDS.count);
    const receivedSequence = received.readUInt32LE(RECEIVE_FIELDS.sequence);
    if (count !== BigInt(job.length) || receivedSequence !== job.sequence)
      throw Error(
        `Native TCP receive returned ${count}/${job.length} bytes and sequence ${receivedSequence}/${job.sequence}`
      );
    job.received = true;
    return job;
  }

  /**
   * Waits for the submit frame and returns the next input slot.
   * @param {any} job
   */
  async function finishInput(job) {
    if (!job || activeInput !== job || !input.thread || input.joined || !job.received)
      throw Error('Split input job is not ready');
    const completed = await waitStatus('input', job.sequence, 'input submit');
    if (completed.readUInt32LE(INPUT_FIELDS.sequence) !== job.sequence)
      throw Error('Split decoder submitted the wrong access unit');
    const sent = status(completed.readBigUInt64LE(INPUT_FIELDS.sendStatus));
    if (sent) throw resultError('movie::sendInput returned 0x' + sent.toString(16), sent);
    const inputStatus = status(completed.readBigUInt64LE(INPUT_FIELDS.inputStatus));
    const nextIndex = completed.readInt32LE(INPUT_FIELDS.nextIndex);
    if (inputStatus && !(nextIndex < 0 && EMPTY_QUEUE_RESULTS.includes(inputStatus)))
      throw resultError('Decoder input queue returned 0x' + inputStatus.toString(16), inputStatus);
    activeInput = null;
    return Object.assign(job, {
      input: {status: inputStatus, index: nextIndex},
      presentation: publication
        ? {
            current: completed.readUInt32LE(
              PRESENT_RESULTS + PRESENT_FIELDS.current - INPUT_RESULTS
            ),
            applied: completed.readUInt32LE(
              PRESENT_RESULTS + PRESENT_FIELDS.applied - INPUT_RESULTS
            )
          }
        : null
    });
  }

  /**
   * Waits for the job's output, writes its destination block and opens the fetch gate.
   * @param {any} job
   * @param {OutputDestination} destination
   * @param {Layout | null} frame The decoded layout, published with a publication.
   * @param {any} nextJob With autoQueue, the output the fetch frame queues next.
   */
  async function openOutputFetch(job, destination, frame, nextJob) {
    if (!job || activeOutput !== job || !video.thread || video.joined)
      throw Error('Split output job is not ready');
    if (
      !Number.isSafeInteger(destination?.address) ||
      destination.address <= 0 ||
      !Number.isSafeInteger(destination.bytes) ||
      destination.bytes <= 0
    )
      throw Error('Invalid split decoder output destination');
    if (publication && invalidPublication(publication, destination, frame))
      throw Error('Invalid split decoder publication metadata');
    if (
      nextJob &&
      (!autoQueue ||
        !Number.isInteger(nextJob.sequence) ||
        nextJob.sequence !== job.sequence + 1 ||
        nextJob.sequence > MAX_SEQUENCE ||
        (linkedGates && (!nextJob.received || activeInput !== nextJob)))
    )
      throw Error('Invalid next split output job');
    const acquired = await acquiredOutput(job);
    const block = Buffer.alloc(
      linkedGates
        ? DESTINATION_BYTES.linkedGates
        : autoQueue
          ? DESTINATION_BYTES.autoQueue
          : publication
            ? DESTINATION_BYTES.publication
            : DESTINATION_BYTES.plain
    );
    block.writeBigUInt64LE(BigInt(destination.address), DESTINATION_FIELDS.address);
    block.writeBigUInt64LE(BigInt(destination.bytes), DESTINATION_FIELDS.bytes);
    if (publication) {
      const fields = [
        destination.index,
        frame.width,
        frame.height,
        frame.stride,
        frame.sliceHeight,
        destination.color
      ];
      fields.push(ring.nativeChecksum(destination.sequence, fields), destination.sequence);
      fields.forEach((value, word) =>
        block.writeUInt32LE(value, DESTINATION_FIELDS.metadata + word * WORD_BYTES)
      );
    }
    if (autoQueue) {
      block.writeUInt32LE(nextJob?.sequence ?? 0, DESTINATION_FIELDS.nextSequence);
      block.writeBigUInt64LE(
        BigInt(nextJob ? outputAt.first : outputAt.gate),
        DESTINATION_FIELDS.nextDispatch
      );
    }
    if (linkedGates)
      block.writeBigUInt64LE(
        BigInt(nextJob ? outputAt.third : outputAt.second),
        DESTINATION_FIELDS.fetchDispatch
      );
    await rpc.writeAndCall(address(DESTINATION), block, sync.signalLightEvent, [
      address(FETCH_GATE)
    ]);
    job.nextOutput = nextJob;
    job.fetchOpened = true;
    if (linkedGates && nextJob) {
      nextJob.decodeGateAt = Date.now();
      decodeGateSignals++;
    }
    return acquired;
  }

  /**
   * Waits for the fetch frame, then hands the output slot to the next queued job.
   * @param {any} job
   */
  async function completeOutputFetch(job) {
    if (!job || activeOutput !== job || !job.fetchOpened)
      throw Error('Split output fetch is not open');
    const fetched = await waitStatus('fetch', job.sequence, 'output fetch');
    if (fetched.readUInt32LE(FETCH_FIELDS.sequence) !== job.sequence)
      throw Error('Split decoder fetched the wrong access unit');
    activeOutput = autoQueue ? job.nextOutput : null;
    for (const [name, offset] of FETCH_STATUSES) {
      const value = status(fetched.readBigUInt64LE(offset));
      if (value) throw resultError('movie::' + name + ' returned 0x' + value.toString(16), value);
    }
    return {sequence: job.sequence, pts: job.acquired.pts};
  }

  return {
    get outputEvent() {
      return address(OUTPUT_EVENT);
    },

    async register() {
      const {result} = await rpc.callAddress(
        registerAddress,
        [decoder, address(DECODER_EVENTS)],
        SHORT
      );
      if (status(result) !== 0)
        throw Error('RegisterClientEvents returned 0x' + status(result).toString(16));
    },

    /** Writes both workers' frames and starts them, parked on their gates. */
    async start() {
      if (input.thread !== null || video.thread !== null)
        throw Error('Split decoder workers already started');
      await rpc.callAddress(sync.clearEvent, [address(OUTPUT_EVENT)], SHORT);
      const inputWorkerFrames = inputFrames();
      const outputWorkerFrames = outputFrames();
      await install(input, inputWorkerFrames);
      await install(video, outputWorkerFrames);
      await rpc.write(
        address(INPUT_DISPATCH),
        addressWords(inputAt.first, inputAt.second, outputAt.first, outputAt.second)
      );
      if (linkedGates)
        await rpc.write(
          address(DESTINATION + DESTINATION_FIELDS.fetchDispatch),
          addressWords(outputAt.second)
        );

      input.uncertain = true;
      input.thread = await spawn(rpc, inputBase, inputAt.gate, {
        failed: 'Split input thread creation failed'
      });
      input.uncertain = false;
      if (!inputOnly) {
        video.uncertain = true;
        video.thread = await spawn(rpc, outputBase, outputAt.gate, {
          failed: 'Split output thread creation failed'
        });
        video.uncertain = false;
      }
    },

    /**
     * Writes an input job and opens the input gate. With `sendFirst`, the payload is sent
     * before the gate opens.
     * @param {{index: number, length: number, receiveLength?: number, pts: number,
     *   inputAddress: number, payload: Buffer, sendFirst?: boolean}} unit
     */
    async stageInput({
      index,
      length,
      receiveLength = length,
      pts,
      inputAddress,
      payload,
      sendFirst = false
    }) {
      if (!input.thread || input.joined || activeInput)
        throw Error('Split input worker is not ready');
      if (
        !Buffer.isBuffer(payload) ||
        !payload.length ||
        payload.length !== length ||
        length > transport.maxAccessUnit ||
        !Number.isInteger(receiveLength) ||
        receiveLength < 1 ||
        receiveLength > length ||
        (sendFirst && receiveLength !== length) ||
        !Number.isInteger(index) ||
        index < 0 ||
        !Number.isSafeInteger(inputAddress) ||
        inputAddress <= 0 ||
        !Number.isSafeInteger(pts) ||
        pts < 0
      )
        throw Error('Invalid split decoder input job');
      const sequence = (nextSequence + 1) >>> 0 || 1;
      nextSequence = sequence;
      const job = {sequence, pts: BigInt(pts), length, payload, sent: false};
      const bytes = Buffer.alloc(INPUT_JOB_FIELDS.bytes);
      bytes.writeUInt32LE(sequence, INPUT_JOB_FIELDS.sequence);
      bytes.writeInt32LE(index, INPUT_JOB_FIELDS.index);
      bytes.writeUInt32LE(length, INPUT_JOB_FIELDS.length);
      bytes.writeUInt32LE(receiveLength, INPUT_JOB_FIELDS.receiveLength);
      bytes.writeBigUInt64LE(BigInt(pts), INPUT_JOB_FIELDS.pts);
      bytes.writeBigUInt64LE(BigInt(inputAddress), INPUT_JOB_FIELDS.inputAddress);
      if (sendFirst) {
        await transport.send(payload);
        job.sent = true;
      }
      activeInput = job;
      try {
        await rpc.writeAndCall(address(INPUT_JOB), bytes, sync.signalLightEvent, [
          address(INPUT_GATE)
        ]);
      } catch (error) {
        activeInput = null;
        throw error;
      }
      return job;
    },

    /**
     * @param {any} job
     * @param {Buffer} [payload]
     * @param {any} [pairedOutput]
     */
    async verifyReceived(job, payload, pairedOutput) {
      return verifyReceived(job, payload, pairedOutput);
    },

    /**
     * Finishes an input whose decode gate the output worker opened.
     * @param {any} job
     */
    async finishInputAfterLinkedGate(job) {
      if (!linkedGates || !job.decodeGateAt) throw Error('Linked decode gate is not open');
      return finishInput(job);
    },

    /**
     * Waits for the receive, opens the decode gate and waits for the submit.
     * @param {any} job
     * @param {Buffer} [payload]
     */
    async completeInput(job, payload = job?.payload) {
      await verifyReceived(job, payload);
      await rpc.callAddress(sync.signalLightEvent, [address(DECODE_GATE)], SHORT);
      job.decodeGateAt = Date.now();
      decodeGateSignals++;
      return finishInput(job);
    },

    /** @param {any} job */
    async input(job) {
      const staged = await this.stageInput(job);
      return this.completeInput(staged);
    },

    /**
     * Writes the output job's sequence and opens the output gate.
     * @param {any} job
     */
    async queueOutput(job) {
      if (!video.thread || video.joined || activeOutput)
        throw Error('Split output worker is not ready');
      if (!job || !Number.isInteger(job.sequence) || job.sequence < 1)
        throw Error('Invalid split decoder output job');
      const bytes = Buffer.alloc(WORD_BYTES);
      bytes.writeUInt32LE(job.sequence);
      activeOutput = job;
      await rpc.writeAndCall(address(OUTPUT_JOB), bytes, sync.signalLightEvent, [
        address(OUTPUT_GATE)
      ]);
    },

    /** @param {any} job */
    async waitForAcquired(job) {
      return acquiredOutput(job);
    },

    /**
     * @param {any} job
     * @param {OutputDestination} destination
     * @param {Layout | null} frame
     * @param {any} nextJob
     */
    async openOutputFetch(job, destination, frame, nextJob) {
      if (!linkedGates) throw Error('Linked gates are not enabled');
      return openOutputFetch(job, destination, frame, nextJob);
    },

    /** @param {any} job */
    async completeOutputFetch(job) {
      return completeOutputFetch(job);
    },

    /**
     * @param {any} job
     * @param {OutputDestination} destination
     * @param {Layout | null} [frame]
     * @param {any} [nextJob]
     */
    async finishOutput(job, destination, frame = null, nextJob = null) {
      await openOutputFetch(job, destination, frame, nextJob);
      return completeOutputFetch(job);
    },

    get diagnostics() {
      return {
        decodeGateSignals,
        activeInput: activeInput?.sequence,
        activeOutput: activeOutput?.sequence
      };
    },

    /**
     * Stops the status scheduler, points every dispatch at the exit frames, wakes every gate
     * and joins both workers. An output acquired but not fetched is released here.
     */
    async stop() {
      if (input.uncertain || video.uncertain)
        throw Error('Split decoder thread creation is uncertain; decoder and events retained');
      statusClosing = true;
      rejectStatusWaiters(Error('Split decoder stopped'));
      wakeStatusLoop?.();
      if (statusLoop) await statusLoop;
      if ((!input.thread || input.joined) && (!video.thread || video.joined)) return;
      transport.abort();
      await rpc.write(
        address(INPUT_DISPATCH),
        addressWords(inputAt.exit, inputAt.exit, outputAt.exit, outputAt.exit)
      );
      if (linkedGates)
        await rpc.write(
          address(DESTINATION + DESTINATION_FIELDS.fetchDispatch),
          addressWords(outputAt.exit)
        );
      for (const gate of [INPUT_GATE, DECODE_GATE, OUTPUT_GATE, FETCH_GATE])
        await rpc.callAddress(sync.signalLightEvent, [address(gate)], SHORT);
      await rpc.callAddress(sync.signalEvent, [address(OUTPUT_EVENT)], SHORT);
      for (const worker of [input, video]) {
        if (!worker.thread || worker.joined) continue;
        if (
          !(await wait(rpc, worker.thread, {
            timeoutMs: stopTimeoutMs,
            pollMs: STOP_POLL_MS,
            invalid: 'Split decoder worker state invalid',
            outputBytes: SHORT
          }))
        )
          throw Error(
            'Split decoder ' +
              (worker === input ? 'input' : 'output') +
              ' did not stop; decoder and events retained'
          );
        await join(rpc, worker.thread, worker.base + EXIT_SLOT_OFFSET, {
          failed: 'Split decoder pthread join failed'
        });
        worker.joined = true;
      }
      const acquired = await rpc.read(address(OUTPUT_RESULTS), OUTPUT_FIELDS.sequence + WORD_BYTES);
      const fetched = await rpc.read(address(FETCH_RESULTS + FETCH_FIELDS.sequence), WORD_BYTES);
      const acquiredSequence = acquired.readUInt32LE(OUTPUT_FIELDS.sequence);
      if (
        acquiredSequence &&
        fetched.readUInt32LE() !== acquiredSequence &&
        status(acquired.readBigUInt64LE(OUTPUT_FIELDS.acquireStatus)) === 0 &&
        acquired.readInt32LE(OUTPUT_FIELDS.outputIndex) >= 0
      )
        await rpc.callAddress(
          functions.releaseOutput,
          [decoder, acquired.readInt32LE(OUTPUT_FIELDS.outputIndex)],
          SHORT
        );
      activeInput = activeOutput = null;
    },

    async finalize() {
      if (
        input.uncertain ||
        video.uncertain ||
        (input.thread && !input.joined) ||
        (video.thread && !video.joined)
      )
        throw Error('Split decoder events retained while a worker may be running');
      for (const {offset, finalize} of initialized.reverse())
        await rpc.callAddress(finalize, [address(offset)], SHORT);
    }
  };
}

export {create};
