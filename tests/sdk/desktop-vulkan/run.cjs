/**
 * Builds tools/moonlight/desktop-vulkan-run.c into a caller-selected build directory and runs a
 * desktop.vulkan program through it: writes the frame file, invokes the runner with one argv
 * entry per path (no shell), checks its outputs and writes run.json with the SHA-256 of
 * frame.rgba. Any compiler or runner failure throws with its exit code and stderr, and leaves
 * no run.json or frame.rgba behind.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {checkFrames, decodeState, encodeFrames} = require('./state.js');
const {STATE_BYTES} = require('../../../hbl-platform/sdk/host/state-layout.js');

const SOURCE = path.resolve(__dirname, '../../tools/moonlight/desktop-vulkan-run.c');
const RUNNER = 'desktop-vulkan-run';
const WIDTH = 1920;
const HEIGHT = 1080;
const NO_DEVICE = 2;
const OUTPUTS = ['run.json', 'frame.rgba', 'state.bin', 'states.bin', 'data.bin', 'frames.bin'];

/**
 * @typedef {(file: string, args: string[]) => {status: number | null, stdout: string,
 *   stderr: string, error?: Error}} Exec
 */

/** @type {Exec} */
const spawn = (file, args) =>
  spawnSync(file, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});

/**
 * @param {Exec} exec
 * @param {string} file
 * @param {string[]} args
 */
function invoke(exec, file, args) {
  const result = exec(file, args);
  if (result.error || result.status !== 0) {
    const error = /** @type {Error & {status?: number | null, stderr?: string}} */ (
      Error(
        path.basename(file) +
          ' failed (' +
          (result.error ? result.error.message : 'exit ' + result.status) +
          '): ' +
          (result.stderr || '').trim()
      )
    );
    error.status = result.status;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}

/**
 * @param {string} buildDir
 * @param {{exec?: Exec}} [options]
 * @returns {string} The runner binary.
 */
function buildRunner(buildDir, {exec = spawn} = {}) {
  fs.mkdirSync(buildDir, {recursive: true});
  const binary = path.join(buildDir, RUNNER);
  invoke(exec, 'cc', ['-O2', '-std=c11', '-Wall', SOURCE, '-lvulkan', '-o', binary]);
  return binary;
}

/**
 * Why the GPU cases cannot run here, or null: no compiler, no Vulkan loader or no device.
 * @param {string} buildDir
 * @returns {{reason: string | null, runner?: string, device?: object}}
 */
function gpuStatus(buildDir) {
  for (const tool of ['glslangValidator', 'spirv-val']) {
    const probe = spawnSync(tool, ['--version'], {encoding: 'utf8'});
    if (probe.error) return {reason: tool + ' not found'};
  }
  let runner;
  try {
    runner = buildRunner(buildDir);
  } catch (error) {
    return {reason: 'cannot build ' + RUNNER + ' (cc, Vulkan headers): ' + error.message};
  }
  const probe = spawn(runner, ['--probe']);
  if (probe.status !== 0)
    return {
      reason:
        probe.status === NO_DEVICE
          ? 'no Vulkan device: ' + probe.stderr.trim()
          : RUNNER + ' --probe failed: ' + probe.stderr.trim()
    };
  return {reason: null, runner, device: JSON.parse(probe.stdout).device};
}

/** @param {string} file */
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * @param {string} file
 * @param {number} bytes
 */
function expectSize(file, bytes) {
  const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
  if (size !== bytes)
    throw Error(RUNNER + ' wrote ' + size + ' bytes to ' + file + ', not ' + bytes);
}

/**
 * Runs a program for every frame of the script.
 * @param {object} options
 * @param {{vertex: string, fragment: string, compute: string}} options.shaders
 * @param {string} options.initialState
 * @param {string} options.data
 * @param {import('./state.js').FrameScript} options.script
 * @param {import('./state.js').Clock} options.clock
 * @param {string} options.buildDir Holds the runner binary.
 * @param {string} options.outputDir Receives every output file.
 * @param {string} [options.runner] An already built runner.
 * @param {object} [options.record] Package/backend fields copied into run.json.
 * @param {Exec} [options.exec]
 */
function run(options) {
  const {shaders, script, clock, outputDir, exec = spawn} = options;
  fs.mkdirSync(outputDir, {recursive: true});
  for (const name of OUTPUTS) fs.rmSync(path.join(outputDir, name), {force: true});
  const frames = encodeFrames(script, clock);
  const frameCount = checkFrames(frames);
  const framesFile = path.join(outputDir, 'frames.bin');
  fs.writeFileSync(framesFile, frames);
  const runner = options.runner ?? buildRunner(options.buildDir, {exec});
  const args = [
    shaders.vertex,
    shaders.fragment,
    shaders.compute,
    options.initialState,
    options.data,
    framesFile,
    outputDir
  ];
  let report;
  try {
    report = JSON.parse(invoke(exec, runner, args));
    if (!report.device || !Array.isArray(report.frames) || report.frames.length !== frameCount)
      throw Error(RUNNER + ' reported ' + report.frames?.length + ' frames, not ' + frameCount);
    const files = Object.fromEntries(
      ['frame.rgba', 'state.bin', 'states.bin', 'data.bin'].map(name => [
        name,
        path.join(outputDir, name)
      ])
    );
    expectSize(files['frame.rgba'], WIDTH * HEIGHT * 4);
    expectSize(files['state.bin'], STATE_BYTES);
    expectSize(files['states.bin'], frameCount * STATE_BYTES);
    expectSize(files['data.bin'], fs.statSync(options.data).size);
    const states = fs.readFileSync(files['states.bin']);
    const perFrame = script.inputs.map((input, frame) => ({
      frame,
      buttons: input.mask,
      connected: input.connected,
      ...report.frames[frame],
      state: decodeState(states.subarray(frame * STATE_BYTES, (frame + 1) * STATE_BYTES))
    }));
    const result = {
      ...options.record,
      device: report.device,
      width: report.width,
      height: report.height,
      clock: {...script.clock, provider: clock.mode},
      frameCount,
      input: script.inputs.map(({frame, connected, buttons}) => ({frame, connected, buttons})),
      frames: perFrame,
      state: decodeState(fs.readFileSync(files['state.bin'])),
      dataUnchanged: sha256(files['data.bin']) === sha256(options.data),
      sha256: sha256(files['frame.rgba'])
    };
    fs.writeFileSync(path.join(outputDir, 'run.json'), JSON.stringify(result, null, 2) + '\n');
    return {...result, files: {...files, 'run.json': path.join(outputDir, 'run.json')}};
  } catch (error) {
    for (const name of ['run.json', 'frame.rgba'])
      fs.rmSync(path.join(outputDir, name), {force: true});
    throw error;
  }
}

module.exports = {SOURCE, RUNNER, WIDTH, HEIGHT, buildRunner, gpuStatus, run};
