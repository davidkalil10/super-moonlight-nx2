// Console settings in Civ7's own save data, two checked generations (README "Settings").
// Shipped by source text: everything it needs lives inside the function.

/** @import {ConsoleNative} from './console-runtime.js' */

/**
 * One saved generation; `checksum` covers generation and settings.
 * @typedef {{version: 1, generation: number, settings: unknown, checksum: number}} SettingsRecord
 */

/**
 * @template Settings
 * @param {Pick<ConsoleNative, 'address' | 'checkMemory' | 'verified' | 'call' | 'read64' | 'write32' |
 *   'writeBuffer' | 'readMemory' | 'encode' | 'decode'>} native
 * @param {{memory: unknown, functions: Record<string, unknown>}} configuration
 * @param {{sanitize: (value: unknown) => Settings}} rules
 */
export function createSettingsStore(native, configuration, rules) {
  const {address, checkMemory, verified, call, read64, write32, writeBuffer, readMemory, encode, decode} = native;
  const memory = address(configuration.memory);
  checkMemory(memory, 0x2000, 3);
  /** @type {Record<string, bigint>} */
  const functions = {};
  for (const name of ['commit', 'open', 'read', 'write', 'size', 'create', 'close', 'resize', 'flush']) {
    const pointer = address(configuration.functions[name]);
    if (!verified.has('0x' + pointer.toString(16))) throw Error('Unverified filesystem function: ' + name);
    functions[name] = pointer;
  }

  // Civ7 keeps its save data mounted as "save" for the whole process; the title
  // has no SD card access (MountSdCard returns 2002-6400). Never unmount it.
  const mount = memory + 0x100n;
  const path = memory + 0x200n;
  const data = memory + 0x1000n;
  const option = memory + 0x80n;
  const PATH_NOT_FOUND = 0x202;
  let generation = 0;
  const text = (/** @type {bigint} */ pointer, /** @type {string} */ value) => writeBuffer(pointer, encode(value + '\0'));
  text(mount, 'save');
  write32(option, 1n);

  // The low 22 bits are module and description; higher bits carry an error context.
  /** @param {bigint} value */
  function resultOf(value) {
    const code = Number(BigInt.asUintN(32, value));
    return {code, base: code & 0x3fffff};
  }

  /** @param {{code: number, base: number}} result */
  function describe({code, base}) {
    const module = base & 0x1ff;
    const description = base >>> 9;
    return (2000 + module) + '-' + String(description).padStart(4, '0') + ' (0x' + code.toString(16) + ')';
  }

  /**
   * @param {string} operation
   * @param {bigint[]} args
   */
  function success(operation, ...args) {
    const result = resultOf(call(functions[operation], ...args));
    if (result.code) throw Error('Settings ' + operation + ' failed: ' + describe(result));
  }

  /**
   * @param {number} generation
   * @param {unknown} settings
   */
  function checksum(generation, settings) {
    const value = JSON.stringify({generation, settings});
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++)
      hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
    return hash;
  }

  /**
   * @param {number} slot
   * @param {number} mode
   */
  function open(slot, mode) {
    text(path, 'save:/moonlight-settings-' + slot + '.json');
    const result = resultOf(call(functions.open, memory, path, BigInt(mode)));
    if (result.base === PATH_NOT_FOUND) return null;
    if (result.code) throw Error('Settings open failed: ' + describe(result));

    return read64(memory);
  }

  /**
   * @param {unknown} value
   * @returns {value is SettingsRecord}
   */
  function isValidRecord(value) {
    if (!value || typeof value !== 'object') return false;

    const record = /** @type {Record<string, unknown>} */ (value);
    if (record.version !== 1) return false;

    const saved = record.generation;
    const generationOk = typeof saved === 'number' && Number.isSafeInteger(saved) && saved >= 1;
    if (!generationOk) return false;

    return record.checksum === checksum(saved, record.settings);
  }

  /**
   * @param {number} slot
   * @returns {SettingsRecord | null}
   */
  function read(slot) {
    const handle = open(slot, 1);
    if (handle === null) return null;

    try {
      success('size', memory + 8n, handle);
      const size = Number(read64(memory + 8n));
      if (!Number.isSafeInteger(size) || size < 1 || size > 4096) return null;

      success('read', handle, 0n, data, BigInt(size));
      /** @type {unknown} */
      let record;
      try { record = JSON.parse(decode(readMemory(data, size))); }
      catch { return null; }
      return isValidRecord(record) ? record : null;
    } finally { call(functions.close, handle); }
  }

  /**
   * @param {number} slot
   * @param {Uint8Array} bytes
   */
  function write(slot, bytes) {
    let handle = open(slot, 2);
    if (handle === null) {
      success('create', path, BigInt(bytes.length));
      handle = open(slot, 2);
      if (handle === null) throw Error('Settings file disappeared');
    }

    try {
      success('resize', handle, BigInt(bytes.length));
      writeBuffer(data, bytes);
      success('write', handle, 0n, data, BigInt(bytes.length), option);
      success('flush', handle);
    } finally { call(functions.close, handle); }
  }

  return {
    load() {
      /** @type {SettingsRecord[]} */
      const records = [];
      /** @type {unknown[]} */
      const failures = [];
      for (const slot of [0, 1]) {
        try {
          const record = read(slot);
          if (record) records.push(record);
        } catch (error) { failures.push(error); }
      }
      if (!records.length) {
        if (failures.length) throw failures[0];
        return null;
      }

      records.sort((a, b) => b.generation - a.generation);
      generation = records[0].generation;
      return rules.sanitize(records[0].settings);
    },
    /** @param {unknown} value */
    save(value) {
      const settings = rules.sanitize(value);
      const next = generation + 1;
      if (!Number.isSafeInteger(next)) throw Error('Settings generation exhausted');
      const bytes = encode(JSON.stringify({version: 1, generation: next, settings,
        checksum: checksum(next, settings)}));
      if (bytes.length > 4096) throw Error('Settings exceed storage limit');

      // Save data is journaled: nothing reaches storage until the mount is committed.
      write(next & 1, bytes);
      success('commit', mount);

      generation = next;
    }
  };
}
