import {timingSafeEqual} from 'node:crypto';

export const CONTROL = Object.freeze({
  magic: 0x31434e4d,
  version: 1,
  headerBytes: 16,
  maxPayload: 65536,
  auth: 1,
  accepted: 2,
  request: 3,
  event: 4,
  stream: 5,
  error: 6
});

/** @param {number} kind @param {number} id @param {number} length */
function validate(kind, id, length) {
  if (!Number.isInteger(kind) || kind < CONTROL.auth || kind > CONTROL.error)
    throw Error('Unknown native control frame kind');
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff)
    throw Error('Invalid native control request ID');
  if (!Number.isInteger(length) || length < 1 || length > CONTROL.maxPayload)
    throw Error('Invalid native control payload length');
  if (kind === CONTROL.auth && (id !== 0 || length !== 64))
    throw Error('Invalid native control authentication frame');
}

/** @param {number} kind @param {number} id @param {Uint8Array} payload */
export function encodeControlFrame(kind, id, payload) {
  validate(kind, id, payload.byteLength);
  const frame = Buffer.alloc(CONTROL.headerBytes + payload.byteLength);
  frame.writeUInt32LE(CONTROL.magic);
  frame.writeUInt16LE(CONTROL.version, 4);
  frame.writeUInt16LE(kind, 6);
  frame.writeUInt32LE(id, 8);
  frame.writeUInt32LE(payload.byteLength, 12);
  frame.set(payload, CONTROL.headerBytes);
  return frame;
}

/** @typedef {{kind: number, id: number, payload: Buffer}} ControlFrame */

export class ControlParser {
  #header = Buffer.alloc(CONTROL.headerBytes);
  #payload = Buffer.alloc(CONTROL.maxPayload);
  #headerBytes = 0;
  #payloadBytes = 0;
  #length = 0;
  #kind = 0;
  #id = 0;
  #ready = false;
  #ended = false;
  /** @type {Error | null} */
  #failure = null;

  /** @param {string} message @returns {never} */
  #fail(message) {
    this.#failure = Error(message);
    throw this.#failure;
  }

  #check() {
    if (this.#failure) throw this.#failure;
  }

  /** @param {Uint8Array} bytes @returns {number} */
  feed(bytes) {
    this.#check();
    if (this.#ended) return this.#fail('Native control feed after EOF');
    if (this.#ready) return 0;

    let taken = 0;
    if (this.#headerBytes < CONTROL.headerBytes) {
      const count = Math.min(bytes.byteLength, CONTROL.headerBytes - this.#headerBytes);
      this.#header.set(bytes.subarray(0, count), this.#headerBytes);
      this.#headerBytes += count;
      taken += count;
      if (this.#headerBytes < CONTROL.headerBytes) return taken;
      if (this.#header.readUInt32LE() !== CONTROL.magic)
        return this.#fail('Invalid native control magic');
      if (this.#header.readUInt16LE(4) !== CONTROL.version)
        return this.#fail('Unsupported native control version');
      this.#kind = this.#header.readUInt16LE(6);
      this.#id = this.#header.readUInt32LE(8);
      this.#length = this.#header.readUInt32LE(12);
      try {
        validate(this.#kind, this.#id, this.#length);
      } catch (error) {
        return this.#fail(error instanceof Error ? error.message : String(error));
      }
    }

    const count = Math.min(bytes.byteLength - taken, this.#length - this.#payloadBytes);
    this.#payload.set(bytes.subarray(taken, taken + count), this.#payloadBytes);
    this.#payloadBytes += count;
    this.#ready = this.#payloadBytes === this.#length;
    return taken + count;
  }

  /** @returns {ControlFrame | null} */
  peek() {
    this.#check();
    if (!this.#ready) return null;
    return {kind: this.#kind, id: this.#id, payload: this.#payload.subarray(0, this.#length)};
  }

  consume() {
    this.#check();
    if (!this.#ready) return this.#fail('No native control frame to consume');
    this.#payload.fill(0, 0, this.#length);
    this.#headerBytes = 0;
    this.#payloadBytes = 0;
    this.#length = 0;
    this.#ready = false;
  }

  end() {
    this.#check();
    if (!this.#ready && (this.#headerBytes || this.#payloadBytes))
      return this.#fail('Truncated native control frame');
    this.#ended = true;
  }
}

/** @param {ControlFrame} frame @param {string} token */
export function controlAuthenticated(frame, token) {
  if (!/^[0-9a-f]{64}$/.test(token)) throw Error('Invalid native control token');
  const validShape = frame.kind === CONTROL.auth && frame.id === 0 && frame.payload.length === 64;
  return validShape && timingSafeEqual(frame.payload, Buffer.from(token, 'ascii'));
}
