// Node side of the native HBV2 encoder (hbv2enc.c): one long-running process,
// one frame in flight. Each call resolves with the encoder's stats and the
// slot to write (empty when the frame changed nothing).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const REQUEST_MAGIC = 0x49324248;
const RESULT_MAGIC = 0x4f324248;
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

function encoderPath() {
  const file =
    process.env.HBV2ENC || path.join(os.homedir(), 'claude-builds/HBLauncher/hbv2enc/hbv2enc');
  if (!fs.existsSync(file))
    throw Error(`${file} not found; build it with tools/moonlight/build-hbv2enc.sh`);
  return file;
}

class Encoder {
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

  drain() {
    if (!this.waiting || this.pending.length < RESULT_BYTES) return;
    const result = {};
    RESULT_FIELDS.forEach((name, i) => (result[name] = this.pending.readUInt32LE(i * 4)));
    if (result.magic !== RESULT_MAGIC) {
      this.waiting.reject(Error('hbv2enc returned a bad record'));
      this.waiting = null;
      return;
    }
    if (this.pending.length < RESULT_BYTES + result.slotBytes) return;
    const slot = Buffer.from(this.pending.subarray(RESULT_BYTES, RESULT_BYTES + result.slotBytes));
    this.pending = this.pending.subarray(RESULT_BYTES + result.slotBytes);
    const {resolve} = this.waiting;
    this.waiting = null;
    resolve({...result, slot});
  }

  // rgb: width x height RGB24. Options: sequence, keyframe, budget and cap in
  // bytes, qpMin/qpMax, refresh (chunks forced intra per frame).
  encode(rgb, width, height, options) {
    if (this.waiting) return Promise.reject(Error('hbv2enc is busy'));
    const header = Buffer.alloc(48);
    [
      REQUEST_MAGIC,
      width,
      height,
      options.sequence,
      options.keyframe ? 1 : 0,
      options.budget ?? 0,
      options.cap ?? 0,
      options.qpMin ?? 0,
      options.qpMax ?? 51,
      options.refresh ?? 0
    ].forEach((value, i) => header.writeUInt32LE(value >>> 0, i * 4));
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

module.exports = {Encoder, encoderPath};
