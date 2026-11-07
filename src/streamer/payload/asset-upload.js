/**
 * The PC half of phase C: sends the renderer's asset blob to a console buffer with write-raw and
 * runs `fill-storage` there, which zeroes the buffers and checks the shaders landed.
 */
import {parseAssetBlob} from './asset-blob.js';

/** @import {Civ7Rpc} from '../civ7/transport.js' */

/**
 * Entries the console reads back from the blob: none, the PC paints the UI pages.
 * @type {string[]}
 */
const KEPT_ASSETS = [];
const SAMPLES_PER_ENTRY = 4;

const hex = (/** @type {number | bigint} */ value) => '0x' + BigInt(value).toString(16);

/** @typedef {{address: number | bigint, bytes: number}} StorageRegion */

/**
 * Words at the start, end and two points between of one entry, as `[offset, word]` pairs for the
 * console to compare: a cheap check that write-raw landed the blob where fill-storage reads it.
 * @param {Buffer} blob
 * @param {{offset: number, size: number}} entry
 * @returns {[number, number][]}
 */
export function entrySamples(blob, {offset, size}) {
  if (!size) return [];

  const last = Math.max(0, size - 4);
  const offsets = new Set([0, last]);
  for (let index = 1; index < SAMPLES_PER_ENTRY - 1; index++)
    offsets.add(Math.floor(last * index / (SAMPLES_PER_ENTRY - 1) / 4) * 4);

  return [...offsets].sort((first, second) => first - second).map(at => {
    const bytes = Buffer.alloc(4);
    blob.copy(bytes, 0, offset + at, offset + Math.min(size, at + 4));
    return [at, bytes.readUInt32LE(0)];
  });
}

/**
 * @param {Pick<Civ7Rpc, 'allocate' | 'release' | 'write' | 'request'>} rpc
 * @param {Buffer} blob
 * @param {Record<string, StorageRegion>} regions By the blob's region names: input, storage.
 */
export async function fillConsoleStorage(rpc, blob, regions) {
  const header = parseAssetBlob(blob);
  for (const region of header.regions) {
    const target = regions[region.name];
    if (!target) throw Error('No console address for asset region ' + region.name);
    if (target.bytes !== region.bytes) throw Error('Console ' + region.name + ' is ' + target.bytes + ' bytes, the blob expects ' + region.bytes);
  }

  const buffer = await rpc.allocate(blob.length, {align: 0x1000});
  try {
    await rpc.write(buffer, blob);
    const targets = Object.fromEntries(header.regions.map(region =>
      [region.name, {address: hex(regions[region.name].address), bytes: region.bytes}]));
    const samples = header.entries.map(entry => entrySamples(blob, entry));
    const {id, ok, ...result} = await rpc.request({command: 'fill-storage', address: buffer,
      length: blob.length, checksum: header.checksum, regions: targets, samples, keep: KEPT_ASSETS});
    return {...result, blobBytes: blob.length};
  } finally {
    await rpc.release(buffer);
  }
}
