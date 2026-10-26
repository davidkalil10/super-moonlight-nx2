const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../../hbl-moonlight/tools/moonlight/exchange-timing.js');

test('exchanges bin by their offset from each known event', async () => {
  const {create} = await load();
  const timing = create({windowMs: 4});
  timing.record('status', 10, 12.5, {gate: 8, send: 20, decodeDone: 11.2, receiveDone: null});
  timing.record('status', 15, 17, {gate: 8, send: 20, decodeDone: 11.2});
  timing.record('gate', 18, 24, {gate: 8, send: 20});
  assert.deepEqual(timing.counts, {
    status: {
      exchanges: 2,
      ms: 4.5,
      offsets: {
        gate: {2: {n: 1, ms: 2.5}, '>': {n: 1, ms: 2}},
        send: {'<': {n: 2, ms: 4.5}},
        decodeDone: {'-2': {n: 1, ms: 2.5}, 3: {n: 1, ms: 2}}
      }
    },
    gate: {
      exchanges: 1,
      ms: 6,
      offsets: {gate: {'>': {n: 1, ms: 6}}, send: {'-2': {n: 1, ms: 6}}}
    }
  });
  timing.reset();
  assert.equal(timing.counts.status.exchanges, 0);
  assert.throws(() => timing.record('publish', 0, 1, {}), /Unknown exchange kind/);
});

test('the avoid window delays a read to after the event and parses from the flag', async () => {
  const {delayFor, parseAvoid} = await load();
  const avoid = {beforeMs: 2, afterMs: 3};
  assert.equal(delayFor(10, [20], avoid), 0);
  assert.equal(delayFor(18, [20], avoid), 5);
  assert.equal(delayFor(22.9, [20], avoid), 0.10000000000000142);
  assert.equal(delayFor(23, [20], avoid), 0);
  assert.equal(delayFor(18, [20, 24], avoid), 9, 'a read pushed into the next window moves again');
  assert.equal(delayFor(18, [24, 20], avoid), 9, 'whatever order the events come in');
  assert.equal(delayFor(18, [25, null, 20], avoid), 10);
  assert.equal(delayFor(18, [null, undefined], avoid), 0);
  assert.equal(delayFor(18, [20], null), 0);
  assert.deepEqual(parseAvoid('2-3.5'), {beforeMs: 2, afterMs: 3.5});
  assert.equal(parseAvoid(undefined), null);
  assert.throws(() => parseAvoid('2'), /before/);
});
