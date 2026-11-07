import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {packAssetBlob, parseAssetBlob} from '../../streamer/payload/asset-blob.js';
import * as layout from './layout.js';

export const FORMAT = 'moonlight.civ7.renderer';
export const VERSION = 2;
export const BLOB = 'shaders.bin';
export const PREBUILT = path.join(import.meta.dirname, 'prebuilt');
const sha256 = (/** @type {Buffer} */ bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function contract() {
  return {abi: layout.ABI, nativeABI: layout.NATIVE_ABI,
    viewport: {width: layout.WIDTH, height: layout.HEIGHT},
    buffers: {input: layout.INPUT_BYTES, storage: layout.STORAGE_BYTES},
    video: {frameBytes: layout.FRAME_BYTES, frameCount: layout.FRAME_COUNT, framesOffset: layout.FRAMES_OFFSET,
      slots: layout.VIDEO_SLOTS, slotWords: layout.VIDEO, sampling: ['texel-buffer', 'storage-bilinear']},
    ui: {offset: layout.UI_OFFSET, pageBytes: layout.UI_PAGE_BYTES, pages: layout.UI_PAGE_COUNT,
      vertices: 6, instances: layout.UI_INSTANCES, blending: 'source-alpha'},
    badge: {instance: layout.BADGE_INSTANCE, words: layout.BADGE, offset: layout.BADGE_OFFSET, bytes: layout.BADGE_BYTES},
    bindings: {input: 0, storage: 1, luma: 2, chroma: 3},
    control: layout.CONTROL, uiControl: layout.UI, input: layout.INPUT, initialState: 'zero'};
}

/** Hashes of the shader sources, so a prebuilt bundle that no longer matches them is caught. */
export async function sourceHashes() {
  const source = path.join(import.meta.dirname, 'shaders');
  const hashes = /** @type {Record<string, string>} */ ({});
  for (const name of (await fs.readdir(source)).sort())
    hashes[name] = sha256(await fs.readFile(path.join(source, name)));
  hashes['layout.glsl'] = sha256(Buffer.from(layout.glslLayout()));
  return hashes;
}

/** @param {Record<string, Buffer>} shaders @param {Record<string, string>} [sources] */
export function packRenderer(shaders, sources = {}) {
  const stages = Object.keys(layout.STAGES);
  if (Object.keys(shaders).length !== stages.length || stages.some(stage => !shaders[stage]))
    throw Error('Renderer shader stages do not match the contract');
  for (const [name, bytes] of Object.entries(shaders)) {
    if (bytes.length < 20 || bytes.length % 4 || bytes.readUInt32LE() !== 0x07230203)
      throw Error('Invalid SPIR-V shader: ' + name);
  }
  const inputs = stages.map(name => ({name: name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), bytes: shaders[name]}));
  const blob = packAssetBlob([{name: 'input', bytes: layout.INPUT_BYTES}, {name: 'storage', bytes: layout.STORAGE_BYTES}], inputs);
  const manifest = {format: FORMAT, version: VERSION, contract: contract(),
    blob: {path: BLOB, bytes: blob.length, sha256: sha256(blob)}, sources};
  return {blob, manifest};
}

/** @param {string} [directory] */
export async function loadRenderer(directory = PREBUILT) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'renderer.json'), 'utf8'));
  if (manifest.format !== FORMAT || manifest.version !== VERSION) throw Error('Unsupported Civ7 renderer bundle');
  if (JSON.stringify(manifest.contract) !== JSON.stringify(contract())) throw Error('Renderer resource contract mismatch');
  if (manifest.blob?.path !== BLOB) throw Error('Invalid renderer blob path');
  const blob = await fs.readFile(path.join(directory, BLOB));
  if (blob.length !== manifest.blob.bytes || sha256(blob) !== manifest.blob.sha256)
    throw Error('Renderer blob differs from its manifest');
  const header = parseAssetBlob(blob);
  const expectedRegions = [{name: 'input', bytes: layout.INPUT_BYTES}, {name: 'storage', bytes: layout.STORAGE_BYTES}];
  if (JSON.stringify(header.regions) !== JSON.stringify(expectedRegions)) throw Error('Renderer buffer contract mismatch');
  const shaders = /** @type {Record<string, Buffer>} */ ({});
  for (const entry of header.entries) {
    const name = entry.name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (shaders[name] || entry.region) throw Error('Invalid renderer shader entry');
    shaders[name] = blob.subarray(entry.offset, entry.offset + entry.size);
  }
  packRenderer(shaders);
  const identity = Buffer.from(JSON.stringify({format: FORMAT, version: VERSION, contract: manifest.contract, blob: manifest.blob.sha256}));
  return {manifest, blob, shaders, fingerprint: sha256(identity)};
}
