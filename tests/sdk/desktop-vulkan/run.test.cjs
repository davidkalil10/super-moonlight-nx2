// run.cjs: argv handling, run.json and hash, failing closed, and same-device repeat hashes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {gpuStatus, run, WIDTH, HEIGHT} = require('./run.cjs');
const {checkFrames, clockProvider, initialState, loadFrameScript} = require('./state.js');
const {SCRIPT, runHelloWorld} = require('./hello-world.cjs');
const {builds} = require('../../../hbl-platform/scripts/toolchain.js');

fs.mkdirSync(builds('desktop-vulkan'), {recursive: true});
const scratch = fs.mkdtempSync(path.join(builds('desktop-vulkan'), 'run-'));
test.after(() => fs.rmSync(scratch, {recursive: true, force: true}));

const DEVICE = {name: 'Fake GPU', vendorId: 1, deviceId: 2, driverVersion: 3, apiVersion: 4};

/** An exec that records calls and acts as cc plus a runner writing the outputs it is told to. */
function fake({failCompiler = false, failRunner = false} = {}) {
  const calls = [];
  const exec = (file, args) => {
    calls.push({file, args});
    if (file === 'cc')
      return failCompiler
        ? {status: 1, stdout: '', stderr: 'cc: no vulkan'}
        : {status: 0, stdout: '', stderr: ''};
    if (failRunner) return {status: 1, stdout: '', stderr: 'desktop-vulkan-run: failed at 1: boom'};
    const [, , , state, data, frames, outputDir] = args;
    const count = checkFrames(fs.readFileSync(frames));
    fs.writeFileSync(path.join(outputDir, 'frame.rgba'), Buffer.alloc(WIDTH * HEIGHT * 4, 7));
    fs.writeFileSync(path.join(outputDir, 'state.bin'), fs.readFileSync(state));
    fs.writeFileSync(
      path.join(outputDir, 'states.bin'),
      Buffer.concat(Array(count).fill(fs.readFileSync(state)))
    );
    fs.copyFileSync(data, path.join(outputDir, 'data.bin'));
    const timing = Array(count).fill({computeMs: 0.01, drawMs: 0.2});
    return {
      status: 0,
      stdout: JSON.stringify({device: DEVICE, width: WIDTH, height: HEIGHT, frames: timing}),
      stderr: ''
    };
  };
  return {calls, exec};
}

/** Program files under a directory whose name has spaces. */
function program(name) {
  const dir = path.join(scratch, name, 'pkg with spaces');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'state.bin'), initialState());
  fs.writeFileSync(path.join(dir, 'text.bin'), Buffer.alloc(64, 1));
  return {
    shaders: {
      vertex: path.join(dir, 'a.vert.spv'),
      fragment: path.join(dir, 'a.frag.spv'),
      compute: path.join(dir, 'a.comp.spv')
    },
    initialState: path.join(dir, 'state.bin'),
    data: path.join(dir, 'text.bin'),
    script: loadFrameScript(SCRIPT),
    clock: clockProvider(),
    buildDir: path.join(scratch, name, 'build dir'),
    outputDir: path.join(scratch, name, 'output dir'),
    record: {
      package: {id: 'hello-world'},
      backend: 'desktop.vulkan',
      abi: 1,
      services: {present: 1, input: 1, time: 2}
    }
  };
}

test('builds-with-explicit-output-directory', () => {
  const {calls, exec} = fake();
  const options = program('argv');
  const result = run({...options, exec});
  const [cc, runner] = calls;
  assert.equal(cc.file, 'cc');
  const binary = cc.args[cc.args.indexOf('-o') + 1];
  assert.equal(binary, path.join(options.buildDir, 'desktop-vulkan-run'));
  assert.equal(runner.file, binary);
  assert.deepEqual(runner.args, [
    options.shaders.vertex,
    options.shaders.fragment,
    options.shaders.compute,
    options.initialState,
    options.data,
    path.join(options.outputDir, 'frames.bin'),
    options.outputDir
  ]);
  for (const file of Object.values(result.files))
    assert.equal(path.dirname(file), options.outputDir);
});

test('writes-run-json-and-frame-hash', () => {
  const options = program('record');
  const result = run({...options, exec: fake().exec});
  const record = JSON.parse(fs.readFileSync(path.join(options.outputDir, 'run.json'), 'utf8'));
  const hash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(result.files['frame.rgba']))
    .digest('hex');
  assert.equal(record.sha256, hash);
  assert.equal(result.sha256, hash);
  assert.deepEqual(record.package, {id: 'hello-world'});
  assert.equal(record.backend, 'desktop.vulkan');
  assert.equal(record.abi, 1);
  assert.deepEqual(record.services, {present: 1, input: 1, time: 2});
  assert.deepEqual(record.device, DEVICE);
  assert.equal(record.frameCount, 6);
  assert.equal(record.frames.length, 6);
  assert.deepEqual(Object.keys(record.frames[0]).sort(), [
    'buttons',
    'computeMs',
    'connected',
    'drawMs',
    'frame',
    'state'
  ]);
  assert.deepEqual(record.input[2], {frame: 2, connected: true, buttons: ['B']});
  assert.equal(record.clock.provider, 'host-fixed-step');
  assert.equal(record.dataUnchanged, true);
  assert.equal(result.state.fade, 1);
});

test('fails-closed-on-runner-error', () => {
  const options = program('fail');
  fs.mkdirSync(options.outputDir, {recursive: true});
  for (const name of ['run.json', 'frame.rgba'])
    fs.writeFileSync(path.join(options.outputDir, name), 'stale');
  assert.throws(
    () => run({...options, exec: fake({failCompiler: true}).exec}),
    error => {
      assert.match(error.message, /cc failed \(exit 1\): cc: no vulkan/);
      assert.equal(error.status, 1);
      return true;
    }
  );
  assert.throws(
    () => run({...options, exec: fake({failRunner: true}).exec}),
    /desktop-vulkan-run failed \(exit 1\): .*boom/
  );
  for (const name of ['run.json', 'frame.rgba'])
    assert.ok(!fs.existsSync(path.join(options.outputDir, name)), name);
});

const gpu = gpuStatus(path.join(scratch, 'runner'));

test('same-device-repeat-hash-is-stable', {skip: gpu.reason ?? false}, async t => {
  const buildDir = path.join(scratch, 'repeat');
  const runs = [];
  for (const name of ['first', 'second'])
    runs.push(
      await runHelloWorld({buildDir, outputDir: path.join(buildDir, name), runner: gpu.runner})
    );
  assert.deepEqual(runs[1].device, runs[0].device);
  assert.equal(runs[1].sha256, runs[0].sha256);
  assert.deepEqual(runs[1].state, runs[0].state);
  t.diagnostic(
    runs[0].device.name + ' driver ' + runs[0].device.driverVersion + ' sha256 ' + runs[0].sha256
  );
});
