const test = require('node:test');
const assert = require('node:assert/strict');
const {MODEL, GATE_WAITER, simulate, budget} = require('./request-budget.cjs');

// Modeled steady-state requests per presented frame at 1080p30. Bump these down
// (never up) when a scheduler change lowers them, and record before/after in the
// commit message.
const BUDGET = {staggered: 2.05};

test('the modeled clock restores real timers and runs without real sleeps', async () => {
  const {setTimeout: timeout, clearTimeout: clear} = globalThis;
  const now = Date.now;
  const started = performance.now();
  const result = await simulate({frames: 60, presentHz: 60});
  assert.equal(result.frames, 60);
  assert.ok(result.msPerFrame > 10, 'the modeled vsync paces the frames');
  assert.ok(performance.now() - started < 300);
  assert.equal(globalThis.setTimeout, timeout);
  assert.equal(globalThis.clearTimeout, clear);
  assert.equal(Date.now, now);
});

test('staggered layout costs two requests per frame plus the audio read', async () => {
  const result = await simulate({frames: 120});
  assert.equal(result.frames, 120);
  assert.ok(result.requestsPerFrame >= 2);
  assert.ok(result.requestsPerFrame <= BUDGET.staggered);
  assert.ok(result.fps >= 29.5, `staggered loop holds ${result.fps} fps`);
});

test('staggered rereads add one request per late frame', async () => {
  const base = await simulate({frames: 120});
  for (const retryRate of [0.1, 0.3]) {
    const result = await simulate({frames: 120, retryRate});
    assert.ok(
      Math.abs(result.requestsPerFrame - base.requestsPerFrame - retryRate) < 0.02,
      `${retryRate} retry rate gave ${result.requestsPerFrame} requests/frame`
    );
  }
});

test('staggered 120 fps needs a 120 Hz present', async () => {
  const model = {...MODEL, sourceFps: 120};
  const slow = await simulate({frames: 240, presentHz: 60, model});
  const fast = await simulate({frames: 240, presentHz: 120, model});
  assert.ok(slow.fps < 61, `60 Hz present gave ${slow.fps} fps`);
  assert.ok(fast.fps > slow.fps * 1.2, `120 Hz present gave ${fast.fps} fps`);
  assert.ok(fast.fps < 120, 'one decode in flight caps the loop below 120 fps');
});

test('staggered lag 2 keeps two decodes in flight', async () => {
  const model = {...MODEL, sourceFps: 120};
  const one = await simulate({frames: 240, presentHz: 120, model});
  const two = await simulate({frames: 240, presentHz: 120, lag: 2, model});
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
    const options = {frames: 240, presentHz: 120, lag: 2, paced: false};
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

test('the present pacer reads the status about once per frame at 60 Hz', async () => {
  const {staggeredHostWait} = await budget({frames: 600});
  assert.ok(staggeredHostWait['60Hz-unpaced-poll'].rereadsPerFrame >= 5);
  for (const pacing of ['paced', 'unpaced']) {
    const entry = staggeredHostWait[`60Hz-${pacing}-pacer`];
    assert.ok(entry.requestsPerFrame <= 2.3, `${pacing}: ${entry.requestsPerFrame}`);
    assert.ok(entry.fps >= 59.9, `${pacing}: ${entry.fps} fps`);
  }
});

test('host waits reject unknown policies and include input-slot retry RPCs', async () => {
  const options = {frames: 240, presentHz: 60, lag: 2, barrier: true};
  await assert.rejects(simulate({...options, hostWait: 'sleep'}), /host wait/);
  for (const hostWait of ['pacer', 'waiter']) {
    const base = await simulate({...options, hostWait});
    const retry = await simulate({...options, hostWait, retryRate: 0.3});
    assert.ok(retry.requestsPerFrame >= base.requestsPerFrame + 0.5, hostWait);
    assert.ok(Math.abs(retry.inputSlotRetryRpcsPerFrame - 0.3) < 0.02, hostWait);
  }
});

test('120 Hz gate waiter keeps the host status check and short bridge wait in budget', async () => {
  assert.equal(GATE_WAITER.progressPollMs, 0.5);
  assert.equal(GATE_WAITER.bridgeWaitMs, 1);
  for (const decodeMs of [6.85, 8.5]) {
    const result = await simulate({
      frames: 240,
      presentHz: 120,
      lag: 2,
      barrier: true,
      paced: false,
      hostWait: 'waiter',
      model: {...MODEL, decodeMs, sourceFps: 120}
    });
    assert.equal(result.frames, 240);
    assert.ok(result.requestsPerFrame >= 2 && result.requestsPerFrame < 2.5);
    assert.ok(result.waiterBridgeMsPerFrame > 0 && result.waiterBridgeMsPerFrame <= 1);
    assert.ok(result.bridgeMsPerFrame < 1000 / 120);
    assert.ok(result.bridgeMsPerFrame > result.requestsPerFrame * MODEL.requestMs);
  }
});

test('120 Hz matrix compares current host reread and console waiter at each retry rate', async () => {
  const {staggered120HzGateWaiter: matrix} = await budget({frames: 240});
  assert.equal(Object.keys(matrix).length, 6);
  for (const decodeMs of [6.85, 8.5]) {
    for (const retry of [0, 10, 30]) {
      const {current, waiter} = matrix[`decode${decodeMs}-retry${retry}`];
      assert.ok(current.requestsPerFrame >= 2);
      assert.ok(waiter.requestsPerFrame >= 2);
      assert.ok(waiter.bridgeMsPerFrame < 1000 / 120);
      assert.ok(waiter.waiterBridgeMsPerFrame > 0);
      if (retry === 0) {
        assert.ok(current.fps >= 110, `${decodeMs} ms: ${current.fps} fps`);
        assert.ok(waiter.fps < current.fps);
      } else {
        assert.ok(current.fps < 110, `${decodeMs} ms, ${retry}%: ${current.fps} fps`);
        assert.ok(waiter.fps < 110, `${decodeMs} ms, ${retry}%: ${waiter.fps} fps`);
      }
    }
  }
});

test('console gate waiter retains the 60 Hz baseline', async () => {
  const {staggeredHostWait} = await budget({frames: 240});
  for (const pacing of ['paced', 'unpaced']) {
    const entry = staggeredHostWait[`60Hz-${pacing}-waiter`];
    assert.ok(entry.fps >= 59.9, `${pacing}: ${entry.fps} fps`);
    assert.ok(entry.bridgeMsPerFrame < 1000 / 60);
  }
});

test('staggered late rereads cost less without the host pause', async () => {
  const model = {...MODEL, sourceFps: 120};
  const options = {frames: 240, presentHz: 120, lag: 2, barrier: true};
  for (const retryRate of [0.1, 0.3]) {
    const paused = await simulate({...options, retryRate, retryWaitMs: 5, model, paced: false});
    const immediate = await simulate({...options, retryRate, retryWaitMs: 0, model, paced: false});
    assert.equal(paused.retryWaitMs, 5);
    assert.equal(immediate.requestsPerFrame, paused.requestsPerFrame);
    assert.ok(immediate.fps > paused.fps, `${immediate.fps} against ${paused.fps} fps`);
  }
});

test('skipping older presents lets a staggered backlog decode past the present rate', async () => {
  const run = (paced, skipBacklog) =>
    simulate({
      frames: 240,
      presentHz: 60,
      lag: 2,
      barrier: true,
      paced,
      skipBacklog,
      model: {...MODEL, sourceFps: 60}
    });
  const capped = await run(false, null);
  const skipping = await run(false, 2);
  assert.equal(capped.decodedFps, 60);
  assert.ok(skipping.decodedFps >= 95, `decoded ${skipping.decodedFps}/s`);
  assert.ok(skipping.skipped > 0);
  const steady = await run(true, 2);
  assert.equal(steady.skipped, 0);
  assert.equal(steady.requestsPerFrame, (await run(true, null)).requestsPerFrame);
});

test('a skipped present does not wait on the vsync pacer', async () => {
  const result = await simulate({
    frames: 240,
    presentHz: 60,
    lag: 2,
    barrier: true,
    paced: false,
    hostWait: 'pacer',
    skipBacklog: 2,
    model: {...MODEL, sourceFps: 60}
  });
  assert.ok(result.decodedFps >= 95, `decoded ${result.decodedFps}/s`);
  assert.ok(result.requestsPerFrame < 4, `${result.requestsPerFrame} requests/frame`);
});

test('the vsync skip rule presents at the vsync rate while decode keeps up', async () => {
  const run = (presentHz, decodeMs, skipRule) =>
    simulate({
      frames: 600,
      presentHz,
      lag: 2,
      barrier: true,
      hostWait: 'pacer',
      skipBacklog: skipRule === 'vsync' ? 1 : 2,
      skipRule,
      model: {...MODEL, sourceFps: 120, decodeMs}
    });
  const collapsed = await run(60, 6.85, 'backlog');
  const tracking = await run(60, 6.85, 'vsync');
  assert.ok(collapsed.fps < 30, `T23 rule ${collapsed.fps} fps`);
  assert.ok(tracking.fps >= 59.5, `vsync rule ${tracking.fps} fps`);
  assert.ok(tracking.decodedFps >= 118, `decoded ${tracking.decodedFps}/s`);
  assert.ok(tracking.requestsPerFrame <= 2.6, `${tracking.requestsPerFrame} requests/frame`);
  const full = await run(120, 6.85, 'vsync');
  assert.equal(full.fps, 120);
  assert.equal(full.skipped, 0);
  assert.ok(full.requestsPerFrame <= 2.05, `${full.requestsPerFrame} requests/frame`);
  const slow = await run(120, 8.5, 'vsync');
  assert.ok(slow.fps > 2 * (await run(120, 8.5, 'backlog')).fps, `vsync rule ${slow.fps} fps`);
});

test('the vsync skip rule needs a host wait and a threshold', async () => {
  const options = {frames: 10, presentHz: 60, lag: 2, barrier: true};
  await assert.rejects(
    simulate({...options, skipRule: 'vsync', skipBacklog: 1}),
    /vsync skip rule/
  );
  await assert.rejects(
    simulate({...options, skipRule: 'vsync', hostWait: 'pacer'}),
    /vsync skip rule/
  );
  await assert.rejects(
    simulate({...options, skipRule: 'vsync', hostWait: 'waiter', skipBacklog: 1}),
    /vsync skip rule/
  );
  await assert.rejects(simulate({...options, skipRule: 'newest'}), /Unknown staggered skip rule/);
});

test('the vsync rule learns a console applying every other refresh', async () => {
  const run = (presentHz, appliedHz) =>
    simulate({
      frames: 600,
      presentHz,
      appliedHz,
      lag: 2,
      barrier: true,
      hostWait: 'pacer',
      skipBacklog: 1,
      skipRule: 'vsync',
      decodeWait: true,
      model: {...MODEL, sourceFps: 120, decodeMs: 6.85}
    });
  const every = await run(120, 120);
  const sixty = await run(60, 60);
  const other = await run(120, 60);
  assert.equal(every.appliedPeriodMs, 1000 / 120);
  assert.equal(sixty.appliedPeriodMs, 1000 / 60);
  assert.equal(other.appliedPeriodMs, 1000 / 60);
  assert.equal(every.fps, 120);
  assert.ok(other.fps >= sixty.fps - 1, `${other.fps} fps against ${sixty.fps} on a 60 Hz grid`);
  assert.ok(
    other.rereadsPerFrame <= sixty.rereadsPerFrame + 0.1,
    `${other.rereadsPerFrame} rereads/frame against ${sixty.rereadsPerFrame}`
  );
  assert.ok(
    other.requestsPerFrame <= sixty.requestsPerFrame + 0.1,
    `${other.requestsPerFrame} requests/frame against ${sixty.requestsPerFrame}`
  );
});

test('the pacer learns the apply grid from a host whose backlog keeps the ack optional', async () => {
  const run = (appliedHz, paced) =>
    simulate({
      frames: 600,
      presentHz: 120,
      appliedHz,
      paced,
      lag: 2,
      barrier: true,
      hostWait: 'pacer',
      skipBacklog: 1,
      skipRule: 'vsync',
      decodeWait: true,
      model: {...MODEL, sourceFps: 120, decodeMs: 6.85}
    });
  const backlog = await run(60, false);
  assert.equal(backlog.appliedPeriodMs, 1000 / 60, 'learned with the acks optional');
  assert.ok(backlog.pacer.predicted < 10, `${backlog.pacer.predicted} timed reads with a backlog`);
  assert.ok(backlog.pacer.lateVotes >= 50, `${backlog.pacer.lateVotes} skipped-refresh votes`);
  assert.equal(backlog.pacer.flips, 1);
  const every = await run(120, false);
  assert.equal(every.appliedPeriodMs, 1000 / 120);
  assert.equal(every.pacer.flips, 0);
  assert.ok(
    every.pacer.lateVotes <= 5,
    `${every.pacer.lateVotes} skipped-refresh votes on a 120 grid`
  );
});

test('budget: the decode wait sleeps through a pending acquire instead of rereading', async () => {
  const run = (presentHz, decodeMs, decodeWait, retryRate = 0) =>
    simulate({
      frames: 600,
      presentHz,
      lag: 2,
      barrier: true,
      hostWait: 'pacer',
      skipBacklog: 1,
      skipRule: 'vsync',
      retryRate,
      decodeWait,
      model: {...MODEL, sourceFps: 120, decodeMs}
    });
  for (const presentHz of [60, 120]) {
    const reread = await run(presentHz, 8.5, false);
    const waited = await run(presentHz, 8.5, true);
    assert.ok(reread.requestsPerFrame > 3.5, `${reread.requestsPerFrame} requests/frame`);
    assert.ok(waited.requestsPerFrame <= 2.3, `${waited.requestsPerFrame} requests/frame`);
    assert.ok(waited.fps >= reread.fps * 0.97, `${presentHz} Hz ${waited.fps}/${reread.fps} fps`);
  }
  const reread = await run(120, 6.85, false);
  const waited = await run(120, 6.85, true);
  for (const key of ['requestsPerFrame', 'rereadsPerFrame', 'fps', 'skipped'])
    assert.equal(waited[key], reread[key], key);
  for (const retryRate of [0.1, 0.3]) {
    const reread = await run(120, 6.85, false, retryRate);
    const waited = await run(120, 6.85, true, retryRate);
    assert.ok(waited.requestsPerFrame <= reread.requestsPerFrame, `retry ${retryRate}`);
    assert.ok(waited.fps >= reread.fps, `retry ${retryRate}: ${waited.fps}/${reread.fps} fps`);
  }
});

test('budget: the receive wait sleeps through a slow receive instead of rereading', async () => {
  const run = (receiveWait, receiveMs) =>
    simulate({
      frames: 600,
      presentHz: 120,
      lag: 2,
      barrier: true,
      hostWait: 'pacer',
      skipBacklog: 1,
      skipRule: 'vsync',
      receiveWait,
      model: {...MODEL, sourceFps: 120, decodeMs: 6.85, receiveMs}
    });
  const reread = await run(false, 7);
  const waited = await run(true, 7);
  assert.ok(reread.rereadsPerFrame > 0.5, `${reread.rereadsPerFrame} rereads/frame`);
  assert.ok(
    waited.rereadsPerFrame < reread.rereadsPerFrame / 4,
    `${waited.rereadsPerFrame} rereads/frame with the wait`
  );
  assert.ok(waited.fps >= reread.fps * 0.97, `${waited.fps}/${reread.fps} fps`);
  const quick = await run(false, 2);
  const quickWaited = await run(true, 2);
  for (const key of ['requestsPerFrame', 'rereadsPerFrame', 'fps', 'skipped'])
    assert.equal(quickWaited[key], quick[key], key);
});

test('budget: the decode wait needs the vsync skip rule', async () => {
  const options = {frames: 10, presentHz: 60, lag: 2, barrier: true};
  await assert.rejects(
    simulate({...options, hostWait: 'pacer', skipBacklog: 2, decodeWait: true}),
    /decode wait needs the vsync skip rule/
  );
});

test('budget reports the decode wait matrix', async () => {
  const {staggeredDecodeWait} = await budget({frames: 60});
  assert.equal(Object.keys(staggeredDecodeWait).length, 12);
});
