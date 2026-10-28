// Helpers shared by the moonlight test files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const created = [];

test.after(() => {
  for (const directory of created) fs.rmSync(directory, {recursive: true, force: true});
});

/** A path to NAME in a fresh temp directory, removed after the file's tests. */
function tempFile(prefix, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(directory);
  return path.join(directory, name);
}

/**
 * The staggered counts without the pacer's read counters and the acquire-wait timings, which the
 * fake device does not pin. EXCHANGE is the exchange bin that must carry a timing.
 */
const withoutPacer =
  exchange =>
  ({pacer, exchanges, acquireWaits, ...counts}) => (
    assert.equal(typeof pacer.reads, 'number'),
    assert.equal(typeof exchanges[exchange].ms, 'number'),
    assert.deepEqual(Object.keys(acquireWaits), ['small', 'large']),
    counts
  );

const uiPage = () => import('../../../host/ui/page.js');

module.exports = {tempFile, withoutPacer, uiPage};
