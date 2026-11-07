// `audio-out`: opens the stream's AudioOut and keeps, in window.__moonlightState, the one this
// process holds open, so a later attach closes it before opening again (audio.js).
// Shipped by toString(): everything it uses arrives through `native`.

/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */

/**
 * @typedef {{address: string, hex: string}} AudioOutFunction
 *
 * @typedef {object} AudioOutRecord
 * @property {number} version
 * @property {string} memory The AudioOut object, hex.
 * @property {Record<'stop' | 'flush' | 'released' | 'close', AudioOutFunction>} functions
 */

/**
 * Actions: `status`; `open` records the AudioOut before the open call and keeps it only on
 * result 0; `close` stops, flushes, drains and closes the recorded AudioOut and drops the record.
 * `close` with nothing recorded closes nothing, and a close that throws keeps the record.
 * @param {Pick<ConsoleNative, 'address' | 'checkMemory' | 'readMemory' | 'fromHex' | 'verified' | 'call'> &
 *   {state: {audioOut?: AudioOutRecord | null}}} native
 * @param {ConsoleRequest} request
 */
export function audioOutCommand(native, request) {
  const {address, checkMemory, readMemory, fromHex, verified, call, state} = native;
  const VERSION = 1;
  const CLEANUP = /** @type {const} */ (['stop', 'flush', 'released', 'close']);
  const OBJECT_BYTES = 0x200;
  const PARAMETER_BYTES = 8;
  const MAX_RELEASED = 32;
  /** @param {bigint} value */
  const text = value => '0x' + value.toString(16);

  /**
   * @param {bigint} pointer
   * @param {unknown} hex
   */
  function signatureMatches(pointer, hex) {
    const expected = fromHex(hex);
    if (pointer % 4n || expected.length < 4 || expected.length > 256 || expected.length % 4)
      throw Error('Invalid AudioOut function signature');

    checkMemory(pointer, expected.length, 5);
    const actual = readMemory(pointer, expected.length);
    return actual.every((value, index) => value === expected[index]);
  }

  /**
   * @param {unknown} described
   * @param {string} name
   * @returns {AudioOutFunction}
   */
  function verifiedFunction(described, name) {
    if (!described || typeof described !== 'object') throw Error('Missing AudioOut function: ' + name);
    const value = /** @type {ConsoleRequest} */ (described);
    const pointer = address(value.address);
    if (!verified.has(text(pointer))) throw Error('AudioOut function was not verified: ' + name);
    if (!signatureMatches(pointer, value.hex)) throw Error('AudioOut signature mismatch at ' + text(pointer));
    return {address: text(pointer), hex: String(value.hex).toLowerCase()};
  }

  /** @param {AudioOutFunction} fn @param {bigint} memory */
  function run(fn, memory) {
    const pointer = address(fn.address);
    if (!signatureMatches(pointer, fn.hex)) throw Error('AudioOut signature mismatch at ' + fn.address);
    return call(pointer, memory);
  }

  function open() {
    if (state.audioOut) throw Error('An AudioOut is still open at ' + state.audioOut.memory + '; close it first');
    const memory = address(request.memory);
    const parameter = address(request.parameter);
    checkMemory(memory, OBJECT_BYTES, 3);
    checkMemory(parameter, PARAMETER_BYTES, 3);

    const described = /** @type {ConsoleRequest} */ (request.functions || {});
    const opener = verifiedFunction(described.open, 'open');
    const functions = /** @type {AudioOutRecord['functions']} */ ({});
    for (const name of CLEANUP) functions[name] = verifiedFunction(described[name], name);

    state.audioOut = {version: VERSION, memory: text(memory), functions};
    let result;
    try {
      result = BigInt.asUintN(64, call(address(opener.address), memory, parameter));
    } finally {
      if (result !== 0n) state.audioOut = null;
    }
    return {result: text(result), record: state.audioOut};
  }

  function close() {
    const record = state.audioOut;
    if (!record) return {closed: false};
    if (request.memory !== undefined && address(request.memory) !== BigInt(record.memory))
      throw Error('The recorded AudioOut is at ' + record.memory);

    const memory = BigInt(record.memory);
    run(record.functions.stop, memory);
    run(record.functions.flush, memory);
    for (let index = 0; index < MAX_RELEASED; index++)
      if (run(record.functions.released, memory) === 0n) break;
    run(record.functions.close, memory);
    state.audioOut = null;
    return {closed: true, memory: record.memory};
  }

  switch (request.action) {
    case 'status':
      return {record: state.audioOut || null};
    case 'open':
      return open();
    case 'close':
      return close();
    default:
      throw Error('Invalid audio-out action');
  }
}
