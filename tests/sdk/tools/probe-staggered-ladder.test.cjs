const test = require('node:test');
const assert = require('node:assert/strict');
const {clipIndices, expectedFor, waitChecked, waitOutput} = require('./probe-staggered-ladder.cjs');

test('staggered ladder selects overlap, keyframe recovery and odd tail in one clip', () => {
  const units = Array.from({length: 70}, (_, index) => ({keyframe: index % 30 === 0}));
  assert.deepEqual(clipIndices(units), [1, 2, 30, 31, 32]);
  const selected = [1, 2, 30, 31, 32].map(pts => ({pts, data: Buffer.alloc(pts + 100)}));
  const destinations = new Map([[1, {sequence: 12, index: 2}]]);
  assert.deepEqual(expectedFor(1, selected, destinations), {
    receive: {sequence: 1, bytes: 101}
  });
  assert.deepEqual(expectedFor(4, selected, destinations), {
    receive: {sequence: 4, bytes: 131},
    input: {sequence: 3},
    acquire: {sequence: 2, pts: 2n},
    fetch: {sequence: 1},
    ack: {sequence: 12, index: 2}
  });
});

test('ladder status wait fails on a short receive without opening a gate', async () => {
  const worker = {
    async readStatus() {
      return {receive: {sequence: 1, count: 99n}};
    }
  };
  await assert.rejects(
    () => waitChecked(worker, {receive: {sequence: 1, bytes: 100}}),
    /Short receive/
  );
});

test('tail wait accepts output without a new receive', async () => {
  const worker = {
    async readStatus() {
      return {
        current: 2,
        nativeApplied: 14,
        receive: {sequence: 0, count: 0n},
        acquire: {sequence: 5, status: 0n, index: 1, pts: 32n},
        fetch: {sequence: 4, setStatus: 0n, getStatus: 0n, releaseStatus: 0n}
      };
    }
  };
  const snapshot = await waitOutput(worker, {
    acquire: {sequence: 5, pts: 32n},
    fetch: {sequence: 4},
    ack: {sequence: 14, index: 2}
  });
  assert.equal(snapshot.acquire.index, 1);
});
