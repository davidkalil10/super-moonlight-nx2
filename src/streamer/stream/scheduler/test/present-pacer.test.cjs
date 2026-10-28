// The present pacer, driven read by read on a fake clock.
const test = require('node:test');
const assert = require('node:assert/strict');

const PERIOD = 10;

async function pacerOn(options = {}) {
  const {create} = await import('../present-pacer.js');
  const clock = {now: 0, slept: []};
  const pacer = create({
    periodMs: PERIOD,
    driftMs: 0.25,
    now: () => clock.now,
    sleep: async ms => {
      clock.slept.push(ms);
      clock.now += ms;
    },
    ...options
  });
  return {pacer, clock};
}

/** One status read starting at clock.now and costing readMs. */
function read(pacer, clock, applied, {openedAt = undefined, readMs = 1} = {}) {
  const startedAt = clock.now;
  clock.now += readMs;
  pacer.observe(startedAt, applied, openedAt);
}

/** A miss then a hit 2 ms later: a bracket that puts the phase at `at`. */
function learnPhase(pacer, clock, at) {
  clock.now = at - 2;
  read(pacer, clock, false);
  clock.now = at;
  read(pacer, clock, true);
}

/** The first vsync of the current period at or after `at`. */
function vsyncFrom(pacer, at) {
  const {phase, periodMs} = pacer;
  return phase + Math.ceil((at - phase) / periodMs) * periodMs;
}

/** A fetch opened after vsync V, missed past the refresh at V+10, applied at V+20: 'skipped'. */
function skippedGate(pacer, clock) {
  const vsync = vsyncFrom(pacer, clock.now);
  const openedAt = vsync + 1;
  clock.now = vsync + PERIOD + 3;
  read(pacer, clock, false, {openedAt});
  clock.now = vsync + 2 * PERIOD;
  read(pacer, clock, true, {openedAt});
}

/** Seen applied on the first read just after the refresh at V+10: 'odd' on the long period. */
function refreshGate(pacer, clock) {
  const vsync = vsyncFrom(pacer, clock.now);
  clock.now = vsync + PERIOD + 1;
  read(pacer, clock, true, {openedAt: vsync + 1});
}

test('a hit right after a miss brackets a vsync and sets the phase', async () => {
  const {pacer, clock} = await pacerOn();
  clock.now = 3;
  read(pacer, clock, true);
  assert.equal(pacer.phase, null, 'a first-try hit brackets nothing');

  clock.now = 8;
  read(pacer, clock, false);
  clock.now = 10;
  read(pacer, clock, true);
  assert.equal(pacer.phase, 10);
});

test('timed reads that hit on the first try pull the phase earlier by driftMs', async () => {
  const {pacer, clock} = await pacerOn();
  learnPhase(pacer, clock, 10);

  for (const phase of [9.75, 9.5]) {
    const vsync = vsyncFrom(pacer, clock.now);
    clock.now = vsync + 1;
    await pacer.beforeRead(vsync + 1);
    assert.equal(clock.now, vsync + PERIOD + 1, 'woke one marginMs after the vsync');
    read(pacer, clock, true);
    assert.equal(pacer.phase, phase);
  }

  const vsync = vsyncFrom(pacer, clock.now);
  clock.now = vsync + PERIOD + 2;
  await pacer.beforeRead(vsync + 1);
  read(pacer, clock, true);
  assert.equal(pacer.phase, 9.5, 'an untimed hit does not drift');
  assert.equal(pacer.counters.predicted, 2);
});

test('a hit far from its miss nudges the phase by at most nudgeMs', async () => {
  const {pacer, clock} = await pacerOn();
  learnPhase(pacer, clock, 10);

  for (const [missAt, hitAt, phase] of [
    [30, 43, 10.5],
    [30, 48.5, 10],
    [45, 60.25, 10.25]
  ]) {
    clock.now = missAt;
    read(pacer, clock, false);
    clock.now = hitAt;
    read(pacer, clock, true);
    assert.equal(pacer.phase, phase, `hit at ${hitAt}`);
  }
});

test('six skipped votes in the last sixteen move to twice the period', async () => {
  const {pacer, clock} = await pacerOn();
  learnPhase(pacer, clock, 10);
  for (let i = 0; i < 5; i++) skippedGate(pacer, clock);
  for (let i = 0; i < 10; i++) refreshGate(pacer, clock);
  assert.equal(pacer.periodMs, PERIOD);

  skippedGate(pacer, clock);
  assert.equal(pacer.periodMs, 2 * PERIOD);
  assert.equal(pacer.counters.grid, 2);
  assert.equal(pacer.counters.flips, 1);
  assert.equal(pacer.counters.lateVotes, 6);
});

test('a skipped vote seventeen votes back no longer counts', async () => {
  const {pacer, clock} = await pacerOn();
  learnPhase(pacer, clock, 10);
  for (let i = 0; i < 5; i++) skippedGate(pacer, clock);
  for (let i = 0; i < 11; i++) refreshGate(pacer, clock);
  skippedGate(pacer, clock);

  assert.equal(pacer.periodMs, PERIOD);
  assert.equal(pacer.counters.flips, 0);
  assert.equal(pacer.counters.lateVotes, 6);
});

test('four odd votes in a row flip back, and a skipped vote restarts the count', async () => {
  const {pacer, clock} = await pacerOn();
  learnPhase(pacer, clock, 10);
  for (let i = 0; i < 6; i++) skippedGate(pacer, clock);
  assert.equal(pacer.periodMs, 2 * PERIOD);

  for (let i = 0; i < 3; i++) refreshGate(pacer, clock);
  skippedGate(pacer, clock);
  for (let i = 0; i < 3; i++) refreshGate(pacer, clock);
  assert.equal(pacer.periodMs, 2 * PERIOD);
  assert.equal(pacer.counters.earlyVotes, 6);

  refreshGate(pacer, clock);
  assert.equal(pacer.periodMs, PERIOD);
  assert.deepEqual(
    {...pacer.counters, reads: 0, predicted: 0},
    {reads: 0, predicted: 0, probes: 0, lateVotes: 7, earlyVotes: 7, flips: 2, grid: 1}
  );
});

test('on the long period one timed read in sixteen aims at the odd refresh', async () => {
  const {pacer, clock} = await pacerOn();
  learnPhase(pacer, clock, 10);
  for (let i = 0; i < 6; i++) skippedGate(pacer, clock);

  const wakes = [];
  for (let i = 0; i < 16; i++) {
    const vsync = vsyncFrom(pacer, clock.now);
    clock.now = vsync + 1;
    await pacer.beforeRead(vsync + 1);
    wakes.push(clock.now - vsync);
  }
  assert.deepEqual(wakes, [...Array(15).fill(2 * PERIOD + 1), PERIOD + 1]);
  assert.equal(pacer.counters.probes, 1);

  for (let i = 0; i < 16; i++) {
    const vsync = vsyncFrom(pacer, clock.now);
    clock.now = vsync + PERIOD + 2;
    await pacer.beforeRead(clock.now);
    assert.equal(clock.now, vsync + 2 * PERIOD + 1);
  }
  assert.equal(pacer.counters.probes, 1, 'no probe once the odd refresh has passed');
});

test('pending polls within windowMs of a vsync and otherwise sleeps to the next one', async () => {
  const {pacer, clock} = await pacerOn();
  await pacer.pending();
  assert.deepEqual(clock.slept, [2], 'polls until a phase is known');

  learnPhase(pacer, clock, 10);
  for (const [at, ms] of [
    [11, 2],
    [14.75, 2],
    [15, 6],
    [17, 4],
    [20.5, 2]
  ]) {
    clock.now = at;
    clock.slept = [];
    await pacer.pending();
    assert.deepEqual(clock.slept, [ms], `pending at ${at}`);
  }
});

test('a windowMs shorter than marginMs plus one read sleeps a frame on a slightly early estimate', async () => {
  const seenAt = {};
  for (const windowMs of [5, 1]) {
    const {pacer, clock} = await pacerOn({windowMs});
    learnPhase(pacer, clock, 10);
    clock.now = 13;
    clock.slept = [];
    await pacer.beforeRead(13);
    for (;;) {
      const applied = clock.now >= 22;
      read(pacer, clock, applied, {readMs: 1.5});
      if (applied) break;
      await pacer.pending();
    }
    seenAt[windowMs] = {slept: clock.slept, at: clock.now - 1.5};
  }

  assert.deepEqual(seenAt[5], {slept: [8, 2], at: 24.5});
  assert.deepEqual(seenAt[1], {slept: [8, 9], at: 31.5});
});
