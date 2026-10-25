const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {main, parseArgs} = require('../tools/probe-split-ladder.cjs');

const ALL = ['one', 'two', 'stop-input', 'stop-output', 'short-recv'];

async function ladder(args, outcomes = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hbl-split-ladder-'));
  const runsFile = path.join(directory, 'RUNS.md');
  await fs.writeFile(runsFile, '# Runs\n');
  const calls = [];
  const lines = [];
  let clock = Date.parse('2026-10-25T04:00:00Z');
  const result = await main(parseArgs(args), {
    sourceRevision: '0123456789abcdef',
    builds: path.join(directory, 'builds'),
    runsFile,
    log: line => lines.push(line),
    now: () => new Date((clock += 1500)),
    async run({command, args: probeArgs, stage}) {
      calls.push({command, args: probeArgs, stage});
      const verdict = outcomes[stage] || 'PASS';
      if (verdict === 'crash') return {code: 1, stdout: 'Error: Console disconnected\n'};
      if (verdict === 'nomarker') return {code: 0, stdout: 'done\n'};
      return {
        code: verdict === 'PASS' ? 0 : 1,
        stdout: 'SPLIT DECODER ' + stage + ' ' + verdict + ' (record /records/' + stage + ')\n'
      };
    }
  });
  return {result, calls, lines, runs: await fs.readFile(runsFile, 'utf8')};
}

const CLIP = ['--clip', '/clips/ip1080.h264'];

test('runs every stage in ladder order and records each one', async () => {
  const {result, calls, lines, runs} = await ladder(['/runs/launcher-x', ...CLIP]);
  assert.deepEqual(
    calls.map(call => call.stage),
    ALL
  );
  assert.deepEqual(calls[0].args.slice(1), [
    '/runs/launcher-x',
    '--clip',
    '/clips/ip1080.h264',
    '--stage',
    'one'
  ]);
  assert.match(calls[0].args[0], /probe-split-decoder\.cjs$/);
  assert.equal(result.verdict, 'PASS');
  assert.match(result.output, /2026-10-25T04-00-01-500Z-01234567-split-ladder$/);
  const saved = JSON.parse(await fs.readFile(path.join(result.output, 'ladder.json'), 'utf8'));
  assert.deepEqual(
    saved.stages.map(({stage, verdict, record, seconds}) => [stage, verdict, record, seconds]),
    ALL.map(stage => [stage, 'PASS', '/records/' + stage, 1.5])
  );
  assert.deepEqual(saved.skipped, []);
  assert.equal((runs.match(/^## /gm) || []).length, 1);
  assert.match(runs, /^## 2026-10-25 — split safety ladder at `01234567`/m);
  assert.match(runs, /^- one: PASS, \/records\/one, 1.5s$/m);
  assert.match(runs, /^- short-recv: PASS, \/records\/short-recv, 1.5s$/m);
  assert.match(lines.at(-1), /^SPLIT LADDER PASS/);
});

test('stops at the first failing stage and asks for a restart', async () => {
  const {result, calls, lines, runs} = await ladder(CLIP, {'stop-input': 'FAIL'});
  assert.deepEqual(
    calls.map(call => call.stage),
    ['one', 'two', 'stop-input']
  );
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(result.skipped, ['stop-output', 'short-recv']);
  assert.match(runs, /^- stop-input: FAIL, \/records\/stop-input, 1.5s$/m);
  assert.doesNotMatch(runs, /stop-output/);
  assert.match(lines.join('\n'), /FAIL at stop-input/);
  assert.match(lines.join('\n'), /Restart SmileBASIC/);
});

test('a nonzero exit or a missing PASS marker fails the stage', async () => {
  const crashed = await ladder(CLIP, {one: 'crash'});
  assert.equal(crashed.result.stages[0].verdict, 'FAIL');
  assert.match(crashed.runs, /^- one: FAIL, no record, 1.5s$/m);
  const silent = await ladder(CLIP, {two: 'nomarker'});
  assert.deepEqual(
    silent.result.stages.map(stage => stage.verdict),
    ['PASS', 'FAIL']
  );
});

test('a stage subset runs in ladder order', async () => {
  const {calls, runs} = await ladder([...CLIP, '--stages', 'short-recv,one']);
  assert.deepEqual(
    calls.map(call => call.stage),
    ['one', 'short-recv']
  );
  assert.equal((runs.match(/^- /gm) || []).length, 2);
});

test('dry run prints the probe commands without running or recording', async () => {
  const lines = [];
  const result = await main(parseArgs(['/runs/launcher-x', ...CLIP, '--dry-run']), {
    log: line => lines.push(line),
    run: () => assert.fail('dry run must not start a probe'),
    runsFile: '/nonexistent/RUNS.md',
    builds: '/nonexistent/builds'
  });
  assert.equal(result.dryRun, true);
  assert.equal(lines.length, 5);
  lines.forEach((line, index) =>
    assert.ok(
      line.endsWith(
        'probe-split-decoder.cjs /runs/launcher-x --clip /clips/ip1080.h264 --stage ' + ALL[index]
      ),
      line
    )
  );
});

test('native publication passes the flag to each probe stage', async () => {
  const {result, calls} = await ladder([...CLIP, '--native-publish']);
  assert.equal(result.nativePublish, true);
  assert.equal(calls.length, ALL.length);
  assert.ok(calls.every(call => call.args.at(-1) === '--native-publish'));
});

test('argument validation rejects missing and malformed options', () => {
  assert.throws(() => parseArgs([]), /--clip/);
  assert.throws(() => parseArgs(['--clip']), /--clip needs a value/);
  assert.throws(() => parseArgs(['--clip', '--dry-run']), /--clip needs a value/);
  assert.throws(() => parseArgs([...CLIP, '--stages']), /--stages needs a value/);
  assert.throws(() => parseArgs([...CLIP, '--stages', '']), /--stages needs a value/);
  assert.throws(() => parseArgs([...CLIP, '--stages', 'one,0']), /Unknown stage "0"/);
  assert.throws(() => parseArgs([...CLIP, '--stages', 'one,one']), /Repeated/);
  assert.throws(() => parseArgs([...CLIP, '--stage', 'one']), /Unknown option --stage/);
  assert.throws(() => parseArgs([...CLIP, 'extra']), /Unexpected argument/);
  const defaults = parseArgs(CLIP);
  assert.deepEqual(defaults.stages, ALL);
  assert.equal(defaults.directory, null);
  assert.equal(defaults.output, null);
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.nativePublish, false);
});
