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
const GATE = 0;
const ACQUIRED = 0x10;
const FETCH_GATE = 0x20;
const DONE = 0x30;
const OUTPUT_EVENT = 0x40;
const DECODER_EVENTS = 0x80;
const DISPATCH = 0xc0;
const FETCH_DISPATCH = 0xc8;
const RECEIVE_DONE = 0xe0;
const DECODE_GATE = 0xf0;
const DECODE_DISPATCH = 0x100;
const DECODE_RESULTS = 0x120;
const FETCH_RESULTS = 0x160;
const JOB = 0x1a0;
const FETCH_JOB = 0x1c0;
const PROBE_DONE = 0x1d0;
const RECEIVE_RESULTS = 0x1e0;
const SHORT = 2;
const AUTO_CLEAR = 1;
const READ = 0x586fb0;
const DECODE_PROBES = new Set(['gate', 'dispatch', 'send', 'wait', 'acquire']);
const FETCH_PROBES = new Set(['setData', 'getOutput', 'release', 'input', 'done', 'restore']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = value => Number(BigInt.asUintN(32, value));

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
  if (
    transport &&
    (!Number.isInteger(transport.fd) ||
      transport.fd < 0 ||
      !Number.isInteger(transport.maxAccessUnit) ||
      transport.maxAccessUnit < 1 ||
      !Number.isSafeInteger(transport.recvFunction) ||
      typeof transport.send !== 'function' ||
      typeof transport.abort !== 'function')
  )
    throw Error('Invalid native TCP decoder transport');
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

  const base = await allocate(rpc, transport ? 0x500000 : 0x400000, {
    failed: 'Persistent decoder worker allocation failed',
    invalid: 'Invalid persistent decoder worker allocation'
  });
  const control = await allocate(rpc, CONTROL_BYTES, {
    failed: 'Persistent decoder control allocation failed',
    invalid: 'Invalid persistent decoder control allocation'
  });
  const event = offset => control + offset;
  const data = Buffer.alloc(CONTROL_BYTES);
  data.writeBigUInt64LE(BigInt(event(OUTPUT_EVENT)), DECODER_EVENTS + 8);
  await rpc.write(control, data);
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

  let thread = null;
  let sequence = 0;
  let active = 0;
  let joined = false;
  let uncertainStart = false;
  let probeStage = null;
  const gateFrame = base + 0x10000;
  const gateSnapshot = base + 0x80000;
  const decodeFrame = base + 0x110000;
  const decodeSnapshot = base + 0x180000;
  const fetchFrame = base + 0x210000;
  const fetchSnapshot = base + 0x280000;
  const receiveFrame = base + 0x310000;
  const receiveSnapshot = base + 0x380000;
  const exitFrame = base + (transport ? 0x450000 : 0x350000);

  function frame(address, calls, results = {}) {
    const program = build(address, sdk, calls, CODE, false, new Set(Object.values(functions)));
    if (program.frame.length > 0x100000) throw Error('Persistent decoder frame exceeds its region');
    for (const [call, destination] of Object.entries(results)) {
      const index = program.proof.logicalResultIndices[Number(call)];
      program.frame.writeBigUInt64LE(
        BigInt(event(destination)),
        program.proof.stackOffsets[index] + 0x118
      );
    }
    return program.frame;
  }

  async function poll(offset, resultOffset, label) {
    const until = Date.now() + pollTimeoutMs;
    while (Date.now() < until && !cancelled()) {
      const reply = await rpc.pair(
        [
          {address: sync.tryWaitLightEvent, args: [event(offset), 0, 0, 0]},
          {offset: READ, args: [rpc.output, event(resultOffset), 44, 0]}
        ],
        44
      );
      if ((reply.results[0] & 0xffn) === 1n) {
        if (reply.results[1] !== BigInt(rpc.output))
          throw Error('Persistent decoder result read failed');
        return reply.output;
      }
      await sleep(2);
    }
    throw Error(
      cancelled() ? 'Native decoding cancelled' : `Persistent decoder ${label} timed out`
    );
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

    async start({stage = null} = {}) {
      if (thread !== null) throw Error('Persistent decoder worker already started');
      if (stage !== null && !DECODE_PROBES.has(stage) && !FETCH_PROBES.has(stage))
        throw Error('Invalid persistent decoder probe stage');
      probeStage = stage;
      await rpc.callAddress(sync.clearEvent, [event(OUTPUT_EVENT)], SHORT);
      const jump = sdk + CODE.longjmp.offset;
      const copy = sdk + IPC_COPY.offset;
      const gate = frame(gateFrame, [
        {function: sync.waitLightEvent, args: [event(GATE), 0, 0, 0]},
        stage === 'gate'
          ? {function: sync.signalLightEvent, args: [event(PROBE_DONE), 0, 0, 0]}
          : {function: jump, args: [{u64: event(DISPATCH)}, 1, 0, 0]}
      ]);
      const send = {
        function: functions.sendInput,
        args: [decoder, {u32: event(JOB + 4)}, 0, {u32: event(JOB + 8)}, {u64: event(JOB + 16)}, 0]
      };
      const waitOutput = {function: sync.waitEvent, args: [event(OUTPUT_EVENT), 0, 0, 0]};
      const acquireOutput = {
        function: functions.acquireOutput,
        args: [
          decoder,
          event(DECODE_RESULTS + 16),
          event(DECODE_RESULTS + 24),
          event(DECODE_RESULTS + 32),
          event(DECODE_RESULTS + 36)
        ]
      };
      const decodeCalls =
        stage === 'dispatch'
          ? [{function: sync.signalLightEvent, args: [event(PROBE_DONE), 0, 0, 0]}]
          : [
              send,
              ...(stage === 'send' ? [] : [waitOutput]),
              ...(stage === 'send' || stage === 'wait'
                ? []
                : [
                    acquireOutput,
                    {function: copy, args: [event(DECODE_RESULTS + 40), event(JOB), 4, 0]}
                  ]),
              ...(DECODE_PROBES.has(stage)
                ? [{function: sync.signalLightEvent, args: [event(PROBE_DONE), 0, 0, 0]}]
                : [
                    {function: sync.signalLightEvent, args: [event(ACQUIRED), 0, 0, 0]},
                    {function: sync.waitLightEvent, args: [event(FETCH_GATE), 0, 0, 0]},
                    {function: jump, args: [{u64: event(FETCH_DISPATCH)}, 1, 0, 0]}
                  ])
            ];
      const decodeResults =
        stage === 'dispatch'
          ? {}
          : stage === 'send' || stage === 'wait'
            ? {0: DECODE_RESULTS}
            : {0: DECODE_RESULTS, 2: DECODE_RESULTS + 8};
      const decode = frame(decodeFrame, decodeCalls, decodeResults);
      const fetchCalls = [
        {
          function: functions.bufferSetData,
          args: [output, {u64: event(FETCH_JOB)}, {u64: event(FETCH_JOB + 8)}, 0]
        },
        {
          function: functions.getOutput,
          args: [decoder, {u32: event(DECODE_RESULTS + 16)}, output, format]
        },
        {
          function: functions.releaseOutput,
          args: [decoder, {u32: event(DECODE_RESULTS + 16)}, 0, 0]
        },
        {
          function: functions.acquireInput,
          args: [decoder, event(FETCH_RESULTS + 32), event(FETCH_RESULTS + 36), 0]
        },
        {function: copy, args: [event(FETCH_RESULTS + 40), event(JOB), 4, 0]}
      ];
      const fetchLengths = {setData: 1, getOutput: 2, release: 3, input: 4};
      const fetchCount = fetchLengths[stage] ?? fetchCalls.length;
      const restoreCalls = [
        {function: copy, args: [gateFrame, gateSnapshot, gate.length, 0]},
        {function: copy, args: [decodeFrame, decodeSnapshot, decode.length, 0]},
        {function: copy, args: [fetchFrame, fetchSnapshot, 0, 0]}
      ];
      const receive = transport
        ? frame(
            receiveFrame,
            [
              {
                function: transport.recvFunction,
                args: [transport.fd, {u64: event(JOB + 24)}, {u32: event(JOB + 8)}, 0x40]
              },
              {function: copy, args: [event(RECEIVE_RESULTS + 8), event(JOB), 4, 0]},
              {function: sync.signalLightEvent, args: [event(RECEIVE_DONE), 0, 0, 0]},
              {function: sync.waitLightEvent, args: [event(DECODE_GATE), 0, 0, 0]},
              {function: jump, args: [{u64: event(DECODE_DISPATCH)}, 1, 0, 0]}
            ],
            {0: RECEIVE_RESULTS}
          )
        : null;
      if (receive)
        restoreCalls.push({
          function: copy,
          args: [receiveFrame, receiveSnapshot, receive.length, 0]
        });
      const fetchResults = [
        FETCH_RESULTS,
        FETCH_RESULTS + 8,
        FETCH_RESULTS + 16,
        FETCH_RESULTS + 24
      ];
      const fetchBody = [
        ...fetchCalls.slice(0, fetchCount),
        ...(!FETCH_PROBES.has(stage) || stage === 'restore' ? restoreCalls : []),
        ...(fetchCount === fetchCalls.length
          ? [{function: sync.signalLightEvent, args: [event(DONE), 0, 0, 0]}]
          : []),
        ...(FETCH_PROBES.has(stage)
          ? [{function: sync.signalLightEvent, args: [event(PROBE_DONE), 0, 0, 0]}]
          : [{function: jump, args: [gateFrame, 1, 0, 0]}])
      ];
      const resultSlots = Object.fromEntries(
        fetchResults.slice(0, Math.min(fetchCount, 4)).map((slot, i) => [i, slot])
      );
      let fetch = frame(fetchFrame, fetchBody, resultSlots);
      if (!FETCH_PROBES.has(stage) || stage === 'restore') {
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
      const stop = Buffer.alloc(0xb0);
      stop.writeBigUInt64LE(BigInt(sdk + CODE.exit.offset), 0x58);
      stop.writeBigUInt64LE(BigInt(base + (transport ? 0x470000 : 0x370000)), 0x68);
      await rpc.write(gateFrame, gate);
      await rpc.write(gateSnapshot, gate);
      await rpc.write(decodeFrame, decode);
      await rpc.write(decodeSnapshot, decode);
      await rpc.write(fetchFrame, fetch);
      await rpc.write(fetchSnapshot, fetch);
      if (receive) {
        await rpc.write(receiveFrame, receive);
        await rpc.write(receiveSnapshot, receive);
      }
      await rpc.write(exitFrame, stop);
      for (const [address, bytes] of [
        [gateSnapshot, gate],
        [decodeSnapshot, decode],
        [fetchSnapshot, fetch],
        ...(receive ? [[receiveSnapshot, receive]] : [])
      ])
        if (!(await rpc.read(address, bytes.length)).equals(bytes))
          throw Error('Persistent decoder frame snapshot readback differs');
      const selectors = Buffer.alloc(16);
      selectors.writeBigUInt64LE(BigInt(receive ? receiveFrame : decodeFrame), 0);
      selectors.writeBigUInt64LE(BigInt(fetchFrame), 8);
      await rpc.write(event(DISPATCH), selectors);
      if (receive) {
        const selector = Buffer.alloc(8);
        selector.writeBigUInt64LE(BigInt(decodeFrame));
        await rpc.write(event(DECODE_DISPATCH), selector);
      }
      uncertainStart = true;
      thread = await spawn(rpc, base, gateFrame, {
        failed: 'Persistent decoder thread creation failed'
      });
      uncertainStart = false;
    },

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
      sequence = (sequence + 1) >>> 0 || 1;
      active = sequence;
      const job = Buffer.alloc(transport ? 32 : 24);
      job.writeUInt32LE(sequence, 0);
      job.writeInt32LE(index, 4);
      job.writeUInt32LE(length, 8);
      job.writeBigUInt64LE(BigInt(pts), 16);
      if (transport) job.writeBigUInt64LE(BigInt(inputAddress), 24);
      await rpc.writeAndCall(event(JOB), job, sync.signalLightEvent, [event(GATE)]);
      if (transport) {
        await transport.send(payload);
        const received = await poll(RECEIVE_DONE, RECEIVE_RESULTS, 'TCP receive');
        const count = received.readBigInt64LE(0);
        const receivedSequence = received.readUInt32LE(8);
        if (count !== BigInt(length) || receivedSequence !== sequence)
          throw Error(
            `Native TCP receive returned ${count}/${length} bytes and sequence ${receivedSequence}/${sequence}`
          );
        await rpc.callAddress(sync.signalLightEvent, [event(DECODE_GATE)], SHORT);
      }
      return {sequence, pts: BigInt(pts)};
    },

    async finish(job, destination) {
      if (thread === null || joined || !job || job.sequence !== active)
        throw Error('Persistent decoder job is not ready to finish');
      if (DECODE_PROBES.has(probeStage)) {
        const result = await poll(PROBE_DONE, DECODE_RESULTS, 'probe ' + probeStage);
        return {
          pts: job.pts,
          input: {status: 0, index: -1},
          probe: {
            stage: probeStage,
            sendStatus: status(result.readBigUInt64LE(0)),
            acquireStatus: status(result.readBigUInt64LE(8)),
            outputIndex: result.readInt32LE(16),
            completedSequence: result.readUInt32LE(40)
          }
        };
      }
      const acquired = await poll(ACQUIRED, DECODE_RESULTS, 'output acquire');
      const sent = status(acquired.readBigUInt64LE(0));
      const acquiredStatus = status(acquired.readBigUInt64LE(8));
      const outputIndex = acquired.readInt32LE(16);
      if (acquired.readUInt32LE(40) !== job.sequence)
        throw Error('Persistent decoder acquired the wrong access unit');
      if (sent || acquiredStatus || outputIndex < 0) {
        const value = sent || acquiredStatus || 0x100e;
        throw Object.assign(Error('Persistent decoder acquire returned 0x' + value.toString(16)), {
          result: value
        });
      }
      const target = Buffer.alloc(16);
      target.writeBigUInt64LE(BigInt(destination.address), 0);
      target.writeBigUInt64LE(BigInt(destination.bytes), 8);
      if (FETCH_PROBES.has(probeStage)) {
        await rpc.write(event(FETCH_JOB), target);
        if (!(await rpc.read(event(FETCH_JOB), target.length)).equals(target))
          throw Error('Persistent decoder fetch job readback differs');
      }
      await rpc.writeAndCall(event(FETCH_JOB), target, sync.signalLightEvent, [event(FETCH_GATE)]);
      if (FETCH_PROBES.has(probeStage)) {
        const fetched = await poll(PROBE_DONE, FETCH_RESULTS, 'probe ' + probeStage);
        return {
          pts: acquired.readBigUInt64LE(24),
          input: {status: 0, index: -1},
          probe: {
            stage: probeStage,
            outputIndex,
            getStatus: status(fetched.readBigUInt64LE(8)),
            releaseStatus: status(fetched.readBigUInt64LE(16)),
            inputStatus: status(fetched.readBigUInt64LE(24)),
            nextIndex: fetched.readInt32LE(32),
            completedSequence: fetched.readUInt32LE(40)
          }
        };
      }
      const fetched = await poll(DONE, FETCH_RESULTS, 'output fetch');
      if (fetched.readUInt32LE(40) !== job.sequence)
        throw Error('Persistent decoder completed the wrong access unit');
      active = 0;
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
      const inputStatus = status(fetched.readBigUInt64LE(24));
      const nextIndex = fetched.readInt32LE(32);
      if (inputStatus && !(nextIndex < 0 && [0x100e, 0x1011].includes(inputStatus)))
        throw Object.assign(Error('Decoder input queue returned 0x' + inputStatus.toString(16)), {
          result: inputStatus
        });
      return {
        pts: acquired.readBigUInt64LE(24),
        input: {status: inputStatus, index: nextIndex}
      };
    },

    async run({index, length, pts, destination, inputAddress, payload}) {
      const job = await this.begin({index, length, pts, inputAddress, payload});
      return this.finish(job, destination);
    },

    async stop() {
      if (uncertainStart)
        throw Error('Persistent decoder thread creation is uncertain; decoder and events retained');
      if (thread === null || joined) return;
      transport?.abort();
      const selectors = Buffer.alloc(16);
      selectors.writeBigUInt64LE(BigInt(exitFrame), 0);
      selectors.writeBigUInt64LE(BigInt(exitFrame), 8);
      await rpc.write(event(DISPATCH), selectors);
      if (transport) {
        const selector = Buffer.alloc(8);
        selector.writeBigUInt64LE(BigInt(exitFrame));
        await rpc.write(event(DECODE_DISPATCH), selector);
      }
      await rpc.callAddress(sync.signalLightEvent, [event(GATE)], SHORT);
      await rpc.callAddress(sync.signalLightEvent, [event(FETCH_GATE)], SHORT);
      if (transport) await rpc.callAddress(sync.signalLightEvent, [event(DECODE_GATE)], SHORT);
      await rpc.callAddress(sync.signalEvent, [event(OUTPUT_EVENT)], SHORT);
      if (
        !(await wait(rpc, thread, {
          timeoutMs: stopTimeoutMs,
          pollMs: 5,
          invalid: 'Persistent decoder thread state invalid',
          outputBytes: SHORT
        }))
      )
        throw Error('Persistent decoder worker did not stop; decoder and events retained');
      await join(rpc, thread, base + 8, {failed: 'Persistent decoder thread join failed'});
      joined = true;
      if (active) {
        const acquired = await rpc.read(event(DECODE_RESULTS), 44);
        const completed = await rpc.read(event(FETCH_RESULTS + 40), 4);
        if (
          acquired.readUInt32LE(40) === active &&
          completed.readUInt32LE() !== active &&
          !['release', 'input', 'done', 'restore'].includes(probeStage) &&
          status(acquired.readBigUInt64LE(8)) === 0 &&
          acquired.readInt32LE(16) >= 0
        )
          await rpc.callAddress(
            functions.releaseOutput,
            [decoder, acquired.readInt32LE(16)],
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

module.exports = {create};
