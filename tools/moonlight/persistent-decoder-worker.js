/**
 * One persistent console thread that decodes an access unit per job for native-decoder.js.
 *
 * The thread loops through finite frames that jump into each other with longjmp. It parks on
 * the gate, then runs the decode stage: SendInput, a wait on the decoder's output event and
 * AcquireOutput, after which it signals ACQUIRED and parks on the fetch gate. The fetch stage
 * points the output buffer at the job's destination, fetches and releases the output,
 * acquires the next input slot, restores every frame from its snapshot (running a frame
 * consumes it) and jumps back to the gate. With a native TCP transport, a receive stage runs
 * between the gate and the decode stage, reading the access unit straight from the socket
 * into the decoder's input buffer.
 *
 * Each stage stamps its results, then the job sequence, into the control page; the host polls
 * them with a paired tryWait and read. A probe stage cuts the loop short after one stage to
 * locate a stall on the console. Whenever the thread may still be running, or its creation
 * is uncertain, the decoder and events are retained: nothing is finalized.
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

const CONTROL_BYTES = 0x1000;
/** Light events in the control page. */
const GATE = 0;
const ACQUIRED = 0x10;
const FETCH_GATE = 0x20;
const DONE = 0x30;
const RECEIVE_DONE = 0xe0;
const DECODE_GATE = 0xf0;
const PROBE_DONE = 0x1d0;
/** The auto-clear decoder output event. */
const OUTPUT_EVENT = 0x40;
/** The client events RegisterClientEvents hands the decoder. */
const DECODER_EVENTS = 0x80;
/** Where the client events hold the output event's address. */
const DECODER_OUTPUT_EVENT = 8;
/**
 * Dispatch words the stages jump through: the stage after the gate (receive or decode), the
 * fetch stage, and, with a transport, the decode stage after the receive stage.
 */
const DISPATCH = 0xc0;
const FETCH_DISPATCH = 0xc8;
const DECODE_DISPATCH = 0x100;

/** The job the host writes for each access unit; `tcpBytes` adds the input address. */
const JOB = {
  offset: 0x1a0,
  sequence: 0,
  index: 4,
  length: 8,
  pts: 16,
  inputAddress: 24,
  bytes: 24,
  tcpBytes: 32
};
/** The destination the host writes before the fetch stage: address and size. */
const FETCH_JOB = {offset: 0x1c0, address: 0, bytes: 8, size: 16};
/** Decode stage results: SendInput and AcquireOutput statuses and out-parameters. */
const DECODE_RESULTS = {
  offset: 0x120,
  sendStatus: 0,
  acquireStatus: 8,
  outputIndex: 16,
  pts: 24,
  flags: 32,
  count: 36,
  sequence: 40
};
/** Fetch stage results: one status per call, then AcquireInput's out-parameters. */
const FETCH_RESULTS = {
  offset: 0x160,
  setDataStatus: 0,
  getStatus: 8,
  releaseStatus: 16,
  inputStatus: 24,
  nextIndex: 32,
  inputCount: 36,
  sequence: 40
};
/** @type {[string, number][]} The fetch calls whose failure fails the output. */
const FETCH_STATUSES = [
  ['getOutput', FETCH_RESULTS.getStatus],
  ['releaseOutput', FETCH_RESULTS.releaseStatus]
];
/** Receive stage results: the received byte count and the job sequence. */
const RECEIVE_RESULTS = {offset: 0x1e0, count: 0, sequence: 8};
/** Every results block is read as this many bytes, through its sequence. */
const RESULT_BYTES = 44;
const SEQUENCE_BYTES = 4;

/** Offsets in the worker's allocation of each frame and its snapshot. */
const REGION = {
  gate: 0x10000,
  gateSnapshot: 0x80000,
  decode: 0x110000,
  decodeSnapshot: 0x180000,
  fetch: 0x210000,
  fetchSnapshot: 0x280000,
  receive: 0x310000,
  receiveSnapshot: 0x380000
};
/** The allocation, its exit frame and the exit frame's stack, without a receive stage. */
const LAYOUT = {bytes: 0x400000, exit: 0x350000, exitStack: 0x370000};
/** The same with a receive stage, which pushes the exit frame past its snapshot. */
const TCP_LAYOUT = {bytes: 0x500000, exit: 0x450000, exitStack: 0x470000};
const MAX_FRAME_BYTES = 0x100000;
/** The exit frame is a longjmp context into thread exit. */
const EXIT_CONTEXT_BYTES = 0xb0;
/** Where pthread_join stores the worker's exit value; spawn stores the thread at offset 0. */
const EXIT_SLOT_OFFSET = 8;
const STOP_POLL_MS = 5;
const POLL_INTERVAL_MS = 2;

/** Reply output bytes for native calls: too few to carry an output slot, only the result. */
const SHORT = 2;
const AUTO_CLEAR = 1;
const ADDRESS_BYTES = 8;
/** The SDK memcpy, paired with tryWait to read a results block into rpc.output. */
const READ = 0x586fb0;
/** recv flag that waits for the whole access unit. */
const MSG_WAITALL = 0x40;
/** tryWaitLightEvent's low byte is 1 once the event was signalled. */
const SIGNALLED = 1n;
/** Queue results that only mean no buffer is ready yet, when the index is negative. */
const EMPTY_QUEUE_RESULTS = [0x100e, 0x1011];
/** The result reported for an output that came back without an index. */
const OUTPUT_NOT_READY = 0x100e;

/** Probe stages that stop in the decode stage, after the gate, dispatch or that call. */
const DECODE_PROBES = new Set(['gate', 'dispatch', 'send', 'wait', 'acquire']);
/** Probe stages that stop in the fetch stage, after that call, the signal or the restores. */
const FETCH_PROBES = new Set(['setData', 'getOutput', 'release', 'input', 'done', 'restore']);
/** How many fetch calls run before a fetch probe stops; the others run them all. */
const FETCH_PROBE_CALLS = {setData: 1, getOutput: 2, release: 3, input: 4};
/** Probe stages after which the fetch stage may already have released the output. */
const RELEASED_PROBES = ['release', 'input', 'done', 'restore'];
/** At most this many fetch calls stamp a status. */
const FETCH_STATUS_CALLS = 4;
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

/** @param {number} milliseconds */
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
/** @param {bigint} value */
const status = value => Number(BigInt.asUintN(32, value));

/** @typedef {import('../../../hbl-platform/sdk/native/allocate.js').Rpc} Rpc */
/** @typedef {import('../../../hbl-platform/sdk/native/allocate.js').CallReply} CallReply */
/** @typedef {import('../../../hbl-platform/sdk/native/symbols.js').LoadedModule} LoadedModule */

/**
 * The bridge client, which here also pairs calls and writes and calls in one exchange.
 * @typedef {Rpc & {
 *   pair: (operations: object[], outputBytes: number) =>
 *     Promise<{results: bigint[], output: Buffer}>,
 *   writeAndCall: (address: number, bytes: Buffer, target: number, args: number[]) =>
 *     Promise<CallReply>
 * }} WorkerRpc
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
 * @typedef {'gate' | 'dispatch' | 'send' | 'wait' | 'acquire' | 'setData' | 'getOutput' |
 *   'release' | 'input' | 'done' | 'restore'} ProbeStage
 */

/**
 * @typedef {object} PersistentWorkerOptions
 * @property {WorkerRpc} rpc
 * @property {LoadedModule} module The loaded movie module.
 * @property {Record<string, number>} functions Addresses of the movie functions.
 * @property {number} decoder
 * @property {number} output The movie Buffer the output is fetched into.
 * @property {number} format The output format media object.
 * @property {NativeTransport | null} [transport] Receive each access unit on the console.
 * @property {() => boolean} [cancelled]
 * @property {number} [pollTimeoutMs]
 * @property {number} [stopTimeoutMs]
 */

/**
 * @typedef {object} DecodeJob
 * @property {number} sequence
 * @property {bigint} pts
 */

/**
 * @param {NativeTransport} transport
 * @returns {boolean}
 */
function isInvalidTransport(transport) {
  return (
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
 * The next job sequence, which wraps past zero.
 * @param {number} sequence
 */
const nextSequence = sequence => (sequence + 1) >>> 0 || 1;

/**
 * An error carrying the raw 32-bit result of a failed call.
 * @param {string} message
 * @param {number} value
 */
const resultError = (message, value) => Object.assign(Error(message), {result: value});

/** @param {PersistentWorkerOptions} options */
async function create({
  rpc,
  module,
  functions,
  decoder,
  output,
  format,
  transport = null,
  cancelled = () => false,
  pollTimeoutMs = 5000,
  stopTimeoutMs = 5000
}) {
  if (transport && isInvalidTransport(transport))
    throw Error('Invalid native TCP decoder transport');
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

  const layout = transport ? TCP_LAYOUT : LAYOUT;
  const base = await allocate(rpc, layout.bytes, {
    failed: 'Persistent decoder worker allocation failed',
    invalid: 'Invalid persistent decoder worker allocation'
  });
  const control = await allocate(rpc, CONTROL_BYTES, {
    failed: 'Persistent decoder control allocation failed',
    invalid: 'Invalid persistent decoder control allocation'
  });
  /** @param {number} offset */
  const event = offset => control + offset;
  const page = Buffer.alloc(CONTROL_BYTES);
  page.writeBigUInt64LE(BigInt(event(OUTPUT_EVENT)), DECODER_EVENTS + DECODER_OUTPUT_EVENT);
  await rpc.write(control, page);
  /** @type {{offset: number, finalize: number}[]} Events to finalize, in creation order. */
  const initialized = [];
  for (const offset of [
    GATE,
    ACQUIRED,
    FETCH_GATE,
    DONE,
    PROBE_DONE,
    ...(transport ? [RECEIVE_DONE, DECODE_GATE] : [])
  ]) {
    await rpc.callAddress(sync.initializeLightEvent, [event(offset), 0, AUTO_CLEAR, 0], SHORT);
    initialized.push({offset, finalize: sync.finalizeLightEvent});
  }
  await rpc.callAddress(sync.initializeEvent, [event(OUTPUT_EVENT), 0, AUTO_CLEAR, 0], SHORT);
  initialized.push({offset: OUTPUT_EVENT, finalize: sync.finalizeEvent});

  /** @type {bigint | null} */
  let thread = null;
  let sequence = 0;
  /** The sequence of the job in flight, or 0. */
  let active = 0;
  let joined = false;
  /** Spawning may have created a thread nobody holds. */
  let uncertainStart = false;
  /** @type {ProbeStage | null} */
  let probeStage = null;
  const gateFrame = base + REGION.gate;
  const gateSnapshot = base + REGION.gateSnapshot;
  const decodeFrame = base + REGION.decode;
  const decodeSnapshot = base + REGION.decodeSnapshot;
  const fetchFrame = base + REGION.fetch;
  const fetchSnapshot = base + REGION.fetchSnapshot;
  const receiveFrame = base + REGION.receive;
  const receiveSnapshot = base + REGION.receiveSnapshot;
  const exitFrame = base + layout.exit;

  /**
   * Builds a frame and points the stores of the calls in `results` at control page offsets.
   * @param {number} address Where the frame runs.
   * @param {object[]} calls
   * @param {Record<number, number>} [results] Call index to control page offset.
   * @returns {Buffer}
   */
  function frame(address, calls, results = {}) {
    const program = build(address, sdk, calls, CODE, false, new Set(Object.values(functions)));
    if (program.frame.length > MAX_FRAME_BYTES)
      throw Error('Persistent decoder frame exceeds its region');
    for (const [call, destination] of Object.entries(results)) {
      const index = program.proof.logicalResultIndices[Number(call)];
      program.frame.writeBigUInt64LE(
        BigInt(event(destination)),
        program.proof.stackOffsets[index] + CALL4_X19
      );
    }
    return program.frame;
  }

  /**
   * Polls a light event, reading a results block in the same exchange.
   * @param {number} offset The light event.
   * @param {number} resultOffset The results block.
   * @param {string} label
   * @returns {Promise<Buffer>} The results block once the event was signalled.
   */
  async function poll(offset, resultOffset, label) {
    const until = Date.now() + pollTimeoutMs;
    while (Date.now() < until && !cancelled()) {
      const reply = await rpc.pair(
        [
          {address: sync.tryWaitLightEvent, args: [event(offset), 0, 0, 0]},
          {offset: READ, args: [rpc.output, event(resultOffset), RESULT_BYTES, 0]}
        ],
        RESULT_BYTES
      );
      if ((reply.results[0] & 0xffn) === SIGNALLED) {
        if (reply.results[1] !== BigInt(rpc.output))
          throw Error('Persistent decoder result read failed');
        return reply.output;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw Error(
      cancelled() ? 'Native decoding cancelled' : `Persistent decoder ${label} timed out`
    );
  }

  /** @param {number} offset */
  const signal = offset => ({function: sync.signalLightEvent, args: [event(offset), 0, 0, 0]});
  /** @param {number} offset */
  const park = offset => ({function: sync.waitLightEvent, args: [event(offset), 0, 0, 0]});

  /**
   * @param {ProbeStage | null} stage
   * @param {{jump: number, copy: number}} targets
   * @returns {{calls: object[], results: Record<number, number>}} The decode stage.
   */
  function decodeStage(stage, {jump, copy}) {
    if (stage === 'dispatch') return {calls: [signal(PROBE_DONE)], results: {}};
    const send = {
      function: functions.sendInput,
      args: [
        decoder,
        {u32: event(JOB.offset + JOB.index)},
        0,
        {u32: event(JOB.offset + JOB.length)},
        {u64: event(JOB.offset + JOB.pts)},
        0
      ]
    };
    const waitOutput = {function: sync.waitEvent, args: [event(OUTPUT_EVENT), 0, 0, 0]};
    const acquireOutput = {
      function: functions.acquireOutput,
      args: [
        decoder,
        event(DECODE_RESULTS.offset + DECODE_RESULTS.outputIndex),
        event(DECODE_RESULTS.offset + DECODE_RESULTS.pts),
        event(DECODE_RESULTS.offset + DECODE_RESULTS.flags),
        event(DECODE_RESULTS.offset + DECODE_RESULTS.count)
      ]
    };
    const stampSequence = {
      function: copy,
      args: [
        event(DECODE_RESULTS.offset + DECODE_RESULTS.sequence),
        event(JOB.offset + JOB.sequence),
        SEQUENCE_BYTES,
        0
      ]
    };
    const acquires = stage !== 'send' && stage !== 'wait';
    const calls = [
      send,
      ...(stage === 'send' ? [] : [waitOutput]),
      ...(acquires ? [acquireOutput, stampSequence] : []),
      ...(DECODE_PROBES.has(stage)
        ? [signal(PROBE_DONE)]
        : [
            signal(ACQUIRED),
            park(FETCH_GATE),
            {function: jump, args: [{u64: event(FETCH_DISPATCH)}, 1, 0, 0]}
          ])
    ];
    const results = acquires
      ? {
          0: DECODE_RESULTS.offset + DECODE_RESULTS.sendStatus,
          2: DECODE_RESULTS.offset + DECODE_RESULTS.acquireStatus
        }
      : {0: DECODE_RESULTS.offset + DECODE_RESULTS.sendStatus};
    return {calls, results};
  }

  /**
   * @param {number} copy
   * @returns {object[]} SetDataAndCapacity, GetOutputBuffer, ReleaseOutputBufferIndex,
   *   AcquireInputBufferIndex and the sequence stamp.
   */
  function fetchCalls(copy) {
    return [
      {
        function: functions.bufferSetData,
        args: [
          output,
          {u64: event(FETCH_JOB.offset + FETCH_JOB.address)},
          {u64: event(FETCH_JOB.offset + FETCH_JOB.bytes)},
          0
        ]
      },
      {
        function: functions.getOutput,
        args: [
          decoder,
          {u32: event(DECODE_RESULTS.offset + DECODE_RESULTS.outputIndex)},
          output,
          format
        ]
      },
      {
        function: functions.releaseOutput,
        args: [decoder, {u32: event(DECODE_RESULTS.offset + DECODE_RESULTS.outputIndex)}, 0, 0]
      },
      {
        function: functions.acquireInput,
        args: [
          decoder,
          event(FETCH_RESULTS.offset + FETCH_RESULTS.nextIndex),
          event(FETCH_RESULTS.offset + FETCH_RESULTS.inputCount),
          0
        ]
      },
      {
        function: copy,
        args: [
          event(FETCH_RESULTS.offset + FETCH_RESULTS.sequence),
          event(JOB.offset + JOB.sequence),
          SEQUENCE_BYTES,
          0
        ]
      }
    ];
  }

  /**
   * @param {{jump: number, copy: number}} targets
   * @returns {object[]} The receive stage: recv into the input buffer, stamp, signal, park.
   */
  function receiveCalls({jump, copy}) {
    return [
      {
        function: transport.recvFunction,
        args: [
          transport.fd,
          {u64: event(JOB.offset + JOB.inputAddress)},
          {u32: event(JOB.offset + JOB.length)},
          MSG_WAITALL
        ]
      },
      {
        function: copy,
        args: [
          event(RECEIVE_RESULTS.offset + RECEIVE_RESULTS.sequence),
          event(JOB.offset + JOB.sequence),
          SEQUENCE_BYTES,
          0
        ]
      },
      signal(RECEIVE_DONE),
      park(DECODE_GATE),
      {function: jump, args: [{u64: event(DECODE_DISPATCH)}, 1, 0, 0]}
    ];
  }

  /** @returns {Buffer} The longjmp context of the exit frame. */
  function exitContext() {
    const context = Buffer.alloc(EXIT_CONTEXT_BYTES);
    context.writeBigUInt64LE(BigInt(sdk + CODE.exit.offset), CONTEXT_X30);
    context.writeBigUInt64LE(BigInt(base + layout.exitStack), CONTEXT_SP);
    return context;
  }

  return {
    async register() {
      const {result} = await rpc.callAddress(
        registerAddress,
        [decoder, event(DECODER_EVENTS)],
        SHORT
      );
      if (status(result) !== 0)
        throw Error('RegisterClientEvents returned 0x' + status(result).toString(16));
    },

    /**
     * Writes the frames and starts the thread, parked on the gate.
     * @param {{stage?: ProbeStage | null}} [options] A probe stage stops the loop after it.
     */
    async start({stage = null} = {}) {
      if (thread !== null) throw Error('Persistent decoder worker already started');
      if (stage !== null && !DECODE_PROBES.has(stage) && !FETCH_PROBES.has(stage))
        throw Error('Invalid persistent decoder probe stage');
      probeStage = stage;
      await rpc.callAddress(sync.clearEvent, [event(OUTPUT_EVENT)], SHORT);
      const jump = sdk + CODE.longjmp.offset;
      const copy = sdk + IPC_COPY.offset;
      const gate = frame(gateFrame, [
        park(GATE),
        stage === 'gate'
          ? signal(PROBE_DONE)
          : {function: jump, args: [{u64: event(DISPATCH)}, 1, 0, 0]}
      ]);
      const decodeStageCalls = decodeStage(stage, {jump, copy});
      const decode = frame(decodeFrame, decodeStageCalls.calls, decodeStageCalls.results);
      const fetchStageCalls = fetchCalls(copy);
      const fetchCount = FETCH_PROBE_CALLS[stage] ?? fetchStageCalls.length;
      const restores = !FETCH_PROBES.has(stage) || stage === 'restore';
      const restoreCalls = [
        {function: copy, args: [gateFrame, gateSnapshot, gate.length, 0]},
        {function: copy, args: [decodeFrame, decodeSnapshot, decode.length, 0]},
        {function: copy, args: [fetchFrame, fetchSnapshot, 0, 0]}
      ];
      const receive = transport
        ? frame(receiveFrame, receiveCalls({jump, copy}), {
            0: RECEIVE_RESULTS.offset + RECEIVE_RESULTS.count
          })
        : null;
      if (receive)
        restoreCalls.push({
          function: copy,
          args: [receiveFrame, receiveSnapshot, receive.length, 0]
        });
      const fetchBody = [
        ...fetchStageCalls.slice(0, fetchCount),
        ...(restores ? restoreCalls : []),
        ...(fetchCount === fetchStageCalls.length ? [signal(DONE)] : []),
        ...(FETCH_PROBES.has(stage)
          ? [signal(PROBE_DONE)]
          : [{function: jump, args: [gateFrame, 1, 0, 0]}])
      ];
      const fetchStatuses = [
        FETCH_RESULTS.offset + FETCH_RESULTS.setDataStatus,
        FETCH_RESULTS.offset + FETCH_RESULTS.getStatus,
        FETCH_RESULTS.offset + FETCH_RESULTS.releaseStatus,
        FETCH_RESULTS.offset + FETCH_RESULTS.inputStatus
      ];
      const resultSlots = Object.fromEntries(
        fetchStatuses
          .slice(0, Math.min(fetchCount, FETCH_STATUS_CALLS))
          .map((slot, index) => [index, slot])
      );
      let fetch = frame(fetchFrame, fetchBody, resultSlots);
      if (restores) {
        restoreCalls[2].args[2] = fetch.length;
        fetch = frame(fetchFrame, fetchBody, resultSlots);
      }
      if (
        gate.length > gateSnapshot - gateFrame ||
        decode.length > decodeSnapshot - decodeFrame ||
        fetch.length > fetchSnapshot - fetchFrame ||
        fetchSnapshot + fetch.length > receiveFrame ||
        (receive &&
          (receive.length > receiveSnapshot - receiveFrame ||
            receiveSnapshot + receive.length > exitFrame))
      )
        throw Error('Persistent decoder frame overlaps its snapshot');
      const stop = exitContext();
      /** @type {[number, number, Buffer][]} Each frame's address, its snapshot and its bytes. */
      const slots = [
        [gateFrame, gateSnapshot, gate],
        [decodeFrame, decodeSnapshot, decode],
        [fetchFrame, fetchSnapshot, fetch]
      ];
      if (receive) slots.push([receiveFrame, receiveSnapshot, receive]);
      for (const [live, snapshot, bytes] of slots) {
        await rpc.write(live, bytes);
        await rpc.write(snapshot, bytes);
      }
      await rpc.write(exitFrame, stop);
      for (const [, snapshot, bytes] of slots)
        if (!(await rpc.read(snapshot, bytes.length)).equals(bytes))
          throw Error('Persistent decoder frame snapshot readback differs');
      await rpc.write(
        event(DISPATCH),
        addressWords(receive ? receiveFrame : decodeFrame, fetchFrame)
      );
      if (receive) await rpc.write(event(DECODE_DISPATCH), addressWords(decodeFrame));
      uncertainStart = true;
      thread = await spawn(rpc, base, gateFrame, {
        failed: 'Persistent decoder thread creation failed'
      });
      uncertainStart = false;
    },

    /**
     * Opens the gate for one access unit. With a transport, also sends the payload, waits
     * until the console received all of it and opens the decode gate.
     * @param {{index: number, length: number, pts: number | bigint, inputAddress?: number,
     *   payload?: Buffer}} unit
     * @returns {Promise<DecodeJob>}
     */
    async begin({index, length, pts, inputAddress, payload}) {
      if (thread === null || joined || active)
        throw Error('Persistent decoder worker is not ready');
      if (
        transport &&
        (!Buffer.isBuffer(payload) ||
          payload.length !== length ||
          payload.length > transport.maxAccessUnit ||
          !Number.isSafeInteger(inputAddress) ||
          inputAddress <= 0)
      )
        throw Error('Invalid native TCP decoder payload');
      sequence = nextSequence(sequence);
      active = sequence;
      const job = Buffer.alloc(transport ? JOB.tcpBytes : JOB.bytes);
      job.writeUInt32LE(sequence, JOB.sequence);
      job.writeInt32LE(index, JOB.index);
      job.writeUInt32LE(length, JOB.length);
      job.writeBigUInt64LE(BigInt(pts), JOB.pts);
      if (transport) job.writeBigUInt64LE(BigInt(inputAddress), JOB.inputAddress);
      await rpc.writeAndCall(event(JOB.offset), job, sync.signalLightEvent, [event(GATE)]);
      if (transport) {
        await transport.send(payload);
        const received = await poll(RECEIVE_DONE, RECEIVE_RESULTS.offset, 'TCP receive');
        const count = received.readBigInt64LE(RECEIVE_RESULTS.count);
        const receivedSequence = received.readUInt32LE(RECEIVE_RESULTS.sequence);
        if (count !== BigInt(length) || receivedSequence !== sequence)
          throw Error(
            `Native TCP receive returned ${count}/${length} bytes and sequence ${receivedSequence}/${sequence}`
          );
        await rpc.callAddress(sync.signalLightEvent, [event(DECODE_GATE)], SHORT);
      }
      return {sequence, pts: BigInt(pts)};
    },

    /**
     * Waits for the job's output, then fetches it into `destination` and returns the next
     * input slot. Under a probe stage, returns the stage's raw results instead.
     * @param {DecodeJob} job
     * @param {{address: number, bytes: number}} destination
     */
    async finish(job, destination) {
      if (thread === null || joined || !job || job.sequence !== active)
        throw Error('Persistent decoder job is not ready to finish');
      if (DECODE_PROBES.has(probeStage)) {
        const result = await poll(PROBE_DONE, DECODE_RESULTS.offset, 'probe ' + probeStage);
        return {
          pts: job.pts,
          input: {status: 0, index: -1},
          probe: {
            stage: probeStage,
            sendStatus: status(result.readBigUInt64LE(DECODE_RESULTS.sendStatus)),
            acquireStatus: status(result.readBigUInt64LE(DECODE_RESULTS.acquireStatus)),
            outputIndex: result.readInt32LE(DECODE_RESULTS.outputIndex),
            completedSequence: result.readUInt32LE(DECODE_RESULTS.sequence)
          }
        };
      }
      const acquired = await poll(ACQUIRED, DECODE_RESULTS.offset, 'output acquire');
      const sent = status(acquired.readBigUInt64LE(DECODE_RESULTS.sendStatus));
      const acquiredStatus = status(acquired.readBigUInt64LE(DECODE_RESULTS.acquireStatus));
      const outputIndex = acquired.readInt32LE(DECODE_RESULTS.outputIndex);
      if (acquired.readUInt32LE(DECODE_RESULTS.sequence) !== job.sequence)
        throw Error('Persistent decoder acquired the wrong access unit');
      if (sent || acquiredStatus || outputIndex < 0) {
        const value = sent || acquiredStatus || OUTPUT_NOT_READY;
        throw resultError('Persistent decoder acquire returned 0x' + value.toString(16), value);
      }
      const target = Buffer.alloc(FETCH_JOB.size);
      target.writeBigUInt64LE(BigInt(destination.address), FETCH_JOB.address);
      target.writeBigUInt64LE(BigInt(destination.bytes), FETCH_JOB.bytes);
      if (FETCH_PROBES.has(probeStage)) {
        await rpc.write(event(FETCH_JOB.offset), target);
        if (!(await rpc.read(event(FETCH_JOB.offset), target.length)).equals(target))
          throw Error('Persistent decoder fetch job readback differs');
      }
      await rpc.writeAndCall(event(FETCH_JOB.offset), target, sync.signalLightEvent, [
        event(FETCH_GATE)
      ]);
      if (FETCH_PROBES.has(probeStage)) {
        const fetched = await poll(PROBE_DONE, FETCH_RESULTS.offset, 'probe ' + probeStage);
        return {
          pts: acquired.readBigUInt64LE(DECODE_RESULTS.pts),
          input: {status: 0, index: -1},
          probe: {
            stage: probeStage,
            outputIndex,
            getStatus: status(fetched.readBigUInt64LE(FETCH_RESULTS.getStatus)),
            releaseStatus: status(fetched.readBigUInt64LE(FETCH_RESULTS.releaseStatus)),
            inputStatus: status(fetched.readBigUInt64LE(FETCH_RESULTS.inputStatus)),
            nextIndex: fetched.readInt32LE(FETCH_RESULTS.nextIndex),
            completedSequence: fetched.readUInt32LE(FETCH_RESULTS.sequence)
          }
        };
      }
      const fetched = await poll(DONE, FETCH_RESULTS.offset, 'output fetch');
      if (fetched.readUInt32LE(FETCH_RESULTS.sequence) !== job.sequence)
        throw Error('Persistent decoder completed the wrong access unit');
      active = 0;
      for (const [name, offset] of FETCH_STATUSES) {
        const value = status(fetched.readBigUInt64LE(offset));
        if (value) throw resultError('movie::' + name + ' returned 0x' + value.toString(16), value);
      }
      const inputStatus = status(fetched.readBigUInt64LE(FETCH_RESULTS.inputStatus));
      const nextIndex = fetched.readInt32LE(FETCH_RESULTS.nextIndex);
      if (inputStatus && !(nextIndex < 0 && EMPTY_QUEUE_RESULTS.includes(inputStatus)))
        throw resultError(
          'Decoder input queue returned 0x' + inputStatus.toString(16),
          inputStatus
        );
      return {
        pts: acquired.readBigUInt64LE(DECODE_RESULTS.pts),
        input: {status: inputStatus, index: nextIndex}
      };
    },

    /**
     * @param {{index: number, length: number, pts: number | bigint,
     *   destination: {address: number, bytes: number}, inputAddress?: number,
     *   payload?: Buffer}} unit
     */
    async run({index, length, pts, destination, inputAddress, payload}) {
      const job = await this.begin({index, length, pts, inputAddress, payload});
      return this.finish(job, destination);
    },

    /**
     * Points every dispatch at the exit frame, wakes every gate and joins the thread. An
     * output the thread acquired but did not release is released here.
     */
    async stop() {
      if (uncertainStart)
        throw Error('Persistent decoder thread creation is uncertain; decoder and events retained');
      if (thread === null || joined) return;
      transport?.abort();
      await rpc.write(event(DISPATCH), addressWords(exitFrame, exitFrame));
      if (transport) await rpc.write(event(DECODE_DISPATCH), addressWords(exitFrame));
      await rpc.callAddress(sync.signalLightEvent, [event(GATE)], SHORT);
      await rpc.callAddress(sync.signalLightEvent, [event(FETCH_GATE)], SHORT);
      if (transport) await rpc.callAddress(sync.signalLightEvent, [event(DECODE_GATE)], SHORT);
      await rpc.callAddress(sync.signalEvent, [event(OUTPUT_EVENT)], SHORT);
      if (
        !(await wait(rpc, thread, {
          timeoutMs: stopTimeoutMs,
          pollMs: STOP_POLL_MS,
          invalid: 'Persistent decoder thread state invalid',
          outputBytes: SHORT
        }))
      )
        throw Error('Persistent decoder worker did not stop; decoder and events retained');
      await join(rpc, thread, base + EXIT_SLOT_OFFSET, {
        failed: 'Persistent decoder thread join failed'
      });
      joined = true;
      if (active) {
        const acquired = await rpc.read(event(DECODE_RESULTS.offset), RESULT_BYTES);
        const completed = await rpc.read(
          event(FETCH_RESULTS.offset + FETCH_RESULTS.sequence),
          SEQUENCE_BYTES
        );
        if (
          acquired.readUInt32LE(DECODE_RESULTS.sequence) === active &&
          completed.readUInt32LE() !== active &&
          !RELEASED_PROBES.includes(probeStage) &&
          status(acquired.readBigUInt64LE(DECODE_RESULTS.acquireStatus)) === 0 &&
          acquired.readInt32LE(DECODE_RESULTS.outputIndex) >= 0
        )
          await rpc.callAddress(
            functions.releaseOutput,
            [decoder, acquired.readInt32LE(DECODE_RESULTS.outputIndex)],
            SHORT
          );
        active = 0;
      }
    },

    async finalize() {
      if (uncertainStart || (thread !== null && !joined))
        throw Error('Persistent decoder events retained while the worker is running');
      for (const {offset, finalize} of initialized.reverse())
        await rpc.callAddress(finalize, [event(offset)], SHORT);
    }
  };
}

export {create};
