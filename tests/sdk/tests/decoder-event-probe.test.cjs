// The decoder event probe against a fake console that runs its watcher workers, with a fake
// movie decoder that signals the registered events the way the adapter thread would.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {ADDRESS, runDirectory, expectSequence} = require('./recording-rpc.cjs');
const {gateConsole} = require('./gate-worker-mock.cjs');
const probe = require('../tools/probe-decoder-events.cjs');
const register = require('../native/movie-event-functions.json').registerClientEvents;

const WIDTH = 16,
  HEIGHT = 8,
  FRAME = (WIDTH * HEIGHT * 3) / 2;
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-decoder-events-'));

async function quiet(action) {
  const log = console.log,
    error = console.error;
  console.log = console.error = () => {};
  try {
    return await action();
  } finally {
    console.log = log;
    console.error = error;
  }
}

// An Annex-B clip of SPS/PPS and one single-slice AU per entry of display, with its timing
// sidecar and a reference whose display frame k is filled with k. With subset, the reference
// holds only those display frames and the sidecar lists them.
function clipFiles(display, {frame = FRAME, subset = null} = {}) {
  const folder = temporary();
  const start = [0, 0, 0, 1];
  const nal = bytes => [...start, ...bytes];
  const bytes = [...nal([0x67, 0x42, 0, 0x1e]), ...nal([0x68, 0xce, 1])];
  display.forEach((_, i) => bytes.push(...nal(i ? [0x41, 0x9a, i] : [0x65, 0x88, 0x84])));
  const clip = path.join(folder, 'clip.h264');
  fs.writeFileSync(clip, Buffer.from(bytes));
  fs.writeFileSync(
    path.join(folder, 'clip.json'),
    JSON.stringify(subset ? {display, references: subset} : {display})
  );
  const kept = subset ?? display.map((_, k) => k);
  const reference = Buffer.alloc(kept.length * frame);
  kept.forEach((k, i) => reference.fill(k, i * frame, (i + 1) * frame));
  fs.writeFileSync(path.join(folder, 'clip-reference.nv12'), reference);
  return clip;
}

// hold: frames the decoder keeps until more input arrives (released in display order).
// silent: it never signals the output event. corrupt: frame 1 comes out wrong.
// slots: frames it can hold, decoded or not taken, before its input side is full.
function fakeDecoder(
  fake,
  {hold = 0, silent = false, corrupt = false, slots = Infinity, width = WIDTH, height = HEIGHT} = {}
) {
  const bytes = (width * height * 3) / 2;
  const {memory, rpc} = fake;
  const state = {struct: null, inside: [], ready: [], closed: false, configured: null};
  const signal = offset => {
    const event = memory.read64(state.struct + offset);
    if (event) fake.signal(event);
  };
  fake.rpc.names.set(ADDRESS.module + register.offset, 'movie.registerClientEvents');
  fake.handlers['movie.registerClientEvents'] = ([, struct]) => {
    state.struct = Number(struct);
    return 0n;
  };
  const create = async () => ({
    lastInput: null,
    lastStamp: null,
    async configure(sps, pps, fps, {beforeStart}) {
      rpc.note('decoder.configure');
      await beforeStart(0x5a000000);
      rpc.note('decoder.start');
      signal(0);
      return {width, height};
    },
    async submit(unit, {acquireOutput, stamp}) {
      assert.equal(acquireOutput, false);
      assert.equal(fake.rpc.names.get(stamp), 'timing.tick');
      this.lastStamp = fake.clock();
      state.inside.push(unit.pts);
      state.inside.sort((a, b) => a - b);
      while (state.inside.length > hold) {
        state.ready.push(state.inside.shift());
        if (!silent) signal(8);
      }
      signal(0);
      this.lastInput = {
        status: 0,
        index: state.inside.length + state.ready.length < slots ? 1 : -1
      };
    },
    async receive(destination) {
      if (!state.ready.length) return null;
      const shown = state.ready.shift();
      memory.write(destination.address, Buffer.alloc(bytes, corrupt && shown === 1 ? 9 : shown));
      return {
        width,
        height,
        stride: width,
        sliceHeight: height,
        bytes,
        pts: String(shown),
        format: 'nv12'
      };
    },
    async close() {
      state.closed = true;
      rpc.note('decoder.close');
    }
  });
  return {create, state};
}

async function run(
  display,
  {console: consoleOptions = {}, decoder = {}, subset = null, ...options} = {}
) {
  const fake = gateConsole({advanceOnRead: true, ...consoleOptions});
  const movie = fakeDecoder(fake, decoder);
  const directory = runDirectory(fake.rpc, {
    'compatibility-module.json': {
      base: ADDRESS.module,
      symbols: [{name: register.symbol, offset: register.offset, size: register.size}]
    }
  });
  const output = temporary();
  const outcome = await quiet(() =>
    probe.main(directory, {
      clip: clipFiles(display, {
        frame: ((decoder.width ?? WIDTH) * (decoder.height ?? HEIGHT) * 3) / 2,
        subset
      }),
      output,
      settleMs: 20,
      pollMs: 1,
      drainMs: 20,
      createDecoder: movie.create,
      ...options
    })
  ).then(
    report => ({report}),
    error => ({error})
  );
  const record = JSON.parse(fs.readFileSync(path.join(output, 'decoder-event-probe.json'), 'utf8'));
  return {...outcome, record, fake, movie};
}

const position = (lines, pattern, from = 0) => {
  const index = lines.findIndex((line, i) => i >= from && pattern.test(line));
  assert.ok(index >= 0, 'missing ' + pattern);
  return index;
};

test('access units split at each first slice and keep their parameter sets', () => {
  const nal = bytes => [0, 0, 0, 1, ...bytes];
  const clip = Buffer.from([
    ...nal([0x67, 1]),
    ...nal([0x68, 2]),
    ...nal([0x06, 3]),
    ...nal([0x65, 0x88]),
    ...nal([0x65, 0x08]),
    ...nal([0x41, 0x9a]),
    ...nal([0x09, 0x10]),
    ...nal([0x41, 0x80])
  ]);
  const units = probe.accessUnits(clip);
  assert.deepEqual(
    units.map(u => [u.keyframe, u.data.length]),
    [
      [true, 30],
      [false, 6],
      [false, 12]
    ]
  );
  assert.deepEqual([...units[1].data], nal([0x41, 0x9a]));
});

test('frame comparison wants exact luma and a chroma PSNR floor', () => {
  const expected = Buffer.alloc(FRAME, 100);
  assert.equal(probe.compareFrame(Buffer.from(expected), expected, WIDTH, HEIGHT).match, true);
  const chroma = Buffer.from(expected);
  chroma[WIDTH * HEIGHT] = 104;
  const near = probe.compareFrame(chroma, expected, WIDTH, HEIGHT);
  assert.equal(near.lumaMaxError, 0);
  assert.equal(near.match, true);
  const luma = Buffer.from(expected);
  luma[0] = 101;
  assert.equal(probe.compareFrame(luma, expected, WIDTH, HEIGHT).match, false);
});

test('immediate output: one event and one first-try acquire per AU', async () => {
  const {report, error, fake} = await run([0, 1, 2, 3]);
  assert.equal(error, undefined);
  assert.equal(report.verdict, 'PASS');
  const loop = report.loop;
  assert.equal(loop.firstOutputAfterAu, 0);
  assert.deepEqual(loop.outputsPerAu, {1: 4});
  assert.deepEqual(loop.outputEventsPerAu, {1: 4});
  assert.deepEqual(loop.lagAus, {0: 4});
  assert.equal(loop.acquiredAfterEvent, 4);
  assert.equal(loop.emptyAfterEvent, 0);
  assert.equal(loop.held, 0);
  assert.equal(loop.displayOrder, true);
  assert.deepEqual(loop.inputEventsPerAu, {1: 4});
  assert.equal(loop.inputReadyAfterSend, 4);
  assert.equal(report.afterStart.input, 1);
  assert.deepEqual(report.correctness.matched, 4);
  assert.equal(report.registerStatus, 0);
  assert.equal(report.tickFrequency, 19200000);
  assert.equal(loop.consoleLatencyMs.n, 4);
  assert.ok(loop.consoleLatencyMs.max >= 0);
  assert.equal(loop.submitMs.n, 4);
  // One submit and one receive that hits plus the empty one, per AU.
  assert.equal(report.exchangeCalls.submit, 4);
  assert.equal(report.exchangeCalls.receive, 8);
  // RegisterClientEvents sits between Configure and Start, after the watchers wait.
  const lines = fake.rpc.lines;
  const created = position(lines, /^callAddress thread\.create\(/);
  const second = position(lines, /^callAddress thread\.create\(/, created + 1);
  const configure = position(lines, /^decoder\.configure$/);
  const registered = position(lines, /^callAddress movie\.registerClientEvents\(/);
  const started = position(lines, /^decoder\.start$/);
  assert.ok(second < configure && configure < registered && registered < started);
});

test('held frames show as output latency and as frames left after the drain', async () => {
  const {report, record} = await run([0, 2, 1, 4, 3], {decoder: {hold: 2}});
  assert.equal(record.error, undefined);
  assert.equal(report.verdict, 'PASS');
  const loop = report.loop;
  assert.equal(loop.firstOutputAfterAu, 2);
  assert.deepEqual(loop.outputsPerAu, {0: 2, 1: 3});
  assert.equal(loop.held, 2);
  assert.deepEqual(loop.heldDisplays, [3, 4]);
  assert.equal(loop.displayOrder, true);
  assert.deepEqual(
    report.frames.map(f => [f.display, f.afterAu]),
    [
      [0, 2],
      [1, 3],
      [2, 4]
    ]
  );
  // Lag counts AUs from a frame's own submission: display 2 went in second, came out fifth.
  assert.deepEqual(loop.lagAus, {1: 1, 2: 1, 3: 1});
  assert.equal(loop.maxLagAus, 3);
  assert.equal(report.correctness.matched, 3);
});

test('a silent output event still finds the frames and says so', async () => {
  const {report} = await run([0, 1], {decoder: {silent: true}});
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.loop.eventSeenAus, 0);
  assert.equal(report.loop.outputWithoutEvent, 2);
  assert.deepEqual(report.loop.outputEventsPerAu, {0: 2});
});

test('shutdown wakes and joins both watchers, closes the decoder, then finalizes', async () => {
  const {report, fake, movie} = await run([0, 1, 2]);
  assert.equal(report.finalized, true);
  assert.equal(movie.state.closed, true);
  const lines = fake.rpc.lines;
  const lastSubmit = lines.findLastIndex(l => l === 'decoder.start');
  const stop = position(lines, /^write heap\+0x[0-9a-f]+ 8 /, lastSubmit + 1);
  const wake = position(lines, /^callAddress os\.signalEvent\(/, stop);
  const wake2 = position(lines, /^callAddress os\.signalEvent\(/, wake + 1);
  const joined = position(lines, /^callAddress thread\.join\(/, wake2);
  const joined2 = position(lines, /^callAddress thread\.join\(/, joined + 1);
  const closed = position(lines, /^decoder\.close$/, joined2);
  const finalized = position(lines, /^callAddress os\.finalizeEvent\(/, closed);
  assert.ok(finalized > closed);
  assert.equal(lines.filter(l => l.startsWith('callAddress os.finalizeEvent')).length, 2);
  assert.equal(fake.trace.filter(t => t === 'exit').length, 2);
  assert.ok([...fake.workers.values()].every(w => w.exited));
  expectSequence('decoder-event-probe', lines);
});

test('a stuck watcher keeps the decoder and the events alive', async () => {
  const {error, record, movie, fake} = await run([0, 1], {
    console: {stuck: true},
    stopTimeoutMs: 30
  });
  assert.match(error.message, /Event watcher output did not stop/);
  assert.equal(record.verdict, 'FAIL');
  assert.equal(movie.state.closed, false);
  assert.equal(record.finalized, undefined);
  assert.equal(record.retained.decoder, true);
  assert.equal(record.retained.events.length, 2);
  // The probe still ran: frames came out without any counted event.
  assert.equal(record.loop.received, 2);
  assert.equal(record.loop.eventSeenAus, 0);
  assert.ok(!fake.rpc.lines.some(l => /^callAddress (thread\.join|os\.finalizeEvent)/.test(l)));
});

test('a wrong frame fails the probe but still shuts down cleanly', async () => {
  const {error, record} = await run([0, 1, 2], {decoder: {corrupt: true}});
  assert.equal(error.message, 'Decoded frames differ from the reference');
  assert.equal(record.correctness.matched, 2);
  assert.equal(record.decoderClosed, true);
  assert.equal(record.finalized, true);
});

test('a run that fails part way still reports the AUs that ran', async () => {
  const {error, record} = await run([0, 1, 1, 2]);
  assert.equal(error.message, 'Unexpected or repeated output pts 1');
  assert.equal(record.loop.submitted, 2);
  assert.equal(record.loop.received, 2);
  assert.equal(record.loop.held, 0);
  assert.equal(record.correctness.matched, 2);
  assert.equal(record.finalized, true);
});

test('every event function is verified before use, the worker ones before spawn', async () => {
  const {fake} = await run([0]);
  const lines = fake.rpc.lines;
  const spawned = position(lines, /^callAddress thread\.create\(/);
  for (const name of ['os.initializeEvent', 'os.signalEvent', 'os.finalizeEvent']) {
    const verified = position(lines, new RegExp('^verify ' + name + ' '));
    const used = lines.findIndex(l => !l.startsWith('verify') && l.includes(name + '('));
    assert.ok(verified < used, name + ' used before verify');
  }
  assert.ok(position(lines, /^verify os\.waitEvent /) < spawned);
  assert.ok(position(lines, /^verify os\.atomicAddU32 /) < spawned);
  assert.ok(position(lines, /^verify timing\.tick /) < spawned);
  assert.ok(
    position(lines, /^verify timing\.frequency /) <
      position(lines, /^callAddress timing\.frequency/)
  );
  assert.ok(
    position(lines, /^verify movie\.registerClientEvents /) <
      position(lines, /^callAddress movie\.registerClientEvents\(/)
  );
});

test('burst keeps sending while outputs keep up and times them on the console', async () => {
  const {report, error} = await run([0, 1, 2, 3, 4, 5], {burst: true});
  assert.equal(error, undefined);
  assert.equal(report.verdict, 'PASS');
  const loop = report.loop;
  assert.equal(loop.submitted, 6);
  assert.equal(loop.received, 6);
  assert.equal(loop.held, 0);
  assert.equal(loop.inputBlocked, 0);
  assert.equal(loop.host.submitMs.n, 6);
  assert.equal(loop.console.oneEventPerOutput, true);
  assert.equal(loop.console.eventsTimed, 6);
  assert.equal(loop.console.latencyMs.n, 6);
  assert.equal(loop.console.outputIntervalMs.n, 5);
  assert.equal(loop.console.maxInFlight, 0);
  assert.equal(report.correctness.matched, 6);
  // One submit, one sample and one receive per AU; no empty acquires while outputs keep up.
  assert.equal(report.exchangeCalls.submit, 6);
  assert.equal(
    report.frames.every((f, i) => f.afterAu === i),
    true
  );
});

test('burst drains when the input side fills and reports what stayed inside', async () => {
  const {report, record} = await run([0, 2, 1, 4, 3, 5], {
    burst: true,
    decoder: {hold: 2, slots: 3}
  });
  assert.equal(record.error, undefined);
  assert.equal(report.verdict, 'PASS');
  const loop = report.loop;
  assert.equal(loop.submitted, 6);
  assert.equal(loop.received, 4);
  assert.deepEqual(loop.heldDisplays, [4, 5]);
  assert.equal(loop.displayOrder, true);
  assert.ok(loop.inputBlocked > 0);
  assert.ok(report.sends.filter(s => s.blocked).every(s => s.au > 0));
  assert.ok(loop.console.maxInFlight >= 2);
  assert.equal(report.finalized, true);
});

test('burst shuts down in the same order as the per-AU run', async () => {
  const {report, fake} = await run([0, 1, 2], {burst: true});
  assert.equal(report.finalized, true);
  const lines = fake.rpc.lines;
  const closed = position(lines, /^decoder\.close$/);
  const joins = lines.flatMap((l, i) => (l.startsWith('callAddress thread.join') ? [i] : []));
  assert.equal(joins.length, 2);
  assert.ok(joins.every(i => i < closed));
  assert.ok(position(lines, /^callAddress os\.finalizeEvent\(/, closed) > closed);
});

test('large frames are read and compared only where the reference subset has them', async () => {
  const {report} = await run([0, 1, 2, 3, 4], {
    burst: true,
    subset: [0, 3, 4],
    decoder: {width: 256, height: 192}
  });
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.loop.received, 5);
  assert.equal(report.exchangeCalls.frameRead, 3);
  assert.deepEqual(
    report.frames.filter(f => f.sha256).map(f => f.display),
    [0, 3, 4]
  );
  assert.equal(report.correctness.compared, 3);
  assert.equal(report.correctness.matched, 3);
  assert.deepEqual(report.correctness.last.display, 4);
});

test('burst summary times outputs from the watcher ticks and SendInput stamps', () => {
  const sends = [0, 1, 2].map(au => ({
    au,
    display: au,
    hostAt: au * 5,
    sendTick: String(1000 + au * 100)
  }));
  const samples = [
    {count: 1, tick: '1050', sent: 1, received: 0},
    {count: 2, tick: '1150', sent: 2, received: 1},
    {count: 3, tick: '1250', sent: 3, received: 2}
  ];
  const frames = [0, 1, 2].map(display => ({display, afterAu: display, hostAt: display * 10}));
  const loop = probe.summarizeBurst({
    sends,
    samples,
    frames,
    held: [],
    eventCount: 3,
    ms: ticks => Number(ticks) / 10
  });
  assert.deepEqual(loop.console.latencyMs, {n: 3, p50: 5, p95: 5, max: 5, mean: 5});
  assert.equal(loop.console.outputIntervalMs.p50, 10);
  assert.equal(loop.console.outputFps, 100);
  assert.equal(loop.console.inputFps, 100);
  assert.equal(loop.console.maxInFlight, 0);
  assert.equal(loop.host.fps, 150);
});
