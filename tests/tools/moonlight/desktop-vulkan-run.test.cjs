// desktop-vulkan-run.c on a real Vulkan device: one frame, state persistence, timings, failures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {gpuStatus, run, WIDTH, HEIGHT} = require('../../sdk/desktop-vulkan/run.cjs');
const {clockProvider, parseFrameScript} = require('../../sdk/desktop-vulkan/state.js');
const {program} = require('../../sdk/desktop-vulkan/backend.js');
const {preparePackage} = require('../../sdk/desktop-vulkan/hello-world.cjs');
const {readPackage} = require('../../../hbl-platform/sdk/package/manifest.js');
const {builds} = require('../../../hbl-platform/scripts/toolchain.js');

fs.mkdirSync(builds('desktop-vulkan'), {recursive: true});
const scratch = fs.mkdtempSync(path.join(builds('desktop-vulkan'), 'runner-'));
test.after(() => fs.rmSync(scratch, {recursive: true, force: true}));
const gpu = gpuStatus(path.join(scratch, 'runner'));
const skip = gpu.reason ?? false;

/** @param {[boolean, string[]][]} frames */
const script = frames =>
  parseFrameScript({
    format: 'hb-desktop-frame-script',
    version: 1,
    frameCount: frames.length,
    clock: {mode: 'fixed-step', originMs: 0, rateHz: 60},
    inputs: frames.map(([connected, buttons], frame) => ({frame, connected, buttons}))
  });

let files;
/** The compiled hello-world program, built once. */
async function hello() {
  files ??= program(await readPackage(await preparePackage(path.join(scratch, 'package'))));
  return files;
}

/**
 * @param {string} name
 * @param {[boolean, string[]][]} frames
 */
async function frames(name, frames) {
  return run({
    ...(await hello()),
    script: script(frames),
    clock: clockProvider(),
    buildDir: scratch,
    outputDir: path.join(scratch, name),
    runner: gpu.runner
  });
}

test('runs-compute-draw-readback-frame', {skip}, async () => {
  const result = await frames('one', [[true, []]]);
  const rgba = fs.readFileSync(result.files['frame.rgba']);
  assert.equal(rgba.length, WIDTH * HEIGHT * 4);
  assert.equal(result.width, WIDTH);
  assert.equal(result.height, HEIGHT);
  assert.ok(
    rgba.some((byte, index) => index % 4 !== 3 && byte !== 0),
    'frame is all black'
  );
  assert.equal(fs.statSync(result.files['state.bin']).size, 1024);
  assert.equal(result.state.frames, 1);
});

test('persists-state-and-data-across-frames', {skip}, async () => {
  const result = await frames('two', [
    [true, []],
    [true, ['A']]
  ]);
  const [first, second] = result.frames.map(frame => frame.state);
  assert.equal(first.frames, 1);
  assert.equal(second.frames, 2);
  assert.equal(first.previousButtons, 0);
  assert.equal(second.previousButtons, 1);
  assert.equal(second.time, Math.fround(Math.fround(1 / 60) + Math.fround(1 / 60)));
  assert.ok(second.fade < first.fade);
  assert.equal(second.exitRequest, 0);
  assert.equal(result.dataUnchanged, true);
});

test('reports-device-and-per-frame-gpu-times', {skip}, async t => {
  const result = await frames('three', [
    [true, []],
    [true, []],
    [true, []]
  ]);
  assert.equal(typeof result.device.name, 'string');
  assert.ok(result.device.name.length > 0);
  assert.equal(result.frames.length, 3);
  for (const frame of result.frames) {
    assert.ok(Number.isFinite(frame.computeMs) && frame.computeMs >= 0);
    assert.ok(Number.isFinite(frame.drawMs) && frame.drawMs >= 0);
  }
  t.diagnostic(
    result.device.name + ': ' + JSON.stringify(result.frames.map(f => [f.computeMs, f.drawMs]))
  );
});

test('rejects-invalid-stage-or-output-buffer', {skip}, async () => {
  const {shaders, initialState, data} = await hello();
  const ok = await frames('ok', [[true, []]]);
  const framesFile = path.join(path.dirname(ok.files['frame.rgba']), 'frames.bin');
  const bad = path.join(scratch, 'bad.spv');
  fs.writeFileSync(bad, Buffer.alloc(64, 0x5a));
  const output = path.join(scratch, 'bad-stage');
  fs.mkdirSync(output);
  const invalid = spawnSync(
    gpu.runner,
    [shaders.vertex, shaders.fragment, bad, initialState, data, framesFile, output],
    {encoding: 'utf8'}
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /not SPIR-V/);
  assert.equal(invalid.stdout, '');
  assert.deepEqual(fs.readdirSync(output), []);
  const missing = path.join(scratch, 'no such dir');
  const unwritable = spawnSync(
    gpu.runner,
    [shaders.vertex, shaders.fragment, shaders.compute, initialState, data, framesFile, missing],
    {encoding: 'utf8'}
  );
  assert.equal(unwritable.status, 1);
  assert.match(unwritable.stderr, /cannot write/);
  assert.equal(unwritable.stdout, '');
  const sneaky = path.join(scratch, 'sneaky');
  fs.mkdirSync(sneaky);
  await assert.rejects(
    async () =>
      run({
        ...(await hello()),
        shaders: {...shaders, compute: bad},
        script: script([[true, []]]),
        clock: clockProvider(),
        buildDir: scratch,
        outputDir: sneaky,
        runner: gpu.runner
      }),
    /desktop-vulkan-run failed \(exit 1\)/
  );
  assert.ok(!fs.existsSync(path.join(sneaky, 'run.json')));
});
