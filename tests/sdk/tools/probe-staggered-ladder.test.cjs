const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clipIndices,
  expectedFor,
  proveHeld,
  proveRelease,
  waitChecked,
  waitOutput
} = require('./probe-staggered-ladder.cjs');

const noWait = async () => {};
const statusSequence = list => {
  let index = 0;
  return {
    async readStatus() {
      const [input, acquire, fetch = acquire - 1] = list[Math.min(index++, list.length - 1)];
      return {
        input: {sequence: input, sendStatus: 0n},
        acquire: {sequence: acquire},
        fetch: {sequence: fetch}
      };
    }
  };
};

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

test('a held fetch must keep decode N unsubmitted for the whole window', async () => {
  assert.deepEqual(await proveHeld(statusSequence([[3, 2]]), 4, {polls: 5, wait: noWait}), {
    polls: 5,
    input: 3,
    acquire: 2
  });
  await assert.rejects(
    () =>
      proveHeld(
        statusSequence([
          [3, 2],
          [3, 2],
          [4, 2]
        ]),
        4,
        {wait: noWait}
      ),
    /Decode 4 opened while output 2 was held/
  );
  await assert.rejects(
    () =>
      proveHeld(
        statusSequence([
          [3, 2],
          [3, 3]
        ]),
        4,
        {wait: noWait}
      ),
    /opened while output 2 was held/
  );
});

test('a released fetch must show N-1 acquired before decode N is submitted', async () => {
  assert.deepEqual(
    await proveRelease(
      statusSequence([
        [3, 2, 1],
        [3, 3, 2],
        [4, 3, 2]
      ]),
      4,
      {wait: noWait}
    ),
    {polls: 3, acquire: 3}
  );
  await assert.rejects(
    () =>
      proveRelease(
        statusSequence([
          [3, 2, 1],
          [4, 2, 2]
        ]),
        4,
        {wait: noWait}
      ),
    /Decode 4 was submitted before output 3 was acquired/
  );
  await assert.rejects(
    () => proveRelease(statusSequence([[3, 2, 1]]), 4, {timeoutMs: 20, wait: noWait}),
    /did not open/
  );
});
