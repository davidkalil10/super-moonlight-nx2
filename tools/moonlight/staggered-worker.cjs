const {allocate} = require('../../sdk/native/allocate.cjs');
const {verify} = require('../../sdk/native/symbols.cjs');
const {CODE, verifyCode, verifyCopy, verifyPreamble, spawn, wait, join} = require('../../sdk/native/thread.cjs');
const SYNC = require('../../sdk/native/os-sync-functions.json');
const MOVIE_EVENTS = require('../../sdk/native/movie-event-functions.json');
const inputPlan = require('./staggered-input-plan.cjs');
const outputPlan = require('./staggered-output-plan.cjs');
const gates = require('./staggered-gate.cjs');
const status = require('./staggered-status.cjs');

const CONTROL_BYTES = 0x1000;
const OUTPUT_EVENT = 0x400;
const DECODER_EVENTS = 0x440;
const INPUT_BUFFER = 0x500;
const SHORT = 2;
const AUTO_CLEAR = 1;

async function create({
  rpc,
  module,
  functions,
  decoder,
  output,
  format,
  transport,
  publication,
  stopTimeoutMs = 5000
}) {
  if (
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
  )
    throw Error('Staggered worker needs bounded TCP and native publication');
  const sdk = rpc.a.sdk;
  await verifyCode(rpc);
  await verifyCopy(rpc);
  await verifyPreamble(rpc);
  const sync = {};
  for (const name of [
    'initializeLightEvent',
    'waitLightEvent',
    'signalLightEvent',
    'finalizeLightEvent',
    'initializeEvent',
    'clearEvent',
    'signalEvent',
    'waitEvent',
    'finalizeEvent'
  ]) {
    await verify(rpc, sdk + SYNC[name].offset, SYNC[name].hex);
    sync[name] = sdk + SYNC[name].offset;
  }
  const registration = MOVIE_EVENTS.registerClientEvents;
  if (
    !module.symbols.some(
      symbol =>
        symbol.name === registration.symbol &&
        symbol.section &&
        symbol.offset === registration.offset &&
        symbol.size === registration.size
    )
  )
    throw Error('The loaded movie module has no matching RegisterClientEvents');
  await verify(rpc, module.base + registration.offset, registration.hex);

  const inputBase = await allocate(rpc, 0x400000, {
    failed: 'Staggered input worker allocation failed',
    invalid: 'Invalid staggered input worker allocation'
  });
  const outputBase = await allocate(rpc, 0x400000, {
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
  const at = offset => control + offset;
  const initialControl = Buffer.alloc(CONTROL_BYTES);
  initialControl.writeBigUInt64LE(BigInt(at(OUTPUT_EVENT)), DECODER_EVENTS + 8);
  await rpc.write(control, initialControl);
  const initialized = [];
  for (const offset of [
    inputPlan.CONTROL.decodeGate,
    inputPlan.CONTROL.ignoredFetchGate,
    outputPlan.CONTROL.fetchGate
  ]) {
    await rpc.callAddress(sync.initializeLightEvent, [at(offset), 0, AUTO_CLEAR, 0], SHORT);
    initialized.push({offset, finalize: sync.finalizeLightEvent});
  }
  await rpc.callAddress(sync.initializeEvent, [at(OUTPUT_EVENT), 0, AUTO_CLEAR, 0], SHORT);
  initialized.push({offset: OUTPUT_EVENT, finalize: sync.finalizeEvent});

  const input = inputPlan.plan({
    sdk,
    base: inputBase,
    control,
    mapped: publication.mapped,
    scratch,
    fd: transport.fd,
    recvFunction: transport.recvFunction,
    functions,
    decoder
  });
  const video = outputPlan.plan({
    sdk,
    base: outputBase,
    control,
    mapped: publication.mapped,
    event: at(OUTPUT_EVENT),
    functions,
    decoder,
    output,
    format
  });
  const workers = [
    {name: 'input', base: inputBase, plan: input, thread: null, joined: false, uncertain: false},
    {name: 'output', base: outputBase, plan: video, thread: null, joined: false, uncertain: false}
  ];
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

  async function install(worker, first, second) {
    const plan = worker.plan;
    for (const [address, bytes] of [
      [plan.locations[first][0], plan[first][0].frame],
      [plan.locations[first][1], plan[first][1].frame],
      [plan.locations[`${first}Snapshot`][0], plan[first][0].frame],
      [plan.locations[`${first}Snapshot`][1], plan[first][1].frame],
      [plan.locations[second][0], plan[second][0].frame],
      [plan.locations[second][1], plan[second][1].frame],
      [plan.locations[`${second}Snapshot`][0], plan[second][0].frame],
      [plan.locations[`${second}Snapshot`][1], plan[second][1].frame]
    ])
      await rpc.write(address, bytes);
    for (const name of [first, second]) {
      for (let slot = 0; slot < 2; slot++) {
        const bytes = plan[name][slot].frame;
        const actual = await rpc.read(plan.locations[`${name}Snapshot`][slot], bytes.length);
        if (!actual.equals(bytes)) throw Error(`Staggered ${worker.name} frame readback differs`);
      }
    }
    const exit = Buffer.alloc(0xb0);
    exit.writeBigUInt64LE(BigInt(sdk + CODE.exit.offset), 0x58);
    exit.writeBigUInt64LE(BigInt(worker.base + 0x370000), 0x68);
    await rpc.write(plan.locations.exit, exit);
  }

  function dispatchBytes(stopping = false) {
    const bytes = Buffer.alloc(0x40);
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
        bytes.writeBigUInt64LE(BigInt(stopping ? exit : destinations[slot]), offsets[slot] - 0x40);
    return bytes;
  }

  async function stopWorker(worker) {
    if (!worker.thread || worker.joined) return;
    try {
      const offsets = worker === workers[0]
        ? [...inputPlan.CONTROL.sendDispatch, ...inputPlan.CONTROL.receiveDispatch]
        : [...outputPlan.CONTROL.fetchDispatch, ...outputPlan.CONTROL.acquireDispatch];
      for (const offset of offsets) {
        const destination = Buffer.alloc(8);
        destination.writeBigUInt64LE(BigInt(worker.plan.locations.exit));
        await rpc.write(at(offset), destination);
      }
      if (worker === workers[0]) {
        transport.abort();
        await rpc.callAddress(sync.signalLightEvent, [at(inputPlan.CONTROL.decodeGate)], SHORT);
      } else {
        await rpc.callAddress(sync.signalEvent, [at(OUTPUT_EVENT)], SHORT);
        await rpc.callAddress(sync.signalLightEvent, [at(outputPlan.CONTROL.fetchGate)], SHORT);
      }
      const done = await wait(rpc, worker.thread, {
        timeoutMs: stopTimeoutMs,
        pollMs: 5,
        invalid: 'Staggered worker state invalid',
        outputBytes: SHORT
      });
      if (!done) throw Error(`Staggered ${worker.name} did not stop; restart SmileBASIC`);
      await join(rpc, worker.thread, worker.base + 8, {
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
    async register() {
      const {result} = await rpc.callAddress(
        module.base + registration.offset,
        [decoder, at(DECODER_EVENTS)],
        SHORT
      );
      if (Number(BigInt.asUintN(32, result)) !== 0)
        throw Error('Staggered RegisterClientEvents failed');
    },
    async start(initial) {
      if (
        started ||
        stopped ||
        closed ||
        retained ||
        !initial ||
        initial.sequence !== 1 ||
        !Number.isInteger(initial.length) ||
        initial.length < 1 ||
        initial.length > transport.maxAccessUnit ||
        typeof initial.pts !== 'bigint' ||
        initial.pts < 0n ||
        initial.pts > 0xffffffffffffffffn
      )
        throw Error('Invalid first staggered access unit');
      await install(workers[0], 'receive', 'send');
      await install(workers[1], 'acquire', 'fetch');
      await rpc.write(at(0x40), dispatchBytes());
      const descriptors = Buffer.alloc(gates.WRITE_BYTES);
      descriptors.writeUInt32LE(initial.sequence, 0);
      descriptors.writeUInt32LE(initial.length, 4);
      descriptors.writeBigUInt64LE(initial.pts, 8);
      descriptors.writeBigUInt64LE(BigInt(at(inputPlan.CONTROL.ignoredFetchGate)), 32);
      for (const sequence of [1, 2]) {
        const descriptor = outputPlan.placeholderDescriptor(sequence);
        descriptor.copy(
          descriptors,
          outputPlan.CONTROL.descriptors[(sequence - 1) % 2] - gates.WRITE_OFFSET
        );
      }
      await rpc.write(at(gates.WRITE_OFFSET), descriptors);
      await rpc.write(
        publication.mapped + status.STATUS.receive,
        Buffer.alloc(status.READ_END - status.STATUS.receive)
      );
      await rpc.callAddress(sync.clearEvent, [at(OUTPUT_EVENT)], SHORT);
      try {
        for (const worker of workers) {
          worker.uncertain = true;
          const entry = worker.plan.locations[worker === workers[0] ? 'receive' : 'acquire'][0];
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
    async readStatus() {
      const bytes = await rpc.read(
        publication.mapped + status.READ_START,
        status.READ_END - status.READ_START
      );
      return status.parse(bytes);
    },
    async openGates(options) {
      if (!started || closed || retained || workers.some(worker => worker.joined))
        throw Error('Staggered gates are unavailable');
      const encoded = gates.gateWrite({
        ...options,
        fetchGate: at(outputPlan.CONTROL.fetchGate),
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
      if (Number(BigInt.asUintN(32, got)) !== 0)
        throw Error('Staggered decoder input buffer lookup failed');
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
      if (
        !Number.isSafeInteger(slot.address) ||
        slot.address <= 0 ||
        !Number.isSafeInteger(slot.capacity) ||
        slot.capacity < 1
      )
        throw Error('Invalid staggered decoder input buffer');
      cachedInputs.set(index, slot);
      return slot;
    },
    async retryInputSlot(sequence) {
      if (
        !started ||
        stopped ||
        closed ||
        retained ||
        !Number.isInteger(sequence) ||
        sequence < 1
      )
        throw Error('Staggered input slot retry is unavailable');
      const prior = await rpc.read(publication.mapped + status.STATUS.input + 8, 16);
      const priorStatus = prior.readBigUInt64LE(0);
      if (
        prior.readUInt32LE(12) !== sequence ||
        prior.readInt32LE(8) >= 0 ||
        ![0x100en, 0x1011n].includes(priorStatus)
      )
        throw Error('Staggered input slot retry does not match a pending sequence');
      const {result} = await rpc.callAddress(
        functions.acquireInput,
        [
          decoder,
          publication.mapped + status.STATUS.input + 16,
          publication.mapped + status.STATUS.input + 24,
          0
        ],
        SHORT
      );
      const value = Buffer.alloc(8);
      value.writeBigUInt64LE(BigInt.asUintN(64, result));
      await rpc.write(publication.mapped + status.STATUS.input + 8, value);
      return {
        status: Number(BigInt.asUintN(32, result)),
        index: (await rpc.read(publication.mapped + status.STATUS.input + 16, 4)).readInt32LE()
      };
    },
    stopInput: () => stopWorker(workers[0]),
    stopOutput: () => stopWorker(workers[1]),
    async stop() {
      if (retained || workers.some(worker => worker.uncertain))
        throw Error('Staggered worker state uncertain; native objects retained');
      if (stopped) return;
      if (!started) {
        await destroyInputBuffer();
        stopped = true;
        return;
      }
      await stopWorker(workers[0]);
      await stopWorker(workers[1]);
      const acquired = await rpc.read(publication.mapped + status.STATUS.acquire, 28);
      const fetched = await rpc.read(publication.mapped + status.STATUS.fetch + 24, 4);
      const sequence = acquired.readUInt32LE(24);
      if (
        sequence &&
        fetched.readUInt32LE() !== sequence &&
        acquired.readBigUInt64LE() === 0n &&
        acquired.readInt32LE(8) >= 0
      ) {
        const {result} = await rpc.callAddress(
          functions.releaseOutput,
          [decoder, acquired.readInt32LE(8), 0, 0],
          SHORT
        );
        if (Number(BigInt.asUintN(32, result)) !== 0) {
          retained = true;
          throw Error('Staggered held output release failed');
        }
      }
      await destroyInputBuffer();
      stopped = true;
    },
    async finalize() {
      if (retained || workers.some(worker => worker.uncertain || (worker.thread && !worker.joined)))
        throw Error('Staggered events retained while a worker may be running');
      if (closed) return;
      await destroyInputBuffer();
      for (const item of initialized.reverse())
        await rpc.callAddress(item.finalize, [at(item.offset)], SHORT);
      closed = true;
    }
  };
}

module.exports = {create};
