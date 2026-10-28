const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {gate, readStorage, OVERLAY_READ} = require('../../../host/input/input-feeder.js');
const {UI, UI_MAGIC} = require('../../../tools/moonlight/ring.js');

function block(magic, overlay) {
  const bytes = Buffer.alloc(OVERLAY_READ.bytes);
  bytes.writeUInt32LE(magic, 0);
  bytes.writeUInt32LE(overlay, UI.uiOverlay - UI.uiMagic);
  return bytes;
}

test('input stops the frame the overlay goes up, with one release, and resumes when it drops', () => {
  assert.equal(OVERLAY_READ.offset, UI.uiMagic);
  assert.deepEqual(gate(false, block(UI_MAGIC, 0)), {paused: false, release: false});
  assert.deepEqual(gate(false, block(UI_MAGIC, 1)), {paused: true, release: true});
  assert.deepEqual(gate(true, block(UI_MAGIC, 1)), {paused: true, release: false});
  assert.deepEqual(gate(true, block(UI_MAGIC, 0)), {paused: false, release: false});
  assert.deepEqual(
    gate(false, block(0, 1)),
    {paused: false, release: false},
    'no service, no gate'
  );
});

test('the gate reads the newest Moonlight app report for the private storage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hbfeeder-'));
  try {
    assert.equal(readStorage(directory), null);
    fs.writeFileSync(
      path.join(directory, 'app-moonlight-1.json'),
      JSON.stringify({started: '2026-10-26T10:00:00Z', privateStorage: {mapped: 0x1000, bytes: 4}})
    );
    fs.writeFileSync(
      path.join(directory, 'app-moonlight-2.json'),
      JSON.stringify({started: '2026-10-26T11:00:00Z', privateStorage: {mapped: 0x2000, bytes: 4}})
    );
    fs.writeFileSync(
      path.join(directory, 'app-smilebasic-3.json'),
      JSON.stringify({started: '2026-10-26T12:00:00Z', privateStorage: {mapped: 0x3000}})
    );
    assert.deepEqual(readStorage(directory), {mapped: 0x2000, bytes: 4});
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
