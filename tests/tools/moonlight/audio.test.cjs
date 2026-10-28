// Host audio: the socket plan, the AudioOut stream, the socket audio source and its worker.
const test = require('node:test');
const assert = require('node:assert/strict');
const {PassThrough} = require('node:stream');
const {EventEmitter} = require('node:events');
const {
  primeReceive,
  checkedPrimeCounts,
  primeAppend,
  cycle,
  checkedCycle
} = require('../../../host/audio/audio-socket-plan.js');
const {stream, ByteQueue} = require('../../../host/audio/audio-stream.js');
const {mockRpc} = require('../../../../hbl-platform/tests/audio-out-mock.cjs');
const {create} = require('../../../host/audio/socket-audio-source.js');

// audio-socket-plan.js
const options = {
  sdk: 0x10000000,
  base: 0x50000000,
  fd: 11,
  audio: 0x30000000,
  event: 0x30000100,
  recv: 0x10020000,
  append: 0x10030000,
  getReleased: 0x10040000,
  slots: [
    {descriptor: 0x30000400, data: 0x30010000},
    {descriptor: 0x30000440, data: 0x30014000}
  ],
  bufferBytes: 3840
};

test('socket audio primes two buffers and recycles only after release events', () => {
  const received = primeReceive({...options, base: options.base + 0x10000});
  assert.equal(received.proof.logicalCalls, 2);
  const results = Buffer.alloc(received.proof.resultOffsets.length * 8);
  for (const native of received.proof.logicalResultIndices)
    results.writeBigUInt64LE(3840n, native * 8);
  const counts = checkedPrimeCounts(received, results, 3840);
  assert.deepEqual(counts, [3840, 3840]);
  const appended = primeAppend({...options, receivedCounts: counts, base: options.base + 0x10000});
  assert.equal(appended.proof.logicalCalls, 2);
  const recycled = cycle(options);
  assert.equal(recycled.program.proof.logicalCalls, 10);
  for (const row of recycled.rows) {
    assert.ok(row.wait < row.released);
    assert.ok(row.released < row.receive);
    assert.ok(row.receive < row.append);
  }
  assert.ok(recycled.rows[0].append < recycled.rows[1].wait);
  assert.ok(recycled.program.frame.length < 0x100000);
  const cycleResults = Array.from({length: recycled.calls.length}, () => 0n);
  for (const row of recycled.rows) {
    cycleResults[row.released] = BigInt(options.slots[row.index].descriptor);
    cycleResults[row.receive] = 3840n;
    cycleResults[row.append] = 1n;
  }
  assert.doesNotThrow(() => checkedCycle(cycleResults, recycled.rows, options.slots, 3840));
  cycleResults[recycled.rows[1].released] = BigInt(options.slots[0].descriptor);
  assert.throws(
    () => checkedCycle(cycleResults, recycled.rows, options.slots, 3840),
    /invalid descriptor or count/
  );
});

test('socket audio refuses overlapping descriptors and oversized PCM chunks', () => {
  assert.throws(
    () => cycle({...options, slots: [options.slots[0], options.slots[0]]}),
    /distinct bounded/
  );
  assert.throws(() => primeReceive({...options, bufferBytes: 0x4004}), /distinct bounded/);
  const received = primeReceive({...options, base: options.base + 0x10000});
  const results = Buffer.alloc(received.proof.resultOffsets.length * 8);
  results.writeBigUInt64LE(3840n, received.proof.logicalResultIndices[0] * 8);
  results.writeBigUInt64LE(3839n, received.proof.logicalResultIndices[1] * 8);
  assert.throws(() => checkedPrimeCounts(received, results, 3840), /append gate remains closed/);
  assert.throws(
    () => primeAppend({...options, receivedCounts: [3840, 3839], base: options.base + 0x10000}),
    /append gate remains closed/
  );
});

// audio-stream.js

// one-shot input that delivers a whole buffer in a single data event, used to
// exercise the host-ring overrun path deterministically (a PassThrough would
// chunk at its highWaterMark and let the loop drain between chunks).
function burst() {
  const e = new EventEmitter();
  e.destroy = () => e.emit('close');
  return e;
}
const BUFFER_BYTES = 3840 * 4;

function sine(buffers) {
  const total = buffers * BUFFER_BYTES;
  const pcm = Buffer.alloc(total);
  for (let i = 0; i < total / 2; i++) pcm.writeInt16LE(Math.round(20000 * Math.sin(i / 40)), i * 2);
  return pcm;
}

// a sleep that yields to the event loop (so stream 'data' events fire) then
// advances the mock's virtual clock by the requested amount. A zero sleep must
// not move the clock, so a module that spins on sleep(0) hangs the test.
function virtualSleep(mock) {
  return ms =>
    new Promise(resolve =>
      setImmediate(() => {
        mock.advance(ms);
        resolve();
      })
    );
}

test('primes, starts, appends in order and recycles across wraparound', async () => {
  const mock = mockRpc({combined: true});
  const input = new PassThrough();
  const pcm = sine(20);
  const session = stream({
    rpc: mock.rpc,
    input,
    queue: 3,
    prime: 2,
    maxPending: 64 * BUFFER_BYTES,
    sleep: virtualSleep(mock),
    now: () => mock.clock.t
  });
  input.end(pcm);
  const stats = await session.done;

  // first calls: init, open, three format reads, 8 SetInfo, then appends/start
  const calls = mock.log.calls;
  assert.match(calls[0], /InitializeAudioOutParameter/);
  assert.match(calls[1], /OpenDefaultAudioOut/);
  const setInfo = calls.filter(c => c.includes('SetAudioOutBufferInfo')).length;
  assert.strictEqual(setInfo, 8, 'SetAudioOutBufferInfo once per descriptor');
  const firstStart = calls.indexOf(calls.find(c => c.includes('StartAudioOut')));
  const appendsBeforeStart = calls
    .slice(0, firstStart)
    .filter(c => c.includes('AppendAudioOutBuffer')).length;
  assert.strictEqual(appendsBeforeStart, 2, 'starts after priming two buffers');

  // every slot write, in order, reconstructs the source PCM (tests wraparound)
  const reassembled = Buffer.concat(mock.log.writes.map(w => w.bytes));
  assert.strictEqual(reassembled.length, pcm.length);
  assert.ok(reassembled.equals(pcm), 'slots written back to back in order');
  assert.strictEqual(stats.appended, 20);
  assert.strictEqual(mock.log.combinedWrites, 20);
  assert.strictEqual(stats.released, 20);
  assert.strictEqual(stats.overruns, 0);
  assert.strictEqual(mock.queued.length, 0, 'queue fully drained');

  // polls only for buffers whose playback has elapsed: one per buffer, no empty terminator.
  assert.ok(
    mock.getReleasedCalls <= stats.appended + 2,
    'GetReleasedAudioOutBuffer polling stays within the exchange budget: ' + mock.getReleasedCalls
  );
});

test('bounds host ring and counts overruns when the reader floods', async () => {
  const mock = mockRpc();
  const input = burst();
  const session = stream({
    rpc: mock.rpc,
    input,
    queue: 3,
    prime: 2,
    maxPending: 5 * BUFFER_BYTES,
    sleep: virtualSleep(mock),
    now: () => mock.clock.t
  });
  input.emit('data', sine(40)); // far more than the ring can hold at once
  input.emit('end');
  const stats = await session.done;
  assert.ok(stats.overruns > 0, 'overruns counted');
  assert.ok(stats.droppedBytes > 0, 'bytes dropped to bound latency');
  assert.ok(stats.appended < 40, 'flooded buffers were not all played');
  assert.strictEqual(mock.queued.length, 0);
});

test('counts underruns when the reader starves, then recovers', async () => {
  const mock = mockRpc();
  const input = new PassThrough();
  const session = stream({
    rpc: mock.rpc,
    input,
    queue: 3,
    prime: 2,
    maxPending: 64 * BUFFER_BYTES,
    sleep: virtualSleep(mock),
    now: () => mock.clock.t
  });
  // prime, let the loop drain to empty (underrun), then feed more and end cleanly
  input.write(sine(2));
  await new Promise(r => setTimeout(r, 40));
  input.write(sine(3));
  await new Promise(r => setTimeout(r, 20));
  input.end();
  const stats = await session.done;
  assert.ok(stats.underruns > 0, 'underrun observed');
  assert.ok(stats.appended >= 5, 'playback resumed after the gap');
  assert.strictEqual(mock.queued.length, 0);
});

test('flushes a short tail at EOF with silence padding', async () => {
  const mock = mockRpc();
  const input = new PassThrough();
  const session = stream({
    rpc: mock.rpc,
    input,
    queue: 3,
    prime: 1,
    maxPending: 64 * BUFFER_BYTES,
    sleep: virtualSleep(mock),
    now: () => mock.clock.t
  });
  const partial = Buffer.concat([sine(1), Buffer.alloc(100, 7)]);
  input.end(partial);
  const stats = await session.done;
  assert.strictEqual(stats.tail, 1, 'one padded tail buffer');
  assert.strictEqual(stats.appended, 2);
  assert.strictEqual(mock.queued.length, 0);
});

test('stop() drains and tears down cleanly mid-stream', async () => {
  const mock = mockRpc();
  const input = new PassThrough();
  const session = stream({
    rpc: mock.rpc,
    input,
    queue: 3,
    prime: 2,
    maxPending: 64 * BUFFER_BYTES,
    sleep: virtualSleep(mock),
    now: () => mock.clock.t
  });
  input.write(sine(6));
  await new Promise(r => setTimeout(r, 20));
  session.stop();
  const stats = await session.done;
  assert.ok(stats.appended > 0);
  assert.strictEqual(mock.queued.length, 0, 'teardown flushed the queue');
  assert.ok(
    mock.log.calls.some(c => c.includes('CloseAudioOut')),
    'closed the device'
  );
});

test('reports a hint when OpenDefaultAudioOut fails', async () => {
  const mock = mockRpc({openFail: true});
  const input = new PassThrough();
  const session = stream({
    rpc: mock.rpc,
    input,
    sleep: virtualSleep(mock),
    now: () => mock.clock.t
  });
  input.end(sine(1));
  await assert.rejects(session.done, /game-audio\.js/);
});

test('ByteQueue pulls and drops in FIFO order', () => {
  const q = new ByteQueue();
  q.push(Buffer.from([1, 2, 3]));
  q.push(Buffer.from([4, 5, 6]));
  assert.strictEqual(q.bytes, 6);
  assert.deepStrictEqual([...q.pull(2)], [1, 2]);
  assert.strictEqual(q.dropOldest(2), 2);
  assert.deepStrictEqual([...q.pull(2)], [5, 6]);
  assert.strictEqual(q.bytes, 0);
});

// socket-audio-source.js
const CHUNK = 7680;
const flush = () => new Promise(resolve => setImmediate(resolve));
const filled = value => Buffer.alloc(CHUNK, value);

function clock() {
  let time = 0;
  const waiters = [];
  return {
    now: () => time,
    sleep: ms => new Promise(resolve => waiters.push({at: time + ms, resolve})),
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        waiters.sort((a, b) => a.at - b.at);
        if (!waiters.length || waiters[0].at > end) break;
        const next = waiters.shift();
        time = next.at;
        next.resolve();
        await flush();
      }
      time = end;
      await flush();
    }
  };
}

function fakes({stopError = null, retainOnStop = false, startError = null, sendError = null} = {}) {
  const events = [];
  const sends = [];
  let retained = false;
  const transport = {
    fd: 3,
    close: async () => events.push('transport-close'),
    abort: () => events.push('transport-abort')
  };
  const audio = {
    async start(first, second) {
      events.push('start');
      sends.push(first, second);
      if (startError) throw startError;
    },
    async send(bytes) {
      if (sendError) throw sendError;
      sends.push(bytes);
    },
    async health() {
      events.push('health');
      return {sent: sends.length, running: true, retained, results: ['0', '1']};
    },
    async stop() {
      events.push('audio-stop');
      if (retainOnStop) retained = true;
      if (stopError) throw stopError;
    },
    get retained() {
      return retained;
    }
  };
  const timers = [];
  return {
    events,
    sends,
    timers,
    options: {
      rpc: {a: {sdk: 1}, host: '192.0.2.10'},
      bufferBytes: CHUNK,
      createTransport: async ({host}) => {
        events.push('transport:' + host);
        return transport;
      },
      createAudio: async ({transport: given, bufferBytes}) => {
        assert.equal(given, transport);
        assert.equal(bufferBytes, CHUNK);
        events.push('audio');
        return audio;
      },
      every(callback, ms) {
        timers.push({callback, ms});
        return timers.length;
      },
      cancel: id => events.push('cancel:' + id)
    }
  };
}

test('primes silence, paces one chunk per 40 ms and fills gaps with silence', async () => {
  const f = fakes();
  const time = clock();
  const source = await create({...f.options, now: time.now, sleep: time.sleep});
  const input = new PassThrough();
  source.attach(input);
  await flush();
  assert.deepEqual(f.events.slice(0, 3), ['transport:192.0.2.10', 'audio', 'start']);
  assert.equal(f.sends.length, 3);
  assert.ok(f.sends.every(chunk => chunk.equals(filled(0))));
  input.write(Buffer.concat([filled(1), filled(2)]));
  await flush();
  await time.advance(40);
  await time.advance(40);
  assert.deepEqual(
    f.sends.slice(3).map(chunk => chunk[0]),
    [1, 2]
  );
  await time.advance(80);
  assert.equal(f.sends.length, 7);
  const report = await source.close();
  assert.equal(report.underruns, 1);
  assert.equal(report.silenceChunks, 3);
  assert.equal(report.sent, 7);
  assert.equal(report.appended, 7);
  assert.equal(report.released, 5);
  assert.equal(report.overruns, 0);
  assert.equal(report.receivedBytes, 2 * CHUNK);
  assert.equal(report.peak, 0x0202);
  assert.ok(f.sends.every(chunk => chunk.length === CHUNK));
});

test('tone mode sends a stereo 500 Hz tone and consumes Moonlight PCM', async () => {
  const f = fakes();
  const time = clock();
  const source = await create({...f.options, tone: true, now: time.now, sleep: time.sleep});
  const input = new PassThrough();
  source.attach(input);
  input.write(filled(1));
  await flush();
  await time.advance(40);
  const chunk = f.sends[2];
  assert.equal(chunk.readInt16LE(0), 0);
  assert.equal(chunk.readInt16LE(24 * 4), 8000);
  assert.equal(chunk.readInt16LE(24 * 4 + 2), 8000);
  assert.ok(chunk.equals(f.sends[3]), 'whole periods per chunk');
  const report = await source.close();
  assert.equal(report.tone, true);
  assert.equal(report.peak, 8000);
  assert.equal(report.silenceChunks, 0);
});

test('a flood drops the oldest whole chunks and counts overruns', async () => {
  const f = fakes();
  const time = clock();
  const source = await create({...f.options, now: time.now, sleep: time.sleep});
  const input = new PassThrough();
  source.attach(input);
  await flush();
  input.write(Buffer.concat([1, 2, 3, 4, 5, 6].map(filled)));
  await flush();
  for (let index = 0; index < 4; index++) await time.advance(40);
  assert.deepEqual(
    f.sends.slice(3).map(chunk => chunk[0]),
    [3, 4, 5, 6]
  );
  const report = await source.close();
  assert.equal(report.overruns, 2);
  assert.equal(report.droppedBytes, 2 * CHUNK);
  assert.equal(report.underruns, 0);
});

test('stop halts pacing before the worker stops, then closes TCP', async () => {
  const f = fakes();
  const time = clock();
  const source = await create({...f.options, now: time.now, sleep: time.sleep});
  const input = new PassThrough();
  source.attach(input);
  await flush();
  assert.equal(f.timers.length, 1);
  assert.ok(f.timers[0].ms >= 500, 'health polls at no more than 2 Hz');
  f.timers[0].callback();
  await flush();
  const sent = f.sends.length;
  const report = await source.close();
  assert.equal(f.sends.length, sent, 'no host send after halt');
  assert.deepEqual(f.events.slice(-3), ['cancel:1', 'audio-stop', 'transport-close']);
  assert.ok(input.destroyed);
  assert.equal(report.healthPolls, 1);
  assert.deepEqual(report.lastCycle, ['0', '1']);
  assert.equal(report.cycleCheck, 'pass');
  assert.equal(report.retainedForSafety, false);
  assert.equal(report.error, null);
  assert.equal(await source.close(), await source.close());
  assert.equal(f.events.filter(event => event === 'audio-stop').length, 1);
});

test('a worker that does not stop keeps TCP open and asks for a restart', async () => {
  const f = fakes({
    retainOnStop: true,
    stopError: Error('Socket audio recycle worker did not stop; restart SmileBASIC')
  });
  const time = clock();
  const source = await create({...f.options, now: time.now, sleep: time.sleep});
  const report = await source.close();
  assert.deepEqual(f.events.slice(-2), ['audio-stop', 'transport-abort']);
  assert.ok(!f.events.includes('transport-close'));
  assert.equal(report.retainedForSafety, true);
  assert.equal(report.cycleCheck, null);
  assert.match(report.error, /restart SmileBASIC$/);
  assert.equal(report.error.match(/restart SmileBASIC/g).length, 1);
});

test('a failed cycle check still closes TCP when nothing is retained', async () => {
  const f = fakes({stopError: Error('Socket audio recycle 0 returned an invalid descriptor')});
  const time = clock();
  const source = await create({...f.options, now: time.now, sleep: time.sleep});
  const report = await source.close();
  assert.deepEqual(f.events.slice(-2), ['audio-stop', 'transport-close']);
  assert.equal(report.retainedForSafety, false);
  assert.match(report.error, /invalid descriptor/);
});

test('setup failure cleans up like the probe and reports retention', async () => {
  const f = fakes({startError: Error('Socket audio prime receive was short')});
  await assert.rejects(create(f.options), /prime receive was short/);
  assert.deepEqual(f.events, [
    'transport:192.0.2.10',
    'audio',
    'start',
    'audio-stop',
    'transport-close'
  ]);
  const g = fakes();
  g.options.createAudio = async ({rpc}) => {
    g.events.push('audio');
    await rpc.read(0, 8);
  };
  g.options.rpc.read = async () => {
    throw Error('bridge disconnected');
  };
  const error = await create(g.options).catch(caught => caught);
  assert.match(error.message, /bridge disconnected; restart SmileBASIC/);
  assert.equal(error.report.retainedForSafety, true);
  assert.deepEqual(g.events, ['transport:192.0.2.10', 'audio', 'transport-abort']);
});

test('a mid-stream send failure reports once and stops pacing', async () => {
  const f = fakes({sendError: Error('Native TCP data socket is closed')});
  const time = clock();
  const errors = [];
  const source = await create({
    ...f.options,
    now: time.now,
    sleep: time.sleep,
    onError: error => errors.push(error.message)
  });
  await time.advance(200);
  assert.deepEqual(errors, ['Native TCP data socket is closed']);
  const report = await source.close();
  assert.equal(report.error, 'Native TCP data socket is closed');
  assert.deepEqual(f.events.slice(-2), ['audio-stop', 'transport-close']);
});

// audio-socket-worker.js
const {create: createWorker} = require('../../../host/audio/audio-socket-worker.js');
const {CODE} = require('../../../../hbl-platform/sdk/native/thread.js');
const {repeatingFrame} = require('../../../../hbl-platform/sdk/native/jobs.js');
const {build} = require('../../../../hbl-platform/smilebasic/engine/shared/frames.js');
const symbols = require('../../../../hbl-platform/sdk/native/audio-symbols.json');

const SDK = 0x40000000;
const OUTPUT = 0x20000000;
const FD = 12;
const RECV = 0x30001234;
const DESCRIPTOR_OFFSET = 0x400;
const DESCRIPTOR_STRIDE = 0x40;
const AUDIO_FUNCTIONS = {
  InitializeAudioOutParameter: 'InitializeAudioOutParameter',
  OpenDefaultAudioOut:
    'OpenDefaultAudioOutEPNS0_8AudioOutEPNS_2os11SystemEventERKNS0_17AudioOutParameterE',
  GetAudioOutSampleRate: 'GetAudioOutSampleRate',
  GetAudioOutChannelCount: 'GetAudioOutChannelCount',
  GetAudioOutSampleFormat: 'GetAudioOutSampleFormat',
  SetAudioOutBufferInfo: 'SetAudioOutBufferInfo',
  StartAudioOut: 'StartAudioOut',
  StopAudioOut: 'StopAudioOut',
  FlushAudioOutBuffers: 'FlushAudioOutBuffers',
  CloseAudioOut: 'CloseAudioOut'
};
/** Address to a short name, for the AudioOut functions the host calls and the thread gadgets. */
const NAMES = new Map();
for (const [name, match] of Object.entries(AUDIO_FUNCTIONS))
  NAMES.set(SDK + symbols.find(symbol => symbol.name.includes(match)).offset, name);
for (const [name, code] of Object.entries(CODE)) NAMES.set(SDK + code.offset, 'thread.' + name);

/** Allocations land one 16 MiB apart: AudioOut, the finite job worker, the recycle worker. */
const region = index => 0x60000000 + index * 0x1000000;
/** The recycle worker's join, which stores its exit value at base + 8; the prime jobs join too. */
const workerJoin = (name, args) => name === 'thread.join' && args[1] === region(2) + 8;
const primeJoin = (name, args) => name === 'thread.join' && args[1] === region(1) + 8;
const chunk = value => Buffer.alloc(CHUNK, value);
const named = (log, name) => log.filter(entry => entry.name === name);
const primeJobs = log => named(log, 'thread.create').filter(entry => entry.args[0] === region(1));

/**
 * A console that runs the socket audio worker's native calls against plain memory: the
 * allocations, in order, are AudioOut, the finite job worker and the recycle worker.
 * `on.call(name, args)` may return a result to replace the default, `on.send(bytes, count)`
 * and `on.read(address)` may throw; `hang` keeps the recycle thread running. `finite(job, index)`
 * is result `index` of finite job 1 (the prime receive) or 2 (the prime append); `frames` keeps
 * what is written to the finite job worker.
 */
function fakeConsole({
  on = {},
  hang = false,
  cycle = 'whole',
  finite = job => (job === 1 ? BigInt(CHUNK) : 1n)
} = {}) {
  const log = [];
  const regions = [];
  const frames = [];
  let finiteJobs = 0;
  let sends = 0;
  let recycleThread = null;
  const regionAt = address =>
    regions.find(region => address >= region.base && address < region.base + region.bytes.length);
  const audio = () => regions[0].base;
  const frame = () => repeatingFrame({base: regions[2].base, sdk: SDK, calls: [], code: CODE});

  /** Recycle results, per slot: wait, released descriptor, received count, appended. */
  function cycleResults() {
    const results = Buffer.alloc(8 * 8);
    for (let slot = 0; slot < 2; slot++) {
      const descriptor = audio() + DESCRIPTOR_OFFSET + slot * DESCRIPTOR_STRIDE;
      results.writeBigUInt64LE(
        BigInt(cycle === 'whole' ? descriptor : descriptor + 1),
        slot * 32 + 8
      );
      results.writeBigUInt64LE(BigInt(CHUNK), slot * 32 + 16);
      results.writeBigUInt64LE(1n, slot * 32 + 24);
    }
    return results;
  }

  const rpc = {
    a: {sdk: SDK},
    output: OUTPUT,
    async request() {
      return {verified: true};
    },
    async call(offset, [, , bytes]) {
      const base = region(regions.length);
      regions.push({base, bytes: Buffer.alloc(bytes)});
      const output = Buffer.alloc(8);
      output.writeBigUInt64LE(BigInt(base));
      return {result: 0n, output};
    },
    async callAddress(address, args) {
      const name = NAMES.get(address) ?? 'native';
      log.push({name, args});
      const result = on.call?.(name, args);
      if (result !== undefined) return {result};
      if (name === 'thread.create') {
        const thread = BigInt(0x1000 + log.length);
        regionAt(args[0]).bytes.writeBigUInt64LE(thread, args[0] - regionAt(args[0]).base);
        if (args[0] === regions[2]?.base) recycleThread = thread;
        else finiteJobs++;
      }
      if (name === 'thread.tryWait') return {result: hang && args[0] === recycleThread ? 0n : 1n};
      if (name === 'GetAudioOutSampleRate') return {result: 48000n};
      if (name === 'GetAudioOutChannelCount') return {result: 2n};
      if (name === 'GetAudioOutSampleFormat') return {result: 2n};
      return {result: 0n};
    },
    async read(address, length) {
      on.read?.(address);
      const owner = regionAt(address);
      if (regions[2] && address === frame().results) {
        log.push({name: 'read results', length});
        return cycleResults().subarray(0, length);
      }
      const bytes = Buffer.from(
        owner.bytes.subarray(address - owner.base, address - owner.base + length)
      );
      // Finite job results: receive counts for the first job, append results for the second.
      if (owner === regions[1] && address !== owner.base)
        for (let at = 0; at + 8 <= bytes.length; at += 8)
          bytes.writeBigUInt64LE(finite(finiteJobs, at / 8), at);
      return bytes;
    },
    async write(address, bytes) {
      const owner = regionAt(address);
      if (owner === regions[1]) frames.push(Buffer.from(bytes));
      if (regions[2] && address === frame().selector)
        log.push({
          name: bytes.readBigUInt64LE() === BigInt(frame().exit) ? 'select exit' : 'select live'
        });
      bytes.copy(owner.bytes, address - owner.base);
    }
  };
  const transport = {
    fd: FD,
    recvFunction: RECV,
    async send(bytes) {
      sends++;
      log.push({name: 'send', silent: !bytes.some(byte => byte), length: bytes.length});
      on.send?.(bytes, sends);
    }
  };
  return {rpc, transport, log, audio, frames};
}

/** Creates and starts socket audio on a fake console; its options go to fakeConsole. */
async function started(options = {}) {
  const fake = fakeConsole(options);
  const socket = await createWorker({rpc: fake.rpc, transport: fake.transport, timeoutMs: 1000});
  await socket.start(chunk(1), chunk(2));
  return {...fake, socket};
}

/** The log from the stop() call on, as names. */
const afterStop = (log, from) => log.slice(from).map(entry => entry.name);

test('socket audio opens with its event, primes both slots and recycles until stop', async () => {
  const {socket, log, audio} = await started();
  const base = audio();
  assert.deepEqual(named(log, 'InitializeAudioOutParameter')[0].args, [base + 0x300]);
  assert.deepEqual(named(log, 'OpenDefaultAudioOut')[0].args, [base, base + 0x100, base + 0x300]);
  assert.deepEqual(
    named(log, 'SetAudioOutBufferInfo').map(entry => entry.args),
    [
      [base + 0x400, base + 0x10000, 0x4000, CHUNK],
      [base + 0x440, base + 0x14000, 0x4000, CHUNK]
    ]
  );
  await socket.send(chunk(3));
  const health = await socket.health();
  assert.equal(health.sent, 3);
  assert.equal(health.running, true);
  const slot = descriptor => ['0', String(descriptor), String(CHUNK), '1'];
  assert.deepEqual(health.results, [...slot(base + 0x400), ...slot(base + 0x440)]);
  const from = log.length;
  await socket.stop();
  assert.deepEqual(afterStop(log, from), [
    'select exit',
    'send',
    'send',
    'thread.tryWait',
    'thread.join',
    'read results',
    'StopAudioOut',
    'FlushAudioOutBuffers',
    'CloseAudioOut'
  ]);
  assert.equal(socket.retained, false);
  await socket.stop();
});

test('stop points the worker at its exit before two silent chunks unblock it', async () => {
  const {socket, log} = await started();
  const from = log.length;
  await socket.stop();
  const tail = log.slice(from);
  assert.equal(tail[0].name, 'select exit');
  assert.deepEqual(
    tail.filter(entry => entry.name === 'send'),
    [
      {name: 'send', silent: true, length: CHUNK},
      {name: 'send', silent: true, length: CHUNK}
    ]
  );
});

test('a failed silent chunk retains the objects and leaves AudioOut open', async () => {
  const failure = Error('socket closed');
  const {socket, log} = await started({
    on: {
      send(bytes, count) {
        if (count === 3) throw failure;
      }
    }
  });
  const from = log.length;
  await assert.rejects(socket.stop(), failure);
  assert.equal(socket.retained, true);
  assert.deepEqual(afterStop(log, from), ['select exit', 'send']);
  await assert.rejects(socket.stop(), /retained for safety/);
});

test('a worker that does not stop is retained and never joined', async () => {
  const {socket, log} = await started({hang: true});
  const from = log.length;
  await assert.rejects(socket.stop(), /did not stop; restart SmileBASIC/);
  assert.equal(socket.retained, true);
  const tail = afterStop(log, from);
  assert.ok(tail.includes('thread.tryWait'));
  for (const name of ['thread.join', 'StopAudioOut', 'FlushAudioOutBuffers', 'CloseAudioOut'])
    assert.ok(!tail.includes(name), name);
  await assert.rejects(socket.stop(), /retained for safety/);
});

test('a failed join retains the objects', async () => {
  const {socket, log} = await started({
    on: {call: (name, args) => (workerJoin(name, args) ? 1n : undefined)}
  });
  const from = log.length;
  await assert.rejects(socket.stop(), /recycle worker join failed/);
  assert.equal(socket.retained, true);
  assert.ok(!afterStop(log, from).includes('CloseAudioOut'));
});

test('a worker that could not be spawned is retained without stopping AudioOut', async () => {
  const fake = fakeConsole({
    on: {call: (name, args) => (name === 'thread.create' && args[0] === region(2) ? 1n : undefined)}
  });
  const socket = await createWorker({rpc: fake.rpc, transport: fake.transport});
  await assert.rejects(socket.start(chunk(1), chunk(2)), /recycle worker creation failed/);
  assert.equal(socket.retained, true);
  const from = fake.log.length;
  await assert.rejects(socket.stop(), /retained for safety/);
  assert.deepEqual(afterStop(fake.log, from), []);
  await assert.rejects(socket.stop(), /retained for safety/);
});

test('an AudioOut that did not start is closed without stopping a worker', async () => {
  const fake = fakeConsole({
    on: {call: name => (name === 'StartAudioOut' ? 1n : undefined)}
  });
  const socket = await createWorker({rpc: fake.rpc, transport: fake.transport});
  await assert.rejects(socket.start(chunk(1), chunk(2)), /Socket AudioOut start failed/);
  const from = fake.log.length;
  await socket.stop();
  assert.deepEqual(afterStop(fake.log, from), ['FlushAudioOutBuffers', 'CloseAudioOut']);
  assert.equal(socket.retained, false);
});

test('send is refused as soon as stop is called', async () => {
  const {socket} = await started();
  const stopping = socket.stop();
  await assert.rejects(socket.send(chunk(4)), /no longer writable/);
  await stopping;
});

test('a bad recycle result is thrown only after AudioOut is closed', async () => {
  const {socket, log} = await started({cycle: 'wrong descriptor'});
  const from = log.length;
  await assert.rejects(socket.stop(), /recycle 0 returned an invalid descriptor or count/);
  assert.equal(socket.retained, false);
  assert.deepEqual(afterStop(log, from).slice(-3), [
    'StopAudioOut',
    'FlushAudioOutBuffers',
    'CloseAudioOut'
  ]);
});

test('health reports the worker stopped once it has been joined', async () => {
  let socket;
  let joined = false;
  let health;
  ({socket} = await started({
    on: {
      call(name, args) {
        if (workerJoin(name, args)) joined = true;
      },
      read() {
        if (joined && !health) {
          health = Promise.resolve();
          health = socket.health();
        }
      }
    }
  }));
  await socket.stop();
  assert.deepEqual(await health, {sent: 2, running: false, retained: false});
});

test('an AudioOut that is not 48 kHz stereo s16 is closed again', async () => {
  const fake = fakeConsole({
    on: {call: name => (name === 'GetAudioOutSampleFormat' ? 3n : undefined)}
  });
  await assert.rejects(
    createWorker({rpc: fake.rpc, transport: fake.transport}),
    /Unexpected socket AudioOut format/
  );
  assert.equal(named(fake.log, 'FlushAudioOutBuffers').length, 1);
  assert.equal(named(fake.log, 'CloseAudioOut').length, 1);
});

test('the prime receives each slot whole with MSG_WAITALL', async () => {
  const {frames, audio} = await started();
  const recv = data => ({function: RECV, args: [FD, data, CHUNK, 0x40]});
  const calls = [recv(audio() + 0x10000), recv(audio() + 0x14000)];
  const {frame} = build(region(1) + 0x10000, SDK, calls, CODE, false, new Set([RECV]));
  assert.ok(frames[0].equals(frame));
});

test('a failed prime job retains the objects and leaves AudioOut open', async () => {
  for (const failing of [1, 2]) {
    let joins = 0;
    const fake = fakeConsole({
      on: {call: (name, args) => (primeJoin(name, args) && ++joins === failing ? 1n : undefined)}
    });
    const socket = await createWorker({rpc: fake.rpc, transport: fake.transport});
    await assert.rejects(socket.start(chunk(1), chunk(2)), /Native job join failed/);
    assert.equal(socket.retained, true);
    assert.equal(primeJobs(fake.log).length, failing);
    const from = fake.log.length;
    await assert.rejects(socket.start(chunk(1), chunk(2)), /start is not available/);
    await assert.rejects(socket.stop(), /retained for safety/);
    assert.deepEqual(afterStop(fake.log, from), [], 'job ' + failing);
  }
});

test('a short prime receive appends nothing and closes AudioOut', async () => {
  const fake = fakeConsole({
    finite: (job, index) => (job === 1 ? BigInt(index === 1 ? CHUNK - 4 : CHUNK) : 1n)
  });
  const socket = await createWorker({rpc: fake.rpc, transport: fake.transport});
  await assert.rejects(socket.start(chunk(1), chunk(2)), /prime receive was short/);
  assert.equal(primeJobs(fake.log).length, 1);
  assert.equal(socket.retained, false);
  const from = fake.log.length;
  await socket.stop();
  assert.deepEqual(afterStop(fake.log, from), ['FlushAudioOutBuffers', 'CloseAudioOut']);
});

test('a rejected prime append closes AudioOut without starting it', async () => {
  const fake = fakeConsole({
    finite: (job, index) => (job === 1 ? BigInt(CHUNK) : index === 1 ? 0n : 1n)
  });
  const socket = await createWorker({rpc: fake.rpc, transport: fake.transport});
  await assert.rejects(socket.start(chunk(1), chunk(2)), /rejected prime buffer/);
  assert.equal(named(fake.log, 'StartAudioOut').length, 0);
  assert.equal(socket.retained, false);
  const from = fake.log.length;
  await socket.stop();
  assert.deepEqual(afterStop(fake.log, from), ['FlushAudioOutBuffers', 'CloseAudioOut']);
});

const inRecycleWorker = address => address >= region(2) && address < region(3);
const START_FAILURES = [
  [
    'the second chunk',
    {
      on: {
        send: (bytes, sends) => {
          if (sends === 2) throw Error('send failed');
        }
      }
    },
    /send failed/
  ],
  [
    'a short prime receive',
    {finite: (job, index) => (job === 1 ? BigInt(index === 1 ? CHUNK - 4 : CHUNK) : 1n)},
    /prime receive was short/
  ],
  [
    'a rejected prime append',
    {finite: (job, index) => (job === 1 ? BigInt(CHUNK) : index === 1 ? 0n : 1n)},
    /rejected prime buffer/
  ],
  [
    'the recycle frame readback',
    {
      on: {
        read: address => {
          if (inRecycleWorker(address)) throw Error('readback failed');
        }
      }
    },
    /readback failed/
  ],
  [
    'StartAudioOut',
    {on: {call: name => (name === 'StartAudioOut' ? 1n : undefined)}},
    /AudioOut start failed/
  ]
];

for (const [point, options, error] of START_FAILURES)
  test(`a start that failed on ${point} is not retried`, async () => {
    const fake = fakeConsole(options);
    const socket = await createWorker({rpc: fake.rpc, transport: fake.transport});
    await assert.rejects(socket.start(chunk(1), chunk(2)), error);
    assert.equal(socket.retained, false);
    const from = fake.log.length;
    await assert.rejects(socket.start(chunk(1), chunk(2)), /start is not available/);
    assert.deepEqual(afterStop(fake.log, from), []);
  });

test('start is refused once started and after stop', async () => {
  const {socket, log} = await started();
  const sends = named(log, 'send').length;
  await assert.rejects(socket.start(chunk(1), chunk(2)), /start is not available/);
  await socket.stop();
  await assert.rejects(socket.start(chunk(1), chunk(2)), /start is not available/);
  assert.equal(named(log, 'send').length, sends + 2);
  assert.equal(primeJobs(log).length, 2);
});

test('start is refused after a stop that came first', async () => {
  const fake = fakeConsole();
  const socket = await createWorker({rpc: fake.rpc, transport: fake.transport});
  await socket.stop();
  const from = fake.log.length;
  await assert.rejects(socket.start(chunk(1), chunk(2)), /start is not available/);
  assert.deepEqual(afterStop(fake.log, from), []);
});

test('a bad second chunk is refused before the first is sent', async () => {
  const fake = fakeConsole();
  const socket = await createWorker({rpc: fake.rpc, transport: fake.transport});
  await assert.rejects(socket.start(chunk(1), Buffer.alloc(CHUNK - 4)), /one complete PCM chunk/);
  assert.equal(named(fake.log, 'send').length, 0);
  await socket.start(chunk(1), chunk(2));
  assert.equal(named(fake.log, 'send').length, 2);
});
