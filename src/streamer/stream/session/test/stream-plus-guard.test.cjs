// The stream's + guard wrapper: it never throws into the stream and keeps the saved pointer
// in the run directory until it is restored.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {armPlusGuard, STATE} = require('../stream-plus-guard.js');

const PROGRAM = 0x50001000;

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hbl-plus-guard-'));
}

/** A guard stand-in: `arm` returns `held` (after saving it) or throws `failure`. */
function fakeGuard({held = {program: PROGRAM, saved: 0x5000a000n}, failure, restore} = {}) {
  const calls = [];
  return {
    calls,
    async arm(rpc, {save}) {
      calls.push('arm');
      if (failure?.reason === 'sb4-build') throw failure;
      save(held);
      if (failure) throw failure;
      return held;
    },
    async disarm(rpc, value) {
      calls.push(['disarm', value.saved]);
      if (restore) throw restore;
      return `restored 0x${value.saved.toString(16)} (read back)`;
    }
  };
}

const events = () => {
  const list = [];
  return {list, log: event => list.push(event)};
};

test('arm saves the pointer to the run directory and disarm restores and clears it', async () => {
  const directory = scratch();
  const guard = fakeGuard();
  const {list, log} = events();
  const stream = await armPlusGuard({}, directory, log, {guard});
  const state = JSON.parse(fs.readFileSync(path.join(directory, STATE), 'utf8'));
  assert.deepEqual(state, {program: PROGRAM, saved: '0x5000a000'});
  assert.deepEqual(list, [{event: 'plus-guard', armed: true}]);

  await stream.disarm();
  assert.deepEqual(stream.report, {
    armed: true,
    restored: true,
    outcome: 'restored 0x5000a000 (read back)'
  });
  assert.equal(fs.existsSync(path.join(directory, STATE)), false);
  fs.rmSync(directory, {recursive: true});
});

test('an inherited 0 adopts a pointer left by a stream that died armed', async () => {
  const directory = scratch();
  fs.writeFileSync(
    path.join(directory, STATE),
    JSON.stringify({program: PROGRAM, saved: '0x5000a000'})
  );
  const guard = fakeGuard({held: {program: PROGRAM, saved: null}});
  const stream = await armPlusGuard({}, directory, () => {}, {guard});
  assert.equal(stream.report.armed, 'adopted');
  await stream.disarm();
  assert.deepEqual(guard.calls, ['arm', ['disarm', 0x5000a000n]]);
  assert.equal(stream.report.restored, true);
  fs.rmSync(directory, {recursive: true});
});

test('an inherited 0 under another program is left alone', async () => {
  const directory = scratch();
  fs.writeFileSync(
    path.join(directory, STATE),
    JSON.stringify({program: PROGRAM + 0x1000, saved: '0x5000a000'})
  );
  const guard = fakeGuard({held: {program: PROGRAM, saved: null}});
  const stream = await armPlusGuard({}, directory, () => {}, {guard});
  assert.equal(stream.report.armed, 'inherited');
  await stream.disarm();
  assert.deepEqual(guard.calls, ['arm']);
  assert.equal(stream.report.restored, null);
  fs.rmSync(directory, {recursive: true});
});

test('a program that ended or a fresh exec context is left without a warning', async () => {
  const directory = scratch();
  const guard = fakeGuard();
  guard.disarm = async () => 'left alone, an exec wrote 0x5000b000';
  const stream = await armPlusGuard({}, directory, () => {}, {guard});
  await stream.disarm();
  assert.equal(stream.report.restored, null);
  assert.equal(stream.report.outcome, 'left alone, an exec wrote 0x5000b000');
  assert.equal(fs.existsSync(path.join(directory, STATE)), false);
  fs.rmSync(directory, {recursive: true});
});

test('a guard that cannot arm is logged and never throws', async () => {
  const directory = scratch();
  const failure = Object.assign(Error('Plus guard needs SmileBASIC 4.4.9'), {reason: 'sb4-build'});
  const guard = fakeGuard({failure});
  const {list, log} = events();
  const stream = await armPlusGuard({}, directory, log, {guard});
  await stream.disarm();
  assert.deepEqual(stream.report, {armed: false, restored: null, reason: 'sb4-build'});
  assert.deepEqual(list, [
    {event: 'plus-guard', armed: false, reason: 'sb4-build', error: failure.message}
  ]);
  assert.deepEqual(guard.calls, ['arm']);
  fs.rmSync(directory, {recursive: true});
});

test('a failed arm drops its saved pointer unless the zero could not be undone', async () => {
  const directory = scratch();
  const file = path.join(directory, STATE);
  const undone = Object.assign(Error('Plus guard did not arm'), {
    reason: 'read-back',
    undone: true
  });
  await armPlusGuard({}, directory, () => {}, {guard: fakeGuard({failure: undone})});
  assert.equal(fs.existsSync(file), false);

  const stuck = Object.assign(Error('Plus guard did not arm'), {reason: 'write', undone: false});
  const stream = await armPlusGuard({}, directory, () => {}, {guard: fakeGuard({failure: stuck})});
  assert.equal(stream.report.armed, false);
  assert.ok(fs.existsSync(file), 'the next stream adopts it');

  fs.rmSync(file);
  const gone = Error('Console connection closed');
  const lost = await armPlusGuard({}, directory, () => {}, {guard: fakeGuard({failure: gone})});
  assert.equal(lost.report.reason, 'error');
  assert.ok(fs.existsSync(file), 'a raw error after the save may have left the zero landed');

  const build = Object.assign(Error('Plus guard needs SmileBASIC 4.4.9'), {reason: 'sb4-build'});
  await armPlusGuard({}, directory, () => {}, {guard: fakeGuard({failure: build})});
  assert.ok(fs.existsSync(file), 'a check that wrote nothing leaves an older pointer alone');
  fs.rmSync(directory, {recursive: true});
});

test('a lost bridge or a failed restore is reported and keeps the saved pointer', async () => {
  const directory = scratch();
  const rpc = {bridgeLost: false};
  const lost = await armPlusGuard(rpc, directory, () => {}, {guard: fakeGuard()});
  rpc.bridgeLost = true;
  await lost.disarm();
  assert.deepEqual(lost.report, {armed: true, restored: false, reason: 'bridge-lost'});
  assert.ok(fs.existsSync(path.join(directory, STATE)));

  let streamLost = false;
  const seen = await armPlusGuard({}, directory, () => {}, {
    guard: fakeGuard(),
    lost: () => streamLost
  });
  streamLost = true;
  await seen.disarm();
  assert.equal(seen.report.reason, 'bridge-lost');

  const restore = Error('Plus guard restore read back ...; restart SmileBASIC before using +');
  const {list, log} = events();
  const failed = await armPlusGuard({}, directory, log, {guard: fakeGuard({restore})});
  await failed.disarm();
  assert.deepEqual(failed.report, {armed: true, restored: false, reason: 'restore-failed'});
  assert.deepEqual(list.at(-1), {
    event: 'plus-guard',
    restored: false,
    reason: 'restore-failed',
    error: restore.message
  });
  assert.ok(fs.existsSync(path.join(directory, STATE)));
  fs.rmSync(directory, {recursive: true});
});
