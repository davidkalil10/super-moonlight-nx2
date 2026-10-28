// The decoder slot readout of HBL_STAGE_TICKS=1: distinct indices, counts and refusals.
const test = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../slot-readout.js');

/** A status read with the input and acquire groups only. */
function snapshot({input = {}, acquire = {}}) {
  return {
    input: {sendStatus: 0n, nextSlotStatus: 0n, nextIndex: 0, sequence: 0, remaining: 0, ...input},
    acquire: {status: 0n, index: 0, pts: 0n, sequence: 0, remaining: 0, ...acquire}
  };
}

test('the slot readout books distinct indices and the most remaining, over repeated reads', () => {
  const book = create();
  for (const [sequence, index] of [
    [1, 0],
    [2, 1],
    [2, 1],
    [3, 2],
    [4, 3],
    [5, 0]
  ])
    book.observe(
      snapshot({
        input: {sequence, nextIndex: index, remaining: sequence === 3 ? 2 : 1},
        acquire: {sequence, index: (index + 3) % 4, remaining: sequence === 4 ? 1 : 0}
      })
    );

  assert.deepEqual(book.summary, {
    input: {indices: [0, 1, 2, 3], remainingMax: 2, noSlot: {}},
    output: {indices: [0, 1, 2, 3], remainingMax: 1}
  });
});

test('a refused input slot counts once per sequence and a failed acquire books nothing', () => {
  const book = create();
  const refused = {sequence: 7, nextSlotStatus: 0x1011n, nextIndex: -1};
  book.observe(snapshot({input: refused, acquire: {sequence: 7, status: 0x100en, index: -1}}));
  book.observe(snapshot({input: refused}));
  book.observe(snapshot({input: {...refused, sequence: 8}}));
  // A read before any group has run shows only zero sequences.
  book.observe(snapshot({}));

  assert.deepEqual(book.summary, {
    input: {indices: [], remainingMax: 0, noSlot: {'0x1011': 2}},
    output: {indices: [], remainingMax: 0}
  });
});
