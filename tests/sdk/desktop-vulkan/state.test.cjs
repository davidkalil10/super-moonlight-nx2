// desktop.vulkan control block: initial state, scripted input words, clock ownership and bounds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CLOCK_MS,
  FRAME_INDEX,
  MAX_DATA_BYTES,
  initialState,
  checkState,
  checkData,
  buttonMask,
  parseFrameScript,
  applyFrameInput,
  clockProvider,
  encodeFrames,
  checkFrames
} = require('./state.js');
const {STATE, STATE_BYTES, DATA_OFFSET} = require('../../../hbl-platform/sdk/host/state-layout.js');
const {builds} = require('../../../hbl-platform/scripts/toolchain.js');
const {gpuStatus, run} = require('./run.cjs');
const {preparePackage} = require('./hello-world.cjs');

/** @param {[boolean, string[]][]} frames */
const script = frames =>
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
  const frames = script([
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
  const fixed = script(Array.from({length: 120}, () => [true, []]));
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
  const {readPackage} = require('../../../hbl-platform/sdk/package/manifest.js');
  const files = program(await readPackage(await preparePackage(root)));
  const seeded = initialState();
  seeded.writeFloatLE(5, STATE.time);
  seeded.writeUInt32LE(100, STATE.frames);
  files.initialState = path.join(root, 'seeded.bin');
  fs.writeFileSync(files.initialState, seeded);
  const result = run({
    ...files,
    script: script([[true, []]]),
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
  const frames = script([[true, ['A']]]);
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
