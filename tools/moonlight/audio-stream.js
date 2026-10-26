// Continuous PCM playback on the console AudioOut, fed by the Moonlight helper.
// Reads interleaved 48 kHz stereo s16le from stdin (default), a numeric fd
// (--fd N) or a file (--file PATH, offline test), keeps a small ring of console
// AudioOut buffers primed and appended back to back, and measures underruns and
// overruns. Functions resolve through sdk/native/symbols.cjs like game-audio.js.
// Usage: node tools/moonlight/audio-stream.js [runs/launcher-XXXX] [--fd N | --file PATH]
//        [--buffer-frames 3840] [--queue 3] [--prime 2]
import fs from 'node:fs';
import path from 'node:path';
import * as session from '../../../hbl-platform/sdk/host/session.js';
import * as cli from '../../../hbl-platform/sdk/cli.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_BYTES = 4;
const DESCRIPTOR_COUNT = 8;
const SLOT_STRIDE = 0x4000;
const SLOT_BASE = 0x10000;
const PARAM_OFFSET = 0x300;
const DESCRIPTOR_BASE = 0x400;
const DESCRIPTOR_STRIDE = 0x40;

import {sdkResolver} from '../../../hbl-platform/sdk/native/symbols.js';
import {allocate} from '../../../hbl-platform/sdk/native/allocate.js';
import * as audioOut from '../../../hbl-platform/sdk/host/audio-out.js';

const check = (value, message) => {
  if (!value) throw Error(message);
};

function resolver(rpc, counted = () => {}) {
  const resolve = sdkResolver(rpc, {ambiguous: 'Ambiguous audio symbol '});
  async function call(name, ...args) {
    counted();
    return (await rpc.callAddress(await resolve(name), args, 2)).result;
  }
  call.writeAndCall = async (address, bytes, name, ...args) => {
    counted();
    const target = await resolve(name);
    if (rpc.writeAndCall) return (await rpc.writeAndCall(address, bytes, target, args)).result;
    await rpc.write(address, bytes);
    return (await rpc.callAddress(target, args, 2)).result;
  };
  return call;
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
    receivedBytes: 0,
    calls: 0
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
    const call = resolver(rpc, () => stats.calls++);

    const alloc = 65536 + DESCRIPTOR_COUNT * SLOT_STRIDE;
    base = await allocate(rpc, alloc, {
      align: 65536,
      failed: 'Audio allocation failed',
      invalid: 'Invalid audio allocation'
    });
    await rpc.write(base, Buffer.alloc(65536));

    const param = base + PARAM_OFFSET;
    await audioOut.open(rpc, call, base, param, {
      rate: SAMPLE_RATE,
      channels: CHANNELS,
      failed: opened =>
        'OpenDefaultAudioOut failed (' + opened + '); game-audio.js may hold the device',
      format: 'Unexpected AudioOut format'
    });

    descriptors = audioOut.descriptors(base + DESCRIPTOR_BASE, DESCRIPTOR_COUNT, DESCRIPTOR_STRIDE);
    const index = new Map(descriptors.map((address, i) => [address, i]));
    for (let i = 0; i < DESCRIPTOR_COUNT; i++) {
      await call('SetAudioOutBufferInfo', descriptors[i], slotAddress(i), SLOT_STRIDE, bufferBytes);
      free.add(descriptors[i]);
    }

    async function drain() {
      const due = inFlight.filter(item => item.releaseAt <= now()).length;
      for (let i = 0; i < due; i++) {
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
      check(
        (await call.writeAndCall(
          slotAddress(slot),
          pcm,
          'AppendAudioOutBuffer',
          base,
          descriptor
        )) === 1n,
        'Append rejected'
      );
      stats.written++;
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

function makeInput(args) {
  const fdAt = args.indexOf('--fd');
  const fileAt = args.indexOf('--file');
  if (fdAt >= 0) return fs.createReadStream(null, {fd: Number(args[fdAt + 1])});
  if (fileAt >= 0) return fs.createReadStream(args[fileAt + 1]);
  return process.stdin;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => cli.number(args, name, fallback);
  const directory = session.resolve(args[0]);
  const rpc = session.rpc(directory);
  const input = makeInput(args);
  const playback = stream({
    rpc,
    input,
    bufferFrames: option('--buffer-frames', 3840),
    queue: option('--queue', 3),
    prime: option('--prime', 2)
  });
  process.on('SIGINT', () => playback.stop());
  process.on('SIGTERM', () => playback.stop());
  console.log('Continuous audio stream ready.');
  const printing = args.includes('--stats')
    ? setInterval(() => {
        console.log(JSON.stringify({event: 'audio-stats', ...playback.stats}));
      }, 1000)
    : null;
  let error;
  try {
    await playback.done;
  } catch (e) {
    error = e;
  } finally {
    clearInterval(printing);
  }
  const file = path.join(directory, `moonlight-audio-${Date.now()}.json`);
  await fs.promises.writeFile(
    file,
    JSON.stringify(
      {
        session: rpc.a.session,
        completed: new Date().toISOString(),
        ...playback.stats,
        error: error?.message
      },
      null,
      2
    )
  );
  console.log(JSON.stringify(playback.stats));
  console.log('Saved ' + file);
  if (error) throw error;
}

const newestRun = session.newest;
export {stream, ByteQueue, newestRun};

if (cli.isMain(import.meta))
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
