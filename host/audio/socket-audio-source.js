/**
 * Moonlight PCM paced over a native TCP stream into the console socket audio worker.
 *
 * Incoming PCM is queued on the host and sent one chunk per chunk duration, on a clock of
 * its own: when the queue runs dry a silent chunk goes out instead, so the console worker,
 * which blocks in recv, always gets a steady stream. A queue that grows past maxPending
 * drops its oldest whole chunks. With `tone`, a 500 Hz test tone replaces the input, which
 * is still drained.
 *
 * A pacer that falls more than the console's two slots behind (an event-loop stall) refills
 * both slots at once, which the console has played out by then, and skips the rest of the
 * stall in whole chunks. The audio of the skipped chunks lands in the queue after the stall
 * and is trimmed from its head at the next on-time sends, so the host does not keep it as
 * latency until an overflow throws it away.
 *
 * The rpc is wrapped so a lost bridge is noticed: the console objects are then retained
 * rather than closed, and the report asks for a SmileBASIC restart.
 */
import {ByteQueue} from './audio-stream.js';
import {create as createNativeTransport} from '../stream/native-tcp.js';
import {create as createAudioWorker} from './audio-socket-worker.js';

const SAMPLE_RATE = 48000;
/** One interleaved stereo s16 sample frame. */
const FRAME_BYTES = 4;
/** Offset of the right channel's sample within a frame. */
const RIGHT_SAMPLE_OFFSET = 2;
const SAMPLE_BYTES = 2;
/** Two chunks are appended before playback starts. */
const PRIMED = 2;
const DEFAULT_BUFFER_BYTES = 7680;
const HEALTH_MS = 1000;
const MAX_PENDING_CHUNKS = 4;
/** How long after a late send the on-time sends trim the queue back to one chunk. */
const SETTLE_MS = 1000;
const TONE_HZ = 500;
const TONE_AMPLITUDE = 8000;
/** Errors that mean the bridge itself is gone, not just one call. */
const BRIDGE_LOST = /disconnected|timed out|ECONN|EPIPE|socket hang up/i;
/** The rpc methods that reach the console. */
const RPC_METHODS = [
  'request',
  'call',
  'callAddress',
  'pair',
  'read',
  'write',
  'query',
  'writeAndCall'
];

/**
 * @typedef {object} SourceOptions
 * @property {any} rpc
 * @property {string} [host] Host address the console connects back to; defaults to rpc.host.
 * @property {number} [bufferBytes] Bytes per chunk.
 * @property {boolean} [tone] Play a test tone instead of the input.
 * @property {number} [maxPending] Queued bytes kept before the oldest chunks are dropped.
 * @property {number} [healthMs] Interval of the worker health polls.
 * @property {(options: {rpc: any, host: string}) => Promise<any>} [createTransport]
 * @property {(options: {rpc: any, transport: any, bufferBytes: number}) => Promise<any>}
 *   [createAudio]
 * @property {() => number} [now] Clock in milliseconds.
 * @property {(ms: number) => Promise<unknown>} [sleep]
 * @property {(callback: () => void, ms: number) => any} [every]
 * @property {(timer: any) => void} [cancel]
 * @property {(error: Error) => void} [onError] Called once when playback fails.
 */

/**
 * @typedef {object} SocketAudioSource
 * @property {(stream: import('node:stream').Readable) => void} attach Feeds PCM from a stream.
 * @property {() => void} halt Stops pacing and detaches the input.
 * @property {() => Promise<object>} close Halts, releases the console objects and reports.
 * @property {() => object} report The current counters.
 */

/**
 * One chunk of a stereo sine tone, the same on both channels.
 * @param {number} bytes
 * @returns {Buffer}
 */
function toneChunk(bytes) {
  const chunk = Buffer.alloc(bytes);
  for (let frame = 0; frame < bytes / FRAME_BYTES; frame++) {
    const sample = Math.round(
      TONE_AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * frame) / SAMPLE_RATE)
    );
    chunk.writeInt16LE(sample, frame * FRAME_BYTES);
    chunk.writeInt16LE(sample, frame * FRAME_BYTES + RIGHT_SAMPLE_OFFSET);
  }
  return chunk;
}

/**
 * The largest absolute s16 sample in a chunk.
 * @param {Buffer} chunk
 * @returns {number}
 */
function peakOf(chunk) {
  let peak = 0;
  for (let offset = 0; offset + 1 < chunk.length; offset += SAMPLE_BYTES)
    peak = Math.max(peak, Math.abs(chunk.readInt16LE(offset)));
  return peak;
}

/**
 * Wraps the rpc's console-facing methods so an error that means the bridge is gone sets
 * state.bridgeLost.
 * @param {any} rpc
 * @param {{bridgeLost: boolean}} state
 * @returns {any}
 */
function watched(rpc, state) {
  const device = {...rpc};
  for (const name of RPC_METHODS) {
    if (typeof rpc[name] !== 'function') continue;
    device[name] = async (...args) => {
      try {
        return await rpc[name](...args);
      } catch (error) {
        if (BRIDGE_LOST.test(error.message)) state.bridgeLost = true;
        throw error;
      }
    };
  }
  return device;
}

/**
 * Opens the transport and socket audio worker, primes two silent chunks and starts pacing.
 * A failed setup throws an error carrying the report.
 * @param {SourceOptions} options
 * @returns {Promise<SocketAudioSource>}
 */
async function create({
  rpc,
  host = rpc.host,
  bufferBytes = DEFAULT_BUFFER_BYTES,
  tone = false,
  maxPending = MAX_PENDING_CHUNKS * bufferBytes,
  healthMs = HEALTH_MS,
  createTransport = createNativeTransport,
  createAudio = createAudioWorker,
  now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  every = (callback, ms) => setInterval(callback, ms),
  cancel = clearInterval,
  onError = () => {}
}) {
  const bufferMs = (bufferBytes / FRAME_BYTES / SAMPLE_RATE) * 1000;
  const silence = Buffer.alloc(bufferBytes);
  const toned = tone ? toneChunk(bufferBytes) : null;
  const state = {bridgeLost: false};
  const device = watched(rpc, state);
  const stats = {
    bufferBytes,
    tone,
    peak: 0,
    sent: 0,
    underruns: 0,
    silenceChunks: 0,
    overruns: 0,
    droppedBytes: 0,
    receivedBytes: 0,
    late: 0,
    trimmed: 0,
    healthPolls: 0,
    lastCycle: null,
    cycleCheck: null,
    retainedForSafety: false,
    error: null
  };
  let transport = null;
  let audio = null;

  /**
   * Stops the worker and closes the transport, or, when the worker or the bridge may still
   * hold them, aborts the transport and keeps the console objects. Never throws; failures
   * land in stats.error.
   */
  async function release() {
    let failure = null;
    if (audio && !audio.retained) {
      try {
        await audio.stop();
        if (stats.sent) stats.cycleCheck = 'pass';
      } catch (error) {
        failure = error;
      }
    }
    const retained = Boolean(audio?.retained || state.bridgeLost);
    if (transport) {
      if (retained) transport.abort();
      else
        try {
          await transport.close();
        } catch (error) {
          failure ||= error;
        }
    }
    stats.retainedForSafety = retained;
    if (failure) stats.error ||= failure.message;
    if (retained) {
      stats.error ||= 'Socket audio objects retained for safety';
      if (!/restart SmileBASIC/.test(stats.error)) stats.error += '; restart SmileBASIC';
    }
  }

  try {
    transport = await createTransport({rpc: device, host});
    audio = await createAudio({rpc: device, transport, bufferBytes});
    await audio.start(silence, silence);
    stats.sent = PRIMED;
  } catch (error) {
    stats.error = error.message;
    await release();
    throw Object.assign(Error(stats.error), {report: report()});
  }

  const queue = new ByteQueue();
  let input = null;
  let halted = false;
  let fed = false;
  let underflowing = false;
  let failed = false;
  let polling = null;
  let closing = null;
  let settleUntil = -Infinity;
  /** @type {(value?: unknown) => void} */
  let wake = () => {};

  /** @param {Error} error */
  function fail(error) {
    if (halted || failed) return;
    failed = true;
    stats.error ||= error.message;
    halt();
    onError(error);
  }

  /** Drops the oldest whole chunks once the queue holds more than maxPending bytes. */
  function dropOverflow() {
    if (queue.bytes > maxPending) {
      const excess = queue.bytes - maxPending;
      const wholeChunkBytes = Math.ceil(excess / bufferBytes) * bufferBytes;
      const dropped = queue.dropOldest(Math.min(wholeChunkBytes, queue.bytes));
      stats.droppedBytes += dropped;
      stats.overruns += Math.round(dropped / bufferBytes) || 1;
    }
  }

  /** Drops the oldest whole chunks while more than one is queued, counting them. */
  function trimSurplus() {
    while (queue.bytes >= 2 * bufferBytes) {
      queue.dropOldest(bufferBytes);
      stats.trimmed++;
    }
  }

  /** @param {Buffer} chunk */
  function onData(chunk) {
    if (halted) return;
    fed = true;
    stats.receivedBytes += chunk.length;
    queue.push(chunk);
    dropOverflow();
  }
  const onInputError = error => fail(error);

  /**
   * The next chunk to send: the tone, queued PCM, or silence when the queue is short. Counts
   * an underrun when a fed input first runs dry.
   * @returns {Buffer}
   */
  function nextChunk() {
    if (toned) {
      if (queue.bytes >= bufferBytes) queue.pull(bufferBytes);
      return toned;
    }
    if (queue.bytes >= bufferBytes) {
      underflowing = false;
      return queue.pull(bufferBytes);
    }
    stats.silenceChunks++;
    if (fed && !underflowing) stats.underruns++;
    underflowing = fed;
    return silence;
  }

  /** Sleeps until `ms` have passed or halt() wakes it. */
  function pause(ms) {
    return new Promise(resolve => {
      wake = resolve;
      sleep(ms).then(resolve);
    });
  }

  const pacing = (async () => {
    let due = now();
    let slept = false;
    while (!halted) {
      const wait = due - now();
      if (wait > 0) {
        await pause(wait);
        slept = true;
        continue;
      }
      const behind = now() - due;
      if (behind > PRIMED * bufferMs) {
        stats.late++;
        due += Math.floor((behind - (PRIMED - 1) * bufferMs) / bufferMs) * bufferMs;
        settleUntil = now() + SETTLE_MS;
      }
      if (slept && behind < bufferMs && now() <= settleUntil) trimSurplus();
      slept = false;
      const chunk = nextChunk();
      await audio.send(chunk);
      stats.sent++;
      stats.peak = Math.max(stats.peak, peakOf(chunk));
      due += bufferMs;
    }
  })().catch(fail);

  const timer = every(() => {
    if (halted || polling) return;
    polling = audio
      .health()
      .then(health => {
        stats.healthPolls++;
        stats.lastCycle = health.results ?? null;
      })
      .catch(fail)
      .finally(() => {
        polling = null;
      });
  }, healthMs);

  /** @param {import('node:stream').Readable} stream */
  function attach(stream) {
    if (input || halted) throw Error('Socket audio input is already attached');
    input = stream;
    input.on('data', onData);
    input.on('error', onInputError);
  }

  function halt() {
    if (halted) return;
    halted = true;
    wake();
    cancel(timer);
    if (input) {
      input.off('data', onData);
      input.on('error', () => {});
      input.destroy?.();
    }
  }

  function report() {
    return {
      ...stats,
      appended: stats.sent,
      released: Math.max(0, stats.sent - PRIMED),
      countersFrom: 'host'
    };
  }

  /** Halts, waits for the pacer and any health poll, then releases. Idempotent. */
  function close() {
    closing ||= (async () => {
      halt();
      await pacing;
      await polling;
      await release();
      return report();
    })();
    return closing;
  }

  return {attach, halt, close, report};
}

export {create};
