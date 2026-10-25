const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {main, parseArgs, STAGES} = require('./probe-paired-ladder.cjs');

test('paired ladder parses stages in safety order and rejects bad options', () => {
  const parsed = parseArgs(['--clip', '/tmp/ip1080.h264', '--stages', 'short-recv,one,two']);
  assert.deepEqual(parsed.stages, ['one', 'two', 'short-recv']);
  assert.deepEqual(STAGES, ['one', 'two', 'stop-input', 'stop-output', 'short-recv']);
  assert.equal(parseArgs(['--clip', '/tmp/ip1080.h264', '--loop']).loop, true);
  assert.equal(parseArgs(['--clip', '/tmp/ip1080.h264', '--staggered']).staggered, true);
  assert.throws(
    () => parseArgs(['--clip', '/tmp/ip1080.h264', '--staggered', '--loop']),
    /complete safety stages/
  );
  assert.throws(() => parseArgs(['--clip', '/tmp/ip1080.h264', '--stages', 'two,two']), /stages/);
  assert.throws(() => parseArgs(['--clip']), /needs a value/);
});

test('paired ladder delegates one staggered safety batch', async () => {
  let calls = 0;
  const result = await main(
    {directory: '/tmp/launcher-test', clip: '/tmp/ip1080.h264', staggered: true, dryRun: true},
    {
      runStaggered: async (directory, options) => {
        calls++;
        assert.equal(directory, '/tmp/launcher-test');
        assert.deepEqual(options, {clip: '/tmp/ip1080.h264', dryRun: true});
        return {dryRun: true};
      }
    }
  );
  assert.equal(calls, 1);
  assert.equal(result.dryRun, true);
});

test('paired loop ladder maps only output stages to the persistent collector', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paired-loop-ladder-'));
  try {
    const calls = [];
    const result = await main(
      {
        directory: path.join(root, 'launcher-test'),
        clip: '/tmp/ip1080.h264',
        stages: ['one', 'two'],
        loop: true
      },
      {
        sourceRevision: '0123456789abcdef',
        builds: root,
        runsFile: path.join(root, 'RUNS.md'),
        sessionRpc: () => ({host: '127.0.0.1', a: {session: 'launcher-test'}}),
        ensureFresh: async () => {},
        runSplit: async (_directory, options) => {
          calls.push(options.stage);
          await fs.mkdir(options.output, {recursive: true});
          await fs.writeFile(path.join(options.output, 'result.json'), '{}');
        },
        runPaired: async (_directory, options) => {
          calls.push(options.stage);
          await fs.mkdir(options.output, {recursive: true});
          await fs.writeFile(path.join(options.output, 'paired-output.json'), '{}');
        },
        log: () => {}
      }
    );
    assert.deepEqual(calls, ['one', 'loop-two']);
    assert.equal(result.verdict, 'PASS');
    assert.match(result.output, /paired-loop-ladder$/);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('paired ladder stops and records the first failing stage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paired-ladder-'));
  try {
    const runsFile = path.join(root, 'RUNS.md');
    const calls = [];
    const result = await main(
      {directory: path.join(root, 'launcher-test'), clip: '/tmp/ip1080.h264', stages: STAGES},
      {
        sourceRevision: '0123456789abcdef',
        builds: root,
        runsFile,
        sessionRpc: () => ({host: '127.0.0.1', a: {session: 'launcher-test'}}),
        ensureFresh: async id => assert.equal(id, 'launcher-test'),
        runSplit: async (_directory, options) => {
          calls.push(options.stage);
          await fs.mkdir(options.output, {recursive: true});
          await fs.writeFile(path.join(options.output, 'result.json'), '{}');
        },
        runPaired: async (_directory, options) => {
          calls.push(options.stage);
          assert.equal(options.allowSameSession, true);
          await fs.mkdir(options.output, {recursive: true});
          await fs.writeFile(path.join(options.output, 'paired-output.json'), '{}');
          throw Error('acquire timed out');
        },
        log: () => {}
      }
    );
    assert.deepEqual(calls, ['one', 'two']);
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.skipped, ['stop-input', 'stop-output', 'short-recv']);
    assert.match(await fs.readFile(runsFile, 'utf8'), /two: FAIL/);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});
