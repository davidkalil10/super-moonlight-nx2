const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ring = require('../../tools/moonlight/ring.cjs');
const {
  requireNewPairedSession,
  waitForNativeReady
} = require('./probe-paired-output.cjs');

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
