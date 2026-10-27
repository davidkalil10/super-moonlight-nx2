const test = require('node:test');
const assert = require('node:assert/strict');
const {
  instrument,
  requestsFor,
  watchBridge
} = require('../../../hbl-moonlight/tools/moonlight/bridge-counter.js');

test('bridge counter attributes requests and elapsed time to the active stage', async () => {
  let clock = 0;
  let stage = 'split-input';
  const rpc = {
    a: {session: 'test'},
    async callAddress() {
      clock += 3;
      return {result: 0n};
    },
    async read() {
      clock += 5;
      return Buffer.alloc(0x80001);
    },
    async write() {
      clock += 2;
    }
  };
  const counter = instrument(
    rpc,
    () => stage,
    () => clock
  );
  assert.equal(counter.rpc.a, rpc.a);
  await counter.rpc.callAddress(12, []);
  stage = 'publish';
  await counter.rpc.read(24, 0x80001);
  await counter.rpc.write(32, Buffer.alloc(4));
  assert.deepEqual(counter.take(), {
    exchanges: 4,
    bridgeMs: 10,
    bridgeByStage: {
      'split-input': {exchanges: 1, bridgeMs: 3},
      publish: {exchanges: 3, bridgeMs: 7}
    }
  });
  assert.deepEqual(counter.take(), {exchanges: 0, bridgeMs: 0, bridgeByStage: {}});
});

test('failed requests still count and an invalid transfer does not mask its error', async () => {
  let clock = 0;
  const counter = instrument(
    {
      async read() {
        clock += 2;
        throw Error('Bridge disconnected');
      }
    },
    () => 'receive',
    () => clock
  );
  await assert.rejects(counter.rpc.read(0, 16), /Bridge disconnected/);
  await assert.rejects(counter.rpc.read(0, null), /Bridge disconnected/);
  assert.deepEqual(counter.take(), {
    exchanges: 1,
    bridgeMs: 4,
    bridgeByStage: {receive: {exchanges: 1, bridgeMs: 4}}
  });
  assert.equal(requestsFor('write', [0, Buffer.alloc(0x100001)]), 3);
});

test('silentMs is how long the console has left a call unanswered', async () => {
  let clock = 50;
  const answers = [];
  const counter = instrument(
    {request: () => new Promise(resolve => answers.push(resolve))},
    () => 'unit',
    () => clock
  );
  assert.equal(counter.silentMs(), 0, 'nothing pending is not silence');
  const first = counter.rpc.request();
  clock = 1250;
  const second = counter.rpc.request();
  clock = 6050;
  assert.equal(counter.silentMs(), 6000);
  clock = 6100;
  answers[0]();
  await first;
  clock = 6600;
  assert.equal(counter.silentMs(), 500, 'any answer restarts the count');
  answers[1]();
  await second;
  assert.equal(counter.silentMs(), 0);
  clock = 9000;
  const third = counter.rpc.request();
  clock = 9200;
  assert.equal(counter.silentMs(), 200, 'an idle bridge is not counted');
  answers[2]();
  await third;
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
