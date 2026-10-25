const test = require('node:test');
const assert = require('node:assert/strict');
const {BASELINE, MODEL, simulate, budget} = require('./request-budget.cjs');

// Modeled steady-state requests per presented frame at 1080p30. Bump these down
// (never up) when a scheduler change lowers them, and record before/after in the
// commit message.
const BUDGET = {
  persistent: 10.05,
  split: 11.05,
  splitPublish: 8,
  splitPublishAuto: 7,
  splitLinked: 4,
  paired: 11.25,
  staggered: 2.05
};
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

test('linked gates share both status reads and stay within four requests per frame', async () => {
  const result = await simulate({
    mode: 'split',
    frames: 120,
    nativePublish: true,
    autoQueue: true,
    linkedGates: true
  });
  assert.equal(result.frames, 120);
  assert.ok(result.requestsPerFrame <= BUDGET.splitLinked);
  assert.equal(result.byStage['split-input'].requests, 2);
  assert.equal(result.byStage['split-output'].requests, 2);
  assert.equal(result.byStage['split-queue'], undefined);
});

test('linked status reads remain shared at a modeled 60 fps source', async () => {
  const result = await simulate({
    mode: 'split',
    frames: 120,
    nativePublish: true,
    autoQueue: true,
    linkedGates: true,
    model: {...MODEL, sourceFps: 60}
  });
  assert.ok(result.requestsPerFrame <= BUDGET.splitLinked);
  assert.equal(result.frames, 120);
});

for (const sourceFps of [30, 60, 120]) {
  test(`paired loop keeps its host gates within budget at a ${sourceFps} fps source`, async () => {
    const model = {...MODEL, sourceFps};
    const result = await simulate({mode: 'paired', frames: 120, model});
    assert.equal(result.frames, 120);
    assert.equal(result.paired, true);
    assert.ok(
      result.requestsPerFrame <= BUDGET.paired,
      `${result.requestsPerFrame} requests/frame exceeds the ${BUDGET.paired} budget`
    );
    assert.deepEqual(Object.keys(result.byStage).sort(), [
      'destination',
      'paired-acquire',
      'paired-begin',
      'paired-fetch',
      'paired-input'
    ]);
    assert.equal(result.byStage['paired-begin'].requests, 1);
    assert.equal(result.byStage['paired-input'].requests, 4);
    const stages = Object.values(result.byStage).reduce((sum, row) => sum + row.requests, 0);
    assert.ok(Math.abs(stages - result.requestsPerFrame) < 0.05, 'stages sum to the total');
    if (sourceFps === 30) assert.ok(result.fps >= 29.5, `paired loop holds ${result.fps} fps`);
  });
}

test('paired loop rejects the split worker publication flags', async () => {
  await assert.rejects(
    simulate({mode: 'paired', nativePublish: true}),
    /publishes from its own worker/
  );
});

test('staggered layout costs two requests per frame plus the audio read', async () => {
  const result = await simulate({mode: 'staggered', frames: 120});
  assert.equal(result.frames, 120);
  assert.ok(result.requestsPerFrame >= 2);
  assert.ok(result.requestsPerFrame <= BUDGET.staggered);
  assert.ok(result.fps >= 29.5, `staggered loop holds ${result.fps} fps`);
});

test('staggered rereads add one request per late frame', async () => {
  const base = await simulate({mode: 'staggered', frames: 120});
  for (const retryRate of [0.1, 0.3]) {
    const result = await simulate({mode: 'staggered', frames: 120, retryRate});
    assert.ok(
      Math.abs(result.requestsPerFrame - base.requestsPerFrame - retryRate) < 0.02,
      `${retryRate} retry rate gave ${result.requestsPerFrame} requests/frame`
    );
  }
});

test('staggered 120 fps needs a 120 Hz present', async () => {
  const model = {...MODEL, sourceFps: 120};
  const slow = await simulate({mode: 'staggered', frames: 240, presentHz: 60, model});
  const fast = await simulate({mode: 'staggered', frames: 240, presentHz: 120, model});
  assert.ok(slow.fps < 61, `60 Hz present gave ${slow.fps} fps`);
  assert.ok(fast.fps > slow.fps * 1.2, `120 Hz present gave ${fast.fps} fps`);
  assert.ok(fast.fps < 120, 'one decode in flight caps the loop below 120 fps');
});

test('staggered lag 2 keeps two decodes in flight', async () => {
  const model = {...MODEL, sourceFps: 120};
  const one = await simulate({mode: 'staggered', frames: 240, presentHz: 120, model});
  const two = await simulate({mode: 'staggered', frames: 240, presentHz: 120, lag: 2, model});
  assert.equal(two.lag, 2);
  assert.ok(two.requestsPerFrame <= BUDGET.staggered);
  assert.ok(two.fps > one.fps * 1.4, `lag 2 gave ${two.fps} fps against ${one.fps}`);
  assert.ok(two.fps >= 110, `lag 2 at 120 Hz present gave ${two.fps} fps`);
});

test('budget reports the staggered matrix', async () => {
  const {staggered} = await budget({frames: 60});
  assert.equal(Object.keys(staggered).length, 12);
  assert.equal(staggered['60fps-60Hz-retry0'].requestsPerFrame <= BUDGET.staggered, true);
});

test('budget reports lag 2 at both decode times', async () => {
  const {staggeredLag2} = await budget({frames: 60});
  assert.equal(Object.keys(staggeredLag2).length, 6);
});

test('staggered acquire barrier keeps the host requests and 120 Hz lag 2 rate', async () => {
  for (const decodeMs of [MODEL.decodeMs, 6.85]) {
    const options = {mode: 'staggered', frames: 240, presentHz: 120, lag: 2, paced: false};
    const model = {...MODEL, decodeMs, sourceFps: 120};
    const open = await simulate({...options, model});
    const barrier = await simulate({...options, barrier: true, model});
    assert.equal(barrier.barrier, true);
    assert.equal(barrier.requestsPerFrame, open.requestsPerFrame);
    assert.ok(barrier.fps <= open.fps, `barrier ${barrier.fps} fps against ${open.fps}`);
    assert.ok(barrier.fps >= 110, `barrier at ${decodeMs} ms decode gave ${barrier.fps} fps`);
  }
});

test('budget reports the barrier matrix', async () => {
  const {staggeredBarrier} = await budget({frames: 60});
  assert.equal(Object.keys(staggeredBarrier).length, 24);
  for (const [name, entry] of Object.entries(staggeredBarrier))
    if (name.endsWith('retry0')) assert.ok(entry.requestsPerFrame <= BUDGET.staggered, name);
});
