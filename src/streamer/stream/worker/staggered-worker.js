/**
 * Lifecycle of the staggered input and output workers, two console threads that run the
 * frames of staggered-input-plan.js and staggered-output-plan.js.
 *
 * The control page holds the light events (decode gate 0x00, ignored fetch gate 0x10, fetch
 * gate 0x20, acquisition acknowledgement 0x30, and under gate on receive the length gate 0x80,
 * which starts signalled for AU 1), the dispatch words 0x40-0x7f, the descriptors
 * 0x100-0x2ff, the decoder output event 0x400 and its registration 0x440. The acknowledgement
 * is auto-clear and starts signalled for AU 1; the output worker signals it once per acquired
 * output (see staggered-input-plan.js for the order). A drain also stamps the next output's
 * placeholder, so the last tail output acquires under its own sequence instead of the one its
 * slot held two AUs earlier.
 *
 * Stopping the input worker points its dispatches at the exit frame first, then wakes the
 * decode gate and the acknowledgement, so a worker parked on either exits without another
 * SendInput. Whenever a worker may still be running or a gate write may have half landed, the
 * native objects are retained: nothing is finalized and SmileBASIC has to be restarted.
 */
import {allocate, release} from '../../../../../hbl-platform/sdk/native/allocate.js';
import {verify} from '../../../../../hbl-platform/sdk/native/symbols.js';
import {
  CONTEXT_X30,
  CONTEXT_SP
} from '../../../../../hbl-platform/smilebasic/engine/shared/frames.js';
import {
  CODE,
  verifyCode,
  verifyCopy,
  verifyPreamble,
  spawn,
  wait,
  join
} from '../../../../../hbl-platform/sdk/native/thread.js';
import SYNC from '../../../../../hbl-platform/sdk/native/os-sync-functions.json' with {type: 'json'};
import MOVIE_EVENTS from '../../console-api/movie-event-functions.json' with {type: 'json'};
import * as inputPlan from './staggered-input-plan.js';
import * as outputPlan from './staggered-output-plan.js';
import * as gates from './staggered-gate.js';
import * as status from './staggered-status.js';

const CONTROL_BYTES = 0x1000;
/** The acquisition acknowledgement light event. */
const ACQUIRE_ACK = 0x30;
/** The dispatch words every frame jumps through. */
const DISPATCH_OFFSET = 0x40;
const DISPATCH_BYTES = 0x40;
/** The auto-clear decoder output event. */
const OUTPUT_EVENT = 0x400;
/** The client events RegisterClientEvents hands the decoder. */
const DECODER_EVENTS = 0x440;
/** Where the client events hold the output event's address. */
const DECODER_OUTPUT_EVENT = 8;
/** The movie Buffer used to look up decoder input buffers. */
const INPUT_BUFFER = 0x500;

/** Each worker's allocation for its frames, snapshots and stack. */
const WORKER_BYTES = 0x400000;
/** The exit frame is a longjmp context into thread exit, on its own stack. */
const EXIT_CONTEXT_BYTES = 0xb0;
const EXIT_STACK_OFFSET = 0x370000;
/** Where pthread_join stores the worker's exit value; spawn stores the thread at offset 0. */
const EXIT_SLOT_OFFSET = 8;
const STOP_POLL_MS = 5;

/** Reply output bytes for native calls: too few to carry an output slot, only the result. */
const SHORT = 2;
const AUTO_CLEAR = 1;
const ADDRESS_BYTES = 8;
const MAX_PTS = 0xffffffffffffffffn;
/** AcquireInputBufferIndex results that only mean no input slot is free yet. */
const NO_INPUT_SLOT = [0x100en, 0x1011n];
const SYNC_FUNCTIONS = [
  'initializeLightEvent',
  'waitLightEvent',
  'signalLightEvent',
  'finalizeLightEvent',
  'initializeEvent',
  'clearEvent',
  'signalEvent',
  'waitEvent',
  'finalizeEvent'
];

/** The input status words a slot retry reads: next-slot status, next index, sequence. */
const NEXT_SLOT = {
  offset: status.STATUS.input + 8,
  bytes: 16,
  status: 0,
  index: 8,
  sequence: 12
};
/** Ring offsets AcquireInputBufferIndex writes its index and count to. */
const NEXT_INDEX = status.STATUS.input + 16;
const INPUT_COUNT = status.STATUS.input + 24;
/** The acquire status words stop reads: status, output index, sequence. */
const ACQUIRED = {
  offset: status.STATUS.acquire,
  bytes: 28,
  status: 0,
  index: 8,
  sequence: 24
};
const FETCH_SEQUENCE = status.STATUS.fetch + 24;
const SEQUENCE_BYTES = 4;

/** @typedef {import('../../../../../hbl-platform/sdk/native/allocate.js').Rpc} Rpc */
/** @typedef {import('../../../../../hbl-platform/sdk/native/allocate.js').CallReply} CallReply */

/**
 * The bridge client, which here must also write and call in one exchange.
 * @typedef {Rpc & {writeAndCall: (address: number, bytes: Buffer, target: number,
 *   args: number[]) => Promise<CallReply>}} StaggeredRpc
 */

/**
 * @typedef {object} NativeTransport
 * @property {number} fd Console socket descriptor the access units arrive on.
 * @property {number} maxAccessUnit Size of the receive scratch; must be 1 MiB.
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
 * @typedef {object} WorkerState
 * @property {string} name
 * @property {number} base
 * @property {any} plan
 * @property {bigint | null} thread
 * @property {boolean} joined
 * @property {boolean} uncertain Spawning may have created a thread nobody holds.
 */

/**
 * @param {NativeTransport} transport
 * @param {Publication} publication
 * @returns {boolean}
 */
function isUnboundedSetup(transport, publication) {
  return (
    !transport ||
    !Number.isInteger(transport.fd) ||
    transport.fd < 0 ||
    transport.maxAccessUnit !== 0x100000 ||
    !Number.isSafeInteger(transport.recvFunction) ||
    typeof transport.send !== 'function' ||
    typeof transport.abort !== 'function' ||
    !Number.isSafeInteger(publication?.mapped) ||
    publication.mapped <= 0 ||
    ![1, 2].includes(publication.color)
  );
}

/**
 * @param {{symbols: any[]}} module
 * @param {{symbol: string, offset: number, size: number}} registration
 * @returns {boolean}
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
 * @param {bigint} result
 * @returns {number} The low 32 bits of a native result.
 */
function resultCode(result) {
  return Number(BigInt.asUintN(32, result));
}

/**
 * @param {number} address
 * @returns {Buffer}
 */
function addressWord(address) {
  const bytes = Buffer.alloc(ADDRESS_BYTES);
  bytes.writeBigUInt64LE(BigInt(address));
  return bytes;
}

/**
 * The control page as first written: all zero but the output event's registration.
 * @param {number} control
 * @returns {Buffer}
 */
function initialControl(control) {
  const bytes = Buffer.alloc(CONTROL_BYTES);
  bytes.writeBigUInt64LE(BigInt(control + OUTPUT_EVENT), DECODER_EVENTS + DECODER_OUTPUT_EVENT);
  return bytes;
}

/**
 * Every frame of a worker's two kinds, each written live and as its snapshot.
 * @param {any} plan
 * @param {string} first
 * @param {string} second
 * @returns {[number, Buffer][]}
 */
function frameWrites(plan, first, second) {
  return [
    [plan.locations[first][0], plan[first][0].frame],
    [plan.locations[first][1], plan[first][1].frame],
    [plan.locations[`${first}Snapshot`][0], plan[first][0].frame],
    [plan.locations[`${first}Snapshot`][1], plan[first][1].frame],
    [plan.locations[second][0], plan[second][0].frame],
    [plan.locations[second][1], plan[second][1].frame],
    [plan.locations[`${second}Snapshot`][0], plan[second][0].frame],
    [plan.locations[`${second}Snapshot`][1], plan[second][1].frame]
  ];
}

/**
 * @param {number} sdk
 * @param {number} base The worker's allocation.
 * @returns {Buffer} The longjmp context of the worker's exit frame.
 */
function exitContext(sdk, base) {
  const bytes = Buffer.alloc(EXIT_CONTEXT_BYTES);
  bytes.writeBigUInt64LE(BigInt(sdk + CODE.exit.offset), CONTEXT_X30);
  bytes.writeBigUInt64LE(BigInt(base + EXIT_STACK_OFFSET), CONTEXT_SP);
  return bytes;
}

/**
 * @param {any} initial
 * @param {number} maxAccessUnit
 * @returns {boolean} True unless `initial` is a valid first access unit.
 */
function isInvalidFirstUnit(initial, maxAccessUnit) {
  return (
    !initial ||
    initial.sequence !== 1 ||
    !Number.isInteger(initial.length) ||
    initial.length < 1 ||
    initial.length > maxAccessUnit ||
    typeof initial.pts !== 'bigint' ||
    initial.pts < 0n ||
    initial.pts > MAX_PTS
  );
}

/**
 * The descriptors written before the workers start, at gates.WRITE_OFFSET: the first input
 * descriptor carries AU 1, both input descriptors name the ignored fetch gate, and the output
 * descriptors hold placeholders for outputs 1 and 2.
 * @param {{sequence: number, length: number, pts: bigint}} initial
 * @param {number} control
 * @returns {Buffer}
 */
function startDescriptors(initial, control) {
  const descriptors = Buffer.alloc(gates.WRITE_BYTES);
  descriptors.writeUInt32LE(initial.sequence, inputPlan.DESCRIPTOR.sequence);
  descriptors.writeUInt32LE(initial.length, inputPlan.DESCRIPTOR.length);
  descriptors.writeBigUInt64LE(initial.pts, inputPlan.DESCRIPTOR.pts);
  for (const slot of inputPlan.CONTROL.descriptors)
    descriptors.writeBigUInt64LE(
      BigInt(control + inputPlan.CONTROL.ignoredFetchGate),
      slot - gates.WRITE_OFFSET + inputPlan.DESCRIPTOR.fetchGate
    );
  for (const sequence of [1, 2]) {
    const descriptor = outputPlan.placeholderDescriptor(sequence);
    descriptor.copy(
      descriptors,
      outputPlan.CONTROL.descriptors[(sequence - 1) % 2] - gates.WRITE_OFFSET
    );
  }
  return descriptors;
}

/**
 * Both output descriptors for a tail drain: output `sequence` and the next one's placeholder.
 * @param {number} sequence
 * @param {Buffer} descriptor
 * @returns {Buffer}
 */
function drainDescriptors(sequence, descriptor) {
  const slot = (sequence - 1) % 2;
  const bytes = Buffer.alloc(2 * outputPlan.DESCRIPTOR.size);
  descriptor.copy(bytes, slot * outputPlan.DESCRIPTOR.size);
  outputPlan
    .placeholderDescriptor(sequence + 1)
    .copy(bytes, (1 - slot) * outputPlan.DESCRIPTOR.size);
  return bytes;
}

/**
 * @param {{index: number, address: number, capacity: number}} slot
 * @returns {boolean}
 */
function isInvalidInputBuffer(slot) {
  return (
    !Number.isSafeInteger(slot.address) ||
    slot.address <= 0 ||
    !Number.isSafeInteger(slot.capacity) ||
    slot.capacity < 1
  );
}

/**
 * @param {Buffer} acquired The acquire status words.
 * @param {Buffer} fetched The fetch sequence.
 * @returns {boolean} True when the output worker acquired an output it never fetched.
 */
function holdsOutput(acquired, fetched) {
  const sequence = acquired.readUInt32LE(ACQUIRED.sequence);
  return Boolean(
    sequence &&
      fetched.readUInt32LE() !== sequence &&
      acquired.readBigUInt64LE(ACQUIRED.status) === 0n &&
      acquired.readInt32LE(ACQUIRED.index) >= 0
  );
}

/**
 * Verifies the code, copy and preamble the frames run through and the movie module's
 * RegisterClientEvents, and resolves the sync functions the workers call.
 * @param {StaggeredRpc} rpc
 * @param {{base: number, symbols: any[]}} module
 * @returns {Promise<Record<string, number>>}
 */
async function verifySetup(rpc, module) {
  const sdk = rpc.a.sdk;
  await verifyCode(rpc);
  await verifyCopy(rpc);
  await verifyPreamble(rpc);
  /** @type {Record<string, number>} */
  const sync = {};
  for (const name of SYNC_FUNCTIONS) {
    await verify(rpc, sdk + SYNC[name].offset, SYNC[name].hex);
    sync[name] = sdk + SYNC[name].offset;
  }
  const registration = MOVIE_EVENTS.registerClientEvents;
  if (!hasRegistration(module, registration))
    throw Error('The loaded movie module has no matching RegisterClientEvents');
  await verify(rpc, module.base + registration.offset, registration.hex);
  return sync;
}

/**
 * Allocates both workers' frame regions, the shared control page and the receive scratch.
 * @param {StaggeredRpc} rpc
 * @param {NativeTransport} transport
 */
async function allocateRegions(rpc, transport) {
  const inputBase = await allocate(rpc, WORKER_BYTES, {
    failed: 'Staggered input worker allocation failed',
    invalid: 'Invalid staggered input worker allocation'
  });
  const outputBase = await allocate(rpc, WORKER_BYTES, {
    failed: 'Staggered output worker allocation failed',
    invalid: 'Invalid staggered output worker allocation'
  });
  const control = await allocate(rpc, CONTROL_BYTES, {
    failed: 'Staggered control allocation failed',
    invalid: 'Invalid staggered control allocation'
  });
  const scratch = await allocate(rpc, transport.maxAccessUnit, {
    failed: 'Staggered receive scratch allocation failed',
    invalid: 'Invalid staggered receive scratch allocation'
  });
  return {inputBase, outputBase, control, scratch};
}

/**
 * Writes the initial control page and initializes its gates and events.
 * @param {StaggeredRpc} rpc
 * @param {Record<string, number>} sync
 * @param {number} control
 * @param {boolean} gateOnReceive
 * @returns {Promise<{offset: number, finalize: number}[]>} The events in initialization order.
 */
async function initializeControl(rpc, sync, control, gateOnReceive) {
  const at = offset => control + offset;
  await rpc.write(control, initialControl(control));
  const initialized = [];
  for (const [offset, signalled] of [
    [inputPlan.CONTROL.decodeGate, 0],
    [inputPlan.CONTROL.ignoredFetchGate, 0],
    [outputPlan.CONTROL.fetchGate, 0],
    [ACQUIRE_ACK, 1],
    ...(gateOnReceive ? [[inputPlan.CONTROL.lengthGate, 1]] : [])
  ]) {
    await rpc.callAddress(sync.initializeLightEvent, [at(offset), signalled, AUTO_CLEAR, 0], SHORT);
    initialized.push({offset, finalize: sync.finalizeLightEvent});
  }
  await rpc.callAddress(sync.initializeEvent, [at(OUTPUT_EVENT), 0, AUTO_CLEAR, 0], SHORT);
  initialized.push({offset: OUTPUT_EVENT, finalize: sync.finalizeEvent});
  return initialized;
}

/**
 * Plans both workers' frames over the allocated regions.
 * @param {object} options
 * @param {number} options.sdk
 * @param {Awaited<ReturnType<typeof allocateRegions>>} options.regions
 * @param {NativeTransport} options.transport
 * @param {Publication} options.publication
 * @param {Record<string, number>} options.functions
 * @param {number} options.decoder
 * @param {number} options.output
 * @param {number} options.format
 * @param {boolean} options.gateOnReceive
 * @returns {WorkerState[]} The input worker, then the output worker.
 */
function planWorkers({
  sdk,
  regions,
  transport,
  publication,
  functions,
  decoder,
  output,
  format,
  gateOnReceive
}) {
  const {inputBase, outputBase, control, scratch} = regions;
  const at = offset => control + offset;
  const input = inputPlan.plan({
    sdk,
    base: inputBase,
    control,
    mapped: publication.mapped,
    scratch,
    fd: transport.fd,
    recvFunction: transport.recvFunction,
    functions,
    decoder,
    acquireAck: at(ACQUIRE_ACK),
    ...(gateOnReceive && {lengthGate: at(inputPlan.CONTROL.lengthGate)})
  });
  const video = outputPlan.plan({
    sdk,
    base: outputBase,
    control,
    mapped: publication.mapped,
    event: at(OUTPUT_EVENT),
    acquireAck: at(ACQUIRE_ACK),
    functions,
    decoder,
    output,
    format
  });
  return [
    {name: 'input', base: inputBase, plan: input, thread: null, joined: false, uncertain: false},
    {name: 'output', base: outputBase, plan: video, thread: null, joined: false, uncertain: false}
  ];
}

/**
 * Verifies the native code both workers rely on, allocates and initializes their control page
 * and plans their frames. Nothing runs until start().
 * @param {object} options
 * @param {StaggeredRpc} options.rpc
 * @param {{base: number, symbols: any[]}} options.module The loaded movie module.
 * @param {Record<string, number>} options.functions Movie decoder function addresses.
 * @param {number} options.decoder
 * @param {number} options.output The movie Buffer the fetch frame fills.
 * @param {number} options.format The MediaData the fetch frame fills.
 * @param {NativeTransport} options.transport
 * @param {Publication} options.publication
 * @param {number} [options.stopTimeoutMs]
 * @param {boolean} [options.gateOnReceive] each receive waits for primeInput (see
 *   staggered-input-plan.js)
 */
async function create({
  rpc,
  module,
  functions,
  decoder,
  output,
  format,
  transport,
  publication,
  stopTimeoutMs = 5000,
  gateOnReceive = false
}) {
  if (isUnboundedSetup(transport, publication))
    throw Error('Staggered worker needs bounded TCP and native publication');
  const sdk = rpc.a.sdk;
  const sync = await verifySetup(rpc, module);
  const regions = await allocateRegions(rpc, transport);
  const {control} = regions;
  const at = offset => control + offset;
  const initialized = await initializeControl(rpc, sync, control, gateOnReceive);
  /** @type {WorkerState[]} */
  const workers = planWorkers({
    sdk,
    regions,
    transport,
    publication,
    functions,
    decoder,
    output,
    format,
    gateOnReceive
  });
  const [inputWorker, outputWorker] = workers;
  const input = inputWorker.plan;
  const video = outputWorker.plan;
  let started = false;
  let stopped = false;
  let closed = false;
  let retained = false;
  let decodeGateSignals = 0;
  let inputBufferCreated = false;
  const cachedInputs = new Map();

  async function destroyInputBuffer() {
    if (!inputBufferCreated) return;
    await rpc.callAddress(functions.bufferDestroy, [at(INPUT_BUFFER)], SHORT);
    inputBufferCreated = false;
    cachedInputs.clear();
  }

  /**
   * Writes a worker's frames and snapshots, reads the snapshots back and writes its exit.
   * @param {WorkerState} worker
   * @param {string} first
   * @param {string} second
   */
  async function install(worker, first, second) {
    const plan = worker.plan;
    for (const [address, bytes] of frameWrites(plan, first, second))
      await rpc.write(address, bytes);
    for (const name of [first, second]) {
      for (let slot = 0; slot < 2; slot++) {
        const bytes = plan[name][slot].frame;
        const actual = await rpc.read(plan.locations[`${name}Snapshot`][slot], bytes.length);
        if (!actual.equals(bytes)) throw Error(`Staggered ${worker.name} frame readback differs`);
      }
    }
    await rpc.write(plan.locations.exit, exitContext(sdk, worker.base));
  }

  /**
   * The dispatch words. Running, each send and fetch dispatch leads to its own slot's frame
   * and each receive and acquire dispatch to the other slot's; stopping, all lead to the exit.
   * @param {boolean} [stopping]
   * @returns {Buffer}
   */
  function dispatchBytes(stopping = false) {
    const bytes = Buffer.alloc(DISPATCH_BYTES);
    const pairs = [
      [inputPlan.CONTROL.sendDispatch, input.locations.send, input.locations.exit],
      [
        inputPlan.CONTROL.receiveDispatch,
        [input.locations.receive[1], input.locations.receive[0]],
        input.locations.exit
      ],
      [outputPlan.CONTROL.fetchDispatch, video.locations.fetch, video.locations.exit],
      [
        outputPlan.CONTROL.acquireDispatch,
        [video.locations.acquire[1], video.locations.acquire[0]],
        video.locations.exit
      ]
    ];
    for (const [offsets, destinations, exit] of pairs)
      for (let slot = 0; slot < 2; slot++)
        bytes.writeBigUInt64LE(
          BigInt(stopping ? exit : destinations[slot]),
          offsets[slot] - DISPATCH_OFFSET
        );
    return bytes;
  }

  /**
   * Points the worker's dispatches at its exit, wakes whatever it may be parked on, then
   * waits for and joins its thread. Any failure retains the native objects.
   * @param {WorkerState} worker
   */
  async function stopWorker(worker) {
    if (!worker.thread || worker.joined) return;
    try {
      const offsets =
        worker === inputWorker
          ? [...inputPlan.CONTROL.sendDispatch, ...inputPlan.CONTROL.receiveDispatch]
          : [...outputPlan.CONTROL.fetchDispatch, ...outputPlan.CONTROL.acquireDispatch];
      for (const offset of offsets)
        await rpc.write(at(offset), addressWord(worker.plan.locations.exit));
      if (worker === inputWorker) {
        transport.abort();
        await rpc.callAddress(sync.signalLightEvent, [at(inputPlan.CONTROL.decodeGate)], SHORT);
        await rpc.callAddress(sync.signalLightEvent, [at(ACQUIRE_ACK)], SHORT);
        if (gateOnReceive)
          await rpc.callAddress(sync.signalLightEvent, [at(inputPlan.CONTROL.lengthGate)], SHORT);
      } else {
        await rpc.callAddress(sync.signalEvent, [at(OUTPUT_EVENT)], SHORT);
        await rpc.callAddress(sync.signalLightEvent, [at(outputPlan.CONTROL.fetchGate)], SHORT);
      }
      const done = await wait(rpc, worker.thread, {
        timeoutMs: stopTimeoutMs,
        pollMs: STOP_POLL_MS,
        invalid: 'Staggered worker state invalid',
        outputBytes: SHORT
      });
      if (!done) throw Error(`Staggered ${worker.name} did not stop; restart SmileBASIC`);
      await join(rpc, worker.thread, worker.base + EXIT_SLOT_OFFSET, {
        failed: `Staggered ${worker.name} pthread join failed`,
        outputBytes: SHORT
      });
      worker.joined = true;
    } catch (error) {
      retained = true;
      throw error;
    }
  }

  return {
    get outputEvent() {
      return at(OUTPUT_EVENT);
    },
    get diagnostics() {
      return {started, retained, decodeGateSignals, joined: workers.map(item => item.joined)};
    },

    /** Hands the decoder the client events, so outputs signal the output event. */
    async register() {
      const {result} = await rpc.callAddress(
        module.base + MOVIE_EVENTS.registerClientEvents.offset,
        [decoder, at(DECODER_EVENTS)],
        SHORT
      );
      if (resultCode(result) !== 0) throw Error('Staggered RegisterClientEvents failed');
    },

    /**
     * Installs both workers, writes the first descriptors and clears the status, then spawns
     * the input worker on its first receive frame and the output worker on its first acquire.
     * @param {{sequence: number, length: number, pts: bigint}} initial The first access unit.
     */
    async start(initial) {
      if (
        started ||
        stopped ||
        closed ||
        retained ||
        isInvalidFirstUnit(initial, transport.maxAccessUnit)
      )
        throw Error('Invalid first staggered access unit');
      await install(inputWorker, 'receive', 'send');
      await install(outputWorker, 'acquire', 'fetch');
      await rpc.write(at(DISPATCH_OFFSET), dispatchBytes());
      await rpc.write(at(gates.WRITE_OFFSET), startDescriptors(initial, control));
      await rpc.write(
        publication.mapped + status.STATUS.receive,
        Buffer.alloc(status.READ_END - status.STATUS.receive)
      );
      await rpc.callAddress(sync.clearEvent, [at(OUTPUT_EVENT)], SHORT);
      try {
        for (const worker of workers) {
          worker.uncertain = true;
          const entry = worker.plan.locations[worker === inputWorker ? 'receive' : 'acquire'][0];
          worker.thread = await spawn(rpc, worker.base, entry, {
            failed: `Staggered ${worker.name} worker creation failed`,
            outputBytes: SHORT
          });
          worker.uncertain = false;
        }
      } catch (error) {
        retained = workers.some(worker => worker.uncertain);
        throw error;
      }
      started = true;
    },

    /** @returns {Promise<import('./staggered-status.js').Snapshot>} */
    async readStatus() {
      const bytes = await rpc.read(
        publication.mapped + status.READ_START,
        status.READ_END - status.READ_START
      );
      return status.parse(bytes);
    },

    /**
     * Writes the checked gate descriptors and signals the decode gate in one exchange.
     * @param {any} options gates.gateWrite's options, less the gates and publication.
     */
    async openGates({holdFetch = false, ...options}) {
      if (!started || closed || retained || workers.some(worker => worker.joined))
        throw Error('Staggered gates are unavailable');
      const encoded = gates.gateWrite({
        ...options,
        fetchGate: at(
          holdFetch ? inputPlan.CONTROL.ignoredFetchGate : outputPlan.CONTROL.fetchGate
        ),
        ignoredFetchGate: at(inputPlan.CONTROL.ignoredFetchGate),
        publication
      });
      try {
        await rpc.writeAndCall(at(encoded.offset), encoded.bytes, sync.signalLightEvent, [
          at(inputPlan.CONTROL.decodeGate)
        ]);
      } catch (error) {
        retained = true;
        throw error;
      }
      decodeGateSignals++;
    },

    /**
     * Under gate on receive: writes access unit `unit`'s descriptor and signals the length gate
     * in one exchange, before the unit is sent. The caller primes a unit only once the unit two
     * before it, whose descriptor slot it reuses, is submitted: checked by its gate, or under the
     * gate queue implied by a status read that saw the unit before it received.
     * @param {{sequence: number, length: number, pts: bigint}} unit
     */
    async primeInput(unit) {
      if (!gateOnReceive || !started || closed || retained || inputWorker.joined)
        throw Error('Staggered input prime is unavailable');
      const encoded = inputPlan.primeWrite(unit, at(inputPlan.CONTROL.ignoredFetchGate));
      try {
        await rpc.writeAndCall(at(encoded.offset), encoded.bytes, sync.signalLightEvent, [
          at(inputPlan.CONTROL.lengthGate)
        ]);
      } catch (error) {
        retained = true;
        throw error;
      }
    },

    /**
     * After the input worker stopped: fetches one checked tail output into `destination` and
     * opens the fetch gate in one exchange.
     */
    async drainOutput({snapshot, expected, destination, frame}) {
      if (!started || stopped || closed || retained || outputWorker.joined)
        throw Error('Staggered output drain is unavailable');
      status.checkOutput(snapshot, expected);
      const sequence = expected.acquire.sequence;
      const descriptor = outputPlan.outputDescriptor({
        auSequence: sequence,
        destination,
        frame,
        publication
      });
      const bytes = drainDescriptors(sequence, descriptor);
      try {
        await rpc.writeAndCall(
          at(outputPlan.CONTROL.descriptors[0]),
          bytes,
          sync.signalLightEvent,
          [at(outputPlan.CONTROL.fetchGate)]
        );
      } catch (error) {
        retained = true;
        throw error;
      }
    },

    /**
     * Looks up decoder input buffer `index` once and caches its address and capacity.
     * @param {number} index
     * @returns {Promise<{index: number, address: number, capacity: number}>}
     */
    async inputSlot(index) {
      if (!started || stopped || closed || retained || !Number.isInteger(index) || index < 0)
        throw Error('Staggered input slot is unavailable');
      if (cachedInputs.has(index)) return cachedInputs.get(index);
      if (!inputBufferCreated) {
        await rpc.callAddress(functions.bufferCreate, [at(INPUT_BUFFER)], SHORT);
        inputBufferCreated = true;
      }
      const {result: got} = await rpc.callAddress(
        functions.getInput,
        [decoder, index, at(INPUT_BUFFER)],
        SHORT
      );
      if (resultCode(got) !== 0) throw Error('Staggered decoder input buffer lookup failed');
      const {result: pointer} = await rpc.callAddress(
        functions.bufferData,
        [at(INPUT_BUFFER)],
        SHORT
      );
      const {result: capacityValue} = await rpc.callAddress(
        functions.bufferCapacity,
        [at(INPUT_BUFFER)],
        SHORT
      );
      const slot = {index, address: Number(pointer), capacity: Number(capacityValue)};
      if (isInvalidInputBuffer(slot)) throw Error('Invalid staggered decoder input buffer');
      cachedInputs.set(index, slot);
      return slot;
    },

    /**
     * Repeats the input worker's next-slot acquire for `sequence` from the host, when the
     * worker found no free slot, and stamps the new result where the worker would have.
     * @param {number} sequence
     * @returns {Promise<{status: number, index: number}>}
     */
    async retryInputSlot(sequence) {
      if (!started || stopped || closed || retained || !Number.isInteger(sequence) || sequence < 1)
        throw Error('Staggered input slot retry is unavailable');
      const prior = await rpc.read(publication.mapped + NEXT_SLOT.offset, NEXT_SLOT.bytes);
      const priorStatus = prior.readBigUInt64LE(NEXT_SLOT.status);
      if (
        prior.readUInt32LE(NEXT_SLOT.sequence) !== sequence ||
        prior.readInt32LE(NEXT_SLOT.index) >= 0 ||
        !NO_INPUT_SLOT.includes(priorStatus)
      )
        throw Error('Staggered input slot retry does not match a pending sequence');
      const {result} = await rpc.callAddress(
        functions.acquireInput,
        [decoder, publication.mapped + NEXT_INDEX, publication.mapped + INPUT_COUNT, 0],
        SHORT
      );
      const value = Buffer.alloc(8);
      value.writeBigUInt64LE(BigInt.asUintN(64, result));
      await rpc.write(publication.mapped + NEXT_SLOT.offset, value);
      return {
        status: resultCode(result),
        index: (await rpc.read(publication.mapped + NEXT_INDEX, 4)).readInt32LE()
      };
    },

    stopInput: () => stopWorker(inputWorker),
    stopOutput: () => stopWorker(outputWorker),

    /**
     * Stops both workers, releases an output the output worker still holds and destroys the
     * input lookup buffer.
     */
    async stop() {
      if (retained || workers.some(worker => worker.uncertain))
        throw Error('Staggered worker state uncertain; native objects retained');
      if (stopped) return;
      if (!started) {
        await destroyInputBuffer();
        stopped = true;
        return;
      }
      await stopWorker(inputWorker);
      await stopWorker(outputWorker);
      const acquired = await rpc.read(publication.mapped + ACQUIRED.offset, ACQUIRED.bytes);
      const fetched = await rpc.read(publication.mapped + FETCH_SEQUENCE, SEQUENCE_BYTES);
      if (holdsOutput(acquired, fetched)) {
        const {result} = await rpc.callAddress(
          functions.releaseOutput,
          [decoder, acquired.readInt32LE(ACQUIRED.index), 0, 0],
          SHORT
        );
        if (resultCode(result) !== 0) {
          retained = true;
          throw Error('Staggered held output release failed');
        }
      }
      await destroyInputBuffer();
      stopped = true;
    },

    /** Finalizes the events, then frees the regions, once no worker can be running. */
    async finalize() {
      if (retained || workers.some(worker => worker.uncertain || (worker.thread && !worker.joined)))
        throw Error('Staggered events retained while a worker may be running');
      if (closed) return;
      await destroyInputBuffer();
      for (const item of initialized.reverse())
        await rpc.callAddress(item.finalize, [at(item.offset)], SHORT);
      closed = true;
      const {inputBase, outputBase, control, scratch} = regions;
      for (const base of [scratch, control, outputBase, inputBase]) await release(rpc, base);
    }
  };
}

export {ACQUIRE_ACK, create};
