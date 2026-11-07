// Console startup's graphics: compat table, display, pipelines and storage, with every object
// kept in the console's graphics ledger so a later attach in the same process can reuse them.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {resolveCompatibility, functionResolver} from '../civ7/modules.js';
import {createDisplay, displaySize, ledgerDestroy, DEFAULT_SIZE} from '../civ7/display.js';
import {TARGET} from '../../renderer/civ7/layout.js';
import {createRendererPipelines} from '../civ7/renderer-pipelines.js';
import {loadRenderer} from '../../renderer/civ7/bundle.js';
import {fillConsoleStorage} from './asset-upload.js';

/** @import {Civ7Rpc} from '../civ7/transport.js' */
/** @import {Civ7Reply} from '../civ7/protocol.js' */
/** @import {CompatTable} from '../civ7/modules.js' */
/** @import {DisplayObject, DisplayResult} from '../civ7/display.js' */
/** @import {Created} from '../civ7/pipelines.js' */
/** @import {PipelineMenu, PipelineGpu} from '../civ7/renderer-pipelines.js' */

const RECORD_BATCH = 64;
const hex = (/** @type {number | bigint | string} */ value) => '0x' + BigInt(value).toString(16);
const sha256 = (/** @type {Buffer} */ bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * @typedef {object} ConsoleStartupOptions
 * @property {Civ7Rpc} rpc Allocations made here must stay out of resources.js, which is why
 *   serve.js clears rpc.resources while preparing.
 * @property {string} directory
 * @property {string} compatCache
 * @property {string} [inspector]
 * @property {CompatTable} [table] The compat table, for tests.
 * @property {boolean} [destroyDisplay] Allows tearing down a display stage the ledger cannot
 *   reuse; off by default, since destroying a swapchain once crashed the console.
 * @property {{width: number, height: number}} [layerSize] The size a new display opens at; a
 *   retained one keeps its own (civ7/README.md, "Layer size").
 * @property {(event: object) => void} [log]
 * @property {(name: string) => void} [mark] startup-timing.js marks
 */

/**
 * A ledger object to record, with its destroy call by function name.
 * @typedef {{kind: string, name: string, handle: string, destroy: DisplayObject['destroy']}} LedgerObject
 */

/** @typedef {(command: string, body?: object) => Promise<Civ7Reply>} Ledger */

/**
 * `graphics-status`, checked; `display` and `app` are what this module committed earlier.
 * @typedef {{reuse: 'all' | 'display' | 'none', reapApp: boolean, reapDisplay: boolean,
 *   display?: DisplayResult | null, app?: {menu: PipelineMenu, gpu: PipelineGpu} | null}} LedgerStatus
 */

/**
 * @param {Civ7Reply} reply
 * @returns {LedgerStatus}
 */
function ledgerStatus(reply) {
  const reuseOk = reply.reuse === 'all' || reply.reuse === 'display' || reply.reuse === 'none';
  const reapOk = typeof reply.reapApp === 'boolean' && typeof reply.reapDisplay === 'boolean';
  if (!reuseOk || !reapOk) throw Error('Invalid graphics ledger status');
  return /** @type {LedgerStatus} */ (/** @type {unknown} */ (reply));
}

/**
 * Tells the shaders the layer's size (layout.js TARGET); storage persists, so this runs on reuse too.
 * @param {Pick<Civ7Rpc, 'write'>} rpc
 * @param {PipelineGpu} gpu
 * @param {{width: number, height: number}} layer
 */
async function writeTarget(rpc, gpu, layer) {
  const words = Buffer.alloc(8);
  words.writeUInt32LE(layer.width, 0);
  words.writeUInt32LE(layer.height, 4);
  if (TARGET.height !== TARGET.width + 4) throw Error('Target words are not adjacent');
  await rpc.write(gpu.privateStorage.mapped + TARGET.width, words);
}

/**
 * The retained display's size against the one this startup would open; the retained one wins.
 * @param {DisplayResult} display
 * @param {{width: number, height: number}} wanted
 * @param {(event: object) => void} log
 */
function keptLayer(display, wanted, log) {
  const layer = displaySize(display);
  const same = layer.width === wanted.width && layer.height === wanted.height;
  if (!same) log({event: 'layer-retained', size: layer, wanted});
  return layer;
}

/**
 * @param {ConsoleStartupOptions} options
 * @returns {Promise<{menu: PipelineMenu, gpu: PipelineGpu, reused: 'all' | 'display' | 'none',
 *   layer: {width: number, height: number}}>}
 */
export async function prepareConsoleGraphics({rpc, directory, compatCache, inspector, table,
  destroyDisplay = false, layerSize = DEFAULT_SIZE, log = () => {}, mark = () => {}}) {
  const assets = loadRenderer().then(loaded => {
    mark('assets');
    return loaded;
  });
  assets.catch(() => {});

  const compat = await resolveCompatibility(rpc, {directory, cache: compatCache, inspector, log,
    ...(table ? {table} : {})});
  const resolve = functionResolver(rpc, compat.module);
  const renderer = await assets;
  const blob = renderer.blob;
  const tableHash = compat.hash;
  const blobHash = sha256(blob);
  /** @type {Ledger} */
  const ledger = (command, body = {}) => rpc.request({command: 'graphics-' + command, ...body});

  const status = ledgerStatus(await ledger('status', {tableHash, blobHash}));
  log({event: 'graphics-ledger', reuse: status.reuse, reapApp: status.reapApp, reapDisplay: status.reapDisplay});
  if (status.reuse === 'all') {
    if (!status.app || !status.display) throw Error('Invalid graphics ledger status');
    const session = rpc.a.session;
    const menu = {...status.app.menu, session};
    const gpu = {...status.app.gpu, session};
    const layer = keptLayer(status.display, layerSize, log);
    logVideoPath(gpu, log);
    await writeTarget(rpc, gpu, layer);
    await writeReports(directory, {display: status.display, menu});
    return {menu, gpu, reused: 'all', layer};
  }

  /** @param {'display' | 'app'} stage @param {LedgerObject[]} objects */
  async function record(stage, objects) {
    const entries = [];
    for (const object of objects)
      entries.push({kind: object.kind, name: object.name, handle: hex(object.handle),
        destroy: await ledgerDestroy(object.destroy, resolve, rpc.verifiedFunctions)});
    for (let start = 0; start < entries.length; start += RECORD_BATCH)
      await ledger('record', {stage, objects: entries.slice(start, start + RECORD_BATCH)});
  }

  const reusable = status.reuse === 'display' ? status.display : null;
  if (reusable && status.reapApp) await reap(ledger, false);
  if (!reusable && status.reapDisplay) {
    if (!destroyDisplay) throw Error('The console holds graphics this startup cannot reuse; restart Civ7');
    await reap(ledger, true);
  }
  const display = reusable || await buildDisplay(rpc, {resolve, tableHash, ledger, record, log, size: layerSize});
  const layer = keptLayer(display, layerSize, log);

  log({event: 'startup', stage: 'interface'});
  await ledger('begin', {stage: 'app', tableHash, blobHash});
  /** @param {Created} object @returns {LedgerObject[]} */
  const destroyed = object => object.destroy && object.destroy !== 'release'
    ? [{...object, destroy: {name: object.destroy, args: [display.device, '$handle', 0]}}]
    : [];
  const destroys = (/** @type {Created[]} */ objects) => objects.flatMap(destroyed);
  const onCreated = (/** @type {Created[]} */ objects) => record('app', destroys(objects));
  const {menu, gpu, requests, cache} = await createRendererPipelines(rpc, {display, renderer, resolve,
    cache: true, onCreated});
  log({event: 'startup', stage: 'pipelines', requests, cache});
  logVideoPath(gpu, log);

  const controls = {address: menu.controls.mapped, bytes: menu.controls.bytes};
  const filled = await fillConsoleStorage(rpc, blob, {
    input: controls,
    storage: {address: gpu.privateStorage.mapped, bytes: gpu.privateStorage.bytes}});
  log({event: 'startup', stage: 'storage', ...filled});
  await writeTarget(rpc, gpu, layer);
  await ledger('commit', {stage: 'app', result: {menu, gpu}});

  await writeReports(directory, {display, menu});
  return {menu, gpu, reused: status.reuse, layer};
}

/**
 * The civ7 renderer's frame sampling path and why it was chosen (renderer-pipelines.js videoPath).
 * @param {object} gpu
 * @param {(event: object) => void} log
 */
function logVideoPath(gpu, log) {
  if ('video' in gpu && gpu.video) log({event: 'video-path', .../** @type {object} */ (gpu.video)});
}

/**
 * @param {Civ7Rpc} rpc
 * @param {{resolve: (name: string) => Promise<number>, tableHash: string,
 *   ledger: Ledger, record: (stage: 'display', objects: LedgerObject[]) => Promise<void>,
 *   log: (event: object) => void, size: {width: number, height: number}}} options
 */
async function buildDisplay(rpc, {resolve, tableHash, ledger, record, log, size}) {
  await ledger('begin', {stage: 'display', tableHash});
  let built;
  try {
    built = await createDisplay(rpc, {resolve, size});
  } catch (error) {
    const objects = /** @type {{objects?: DisplayObject[]}} */ (error).objects;
    if (objects?.length) await record('display', objects);
    throw error;
  }

  await record('display', built.objects);
  await ledger('commit', {stage: 'display', result: built.display});
  log({event: 'startup', stage: 'display', requests: built.requests, cleared: built.display.frames.cleared,
    size});
  return built.display;
}

/** @param {Ledger} ledger @param {boolean} destroyDisplay */
async function reap(ledger, destroyDisplay) {
  const result = await ledger('reap', {destroyDisplay});
  const failure = /** @type {{kind?: unknown, message?: unknown} | null | undefined} */ (result.failure);
  if (failure) throw Error('Console graphics reap failed at ' + failure.kind + ': ' + failure.message);
}

/**
 * vulkan-display.json and launcher.json, for diagnostics.
 * @param {string} directory
 * @param {{display: DisplayResult, menu: PipelineMenu}} reports
 */
async function writeReports(directory, {display, menu}) {
  const write = (/** @type {string} */ name, /** @type {object} */ value) =>
    fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2), {mode: 0o600});
  await write('vulkan-display.json', {source: 'console', session: menu.session, presentationAccepted: true,
    displayResources: display});
  await write('launcher.json', menu);
}
