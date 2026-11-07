import net from 'node:net';
import crypto from 'node:crypto';
import {FrameReader, encodeFrame, isReply, replyArray, replyInteger, replyString, MEMORY_CHUNK_BYTES,
  UPLOAD_CHUNK_BYTES} from './protocol.js';
import {buildPayload} from './payload.js';

/** @import {Civ7Frame, Civ7Reply} from './protocol.js' */

/** @typedef {number | bigint | string} NativeValue */

/**
 * The validated hello frame (see validHello).
 * @typedef {Civ7Frame & {type: 'hello', version: 1, token: string, main: string, sdk: string,
 *   nativeArguments: number, bridgeMs?: number}} Civ7Hello
 */

/**
 * What a journalled cleanup call records; resources.js owns the full entry.
 * @typedef {{key: string, creation?: boolean, expectedResult: number | null}} JournalledCall
 */

/**
 * The part of the resource ledger the transport drives (resources.js createResourceLedger).
 * @typedef {object} AllocationJournal
 * @property {(size: number, alignment: number) => Promise<string>} prepareAllocation
 * @property {(key: string, pointer: number | bigint, bytes: number) => Promise<void>} allocated
 * @property {(pointer: NativeValue) => string | undefined} releaseKey
 * @property {(pointer: NativeValue) => Promise<void>} released
 * @property {(fn: NativeValue, args: NativeValue[]) => JournalledCall | null} findCall
 * @property {(key: string, result?: bigint) => Promise<void>} complete
 * @property {(pointer: NativeValue, fn: NativeValue, args: NativeValue[],
 *   destructors: {fn: NativeValue, args: NativeValue[], expectedResult?: number, terminal?: boolean}[],
 *   expectedResult?: number | null) => Promise<void>} prepare
 * @property {(pointer: NativeValue, fn: NativeValue, args: NativeValue[], expectedResult?: number | null)
 *   => Promise<void>} register
 * @property {(pointer: NativeValue, bytes: number) => Promise<void>} allocate
 * @property {(pointer: NativeValue) => Promise<void>} clearCalls
 */

/**
 * One native call of a plan: an argument is a value or a map of names to pointers.
 * @typedef {{function: NativeValue, args: (NativeValue | Record<string, NativeValue>)[]}} PlannedCall
 */

/** @param {NativeValue} value */
const address = value => '0x' + BigInt(value).toString(16);

/**
 * The allocations the console process still holds, as address to size, or null when the
 * payload does not report them.
 * @param {unknown} reported
 * @returns {Map<string, number> | null}
 */
function heldAllocations(reported) {
  if (!Array.isArray(reported)) return null;

  const held = new Map();
  for (const entry of reported) {
    const addressOk = typeof entry?.address === 'string' && /^0x[0-9a-f]+$/i.test(entry.address);
    const sizeOk = Number.isSafeInteger(entry?.size) && entry.size > 0;
    if (!addressOk || !sizeOk) return null;
    held.set(address(entry.address), /** @type {number} */ (entry.size));
  }

  return held;
}

/**
 * @typedef {object} PendingRequest
 * @property {(reply: Civ7Reply) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {NodeJS.Timeout | undefined} timer
 */

export class Civ7Rpc {
  #socket;
  /** @type {Map<number, PendingRequest>} */
  #pending = new Map();
  #sequence = 0;
  #closed = false;
  #timeout;
  /** @type {Error | undefined} */
  #failure;
  /** @type {(error: Error) => void} */
  #disconnected = () => {};

  /**
   * @param {net.Socket} socket
   * @param {FrameReader} reader
   * @param {Civ7Hello} hello
   */
  constructor(socket, reader, hello, timeoutMs = 30000) {
    this.#socket = socket;
    this.#timeout = timeoutMs;
    this.processSession = typeof hello.session === 'string' && /^[0-9a-f]{32,64}$/.test(hello.session);
    this.a = {main: Number(BigInt(hello.main)), sdk: Number(BigInt(hello.sdk)), target: 'civ7',
      session: this.processSession ? 'civ7:' + hello.session : 'civ7:' + hello.main + ':' + hello.sdk, scratch: 0};
    this.nativeArguments = hello.nativeArguments;
    this.consoleAllocations = heldAllocations(hello.allocations);
    /** Console time from the bridge's start to its hello (startup-timing.js). */
    this.bridgeMs = Number.isFinite(hello.bridgeMs) ? Number(hello.bridgeMs) : null;
    /** @type {Map<string, string>} */
    this.verifiedFunctions = new Map();
    /** @type {AllocationJournal | null} */
    this.resources = null;
    this.output = 0;
    /** @type {Promise<unknown>} */
    this.completion = Promise.resolve();
    /** @type {Promise<Error>} */
    this.disconnected = new Promise(resolve => { this.#disconnected = resolve; });
    socket.setKeepAlive?.(true, 5000);
    reader.on('frame', (/** @type {Civ7Frame} */ reply) => {
      if (!isReply(reply)) return this.#fail(Error('Unexpected Civ7 response'));
      const pending = this.#pending.get(reply.id);
      if (!pending) return this.#fail(Error('Unexpected Civ7 response'));
      this.#pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.ok) pending.resolve(reply);
      else pending.reject(Error(String(reply.error || 'Civ7 command failed')));
    });
    socket.on('close', () => this.#fail(Error('Civ7 control connection closed')));
    socket.on('error', error => this.#fail(error));
  }

  /** @param {Error} error */
  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error;
    this.#disconnected(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#socket.destroy();
  }

  /**
   * @param {{command: string, address?: NativeValue, [field: string]: unknown}} body
   * @param {Buffer} [data] the raw bytes of a write-raw command
   * @returns {Promise<Civ7Reply>}
   */
  request(body, data = undefined, timeoutMs = this.#timeout) {
    if (this.#closed) return Promise.reject(this.#failure ?? Error('Civ7 control connection is closed'));
    const id = ++this.#sequence;
    const normalized = {...body, id};
    if (normalized.address !== undefined) normalized.address = address(normalized.address);
    let frame;
    try {
      frame = encodeFrame(normalized);
      if (data) {
        if (!Buffer.isBuffer(data) || body.command !== 'write-raw' || data.length !== body.length)
          throw Error('Invalid raw upload');
        frame = Buffer.concat([frame, data]);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((/** @type {PendingRequest['resolve']} */ resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => this.#fail(Error('Civ7 command timed out: ' + body.command)), timeoutMs) : undefined;
      this.#pending.set(id, {resolve, reject, timer});
      this.#socket.write(frame, error => {
        if (error) this.#fail(error);
      });
    }).then(reply => {
      if (body.command === 'verify-function' && body.address !== undefined)
        this.verifiedFunctions.set(address(body.address), String(body.hex));
      return reply;
    });
  }

  get connected() { return !this.#closed; }

  disconnect(error = Error('Civ7 control connection is closed')) { this.#fail(error); }

  async initialize() {
    this.output = await this.allocate(0x1000);
    this.a.scratch = await this.allocate(0x30000);
    return this;
  }

  /**
   * @param {number} size
   * @returns {Promise<number>}
   */
  async allocate(size, {align = 0x1000} = {}) {
    if (!Number.isInteger(size) || size < 1 || size > 128 * 1024 * 1024 ||
        !Number.isInteger(align) || align < 8 || align > 2 * 1024 * 1024 || (align & (align - 1)))
      throw Error('Invalid console allocation size or alignment');
    const cleanupKey = await this.resources?.prepareAllocation(size, align);
    const reply = await this.request({command: 'allocate', size, alignment: align,
      ...(cleanupKey ? {cleanupKey} : {})});
    const pointer = Number(replyInteger(reply, 'address'));
    if (cleanupKey) await this.resources?.allocated(cleanupKey, pointer, size);
    return pointer;
  }

  /** @param {number} pointer */
  async release(pointer) {
    const cleanupKey = this.resources?.releaseKey(pointer);
    await this.request({command: 'release', address: pointer, ...(cleanupKey ? {cleanupKey} : {})});
    await this.resources?.released(pointer);
  }

  /** Frees scratch and output best-effort; the first failure is returned, not thrown. */
  async #releaseBuffers() {
    /** @type {unknown} */
    let failure = null;

    if (this.a.scratch) {
      try {
        await this.release(this.a.scratch);
        this.a.scratch = 0;
      } catch (error) {
        failure = error;
      }
    }

    if (this.output) {
      try {
        await this.release(this.output);
        this.output = 0;
      } catch (error) {
        failure ??= error;
      }
    }

    return failure;
  }

  /**
   * @param {number} pointer
   * @param {number} length
   */
  async read(pointer, length) {
    if (!Number.isSafeInteger(length) || length < 0) throw Error('Invalid memory read length');
    const chunks = [];
    for (let offset = 0; offset < length; offset += MEMORY_CHUNK_BYTES) {
      const count = Math.min(length - offset, MEMORY_CHUNK_BYTES);
      const reply = await this.request({command: 'read', address: pointer + offset, length: count});
      const hex = reply.hex;
      if (typeof hex !== 'string' || hex.length !== count * 2 || !/^[0-9a-f]+$/i.test(hex))
        throw Error('Invalid Civ7 memory reply');
      chunks.push(Buffer.from(hex, 'hex'));
    }
    return Buffer.concat(chunks, length);
  }

  /**
   * @param {number} pointer
   * @param {Buffer} bytes
   */
  async write(pointer, bytes) {
    if (!Buffer.isBuffer(bytes)) throw Error('Memory writes require a Buffer');
    for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES);
      await this.request({command: 'write-raw', address: pointer + offset, length: chunk.length}, chunk);
    }
  }

  /**
   * @param {NativeValue} pointer
   * @param {NativeValue[]} args
   * @returns {Promise<{result: bigint, output: Buffer}>}
   */
  async callAddress(pointer, args = [], outputBytes = 0) {
    if (args.length > this.nativeArguments) throw Error('Civ7 supports at most six register arguments');
    const cleanup = this.resources?.findCall(pointer, args);
    const reply = await this.request({command: 'call', address: pointer,
      args: args.map(value => BigInt(value).toString()),
      ...(cleanup ? {cleanupKey: cleanup.key} : {}),
      ...(outputBytes ? {output: {address: address(this.output), length: outputBytes}} : {})});
    const output = outputBytes ? Buffer.from(replyString(reply, 'hex'), 'hex') : Buffer.alloc(0);
    if (output.length !== outputBytes) throw Error('Invalid native output length');
    const result = replyInteger(reply, 'result');
    if (cleanup && (cleanup.creation || cleanup.expectedResult === null ||
        Number(result & 0xffffffffn) === cleanup.expectedResult))
      await this.resources?.complete(cleanup.key, result);
    return {result, output};
  }

  /** @param {{address: NativeValue, args: NativeValue[]}[]} calls */
  async pair(calls) {
    const reply = await this.request({command: 'batch', commands: calls.map(item => ({
      command: 'call', address: address(item.address), args: item.args.map(value => BigInt(value).toString())
    }))});
    return {results: replyArray(reply, 'replies').map(item => replyInteger(asFrame(item), 'result'))};
  }

  /** @param {PlannedCall[]} calls */
  async runCalls(calls) {
    const reply = await this.request({command: 'native-plan', calls: calls.map(item => ({
      address: address(item.function),
      args: item.args.map(value => typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, pointer]) => [key, address(pointer)]))
        : BigInt(value).toString())
    }))});
    return replyArray(reply, 'results').map(value => replyInteger({value}, 'value'));
  }

  /** @param {{steps: object[], read?: object[]}} plan */
  callPlan({steps, read = []}) {
    return this.request({command: 'call-plan', steps, read});
  }

  /**
   * @param {number} offset from the SDK base
   * @param {NativeValue[]} [args]
   * @param {number} [outputBytes]
   */
  call(offset, args, outputBytes) {
    return this.callAddress(this.a.sdk + offset, args, outputBytes);
  }

  async close() {
    if (this.#closed) return;
    const releaseFailure = await this.#releaseBuffers();

    let reply;
    try {
      reply = await this.request({command: 'close'});
    } catch (error) {
      this.#fail(/** @type {Error} */ (error));
      throw releaseFailure ?? error;
    }

    this.#socket.end();
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    try {
      await Promise.race([this.completion, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('CivSwitch loader did not finish the payload')), this.#timeout);
      })]);
    } finally {
      clearTimeout(timer);
    }
    if (releaseFailure) throw releaseFailure;

    return reply;
  }
}

/**
 * @param {unknown} value an element of a reply array
 * @returns {Civ7Frame}
 */
function asFrame(value) {
  if (!value || typeof value !== 'object') throw Error('Invalid Civ7 reply entry');
  return /** @type {Civ7Frame} */ (value);
}

/**
 * @param {Civ7Frame} frame
 * @param {string} token
 * @returns {frame is Civ7Hello}
 */
function validHello(frame, token) {
  const identityOk = frame.type === 'hello' && frame.version === 1 && frame.token === token;
  if (!identityOk || frame.nativeArguments !== 6) return false;

  const {main, sdk} = frame;
  if (typeof main !== 'string' || typeof sdk !== 'string') return false;
  if (!/^0x[0-9a-f]+$/i.test(main) || !/^0x[0-9a-f]+$/i.test(sdk)) return false;

  return BigInt(main) < (1n << 39n) && BigInt(sdk) < (1n << 39n);
}

/**
 * @param {string} consoleHost
 * @param {number} consolePort
 * @param {string} source
 * @param {(text: string) => void} log
 * @param {number} timeoutMs
 */
async function upload(consoleHost, consolePort, source, log, timeoutMs) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const socket = net.connect(consolePort, consoleHost);
    socket.setTimeout(timeoutMs);
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
        socket.once('timeout', () => reject(Error('CivSwitch connection timed out')));
      });
    } catch (error) {
      socket.destroy();
      if (attempt === 2) throw error;
      continue;
    }
    socket.setTimeout(0);
    socket.on('data', bytes => log(bytes.toString('utf8')));
    socket.on('error', error => log('CivSwitch loader: ' + error.message + '\n'));
    socket.end(source);
    return socket;
  }
  throw Error('CivSwitch connection failed');
}

/** @param {{port?: number, token: string, timeoutMs?: number, waitMs?: number}} options */
export async function listenForPayload({port = 39380, token, timeoutMs = 30000, waitMs = 0}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !/^[0-9a-f]{64}$/.test(token))
    throw Error('Invalid payload listener configuration');
  const server = net.createServer();
  /** @type {Set<net.Socket>} */
  const candidates = new Set();
  /** @type {(error: Error) => void} */
  let rejectConnection = () => {};
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {Promise<Civ7Rpc>} */
  const connected = new Promise((resolve, reject) => {
    rejectConnection = reject;
    server.on('error', reject);
    if (waitMs > 0) timer = setTimeout(() => reject(Error('Moonlight payload did not connect')), waitMs);
    server.on('connection', socket => {
      candidates.add(socket);
      socket.setNoDelay(true);
      socket.on('error', () => {});
      socket.on('close', () => candidates.delete(socket));
      const reader = new FrameReader();
      socket.on('data', chunk => {
        try { reader.feed(chunk); }
        catch (error) { socket.destroy(/** @type {Error} */ (error)); }
      });
      reader.once('frame', (/** @type {Civ7Frame} */ hello) => {
        if (!validHello(hello, token)) {
          socket.destroy();
          return;
        }
        candidates.delete(socket);
        clearTimeout(timer);
        server.close();
        for (const candidate of candidates) candidate.destroy();
        const rpc = new Civ7Rpc(socket, reader, hello, timeoutMs);
        rpc.completion = new Promise(done => socket.once('close', done));
        resolve(rpc);
      });
    });
  });
  connected.catch(() => {});
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => resolve(undefined));
    });
  } catch (error) {
    clearTimeout(timer);
    server.close();
    throw error;
  }
  const endpoint = server.address();
  if (!endpoint || typeof endpoint === 'string') throw Error('Invalid payload listener address');
  return {port: endpoint.port, connected,
    close() {
      clearTimeout(timer);
      rejectConnection(Error('Moonlight payload listener closed'));
      server.close();
      for (const candidate of candidates) candidate.destroy();
    }};
}

/**
 * @param {{consoleHost: string, hostAddress: string, consolePort?: number, port?: number,
 *   timeoutMs?: number, nativeStackBytes?: number, log?: (text: string) => void}} options
 */
export async function attach({consoleHost, hostAddress, consolePort = 9026, port = 39380,
  timeoutMs = 30000, nativeStackBytes = 0x100000, log = () => {}}) {
  if (!net.isIPv4(consoleHost) || !net.isIPv4(hostAddress)) throw Error('Moonlight requires LAN IPv4 addresses');
  if (nativeStackBytes !== 0 && (!Number.isInteger(nativeStackBytes) ||
      nativeStackBytes < 0x10000 || nativeStackBytes > 0x800000 || nativeStackBytes % 16))
    throw Error('Invalid native stack size');
  if (!Number.isInteger(consolePort) || consolePort < 1 || consolePort > 65535)
    throw Error('Invalid console port');
  const token = crypto.randomBytes(32).toString('hex');
  const listener = await listenForPayload({port, token, timeoutMs, waitMs: timeoutMs});
  /** @type {net.Socket | undefined} */
  let loader;
  try {
    const configuration = {host: hostAddress, port: listener.port, token, nativeStackBytes};
    loader = await upload(consoleHost, consolePort, buildPayload(configuration), log, Math.min(timeoutMs, 12000));
    const completion = new Promise(resolve => loader?.once('close', resolve));
    const rpc = await listener.connected;
    rpc.completion = completion;
    await rpc.initialize();
    return rpc;
  } catch (error) {
    loader?.destroy();
    throw error;
  } finally { listener.close(); }
}
