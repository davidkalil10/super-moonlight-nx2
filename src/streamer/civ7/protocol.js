import {EventEmitter} from 'node:events';

export const MAX_FRAME_BYTES = 256 * 1024;
export const MEMORY_CHUNK_BYTES = 64 * 1024;
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;

/**
 * A decoded JSON frame from the payload. Its fields are only typed where they are read.
 * @typedef {{[field: string]: unknown}} Civ7Frame
 */

/** @typedef {Civ7Frame & {id: number, ok: boolean, error?: unknown}} Civ7Reply */

/** @param {unknown} value */
export function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (!body.length || body.length > MAX_FRAME_BYTES) throw Error('Invalid Civ7 frame length');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

/**
 * @param {Civ7Frame} frame
 * @returns {frame is Civ7Reply}
 */
export function isReply(frame) {
  return Number.isSafeInteger(frame.id) && typeof frame.ok === 'boolean';
}

/**
 * An integer field of a reply, sent as a decimal or 0x string or a safe number.
 * @param {Civ7Frame} reply
 * @param {string} field
 */
export function replyInteger(reply, field) {
  const value = reply[field];
  const integerOk = typeof value === 'number' && Number.isSafeInteger(value);
  if (typeof value === 'string' || integerOk) return BigInt(value);
  throw Error('Invalid Civ7 reply field: ' + field);
}

/**
 * @param {Civ7Frame} reply
 * @param {string} field
 */
export function replyString(reply, field) {
  const value = reply[field];
  if (typeof value !== 'string') throw Error('Invalid Civ7 reply field: ' + field);
  return value;
}

/**
 * @param {Civ7Frame} reply
 * @param {string} field
 */
export function replyArray(reply, field) {
  const value = reply[field];
  if (!Array.isArray(value)) throw Error('Invalid Civ7 reply field: ' + field);
  return /** @type {unknown[]} */ (value);
}

export class FrameReader extends EventEmitter {
  #buffer = Buffer.alloc(0);

  /** @param {Buffer} chunk */
  feed(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE();
      if (!length || length > MAX_FRAME_BYTES) throw Error('Invalid Civ7 frame length');
      if (this.#buffer.length < length + 4) return;
      /** @type {unknown} */
      const value = JSON.parse(this.#buffer.subarray(4, length + 4).toString('utf8'));
      this.#buffer = this.#buffer.subarray(length + 4);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Civ7 frame');
      this.emit('frame', /** @type {Civ7Frame} */ (value));
    }
  }
}
