import {sdkResolver} from './sdk.js';

/** @import {Civ7Rpc, NativeValue} from './transport.js' */
/** @import {ConsoleNative} from './console-runtime.js' */

/** The BSD values Horizon's socket ABI uses: civ7/README.md, "Socket buffers". */
export const SOCKET_OPTION = {solSocket: 0xffff, receiveBuffer: 0x1002};

/** Tried in order until SetSockOpt accepts one; the stack may cap the largest. */
export const RECEIVE_BUFFER_BYTES = [0x100000, 0x80000, 0x40000];

/** Where the console leaves its report in a stream header, past the ack, record and timing. */
export const REPORT_OFFSET = 0xf80;
/** The four report words, then the length and UTF-8 text of a setter error; ends the header. */
export const REPORT_BYTES = 0x80;
const REPORT_MAGIC = 0x31564352;

/**
 * What a request carries for setReceiveBuffer; the console re-checks every field.
 * @typedef {{set: string, get: string, errno?: string, scratch: string, bytes: number[]}} ReceiveBufferRequest
 */

/**
 * The console's answer: the size SetSockOpt took (null when it refused all), what GetSockOpt
 * read back (null when it failed), the errno of the last refusal and the message of a setter
 * exception, which leaves the socket on its default buffer.
 * @typedef {{requested: number | null, effective: number | null, errno?: number, error?: string}} ReceiveBufferReport
 */

/** @param {NativeValue} value */
const hex = value => '0x' + BigInt(value).toString(16);

/**
 * Verifies SetSockOpt and GetSockOpt (and GetLastErrno) and returns what a request carries,
 * or null when either signature does not match, so the socket keeps its default buffer.
 * @param {Pick<Civ7Rpc, 'a' | 'request'>} rpc
 * @param {NativeValue} scratch REPORT_BYTES writable bytes on the console
 * @param {{resolve?: (name: string) => Promise<number>, bytes?: number[]}} [options]
 * @returns {Promise<ReceiveBufferRequest | null>}
 */
export async function receiveBufferRequest(rpc, scratch, {resolve = sdkResolver(rpc), bytes = RECEIVE_BUFFER_BYTES} = {}) {
  try {
    const set = await resolve('SetSockOpt');
    const get = await resolve('GetSockOpt');
    const errno = await resolve('GetLastErrno');
    return {set: hex(set), get: hex(get), errno: hex(errno), scratch: hex(scratch), bytes};
  } catch {
    return null;
  }
}

/**
 * Reads the report setReceiveBuffer left at `scratch`, or null if it never ran there.
 * @param {Uint8Array} bytes the REPORT_BYTES at the request's scratch
 * @returns {ReceiveBufferReport | null}
 */
export function readReceiveBufferReport(bytes) {
  if (bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12, true) !== REPORT_MAGIC) return null;

  const requested = view.getUint32(8, true);
  const effective = view.getUint32(0, true);
  const errno = view.getUint32(4, true);
  const errorBytes = bytes.length >= 20 ? Math.min(view.getUint32(16, true), bytes.length - 20) : 0;
  const error = errorBytes ? new TextDecoder().decode(bytes.subarray(20, 20 + errorBytes)) : '';
  return {requested: requested || null, effective: effective || null, ...(errno ? {errno} : {}),
    ...(error ? {error} : {})};
}

/**
 * Console side, shipped by payload.js: sets SO_RCVBUF on `channel` before connect, trying each
 * size until one is accepted, then reads the effective value back. Leaves the report at
 * `scratch` (u32 effective, errno, requested, magic, error length, error text) for the PC and
 * returns it. Never throws: the socket then keeps its default buffer and the report names why.
 * call_rop stores every argument in a BigUint64Array, so each one is a bigint.
 * @param {Pick<ConsoleNative, 'address' | 'integer' | 'checkMemory' | 'verified' | 'call' | 'read32' |
 *   'writeBuffer' | 'encode'>} native
 * @param {bigint} channel
 * @param {ReceiveBufferRequest} request
 * @returns {ReceiveBufferReport | null}
 */
export function setReceiveBuffer(native, channel, request) {
  const {address, integer, checkMemory, verified, call, read32, writeBuffer, encode} = native;
  const solSocket = 0xffffn;
  const receiveBuffer = 0x1002n;
  const magic = 0x31564352;
  const reportBytes = 0x80;
  const succeeded = (/** @type {bigint} */ result) => (result & 0xffffffffn) === 0n;
  let scratch = -1n;
  let requested = 0;
  let effective = 0;
  let refusal = 0;
  let error = '';

  /** False when a function is not verified, so the request is skipped without a report. */
  function apply() {
    const set = address(request.set);
    const get = address(request.get);
    const errno = request.errno === undefined ? null : address(request.errno);
    const known = (/** @type {bigint} */ value) => verified.has('0x' + value.toString(16));
    const errnoKnown = errno === null || known(errno);
    if (!known(set) || !known(get) || !errnoKnown) return false;

    if (!Array.isArray(request.bytes) || request.bytes.length < 1 || request.bytes.length > 8)
      throw Error('Invalid receive buffer sizes');
    const sizes = request.bytes.map(value => integer(value, 0x1000, 0x1000000));
    const target = address(request.scratch);
    checkMemory(target, reportBytes, 3);
    scratch = target;

    const word = new Uint8Array(8);
    const view = new DataView(word.buffer);
    for (const size of sizes) {
      view.setUint32(0, size, true);
      writeBuffer(scratch, word.subarray(0, 4));
      if (succeeded(call(set, channel, solSocket, receiveBuffer, scratch, 4n))) {
        requested = size;
        break;
      }
      refusal = errno === null ? 0 : Number(call(errno) & 0xffffffffn);
    }

    view.setUint32(0, 0, true);
    view.setUint32(4, 4, true);
    writeBuffer(scratch, word);
    const read = succeeded(call(get, channel, solSocket, receiveBuffer, scratch, scratch + 4n));
    effective = read ? Number(read32(scratch)) : 0;
    return true;
  }

  try {
    if (!apply()) return null;
  } catch (failure) {
    error = String(/** @type {{message?: unknown}} */ (failure)?.message || failure);
  }

  const result = {requested: requested || null, effective: effective || null,
    ...(refusal ? {errno: refusal} : {}), ...(error ? {error} : {})};
  if (scratch < 0n) return result;

  try {
    const text = encode(error).subarray(0, reportBytes - 20);
    const report = new Uint8Array(reportBytes);
    const view = new DataView(report.buffer);
    view.setUint32(0, effective, true);
    view.setUint32(4, refusal, true);
    view.setUint32(8, requested, true);
    view.setUint32(12, magic, true);
    view.setUint32(16, text.length, true);
    report.set(text, 20);
    writeBuffer(scratch, report);
  } catch {}
  return result;
}

/**
 * Reads each console report once the sockets are connected; a failed read reports null.
 * @param {Pick<Civ7Rpc, 'read'>} rpc
 * @param {Record<string, ReceiveBufferRequest | null | undefined>} requests
 */
export async function receiveBufferReports(rpc, requests) {
  /** @type {Record<string, ReceiveBufferReport | null>} */
  const reports = {};
  for (const [name, request] of Object.entries(requests)) {
    if (!request) continue;

    try {
      reports[name] = readReceiveBufferReport(await rpc.read(Number(BigInt(request.scratch)), REPORT_BYTES));
    } catch {
      reports[name] = null;
    }
  }
  return reports;
}
