const test = require('node:test');
const assert = require('node:assert/strict');
const {BASELINE, MODEL, simulate} = require('./request-budget.cjs');

// Modeled steady-state requests per presented frame at 1080p30. Bump these down
// (never up) when a scheduler change lowers them, and record before/after in the
// commit message.
const BUDGET = {persistent: 10.05, split: 11.05, splitPublish: 8, splitPublishAuto: 7};
const REQUEST_TOLERANCE = 1;
const BRIDGE_MS_TOLERANCE = 3;

for (const mode of ['persistent', 'split']) {
  test(`${mode} loop stays within its request budget`, async () => {
    const result = await simulate({mode, frames: 120});
    assert.equal(result.frames, 120);
    assert.ok(
      result.requestsPerFrame <= BUDGET[mode],
      `${result.requestsPerFrame} requests/frame exceeds the ${BUDGET[mode]} budget`
    );
    const stages = Object.values(result.byStage).reduce((sum, row) => sum + row.requests, 0);
    assert.ok(Math.abs(stages - result.requestsPerFrame) < 0.05, 'stages sum to the total');
  });

  test(`${mode} model lands near the step 3a device baseline`, async () => {
    const paced = await simulate({mode, frames: 120});
    const free = await simulate({mode, frames: 120, paced: false});
    const baseline = BASELINE[mode];
    assert.ok(
      Math.abs(paced.requestsPerFrame - baseline.requests) <= REQUEST_TOLERANCE,
      `${paced.requestsPerFrame} requests/frame vs ${baseline.requests} on device`
    );
    assert.ok(
      Math.abs(paced.bridgeMsPerFrame - baseline.bridgeMs) <= BRIDGE_MS_TOLERANCE,
      `${paced.bridgeMsPerFrame} bridge-ms/frame vs ${baseline.bridgeMs} on device`
    );
    for (const [stage, requests] of Object.entries(baseline.byStage))
      assert.ok(
        Math.abs(paced.byStage[stage].requests - requests) <= REQUEST_TOLERANCE,
        `${stage}: ${paced.byStage[stage].requests} vs ${requests} on device`
      );
    assert.ok(Math.abs(paced.fps - 30) < 0.5, 'paced run follows the 30 fps source');
    assert.ok(free.fps >= 30, `predicted ${free.fps} fps cannot hold 1080p30`);
  });
}

test('the modeled clock restores real timers and runs without real sleeps', async () => {
  const {setTimeout: timeout, clearTimeout: clear} = globalThis;
  const now = Date.now;
  const started = performance.now();
  const result = await simulate({mode: 'persistent', frames: 60, model: {...MODEL, decodeMs: 13}});
  assert.equal(result.frames, 60);
  assert.ok(result.byStage.persistent.requests > 8, 'failed polls sleep between retries');
  assert.ok(performance.now() - started < 300);
  assert.equal(globalThis.setTimeout, timeout);
  assert.equal(globalThis.clearTimeout, clear);
  assert.equal(Date.now, now);
});

test('native worker publication removes destination and host publish requests', async () => {
  const result = await simulate({mode: 'split', frames: 120, nativePublish: true});
  assert.equal(result.frames, 120);
  assert.ok(result.requestsPerFrame <= BUDGET.splitPublish);
  assert.equal(result.byStage['split-input'].requests, 4);
  assert.equal(result.byStage['split-output'].requests, 3);
  assert.equal(result.byStage['split-queue'].requests, 1);
  assert.equal(result.byStage.destination, undefined);
  assert.equal(result.byStage.publish, undefined);
});

test('automatic output queue removes one host request per split frame', async () => {
  const result = await simulate({mode: 'split', frames: 120, nativePublish: true, autoQueue: true});
  assert.equal(result.frames, 120);
  assert.ok(result.requestsPerFrame <= BUDGET.splitPublishAuto);
  assert.equal(result.byStage['split-queue'], undefined);
  assert.equal(result.byStage['split-input'].requests, 4);
  assert.equal(result.byStage['split-output'].requests, 3);
});
