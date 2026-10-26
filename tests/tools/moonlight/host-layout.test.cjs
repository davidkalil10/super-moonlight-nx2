const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const {
  render,
  OUTPUT
} = require('../../../hbl-moonlight/tools/moonlight/helper/generate-layout.js');

test('the native host layout header matches its JS sources', () => {
  assert.strictEqual(fs.readFileSync(OUTPUT, 'utf8'), render());
});
