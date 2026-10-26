/**
 * Backend two of the HB package format: desktop.vulkan, an offscreen Vulkan runner. Its section
 * of `backends` names the three SPIR-V stages, the 1024-byte initial state and the data image,
 * all under backends/desktop.vulkan/. supports() checks that section and every file it names
 * before any Vulkan work; load() runs the package for a fixed frame script through run.cjs and
 * returns the run record. It presents offscreen only (no window, no swapchain) and provides no
 * audio. docs/hb-package.md in hbl-platform fixes the contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {STATE_BYTES} from '../../../hbl-platform/sdk/host/state-layout.js';
import {headers, compile} from '../../../hbl-platform/sdk/build.js';
import {MAX_DATA_BYTES, checkData, checkState, clockProvider, loadFrameScript} from './state.js';

const require = createRequire(import.meta.url);

const ID = 'desktop.vulkan';
const ABI = 1;
/** time 2 adds the host clock words at +48/+52 and serves every lower version. */
const SERVICES = Object.freeze({present: 1, input: 1, time: 2});
const SECTION_KEYS = ['abi', 'shaders', 'initialState', 'data'];
/** [entry stage, SPIR-V suffix, section stage] */
const STAGES = [
  ['logic', 'comp', 'compute'],
  ['draw', 'frag', 'fragment'],
  ['vertex', 'vert', 'vertex']
];
const SECTION_DIR = 'backends/' + ID + '/';
const SPIRV_MAGIC = 0x07230203;
const SPIRV_HEADER_BYTES = 20;
/** Also desktop-vulkan-run.c's cap; 4x backend one's 1 MiB shader limit. */
const MAX_SPIRV_BYTES = 4 * 1024 * 1024;
const FULL_SCREEN_VERTEX = path.join(
  import.meta.dirname,
  '../../../hbl-platform/sdk/include/fullscreen.vert'
);

/** @typedef {import('../../../hbl-platform/sdk/package/manifest.js').Package} Package */

/**
 * @typedef {object} Program Real paths of the files the section names.
 * @property {{vertex: string, fragment: string, compute: string}} shaders
 * @property {string} initialState
 * @property {string} data
 */

/**
 * @param {unknown} value
 * @param {string} message
 */
const check = (value, message) => {
  if (!value) throw Error(message);
};

/** @param {unknown} name */
const sectionPath = name =>
  typeof name === 'string' &&
  name.startsWith(SECTION_DIR) &&
  !name.includes('\\') &&
  !name.split('/').includes('..') &&
  !name.split('/').includes('') &&
  !name.split('/').includes('.');

/**
 * A section file: inside the package, regular and within its size bounds. Synchronous because
 * the loader calls supports() synchronously.
 * @param {string} root Real path of the package folder.
 * @param {unknown} name
 * @param {number} min
 * @param {number} max
 * @returns {string} The real path.
 */
function sectionFile(root, name, min, max) {
  check(sectionPath(name), 'Path must stay inside ' + SECTION_DIR + ': ' + name);
  const file = /** @type {string} */ (name);
  let real;
  try {
    real = fs.realpathSync(path.resolve(root, file));
  } catch {
    throw Error('Missing backend file: ' + file);
  }
  check(real.startsWith(root + path.sep), 'Path escapes its package: ' + file);
  const stat = fs.statSync(real);
  check(stat.isFile(), 'Not a regular file: ' + file);
  check(stat.size >= min && stat.size <= max, 'Invalid file size: ' + file);
  return real;
}

/**
 * @param {string} real
 * @param {string} name
 */
function checkSpirv(real, name) {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(real, 'r');
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  check(
    fs.statSync(real).size % 4 === 0 && head.readUInt32LE() === SPIRV_MAGIC,
    'Not SPIR-V: ' + name
  );
}

/**
 * Checks the section and resolves its files; throws the reason the backend cannot run it.
 * @param {Package} pkg
 * @returns {Program}
 */
function program(pkg) {
  const section = pkg.manifest.backends?.[ID];
  check(section && typeof section === 'object', 'Package has no ' + ID + ' section');
  check(section.abi === ABI, 'Unsupported ' + ID + ' abi ' + JSON.stringify(section.abi));
  for (const key of Object.keys(section))
    check(SECTION_KEYS.includes(key), 'Unknown ' + ID + ' field: ' + key);
  check(
    section.shaders && typeof section.shaders === 'object',
    'Package has no ' + ID + ' shaders'
  );
  const shaders = /** @type {Program['shaders']} */ ({});
  for (const [, , stage] of STAGES) {
    const name = section.shaders[stage];
    check(name !== undefined, 'Missing ' + ID + ' ' + stage + ' shader');
    shaders[stage] = sectionFile(pkg.root, name, SPIRV_HEADER_BYTES, MAX_SPIRV_BYTES);
    checkSpirv(shaders[stage], name);
  }
  check(
    Object.keys(section.shaders).every(stage => STAGES.some(([, , known]) => known === stage)),
    'Unknown ' + ID + ' shader stage'
  );
  const data = sectionFile(pkg.root, section.data, 4, MAX_DATA_BYTES);
  check(fs.statSync(data).size % 4 === 0, 'Data is not whole words: ' + section.data);
  return {
    shaders,
    initialState: sectionFile(pkg.root, section.initialState, STATE_BYTES, STATE_BYTES),
    data
  };
}

/** @type {import('../../../hbl-platform/sdk/package/loader.js').Backend<object>} */
const backend = {
  id: ID,
  abi: ABI,
  services: SERVICES,

  supports(pkg) {
    try {
      program(pkg);
      return null;
    } catch (error) {
      return error.message;
    }
  },

  /**
   * Runs the package offscreen for one frame script.
   * @param {Package} pkg
   * @param {{buildDir: string, outputDir: string, script: string | object, clock?: string,
   *   runner?: string, exec?: Function}} options
   */
  async load(pkg, options) {
    check(options?.buildDir && options?.outputDir, ID + ' needs buildDir and outputDir');
    const files = program(pkg);
    const state = await fs.promises.readFile(files.initialState);
    checkState(state);
    checkData(await fs.promises.readFile(files.data));
    const {run} = require('./run.cjs');
    return run({
      ...files,
      script: loadFrameScript(options.script),
      clock: clockProvider(options.clock),
      buildDir: options.buildDir,
      outputDir: options.outputDir,
      runner: options.runner,
      exec: options.exec,
      record: {
        package: {id: pkg.manifest.id, version: pkg.manifest.version, fingerprint: pkg.fingerprint},
        backend: ID,
        abi: ABI,
        services: SERVICES
      }
    });
  }
};

/**
 * Compiles the package's entry sources into backends/desktop.vulkan/app.<stage>.spv, with the
 * service-interface headers copied into src/ first. State and data are the package's own build
 * step; this only makes the shaders.
 * @param {Package} pkg
 * @returns {Promise<Record<string, string>>} Section stage to SPIR-V path.
 */
async function build(pkg) {
  check(pkg.manifest.entry, 'Package has no entry to build');
  const output = path.join(pkg.root, SECTION_DIR);
  await headers(path.join(pkg.root, 'src'));
  await fs.promises.mkdir(output, {recursive: true});
  /** @type {Record<string, string>} */
  const shaders = {};
  for (const [entry, suffix, stage] of STAGES) {
    const file = pkg.manifest.entry[entry];
    const target = path.join(output, 'app.' + suffix + '.spv');
    compile(file ? path.join(pkg.root, file) : FULL_SCREEN_VERTEX, target);
    shaders[stage] = SECTION_DIR + 'app.' + suffix + '.spv';
  }
  return shaders;
}

export {ID, ABI, SERVICES, SECTION_DIR, MAX_SPIRV_BYTES, backend, program, build};
