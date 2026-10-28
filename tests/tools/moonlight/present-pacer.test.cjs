const test = require('node:test');
const assert = require('node:assert/strict');

const PERIOD = 1000 / 120;

/**
 * Drives the pacer through gates against a console that applies on a grid of applyMs: each gate
 * opens a fetch, waits for the pacer, reads (one read costs readMs) until the apply is seen.
 */
async function gates({
  applyMs,
  count,
  readMs = 1,
  pacer,
  clock,
  grid = () => applyMs,
  lateBy = () => 0
}) {
  const reads = [];
  for (let gate = 0; gate < count; gate++) {
    const openedAt = clock.now;
    const step = grid(gate);
    const applyAt = Math.ceil((openedAt + 1e-6) / step) * step;
    await pacer.beforeRead(openedAt);
    clock.now += lateBy(gate);
    let n = 0;
    for (;;) {
      const startedAt = clock.now;
      clock.now += readMs;
      n++;
      const applied = applyAt <= startedAt;
      pacer.observe(startedAt, applied);
      if (applied) break;
      await pacer.pending();
    }
    reads.push(n);
    clock.now += 0.5;
  }
  return reads;
}

async function pacerOn(options = {}) {
  const {create} = await import('../../../host/stream/present-pacer.js');
  const clock = {now: 0.3};
  const pacer = create({
    periodMs: PERIOD,
    now: () => clock.now,
    sleep: async ms => {
      clock.now += ms;
    },
    ...options
  });
  return {pacer, clock};
}

test('a console applying every refresh keeps the refresh period and reads once per gate', async () => {
  const {pacer, clock} = await pacerOn();
  const reads = await gates({applyMs: PERIOD, count: 200, pacer, clock});
  assert.equal(pacer.periodMs, PERIOD);
  const extra = reads.slice(20).reduce((sum, n) => sum + n - 1, 0);
  assert.ok(extra <= 18, `${extra} rereads in 180 gates`);
});

test('a console applying every other refresh moves the pacer to the long period', async () => {
  const {pacer, clock} = await pacerOn();
  const learning = await gates({applyMs: 2 * PERIOD, count: 40, pacer, clock});
  assert.equal(pacer.periodMs, 2 * PERIOD);
  const settled = await gates({applyMs: 2 * PERIOD, count: 200, pacer, clock});
  const extra = settled.reduce((sum, n) => sum + n - 1, 0);
  const whileLearning = learning.reduce((sum, n) => sum + n - 1, 0);
  assert.ok(whileLearning >= 12, `${whileLearning} rereads while the short period held`);
  assert.ok(extra <= 20, `${extra} rereads on the long period`);
});

test('midpoint probes bring the short period back once the console applies every refresh', async () => {
  const {pacer, clock} = await pacerOn();
  await gates({applyMs: 2 * PERIOD, count: 60, pacer, clock});
  assert.equal(pacer.periodMs, 2 * PERIOD);
  await gates({applyMs: PERIOD, count: 1000, pacer, clock});
  assert.equal(pacer.periodMs, PERIOD);
  const reads = await gates({applyMs: PERIOD, count: 100, pacer, clock});
  const extra = reads.slice(10).reduce((sum, n) => sum + n - 1, 0);
  assert.ok(extra <= 9, `${extra} rereads back on the short period`);
});

test('a late apply now and then does not move the period', async () => {
  const {pacer, clock} = await pacerOn();
  await gates({applyMs: PERIOD, count: 40, pacer, clock});
  const jittery = gate => (gate % 5 === 0 ? 2 * PERIOD : PERIOD);
  await gates({applyMs: PERIOD, count: 200, pacer, clock, grid: jittery});
  assert.equal(pacer.periodMs, PERIOD);
});

test('a probe read that starts at the next long vsync counts for nothing', async () => {
  const {pacer, clock} = await pacerOn();
  await gates({applyMs: 2 * PERIOD, count: 60, pacer, clock});
  assert.equal(pacer.periodMs, 2 * PERIOD);
  await gates({applyMs: 2 * PERIOD, count: 1000, pacer, clock, lateBy: () => PERIOD + 2});
  assert.equal(pacer.periodMs, 2 * PERIOD, 'late reads on a 60 Hz apply grid never flip it');
});

test('a burst of six late applies flips to the long period and the probes recover it', async () => {
  const {pacer, clock} = await pacerOn();
  await gates({applyMs: PERIOD, count: 40, pacer, clock});
  const burst = gate => (gate < 6 ? 2 * PERIOD : PERIOD);
  const reads = await gates({applyMs: PERIOD, count: 600, pacer, clock, grid: burst});
  assert.equal(pacer.periodMs, PERIOD, 'back on the refresh within 600 gates');
  const extra = reads.reduce((sum, n) => sum + n - 1, 0);
  assert.ok(extra <= 40, `${extra} rereads around the burst`);
});
