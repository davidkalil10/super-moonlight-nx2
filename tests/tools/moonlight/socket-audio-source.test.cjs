const test = require('node:test');
const assert = require('node:assert/strict');
const {PassThrough} = require('node:stream');
const {create} = require('./socket-audio-source.cjs');

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
