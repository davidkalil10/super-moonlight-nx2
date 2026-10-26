/**
 * Node side of the native HBV2 encoder (hbv2enc.c): one long-running process, one frame in
 * flight. Each request is a fixed header followed by the RGB24 frame on stdin; each result is a
 * fixed record of little-endian words followed by the slot on stdout. Each call resolves with the
 * encoder's stats and the slot to write (empty when the frame changed nothing).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

const REQUEST_MAGIC = 0x49324248;
const RESULT_MAGIC = 0x4f324248;
/** The request header is a fixed 48 bytes; unused trailing words stay zero. */
const REQUEST_BYTES = 48;
const DEFAULT_QP_MAX = 51;
/** Result record words, in order. */
const RESULT_FIELDS = [
  'magic',
  'sequence',
  'slotBytes',
  'qp',
  'intra',
  'inter',
  'skip',
  'deferred',
  'encodeMicros',
  'keyframe',
  'psnrCentidB',
  'reference'
];
const RESULT_BYTES = RESULT_FIELDS.length * 4;

/**
 * The encoder binary: $HBV2ENC, or the default build location.
 * @returns {string}
 */
function encoderPath() {
  const file =
    process.env.HBV2ENC || path.join(os.homedir(), 'claude-builds/HBLauncher/hbv2enc/hbv2enc');
  if (!fs.existsSync(file))
    throw Error(`${file} not found; build it with tools/moonlight/build-hbv2enc.sh`);
  return file;
}

/**
 * @typedef {object} EncodeOptions
 * @property {number} sequence
 * @property {boolean} [keyframe]
 * @property {number} [budget] target slot bytes
 * @property {number} [cap] hard slot byte limit
 * @property {number} [qpMin]
 * @property {number} [qpMax]
 * @property {number} [refresh] chunks forced intra per frame
 */

/**
 * @param {number} width
 * @param {number} height
 * @param {EncodeOptions} options
 * @returns {Buffer}
 */
function requestHeader(width, height, options) {
  const header = Buffer.alloc(REQUEST_BYTES);
  [
    REQUEST_MAGIC,
    width,
    height,
    options.sequence,
    options.keyframe ? 1 : 0,
    options.budget ?? 0,
    options.cap ?? 0,
    options.qpMin ?? 0,
    options.qpMax ?? DEFAULT_QP_MAX,
    options.refresh ?? 0
  ].forEach((value, i) => header.writeUInt32LE(value >>> 0, i * 4));
  return header;
}

function readResult(bytes) {
  const result = {};
  RESULT_FIELDS.forEach((name, i) => (result[name] = bytes.readUInt32LE(i * 4)));
  return result;
}

class Encoder {
  /**
   * Spawns hbv2enc with its optional thread count and reconstruction output path.
   * @param {{threads?: number, recon?: string}} [options]
   */
  constructor({threads, recon} = {}) {
    const args = [];
    if (threads) args.push('--threads', String(threads));
    if (recon) args.push('--recon', recon);
    // Spinning OpenMP workers starve the capture and RPC processes sharing
    // the CPU (58 ms vs 6.5 ms per 1080p frame on m5), so they sleep instead.
    const env = {OMP_WAIT_POLICY: 'passive', ...process.env};
    this.process = spawn(encoderPath(), args, {env, stdio: ['pipe', 'pipe', 'inherit']});
    this.pending = Buffer.alloc(0);
    this.waiting = null;
    this.process.stdout.on('data', chunk => {
      this.pending = Buffer.concat([this.pending, chunk]);
      this.drain();
    });
    this.exited = new Promise(resolve => this.process.on('close', resolve));
    this.process.on('close', code => {
      if (this.waiting) this.waiting.reject(Error('hbv2enc exited with ' + code));
      this.waiting = null;
    });
  }

  /** Settles the waiting call once its whole result record and slot have arrived. */
  drain() {
    if (!this.waiting || this.pending.length < RESULT_BYTES) return;
    const result = readResult(this.pending);
    if (result.magic !== RESULT_MAGIC) {
      this.waiting.reject(Error('hbv2enc returned a bad record'));
      this.waiting = null;
      return;
    }
    const end = RESULT_BYTES + result.slotBytes;
    if (this.pending.length < end) return;
    const slot = Buffer.from(this.pending.subarray(RESULT_BYTES, end));
    this.pending = this.pending.subarray(end);
    const {resolve} = this.waiting;
    this.waiting = null;
    resolve({...result, slot});
  }

  /**
   * @param {Buffer} rgb width x height RGB24
   * @param {number} width
   * @param {number} height
   * @param {EncodeOptions} options
   * @returns {Promise<Record<string, any>>} the result record's fields plus `slot`
   */
  encode(rgb, width, height, options) {
    if (this.waiting) return Promise.reject(Error('hbv2enc is busy'));
    const header = requestHeader(width, height, options);
    const done = new Promise((resolve, reject) => (this.waiting = {resolve, reject}));
    this.process.stdin.write(header);
    this.process.stdin.write(rgb);
    return done;
  }

  async close() {
    this.process.stdin.end();
    await this.exited;
  }
}

export {Encoder, encoderPath};
