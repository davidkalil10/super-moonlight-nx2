// Host audio: the socket plan, the AudioOut stream and the socket audio source.
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
const {mockRpc} = require('../../../../hbl-platform-dev/sdk/tests/audio-out-mock.cjs');
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
