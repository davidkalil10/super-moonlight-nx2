const {build} = require('../../smilebasic/engine/shared/frames.cjs');
const {allocate} = require('../../sdk/native/allocate.cjs');
const {verify} = require('../../sdk/native/symbols.cjs');
const {
  CODE,
  IPC_COPY,
  verifyCode,
  verifyCopy,
  verifyPreamble,
  spawn,
  wait,
  join
} = require('../../sdk/native/thread.cjs');
const SYNC = require('../../sdk/native/os-sync-functions.json');
const MOVIE_EVENTS = require('../../sdk/native/movie-event-functions.json');

const CONTROL_BYTES = 0x1000;
const INPUT_GATE = 0x00;
const RECEIVE_DONE = 0x10;
const DECODE_GATE = 0x20;
const INPUT_DONE = 0x30;
const OUTPUT_GATE = 0x40;
const ACQUIRED = 0x50;
const FETCH_GATE = 0x60;
const OUTPUT_DONE = 0x70;
const OUTPUT_EVENT = 0x80;
const DECODER_EVENTS = 0xc0;
const INPUT_DISPATCH = 0x100;
const DECODE_DISPATCH = 0x108;
const OUTPUT_DISPATCH = 0x110;
const FETCH_DISPATCH = 0x118;
const INPUT_JOB = 0x140;
const OUTPUT_JOB = 0x160;
const RECEIVE_RESULTS = 0x180;
const INPUT_RESULTS = 0x1a0;
const OUTPUT_RESULTS = 0x1c0;
const FETCH_RESULTS = 0x1f0;
const SHORT = 2;
const AUTO_CLEAR = 1;
const READ = 0x586fb0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = value => Number(BigInt.asUintN(32, value));

async function create({
  rpc,
  module,
  functions,
  decoder,
  output,
  format,
  transport,
  cancelled = () => false,
  pollTimeoutMs = 5000,
  stopTimeoutMs = 5000
}) {
  if (
    !transport ||
    !Number.isInteger(transport.fd) ||
    transport.fd < 0 ||
    !Number.isInteger(transport.maxAccessUnit) ||
    transport.maxAccessUnit < 1 ||
    !Number.isSafeInteger(transport.recvFunction) ||
    typeof transport.send !== 'function' ||
    typeof transport.abort !== 'function'
  )
    throw Error('Split decoder needs a native TCP transport');

  const sdk = rpc.a.sdk;
  const sync = {};
  await verifyCode(rpc);
  await verifyCopy(rpc);
  await verifyPreamble(rpc);
  for (const name of [
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
  const registerAddress = module.base + registration.offset;
  await verify(rpc, registerAddress, registration.hex);

  const inputBase = await allocate(rpc, 0x400000, {
    failed: 'Split input worker allocation failed',
    invalid: 'Invalid split input worker allocation'
  });
  const outputBase = await allocate(rpc, 0x400000, {
    failed: 'Split output worker allocation failed',
    invalid: 'Invalid split output worker allocation'
  });
  const control = await allocate(rpc, CONTROL_BYTES, {
    failed: 'Split decoder control allocation failed',
    invalid: 'Invalid split decoder control allocation'
  });
  const address = offset => control + offset;
  const block = Buffer.alloc(CONTROL_BYTES);
  block.writeBigUInt64LE(BigInt(address(OUTPUT_EVENT)), DECODER_EVENTS + 8);
  await rpc.write(control, block);
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

  const input = {base: inputBase, thread: null, joined: false, uncertain: false};
  const video = {base: outputBase, thread: null, joined: false, uncertain: false};
  let nextSequence = 0;
  let activeInput = null;
  let activeOutput = null;
  let decodeGateSignals = 0;
  const jump = sdk + CODE.longjmp.offset;
  const copy = sdk + IPC_COPY.offset;
  const frame = (base, calls, results = {}) => {
    const program = build(base, sdk, calls, CODE, false, new Set(Object.values(functions)));
    if (program.frame.length > 0x70000) throw Error('Split decoder frame exceeds its region');
    for (const [call, resultOffset] of Object.entries(results)) {
      const index = program.proof.logicalResultIndices[Number(call)];
      program.frame.writeBigUInt64LE(
        BigInt(address(resultOffset)),
        program.proof.stackOffsets[index] + 0x118
      );
    }
    return program.frame;
  };
  const locations = base => ({
    gate: base + 0x10000,
    gateSnapshot: base + 0x80000,
    first: base + 0x110000,
    firstSnapshot: base + 0x180000,
    second: base + 0x210000,
    secondSnapshot: base + 0x280000,
    exit: base + 0x350000
  });
  const inputAt = locations(inputBase);
  const outputAt = locations(outputBase);

  async function poll(eventOffset, resultOffset, label) {
    const until = Date.now() + pollTimeoutMs;
    while (Date.now() < until && !cancelled()) {
      const reply = await rpc.pair(
        [
          {address: sync.tryWaitLightEvent, args: [address(eventOffset), 0, 0, 0]},
          {offset: READ, args: [rpc.output, address(resultOffset), 44, 0]}
        ],
        44
      );
      if ((reply.results[0] & 0xffn) === 1n) {
        if (reply.results[1] !== BigInt(rpc.output))
          throw Error('Split decoder result read failed');
        return reply.output;
      }
      await sleep(2);
    }
    throw Error(cancelled() ? 'Native decoding cancelled' : `Split decoder ${label} timed out`);
  }

  async function install(worker, frames) {
    const at = locations(worker.base);
    const stop = Buffer.alloc(0xb0);
    stop.writeBigUInt64LE(BigInt(sdk + CODE.exit.offset), 0x58);
    stop.writeBigUInt64LE(BigInt(worker.base + 0x370000), 0x68);
    for (const [destination, bytes] of [
      [at.gate, frames.gate],
      [at.gateSnapshot, frames.gate],
      [at.first, frames.first],
      [at.firstSnapshot, frames.first],
      [at.second, frames.second],
      [at.secondSnapshot, frames.second],
      [at.exit, stop]
    ])
      await rpc.write(destination, bytes);
    for (const [snapshot, bytes] of [
      [at.gateSnapshot, frames.gate],
      [at.firstSnapshot, frames.first],
      [at.secondSnapshot, frames.second]
    ])
      if (!(await rpc.read(snapshot, bytes.length)).equals(bytes))
        throw Error('Split decoder frame snapshot readback differs');
  }

  async function acquiredOutput(job) {
    if (!job || activeOutput !== job || !video.thread || video.joined)
      throw Error('Split output job is not ready');
    const acquired = await poll(ACQUIRED, OUTPUT_RESULTS, 'output acquire');
    if (acquired.readUInt32LE(32) !== job.sequence)
      throw Error('Split decoder acquired the wrong access unit');
    const acquiredStatus = status(acquired.readBigUInt64LE(0));
    const outputIndex = acquired.readInt32LE(8);
    if (acquiredStatus || outputIndex < 0) {
      const value = acquiredStatus || 0x100e;
      throw Object.assign(Error('Split decoder acquire returned 0x' + value.toString(16)), {
        result: value
      });
    }
    return {index: outputIndex, pts: acquired.readBigUInt64LE(16)};
  }

  return {
    async register() {
      const {result} = await rpc.callAddress(
        registerAddress,
        [decoder, address(DECODER_EVENTS)],
        SHORT
      );
      if (status(result) !== 0)
        throw Error('RegisterClientEvents returned 0x' + status(result).toString(16));
    },

    async start() {
      if (input.thread !== null || video.thread !== null)
        throw Error('Split decoder workers already started');
      await rpc.callAddress(sync.clearEvent, [address(OUTPUT_EVENT)], SHORT);
      const inputGate = frame(inputAt.gate, [
        {function: sync.waitLightEvent, args: [address(INPUT_GATE), 0, 0, 0]},
        {function: jump, args: [{u64: address(INPUT_DISPATCH)}, 1, 0, 0]}
      ]);
      const receive = frame(
        inputAt.first,
        [
          {
            function: transport.recvFunction,
            args: [
              transport.fd,
              {u64: address(INPUT_JOB + 24)},
              {u32: address(INPUT_JOB + 8)},
              0x40
            ]
          },
          {function: copy, args: [address(RECEIVE_RESULTS + 8), address(INPUT_JOB), 4, 0]},
          {function: sync.signalLightEvent, args: [address(RECEIVE_DONE), 0, 0, 0]},
          {function: sync.waitLightEvent, args: [address(DECODE_GATE), 0, 0, 0]},
          {function: jump, args: [{u64: address(DECODE_DISPATCH)}, 1, 0, 0]}
        ],
        {0: RECEIVE_RESULTS}
      );
      const inputRestore = [
        {function: copy, args: [inputAt.gate, inputAt.gateSnapshot, inputGate.length, 0]},
        {function: copy, args: [inputAt.first, inputAt.firstSnapshot, receive.length, 0]},
        {function: copy, args: [inputAt.second, inputAt.secondSnapshot, 0, 0]}
      ];
      const sendCalls = [
        {
          function: functions.sendInput,
          args: [
            decoder,
            {u32: address(INPUT_JOB + 4)},
            0,
            {u32: address(INPUT_JOB + 8)},
            {u64: address(INPUT_JOB + 16)},
            0
          ]
        },
        {
          function: functions.acquireInput,
          args: [decoder, address(INPUT_RESULTS + 16), address(INPUT_RESULTS + 20), 0]
        },
        {function: copy, args: [address(INPUT_RESULTS + 24), address(INPUT_JOB), 4, 0]},
        ...inputRestore,
        {function: sync.signalLightEvent, args: [address(INPUT_DONE), 0, 0, 0]},
        {function: jump, args: [inputAt.gate, 1, 0, 0]}
      ];
      let send = frame(inputAt.second, sendCalls, {0: INPUT_RESULTS, 1: INPUT_RESULTS + 8});
      inputRestore[2].args[2] = send.length;
      send = frame(inputAt.second, sendCalls, {0: INPUT_RESULTS, 1: INPUT_RESULTS + 8});

      const outputGate = frame(outputAt.gate, [
        {function: sync.waitLightEvent, args: [address(OUTPUT_GATE), 0, 0, 0]},
        {function: jump, args: [{u64: address(OUTPUT_DISPATCH)}, 1, 0, 0]}
      ]);
      const acquire = frame(
        outputAt.first,
        [
          {function: sync.waitEvent, args: [address(OUTPUT_EVENT), 0, 0, 0]},
          {
            function: functions.acquireOutput,
            args: [
              decoder,
              address(OUTPUT_RESULTS + 8),
              address(OUTPUT_RESULTS + 16),
              address(OUTPUT_RESULTS + 24),
              address(OUTPUT_RESULTS + 28)
            ]
          },
          {function: copy, args: [address(OUTPUT_RESULTS + 32), address(OUTPUT_JOB), 4, 0]},
          {function: sync.signalLightEvent, args: [address(ACQUIRED), 0, 0, 0]},
          {function: sync.waitLightEvent, args: [address(FETCH_GATE), 0, 0, 0]},
          {function: jump, args: [{u64: address(FETCH_DISPATCH)}, 1, 0, 0]}
        ],
        {1: OUTPUT_RESULTS}
      );
      const outputRestore = [
        {function: copy, args: [outputAt.gate, outputAt.gateSnapshot, outputGate.length, 0]},
        {function: copy, args: [outputAt.first, outputAt.firstSnapshot, acquire.length, 0]},
        {function: copy, args: [outputAt.second, outputAt.secondSnapshot, 0, 0]}
      ];
      const fetchCalls = [
        {
          function: functions.bufferSetData,
          args: [output, {u64: address(OUTPUT_JOB + 8)}, {u64: address(OUTPUT_JOB + 16)}, 0]
        },
        {
          function: functions.getOutput,
          args: [decoder, {u32: address(OUTPUT_RESULTS + 8)}, output, format]
        },
        {
          function: functions.releaseOutput,
          args: [decoder, {u32: address(OUTPUT_RESULTS + 8)}, 0, 0]
        },
        {function: copy, args: [address(FETCH_RESULTS + 24), address(OUTPUT_JOB), 4, 0]},
        ...outputRestore,
        {function: sync.signalLightEvent, args: [address(OUTPUT_DONE), 0, 0, 0]},
        {function: jump, args: [outputAt.gate, 1, 0, 0]}
      ];
      let fetch = frame(outputAt.second, fetchCalls, {
        0: FETCH_RESULTS,
        1: FETCH_RESULTS + 8,
        2: FETCH_RESULTS + 16
      });
      outputRestore[2].args[2] = fetch.length;
      fetch = frame(outputAt.second, fetchCalls, {
        0: FETCH_RESULTS,
        1: FETCH_RESULTS + 8,
        2: FETCH_RESULTS + 16
      });

      await install(input, {gate: inputGate, first: receive, second: send});
      await install(video, {gate: outputGate, first: acquire, second: fetch});
      const selectors = Buffer.alloc(32);
      for (const [index, target] of [
        inputAt.first,
        inputAt.second,
        outputAt.first,
        outputAt.second
      ].entries())
        selectors.writeBigUInt64LE(BigInt(target), index * 8);
      await rpc.write(address(INPUT_DISPATCH), selectors);

      input.uncertain = true;
      input.thread = await spawn(rpc, inputBase, inputAt.gate, {
        failed: 'Split input thread creation failed'
      });
      input.uncertain = false;
      video.uncertain = true;
      video.thread = await spawn(rpc, outputBase, outputAt.gate, {
        failed: 'Split output thread creation failed'
      });
      video.uncertain = false;
    },

    async stageInput({index, length, pts, inputAddress, payload}) {
      if (!input.thread || input.joined || activeInput)
        throw Error('Split input worker is not ready');
      if (
        !Buffer.isBuffer(payload) ||
        !payload.length ||
        payload.length !== length ||
        length > transport.maxAccessUnit ||
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
      const job = {sequence, pts: BigInt(pts), length, payload};
      const bytes = Buffer.alloc(32);
      bytes.writeUInt32LE(sequence, 0);
      bytes.writeInt32LE(index, 4);
      bytes.writeUInt32LE(length, 8);
      bytes.writeBigUInt64LE(BigInt(pts), 16);
      bytes.writeBigUInt64LE(BigInt(inputAddress), 24);
      activeInput = job;
      await rpc.writeAndCall(address(INPUT_JOB), bytes, sync.signalLightEvent, [
        address(INPUT_GATE)
      ]);
      return job;
    },

    async completeInput(job, payload = job?.payload) {
      if (!job || activeInput !== job || !input.thread || input.joined)
        throw Error('Split input job is not ready');
      await transport.send(payload);
      const received = await poll(RECEIVE_DONE, RECEIVE_RESULTS, 'TCP receive');
      const count = received.readBigInt64LE(0);
      const receivedSequence = received.readUInt32LE(8);
      if (count !== BigInt(job.length) || receivedSequence !== job.sequence)
        throw Error(
          `Native TCP receive returned ${count}/${job.length} bytes and sequence ${receivedSequence}/${job.sequence}`
        );
      await rpc.callAddress(sync.signalLightEvent, [address(DECODE_GATE)], SHORT);
      decodeGateSignals++;
      const completed = await poll(INPUT_DONE, INPUT_RESULTS, 'input submit');
      if (completed.readUInt32LE(24) !== job.sequence)
        throw Error('Split decoder submitted the wrong access unit');
      const sent = status(completed.readBigUInt64LE(0));
      if (sent)
        throw Object.assign(Error('movie::sendInput returned 0x' + sent.toString(16)), {
          result: sent
        });
      const inputStatus = status(completed.readBigUInt64LE(8));
      const nextIndex = completed.readInt32LE(16);
      if (inputStatus && !(nextIndex < 0 && [0x100e, 0x1011].includes(inputStatus)))
        throw Object.assign(Error('Decoder input queue returned 0x' + inputStatus.toString(16)), {
          result: inputStatus
        });
      activeInput = null;
      return {sequence: job.sequence, pts: job.pts, input: {status: inputStatus, index: nextIndex}};
    },

    async input(job) {
      const staged = await this.stageInput(job);
      return this.completeInput(staged);
    },

    async queueOutput(job) {
      if (!video.thread || video.joined || activeOutput)
        throw Error('Split output worker is not ready');
      if (!job || !Number.isInteger(job.sequence) || job.sequence < 1)
        throw Error('Invalid split decoder output job');
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32LE(job.sequence);
      activeOutput = job;
      await rpc.writeAndCall(address(OUTPUT_JOB), bytes, sync.signalLightEvent, [
        address(OUTPUT_GATE)
      ]);
    },

    async waitForAcquired(job) {
      return acquiredOutput(job);
    },

    async finishOutput(job, destination) {
      if (!job || activeOutput !== job || !video.thread || video.joined)
        throw Error('Split output job is not ready');
      if (
        !Number.isSafeInteger(destination?.address) ||
        destination.address <= 0 ||
        !Number.isSafeInteger(destination.bytes) ||
        destination.bytes <= 0
      )
        throw Error('Invalid split decoder output destination');
      const acquired = await acquiredOutput(job);
      const destinationBytes = Buffer.alloc(16);
      destinationBytes.writeBigUInt64LE(BigInt(destination.address), 0);
      destinationBytes.writeBigUInt64LE(BigInt(destination.bytes), 8);
      await rpc.writeAndCall(address(OUTPUT_JOB + 8), destinationBytes, sync.signalLightEvent, [
        address(FETCH_GATE)
      ]);
      const fetched = await poll(OUTPUT_DONE, FETCH_RESULTS, 'output fetch');
      if (fetched.readUInt32LE(24) !== job.sequence)
        throw Error('Split decoder fetched the wrong access unit');
      activeOutput = null;
      for (const [name, offset] of [
        ['getOutput', 8],
        ['releaseOutput', 16]
      ]) {
        const value = status(fetched.readBigUInt64LE(offset));
        if (value)
          throw Object.assign(Error('movie::' + name + ' returned 0x' + value.toString(16)), {
            result: value
          });
      }
      return {sequence: job.sequence, pts: acquired.pts};
    },

    get diagnostics() {
      return {
        decodeGateSignals,
        activeInput: activeInput?.sequence,
        activeOutput: activeOutput?.sequence
      };
    },

    async stop() {
      if (input.uncertain || video.uncertain)
        throw Error('Split decoder thread creation is uncertain; decoder and events retained');
      if ((!input.thread || input.joined) && (!video.thread || video.joined)) return;
      transport.abort();
      const selectors = Buffer.alloc(32);
      for (let offset = 0; offset < selectors.length; offset += 8)
        selectors.writeBigUInt64LE(BigInt(offset < 16 ? inputAt.exit : outputAt.exit), offset);
      await rpc.write(address(INPUT_DISPATCH), selectors);
      for (const gate of [INPUT_GATE, DECODE_GATE, OUTPUT_GATE, FETCH_GATE])
        await rpc.callAddress(sync.signalLightEvent, [address(gate)], SHORT);
      await rpc.callAddress(sync.signalEvent, [address(OUTPUT_EVENT)], SHORT);
      for (const worker of [input, video]) {
        if (!worker.thread || worker.joined) continue;
        if (
          !(await wait(rpc, worker.thread, {
            timeoutMs: stopTimeoutMs,
            pollMs: 5,
            invalid: 'Split decoder worker state invalid',
            outputBytes: SHORT
          }))
        )
          throw Error(
            'Split decoder ' +
              (worker === input ? 'input' : 'output') +
              ' did not stop; decoder and events retained'
          );
        await join(rpc, worker.thread, worker.base + 8, {
          failed: 'Split decoder pthread join failed'
        });
        worker.joined = true;
      }
      if (activeOutput) {
        const acquired = await rpc.read(address(OUTPUT_RESULTS), 36);
        const fetched = await rpc.read(address(FETCH_RESULTS + 24), 4);
        if (
          acquired.readUInt32LE(32) === activeOutput.sequence &&
          fetched.readUInt32LE() !== activeOutput.sequence &&
          status(acquired.readBigUInt64LE(0)) === 0 &&
          acquired.readInt32LE(8) >= 0
        )
          await rpc.callAddress(functions.releaseOutput, [decoder, acquired.readInt32LE(8)], SHORT);
      }
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

module.exports = {create};
