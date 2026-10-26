// HBLauncher hello-world end to end on desktop.vulkan: first frame, exit on B, repeat hash.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {gpuStatus, WIDTH, HEIGHT} = require('./run.cjs');
const {runHelloWorld} = require('./hello-world.cjs');
const {builds} = require('../../../hbl-platform/scripts/toolchain.js');

fs.mkdirSync(builds('desktop-vulkan'), {recursive: true});
const scratch = fs.mkdtempSync(path.join(builds('desktop-vulkan'), 'hello-'));
test.after(() => fs.rmSync(scratch, {recursive: true, force: true}));
const gpu = gpuStatus(path.join(scratch, 'runner'));
const skip = gpu.reason ?? false;

/** @param {string[][]} buttons One list per frame, all connected. */
const script = buttons => ({
  format: 'hb-desktop-frame-script',
  version: 1,
  frameCount: buttons.length,
  clock: {mode: 'fixed-step', originMs: 0, rateHz: 60},
  inputs: buttons.map((list, frame) => ({frame, connected: true, buttons: list}))
});

/**
 * @param {string} name
 * @param {object} [frames] Defaults to the checked-in fixture.
 */
const hello = (name, frames) =>
  runHelloWorld({
    buildDir: path.join(scratch, name),
    outputDir: path.join(scratch, name, 'output'),
    script: frames,
    runner: gpu.runner
  });

test('hello-world-idle-first-frame', {skip}, async t => {
  const result = await hello('idle', script([[]]));
  assert.equal(result.selected, 'desktop.vulkan');
  assert.ok(fs.existsSync(path.join(scratch, 'idle/package/hello-world/src/time.glsl')));
  const {state} = result;
  assert.equal(state.buttons, 0);
  assert.equal(state.connected, 1);
  assert.equal(state.time, Math.fround(1 / 60));
  assert.equal(state.previousButtons, 0);
  assert.equal(state.frames, 1);
  assert.ok(Math.abs(state.fade - 14 / 15) < 1e-6);
  assert.equal(state.exitRequest, 0);
  const rgba = fs.readFileSync(result.files['frame.rgba']);
  assert.equal(rgba.length, WIDTH * HEIGHT * 4);
  assert.ok(rgba.some((byte, index) => index % 4 !== 3 && byte !== 0));
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  t.diagnostic(result.device.name + ' first frame sha256 ' + result.sha256);
});

test('hello-world-back-press-requests-exit', {skip}, async () => {
  const result = await hello('back', script([[], ['B']]));
  assert.deepEqual(
    result.frames.map(frame => frame.state.exitRequest),
    [0, 1]
  );
  assert.equal(result.state.exitRequest, 1);
  assert.equal(result.state.previousButtons, 2);
  assert.equal(result.frames.length, 2);
  assert.equal(fs.statSync(result.files['frame.rgba']).size, WIDTH * HEIGHT * 4);
});

test('repeat-run-proofs-local-hash-stability', {skip}, async t => {
  const first = await hello('repeat-1');
  const second = await hello('repeat-2');
  assert.deepEqual(second.device, first.device);
  assert.equal(second.sha256, first.sha256);
  const {state} = first;
  assert.equal(state.buttons, 0);
  assert.equal(state.connected, 1);
  assert.equal(state.previousButtons, 0);
  assert.equal(state.frames, 6);
  assert.ok(Math.abs(state.time - 0.1) < 1e-6);
  assert.ok(Math.abs(state.fade - 0.6) < 1e-6);
  assert.equal(state.exitRequest, 1);
  assert.equal(state.clockMs, 83);
  assert.equal(state.frameIndex, 5);
  assert.deepEqual(
    first.frames.map(frame => [frame.state.clockMs, frame.state.frameIndex, frame.state.frames]),
    [0, 1, 2, 3, 4, 5].map(n => [Math.floor((n * 1000) / 60), n, n + 1])
  );
  assert.deepEqual(
    first.frames.map(frame => frame.state.exitRequest),
    [0, 0, 1, 1, 1, 1]
  );
  assert.deepEqual(second.state, state);
  t.diagnostic(first.device.name + ' sha256 ' + first.sha256);
});
