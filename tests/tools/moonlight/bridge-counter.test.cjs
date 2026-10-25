const test = require('node:test');
const assert = require('node:assert/strict');
const {
  instrument,
  requestsFor
} = require('../../../hbl-moonlight/tools/moonlight/bridge-counter.cjs');

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
