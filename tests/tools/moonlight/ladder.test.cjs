// HBLauncher's T304 ladder runner: rung arguments, the refusals, the flag-on check against the
// records native-h264.js writes, and the button-to-photon estimate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ladder = require('../../../HBLauncher/tools/moonlight/ladder.cjs');
const fake = require('../../../HBLauncher/tools/moonlight/ladder-fake.cjs');

const MOON = path.resolve(__dirname, '../../../hbl-moonlight');

test('every rung carries the T115 control arguments and its own flags', () => {
  const control = ladder.base('192.168.8.245');
  assert.deepEqual(control.slice(0, 3), ['--moonlight', '192.168.8.245', 'Desktop']);
  for (const flag of ['--staggered', '--socket-audio', '--duration'])
    assert.ok(control.includes(flag));
  assert.deepEqual(ladder.rungFlags('R1', {trimMs: 31}), ['--trim-backlog-ms', '31']);
  assert.deepEqual(ladder.rungFlags('R4a'), ['--gate-on-receive', '--receive-wait']);
  assert.deepEqual(ladder.rungFlags('R0', {extra: {R0: ['--queue', '4']}}), ['--queue', '4']);
});

test('gate on receive at 120 Hz is refused, however the flags were added', () => {
  const r4a = [...ladder.base('h'), ...ladder.rungFlags('R4a')];
  assert.equal(ladder.refusal(r4a), null);
  assert.match(ladder.refusal([...r4a, '--present-hz', '120']), /--gate-on-receive/);
});

test('present-hz 120 is refused, and the estimate is labelled 60 Hz', () => {
  assert.match(ladder.refusal([...ladder.base('h'), '--present-hz', '120']), /60 Hz model/);
  assert.equal(ladder.refusal([...ladder.base('h'), '--present-hz', '60']), null);
  assert.match(ladder.tsv([]), /estimate60HzMs/);
  assert.match(ladder.table([]), /estimate60HzMs/);
});

test('R1 needs R0 first or an explicit ms', () => {
  assert.throws(() => ladder.parseArgs(['--dry-run', '--rungs', 'R1']), /add R0/);
  assert.throws(() => ladder.parseArgs(['--dry-run', '--rungs', 'R1,R0']), /R0 runs first/);
  assert.equal(ladder.parseArgs(['--dry-run', '--rungs', 'R1', '--trim-ms', '30']).trimMs, 30);
  assert.throws(() => ladder.parseArgs(['--dry-run', '--rungs', 'R9']), /Unknown rung R9/);
  assert.throws(() => ladder.parseArgs(['--rungs', 'R0']), /RUN_DIR/);
  assert.deepEqual(ladder.parseArgs(['--dry-run', '--add', 'R3', '--queue 4']).extra, {
    R3: ['--queue', '4']
  });
});

test('R1 takes its ms from the passing R0 attempt', () => {
  const failed = {rung: 'R0', pass: false, gateAgeMs: 40};
  const passed = {rung: 'R0-retry', pass: true, gateAgeMs: 22};
  assert.equal(ladder.controlFor([failed, passed]), passed);
  assert.equal(ladder.controlFor([failed, {rung: 'R0-retry', pass: false, gateAgeMs: 30}]).gateAgeMs,
    30);
  assert.equal(ladder.controlFor([{rung: 'R0', pass: false, gateAgeMs: null}]), null);
});

test('a flag is on only where native-h264.js records it', () => {
  const started = {event: 'staggered-worker', started: true, trimBacklogMs: 30};
  const summary = {skipBacklog: 1, inputHz: 120, receiveWait: true};
  assert.equal(ladder.flagOn([], {started, summary}), '-');
  assert.equal(ladder.flagOn(['--trim-backlog-ms', '30'], {started, summary}), 'on');
  assert.equal(ladder.flagOn(['--trim-backlog-ms', '31'], {started, summary}), 'FLAG-NOT-ON');
  assert.equal(ladder.flagOn(['--gate-on-receive', '--receive-wait'], {started, summary}),
    'FLAG-NOT-ON');
  assert.equal(ladder.flagOn(['--skip-backlog', '1'], {started, summary}), 'on');
  assert.equal(ladder.flagOn(['--input-hz', '120'], {started: null, summary}), 'NO-START');
  assert.equal(ladder.flagOn(['--input-hz', '120'], {started, summary: {inputHz: 60}}),
    'FLAG-NOT-ON');
});

test('the estimate fed the T304 typical column comes to its ~175 ms', () => {
  const typical = {
    inputHz: 60,
    au: {waitMs: 25},
    stages: {input: {requestsPerFrame: 1, bridgeMsPerFrame: 2}}
  };
  const {ms, terms} = ladder.estimate(typical);
  assert.equal(ms, 172.5);
  assert.equal(terms.fixed, 87.2);
  assert.equal(ladder.estimate({...typical, gateOnReceive: true, outputLag: 1}).ms, 139.2);
  assert.equal(ladder.estimate({...typical, inputHz: 120}).ms, 168.4);
  assert.equal(ladder.estimate({fps: 60}), null);
});

test('a counts pipe error marks the rung INPUT-COUNTS-INCOMPLETE', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-records-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const events = [
    {event: 'staggered-worker', started: true, outputLag: 1},
    {event: 'input-counts-error', message: 'EPIPE'}
  ];
  fs.writeFileSync(path.join(directory, 'events.jsonl'),
    events.map(event => JSON.stringify(event)).join('\n') + '\n');
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(
    {fps: 60, dropped: 0, idr: 0, pass: true, failures: [], au: {waitMs: 20, gateAgeMs: 18}}));
  const records = ladder.readRecords(directory);
  const row = ladder.row('R4b', ['--output-lag', '1'], records);
  assert.equal(row.flagOn, 'on');
  assert.equal(row.note, 'INPUT-COUNTS-INCOMPLETE');
  assert.equal(row.score, 'fps 60 dropped 0 idr 0 PASS');
  const [header, line] = ladder.tsv([row]).trim().split('\n');
  assert.equal(header.split('\t').length, line.split('\t').length);
});

test('a fake rung writes the records the ladder reads', {timeout: 20000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-fake-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(runDir, 'app-runtime.json'), '{"active":{"id":"moonlight"}}');
  const flags = ladder.rungFlags('R1', {trimMs: 9});
  const directory = path.join(root, 'R1');
  await fake.create(MOON, runDir)([...ladder.base('h'), ...flags], directory, 5, /^$/);
  const row = ladder.row('R1', flags, ladder.readRecords(directory));
  assert.equal(row.flagOn, 'on');
  assert.match(row.score, /^fps \d+(\.\d+)? dropped 0 idr 0 trimmed \d+ PASS$/);
  assert.equal(typeof row.gateAgeMs, 'number');
  assert.equal(typeof row.estimateMs, 'number');
});
