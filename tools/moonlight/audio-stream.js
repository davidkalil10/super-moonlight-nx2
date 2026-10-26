/**
 * Continuous PCM playback on the console AudioOut, fed by the Moonlight helper.
 *
 * Reads interleaved 48 kHz stereo s16le from stdin (default), a numeric fd (--fd N) or a
 * file (--file PATH, offline test), keeps a small ring of console AudioOut buffers primed and
 * appended back to back, and measures underruns and overruns. The host writes every chunk
 * over the bridge into its slot and appends it in the same exchange when the rpc can.
 *
 * Releases are not signalled: each appended buffer gets an expected release time on a host
 * playhead, and GetReleasedAudioOutBuffer is only polled for buffers that should be done.
 * Functions resolve through sdk/native/symbols.js like game-audio.js.
 *
 * Usage: node tools/moonlight/audio-stream.js [runs/launcher-XXXX] [--fd N | --file PATH]
 *        [--buffer-frames 3840] [--queue 3] [--prime 2] [--stats]
 */
import fs from 'node:fs';
import path from 'node:path';
import * as session from '../../../hbl-platform/sdk/host/session.js';
import * as cli from '../../../hbl-platform/sdk/cli.js';
import {sdkResolver} from '../../../hbl-platform/sdk/native/symbols.js';
import {allocate} from '../../../hbl-platform/sdk/native/allocate.js';
import * as audioOut from '../../../hbl-platform/sdk/host/audio-out.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
/** One interleaved stereo s16 sample frame. */
const FRAME_BYTES = 4;
/**
 * The AudioOut region: the AudioOut object at 0, the open parameter and the descriptors in
 * the first SLOT_BASE bytes, then one PCM slot per descriptor.
 */
const DESCRIPTOR_COUNT = 8;
const SLOT_STRIDE = 0x4000;
const SLOT_BASE = 0x10000;
const PARAM_OFFSET = 0x300;
const DESCRIPTOR_BASE = 0x400;
const DESCRIPTOR_STRIDE = 0x40;
const ALLOCATION_ALIGN = 0x10000;
const PAGE_BYTES = 0x1000;
/** Largest write one bridge exchange carries. */
const EXCHANGE_BYTES = 32768;
/** Reply output bytes for native calls: too few to carry an output slot, only the result. */
const SHORT = 2;
/** AppendAudioOutBuffer returns true when it queued the buffer. */
const APPENDED = 1n;

const DEFAULT_BUFFER_FRAMES = 3840;
/** Buffers kept in flight while playing. */
const DEFAULT_QUEUE = 3;
/** Buffers appended before StartAudioOut. */
const DEFAULT_PRIME = 2;
/** Pending input allowed beyond the in-flight queue, in buffers, before the oldest drops. */
const PENDING_HEADROOM = 2;
/** The loop never sleeps less than this fraction of a buffer while buffers play. */
const MIN_SLEEP_DIVISOR = 8;
/** Sleep between polls, as a fraction of a buffer, while nothing is in flight. */
const IDLE_SLEEP_DIVISOR = 4;
const STATS_INTERVAL_MS = 1000;

/**
 * @typedef {object} StreamOptions
 * @property {any} rpc
 * @property {import('node:stream').Readable} input Interleaved 48 kHz stereo s16le PCM.
 * @property {number} [bufferFrames] Sample frames per AudioOut buffer.
 * @property {number} [queue] Buffers kept in flight while playing.
 * @property {number} [prime] Buffers appended before playback starts, at most `queue`.
 * @property {number} [maxPending] Pending input bytes kept before the oldest are dropped.
 * @property {(ms: number) => Promise<unknown>} [sleep]
 * @property {() => number} [now] Clock in milliseconds.
 */

/**
 * @param {unknown} value
 * @param {string} message
 */
const check = (value, message) => {
  if (!value) throw Error(message);
};

/**
 * A `call(name, ...args)` that resolves AudioOut functions by name and counts every call.
 * call.writeAndCall writes bytes and calls in one exchange when the rpc supports it.
 * @param {any} rpc
 * @param {() => void} [counted]
 */
function resolver(rpc, counted = () => {}) {
  const resolve = sdkResolver(rpc, {ambiguous: 'Ambiguous audio symbol '});
  async function call(name, ...args) {
    counted();
    return (await rpc.callAddress(await resolve(name), args, SHORT)).result;
  }
  call.writeAndCall = async (address, bytes, name, ...args) => {
    counted();
    const target = await resolve(name);
    if (rpc.writeAndCall) return (await rpc.writeAndCall(address, bytes, target, args)).result;
    await rpc.write(address, bytes);
    return (await rpc.callAddress(target, args, SHORT)).result;
  };
  return call;
}

/** A FIFO of byte chunks that pulls and drops by byte count across chunk boundaries. */
class ByteQueue {
  constructor() {
    /** @type {Buffer[]} */
    this.chunks = [];
    this.bytes = 0;
  }
  /** @param {Buffer} buf */
  push(buf) {
    if (buf.length) {
      this.chunks.push(buf);
      this.bytes += buf.length;
    }
  }
  /**
   * Removes the oldest `n` bytes, which must be queued.
   * @param {number} n
   * @returns {Buffer}
   */
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
  /**
   * Discards up to `n` of the oldest bytes.
   * @param {number} n
   * @returns {number} The bytes dropped.
   */
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

/**
 * Starts playing `input` on the console AudioOut.
 * @param {StreamOptions} options
 * @returns {{done: Promise<object>, stop: () => void, stats: object}} done resolves with the
 *   stats once the input ended or stop() was called and AudioOut drained and closed.
 */
function stream(options) {
  const rpc = options.rpc;
  const input = options.input;
  const bufferFrames = options.bufferFrames || DEFAULT_BUFFER_FRAMES;
  const bufferBytes = bufferFrames * FRAME_BYTES;
  const queueMax = options.queue || DEFAULT_QUEUE;
  const prime = Math.min(options.prime || DEFAULT_PRIME, queueMax);
  const bufferMs = (bufferFrames / SAMPLE_RATE) * 1000;
  const maxPending = options.maxPending || (queueMax + PENDING_HEADROOM) * bufferBytes;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now || (() => performance.now());

  check(bufferFrames > 0 && bufferFrames % 1 === 0, 'buffer-frames must be a positive integer');
  check(bufferBytes <= SLOT_STRIDE, 'buffer does not fit a slot');
  check(bufferBytes <= EXCHANGE_BYTES, 'buffer exceeds one write exchange');
  check(SLOT_STRIDE % PAGE_BYTES === 0, 'slot stride must be page aligned');

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

  /** Drops the oldest whole buffers once more than maxPending bytes are waiting. */
  function dropOverflow() {
    if (pending.bytes > maxPending) {
      const excess = pending.bytes - maxPending;
      const wholeBufferBytes = Math.ceil(excess / bufferBytes) * bufferBytes;
      const dropped = pending.dropOldest(Math.min(wholeBufferBytes, pending.bytes));
      stats.droppedBytes += dropped;
      stats.overruns += Math.round(dropped / bufferBytes) || 1;
    }
  }

  input.on('data', chunk => {
    stats.receivedBytes += chunk.length;
    pending.push(chunk);
    dropOverflow();
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

    const regionBytes = SLOT_BASE + DESCRIPTOR_COUNT * SLOT_STRIDE;
    base = await allocate(rpc, regionBytes, {
      align: ALLOCATION_ALIGN,
      failed: 'Audio allocation failed',
      invalid: 'Invalid audio allocation'
    });
    await rpc.write(base, Buffer.alloc(SLOT_BASE));

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

    /** Takes back the buffers whose expected release time has passed. */
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

    /**
     * Writes one buffer into its slot, appends it and schedules its expected release after
     * the buffers already playing.
     * @param {number} descriptor
     * @param {Buffer} pcm
     */
    async function append(descriptor, pcm) {
      const slot = index.get(descriptor);
      check(
        (await call.writeAndCall(
          slotAddress(slot),
          pcm,
          'AppendAudioOutBuffer',
          base,
          descriptor
        )) === APPENDED,
        'Append rejected'
      );
      stats.written++;
      free.delete(descriptor);
      const playhead = inFlight.length ? inFlight[inFlight.length - 1].releaseAt : now();
      inFlight.push({descriptor, releaseAt: Math.max(playhead, now()) + bufferMs});
      stats.appended++;
    }

    const firstFree = () => free.values().next().value;
    /** Input ended with a partial buffer left, which goes out padded with silence. */
    const hasTail = () =>
      inputEnded &&
      pending.bytes > 0 &&
      pending.bytes < bufferBytes &&
      free.size > 0 &&
      inFlight.length < queueMax;
    const isPrimed = () => inFlight.length >= prime || (inputEnded && inFlight.length > 0);
    /** Until the next expected release, bounded to [bufferMs / 8, bufferMs]. */
    const nextSleep = () =>
      inFlight.length
        ? Math.max(bufferMs / MIN_SLEEP_DIVISOR, Math.min(bufferMs, inFlight[0].releaseAt - now()))
        : bufferMs / IDLE_SLEEP_DIVISOR;

    try {
      while (true) {
        if (inFlight.length) await drain();
        const cap = started ? queueMax : prime;
        while (free.size > 0 && inFlight.length < cap && pending.bytes >= bufferBytes) {
          await append(firstFree(), pending.pull(bufferBytes));
        }
        if (hasTail()) {
          const tail = Buffer.alloc(bufferBytes);
          pending.pull(pending.bytes).copy(tail);
          await append(firstFree(), tail);
          stats.tail++;
        }
        if (!started && isPrimed()) {
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

        await sleep(nextSleep());
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

/**
 * @param {string[]} args
 * @returns {import('node:stream').Readable} The --fd or --file stream, or stdin.
 */
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
    bufferFrames: option('--buffer-frames', DEFAULT_BUFFER_FRAMES),
    queue: option('--queue', DEFAULT_QUEUE),
    prime: option('--prime', DEFAULT_PRIME)
  });
  process.on('SIGINT', () => playback.stop());
  process.on('SIGTERM', () => playback.stop());
  console.log('Continuous audio stream ready.');
  const printing = args.includes('--stats')
    ? setInterval(() => {
        console.log(JSON.stringify({event: 'audio-stats', ...playback.stats}));
      }, STATS_INTERVAL_MS)
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
