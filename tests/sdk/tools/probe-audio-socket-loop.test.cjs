const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {requireNewAudioSession} = require('./probe-audio-socket-loop.cjs');

test('socket audio loop rejects a launcher session already used by an audio probe', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-session-'));
  try {
    const prior = path.join(root, '2026-10-25-audio-event');
    await fs.mkdir(prior);
    await fs.writeFile(path.join(prior, 'audio-event.json'), '{"session":"launcher-old"}');
    await assert.rejects(requireNewAudioSession('launcher-old', root), /Start a new normal START/);
    await assert.doesNotReject(requireNewAudioSession('launcher-new', root));
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});
