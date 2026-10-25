const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ring = require('../../tools/moonlight/ring.cjs');
const {
  clipFrameRate,
  pairIndices,
  stageOverlappedInput,
  requireNewPairedSession,
  waitForNativeReady
} = require('./probe-paired-output.cjs');

test('keyframe recovery keeps one decoder across P pair, IDR, and next P pair', () => {
  assert.deepEqual(pairIndices('keyframe', [0, 30, 60]), [
    [1, 2],
    [30],
    [31, 32]
  ]);
  assert.deepEqual(pairIndices('odd', [0, 30, 60]), [[30]]);
  assert.throws(() => pairIndices('keyframe', [0, 2, 3]), /two P frames/);
});

test('overlap opens the next decode gate only after the host exact receive check', async () => {
  const calls = [];
  let releaseInput;
  const pending = new Promise(resolve => { releaseInput = resolve; });
  const diagnostics = {decodeGateSignals: 2};
  const decoder = {
    splitDiagnostics: diagnostics,
    async stageSplitInput() { calls.push('stage'); },
    async verifySplitReceive() { calls.push('verified'); },
    async completeSplitInput() {
      calls.push('decode gate');
      diagnostics.decodeGateSignals++;
      await pending;
      return {sequence: 3};
    }
  };
  const step = async (_name, run) => run();
  const staged = await stageOverlappedInput(decoder, {pts: 3}, step);
  assert.deepEqual(calls, ['stage', 'verified', 'decode gate']);
  releaseInput();
  assert.deepEqual(await staged.completion, {value: {sequence: 3}});

  const rejected = {
    splitDiagnostics: {decodeGateSignals: 0},
    async stageSplitInput() {},
    async verifySplitReceive() { throw Error('short receive'); },
    async completeSplitInput() { throw Error('decode gate opened'); }
  };
  await assert.rejects(
    stageOverlappedInput(rejected, {pts: 3}, step),
    /short receive/
  );
});

test('paired output probe rejects launcher sessions used by prior native runs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paired-session-'));
  try {
    const prior = path.join(root, '2026-10-25-audio-socket-loop');
    await fs.mkdir(prior);
    await fs.writeFile(path.join(prior, 'audio-socket-loop.json'), '{"session":"launcher-old"}');
    await assert.rejects(requireNewPairedSession('launcher-old', root), /new normal START/);
    await assert.doesNotReject(requireNewPairedSession('launcher-new', root));
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('paired output preflight skips only an unused self-rejected session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paired-preflight-'));
  try {
    const directory = path.join(root, '2026-10-25-r3-paired-four');
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, 'paired-output.json'),
      JSON.stringify({
        probe: 'paired-output',
        session: 'launcher-fresh',
        verdict: 'FAIL',
        retainedForSafety: false,
        error: 'Start a new normal START session before paired output'
      })
    );
    const journal = path.join(directory, 'paired-output.jsonl');
    await fs.writeFile(journal, '');
    await assert.doesNotReject(requireNewPairedSession('launcher-fresh', root));
    await fs.writeFile(journal, '{"phase":"before","operation":"read"}\n');
    await assert.rejects(requireNewPairedSession('launcher-fresh', root), /new normal START/);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('paired output startup permits a balanced readiness read and rejects a mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paired-startup-'));
  try {
    const directory = path.join(root, '2026-10-25-r3-paired-four');
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, 'paired-output.json'),
      JSON.stringify({
        probe: 'paired-output',
        session: 'launcher-fresh',
        verdict: 'FAIL',
        retainedForSafety: false,
        error: 'Relaunch Moonlight after rebuilding its native-video shaders'
      })
    );
    const journal = path.join(directory, 'paired-output.jsonl');
    await fs.writeFile(
      journal,
      [
        {phase: 'before', operation: 'read'},
        {phase: 'after', operation: 'read'}
      ].map(entry => JSON.stringify(entry)).join('\n') + '\n'
    );
    await assert.doesNotReject(requireNewPairedSession('launcher-fresh', root));
    await fs.appendFile(journal, '{"phase":"before","operation":"write"}\n');
    await assert.rejects(requireNewPairedSession('launcher-fresh', root), /new normal START/);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('paired output waits for Moonlight to initialize native video', async () => {
  const values = [0, 0, ring.NATIVE_ABI];
  const rpc = {
    async read(address, length) {
      assert.equal(address, 0x70000000 + ring.CONTROL.nativeReady);
      assert.equal(length, 4);
      const value = Buffer.alloc(4);
      value.writeUInt32LE(values.shift());
      return value;
    }
  };
  await waitForNativeReady(rpc, {mapped: 0x70000000}, {timeoutMs: 1000, pollMs: 0});
  assert.equal(values.length, 0);
});

test('paired output configures the decoder at the clip frame rate', () => {
  assert.equal(clipFrameRate({fps: 120}), 120);
  assert.equal(clipFrameRate({}), 30);
  for (const fps of [0, 121, 59.94, '120'])
    assert.throws(() => clipFrameRate({fps}), /frame rate must be 1 to 120/);
});
