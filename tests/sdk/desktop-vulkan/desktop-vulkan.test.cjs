// desktop.vulkan, HB package backend two.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const crypto = require('node:crypto');
const {backend, ID, SECTION_DIR} = require('./backend.js');
const {preparePackage, runHelloWorld, SCRIPT} = require('./hello-world.cjs');
const {readPackage} = require('../../../../hbl-platform/sdk/package/manifest.js');
const {loadApp, select} = require('../../../../hbl-platform/sdk/package/loader.js');
const {builds} = require('../../../../hbl-platform/sdk/build.js');
const {gpuStatus, WIDTH, HEIGHT, run} = require('./run.cjs');
const {
  checkFrames,
  clockProvider,
  initialState,
  loadFrameScript,
  CLOCK_MS,
  FRAME_INDEX,
  MAX_DATA_BYTES,
  checkState,
  checkData,
  buttonMask,
  parseFrameScript,
  applyFrameInput,
  encodeFrames
} = require('./state.js');
const {STATE, STATE_BYTES, DATA_OFFSET} = require('../../../../hbl-platform/sdk/host/layout.js');

// desktop.vulkan backend selection and section checks, all before any Vulkan work.
fs.mkdirSync(builds('desktop-vulkan'), {recursive: true});
const backendScratch = fs.mkdtempSync(path.join(builds('desktop-vulkan'), 'backend-'));
test.after(() => fs.rmSync(backendScratch, {recursive: true, force: true}));

let count = 0;

/**
 * A fresh hello-world package with the desktop.vulkan section, changed by `change`.
 * @param {(manifest: any, root: string) => void} [change]
 */
async function hello(change = () => {}) {
  const root = await preparePackage(path.join(backendScratch, String(count++)), {compile: false});
  const file = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(manifest, root);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  return root;
}

/** @param {(manifest: any, root: string) => void} change */
const reason = async change => backend.supports(await readPackage(await hello(change)));

/** A backend whose load must never run. */
const guarded = {
  ...backend,
  load: async () => assert.fail('runner started')
};

test('selects-desktop-vulkan-for-hello-world', async () => {
  const pkg = await readPackage(await hello());
  assert.deepEqual(Object.keys(pkg.manifest.services), ['present', 'input', 'time']);
  const selected = select(pkg, [backend]);
  assert.equal(selected.backend.id, ID);
  assert.deepEqual(selected.absentOptional, []);
  assert.equal(backend.supports(pkg), null);
  assert.equal(backend.services.audio, undefined);
});

test('refuses-required-audio', async () => {
  const root = await hello(manifest => (manifest.services.audio = '1'));
  const pkg = await readPackage(root);
  assert.throws(() => select(pkg, [guarded]), /lacks audio 1 \(not provided\)/);
  await assert.rejects(loadApp(root, [guarded], {}), /desktop\.vulkan lacks audio/);
});

test('refuses-unsupported-backend-abi', async () => {
  assert.equal(
    await reason(manifest => (manifest.backends[ID].abi = 2)),
    'Unsupported desktop.vulkan abi 2'
  );
  assert.equal(
    await reason(manifest => delete manifest.backends[ID].abi),
    'Unsupported desktop.vulkan abi undefined'
  );
});

test('refuses-missing-required-shader-stage', async () => {
  for (const stage of ['compute', 'fragment', 'vertex'])
    assert.equal(
      await reason(manifest => delete manifest.backends[ID].shaders[stage]),
      'Missing desktop.vulkan ' + stage + ' shader'
    );
  assert.equal(
    await reason(manifest => delete manifest.backends[ID].shaders),
    'Package has no desktop.vulkan shaders'
  );
});

test('refuses-missing-or-escaping-backend-file', async () => {
  assert.equal(
    await reason(manifest => (manifest.backends[ID].data = SECTION_DIR + 'absent.bin')),
    'Missing backend file: ' + SECTION_DIR + 'absent.bin'
  );
  assert.equal(
    await reason(
      manifest => (manifest.backends[ID].initialState = SECTION_DIR + '../../state.bin')
    ),
    'Path must stay inside ' + SECTION_DIR + ': ' + SECTION_DIR + '../../state.bin'
  );
  assert.equal(
    await reason(manifest => (manifest.backends[ID].shaders.compute = 'src/app.comp')),
    'Path must stay inside ' + SECTION_DIR + ': src/app.comp'
  );
  const outside = path.join(backendScratch, 'outside.spv');
  fs.copyFileSync(path.join(await hello(), SECTION_DIR, 'app.comp.spv'), outside);
  const root = await hello((manifest, root) => {
    fs.symlinkSync(outside, path.join(root, SECTION_DIR, 'escape.spv'));
    manifest.backends[ID].shaders.compute = SECTION_DIR + 'escape.spv';
  });
  assert.equal(
    backend.supports(await readPackage(root)),
    'Path escapes its package: ' + SECTION_DIR + 'escape.spv'
  );
  await assert.rejects(loadApp(root, [guarded], {}), /Path escapes its package/);
});

test('refuses-section-file-linked-elsewhere-in-the-package', async () => {
  const root = await hello((manifest, root) => {
    fs.symlinkSync(
      '../hblauncher.gpu-app/app.comp.spv',
      path.join(root, SECTION_DIR, 'linked.spv')
    );
    manifest.backends[ID].shaders.compute = SECTION_DIR + 'linked.spv';
  });
  assert.equal(
    backend.supports(await readPackage(root)),
    'Path leaves ' + SECTION_DIR + ': ' + SECTION_DIR + 'linked.spv'
  );
});

test('checks-state-and-data-size', async () => {
  assert.equal(
    await reason((manifest, root) =>
      fs.writeFileSync(path.join(root, SECTION_DIR, 'state.bin'), Buffer.alloc(1000))
    ),
    'Invalid file size: ' + SECTION_DIR + 'state.bin'
  );
  assert.equal(
    await reason(manifest => delete manifest.backends[ID].data),
    'Path must stay inside ' + SECTION_DIR + ': undefined'
  );
  assert.equal(
    await reason((manifest, root) =>
      fs.writeFileSync(path.join(root, SECTION_DIR, 'text.bin'), Buffer.alloc(7 * 1024 * 1024 + 4))
    ),
    'Invalid file size: ' + SECTION_DIR + 'text.bin'
  );
  assert.equal(
    await reason((manifest, root) =>
      fs.writeFileSync(path.join(root, SECTION_DIR, 'text.bin'), '')
    ),
    'Invalid file size: ' + SECTION_DIR + 'text.bin'
  );
  assert.equal(
    await reason((manifest, root) =>
      fs.writeFileSync(path.join(root, SECTION_DIR, 'text.bin'), Buffer.alloc(6))
    ),
    'Data is not whole words: ' + SECTION_DIR + 'text.bin'
  );
  assert.equal(
    await reason(manifest => (manifest.backends[ID].memory = SECTION_DIR + 'memory.bin')),
    'Unknown desktop.vulkan field: memory'
  );
});

// HBLauncher hello-world end to end on desktop.vulkan: first frame, exit on B, repeat hash.
const helloScratch = fs.mkdtempSync(path.join(builds('desktop-vulkan'), 'hello-'));
test.after(() => fs.rmSync(helloScratch, {recursive: true, force: true}));
const gpu = gpuStatus(path.join(helloScratch, 'runner'));
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
const runHello = (name, frames) =>
  runHelloWorld({
    buildDir: path.join(helloScratch, name),
    outputDir: path.join(helloScratch, name, 'output'),
    script: frames,
    runner: gpu.runner
  });

test('hello-world-idle-first-frame', {skip}, async t => {
  const result = await runHello('idle', script([[]]));
  assert.equal(result.selected, 'desktop.vulkan');
  assert.ok(fs.existsSync(path.join(helloScratch, 'idle/package/hello-world/src/time.glsl')));
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
  const result = await runHello('back', script([[], ['B']]));
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
  const first = await runHello('repeat-1');
  const second = await runHello('repeat-2');
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

// The README's smoke command, run as written against the hello-world fixture.
const README = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
const ROOT = path.resolve(__dirname, '../..');

const scratch = fs.mkdtempSync(path.join(builds('desktop-vulkan'), 'readme-'));
test.after(() => fs.rmSync(scratch, {recursive: true, force: true}));
const readmeGpu = gpuStatus(path.join(scratch, 'runner'));

test('documented-smoke-command-is-reproducible', {skip: readmeGpu.reason ?? false}, () => {
  assert.match(README, /Offscreen only/);
  assert.match(README, /No audio/);
  assert.match(README, /no Moonlight stream/);
  const line = README.split('\n').find(text => text.startsWith('node sdk/desktop-vulkan/'));
  assert.ok(line, 'README has no smoke command');
  const [command, ...args] = line.split(' ').map(word => (word === 'BUILD_DIR' ? scratch : word));
  assert.equal(command, 'node');
  const stdout = execFileSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const report = JSON.parse(stdout.slice(stdout.search(/^\{/m)));
  assert.equal(report.selected, 'desktop.vulkan');
  assert.match(report.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.state.exitRequest, 1);
  assert.equal(report.state.frames, 6);
  const output = path.join(scratch, 'output');
  for (const name of [
    'frame.rgba',
    'state.bin',
    'states.bin',
    'data.bin',
    'frames.bin',
    'run.json'
  ]) {
    assert.ok(README.includes('`' + name + '`'), name + ' undocumented');
    assert.ok(fs.statSync(path.join(output, name)).size > 0, name);
  }
});

// run.cjs: argv handling, run.json and hash, failing closed, and same-device repeat hashes.
const runScratch = fs.mkdtempSync(path.join(builds('desktop-vulkan'), 'run-'));
test.after(() => fs.rmSync(runScratch, {recursive: true, force: true}));

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
  const dir = path.join(runScratch, name, 'pkg with spaces');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'state.bin'), initialState());
  fs.writeFileSync(path.join(dir, 'text.bin'), Buffer.alloc(64, 1));
  for (const stage of ['vert', 'frag', 'comp'])
    fs.writeFileSync(path.join(dir, 'a.' + stage + '.spv'), stage);
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
    buildDir: path.join(runScratch, name, 'build dir'),
    outputDir: path.join(runScratch, name, 'output dir'),
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
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.deepEqual(record.program, {
    vertex: digest(options.shaders.vertex),
    fragment: digest(options.shaders.fragment),
    compute: digest(options.shaders.compute),
    initialState: digest(options.initialState),
    data: digest(options.data)
  });
  assert.notEqual(record.program.vertex, record.program.compute);
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

// desktop.vulkan control block: initial state, scripted input words, clock ownership and bounds.
/** @param {[boolean, string[]][]} frames */
const stateScript = frames =>
  parseFrameScript({
    format: 'hb-desktop-frame-script',
    version: 1,
    frameCount: frames.length,
    clock: {mode: 'fixed-step', originMs: 0, rateHz: 60},
    inputs: frames.map(([connected, buttons], frame) => ({frame, connected, buttons}))
  });

/** @param {Buffer} encoded */
function offsetsPerFrame(encoded) {
  const frames = [];
  for (let at = 0; at < encoded.length; ) {
    const count = encoded.readUInt32LE(at);
    const writes = [];
    for (let i = 0; i < count; i++) writes.push(encoded.readUInt32LE(at + 4 + i * 8));
    frames.push(writes);
    at += 4 + count * 8;
  }
  return frames;
}

test('initializes-hello-world-state', () => {
  const state = initialState();
  assert.equal(state.length, STATE_BYTES);
  assert.equal(state.length, DATA_OFFSET);
  assert.equal(state.readFloatLE(STATE.fade), 1);
  const rest = Buffer.from(state);
  rest.writeFloatLE(0, STATE.fade);
  assert.ok(rest.every(byte => byte === 0));
});

test('writes-scripted-input-words', () => {
  const frames = stateScript([
    [true, []],
    [true, ['B']]
  ]);
  assert.equal(buttonMask(['B', 'MINUS']), 2 | 2048);
  assert.throws(() => buttonMask(['TURBO']), /Unknown button: TURBO/);
  const state = initialState();
  state.writeUInt32LE(0xabcd, STATE.previousButtons);
  state.writeUInt32LE(7, STATE.frames);
  const before = Buffer.from(state);
  applyFrameInput(state, frames.inputs[1]);
  assert.equal(state.readUInt32LE(STATE.buttons), 2);
  assert.equal(state.readUInt32LE(STATE.connected), 1);
  for (let offset = 0; offset < STATE_BYTES; offset += 4)
    if (offset !== STATE.buttons && offset !== STATE.connected)
      assert.equal(state.readUInt32LE(offset), before.readUInt32LE(offset), 'offset ' + offset);
  applyFrameInput(state, {...frames.inputs[0], connected: false});
  assert.equal(state.readUInt32LE(STATE.connected), 0);
  for (const writes of offsetsPerFrame(encodeFrames(frames)))
    assert.deepEqual(writes, [STATE.buttons, STATE.connected, CLOCK_MS, FRAME_INDEX]);
});

test('keeps-clock-and-frame-app-owned-for-current-template', async t => {
  const fixed = stateScript(Array.from({length: 120}, () => [true, []]));
  assert.equal(clockProvider().mode, 'host-fixed-step');
  for (const name of ['host', 'none'])
    for (const writes of offsetsPerFrame(encodeFrames(fixed, clockProvider(name)))) {
      assert.ok(!writes.includes(STATE.time), name + ' writes +64');
      assert.ok(!writes.includes(STATE.frames), name + ' writes +88');
      assert.ok(!writes.includes(STATE.previousButtons), name + ' writes +84');
    }
  assert.deepEqual(clockProvider().writes(fixed, 0), [
    [CLOCK_MS, 0],
    [FRAME_INDEX, 0]
  ]);
  assert.deepEqual(clockProvider().writes(fixed, 7), [
    [CLOCK_MS, 116],
    [FRAME_INDEX, 7]
  ]);
  assert.deepEqual(clockProvider('none').writes(fixed, 7), []);

  fs.mkdirSync(builds('desktop-vulkan'), {recursive: true});
  const root = fs.mkdtempSync(path.join(builds('desktop-vulkan'), 'state-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const gpu = gpuStatus(path.join(root, 'runner'));
  if (gpu.reason) return t.diagnostic('GPU half not run: ' + gpu.reason);
  const {program} = require('./backend.js');
  const {readPackage} = require('../../../../hbl-platform/sdk/package/manifest.js');
  const files = program(await readPackage(await preparePackage(root)));
  const seeded = initialState();
  seeded.writeFloatLE(5, STATE.time);
  seeded.writeUInt32LE(100, STATE.frames);
  files.initialState = path.join(root, 'seeded.bin');
  fs.writeFileSync(files.initialState, seeded);
  const result = run({
    ...files,
    script: stateScript([[true, []]]),
    clock: clockProvider(),
    buildDir: root,
    outputDir: path.join(root, 'output'),
    runner: gpu.runner
  });
  assert.equal(result.state.time, Math.fround(5 + Math.fround(1 / 60)));
  assert.equal(result.state.frames, 101);
  assert.equal(result.state.previousButtons, 0);
  assert.ok(Math.abs(result.state.fade - 14 / 15) < 1e-6);
  assert.equal(result.state.exitRequest, 0);
  assert.equal(result.state.clockMs, 0);
  assert.equal(result.state.frameIndex, 0);
});

test('rejects-short-input-state-and-atlas-buffers', () => {
  assert.throws(() => checkState(Buffer.alloc(STATE_BYTES - 1)), /exactly 1024 bytes/);
  assert.throws(() => checkState(Buffer.alloc(STATE_BYTES + 4)), /exactly 1024 bytes/);
  const frames = stateScript([[true, ['A']]]);
  assert.throws(() => applyFrameInput(Buffer.alloc(16), frames.inputs[0]), /exactly 1024 bytes/);
  const encoded = encodeFrames(frames);
  assert.equal(checkFrames(encoded), 1);
  assert.throws(
    () => checkFrames(encoded.subarray(0, encoded.length - 4)),
    /Truncated input record/
  );
  assert.throws(() => checkFrames(encoded.subarray(0, encoded.length - 1)), /Truncated frame file/);
  const outside = Buffer.from(encoded);
  outside.writeUInt32LE(STATE_BYTES, 4);
  assert.throws(() => checkFrames(outside), /outside the control block/);
  assert.throws(() => checkFrames(Buffer.alloc(0)), /no frames/);
  assert.throws(() => checkData(Buffer.alloc(0)), /Data must be/);
  assert.throws(() => checkData(Buffer.alloc(6)), /Data must be/);
  assert.throws(() => checkData(Buffer.alloc(MAX_DATA_BYTES + 4)), /Data must be/);
  checkData(Buffer.alloc(8));
  assert.throws(
    () =>
      parseFrameScript({
        format: 'hb-desktop-frame-script',
        version: 1,
        frameCount: 2,
        clock: {mode: 'fixed-step', originMs: 0, rateHz: 60},
        inputs: [{frame: 0, connected: true, buttons: []}]
      }),
    /one input per frame/
  );
  assert.throws(
    () =>
      parseFrameScript({
        format: 'hb-desktop-frame-script',
        version: 1,
        frameCount: 1,
        clock: {mode: 'fixed-step', originMs: 0, rateHz: 60},
        inputs: [{frame: 0, connected: true}]
      }),
    {message: 'Frame 0 buttons must be a list'}
  );
  const clocked = (originMs, rateHz, frameCount = 2) => () =>
    parseFrameScript({
      format: 'hb-desktop-frame-script',
      version: 1,
      frameCount,
      clock: {mode: 'fixed-step', originMs, rateHz},
      inputs: Array.from({length: frameCount}, (_, frame) => ({
        frame,
        connected: true,
        buttons: []
      }))
    });
  assert.throws(clocked(-1, 60), /Clock must stay within 0 and 2\^32 ms/);
  assert.throws(clocked(2 ** 32 - 10, 60), /Clock must stay within/);
  assert.throws(clocked(0, 1e-7), /Clock must stay within/);
  clocked(2 ** 32 - 1000, 60)();
});
