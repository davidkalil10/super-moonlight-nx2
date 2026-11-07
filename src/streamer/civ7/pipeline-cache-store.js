// Moonlight's Vulkan pipeline cache in Civ7's save data, beside the settings (README "Pipeline
// cache"). Shipped by source text: everything it needs lives inside the function.

/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */

/**
 * @typedef {object} StoredCache What a load or save found, as the host compares it.
 * @property {number} bytes Vulkan cache data length.
 * @property {number} checksum FNV-1a over the file after its checksum word.
 * @property {number} vendor
 * @property {number} device
 * @property {string} uuid pipelineCacheUUID, hex.
 */

/**
 * `pipeline-cache-load` reads `save:/moonlight-pipelines.bin` into the request's memory and
 * checks it; `pipeline-cache-save` serializes a VkPipelineCache and rewrites the file when it
 * changed. Neither throws for a missing or corrupt file.
 * @param {Pick<ConsoleNative, 'address' | 'integer' | 'argument' | 'checkMemory' | 'verified' | 'call' |
 *   'read32' | 'read64' | 'write32' | 'write64' | 'readBuffer' | 'writeBuffer' | 'encode' | 'fromHex' |
 *   'toHex'>} native
 * @param {ConsoleRequest} request
 */
export function pipelineCacheStore(native, request) {
  const {address, integer, argument, checkMemory, verified, call, read32, read64, write32, write64,
    readBuffer, writeBuffer, encode, fromHex, toHex} = native;
  const PATH = 'save:/moonlight-pipelines.bin';
  const MAGIC = 0x43504c4d;
  const VERSION = 1;
  const HEADER_BYTES = 80;
  const CHECKED_FROM = 16;
  const VULKAN_HEADER_BYTES = 32;
  const VULKAN_HEADER_VERSION = 1;
  const KEY_BYTES = 32;
  const FILE_OFFSET = 0x100;
  const MAX_CAPACITY = 4 * 1024 * 1024;
  const PATH_NOT_FOUND = 0x202;
  const READ = 1;
  const WRITE = 2;

  const memory = address(request.memory);
  const capacity = integer(request.capacity, HEADER_BYTES + VULKAN_HEADER_BYTES, MAX_CAPACITY);
  checkMemory(memory, FILE_OFFSET + capacity, 3);
  const key = fromHex(request.key);
  if (key.length !== KEY_BYTES) throw Error('Invalid pipeline cache key');

  const handleSlot = memory;
  const sizeSlot = memory + 0x8n;
  const option = memory + 0x10n;
  const mount = memory + 0x20n;
  const path = memory + 0x40n;
  const file = memory + BigInt(FILE_OFFSET);
  const data = file + BigInt(HEADER_BYTES);

  /** @type {Record<string, unknown>} */
  const named = /** @type {Record<string, unknown>} */ (request.functions || {});
  /** @param {string} name */
  function functionAt(name) {
    const pointer = address(named[name]);
    if (!verified.has('0x' + pointer.toString(16))) throw Error('Unverified pipeline cache function: ' + name);
    return pointer;
  }

  // The low 22 bits are module and description; higher bits carry an error context.
  /** @param {bigint} value */
  const resultBase = value => Number(BigInt.asUintN(32, value)) & 0x3fffff;

  /** @param {string} operation @param {bigint} value */
  function success(operation, value) {
    const code = Number(BigInt.asUintN(32, value));
    if (code) throw Error('Pipeline cache ' + operation + ' failed: 0x' + code.toString(16));
  }

  /** @param {Uint8Array} bytes */
  function checksum(bytes) {
    let hash = 2166136261;
    for (let index = 0; index < bytes.length; index++) hash = Math.imul(hash ^ bytes[index], 16777619) >>> 0;
    return hash;
  }

  /** @param {Uint8Array} a @param {Uint8Array} b */
  const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

  /** @param {bigint} pointer */
  const word = pointer => Number(read32(pointer));

  /**
   * The Vulkan header at the start of the cache data, checked against its own length.
   * @param {number} bytes
   */
  function vulkanHeader(bytes) {
    const headerSize = word(data);
    const sizeOk = headerSize >= VULKAN_HEADER_BYTES && headerSize <= bytes;
    const versionOk = word(data + 4n) === VULKAN_HEADER_VERSION;
    if (!sizeOk || !versionOk) return null;

    return {vendor: word(data + 8n), device: word(data + 12n), uuid: toHex(readBuffer(data + 16n, 16))};
  }

  /** @param {number} mode */
  function open(mode) {
    writeBuffer(path, encode(PATH + '\0'));
    const result = call(functionAt('open'), handleSlot, path, BigInt(mode));
    if (resultBase(result) === PATH_NOT_FOUND) return null;
    success('open', result);

    return read64(handleSlot);
  }

  /** @returns {Record<string, unknown>} */
  function load() {
    const handle = open(READ);
    if (handle === null) return {status: 'missing'};

    let size;
    try {
      success('size', call(functionAt('size'), sizeSlot, handle));
      size = Number(read64(sizeSlot));
      const sizeOk = Number.isSafeInteger(size) && size >= HEADER_BYTES + VULKAN_HEADER_BYTES && size <= capacity;
      if (!sizeOk) return {status: 'invalid', reason: 'size', size};

      success('read', call(functionAt('read'), handle, 0n, file, BigInt(size)));
    } finally { call(functionAt('close'), handle); }

    const formatOk = word(file) === MAGIC && word(file + 4n) === VERSION;
    if (!formatOk) return {status: 'invalid', reason: 'format'};

    const bytes = word(file + 8n);
    if (HEADER_BYTES + bytes !== size) return {status: 'invalid', reason: 'length'};

    const stored = word(file + 12n);
    if (checksum(readBuffer(file + BigInt(CHECKED_FROM), size - CHECKED_FROM)) !== stored)
      return {status: 'invalid', reason: 'checksum'};

    if (!same(readBuffer(file + 40n, KEY_BYTES), key)) return {status: 'stale', reason: 'shaders'};

    const header = vulkanHeader(bytes);
    const vendor = word(file + 16n);
    const device = word(file + 20n);
    const uuid = toHex(readBuffer(file + 24n, 16));
    const headerOk = header && header.vendor === vendor && header.device === device && header.uuid === uuid;
    if (!headerOk) return {status: 'invalid', reason: 'vulkan header'};

    return {status: 'loaded', data: '0x' + data.toString(16), bytes, checksum: stored, vendor, device, uuid};
  }

  /** @param {number} total */
  function write(total) {
    let handle = open(WRITE);
    if (handle === null) {
      success('create', call(functionAt('create'), path, BigInt(total)));
      handle = open(WRITE);
      if (handle === null) throw Error('Pipeline cache file disappeared');
    }

    try {
      success('resize', call(functionAt('resize'), handle, BigInt(total)));
      write32(option, 1n);
      success('write', call(functionAt('write'), handle, 0n, file, BigInt(total), option));
      success('flush', call(functionAt('flush'), handle));
    } finally { call(functionAt('close'), handle); }
  }

  /** @returns {Record<string, unknown>} */
  function save() {
    const getData = functionAt('getData');
    const device = argument(request.device);
    const cache = argument(request.cache);
    if (!device || !cache) throw Error('Invalid pipeline cache handles');
    const room = capacity - HEADER_BYTES;

    write64(sizeSlot, 0n);
    success('size query', call(getData, device, cache, sizeSlot, 0n));
    const reported = Number(read64(sizeSlot));
    if (reported < VULKAN_HEADER_BYTES) return {status: 'empty', bytes: reported};
    if (reported > room) return {status: 'too large', bytes: reported};

    success('serialize', call(getData, device, cache, sizeSlot, data));
    const bytes = Number(read64(sizeSlot));
    const header = bytes >= VULKAN_HEADER_BYTES ? vulkanHeader(bytes) : null;
    if (!header) return {status: 'invalid', reason: 'vulkan header'};

    writeBuffer(file, new Uint8Array(HEADER_BYTES));
    write32(file, BigInt(MAGIC));
    write32(file + 4n, BigInt(VERSION));
    write32(file + 8n, BigInt(bytes));
    write32(file + 16n, BigInt(header.vendor));
    write32(file + 20n, BigInt(header.device));
    writeBuffer(file + 24n, readBuffer(data + 16n, 16));
    writeBuffer(file + 40n, key);
    const sum = checksum(readBuffer(file + BigInt(CHECKED_FROM), HEADER_BYTES + bytes - CHECKED_FROM));
    write32(file + 12n, BigInt(sum));
    const found = {bytes, checksum: sum, vendor: header.vendor, device: header.device, uuid: header.uuid};

    const previous = /** @type {{bytes?: unknown, checksum?: unknown} | null | undefined} */ (request.previous);
    const unchanged = previous && previous.bytes === bytes && previous.checksum === sum;
    if (unchanged) return {status: 'unchanged', ...found};

    // Save data is journaled: nothing reaches storage until the mount is committed.
    write(HEADER_BYTES + bytes);
    writeBuffer(mount, encode('save\0'));
    success('commit', call(functionAt('commit'), mount));
    return {status: 'saved', ...found};
  }

  if (request.command === 'pipeline-cache-load') return load();
  if (request.command === 'pipeline-cache-save') return save();
  throw Error('Unknown pipeline cache command');
}
