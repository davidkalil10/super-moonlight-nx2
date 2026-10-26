const test = require('node:test');
const assert = require('node:assert/strict');

const KB = 1024;

async function predictor(options = {}) {
  const {create} = await import('../../../hbl-moonlight/tools/moonlight/receive-wait.js');
  const clock = {now: 0};
  const sleeps = [];
  const wait = create({
    now: () => clock.now,
    sleep: async ms => {
      sleeps.push(ms);
      clock.now += ms;
    },
    ...options
  });
  return {wait, clock, sleeps};
}

test('a gate whose receive keeps up reads at once', async () => {
  const {wait, sleeps} = await predictor();
  wait.sent(1, 24 * KB, 0);
  assert.equal(await wait.beforeRead(1, false, 2), false);
  wait.observe(1, 1, true);
  wait.sent(2, 24 * KB, 1);
  assert.equal(await wait.beforeRead(2, false, 2), false);
  assert.deepEqual(sleeps, []);
  assert.equal(await wait.beforeRead(9, true, 2), false, 'an unknown unit never waits');
});

test('a pending receive sleeps to its prediction less the read time', async () => {
  const {wait, clock, sleeps} = await predictor({baseMs: 1, startPerKbMs: 0.25});
  wait.sent(1, 24 * KB, 0);
  clock.now = 2;
  assert.equal(await wait.beforeRead(1, true, 2), true);
  assert.deepEqual(sleeps, [1 + 24 * 0.25 - 2 - 2]);
  assert.equal(clock.now, 1 + 24 * 0.25 - 2);
  clock.now = 20;
  assert.equal(await wait.beforeRead(1, true, 2), false, 'a prediction already past never waits');
});

test('the estimate grows on a late receive and shrinks on an early one', async () => {
  const {wait, clock} = await predictor({baseMs: 1, startPerKbMs: 0.2, growMs: 0.5, shrinkMs: 0.1});
  wait.sent(1, 10 * KB, 0);
  clock.now = 3;
  wait.observe(1, 3, false, {pendingSeen: false});
  assert.equal(wait.perKbMs, 0.2 + 0.5 / 10, 'a pending read past the prediction grows it');
  wait.observe(1, 4, false, {pendingSeen: true});
  assert.equal(wait.perKbMs, 0.2 + 0.5 / 10, 'a stalled unit grows it once, not per reread');
  clock.now = 1;
  wait.sent(2, 10 * KB, 1);
  wait.observe(2, 1.5, false, {pendingSeen: false});
  assert.equal(wait.perKbMs, 0.25, 'a pending read before the prediction changes nothing');
  wait.observe(2, 4, true, {waited: true, pendingSeen: true});
  assert.equal(wait.perKbMs, 0.25 - 0.1 / 10, 'a waited read that found it received shrinks it');
  wait.observe(2, 4, true, {waited: false, pendingSeen: false});
  assert.equal(wait.perKbMs, 0.25 - 0.1 / 10, 'a read that did not wait leaves it');
});

test('the link binds after a pending gate and the next first read waits', async () => {
  const {wait, clock, sleeps} = await predictor({baseMs: 1, startPerKbMs: 0.5});
  wait.sent(1, 8 * KB, 0);
  assert.equal(await wait.beforeRead(1, false, 1), false, 'unbound: the first read goes out');
  wait.observe(1, 1, false, {pendingSeen: false});
  wait.observe(1, 6, true, {waited: false, pendingSeen: true});
  wait.sent(2, 8 * KB, 6);
  clock.now = 6;
  assert.equal(await wait.beforeRead(2, false, 1), true, 'bound: the first read waits');
  assert.deepEqual(sleeps, [6 + 1 + 8 * 0.5 - 1 - 6]);
  wait.observe(2, clock.now + 1, true, {waited: true, pendingSeen: false});
  wait.sent(3, 8 * KB, clock.now);
  assert.equal(await wait.beforeRead(3, false, 1), true, 'a waited gate keeps the link bound');
  wait.observe(3, clock.now + 1, true, {waited: false, pendingSeen: false});
  wait.sent(4, 8 * KB, clock.now);
  assert.equal(await wait.beforeRead(4, false, 1), false, 'a gate that read at once unbinds it');
});

test('sends older than four units are forgotten', async () => {
  const {wait} = await predictor();
  for (let unit = 1; unit <= 6; unit++) wait.sent(unit, KB, unit);
  assert.equal(await wait.beforeRead(1, true, 1), false);
  assert.equal(await wait.beforeRead(2, true, 1), false);
  assert.equal(await wait.beforeRead(3, true, 1), true);
});
