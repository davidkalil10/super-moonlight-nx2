const test = require('node:test');
const assert = require('node:assert/strict');
const {gate} = require('../../../hbl-moonlight/tools/moonlight/input-feeder.js');

test('input stops the frame the overlay goes up, with one release, and resumes when it drops', () => {
  assert.deepEqual(gate(false, 0), {paused: false, release: false});
  assert.deepEqual(gate(false, 1), {paused: true, release: true});
  assert.deepEqual(gate(true, 1), {paused: true, release: false});
  assert.deepEqual(gate(true, 0), {paused: false, release: false});
});
