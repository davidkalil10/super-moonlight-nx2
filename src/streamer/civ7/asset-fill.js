/**
 * `fill-storage`: unpacks the asset blob (payload/asset-blob.js) already written to the console,
 * zeroes each region and copies the entries into place with native copies. Shipped with toString().
 */

/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */

/** @typedef {{start: bigint, end: bigint}} Span */
/** @typedef {Span & {name: string, pointer: bigint, bytes: number, spans: Span[]}} Region */

/**
 * Checks everything before writing anything: header, region sizes and permissions, entry bounds
 * and a few sampled words per entry. The PC checks sha256 before sending; script byte loops run
 * at ~0.3 MB/s on the console, so only the header is checksummed here (payload/README.md).
 * @param {Pick<ConsoleNative, 'address' | 'integer' | 'checkMemory' | 'readBuffer' | 'writeBuffer'> &
 *   {copy: (target: bigint, source: bigint, count: number) => void, now?: () => number,
 *   keep?: (name: string, bytes: Uint8Array, checksum: number) => void}} native Entries without a
 *   region (the UI glyph atlas) go to `keep`, as the PC releases the blob after the fill.
 * @param {ConsoleRequest} request address, length, checksum, regions (name to address and bytes),
 *   samples (per entry, `[offset, word]` pairs read from the blob on the PC) and keep (entry names)
 */
export function fillStorage(native, request) {
  const {address, integer, checkMemory, readBuffer, writeBuffer, copy} = native;
  const now = native.now || (() => Date.now());
  const MAGIC = 0x42414c4d;
  const VERSION = 1;
  const FIXED_BYTES = 32;
  const REGION_BYTES = 16;
  const REGION_NAME_BYTES = 12;
  const ENTRY_BYTES = 80;
  const NAME_BYTES = 24;
  const CHECKSUM_OFFSET = 24;
  const ALIGNMENT = 16;
  const MAX_REGIONS = 8;
  const MAX_ENTRIES = 64;
  const MAX_BLOB_BYTES = 16 * 1024 * 1024;
  const MAX_REGION_BYTES = 64 * 1024 * 1024;
  const ZERO_SEED_BYTES = 256;
  const MAX_SAMPLES = 8;
  const FNV_OFFSET_BASIS = 2166136261;
  const FNV_PRIME = 16777619;
  const started = now();

  /**
   * @param {Uint8Array} bytes
   * @param {number} offset
   */
  function word(bytes, offset) {
    return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
  }

  /**
   * @param {Uint8Array} bytes
   * @param {number} offset
   * @param {number} limit
   */
  function name(bytes, offset, limit) {
    let text = '';
    for (let index = 0; index < limit && bytes[offset + index]; index++)
      text += String.fromCharCode(bytes[offset + index]);
    return text;
  }

  /**
   * @param {number} checksum
   * @param {Uint32Array} words
   */
  function mix(checksum, words) {
    for (let index = 0; index < words.length; index++)
      checksum = Math.imul(checksum ^ words[index], FNV_PRIME);
    return checksum;
  }

  /** @param {Uint8Array} bytes */
  function wordsOf(bytes) {
    const aligned = bytes.byteOffset % 4 || bytes.length % 4 ? new Uint8Array((bytes.length + 3) & ~3) : bytes;
    if (aligned !== bytes) aligned.set(bytes);
    return new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.length >> 2);
  }

  /**
   * Doubles a small zeroed seed in place.
   * @param {bigint} pointer
   * @param {number} bytes
   */
  function zeroFromSeed(pointer, bytes) {
    const seed = Math.min(ZERO_SEED_BYTES, bytes);
    writeBuffer(pointer, new Uint8Array(seed));
    for (let filled = seed; filled < bytes; filled *= 2)
      copy(pointer + BigInt(filled), pointer, Math.min(filled, bytes - filled));
  }

  /**
   * @param {bigint} pointer
   * @param {number} bytes
   * @param {Region} zeroed
   */
  function zeroFrom(pointer, bytes, zeroed) {
    for (let filled = 0; filled < bytes; filled += zeroed.bytes)
      copy(pointer + BigInt(filled), zeroed.pointer, Math.min(zeroed.bytes, bytes - filled));
  }

  /**
   * @param {Uint8Array} bytes
   * @param {number} count
   */
  function partialWord(bytes, count) {
    let value = 0;
    for (let index = 0; index < count; index++) value |= bytes[index] << (index * 8);
    return value >>> 0;
  }

  /**
   * @param {{name: string, offset: number, size: number}} entry
   * @param {unknown} samples
   */
  function checkSamples(entry, samples) {
    if (!Array.isArray(samples) || samples.length > MAX_SAMPLES) throw Error('Asset ' + entry.name + ' has invalid samples');
    if (entry.size && !samples.length) throw Error('Asset ' + entry.name + ' has no samples');

    for (const sample of samples) {
      if (!Array.isArray(sample) || sample.length !== 2) throw Error('Asset ' + entry.name + ' has invalid samples');
      const at = integer(sample[0], 0, entry.size - 1);
      const count = Math.min(4, entry.size - at);
      const actual = partialWord(readBuffer(blob + BigInt(entry.offset + at), count), count);
      if (actual !== sample[1]) throw Error('Asset ' + entry.name + ' sample mismatch');
    }
  }

  /**
   * @param {Span} first
   * @param {Span} second
   */
  function overlaps(first, second) {
    return first.start < second.end && second.start < first.end;
  }

  const blob = address(request.address);
  const length = integer(request.length, FIXED_BYTES, MAX_BLOB_BYTES);
  checkMemory(blob, length, 1);
  if (!Number.isSafeInteger(request.checksum)) throw Error('Invalid asset blob checksum');

  const fixed = readBuffer(blob, FIXED_BYTES);
  if (word(fixed, 0) !== MAGIC || word(fixed, 4) !== VERSION) throw Error('Not an asset blob of version 1');
  const headerBytes = word(fixed, 8);
  const regionCount = word(fixed, 16);
  const entryCount = word(fixed, 20);
  const sizesOk = word(fixed, 12) === length && headerBytes <= length;
  const countsOk = regionCount <= MAX_REGIONS && entryCount <= MAX_ENTRIES;
  if (!sizesOk || !countsOk) throw Error('Asset blob header does not match its length');
  const tableBytes = FIXED_BYTES + regionCount * REGION_BYTES + entryCount * ENTRY_BYTES;
  if (headerBytes !== Math.ceil(tableBytes / ALIGNMENT) * ALIGNMENT) throw Error('Asset blob header size mismatch');

  const header = readBuffer(blob, headerBytes).slice();
  const stored = word(header, CHECKSUM_OFFSET);
  header.fill(0, CHECKSUM_OFFSET, CHECKSUM_OFFSET + 4);
  if ((mix(FNV_OFFSET_BASIS, wordsOf(header)) >>> 0) !== stored || stored !== request.checksum)
    throw Error('Asset blob header checksum mismatch');

  const blobSpan = {start: blob, end: blob + BigInt(length)};
  const targets = /** @type {Record<string, {address: unknown, bytes: unknown} | undefined> | undefined} */ (
    request.regions);
  /** @type {Region[]} */
  const regions = [];
  for (let index = 0; index < regionCount; index++) {
    const at = FIXED_BYTES + index * REGION_BYTES;
    const regionName = name(header, at, REGION_NAME_BYTES);
    const bytes = integer(word(header, at + REGION_NAME_BYTES), 1, MAX_REGION_BYTES);
    const target = targets && Object.hasOwn(targets, regionName) ? targets[regionName] : null;
    if (!target) throw Error('No address for asset region ' + regionName);
    if (target.bytes !== bytes) throw Error('Asset region ' + regionName + ' size differs from the blob');

    const pointer = address(target.address);
    checkMemory(pointer, bytes, 3);
    const region = {name: regionName, pointer, bytes, start: pointer, end: pointer + BigInt(bytes), spans: []};
    if (overlaps(region, blobSpan) || regions.some(other => overlaps(region, other)))
      throw Error('Asset region ' + regionName + ' overlaps another');
    regions.push(region);
  }

  const entries = [];
  const entryTable = FIXED_BYTES + regionCount * REGION_BYTES;
  for (let index = 0; index < entryCount; index++) {
    const at = entryTable + index * ENTRY_BYTES;
    const entryName = name(header, at, NAME_BYTES);
    const offset = word(header, at + 24);
    const size = word(header, at + 28);
    const regionIndex = word(header, at + 32);
    const regionOffset = word(header, at + 36);
    if (offset < headerBytes || offset + size > length) throw Error('Asset ' + entryName + ' is out of bounds');
    if (regionIndex > regionCount) throw Error('Asset ' + entryName + ' names an unknown region');

    const region = regionIndex ? regions[regionIndex - 1] : null;
    if (region) {
      if (regionOffset + size > region.bytes) throw Error('Asset ' + entryName + ' does not fit its region');
      const span = {start: BigInt(regionOffset), end: BigInt(regionOffset + size)};
      if (region.spans.some(other => overlaps(span, other))) throw Error('Asset ' + entryName + ' overlaps another');
      region.spans.push(span);
    }
    entries.push({name: entryName, offset, size, region, regionOffset, checksum: word(header, at + 40)});
  }

  const samples = request.samples;
  if (!Array.isArray(samples) || samples.length !== entries.length) throw Error('Asset blob samples do not match its entries');
  entries.forEach((entry, index) => checkSamples(entry, samples[index]));
  const keep = Array.isArray(request.keep) ? request.keep : [];
  const verified = now();

  let zeroed = 0;
  const largest = regions.reduce((best, region) => region.bytes > best.bytes ? region : best, regions[0]);
  if (largest) {
    zeroFromSeed(largest.pointer, largest.bytes);
    zeroed += largest.bytes;
  }
  for (const region of regions) {
    if (region === largest) continue;
    zeroFrom(region.pointer, region.bytes, largest);
    zeroed += region.bytes;
  }

  let copied = 0;
  for (const entry of entries) {
    if (!entry.region || !entry.size) continue;
    copy(entry.region.pointer + BigInt(entry.regionOffset), blob + BigInt(entry.offset), entry.size);
    copied += entry.size;
  }

  const filled = now();

  let kept = 0;
  for (const entry of entries) {
    if (entry.region || !native.keep || !keep.includes(entry.name)) continue;
    native.keep(entry.name, readBuffer(blob + BigInt(entry.offset), entry.size).slice(), entry.checksum);
    kept += entry.size;
  }

  return {regions: regions.length, entries: entries.length, zeroed, copied, kept,
    verifyMs: verified - started, fillMs: filled - verified, keepMs: now() - filled};
}
