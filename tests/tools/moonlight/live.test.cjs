const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const LIVE = path.resolve(__dirname, '../../../hbl-moonlight/host/stream/live.js');
const H264 = ['--codec', 'h264', '--moonlight', 'host', 'Desktop'];

function runDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-dispatch-'));
  fs.mkdirSync(path.join(directory, 'shared'));
  fs.writeFileSync(
    path.join(directory, 'shared', 'rpc.cjs'),
    "module.exports = {a: {protocol: 3, session: 'launcher-Test01'}};\n"
  );
  fs.writeFileSync(
    path.join(directory, 'app-moonlight-1.json'),
    JSON.stringify({
      started: '2026-10-26T00:00:00Z',
      privateStorage: {mapped: 0x10000000, bytes: 0x40000000, memoryFlags: 7}
    })
  );
  return directory;
}

function live(directory, args) {
  const result = spawnSync(process.execPath, [LIVE, directory, ...args], {
    encoding: 'utf8',
    timeout: 20000
  });
  return {status: result.status, error: result.stderr.trim().split('\n').at(-1)};
}

test('live.js hands the staggered skip options to the native H.264 parser', t => {
  const directory = runDirectory();
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  assert.deepEqual(live(directory, [...H264, '--decode-wait']), {
    status: 1,
    error: '--decode-wait needs --skip-rule vsync'
  });
  assert.deepEqual(live(directory, [...H264, '--staggered', '--decode-wait']), {
    status: 1,
    error: '--decode-wait needs --skip-rule vsync'
  });
  assert.deepEqual(live(directory, [...H264, '--staggered', '--skip-rule', 'frames']), {
    status: 1,
    error: '--skip-rule takes backlog or vsync'
  });
  assert.deepEqual(
    live(directory, [...H264, '--staggered', '--skip-rule', 'vsync', '--skip-backlog', 'off']),
    {status: 1, error: '--skip-rule vsync needs a --skip-backlog unit count'}
  );
});

test('a valid vsync and decode-wait set passes parsing and stops at the session check', t => {
  const directory = runDirectory();
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  for (const staggered of [['--staggered'], []])
    assert.deepEqual(
      live(directory, [...H264, ...staggered, '--skip-rule', 'vsync', '--decode-wait']),
      {status: 1, error: 'Native TCP requires a fresh launcher session from this branch'}
    );
});

test('live.js streams H.264 by default and refuses any other codec', t => {
  const directory = runDirectory();
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  assert.deepEqual(live(directory, ['--moonlight', 'host', 'Desktop']), {
    status: 1,
    error: 'Native TCP requires a fresh launcher session from this branch'
  });
  for (const codec of ['hbv1', 'hbv2'])
    assert.deepEqual(live(directory, ['--codec', codec, '--moonlight', 'host', 'Desktop']), {
      status: 1,
      error: '--codec is h264'
    });
});
