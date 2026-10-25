// Offline request budget for the native H.264 host loop. The real persistent and
// split workers and the real sink run against a modeled console on a virtual clock;
// the per-frame loop mirrors native-h264.cjs, including its stage labels.
const {instrument, requestsFor} = require('./bridge-counter.cjs');
const ring = require('./ring.cjs');
const definitions = require('../../sdk/native/movie-functions.json');
const registration = require('../../sdk/native/movie-event-functions.json').registerClientEvents;
const SYNC = require('../../sdk/native/os-sync-functions.json');
const {CODE} = require('../../sdk/native/thread.cjs');
const PAIRED = require('./paired-loop-plan.cjs').CONTROL;
const presentPacer = require('./present-pacer.cjs');

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
const R3_DECODE_MS = 6.85;
// staggered-live.cjs rereads a late gate status back to back; it paused 5 ms before.
const STAGGERED = {retryWaitMs: 0, audioIntervalMs: 1000};

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
    outputJob: 0x300,
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
function createConsole(
  clock,
  mode,
  model,
  nativePublish = false,
  autoQueue = false,
  linkedGates = false,
  paired = false
) {
  const layout = LAYOUT[mode];
  const regions = [];
  const signaled = new Set();
  const decodes = new Map();
  const loop = {control: 0, waiting: false, outputs: []};
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
    const index = peek(MAPPED + ring.CONTROL.nativeIndex, 4);
    const vsync = Math.ceil((clock.now() + 1e-6) / model.vsyncMs) * model.vsyncMs;
    at(vsync, () => {
      poke(MAPPED + ring.CONTROL.current, index);
      poke(MAPPED + ring.CONTROL.nativeApplied, value);
    });
  }

  function decode(sequence, pts) {
    const done = Math.max(clock.now(), decoderFree) + model.decodeMs;
    decoderFree = done;
    decodes.set(sequence, {done, pts});
    return done;
  }

  function loopResults(offset, fields) {
    for (const [at, write, value] of fields) {
      const bytes = Buffer.alloc(8);
      bytes[write](value);
      poke(loop.control + offset + at, bytes.subarray(0, write.includes('Big') ? 8 : 4));
    }
  }

  function acquirePair() {
    if (!loop.waiting || loop.outputs.length < 2) return;
    loop.waiting = false;
    const outputs = loop.outputs.splice(0, 2);
    const sequence = peek(loop.control + PAIRED.job, 4).readUInt32LE();
    at(Math.max(clock.now(), outputs[1].done), () => {
      outputs.forEach((output, index) =>
        loopResults(PAIRED.acquired[index], [
          [0, 'writeInt32LE', index],
          [8, 'writeBigUInt64LE', output.pts]
        ])
      );
      loopResults(PAIRED.acquireResults, [
        [0, 'writeBigUInt64LE', 0n],
        [8, 'writeBigUInt64LE', 0n],
        [16, 'writeUInt32LE', sequence]
      ]);
    });
  }

  function pairedGate(offset) {
    if (offset === PAIRED.startGate) {
      loop.waiting = true;
      acquirePair();
      return;
    }
    const index = offset === PAIRED.fetchGate ? 0 : 1;
    const results = index ? PAIRED.secondResults : PAIRED.firstResults;
    at(clock.now() + model.fetchMs, () => {
      const destination = peek(loop.control + PAIRED.destinations[index], 48);
      poke(MAPPED + ring.CONTROL.nativeIndex, destination.subarray(16, 44));
      poke(MAPPED + ring.CONTROL.nativeSequence, destination.subarray(44, 48));
      loopResults(results, [
        [0, 'writeBigUInt64LE', 0n],
        [8, 'writeBigUInt64LE', 0n],
        [16, 'writeBigUInt64LE', 0n],
        [24, 'writeUInt32LE', peek(loop.control + PAIRED.job, 4).readUInt32LE()]
      ]);
    });
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
      if (mode === 'split' && receive?.sent === undefined)
        throw Error('Modeled split input gate opened before the TCP payload was sent');
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
      const done = decode(sequence, pts);
      if (paired) {
        loop.outputs.push({done, pts});
        acquirePair();
      }
      at(clock.now() + model.submitMs, () => {
        if (nativePublish) {
          const presentation = Buffer.alloc(8);
          presentation.writeUInt32LE(peek(MAPPED + ring.CONTROL.current, 4).readUInt32LE());
          presentation.writeUInt32LE(
            peek(MAPPED + ring.CONTROL.nativeApplied, 4).readUInt32LE(),
            4
          );
          poke(control + 0x210, presentation);
        }
        complete(
          layout.inputResults,
          [
            [0, 'writeBigUInt64LE', 0n],
            [8, 'writeBigUInt64LE', 0n],
            [16, 'writeInt32LE', 1],
            [24, 'writeUInt32LE', sequence]
          ],
          layout.inputDone
        );
      });
    } else if (offset === layout.outputGate) {
      const output = peek(control + layout.outputJob, 4).readUInt32LE();
      const decoded = decodes.get(output);
      if (!decoded) throw Error('Modeled console has no decode for output ' + output);
      at(Math.max(clock.now(), decoded.done), () => {
        if (linkedGates) {
          const presentation = Buffer.alloc(8);
          presentation.writeUInt32LE(peek(MAPPED + ring.CONTROL.current, 4).readUInt32LE());
          presentation.writeUInt32LE(
            peek(MAPPED + ring.CONTROL.nativeApplied, 4).readUInt32LE(),
            4
          );
          poke(control + 0x210, presentation);
        }
        complete(
          layout.acquireResults,
          [
            [0, 'writeBigUInt64LE', 0n],
            [8, 'writeInt32LE', 0],
            [16, 'writeBigUInt64LE', decoded.pts],
            [32, 'writeUInt32LE', output]
          ],
          layout.acquired
        );
      });
    } else if (offset === layout.fetchGate) {
      const output =
        mode === 'split' ? peek(control + layout.outputJob, 4).readUInt32LE() : sequence;
      if (linkedGates && peek(control + layout.outputJob + 56, 4).readUInt32LE())
        gate(layout.decodeGate);
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
      at(clock.now() + model.fetchMs, () => {
        if (nativePublish) {
          const publish = peek(control + layout.outputJob + 24, 32);
          poke(MAPPED + ring.CONTROL.nativeIndex, publish.subarray(0, 28));
          poke(MAPPED + ring.CONTROL.nativeSequence, publish.subarray(28));
        }
        complete(layout.fetchResults, fields, layout.fetchDone);
        if (autoQueue) {
          const next = peek(control + layout.outputJob + 56, 4).readUInt32LE();
          if (next) {
            const sequence = Buffer.alloc(4);
            sequence.writeUInt32LE(next);
            poke(control + layout.outputJob, sequence);
            gate(layout.outputGate);
          }
        }
      });
    }
  }

  function callAddress(address, args) {
    if (address === SDK + CODE.create.offset) {
      const thread = Buffer.alloc(8);
      thread.writeBigUInt64LE(0x7000n + BigInt(regions.length));
      poke(Number(args[0]), thread);
    }
    if (address === SDK + CODE.tryWait.offset) return 1n;
    if (address === SDK + SYNC.signalLightEvent.offset && loop.control) {
      const offset = Number(args[0]) - loop.control;
      if (offset >= 0 && offset < 0x1000) {
        pairedGate(offset);
        return 0n;
      }
    }
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
        if (args[2] === 0x1000 && paired && control) loop.control = base;
        else if (args[2] === 0x1000) control = base;
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

// R(N) reads one status snapshot, W(N) is one writeAndCall that opens decode gate N
// and fetch gate N-1. A late receive, acquire or renderer ack costs one extra read
// after an off-bridge wait; retryRate spreads those rereads evenly over the frames.
// With barrier set the console orders each submit as in cb183ad: gate N releases the
// held output first (fetchMs), then N is submitted once output N-1 is acquired. The
// host side is unchanged.
// With hostWait set the host reads the status the way staggered-live.cjs does instead
// of waking exactly when the frame is ready: back to back while receive or decode is
// pending, and for a pending present either back to back ('poll') or through the
// present pacer ('pacer').
async function simulateStaggered({
  frames = 120,
  warmup = 4,
  paced = true,
  presentHz = 60,
  retryRate = 0,
  lag = 1,
  barrier = false,
  retryWaitMs = STAGGERED.retryWaitMs,
  hostWait = null,
  skipBacklog = null,
  maxSkips = 4,
  model = MODEL
}) {
  if (hostWait && !['poll', 'pacer'].includes(hostWait))
    throw Error('Unknown staggered host wait ' + hostWait);
  if (hostWait && retryRate) throw Error('A modeled host wait makes its own rereads');
  const timing = {...model, vsyncMs: 1000 / presentHz};
  const clock = createClock();
  return clock.run(async () => {
    const interval = 1000 / timing.sourceFps;
    const origin = clock.now();
    const decoded = [];
    let busyUntil = 0;
    let exchanges = 0;
    let bridgeMs = 0;
    let decoderFree = 0;
    let sent = origin;
    let started = origin;
    let presented = 0;
    let skipped = 0;
    let skips = 0;
    const offScreen = new Set();
    let retryDebt = 0;
    let nextAudio = origin;
    let rereads = 0;
    let fetchOpened = null;
    const pacer = presentPacer.create({
      periodMs: timing.vsyncMs,
      now: clock.now,
      sleep: clock.sleep
    });
    const request = async () => {
      busyUntil = Math.max(clock.now(), busyUntil) + timing.requestMs;
      exchanges++;
      bridgeMs += timing.requestMs;
      await clock.sleep(busyUntil - clock.now());
    };
    const applied = [];
    const apply = (frame, fetchDone, skip) => {
      if (skip) {
        applied[frame] = frame ? applied[frame - 1] : 0;
        return;
      }
      const vsync = Math.ceil((fetchDone + 1e-6) / timing.vsyncMs) * timing.vsyncMs;
      applied[frame] = Math.max(vsync, frame ? applied[frame - 1] + timing.vsyncMs : 0);
    };
    for (let frame = 0; frame < warmup + frames; frame++) {
      if (frame === warmup) {
        exchanges = 0;
        bridgeMs = 0;
        presented = 0;
        skipped = 0;
        retryDebt = 0;
        rereads = 0;
        started = clock.now();
        nextAudio = started;
      }
      const arrival = paced ? origin + frame * interval : origin;
      const inputReady = Math.max(sent + timing.receiveMs, frame >= lag ? decoded[frame - lag] : 0);
      const presentReady = frame > lag ? applied[frame - lag - 1] : 0;
      const ready = hostWait ? arrival : Math.max(arrival, inputReady, presentReady);
      if (ready > clock.now()) await clock.sleep(ready - clock.now());
      if (clock.now() >= nextAudio) {
        nextAudio += STAGGERED.audioIntervalMs;
        await request();
      }
      retryDebt += retryRate;
      if (retryDebt >= 1) {
        retryDebt -= 1;
        await request();
        await clock.sleep(retryWaitMs);
      }
      const acked = frame > lag && !offScreen.has(frame - lag - 1);
      if (hostWait) {
        if (hostWait === 'pacer' && acked) await pacer.beforeRead(fetchOpened);
        for (;;) {
          const startedAt = clock.now();
          await request();
          const at = clock.now();
          if (acked) pacer.observe(startedAt, presentReady <= at);
          if (inputReady <= at && presentReady <= at) break;
          rereads++;
          if (inputReady <= at && hostWait === 'pacer') await pacer.pending();
        }
      } else await request();
      await request();
      if (frame >= lag) fetchOpened = clock.now();
      let submit = clock.now();
      if (barrier && frame)
        submit = Math.max(submit + (frame >= lag ? timing.fetchMs : 0), decoded[frame - 1]);
      decoded[frame] = Math.max(submit, decoderFree) + timing.decodeMs;
      decoderFree = decoded[frame];
      const arrived = paced
        ? Math.min(warmup + frames, Math.floor((clock.now() - origin) / interval) + 1)
        : warmup + frames;
      const skip =
        skipBacklog !== null &&
        frame > lag &&
        arrived - frame - 1 > skipBacklog &&
        skips < maxSkips;
      skips = skip ? skips + 1 : 0;
      if (skip) offScreen.add(frame - lag);
      if (frame >= lag) apply(frame - lag, clock.now() + timing.fetchMs, skip);
      sent = clock.now();
      if (frame >= lag && skip) skipped++;
      else if (frame >= lag) presented++;
    }
    const elapsed = clock.now() - started;
    const outputs = presented + skipped;
    const perFrame = value => Math.round((value / outputs) * 100) / 100;
    return {
      frames: presented,
      paced,
      staggered: true,
      presentHz,
      retryRate,
      lag,
      barrier,
      retryWaitMs,
      hostWait,
      rereadsPerFrame: perFrame(rereads),
      skipBacklog,
      skipped,
      requestsPerFrame: perFrame(exchanges),
      bridgeMsPerFrame: perFrame(bridgeMs),
      msPerFrame: perFrame(elapsed),
      fps: Math.round((presented * 100000) / elapsed) / 100,
      decodedFps: Math.round((outputs * 100000) / elapsed) / 100
    };
  });
}

async function simulate({
  mode,
  frames = 120,
  warmup = 4,
  paced = true,
  nativePublish = false,
  autoQueue = false,
  linkedGates = false,
  presentHz,
  retryRate,
  lag,
  barrier,
  retryWaitMs,
  hostWait,
  skipBacklog,
  maxSkips,
  model = MODEL
}) {
  if (mode === 'staggered')
    return simulateStaggered({
      frames,
      warmup,
      paced,
      presentHz,
      retryRate,
      lag,
      barrier,
      retryWaitMs,
      hostWait,
      skipBacklog,
      maxSkips,
      model
    });
  const paired = mode === 'paired';
  if (paired && (nativePublish || autoQueue || linkedGates))
    throw Error('The paired loop publishes from its own worker');
  if (paired) mode = 'split';
  if (!LAYOUT[mode]) throw Error('Unknown request budget mode ' + mode);
  if (nativePublish && mode !== 'split') throw Error('Native worker publication needs split mode');
  if (autoQueue && !nativePublish) throw Error('Automatic output queue needs worker publication');
  if (linkedGates && !autoQueue) throw Error('Linked gates need automatic output queue');
  if (paired && warmup % 2) throw Error('The paired loop warms up in whole pairs');
  const clock = createClock();
  return clock.run(async () => {
    const machine = createConsole(
      clock,
      mode,
      model,
      nativePublish || paired,
      autoQueue,
      linkedGates,
      paired
    );
    let stage = 'setup';
    const bridge = instrument(machine.rpc, () => stage, clock.now);
    const rpc = bridge.rpc;
    const pairedLive = paired
      ? require('./paired-live.cjs').create({rpc, publication: {mapped: MAPPED, color: 1}})
      : null;
    const create = paired
      ? pairedLive.factory
      : require(mode === 'split' ? './split-decoder-worker.cjs' : './persistent-decoder-worker.cjs')
          .create;
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
      transport: machine.transport,
      publication: nativePublish || paired ? {mapped: MAPPED, color: 1} : null,
      autoQueue,
      linkedGates
    });
    await worker.register();
    await worker.start();
    if (paired) await pairedLive.start();
    const sink = await require('./native-sink.cjs').create(rpc, machine.storage);
    const payload = Buffer.alloc(ACCESS_UNIT_BYTES, 1);
    const interval = 1000 / model.sourceFps;
    const origin = clock.now();
    let pending = null;
    let started = 0;
    let presented = 0;
    const modeled = frame => ({
      index: 1,
      length: payload.length,
      pts: (frame + 1) * 3000,
      inputAddress: INPUT_ADDRESS,
      payload
    });
    const decoder = {
      submitSplit: async unit =>
        worker.completeInput(await worker.stageInput({...unit, sendFirst: true}))
    };
    for (let frame = 0; paired && frame < warmup + frames; frame += 2) {
      stage = 'read';
      if (frame === warmup) {
        bridge.take();
        started = clock.now();
        presented = 0;
      }
      if (paced) await clock.sleep(origin + (frame + 1) * interval - clock.now());
      await pairedLive.pair({
        decoder,
        sink,
        units: [modeled(frame), modeled(frame + 1)],
        layout: DECODED,
        enter: name => {
          stage = name;
        },
        onPresented: count => {
          presented += count;
        }
      });
    }
    for (let frame = 0; !paired && frame < warmup + frames; frame++) {
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
        if (linkedGates && pending) {
          const staged = await worker.stageInput({...unit, sendFirst: true});
          const [, acquired] = await Promise.all([
            worker.verifyReceived(staged, undefined, pending),
            worker.waitForAcquired(pending)
          ]);
          stage = 'destination';
          const destination = await sink.workerDestination(acquired.presentation);
          stage = 'split-output';
          await worker.openOutputFetch(pending, destination, DECODED, staged);
          const [current] = await Promise.all([
            worker.finishInputAfterLinkedGate(staged),
            worker.completeOutputFetch(pending)
          ]);
          pending = current;
          presented++;
          continue;
        }
        const current = await worker.completeInput(
          await worker.stageInput({...unit, sendFirst: true})
        );
        if (pending) {
          stage = 'destination';
          const destination = nativePublish
            ? await sink.workerDestination(current.presentation)
            : await sink.destination();
          stage = 'split-output';
          await worker.finishOutput(pending, destination, DECODED, autoQueue ? current : null);
          if (!nativePublish) {
            stage = 'publish';
            await sink.publish(destination, DECODED);
          }
          presented++;
        }
        stage = 'split-queue';
        if (!autoQueue || !pending) await worker.queueOutput(current);
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
      paired,
      nativePublish,
      autoQueue,
      linkedGates,
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
  for (const name of ['persistent', 'split', 'splitPublish', 'splitPublishAuto', 'splitLinked']) {
    const mode = name.startsWith('splitPublish') || name === 'splitLinked' ? 'split' : name;
    const nativePublish = name.startsWith('splitPublish') || name === 'splitLinked';
    const autoQueue = name === 'splitPublishAuto' || name === 'splitLinked';
    const linkedGates = name === 'splitLinked';
    const paced = await simulate({mode, frames, model, nativePublish, autoQueue, linkedGates});
    const free = await simulate({
      mode,
      frames,
      model,
      nativePublish,
      autoQueue,
      linkedGates,
      paced: false
    });
    modes[name] = {
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
  for (const name of ['persistent', 'split', 'splitPublish', 'splitPublishAuto', 'splitLinked']) {
    const options = {
      mode: name.startsWith('splitPublish') || name === 'splitLinked' ? 'split' : name,
      nativePublish: name.startsWith('splitPublish') || name === 'splitLinked',
      autoQueue: name === 'splitPublishAuto' || name === 'splitLinked',
      linkedGates: name === 'splitLinked',
      frames,
      model: {...model, decodeMs: PLAN_DECODE_MS}
    };
    planDecode[name] = {
      requestsPerFrame: (await simulate(options)).requestsPerFrame,
      predictedFps: (await simulate({...options, paced: false})).fps
    };
  }
  const paired = {};
  for (const sourceFps of [30, 60, 120]) {
    const rate = {...model, sourceFps};
    const paced = await simulate({mode: 'paired', frames, model: rate});
    const free = await simulate({mode: 'paired', frames, model: rate, paced: false});
    const fastPresent = await simulate({
      mode: 'paired',
      frames,
      model: {...rate, vsyncMs: 1000 / 120},
      paced: false
    });
    paired[sourceFps + 'fps'] = {
      requestsPerFrame: paced.requestsPerFrame,
      bridgeMsPerFrame: paced.bridgeMsPerFrame,
      fps: paced.fps,
      predictedFps: free.fps,
      predictedFpsAt120HzPresent: fastPresent.fps,
      byStage: paced.byStage
    };
  }
  const staggered = {};
  for (const sourceFps of [60, 120]) {
    for (const presentHz of [60, 120]) {
      for (const retryRate of [0, 0.1, 0.3]) {
        const options = {mode: 'staggered', frames, presentHz, retryRate};
        const rate = {...model, sourceFps};
        const paced = await simulate({...options, model: rate});
        const free = await simulate({...options, model: rate, paced: false});
        staggered[`${sourceFps}fps-${presentHz}Hz-retry${retryRate * 100}`] = {
          requestsPerFrame: paced.requestsPerFrame,
          bridgeMsPerFrame: paced.bridgeMsPerFrame,
          fps: paced.fps,
          predictedFps: free.fps
        };
      }
    }
  }
  const staggeredLag2 = {};
  for (const decodeMs of [model.decodeMs, R3_DECODE_MS]) {
    for (const retryRate of [0, 0.1, 0.3]) {
      const options = {mode: 'staggered', frames, presentHz: 120, retryRate, lag: 2};
      const rate = {...model, decodeMs, sourceFps: 120};
      const paced = await simulate({...options, model: rate});
      const free = await simulate({...options, model: rate, paced: false});
      staggeredLag2[`120fps-120Hz-decode${decodeMs}-retry${retryRate * 100}`] = {
        requestsPerFrame: paced.requestsPerFrame,
        bridgeMsPerFrame: paced.bridgeMsPerFrame,
        fps: paced.fps,
        predictedFps: free.fps
      };
    }
  }
  const staggeredBarrier = {};
  for (const sourceFps of [60, 120]) {
    for (const presentHz of [60, 120]) {
      for (const decodeMs of [model.decodeMs, R3_DECODE_MS]) {
        for (const retryRate of [0, 0.1, 0.3]) {
          const options = {mode: 'staggered', frames, presentHz, retryRate, lag: 2};
          const rate = {...model, decodeMs, sourceFps};
          const paced = await simulate({...options, barrier: true, model: rate});
          const free = await simulate({...options, barrier: true, model: rate, paced: false});
          const open = await simulate({...options, model: rate, paced: false});
          staggeredBarrier[
            `${sourceFps}fps-${presentHz}Hz-decode${decodeMs}-retry${retryRate * 100}`
          ] = {
            requestsPerFrame: paced.requestsPerFrame,
            bridgeMsPerFrame: paced.bridgeMsPerFrame,
            fps: paced.fps,
            predictedFps: free.fps,
            predictedFpsWithoutBarrier: open.fps
          };
        }
      }
    }
  }
  const staggeredRetryWait = {};
  for (const decodeMs of [model.decodeMs, R3_DECODE_MS]) {
    for (const retryRate of [0.1, 0.3]) {
      for (const retryWaitMs of [5, 1, 0]) {
        const options = {mode: 'staggered', frames, presentHz: 120, retryRate, lag: 2};
        const rate = {...model, decodeMs, sourceFps: 120};
        const free = await simulate({
          ...options,
          barrier: true,
          retryWaitMs,
          model: rate,
          paced: false
        });
        staggeredRetryWait[`decode${decodeMs}-retry${retryRate * 100}-wait${retryWaitMs}`] = {
          requestsPerFrame: free.requestsPerFrame,
          predictedFps: free.fps
        };
      }
    }
  }
  const staggeredHostWait = {};
  for (const presentHz of [60, 120]) {
    for (const paced of [true, false]) {
      for (const hostWait of ['poll', 'pacer']) {
        const result = await simulate({
          mode: 'staggered',
          frames,
          presentHz,
          lag: 2,
          barrier: true,
          hostWait,
          paced,
          model: {...model, sourceFps: presentHz}
        });
        staggeredHostWait[`${presentHz}Hz-${paced ? 'paced' : 'unpaced'}-${hostWait}`] = {
          requestsPerFrame: result.requestsPerFrame,
          rereadsPerFrame: result.rereadsPerFrame,
          fps: result.fps
        };
      }
    }
  }
  return {
    frames,
    model,
    assumptions: [
      'Requests, bridge-ms and byStage are at the paced source rate; predictedFps is the same loop with every access unit already waiting.',
      'The loop mirrors native-h264.cjs steady state, including the split send-before-gate path; native-decoder.cjs adds no request while the tail AcquireInput returns an index.'
    ],
    modes,
    paired,
    staggered,
    staggeredLag2,
    staggeredBarrier,
    staggeredRetryWait,
    staggeredHostWait,
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

module.exports = {MODEL, BASELINE, STAGGERED, createClock, simulate, budget};
