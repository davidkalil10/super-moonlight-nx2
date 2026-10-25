// Offline request budget for the native H.264 host loop. The real persistent and
// split workers and the real sink run against a modeled console on a virtual clock;
// the per-frame loop mirrors native-h264.cjs, including its stage labels.
const {instrument, requestsFor} = require('./bridge-counter.cjs');
const ring = require('./ring.cjs');
const definitions = require('../../sdk/native/movie-functions.json');
const registration = require('../../sdk/native/movie-event-functions.json').registerClientEvents;
const SYNC = require('../../sdk/native/os-sync-functions.json');
const {CODE} = require('../../sdk/native/thread.cjs');

const SDK = 0x40000000;
const MODULE = 0x50000000;
const SCRATCH = 0x20000000;
const MAPPED = 0x30000000;
const DECODER = 0x70000000;
const INPUT_ADDRESS = 0x72000000;
const ACCESS_UNIT_BYTES = 40000;
const DECODED = {
  format: 'nv12',
  width: 1920,
  height: 1080,
  stride: 1920,
  sliceHeight: 1088,
  bytes: (1920 * 1088 * 3) / 2
};

// requestMs is the default-mode 3a figure (23.46 ms / 10.47 requests); that run has
// no overlapping requests, so it is pure bridge cost. decodeMs is the decode latency
// the host sees after DECODE_GATE, fitted to the 3a poll counts: the plan's 13 ms
// makes the persistent loop poll ACQUIRED twice more than the device did.
const MODEL = {
  requestMs: 2.24,
  decodeMs: 8.5,
  vsyncMs: 1000 / 60,
  receiveMs: 2,
  submitMs: 0.5,
  fetchMs: 1.5,
  sourceFps: 30
};
const PLAN_DECODE_MS = 13;

// Step 3a device baselines at 1080p30, revision 8805924 (R1B-CONCURRENCY-RESULTS.md).
const BASELINE = {
  persistent: {
    requests: 10.47,
    bridgeMs: 23.46,
    byStage: {persistent: 7.27, destination: 1.21, publish: 2}
  },
  split: {
    requests: 11.57,
    bridgeMs: 26.74,
    byStage: {
      'split-input': 4.47,
      'split-output': 3.02,
      'split-queue': 1,
      destination: 1.09,
      publish: 2
    }
  }
};

const LAYOUT = {
  persistent: {
    inputGate: 0x00,
    job: 0x1a0,
    receiveDone: 0xe0,
    receiveResults: 0x1e0,
    decodeGate: 0xf0,
    acquired: 0x10,
    acquireResults: 0x120,
    fetchGate: 0x20,
    fetchDone: 0x30,
    fetchResults: 0x160
  },
  split: {
    inputGate: 0x00,
    job: 0x140,
    receiveDone: 0x10,
    receiveResults: 0x180,
    decodeGate: 0x20,
    inputDone: 0x30,
    inputResults: 0x1a0,
    outputGate: 0x40,
    outputJob: 0x160,
    acquired: 0x50,
    acquireResults: 0x1c0,
    fetchGate: 0x60,
    fetchDone: 0x70,
    fetchResults: 0x1f0
  }
};

function createClock() {
  let now = 0;
  let order = 0;
  const timers = [];
  const schedule = (callback, ms = 0, ...args) => {
    const timer = {at: now + Math.max(0, Number(ms) || 0), order: order++, callback, args};
    timers.push(timer);
    return timer;
  };
  const cancel = timer => {
    const index = timers.indexOf(timer);
    if (index >= 0) timers.splice(index, 1);
  };
  return {
    now: () => now,
    schedule,
    sleep: ms => new Promise(resolve => schedule(resolve, ms)),
    async run(body) {
      const immediate = setImmediate;
      const saved = [globalThis.setTimeout, globalThis.clearTimeout, Date.now];
      globalThis.setTimeout = schedule;
      globalThis.clearTimeout = cancel;
      Date.now = () => now;
      try {
        let settled = false;
        const result = body();
        result.then(
          () => (settled = true),
          () => (settled = true)
        );
        while (!settled) {
          await new Promise(resolve => immediate(resolve));
          if (settled) break;
          if (!timers.length) throw Error('Request budget simulation stalled');
          timers.sort((a, b) => a.at - b.at || a.order - b.order);
          const timer = timers.shift();
          now = timer.at;
          timer.callback(...timer.args);
        }
        return await result;
      } finally {
        [globalThis.setTimeout, globalThis.clearTimeout, Date.now] = saved;
      }
    }
  };
}

// A healthy console: one bridge exchange at a time, worker threads that answer the
// host's gates after modeled latencies, and a presenter that applies each published
// frame on the next vsync.
function createConsole(clock, mode, model) {
  const layout = LAYOUT[mode];
  const regions = [];
  const signaled = new Set();
  const decodes = new Map();
  let heap = 0x60000000;
  let control = 0;
  let busyUntil = 0;
  let decoderFree = 0;
  let receive = null;

  const add = (base, size) => {
    regions.push({base, bytes: Buffer.alloc(size)});
    return base;
  };
  const regionAt = address =>
    regions.find(region => address >= region.base && address < region.base + region.bytes.length);
  const peek = (address, length) => {
    const region = regionAt(address);
    if (!region) throw Error('Unmapped read at 0x' + address.toString(16));
    return Buffer.from(
      region.bytes.subarray(address - region.base, address - region.base + length)
    );
  };
  const poke = (address, bytes) => {
    const region = regionAt(address);
    if (!region) throw Error('Unmapped write at 0x' + address.toString(16));
    bytes.copy(region.bytes, address - region.base);
    if (address === MAPPED + ring.CONTROL.nativeSequence && bytes.readUInt32LE()) present(bytes);
  };
  const at = (time, action) => clock.schedule(action, time - clock.now());
  const complete = (results, fields, done) => {
    const bytes = peek(control + results, 48);
    for (const [offset, write, value] of fields) bytes[write](value, offset);
    poke(control + results, bytes);
    signaled.add(control + done);
  };

  function present(commit) {
    const value = Buffer.from(commit);
    const vsync = Math.ceil((clock.now() + 1e-6) / model.vsyncMs) * model.vsyncMs;
    at(vsync, () => poke(MAPPED + ring.CONTROL.nativeApplied, value));
  }

  function decode(sequence, pts) {
    const done = Math.max(clock.now(), decoderFree) + model.decodeMs;
    decoderFree = done;
    decodes.set(sequence, {done, pts});
    return done;
  }

  function finishReceive() {
    if (!receive?.posted || receive.sent === undefined) return;
    const {sequence, length} = receive;
    receive = null;
    at(clock.now() + model.receiveMs, () =>
      complete(
        layout.receiveResults,
        [
          [0, 'writeBigInt64LE', BigInt(length)],
          [8, 'writeUInt32LE', sequence]
        ],
        layout.receiveDone
      )
    );
  }

  function gate(offset) {
    const job = peek(control + layout.job, 32);
    const sequence = job.readUInt32LE(0);
    const pts = job.readBigUInt64LE(16);
    if (offset === layout.inputGate) {
      receive = {...receive, posted: true, sequence, length: job.readUInt32LE(8)};
      finishReceive();
    } else if (offset === layout.decodeGate && mode === 'persistent') {
      at(decode(sequence, pts), () =>
        complete(
          layout.acquireResults,
          [
            [0, 'writeBigUInt64LE', 0n],
            [8, 'writeBigUInt64LE', 0n],
            [16, 'writeInt32LE', 0],
            [24, 'writeBigUInt64LE', pts],
            [40, 'writeUInt32LE', sequence]
          ],
          layout.acquired
        )
      );
    } else if (offset === layout.decodeGate) {
      decode(sequence, pts);
      at(clock.now() + model.submitMs, () =>
        complete(
          layout.inputResults,
          [
            [0, 'writeBigUInt64LE', 0n],
            [8, 'writeBigUInt64LE', 0n],
            [16, 'writeInt32LE', 1],
            [24, 'writeUInt32LE', sequence]
          ],
          layout.inputDone
        )
      );
    } else if (offset === layout.outputGate) {
      const output = peek(control + layout.outputJob, 4).readUInt32LE();
      const decoded = decodes.get(output);
      if (!decoded) throw Error('Modeled console has no decode for output ' + output);
      at(Math.max(clock.now(), decoded.done), () =>
        complete(
          layout.acquireResults,
          [
            [0, 'writeBigUInt64LE', 0n],
            [8, 'writeInt32LE', 0],
            [16, 'writeBigUInt64LE', decoded.pts],
            [32, 'writeUInt32LE', output]
          ],
          layout.acquired
        )
      );
    } else if (offset === layout.fetchGate) {
      const output =
        mode === 'split' ? peek(control + layout.outputJob, 4).readUInt32LE() : sequence;
      decodes.delete(output);
      const fields =
        mode === 'split'
          ? [
              [8, 'writeBigUInt64LE', 0n],
              [16, 'writeBigUInt64LE', 0n],
              [24, 'writeUInt32LE', output]
            ]
          : [
              [8, 'writeBigUInt64LE', 0n],
              [16, 'writeBigUInt64LE', 0n],
              [24, 'writeBigUInt64LE', 0n],
              [32, 'writeInt32LE', 1],
              [40, 'writeUInt32LE', output]
            ];
      at(clock.now() + model.fetchMs, () =>
        complete(layout.fetchResults, fields, layout.fetchDone)
      );
    }
  }

  function callAddress(address, args) {
    if (address === SDK + CODE.create.offset) {
      const thread = Buffer.alloc(8);
      thread.writeBigUInt64LE(0x7000n + BigInt(regions.length));
      poke(Number(args[0]), thread);
    }
    if (address === SDK + CODE.tryWait.offset) return 1n;
    if (address === SDK + SYNC.signalLightEvent.offset && control) gate(Number(args[0]) - control);
    return 0n;
  }

  async function exchange(count, body) {
    busyUntil = Math.max(clock.now(), busyUntil) + count * model.requestMs;
    await clock.sleep(busyUntil - clock.now());
    return body();
  }

  add(SCRATCH, 0x1000);
  add(MAPPED, ring.MEMORY_BYTES);
  const ready = Buffer.alloc(4);
  ready.writeUInt32LE(ring.NATIVE_ABI);
  poke(MAPPED + ring.CONTROL.nativeReady, ready);

  const rpc = {
    a: {sdk: SDK, session: 'request-budget', protocol: 3},
    output: SCRATCH,
    request: () => exchange(1, () => ({verified: true})),
    call: (offset, args) =>
      exchange(1, () => {
        const base = add(heap, args[2]);
        heap += Math.ceil(args[2] / 0x100000) * 0x100000;
        if (args[2] === 0x1000) control = base;
        const output = Buffer.alloc(8);
        output.writeBigUInt64LE(BigInt(base));
        return {result: 0n, output};
      }),
    callAddress: (address, args) =>
      exchange(1, () => ({result: callAddress(address, args), output: Buffer.alloc(8)})),
    pair: (operations, outputBytes) =>
      exchange(1, () => {
        const event = Number(operations[0].args[0]);
        const ready = signaled.delete(event);
        return {
          results: [ready ? 1n : 0n, BigInt(SCRATCH)],
          output: peek(Number(operations[1].args[1]), outputBytes)
        };
      }),
    read: (address, length) =>
      exchange(requestsFor('read', [address, length]), () => peek(address, length)),
    write: (address, bytes) =>
      exchange(requestsFor('write', [address, bytes]), () => poke(address, bytes)),
    writeAndCall: (address, bytes, target, args) =>
      exchange(1, () => {
        poke(address, bytes);
        return {result: callAddress(target, args)};
      }),
    query: address =>
      exchange(1, () => {
        const region = regionAt(address);
        return {
          address: BigInt(region.base),
          size: BigInt(region.bytes.length),
          permissions: 3,
          ipcReferences: 0
        };
      })
  };

  const transport = {
    fd: 12,
    maxAccessUnit: 0x100000,
    recvFunction: SDK + 0x1234,
    async send() {
      receive = {...receive, sent: clock.now()};
      finishReceive();
    },
    abort() {}
  };

  return {
    rpc,
    transport,
    storage: {mapped: MAPPED, bytes: ring.MEMORY_BYTES, memoryFlags: 4}
  };
}

async function simulate({mode, frames = 120, warmup = 4, paced = true, model = MODEL}) {
  if (!LAYOUT[mode]) throw Error('Unknown request budget mode ' + mode);
  const clock = createClock();
  return clock.run(async () => {
    const machine = createConsole(clock, mode, model);
    let stage = 'setup';
    const bridge = instrument(machine.rpc, () => stage, clock.now);
    const rpc = bridge.rpc;
    const create = require(
      mode === 'split' ? './split-decoder-worker.cjs' : './persistent-decoder-worker.cjs'
    ).create;
    const worker = await create({
      rpc,
      module: {
        base: MODULE,
        symbols: [
          {
            name: registration.symbol,
            section: '.text',
            offset: registration.offset,
            size: registration.size
          }
        ]
      },
      functions: Object.fromEntries(
        Object.entries(definitions).map(([name, definition]) => [name, MODULE + definition.offset])
      ),
      decoder: DECODER,
      output: DECODER + 0x300,
      format: DECODER + 0x180,
      transport: machine.transport
    });
    await worker.register();
    await worker.start();
    const sink = await require('./native-sink.cjs').create(rpc, machine.storage);
    const payload = Buffer.alloc(ACCESS_UNIT_BYTES, 1);
    const interval = 1000 / model.sourceFps;
    const origin = clock.now();
    let pending = null;
    let started = 0;
    let presented = 0;
    for (let frame = 0; frame < warmup + frames; frame++) {
      stage = 'read';
      if (frame === warmup) {
        bridge.take();
        started = clock.now();
        presented = 0;
      }
      if (paced) await clock.sleep(origin + frame * interval - clock.now());
      const unit = {
        index: 1,
        length: payload.length,
        pts: (frame + 1) * 3000,
        inputAddress: INPUT_ADDRESS,
        payload
      };
      if (mode === 'split') {
        stage = 'split-input';
        const current = await worker.completeInput(await worker.stageInput(unit));
        if (pending) {
          stage = 'destination';
          const destination = await sink.destination();
          stage = 'split-output';
          await worker.finishOutput(pending, destination);
          stage = 'publish';
          await sink.publish(destination, DECODED);
          presented++;
        }
        stage = 'split-queue';
        await worker.queueOutput(current);
        pending = current;
      } else {
        stage = 'persistent';
        const job = await worker.begin(unit);
        stage = 'destination';
        const destination = await sink.destination();
        stage = 'persistent';
        await worker.finish(job, destination);
        stage = 'publish';
        await sink.publish(destination, DECODED);
        presented++;
      }
    }
    stage = 'read';
    const elapsed = clock.now() - started;
    const counted = bridge.take();
    const perFrame = value => Math.round((value / presented) * 100) / 100;
    return {
      frames: presented,
      paced,
      requestsPerFrame: perFrame(counted.exchanges),
      bridgeMsPerFrame: perFrame(counted.bridgeMs),
      msPerFrame: perFrame(elapsed),
      fps: Math.round((presented * 100000) / elapsed) / 100,
      byStage: Object.fromEntries(
        Object.entries(counted.bridgeByStage).map(([name, row]) => [
          name,
          {requests: perFrame(row.exchanges), bridgeMs: perFrame(row.bridgeMs)}
        ])
      )
    };
  });
}

async function budget({frames = 120, model = MODEL} = {}) {
  const modes = {};
  for (const mode of ['persistent', 'split']) {
    const paced = await simulate({mode, frames, model});
    const free = await simulate({mode, frames, model, paced: false});
    modes[mode] = {
      requestsPerFrame: paced.requestsPerFrame,
      bridgeMsPerFrame: paced.bridgeMsPerFrame,
      predictedFps: free.fps,
      byStage: paced.byStage,
      unpaced: {
        requestsPerFrame: free.requestsPerFrame,
        bridgeMsPerFrame: free.bridgeMsPerFrame,
        msPerFrame: free.msPerFrame
      },
      baseline: BASELINE[mode]
    };
  }
  const planDecode = {};
  for (const mode of ['persistent', 'split']) {
    const options = {mode, frames, model: {...model, decodeMs: PLAN_DECODE_MS}};
    planDecode[mode] = {
      requestsPerFrame: (await simulate(options)).requestsPerFrame,
      predictedFps: (await simulate({...options, paced: false})).fps
    };
  }
  return {
    frames,
    model,
    assumptions: [
      'Requests, bridge-ms and byStage are at the paced source rate; predictedFps is the same loop with every access unit already waiting.',
      'The loop mirrors native-h264.cjs steady state; native-decoder.cjs adds no request while the tail AcquireInput returns an index.'
    ],
    modes,
    planDecodeMs: {decodeMs: PLAN_DECODE_MS, ...planDecode}
  };
}

if (require.main === module) {
  const at = process.argv.indexOf('--frames');
  const frames = at < 0 ? 120 : Number(process.argv[at + 1]);
  if (!Number.isInteger(frames) || frames < 1) {
    console.error('Usage: node tools/moonlight/request-budget.cjs [--frames N]');
    process.exit(2);
  }
  budget({frames}).then(
    result => console.log(JSON.stringify(result, null, 2)),
    error => {
      console.error(error);
      process.exit(1);
    }
  );
}

module.exports = {MODEL, BASELINE, createClock, simulate, budget};
