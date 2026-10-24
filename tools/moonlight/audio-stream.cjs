// Continuous PCM playback on the console AudioOut, fed by the Moonlight helper.
// Reads interleaved 48 kHz stereo s16le from stdin (default), a numeric fd
// (--fd N) or a file (--file PATH, offline test), keeps a small ring of console
// AudioOut buffers primed and appended back to back, and measures underruns and
// overruns. It reuses game-audio.cjs's function-resolution path (audio-symbols
// + sdk-checks verify-function) and the same sound-memory allocation call.
// Usage: node tools/moonlight/audio-stream.cjs [runs/launcher-XXXX] [--fd N | --file PATH]
//        [--buffer-frames 3840] [--queue 3] [--prime 2]
const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_BYTES = 4;
const DESCRIPTOR_COUNT = 8;
const SLOT_STRIDE = 0x4000;
const SLOT_BASE = 0x10000;
const PARAM_OFFSET = 0x300;
const DESCRIPTOR_BASE = 0x400;
const DESCRIPTOR_STRIDE = 0x40;
const ALLOCATE = 5732112;

const symbols = require('../../homebrew-launcher/audio-symbols.json');
const sdkImage = require('../../smilebasic/reference/sdk-checks.cjs');

const check = (value, message) => {
  if (!value) throw Error(message);
};

function resolver(rpc) {
  const resolved = {};
  return async function call(name, ...args) {
    if (!resolved[name]) {
      const matches = symbols.filter(s => s.name.includes(name));
      check(matches.length === 1, 'Ambiguous audio symbol ' + name);
      const s = matches[0];
      const address = rpc.a.sdk + s.offset;
      await rpc.request({
        command: 'verify-function',
        address,
        hex: sdkImage.bytes(s.offset, Math.min(32, s.size)).toString('hex')
      });
      resolved[name] = address;
    }
    return (await rpc.callAddress(resolved[name], args)).result;
  };
}

async function allocate(rpc, bytes) {
  const temp = rpc.a.scratch + 0x10000;
  const saved = await rpc.read(temp, 8);
  let base;
  try {
    check(
      (await rpc.call(ALLOCATE, [temp, 65536, bytes])).result === 0n,
      'Audio allocation failed'
    );
    base = Number((await rpc.read(temp, 8)).readBigUInt64LE());
  } finally {
    await rpc.write(temp, saved);
  }
  check(Number.isSafeInteger(base) && base > 0 && base % 65536 === 0, 'Invalid audio allocation');
  return base;
}

class ByteQueue {
  constructor() {
    this.chunks = [];
    this.bytes = 0;
  }
  push(buf) {
    if (buf.length) {
      this.chunks.push(buf);
      this.bytes += buf.length;
    }
  }
  pull(n) {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - filled);
      head.copy(out, filled, 0, take);
      filled += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.bytes -= n;
    return out;
  }
  dropOldest(n) {
    const target = Math.min(n, this.bytes);
    let dropped = 0;
    while (dropped < target) {
      const head = this.chunks[0];
      const take = Math.min(head.length, target - dropped);
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
      dropped += take;
    }
    this.bytes -= dropped;
    return dropped;
  }
}

function stream(options) {
  const rpc = options.rpc;
  const input = options.input;
  const bufferFrames = options.bufferFrames || 3840;
  const bufferBytes = bufferFrames * FRAME_BYTES;
  const queueMax = options.queue || 3;
  const prime = Math.min(options.prime || 2, queueMax);
  const bufferMs = (bufferFrames / SAMPLE_RATE) * 1000;
  const maxPending = options.maxPending || (queueMax + 2) * bufferBytes;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now || (() => performance.now());

  check(bufferFrames > 0 && bufferFrames % 1 === 0, 'buffer-frames must be a positive integer');
  check(bufferBytes <= SLOT_STRIDE, 'buffer does not fit a slot');
  check(bufferBytes <= 32768, 'buffer exceeds one write exchange');
  check(SLOT_STRIDE % 0x1000 === 0, 'slot stride must be page aligned');

  const stats = {
    appended: 0,
    released: 0,
    written: 0,
    underruns: 0,
    overruns: 0,
    droppedBytes: 0,
    tail: 0,
    receivedBytes: 0
  };

  const pending = new ByteQueue();
  let base = 0;
  let descriptors = [];
  const slotAddress = i => base + SLOT_BASE + i * SLOT_STRIDE;
  const free = new Set();
  const inFlight = [];
  let started = false;
  let stopped = false;
  let inputEnded = false;
  let inputError = null;
  let underflowing = false;

  input.on('data', chunk => {
    stats.receivedBytes += chunk.length;
    pending.push(chunk);
    if (pending.bytes > maxPending) {
      const drop = pending.bytes - maxPending;
      const whole = Math.ceil(drop / bufferBytes) * bufferBytes;
      const dropped = pending.dropOldest(Math.min(whole, pending.bytes));
      stats.droppedBytes += dropped;
      stats.overruns += Math.round(dropped / bufferBytes) || 1;
    }
  });
  input.on('end', () => (inputEnded = true));
  input.on('close', () => (inputEnded = true));
  input.on('error', error => {
    if (!stopped) inputError = error;
    inputEnded = true;
  });

  function stop() {
    stopped = true;
    input.destroy();
  }

  async function run() {
    const call = resolver(rpc);

    const alloc = 65536 + DESCRIPTOR_COUNT * SLOT_STRIDE;
    base = await allocate(rpc, alloc);
    await rpc.write(base, Buffer.alloc(65536));

    const param = base + PARAM_OFFSET;
    await call('InitializeAudioOutParameter', param);
    const params = await rpc.read(param, 8);
    params.writeUInt32LE(SAMPLE_RATE);
    params.writeUInt16LE(CHANNELS, 4);
    await rpc.write(param, params);

    const opened = await call('OpenDefaultAudioOutEPNS0_8AudioOutER', base, param);
    check(
      opened === 0n,
      'OpenDefaultAudioOut failed (' + opened + '); game-audio.cjs may hold the device'
    );
    check(
      (await call('GetAudioOutSampleRate', base)) === BigInt(SAMPLE_RATE) &&
        (await call('GetAudioOutChannelCount', base)) === BigInt(CHANNELS) &&
        (await call('GetAudioOutSampleFormat', base)) === 2n,
      'Unexpected AudioOut format'
    );

    descriptors = Array.from(
      {length: DESCRIPTOR_COUNT},
      (_, i) => base + DESCRIPTOR_BASE + i * DESCRIPTOR_STRIDE
    );
    const index = new Map(descriptors.map((address, i) => [address, i]));
    for (let i = 0; i < DESCRIPTOR_COUNT; i++) {
      await call('SetAudioOutBufferInfo', descriptors[i], slotAddress(i), SLOT_STRIDE, bufferBytes);
      free.add(descriptors[i]);
    }

    async function drain() {
      for (let i = 0; i < DESCRIPTOR_COUNT; i++) {
        const address = await call('GetReleasedAudioOutBuffer', base);
        if (address === 0n) break;
        const slot = index.get(Number(address));
        check(slot !== undefined, 'Unknown released descriptor');
        if (!free.has(Number(address))) {
          free.add(Number(address));
          inFlight.shift();
          stats.released++;
        }
      }
    }

    async function append(descriptor, pcm) {
      const slot = index.get(descriptor);
      await rpc.write(slotAddress(slot), pcm);
      stats.written++;
      check((await call('AppendAudioOutBuffer', base, descriptor)) === 1n, 'Append rejected');
      free.delete(descriptor);
      const playhead = inFlight.length ? inFlight[inFlight.length - 1].releaseAt : now();
      inFlight.push({descriptor, releaseAt: Math.max(playhead, now()) + bufferMs});
      stats.appended++;
    }

    try {
      while (true) {
        if (inFlight.length) await drain();
        const cap = started ? queueMax : prime;
        while (free.size > 0 && inFlight.length < cap && pending.bytes >= bufferBytes) {
          await append(free.values().next().value, pending.pull(bufferBytes));
        }
        if (
          inputEnded &&
          pending.bytes > 0 &&
          pending.bytes < bufferBytes &&
          free.size > 0 &&
          inFlight.length < queueMax
        ) {
          const tail = Buffer.alloc(bufferBytes);
          pending.pull(pending.bytes).copy(tail);
          await append(free.values().next().value, tail);
          stats.tail++;
        }
        if (!started && (inFlight.length >= prime || (inputEnded && inFlight.length > 0))) {
          check((await call('StartAudioOut', base)) === 0n, 'StartAudioOut failed');
          started = true;
        }
        if (inFlight.length > 0) underflowing = false;
        else if (started && !inputEnded && !stopped && !underflowing) {
          stats.underruns++;
          underflowing = true;
        }

        const done =
          (stopped || inputEnded) && inFlight.length === 0 && pending.bytes < bufferBytes;
        if (done) break;

        const wait = inFlight.length
          ? Math.max(bufferMs / 8, Math.min(bufferMs, inFlight[0].releaseAt - now()))
          : bufferMs / 4;
        await sleep(wait);
      }
    } finally {
      if (started)
        try {
          await call('StopAudioOut', base);
        } catch {}
    }

    await call('FlushAudioOutBuffers', base);
    await drain();
    check(Number(await call('GetAudioOutBufferCount', base)) === 0, 'AudioOut queue did not drain');
    try {
      await call('CloseAudioOut', base);
    } catch {}

    if (inputError) throw inputError;
    return stats;
  }

  const done = run();
  return {done, stop, stats};
}

function newestRun() {
  const runs = path.join(__dirname, '../../runs');
  const newest = fs
    .readdirSync(runs)
    .filter(name => name.startsWith('launcher-'))
    .map(name => path.join(runs, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!newest) throw Error('No launcher session found in runs/');
  return newest;
}

function makeInput(args) {
  const fdAt = args.indexOf('--fd');
  const fileAt = args.indexOf('--file');
  if (fdAt >= 0) return fs.createReadStream(null, {fd: Number(args[fdAt + 1])});
  if (fileAt >= 0) return fs.createReadStream(args[fileAt + 1]);
  return process.stdin;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) =>
    args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback;
  const directory = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : newestRun();
  const rpc = require(path.join(directory, 'shared/rpc.cjs'));
  const input = makeInput(args);
  const session = stream({
    rpc,
    input,
    bufferFrames: option('--buffer-frames', 3840),
    queue: option('--queue', 3),
    prime: option('--prime', 2)
  });
  process.on('SIGINT', () => session.stop());
  process.on('SIGTERM', () => session.stop());
  console.log('Continuous audio stream ready.');
  let error;
  try {
    await session.done;
  } catch (e) {
    error = e;
  }
  const file = path.join(directory, `moonlight-audio-${Date.now()}.json`);
  await fs.promises.writeFile(
    file,
    JSON.stringify(
      {
        session: rpc.a.session,
        completed: new Date().toISOString(),
        ...session.stats,
        error: error?.message
      },
      null,
      2
    )
  );
  console.log(JSON.stringify(session.stats));
  console.log('Saved ' + file);
  if (error) throw error;
}

module.exports = {stream, ByteQueue, newestRun};

if (require.main === module)
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
