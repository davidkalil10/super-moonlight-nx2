const test = require('node:test');
const assert = require('node:assert/strict');
const {CODE, IPC_COPY} = require('../../../hbl-platform/sdk/native/thread.js');
const SYNC = require('../../../hbl-platform/sdk/native/os-sync-functions.json');
const ring = require('../../../hbl-moonlight/tools/moonlight/ring.js');
const {plan} = require('../../../hbl-moonlight/tools/moonlight/paired-loop-plan.js');

const SDK = 0x40000000;
const CONTROL = 0x70000000;
const MAPPED = 0x72000000;
const FUNCTIONS = {
  acquireOutput: 0x50000000,
  bufferSetData: 0x50000004,
  getOutput: 0x50000008,
  releaseOutput: 0x5000000c
};

function fixture() {
  return plan({
    sdk: SDK,
    base: 0x60000000,
    control: CONTROL,
    event: 0x71000000,
    functions: FUNCTIONS,
    decoder: 0x52000000,
    output: 0x52000300,
    format: 0x52000180,
    publication: {mapped: MAPPED}
  });
}

test('paired loop holds two acquisitions behind the host fetch gate', () => {
  const built = fixture();
  const calls = built.calls.acquire;
  assert.deepEqual(
    calls.map(call => call.function),
    [
      SDK + SYNC.waitEvent.offset,
      FUNCTIONS.acquireOutput,
      SDK + SYNC.waitEvent.offset,
      FUNCTIONS.acquireOutput,
      SDK + IPC_COPY.offset,
      SDK + SYNC.waitLightEvent.offset,
      SDK + CODE.longjmp.offset
    ]
  );
  assert.equal(calls[5].args[0], CONTROL + built.control.fetchGate);
  for (const [logical, destination] of [
    [1, CONTROL + built.control.acquireResults],
    [3, CONTROL + built.control.acquireResults + 8]
  ]) {
    const native = built.acquire.proof.logicalResultIndices[logical];
    assert.equal(
      built.acquire.frame.readBigUInt64LE(built.acquire.proof.stackOffsets[native] + 0x118),
      BigInt(destination)
    );
  }
});

test('paired loop commits each surface after fetch and waits before the second', () => {
  const built = fixture();
  for (const [stage, slot] of [
    ['first', 0],
    ['second', 1]
  ]) {
    const calls = built.calls[stage];
    assert.deepEqual(calls.slice(0, 3).map(call => call.function), [
      FUNCTIONS.bufferSetData,
      FUNCTIONS.getOutput,
      FUNCTIONS.releaseOutput
    ]);
    assert.equal(calls[1].args[1].u32, CONTROL + built.control.acquired[slot]);
    assert.deepEqual(calls.slice(3, 5).map(call => call.args[0]), [
      MAPPED + ring.CONTROL.nativeIndex,
      MAPPED + ring.CONTROL.nativeSequence
    ]);
    assert.equal(calls[3].args[1], CONTROL + built.control.destinations[slot] + 16);
    assert.equal(calls[4].args[1], CONTROL + built.control.destinations[slot] + 44);
  }
  assert.equal(
    built.calls.first[6].function,
    SDK + SYNC.waitLightEvent.offset
  );
  assert.equal(
    built.calls.first[6].args[0],
    CONTROL + built.control.secondGate
  );
  assert.equal(built.calls.second.at(-2).args[2], built.second.frame.length);
  assert.equal(built.calls.second.at(-1).function, SDK + CODE.longjmp.offset);
});

test('paired loop has a one-output path that returns directly to its gate', () => {
  const built = fixture();
  assert.deepEqual(
    built.calls.singleAcquire.map(call => call.function),
    [
      SDK + SYNC.waitEvent.offset,
      FUNCTIONS.acquireOutput,
      SDK + IPC_COPY.offset,
      SDK + SYNC.waitLightEvent.offset,
      SDK + CODE.longjmp.offset
    ]
  );
  assert.equal(built.calls.singleFirst[1].function, FUNCTIONS.getOutput);
  assert.equal(
    built.calls.singleFirst.some(call =>
      call.function === SDK + SYNC.waitLightEvent.offset
    ),
    false
  );
  assert.equal(built.calls.singleFirst.at(-1).function, SDK + CODE.longjmp.offset);
});
