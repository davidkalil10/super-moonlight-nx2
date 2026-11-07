// Builds compat-functions.json: the nnCompat functions startup and the civ7 path resolve, named
// and unnamed, with offsets, sizes and first 32 bytes, and the hash that identifies the build.
// Usage: node compat-table.js MODULE_JSON METADATA_BIN TEXT_BIN [OUTPUT]
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {moduleTables} from './compat.js';
import * as ring from '../shared/ring.js';
import movie from '../console-api/movie-functions.json' with {type: 'json'};
import movieMode from '../console-api/movie-mode-functions.json' with {type: 'json'};
import movieEvent from '../console-api/movie-event-functions.json' with {type: 'json'};

const SIGNATURE_BYTES = 32;
const ELF_FUNCTION_TYPE = 2;

/**
 * vi and Vulkan functions the display, launcher, gpu-app, pipeline cache, loop and presenter
 * stages resolve, and the destroy and close calls graphics-ledger.js replays for every object
 * they create.
 */
export const STARTUP_FUNCTIONS = [
  '_ZN2nn2vi12CloseDisplayEPNS0_7DisplayE', '_ZN2nn2vi18OpenDefaultDisplayEPPNS0_7DisplayE',
  '_ZN2nn2vi21LayerCreationSettingsC1Eii', '_ZN2nn2vi5Layer15GetNativeWindowEv',
  '_ZN2nn2vi5Layer4OpenEPKNS0_21LayerCreationSettingsEPNS0_7DisplayEPKc', '_ZN2nn2vi5Layer5CloseEb',
  '_ZN2nn2vi5LayerC1Ev',
  'vkAcquireNextImage2KHR', 'vkAllocateCommandBuffers', 'vkAllocateDescriptorSets', 'vkAllocateMemory',
  'vkBeginCommandBuffer', 'vkBindBufferMemory', 'vkBindImageMemory', 'vkCmdBeginRendering',
  'vkCmdBindDescriptorSets2', 'vkCmdBindPipeline', 'vkCmdCopyBuffer2', 'vkCmdCopyImageToBuffer2',
  'vkCmdDispatch', 'vkCmdDraw', 'vkCmdEndRendering', 'vkCmdExecuteCommands', 'vkCmdPipelineBarrier2',
  'vkCreateBuffer', 'vkCreateBufferView', 'vkCreateCommandPool', 'vkCreateComputePipelines', 'vkCreateDescriptorPool',
  'vkCreateDescriptorSetLayout', 'vkCreateDevice', 'vkCreateFence', 'vkCreateGraphicsPipelines',
  'vkCreateImage', 'vkCreateImageView', 'vkCreateInstance', 'vkCreatePipelineCache', 'vkCreatePipelineLayout',
  'vkCreateSemaphore', 'vkCreateShaderModule', 'vkCreateSwapchainKHR', 'vkCreateViSurfaceNN', 'vkDestroyBuffer', 'vkDestroyBufferView',
  'vkDestroyCommandPool', 'vkDestroyDescriptorPool', 'vkDestroyDescriptorSetLayout', 'vkDestroyDevice',
  'vkDestroyFence', 'vkDestroyImage', 'vkDestroyImageView', 'vkDestroyInstance', 'vkDestroyPipeline',
  'vkDestroyPipelineCache', 'vkDestroyPipelineLayout', 'vkDestroySemaphore', 'vkDestroyShaderModule',
  'vkDestroySurfaceKHR', 'vkDestroySwapchainKHR',
  'vkEndCommandBuffer', 'vkEnumeratePhysicalDevices', 'vkFreeMemory', 'vkGetBufferMemoryRequirements',
  'vkGetDeviceQueue', 'vkGetImageMemoryRequirements', 'vkGetImageSubresourceLayout', 'vkGetPhysicalDeviceMemoryProperties',
  'vkGetPhysicalDeviceProperties', 'vkGetPhysicalDeviceQueueFamilyProperties',
  'vkGetPhysicalDeviceSurfaceCapabilitiesKHR', 'vkGetPhysicalDeviceSurfaceFormatsKHR',
  'vkGetPhysicalDeviceSurfacePresentModesKHR', 'vkGetPhysicalDeviceSurfaceSupportKHR', 'vkGetPipelineCacheData',
  'vkGetSwapchainImagesKHR', 'vkMapMemory2', 'vkQueuePresentKHR',
  'vkQueueSubmit', 'vkQueueWaitIdle', 'vkResetFences', 'vkUpdateDescriptorSets', 'vkWaitForFences'
];

/**
 * The layer's extended swap interval and the chain the public setter and clearer tail-call
 * through to the forwarding table (refresh-rate.js).
 */
export const SWAP_INTERVAL_FUNCTIONS = [
  '_ZN2nn2vi28SetLayerExtendedSwapIntervalEPNS0_5LayerEii', '_ZN2nn2vi30ClearLayerExtendedSwapIntervalEPNS0_5LayerE',
  '_ZN2nn2vi5Layer32SetLayerNextExtendedSwapIntervalEii', '_ZN2nn2vi5Layer34ClearLayerNextExtendedSwapIntervalEv',
  '_ZN2nn2vi6detail13InternalLayer27SetNextExtendedSwapIntervalEii',
  '_ZN2nn2vi6detail13InternalLayer29ClearNextExtendedSwapIntervalEv'
];

/**
 * Functions without a symbol, located by REA on the 2026-10-24 nnCompat text (team note
 * t40-rate-setter.md). Each carries its REA size and prefix; the generator refuses a text image
 * whose bytes differ, and the console verifies the table's 32 bytes like a named entry.
 */
export const UNNAMED_FUNCTIONS = [
  {name: 'DisplaySession301', offset: 0x251470, size: 204, prefix: '7f2303d5fd7bbca9f70b00f9f65702a9'},
  {name: 'DisplaySession354', offset: 0x251540, size: 208, prefix: '7f2303d5ff0301d1fd7b01a9f65702a9'},
  {name: 'ResultErrorHook', offset: 0x1b6e70, size: 40, prefix: '08544092695e90521f0109eb40000054'},
  {name: 'PltLayerSetNextSwap', offset: 0x2bd38a0, size: 16, prefix: 'b0a300b0113246f91082319120021fd6'},
  {name: 'PltLayerClearNextSwap', offset: 0x2bd38b0, size: 16, prefix: 'b0a300b0113646f910a2319120021fd6'},
  {name: 'PltInternalSetNextSwap', offset: 0x2bd34b0, size: 16, prefix: 'b0a300b0113645f910a2299120021fd6'},
  {name: 'PltInternalClearNextSwap', offset: 0x2bd34c0, size: 16, prefix: 'b0a300b0113a45f910c2299120021fd6'},
  {name: 'SwapIntervalForwarder', offset: 0x24ec50, size: 32, prefix: '08f0019008210491e303022ae203012ae10300aa04f940f9'},
  {name: 'SwapIntervalClearForwarder', offset: 0x24ec70, size: 24, prefix: '08f0019008210491e10300aa02fd40f9000140f940001fd6'},
  {name: 'ExtendedSwapIntervalSetter', offset: 0x258c20, size: 16, prefix: '20a00091e103022ae203032a05000014'},
  {name: 'ExtendedSwapIntervalClearer', offset: 0x258d90, size: 12, prefix: '3f8802393fa400b9c0035fd6'}
];

/** Every symbol the table carries: startup, the swap interval chain and the movie decoder tables. */
export function tableNames() {
  const decoder = [movie, movieMode, movieEvent].flatMap(table => Object.values(table).map(entry => entry.symbol));
  return [...new Set([...STARTUP_FUNCTIONS, ...SWAP_INTERVAL_FUNCTIONS, ...decoder])];
}

/**
 * A module capture as captureModule writes it.
 * @typedef {{name: string, imageSize: number, spans: {offset: number, bytes: number, sha256?: string}[],
 *   symbols: {name: string, section: number, type: number, offset: number, size: number}[]}} CapturedModule
 */

/** @typedef {{symbol: string, offset: number, size: number, hex: string}} TableFunction */
/** @typedef {{offset: number, size: number, hex: string}} UnnamedFunction */
/** @typedef {{name: string, offset: number, size: number, prefix: string}} UnnamedSource */

/**
 * `functions` by symbol name; `unnamed` by the name UNNAMED_FUNCTIONS gives them, which no
 * symbol lookup sees.
 * @param {{module: CapturedModule, metadata: (offset: number, length: number) => Uint8Array,
 *   text: Buffer, names?: string[], unnamed?: UnnamedSource[]}} sources
 */
export function buildTable({module, metadata, text, names = tableNames(), unnamed = []}) {
  const first = module.spans?.[0];
  const header = text.subarray(0, 16);
  const headerOk = first && first.offset === 0 && first.bytes === 16;
  if (!headerOk || crypto.createHash('sha256').update(header).digest('hex') !== first.sha256)
    throw Error('Text image does not belong to the captured module');

  const tables = moduleTables(metadata, ring.nativeChecksum);
  if (tables.imageSize !== module.imageSize || tables.symbols !== module.symbols.length)
    throw Error('Metadata image does not match the captured module');

  /** @type {Record<string, TableFunction>} */
  const functions = {};
  for (const name of [...names].sort()) {
    const symbol = module.symbols.find(item => item.name === name && item.section && item.type === ELF_FUNCTION_TYPE);
    if (!symbol) throw Error('Captured module lacks ' + name);
    const length = Math.min(SIGNATURE_BYTES, symbol.size);
    if (length < 4 || symbol.offset + length > text.length) throw Error('Text image lacks ' + name);
    functions[name] = {symbol: name, offset: symbol.offset, size: symbol.size,
      hex: text.subarray(symbol.offset, symbol.offset + length).toString('hex')};
  }

  for (const entry of Object.values({...movie, ...movieMode, ...movieEvent})) {
    const shipped = functions[entry.symbol];
    if (!shipped) continue;
    if (shipped.offset !== entry.offset || !entry.hex.startsWith(shipped.hex))
      throw Error('Movie table disagrees with the text image: ' + entry.symbol);
  }

  /** @type {Record<string, UnnamedFunction>} */
  const unnamedFunctions = {};
  for (const entry of unnamed) {
    const length = Math.min(SIGNATURE_BYTES, entry.size);
    const inText = entry.offset % 4 === 0 && entry.offset + length <= text.length;
    if (!inText) throw Error('Text image lacks ' + entry.name);

    const bytes = text.subarray(entry.offset, entry.offset + length).toString('hex');
    if (!bytes.startsWith(entry.prefix)) throw Error('Unnamed function differs from its REA prefix: ' + entry.name);
    const named = module.symbols.find(item => item.section && item.offset === entry.offset);
    if (named) throw Error(entry.name + ' has a symbol: ' + named.name);

    unnamedFunctions[entry.name] = {offset: entry.offset, size: entry.size, hex: bytes};
  }

  return {module: {name: module.name, hash: tables.hash, imageSize: tables.imageSize,
    symbols: tables.symbols, section: 2}, functions, unnamed: unnamedFunctions};
}

/** @param {string[]} args */
async function main(args) {
  const [moduleFile, metadataFile, textFile, output] = args;
  if (!moduleFile || !metadataFile || !textFile) throw Error('Usage: compat-table.js MODULE_JSON METADATA_BIN TEXT_BIN [OUTPUT]');
  /** @type {CapturedModule} */
  const module = JSON.parse(await fs.readFile(moduleFile, 'utf8'));
  const text = await fs.readFile(textFile);
  const handle = await fs.open(metadataFile, 'r');
  const image = Buffer.alloc(module.imageSize);
  try {
    for (const span of module.spans)
      await handle.read(image, span.offset, span.bytes, span.offset);
  } finally { await handle.close(); }

  const table = buildTable({module, text, unnamed: UNNAMED_FUNCTIONS,
    metadata: (offset, length) => image.subarray(offset, offset + length)});
  const target = output || path.join(import.meta.dirname, 'compat-functions.json');
  await fs.writeFile(target, JSON.stringify(table, null, 2) + '\n');
  console.log(JSON.stringify({output: target, hash: table.module.hash, functions: Object.keys(table.functions).length}));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename))
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
