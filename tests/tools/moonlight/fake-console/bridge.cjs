// Serves the fake console over the real bridge protocol
// (hbl-platform/smilebasic/engine/lib/bridge.js), so host tools that speak HTTP/JSON can be
// run and measured end to end without a console: live.js or input-feeder.js
// through a copy of the real shared/rpc.cjs.
//
// It writes a run directory (connection.json, shared/rpc.cjs, the Moonlight app
// report and game-audio-source.json) and serves until SIGINT. Natives are
// simulated: the sound-memory allocation, the heartbeat copy, and an AudioOut
// that plays appended buffers in real time and counts underruns.
// verify-function checks the bytes against hbl-platform/smilebasic/reference/sdk-checks.json.
//   --pad  cycles a scripted controller + touch state every 500 ms
// Env: RATE, STALL, DECODE as in shared/rpc.cjs; HB_PIPELINE as on the launcher.
// Usage: node tests/tools/moonlight/fake-console/bridge.cjs DIR [--pad]
const fs = require('node:fs');
const path = require('node:path');
const {serve} = require('../../../../../hbl-platform/smilebasic/engine/lib/bridge.js');
const symbols = require('../../../../../hbl-platform/sdk/native/audio-symbols.json');
const {referenceBytes} = require('../../../../../hbl-platform/smilebasic/engine/lib/sdk.js');
const fake = require('./shared/rpc.cjs');
const {ALLOCATE} = require('../../../../../hbl-platform/sdk/native/allocate.js');
const report = require('./app-moonlight-1.json');

const SCRATCH = 0x20000000,
  STATE = 0x30000000,
  SDK = 0x40000000,
  HEAP = 0x60000000,
  COPY = 0x5872f0,
  SAMPLE_RATE = 48000;

const stats = {writes: 0, writeMs: 0, reads: 0, calls: 0, appended: 0, underruns: 0};
let heap = HEAP;

function symbolAt(address) {
  const symbol = symbols.find(s => SDK + s.offset === address);
  if (!symbol) throw Error('No audio symbol at 0x' + address.toString(16));
  return symbol;
}

const audio = new Map();

function audioOut(base) {
  if (!audio.has(base))
    audio.set(base, {started: false, played: false, queue: [], sizes: new Map(), end: 0});
  return audio.get(base);
}

function schedule(out, entry) {
  const now = performance.now();
  if (out.end < now) {
    if (out.played) stats.underruns++;
    out.end = now;
  }
  out.end += ((out.sizes.get(entry.descriptor) / 4) * 1000) / SAMPLE_RATE;
  out.played = true;
  entry.releaseAt = out.end;
}

const AUDIO = {
  InitializeAudioOutParameter: () => 0,
  OpenDefaultAudioOut: base => (audioOut(base), 0),
  GetAudioOutSampleRate: () => SAMPLE_RATE,
  GetAudioOutChannelCount: () => 2,
  GetAudioOutSampleFormat: () => 2,
  SetAudioOutBufferInfo(descriptor, slot, size, dataSize) {
    for (const out of audio.values()) out.sizes.set(descriptor, dataSize);
    return 0;
  },
  AppendAudioOutBuffer(base, descriptor) {
    const out = audioOut(base),
      entry = {descriptor, releaseAt: Infinity};
    if (out.started) schedule(out, entry);
    out.queue.push(entry);
    stats.appended++;
    return 1;
  },
  StartAudioOut(base) {
    const out = audioOut(base);
    out.started = true;
    out.played = false;
    out.end = performance.now();
    for (const entry of out.queue) schedule(out, entry);
    return 0;
  },
  GetReleasedAudioOutBuffer(base) {
    const out = audioOut(base);
    if (!out.queue.length || out.queue[0].releaseAt > performance.now()) return 0;
    return out.queue.shift().descriptor;
  },
  StopAudioOut: base => ((audioOut(base).started = false), 0),
  FlushAudioOutBuffers(base) {
    for (const entry of audioOut(base).queue) entry.releaseAt = 0;
    return 1;
  },
  GetAudioOutBufferCount: base => audioOut(base).queue.length,
  CloseAudioOut: base => (audio.delete(base), 0)
};

function simulate(address, args) {
  const {name} = symbolAt(address);
  const key = Object.keys(AUDIO).find(k => name.includes(k + 'E'));
  if (!key) throw Error('No simulation for ' + name);
  return AUDIO[key](...args.map(Number));
}

const native = {
  connection: {error: null, fail: error => console.error('bridge: ' + error.message)},
  calls: 0,
  depth: Math.max(1, Math.min(4, Number(process.env.HB_PIPELINE) || 1)),
  output: SCRATCH + 0x4040,
  verified: new Set(),
  async call(offset, ...args) {
    await fake.exchange();
    stats.calls++;
    if (offset === COPY) return {result: BigInt(args[0]), output: Buffer.alloc(0)};
    if (offset !== ALLOCATE) throw Error('Unsimulated native call ' + offset);
    const [temp, align, bytes] = args.map(Number);
    heap = Math.ceil(heap / align) * align;
    const pointer = Buffer.alloc(8);
    pointer.writeBigUInt64LE(BigInt(heap));
    fake.poke(temp, pointer);
    heap += bytes;
    return {result: 0n, output: Buffer.alloc(0)};
  },
  async verifyFunction(address, expected) {
    const {offset, size} = symbolAt(address);
    if (!expected.equals(referenceBytes(offset, Math.min(32, size))))
      throw Error('Native function bytes do not match');
    this.verified.add(address);
  },
  async callAddress(address, ...args) {
    if (!this.verified.has(address)) throw Error('Native function has not been verified');
    await fake.exchange();
    stats.calls++;
    return {result: BigInt(simulate(address, args)), output: Buffer.alloc(0)};
  },
  async read(address, length) {
    stats.reads++;
    return fake.read(address, length);
  },
  async write(address, bytes) {
    const started = performance.now();
    await fake.write(address, bytes);
    stats.writes++;
    stats.writeMs += performance.now() - started;
  },
  async exchange(calls, data, outputBytes) {
    if (calls.length !== 1 || data?.length) throw Error('pair is not simulated');
    const [{offset, address, args}] = calls;
    const reply =
      address === undefined
        ? await this.call(offset, ...args)
        : await this.callAddress(address, ...args);
    return {...reply, output: Buffer.from(fake.peek(this.output, outputBytes))};
  },
  async writeAndCall(address, bytes, target, args) {
    if (!this.verified.has(target)) throw Error('Native function has not been verified');
    await this.write(address, bytes);
    stats.calls++;
    return {result: BigInt(simulate(target, args)), output: Buffer.alloc(2)};
  },
  async query() {
    throw Error('query is not simulated');
  }
};

// Each entry holds for 500 ms: the pad (buttons, sticks, connected) and the
// touch points (id, panel x/y, ended).
const PAD_SCRIPT = [
  {buttons: 0, sticks: [0, 0, 0, 0], connected: 1, touches: []},
  {buttons: 1 << 1, sticks: [12000, -8000, 0, 0], connected: 1, touches: [[7, 640, 360, 0]]},
  {
    buttons: (1 << 1) | (1 << 12) | (1 << 14),
    sticks: [0, 0, -32768, 32767],
    connected: 1,
    touches: [
      [7, 700, 380, 0],
      [9, 100, 50, 0]
    ]
  },
  {
    buttons: 1 << 8,
    sticks: [0, 0, 0, 0],
    connected: 1,
    touches: [
      [9, 1280, 720, 0],
      [7, 700, 380, 2]
    ]
  },
  {buttons: 1 << 0, sticks: [5, 5, 5, 5], connected: 0, touches: []}
];

function writePad(entry) {
  const bytes = Buffer.alloc(784);
  bytes.writeUInt32LE(entry.buttons, 8);
  entry.sticks.forEach((value, i) => bytes.writeInt32LE(value, 16 + i * 4));
  bytes.writeUInt32LE(entry.connected, 32);
  bytes.writeUInt32LE(entry.touches.length, 128 + 8);
  entry.touches.forEach(([id, x, y, attributes], i) => {
    const at = 128 + (4 + i * 10) * 4;
    bytes.writeUInt32LE(attributes, at + 8);
    bytes.writeUInt32LE(id, at + 12);
    bytes.writeInt32LE(x, at + 16);
    bytes.writeInt32LE(y, at + 20);
  });
  fake.poke(STATE, bytes);
}

async function main() {
  const directory = path.resolve(process.argv[2] || '');
  if (!process.argv[2]) throw Error('Usage: bridge.cjs DIR [--pad]');
  const bridge = await serve(native);
  fs.mkdirSync(path.join(directory, 'shared'), {recursive: true});
  const json = (name, value) =>
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));
  json('connection.json', {
    port: bridge.port,
    token: bridge.token,
    addresses: {
      scratch: SCRATCH,
      scratchBytes: 524288,
      sdk: SDK,
      platform: 2,
      protocol: 2,
      session: 'fake-console'
    }
  });
  fs.copyFileSync(
    path.join(__dirname, '../../../../../hbl-platform/smilebasic/engine/shared/rpc.cjs'),
    path.join(directory, 'shared/rpc.cjs')
  );
  json('app-moonlight-1.json', report);
  json('game-audio-source.json', {
    session: 'fake-console',
    mapped: STATE,
    package: {id: 'moonlight'}
  });

  if (process.argv.includes('--pad')) {
    let step = 0;
    writePad(PAD_SCRIPT[0]);
    setInterval(() => writePad(PAD_SCRIPT[++step % PAD_SCRIPT.length]), 500);
  }
  setInterval(() => {
    const line = {...stats, writeMs: +(stats.writeMs / Math.max(1, stats.writes)).toFixed(2)};
    console.log('bridge: ' + JSON.stringify(line));
    Object.assign(stats, {writes: 0, writeMs: 0, reads: 0, calls: 0, appended: 0});
  }, 1000);
  console.log('ready ' + directory);
  const stop = async () => {
    await bridge.close();
    process.exit();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
