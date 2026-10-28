// Loopback probe: join.py pairs presses, flips and patch changes by time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const JOIN = path.join(__dirname, '../join.py');
const WALL = 1_793_209_900_000_000;

/** Joins one press, its flip and the unit showing it; evdevUs is the flip's pad time. */
function joinOne(evdevUs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loopback-join-'));
  const flips = path.join(directory, 'flips.log');
  const run = path.join(directory, 'run.log');
  const lines = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';

  fs.writeFileSync(
    flips,
    lines([{event: 'flip', edge: 1, evdevUs, state: 1, flipUs: WALL + 1500}])
  );
  fs.writeFileSync(
    run,
    lines([
      {event: 'probe-press', edge: 1, pressed: true, wallUs: WALL},
      {event: 'probe-patch', seq: 7, state: 1, receivedUs: WALL + 19500, decodedUs: WALL + 21500}
    ])
  );
  try {
    return JSON.parse(
      execFileSync('python3', ['-I', JOIN, flips, run, '--json'], {encoding: 'utf8'})
    );
  } finally {
    fs.rmSync(directory, {recursive: true});
  }
}

test('a pad time on the wall clock gives every leg', () => {
  const result = joinOne(WALL + 1000);
  const [row] = result.rows;

  assert.equal(result.missing.flip, 0);
  assert.deepEqual([row.A, row.B, row.AB, row.C, row.D, row.total], [1, 0.5, 1.5, 18, 2, 21.5]);
  assert.equal(result.foreignEvdev, 0);
});

test('a pad time on a clock of its own still joins, without A and B', () => {
  const result = joinOne(924_685_669);
  const [row] = result.rows;

  assert.equal(result.missing.flip, 0);
  assert.deepEqual([row.AB, row.C, row.D, row.total], [1.5, 18, 2, 21.5]);
  assert.equal('A' in row || 'B' in row, false);
  assert.equal(result.foreignEvdev, 1);
});
