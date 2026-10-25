const test = require('node:test');
const assert = require('node:assert/strict');
const {
  create,
  watchBridge,
  RESTART
} = require('../../../hbl-moonlight/tools/moonlight/paired-live.cjs');

const layout = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
const unit = pts => ({data: Buffer.from([pts]), pts});

function harness({receiveFails = null, acquireFails = false, stopFails = false} = {}) {
  const events = [];
  let decodeGates = 0;
  const loop = {
    retained: false,
    async start() {
      events.push('loop-start');
    },
    async beginPair(sequence) {
      events.push('begin-' + sequence);
    },
    async acquire(pts) {
      events.push('acquire-' + pts.join('/'));
      if (acquireFails) throw Error('Paired loop output 1 acquisition failed or PTS differs');
      return pts.map((value, index) => ({index, pts: value}));
    },
    async openFetch(destinations, frame) {
      assert.equal(frame, layout);
      events.push('open-fetch-' + destinations.map(item => item.index).join('/'));
    },
    async finishFirst() {
      events.push('finish-first');
      return {sequence: 1};
    },
    async finishSecond() {
      events.push('finish-second');
      return {sequence: 2};
    },
    async stop() {
      events.push('loop-stop');
      if (stopFails) {
        loop.retained = true;
        throw Error('Paired loop worker did not stop; restart SmileBASIC');
      }
    },
    async snapshot() {
      return {active: 1};
    },
    get diagnostics() {
      return {retained: loop.retained};
    }
  };
  const decoder = {
    async submitSplit(input) {
      events.push('receive-check-' + input.pts);
      if (receiveFails === input.pts)
        throw Error(`Native TCP receive returned 10/20 bytes and sequence 1/1`);
      decodeGates++;
      events.push('decode-gate-' + input.pts);
      return {sequence: decodeGates};
    },
    async close() {
      events.push('decoder-close');
    }
  };
  let surface = 0;
  const sink = {
    async workerDestination(presentation) {
      assert.equal(presentation, undefined);
      events.push('destination');
      return {index: surface++ % 3};
    },
    async close() {
      events.push('sink-close');
    }
  };
  const paired = create({
    rpc: {},
    publication: {mapped: 0x1000, color: 1},
    createInput: async options => {
      events.push('input-create-' + options.inputOnly);
      return {outputEvent: 0x2000};
    },
    createLoop: async options => {
      assert.equal(options.event, 0x2000);
      assert.deepEqual(options.publication, {mapped: 0x1000, color: 1});
      events.push('loop-create');
      return loop;
    }
  });
  return {events, paired, decoder, sink, decodeGates: () => decodeGates};
}

async function cleanup({paired, decoder, sink, events}) {
  try {
    await paired.stop();
  } catch (error) {
    events.push('retained');
    return error;
  }
  await decoder.close();
  await sink.close();
  return null;
}

async function started(h) {
  await h.paired.factory({functions: {}, decoder: 1, output: 2, format: 3});
  await h.paired.start();
}

test('a pair opens each gate only after its host check', async () => {
  const h = harness();
  await started(h);
  const presented = [];
  const result = await h.paired.pair({
    decoder: h.decoder,
    sink: h.sink,
    units: [unit(4), unit(5)],
    layout,
    onPresented: count => presented.push(count)
  });
  assert.equal(result.sequence, 1);
  await h.paired.pair({decoder: h.decoder, sink: h.sink, units: [unit(6), unit(7)], layout});
  assert.deepEqual(h.events, [
    'input-create-true',
    'loop-create',
    'loop-start',
    'begin-1',
    'receive-check-4',
    'decode-gate-4',
    'receive-check-5',
    'decode-gate-5',
    'acquire-4/5',
    'destination',
    'destination',
    'open-fetch-0/1',
    'finish-first',
    'finish-second',
    'begin-2',
    'receive-check-6',
    'decode-gate-6',
    'receive-check-7',
    'decode-gate-7',
    'acquire-6/7',
    'destination',
    'destination',
    'open-fetch-2/0',
    'finish-first',
    'finish-second'
  ]);
  assert.deepEqual(presented, [1, 1]);
});

test('a failed receive check keeps the decode gate and the fetch gate closed', async () => {
  const h = harness({receiveFails: 5});
  await started(h);
  await assert.rejects(
    h.paired.pair({decoder: h.decoder, sink: h.sink, units: [unit(4), unit(5)], layout}),
    /Native TCP receive returned/
  );
  assert.equal(h.events.includes('decode-gate-5'), false);
  assert.equal(h.decodeGates(), 1);
  assert.equal(
    h.events.some(event => event.startsWith('acquire')),
    false
  );
  assert.equal(
    h.events.some(event => event.startsWith('open-fetch')),
    false
  );
  assert.equal(await cleanup(h), null);
  assert.deepEqual(h.events.slice(-3), ['loop-stop', 'decoder-close', 'sink-close']);
});

test('a failed acquire check keeps the fetch gate closed', async () => {
  const h = harness({acquireFails: true});
  await started(h);
  await assert.rejects(
    h.paired.pair({decoder: h.decoder, sink: h.sink, units: [unit(4), unit(5)], layout}),
    /acquisition failed/
  );
  assert.equal(h.events.at(-1), 'acquire-4/5');
  assert.equal(h.events.includes('destination'), false);
  assert.equal(
    h.events.some(event => event.startsWith('open-fetch')),
    false
  );
  assert.equal(h.events.includes('finish-first'), false);
});

test('out-of-order PTS stops before the pair begins', async () => {
  const h = harness();
  await started(h);
  await assert.rejects(
    h.paired.pair({decoder: h.decoder, sink: h.sink, units: [unit(5), unit(5)], layout}),
    /increasing access-unit PTS/
  );
  assert.equal(
    h.events.some(event => event.startsWith('begin')),
    false
  );
});

test('the paired loop stops before the decoder and sink close', async () => {
  const h = harness();
  await started(h);
  await h.paired.pair({decoder: h.decoder, sink: h.sink, units: [unit(1), unit(2)], layout});
  assert.equal(await cleanup(h), null);
  assert.deepEqual(h.events.slice(-3), ['loop-stop', 'decoder-close', 'sink-close']);
  assert.equal(h.paired.exists, false);
});

test('an uncertain loop stop retains the decoder and sink', async () => {
  const h = harness({stopFails: true});
  await started(h);
  const error = await cleanup(h);
  assert.match(error.message, /restart SmileBASIC/);
  assert.deepEqual(h.events.slice(-2), ['loop-stop', 'retained']);
  assert.equal(h.paired.retained, true);
  await assert.rejects(h.paired.stop(), new RegExp(RESTART.replace(';', '.')));
  assert.equal(h.events.filter(event => event === 'loop-stop').length, 1);
});

test('a never-started loop still stops to finalize its events', async () => {
  const h = harness();
  await h.paired.factory({functions: {}, decoder: 1, output: 2, format: 3});
  await h.paired.stop();
  assert.deepEqual(h.events, ['input-create-true', 'loop-create', 'loop-stop']);
});

test('a bridge timeout marks the session lost so cleanup skips device calls', async () => {
  const rpc = watchBridge({
    a: {session: 'x'},
    host: '192.0.2.1',
    read: async () => {
      throw Error('RPC read timed out');
    },
    write: async () => {
      throw Error('Invalid write');
    }
  });
  assert.equal(rpc.host, '192.0.2.1');
  await assert.rejects(rpc.write(1, Buffer.alloc(1)), /Invalid write/);
  assert.equal(rpc.bridgeLost, false);
  await assert.rejects(rpc.read(1, 4), /timed out/);
  assert.equal(rpc.bridgeLost, true);
});
