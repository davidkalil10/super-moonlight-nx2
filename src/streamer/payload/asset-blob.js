/**
 * The asset blob: every byte startup writes to the console, packed once by the renderer build
 * (src/renderer/civ7/bundle.js) and sent in a few write-raw requests. civ7/asset-fill.js unpacks it.
 */
import crypto from 'node:crypto';

export const ASSET_BLOB = {
  magic: 0x42414c4d,
  version: 1,
  fixedBytes: 32,
  regionBytes: 16,
  entryBytes: 80,
  nameBytes: 24,
  regionNameBytes: 12,
  alignment: 16,
  checksumOffset: 24
};

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/**
 * @typedef {{name: string, bytes: number}} BlobRegion
 * @typedef {{name: string, bytes: Buffer, region?: string, regionOffset?: number}} BlobInput
 * @typedef {{name: string, offset: number, size: number, region: string | null,
 *   regionOffset: number, checksum: number, sha256: string}} BlobEntry
 * @typedef {{version: number, headerBytes: number, totalBytes: number, checksum: number,
 *   regions: BlobRegion[], entries: BlobEntry[]}} BlobHeader
 */

const align = (/** @type {number} */ value) => Math.ceil(value / ASSET_BLOB.alignment) * ASSET_BLOB.alignment;
const sha256 = (/** @type {Buffer} */ bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * FNV-1a over little-endian 32-bit words; the console runs the same loop. A trailing partial
 * word counts as zero padded.
 * @param {Buffer} bytes
 */
export function wordChecksum(bytes) {
  let checksum = FNV_OFFSET_BASIS;
  const whole = bytes.length & ~3;
  for (let offset = 0; offset < whole; offset += 4)
    checksum = Math.imul(checksum ^ bytes.readUInt32LE(offset), FNV_PRIME);
  if (whole < bytes.length) {
    const tail = Buffer.alloc(4);
    bytes.copy(tail, 0, whole);
    checksum = Math.imul(checksum ^ tail.readUInt32LE(0), FNV_PRIME);
  }
  return checksum >>> 0;
}

/**
 * @param {Buffer} target
 * @param {string} text
 * @param {number} offset
 * @param {number} limit
 */
function writeName(target, text, offset, limit) {
  if (!/^[a-z][a-z0-9-]*$/.test(text) || text.length >= limit) throw Error('Invalid asset blob name: ' + text);
  target.write(text, offset, 'ascii');
}

/**
 * @param {Buffer} source
 * @param {number} offset
 * @param {number} limit
 */
function readName(source, offset, limit) {
  const field = source.subarray(offset, offset + limit);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? limit : end).toString('ascii');
}

/**
 * @param {BlobRegion[]} regions
 * @param {BlobInput[]} inputs
 * @returns {Buffer}
 */
export function packAssetBlob(regions, inputs) {
  const layout = ASSET_BLOB;
  const headerBytes = align(layout.fixedBytes + regions.length * layout.regionBytes +
    inputs.length * layout.entryBytes);

  const placed = [];
  let cursor = headerBytes;
  for (const input of inputs) {
    placed.push({input, offset: cursor});
    cursor = align(cursor + input.bytes.length);
  }

  const blob = Buffer.alloc(cursor);
  blob.writeUInt32LE(layout.magic, 0);
  blob.writeUInt32LE(layout.version, 4);
  blob.writeUInt32LE(headerBytes, 8);
  blob.writeUInt32LE(cursor, 12);
  blob.writeUInt32LE(regions.length, 16);
  blob.writeUInt32LE(inputs.length, 20);

  regions.forEach((region, index) => {
    const at = layout.fixedBytes + index * layout.regionBytes;
    writeName(blob, region.name, at, layout.regionNameBytes);
    blob.writeUInt32LE(region.bytes, at + layout.regionNameBytes);
  });

  const entryTable = layout.fixedBytes + regions.length * layout.regionBytes;
  placed.forEach(({input, offset}, index) => {
    const at = entryTable + index * layout.entryBytes;
    const regionIndex = input.region === undefined ? -1 : regions.findIndex(item => item.name === input.region);
    if (input.region !== undefined && regionIndex < 0) throw Error('Unknown asset blob region: ' + input.region);
    const regionOffset = input.regionOffset ?? 0;
    if (regionIndex >= 0 && regionOffset + input.bytes.length > regions[regionIndex].bytes)
      throw Error('Asset ' + input.name + ' does not fit its region');

    writeName(blob, input.name, at, layout.nameBytes);
    blob.writeUInt32LE(offset, at + 24);
    blob.writeUInt32LE(input.bytes.length, at + 28);
    blob.writeUInt32LE(regionIndex + 1, at + 32);
    blob.writeUInt32LE(regionOffset, at + 36);
    blob.writeUInt32LE(wordChecksum(input.bytes), at + 40);
    blob.write(sha256(input.bytes), at + 48, 'hex');
    input.bytes.copy(blob, offset);
  });

  blob.writeUInt32LE(wordChecksum(blob.subarray(0, headerBytes)), layout.checksumOffset);
  return blob;
}

/**
 * Parses and checks a blob in full: header checksum, bounds, and every entry's sha256.
 * @param {Buffer} blob
 * @returns {BlobHeader}
 */
export function parseAssetBlob(blob) {
  const layout = ASSET_BLOB;
  if (!Buffer.isBuffer(blob) || blob.length < layout.fixedBytes) throw Error('Asset blob is too short');
  if (blob.readUInt32LE(0) !== layout.magic) throw Error('Not an asset blob');
  if (blob.readUInt32LE(4) !== layout.version) throw Error('Unsupported asset blob version');

  const headerBytes = blob.readUInt32LE(8);
  const totalBytes = blob.readUInt32LE(12);
  const regionCount = blob.readUInt32LE(16);
  const entryCount = blob.readUInt32LE(20);
  const expectedHeader = align(layout.fixedBytes + regionCount * layout.regionBytes + entryCount * layout.entryBytes);
  if (totalBytes !== blob.length || headerBytes !== expectedHeader || headerBytes > totalBytes)
    throw Error('Asset blob size mismatch');

  const header = Buffer.from(blob.subarray(0, headerBytes));
  const checksum = header.readUInt32LE(layout.checksumOffset);
  header.writeUInt32LE(0, layout.checksumOffset);
  if (wordChecksum(header) !== checksum) throw Error('Asset blob header checksum mismatch');

  const regions = [];
  for (let index = 0; index < regionCount; index++) {
    const at = layout.fixedBytes + index * layout.regionBytes;
    regions.push({name: readName(blob, at, layout.regionNameBytes), bytes: blob.readUInt32LE(at + layout.regionNameBytes)});
  }

  const entries = [];
  const entryTable = layout.fixedBytes + regionCount * layout.regionBytes;
  for (let index = 0; index < entryCount; index++) {
    const at = entryTable + index * layout.entryBytes;
    const offset = blob.readUInt32LE(at + 24);
    const size = blob.readUInt32LE(at + 28);
    const regionIndex = blob.readUInt32LE(at + 32);
    const entry = {
      name: readName(blob, at, layout.nameBytes), offset, size,
      region: regionIndex ? regions[regionIndex - 1]?.name ?? null : null,
      regionOffset: blob.readUInt32LE(at + 36),
      checksum: blob.readUInt32LE(at + 40),
      sha256: blob.subarray(at + 48, at + 80).toString('hex')
    };
    if (offset < headerBytes || offset + size > totalBytes) throw Error('Asset ' + entry.name + ' is out of bounds');
    if (regionIndex && !entry.region) throw Error('Asset ' + entry.name + ' names an unknown region');
    if (sha256(blob.subarray(offset, offset + size)) !== entry.sha256)
      throw Error('Asset ' + entry.name + ' hash mismatch');
    entries.push(entry);
  }

  return {version: layout.version, headerBytes, totalBytes, checksum, regions, entries};
}
