const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {requireNewPairedSession} = require('./probe-paired-output.cjs');

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
        session: 'launcher-fresh',
        verdict: 'FAIL',
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
