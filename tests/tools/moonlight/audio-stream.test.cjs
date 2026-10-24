const test = require('node:test');
const assert = require('node:assert');
const {PassThrough} = require('node:stream');
const {EventEmitter} = require('node:events');
const {stream, ByteQueue} = require('./audio-stream.cjs');

// one-shot input that delivers a whole buffer in a single data event, used to
// exercise the host-ring overrun path deterministically (a PassThrough would
// chunk at its highWaterMark and let the loop drain between chunks).
function burst() {
  const e = new EventEmitter();
  e.destroy = () => e.emit('close');
  return e;
}

const symbols = require('../../homebrew-launcher/audio-symbols.json');
const SDK = 0x10000000;
const BASE = 0x100000;
const SCRATCH = 0x200000;
const BUFFER_BYTES = 3840 * 4;

function nameOf(address) {
  const offset = address - SDK;
  const matches = symbols.filter(s => s.offset === offset);
  return matches.length === 1 ? matches[0].name : null;
}

function mockRpc(options = {}) {
  const mem = Buffer.alloc(0x300000);
  const clock = {t: 0};
  const log = {writes: [], calls: []};
  const queued = []; // appended descriptors, FIFO {descriptor, releaseAt}
  const released = [];
  const liveSet = new Set();
  let retrievedCount = 0;

  function dispatch(address, args) {
    const name = nameOf(address);
    log.calls.push(name);
    if (name.includes('InitializeAudioOutParameter')) return 0n;
    if (name.includes('OpenDefaultAudioOutEPNS0_8AudioOutER')) return options.openFail ? 1n : 0n;
    if (name.includes('GetAudioOutSampleRate')) return 48000n;
    if (name.includes('GetAudioOutChannelCount')) return 2n;
    if (name.includes('GetAudioOutSampleFormat')) return 2n;
    if (name.includes('SetAudioOutBufferInfo')) return 0n;
    if (name.includes('AppendAudioOutBuffer')) {
      const descriptor = args[1];
      assert.ok(!liveSet.has(descriptor), 'descriptor appended while still queued');
      liveSet.add(descriptor);
      queued.push({descriptor, releaseAt: clock.t + (options.playMs ?? 80)});
      return 1n;
    }
    if (name.includes('StartAudioOut')) return 0n;
    if (name.includes('StopAudioOut')) return 0n;
    if (name.includes('FlushAudioOutBuffers')) {
      while (queued.length) {
        const item = queued.shift();
        liveSet.delete(item.descriptor);
        released.push(item.descriptor);
      }
      return 0n;
    }
    if (name.includes('GetReleasedAudioOutBuffer')) {
      if (!released.length) return 0n;
      retrievedCount++;
      return BigInt(released.shift());
    }
    if (name.includes('GetAudioOutBufferCount')) return BigInt(queued.length + released.length);
    if (name.includes('CloseAudioOut')) return 0n;
    throw Error('unexpected call ' + name);
  }

  const rpc = {
    a: {session: 'test-session', sdk: SDK, scratch: SCRATCH},
    async request(body) {
      if (body.command === 'verify-function') return {};
      throw Error('unexpected request ' + body.command);
    },
    async call(offset, args) {
      // the sound allocation call
      mem.writeBigUInt64LE(BigInt(BASE), args[0]);
      return {result: 0n};
    },
    async callAddress(address, args) {
      return {result: dispatch(address, args), output: Buffer.alloc(0)};
    },
    async read(address, length) {
      return Buffer.from(mem.subarray(address, address + length));
    },
    async write(address, bytes) {
      bytes.copy(mem, address);
      if (address >= BASE + 0x10000 && address < BASE + 0x10000 + 8 * 0x4000)
        log.writes.push({address, bytes: Buffer.from(bytes)});
    }
  };

  // virtual clock: advancing moves queued buffers whose playback elapsed to released
  function advance(ms) {
    clock.t += ms;
    while (queued.length && queued[0].releaseAt <= clock.t) {
      const item = queued.shift();
      liveSet.delete(item.descriptor);
      released.push(item.descriptor);
    }
  }

  return {
    rpc,
    clock,
    log,
    advance,
    queued,
    released,
    liveSet,
    get retrieved() {
      return retrievedCount;
    }
  };
}

function sine(buffers) {
  const total = buffers * BUFFER_BYTES;
  const pcm = Buffer.alloc(total);
  for (let i = 0; i < total / 2; i++) pcm.writeInt16LE(Math.round(20000 * Math.sin(i / 40)), i * 2);
  return pcm;
}

// a sleep that yields to the event loop (so stream 'data' events fire) then
// advances the mock's virtual clock.
function virtualSleep(mock) {
  return ms =>
    new Promise(resolve =>
      setImmediate(() => {
        mock.advance(ms || 1);
        resolve();
      })
    );
}

test('primes, starts, appends in order and recycles across wraparound', async () => {
  const mock = mockRpc();
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
  assert.strictEqual(stats.released, 20);
  assert.strictEqual(stats.overruns, 0);
  assert.strictEqual(mock.queued.length, 0, 'queue fully drained');
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
  await assert.rejects(session.done, /game-audio\.cjs/);
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
