// The stage tick book of HBL_STAGE_TICKS=1: pairing, tearing, generations and the host leg.
const test = require('node:test');
const assert = require('node:assert/strict');
const {TICKS_PER_MS, create} = require('../stage-ticks.js');

/** Console ticks of `value` ms. */
const ms = value => BigInt(value * TICKS_PER_MS);

/** A status read with each group's sequence and the stage ticks. */
function snapshot({receive = 0, input = 0, acquire = 0, fetch = 0, applied = 0, ticks = {}}) {
  return {
    current: 0,
    nativeApplied: applied,
    receive: {count: 0n, sequence: receive},
    input: {sendStatus: 0n, nextSlotStatus: 0n, nextIndex: 0, sequence: input},
    acquire: {status: 0n, index: 0, pts: 0n, sequence: acquire},
    fetch: {setStatus: 0n, getStatus: 0n, releaseStatus: 0n, sequence: fetch},
    ticks: {receive: 0n, submit: 0n, ready: 0n, publish: 0n, ...ticks}
  };
}

const once = value => ({p50: value, p95: value, max: value, n: 1});
const none = {p50: null, p95: null, max: null, n: 0};

test('the stage ticks count at 31.25 MHz and add the host leg to submit→publish', () => {
  assert.equal(TICKS_PER_MS * 1000, 31.25e6);
  const book = create();
  book.publishes(3, 9);
  const ticks = {receive: ms(1000), submit: ms(1002), ready: ms(1007), publish: ms(1008.5)};
  const unit = {receive: 3, input: 3, acquire: 3, fetch: 3, ticks};
  book.observe(snapshot({...unit, applied: 8}), 0);
  book.observe(snapshot({...unit, applied: 8}), 5);
  book.observe(snapshot({...unit, applied: 9}), 12);

  assert.deepEqual(book.summary, {
    receiveSubmit: once(2),
    decode: once(5),
    readyPublish: once(1.5),
    publishApplied: once(12),
    sendPresent: once(18.5),
    torn: 0,
    paired: 4
  });
});

/** Reads of the receive and submit stamps: [receive, tick, input, submit]. */
function reads(book, rows) {
  for (const [receive, tick, input, submit] of rows)
    book.observe(snapshot({receive, input, ticks: {receive: ms(tick), submit: ms(submit)}}), 0);
}

const twice = value => ({p50: value, p95: value, max: value, n: 2});

test('a newer tick under the held sequence is torn, and the held tick still books', () => {
  const book = create();
  // Unit 3's receive tick under unit 2's sequence, in the third read.
  reads(book, [
    [1, 5, 2, 12],
    [2, 10, 2, 12],
    [2, 26, 2, 12],
    [3, 26, 3, 28],
    [3, 26, 3, 28]
  ]);

  const {receiveSubmit, torn, paired} = book.summary;
  assert.deepEqual(receiveSubmit, twice(2));
  assert.equal(torn, 1);
  assert.equal(paired, 5);
});

test('one read per unit, as at lag 1, books each unit once the next one shows', () => {
  const book = create();
  reads(book, [
    [1, 10, 1, 13],
    [2, 30, 2, 33],
    [3, 50, 3, 53],
    [4, 70, 4, 73]
  ]);

  const {receiveSubmit, torn, paired} = book.summary;
  assert.deepEqual(receiveSubmit, {p50: 3, p95: 3, max: 3, n: 3});
  assert.equal(torn, 0);
  assert.equal(paired, 6);
});

test('a held tick that shows again under the next sequence was torn and never books', () => {
  const book = create();
  // The second read shows unit 3's receive tick under unit 2's sequence.
  reads(book, [
    [1, 5, 1, 7],
    [2, 26, 2, 12],
    [3, 26, 3, 28],
    [4, 40, 4, 42]
  ]);

  const {receiveSubmit, torn, paired} = book.summary;
  assert.deepEqual(receiveSubmit, twice(2));
  assert.equal(torn, 1);
  assert.equal(paired, 5);
});

test('a sequence going back starts a new generation of units', () => {
  const book = create();
  reads(book, [
    [5, 100, 4, 90],
    [5, 100, 4, 90],
    [1, 1, 0, 0],
    [1, 1, 0, 0],
    [5, 50, 5, 52],
    [5, 50, 5, 52]
  ]);

  assert.deepEqual(book.summary.receiveSubmit, once(2));
});

test('publish→applied runs from the first read showing the fetch to the first applied', () => {
  const book = create();
  book.publishes(6, 20);
  book.observe(snapshot({fetch: 5, applied: 19}), 100);
  book.observe(snapshot({fetch: 6, applied: 19}), 106);
  book.observe(snapshot({fetch: 6, applied: 19}), 111);
  book.observe(snapshot({fetch: 7, applied: 20}), 118);
  // Unit 7 was skipped: it publishes nothing of its own.
  book.observe(snapshot({fetch: 8, applied: 21}), 125);

  const {publishApplied, sendPresent, paired} = book.summary;
  assert.deepEqual(publishApplied, once(12));
  assert.deepEqual(sendPresent, none);
  assert.equal(paired, 0);
});

test('reads without stage ticks book nothing', () => {
  const book = create();
  const {ticks, ...plain} = snapshot({receive: 2, input: 2, ticks: {receive: 1n, submit: 2n}});
  book.observe(plain, 0);
  book.observe(plain, 5);
  assert.deepEqual(book.summary.receiveSubmit, none);
  assert.equal(book.summary.paired, 0);
});
