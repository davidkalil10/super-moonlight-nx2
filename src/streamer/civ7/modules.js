import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import shippedTable from './compat-functions.json' with {type: 'json'};
import {replyArray, replyInteger} from './protocol.js';

/** @import {Civ7Rpc} from './transport.js' */
/** @import {Civ7Frame} from './protocol.js' */

/** @typedef {{name: string, type: number, section: number, offset: number, size: number}} ModuleSymbol */

/**
 * A module as the startup stages read it: captured, cached or made from the shipped table.
 * @typedef {{name: string, base: number, imageSize: number, symbols: ModuleSymbol[], hash?: string,
 *   source?: string, spans?: {offset: number, bytes: number, sha256: string}[]}} ModuleDescription
 */

/** @typedef {typeof shippedTable} CompatTable */

const execute = promisify(execFile);
const IMAGE_LIMIT = 512 * 1024 * 1024;
const TABLE_LIMIT = 64 * 1024 * 1024;

/**
 * One `memory-map` region, its base and size as numbers.
 * @param {unknown} value
 */
function memoryRegion(value) {
  if (!value || typeof value !== 'object') throw Error('Invalid console memory map');
  const region = /** @type {Civ7Frame} */ (value);
  const permissions = region.permissions;
  if (typeof permissions !== 'number') throw Error('Invalid console memory map');

  return {base: Number(replyInteger(region, 'base')), size: Number(replyInteger(region, 'size')), permissions};
}

/**
 * @param {Pick<Civ7Rpc, 'request' | 'read'>} rpc
 * @param {string} name
 */
export async function findModule(rpc, name) {
  const regions = replyArray(await rpc.request({command: 'memory-map'}), 'regions').map(memoryRegion);
  for (const region of regions.filter(item => item.permissions & 4)) {
    const base = region.base;
    const textEnd = base + region.size;
    const next = regions.find(item => item.base === textEnd);
    if (!next || !(next.permissions & 1)) continue;
    const header = await rpc.read(textEnd, 128);
    const index = header.indexOf(Buffer.from(name));
    if (index < 0 || (index > 0 && header[index - 1] !== 0)) continue;
    const end = index + name.length;
    if (header[end] === 0 || header.subarray(end, end + 4).toString() === 'MOD0') return base;
  }
  throw Error('Loaded module not found: ' + name);
}

/**
 * Reads nnCompat's MOD0, dynamic, hash, symbol and string tables into a zero-filled image and
 * checks it with the libnx2 inspector.
 * @param {Pick<Civ7Rpc, 'read'>} rpc
 * @param {{base: number, name: string, directory: string, inspector: string}} options
 */
export async function captureModule(rpc, {base, name, directory, inspector}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw Error('Invalid module name');
  const header = await rpc.read(base, 16);
  const modOffset = header.readUInt32LE(4);
  if (modOffset < 8 || modOffset >= IMAGE_LIMIT) throw Error('Invalid MOD0 offset');
  const mod = await rpc.read(base + modOffset, 28);
  if (mod.subarray(0, 4).toString() !== 'MOD0') throw Error('Missing MOD0 header');
  const dynamicOffset = modOffset + mod.readUInt32LE(4);
  const imageSize = modOffset + mod.readUInt32LE(12);
  if (imageSize <= dynamicOffset || imageSize > IMAGE_LIMIT) throw Error('Invalid mapped image bounds');

  const image = Buffer.alloc(imageSize);
  /** @type {{offset: number, bytes: number, sha256: string}[]} */
  const spans = [];
  /**
   * @param {number} offset
   * @param {Buffer} bytes
   */
  function retain(offset, bytes) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + bytes.length > imageSize)
      throw Error('Module metadata exceeds image bounds');
    bytes.copy(image, offset);
    spans.push({offset, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')});
  }
  /**
   * @param {number} offset
   * @param {number} length
   */
  async function read(offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) ||
        length < 1 || length > TABLE_LIMIT || offset + length > imageSize)
      throw Error('Invalid module metadata range');
    const bytes = await rpc.read(base + offset, length);
    retain(offset, bytes);
    return bytes;
  }
  retain(0, header);
  retain(modOffset, mod);
  /** @type {Map<number, number>} */
  const tags = new Map();
  let ended = false;
  for (let index = 0; index < 128; index++) {
    const entry = await read(dynamicOffset + index * 16, 16);
    const tag = entry.readBigUInt64LE();
    if (tag === 0n) {
      ended = true;
      break;
    }
    tags.set(Number(tag), Number(entry.readBigUInt64LE(8)));
  }
  if (!ended || tags.get(11) !== 24) throw Error('Unsupported module dynamic tables');
  const hashTable = tags.get(4);
  const stringTable = tags.get(5);
  const symbolTable = tags.get(6);
  const stringBytes = tags.get(10);
  if (hashTable === undefined || stringTable === undefined || symbolTable === undefined || stringBytes === undefined)
    throw Error('Unsupported module dynamic tables');
  const hash = await read(hashTable, 8);
  const buckets = hash.readUInt32LE();
  const count = hash.readUInt32LE(4);
  await read(hashTable, 8 + 4 * (buckets + count));
  const symbolBytes = await read(symbolTable, count * 24);
  const strings = await read(stringTable, stringBytes);
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const filename = path.join(directory, name + '-metadata.bin');
  await fs.writeFile(filename, image, {mode: 0o600});
  const validation = await execute(inspector, [filename, '0x' + base.toString(16)], {maxBuffer: 1024 * 1024});
  await fs.writeFile(path.join(directory, name + '-libnx2.log'), validation.stdout + validation.stderr);
  /** @type {ModuleSymbol[]} */
  const symbols = [];
  for (let index = 0; index < count; index++) {
    const entry = symbolBytes.subarray(index * 24, (index + 1) * 24);
    const start = entry.readUInt32LE();
    const end = strings.indexOf(0, start);
    if (start >= strings.length || end < start) throw Error('Invalid module symbol name');
    symbols.push({name: strings.subarray(start, end).toString('utf8'), type: entry[4] & 15,
      section: entry.readUInt16LE(6), offset: Number(entry.readBigUInt64LE(8)), size: Number(entry.readBigUInt64LE(16))});
  }
  const module = {name, base, imageSize, symbols, metadataOnly: true, spans,
    validation: 'libnx2 moduleReadImage', omittedBytes: 'zero-filled; not a full memory capture'};
  await fs.writeFile(path.join(directory, name === 'nnCompat' ? 'compatibility-module.json' : name + '-module.json'),
    JSON.stringify(module, null, 2) + '\n', {mode: 0o600});
  return module;
}

const ELF_FUNCTION_TYPE = 2;
/** @param {number | bigint} value */
const address = value => '0x' + BigInt(value).toString(16);

/**
 * The module description the startup stages read, made from the shipped table.
 * @param {CompatTable} table
 * @param {number} base
 * @returns {ModuleDescription}
 */
function tableModule(table, base) {
  const symbols = Object.values(table.functions).map(entry => ({name: entry.symbol,
    type: ELF_FUNCTION_TYPE, section: table.module.section, offset: entry.offset, size: entry.size}));
  return {name: table.module.name, base, imageSize: table.module.imageSize, hash: table.module.hash,
    symbols, source: 'compat-functions'};
}

/** @typedef {{hash: string, imageSize: unknown, symbols: unknown}} ModuleProbe */

/**
 * @param {ModuleProbe} probe
 * @param {CompatTable} table
 */
function matchesTable(probe, table) {
  const hashOk = probe.hash === table.module.hash;
  const sizeOk = probe.imageSize === table.module.imageSize && probe.symbols === table.module.symbols;
  return hashOk && sizeOk;
}

/**
 * @param {string} file
 * @param {ModuleProbe} probe
 * @returns {Promise<ModuleDescription | null>}
 */
async function readCache(file, probe) {
  /** @type {{hash?: unknown, imageSize?: unknown, symbols?: unknown}} */
  let cached;
  try { cached = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const identityOk = cached.hash === probe.hash && cached.imageSize === probe.imageSize;
  if (!identityOk || !Array.isArray(cached.symbols)) throw Error('Compatibility cache entry is invalid: ' + file);
  return /** @type {ModuleDescription} */ (cached);
}

/**
 * @param {string} file
 * @param {object} module
 */
async function writeCache(file, module) {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = file + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(module) + '\n', {mode: 0o600});
  await fs.rename(temporary, file);
}

/**
 * Console startup: the console hashes nnCompat's tables; a match
 * with the shipped table verifies its functions there and skips the capture, otherwise the
 * capture runs once and is kept in `cache` under the hash.
 * @param {Pick<Civ7Rpc, 'request' | 'read' | 'verifiedFunctions'>} rpc
 * @param {{directory: string, cache: string, inspector?: string, table?: CompatTable,
 *   log?: (event: object) => void}} options
 * @returns {Promise<{module: ModuleDescription, source: 'table' | 'cache' | 'capture', hash: string}>}
 */
export async function resolveCompatibility(rpc, {directory, cache, inspector, table = shippedTable, log = () => {}}) {
  const name = table.module.name;
  const probing = performance.now();
  const reply = await rpc.request({command: 'module-probe', name});
  const probeMs = Math.round(performance.now() - probing);
  const base = Number(replyInteger(reply, 'base'));
  if (typeof reply.hash !== 'string') throw Error('Invalid module hash');
  /** @type {ModuleProbe} */
  const probe = {hash: reply.hash, imageSize: reply.imageSize, symbols: reply.symbols};
  const target = path.join(directory, 'compatibility-module.json');

  if (matchesTable(probe, table)) {
    const functions = Object.values(table.functions).map(entry =>
      ({name: entry.symbol, offset: entry.offset, hex: entry.hex}));
    const verifying = performance.now();
    await rpc.request({command: 'verify-functions', base: address(base), functions});
    const verifyMs = Math.round(performance.now() - verifying);
    for (const entry of functions) rpc.verifiedFunctions?.set(address(base + entry.offset), entry.hex);
    const module = tableModule(table, base);
    await fs.writeFile(target, JSON.stringify(module), {mode: 0o600});
    log({event: 'compatibility', source: 'table', hash: probe.hash, probeMs, verifyMs,
      probeCached: reply.cached === true});
    return {module, source: 'table', hash: probe.hash};
  }

  if (!/^[0-9a-f]{8}$/.test(probe.hash)) throw Error('Invalid module hash');
  const file = path.join(cache, probe.hash + '.json');
  const cached = await readCache(file, probe);
  if (cached) {
    const module = {...cached, base};
    await fs.writeFile(target, JSON.stringify(module), {mode: 0o600});
    log({event: 'compatibility', source: 'cache', hash: probe.hash});
    return {module, source: 'cache', hash: probe.hash};
  }

  if (!inspector) throw Error('Capturing ' + name + ' needs the libnx2 inspector');
  const captured = await captureModule(rpc, {base, name, directory, inspector});
  if (captured.imageSize !== probe.imageSize || captured.symbols.length !== probe.symbols)
    throw Error('Captured module differs from the console probe');
  const {spans, ...rest} = captured;
  await writeCache(file, {...rest, hash: probe.hash});
  log({event: 'compatibility', source: 'capture', hash: probe.hash});
  return {module: captured, source: 'capture', hash: probe.hash};
}

const SIGNATURE_BYTES = 32;

/**
 * Function addresses from the module resolveCompatibility wrote. The table source verified
 * every function already; a cached or captured module verifies each on first use.
 * @param {Pick<Civ7Rpc, 'request' | 'read' | 'verifiedFunctions'>} rpc
 * @param {{name?: string, base: number, symbols: {name: string, offset: number, size: number}[]}} module
 * @returns {(name: string) => Promise<number>}
 */
export function functionResolver(rpc, module) {
  const symbols = new Map(module.symbols.map(symbol => [symbol.name, symbol]));
  /** @type {Map<string, Promise<number>>} */
  const resolved = new Map();

  /** @param {string} name */
  async function verify(name) {
    const symbol = symbols.get(name);
    if (!symbol) throw Error(module.name + ' has no ' + name);
    const pointer = Number(module.base) + symbol.offset;
    if (rpc.verifiedFunctions?.has(address(pointer))) return pointer;

    const hex = (await rpc.read(pointer, Math.min(SIGNATURE_BYTES, symbol.size))).toString('hex');
    await rpc.request({command: 'verify-function', address: address(pointer), hex});
    rpc.verifiedFunctions?.set(address(pointer), hex);
    return pointer;
  }

  return name => {
    let pending = resolved.get(name);
    if (!pending) {
      pending = verify(name);
      resolved.set(name, pending);
    }
    return pending;
  };
}
