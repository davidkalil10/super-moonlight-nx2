/**
 * Socket audio on the console: the host sends PCM over a native TCP socket and a console
 * worker thread receives it straight into AudioOut buffers, so sample data never crosses the
 * bridge.
 *
 * create() opens the default AudioOut with a release event, checks it plays 48 kHz stereo
 * s16 and gives it two buffer slots. start() sends two chunks, receives and appends them
 * with finite native jobs (the prime), then starts AudioOut and spawns a repeating worker
 * that recycles the slots as they are released (see audio-socket-plan.js). Every later
 * send() feeds that worker.
 *
 * The worker blocks in recv and in the release event wait, so stop() points it at its exit
 * and sends two silent chunks to unblock it before waiting and joining. Whenever a native
 * job or the worker may still hold the AudioOut or its buffers, the objects are retained:
 * nothing is closed and SmileBASIC has to be restarted.
 */
import {allocate} from '../../../hbl-platform/sdk/native/allocate.js';
import {sdkResolver, verify} from '../../../hbl-platform/sdk/native/symbols.js';
import {create as createFinite} from '../../../hbl-platform/sdk/native/finite.js';
import * as repeating from '../../../hbl-platform/sdk/native/repeating.js';
import {
  CODE,
  verifyCode,
  verifyCopy,
  spawn,
  wait,
  join
} from '../../../hbl-platform/sdk/native/thread.js';
import SYNC from '../../../hbl-platform/sdk/native/os-sync-functions.json' with {type: 'json'};
import * as audioSocket from './audio-socket-plan.js';

/**
 * The AudioOut region: the AudioOut object at 0, its release event, the open parameter and
 * the descriptors below PCM_OFFSET, then one PCM slot per descriptor.
 */
const AUDIO_BYTES = 0x20000;
const AUDIO_ALIGN = 0x10000;
const EVENT_OFFSET = 0x100;
const PARAM_OFFSET = 0x300;
const DESCRIPTOR_OFFSET = 0x400;
const DESCRIPTOR_STRIDE = 0x40;
const PCM_OFFSET = 0x10000;
/** Capacity of one PCM slot, and so the largest chunk. */
const PCM_STRIDE = 0x4000;
const SLOT_COUNT = 2;
/** Room for the recycle worker's repeating frame, snapshot and results. */
const WORKER_BYTES = 0x400000;
/** Where pthread_join stores the worker's exit value; spawn stores the thread at offset 0. */
const EXIT_SLOT_OFFSET = 8;

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
/** GetAudioOutSampleFormat value for 16-bit PCM. */
const SAMPLE_FORMAT_PCM_INT16 = 2n;
const PARAMETER_BYTES = 8;
const PARAMETER_RATE_OFFSET = 0;
const PARAMETER_CHANNELS_OFFSET = 4;
/** One interleaved stereo s16 sample frame; chunks are whole frames. */
const FRAME_BYTES = 4;
const DEFAULT_BUFFER_BYTES = 7680;

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;
const STOP_POLL_MS = 25;

/** Reply output bytes for native calls: too few to carry an output slot, only the result. */
const SHORT = 2;
/** recv() flag: block until the whole buffer has arrived. */
const MSG_WAITALL = 0x40;
const RESULT_BYTES = 8;
/** AppendAudioOutBuffer returns true when it queued the buffer. */
const APPENDED = 1n;
const OPEN_WITH_EVENT =
  'OpenDefaultAudioOutEPNS0_8AudioOutEPNS_2os11SystemEventERKNS0_17AudioOutParameterE';
/** Resolved in this order before anything is allocated. */
const FUNCTION_NAMES = [
  'InitializeAudioOutParameter',
  OPEN_WITH_EVENT,
  'GetAudioOutSampleRate',
  'GetAudioOutChannelCount',
  'GetAudioOutSampleFormat',
  'SetAudioOutBufferInfo',
  'AppendAudioOutBuffer',
  'StartAudioOut',
  'GetReleasedAudioOutBuffer',
  'GetAudioOutBufferCount',
  'StopAudioOut',
  'FlushAudioOutBuffers',
  'CloseAudioOut'
];

/** @typedef {import('../../../hbl-platform/sdk/native/allocate.js').Rpc} Rpc */

/**
 * @typedef {object} NativeTransport
 * @property {number} fd Console socket descriptor the PCM arrives on.
 * @property {number} recvFunction Address of the console recv function.
 * @property {(bytes: Buffer) => Promise<void>} send Sends bytes from the host end.
 */

/**
 * @typedef {object} SocketAudio
 * @property {(first: Buffer, second: Buffer) => Promise<void>} start Primes two chunks and
 *   starts playback.
 * @property {(bytes: Buffer) => Promise<void>} send Queues one chunk for the worker.
 * @property {() => Promise<{sent: number, running: boolean, retained: boolean,
 *   results?: string[]}>} health The worker's latest results while it runs.
 * @property {() => Promise<void>} stop
 * @property {boolean} retained True when the AudioOut objects were kept for safety.
 */

/**
 * @param {Buffer} bytes
 * @param {number} length
 * @returns {Buffer} bytes, when it is exactly one chunk.
 */
function checkedPcm(bytes, length) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== length)
    throw Error('Socket audio needs one complete PCM chunk');
  return bytes;
}

/**
 * @param {any} rpc
 * @param {NativeTransport} transport
 * @param {number} bufferBytes
 * @param {number} timeoutMs
 * @returns {boolean}
 */
function isBoundedSetup(rpc, transport, bufferBytes, timeoutMs) {
  return (
    Boolean(rpc?.a?.sdk) &&
    Boolean(transport) &&
    Number.isInteger(transport.fd) &&
    transport.fd >= 0 &&
    Number.isSafeInteger(transport.recvFunction) &&
    typeof transport.send === 'function' &&
    Number.isInteger(bufferBytes) &&
    bufferBytes >= FRAME_BYTES &&
    bufferBytes <= PCM_STRIDE &&
    !(bufferBytes % FRAME_BYTES) &&
    Number.isInteger(timeoutMs) &&
    timeoutMs >= MIN_TIMEOUT_MS &&
    timeoutMs <= MAX_TIMEOUT_MS
  );
}

/**
 * @param {number} audio
 * @returns {{descriptor: number, data: number}[]}
 */
function slotsAt(audio) {
  return Array.from({length: SLOT_COUNT}, (_, index) => ({
    descriptor: audio + DESCRIPTOR_OFFSET + index * DESCRIPTOR_STRIDE,
    data: audio + PCM_OFFSET + index * PCM_STRIDE
  }));
}

/**
 * @param {Buffer} bytes
 * @param {number} count
 * @returns {bigint[]}
 */
function resultWords(bytes, count) {
  return Array.from({length: count}, (_, index) => bytes.readBigUInt64LE(index * RESULT_BYTES));
}

/**
 * Opens the default AudioOut over a native TCP transport and returns its controls.
 * @param {{rpc: Rpc, transport: NativeTransport, bufferBytes?: number, timeoutMs?: number}}
 *   options timeoutMs bounds the wait for the worker to stop.
 * @returns {Promise<SocketAudio>}
 */
async function create({
  rpc,
  transport,
  bufferBytes = DEFAULT_BUFFER_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (!isBoundedSetup(rpc, transport, bufferBytes, timeoutMs))
    throw Error('Socket audio needs a bounded native TCP transport');
  await verifyCode(rpc);
  await verifyCopy(rpc);
  await verify(rpc, rpc.a.sdk + SYNC.waitSystemEvent.offset, SYNC.waitSystemEvent.hex);
  const resolve = sdkResolver(rpc, {ambiguous: 'Ambiguous socket audio function '});
  /** @type {Record<string, number>} */
  const functions = {};
  for (const name of FUNCTION_NAMES) functions[name] = await resolve(name);
  const call = async (name, args = []) =>
    (await rpc.callAddress(functions[name], args, SHORT)).result;
  const audio = await allocate(rpc, AUDIO_BYTES, {
    align: AUDIO_ALIGN,
    failed: 'Socket audio allocation failed',
    invalid: 'Invalid socket audio allocation'
  });
  await rpc.write(audio, Buffer.alloc(PCM_OFFSET));
  const event = audio + EVENT_OFFSET;
  const param = audio + PARAM_OFFSET;
  const slots = slotsAt(audio);
  await call('InitializeAudioOutParameter', [param]);
  const parameter = await rpc.read(param, PARAMETER_BYTES);
  parameter.writeUInt32LE(SAMPLE_RATE, PARAMETER_RATE_OFFSET);
  parameter.writeUInt16LE(CHANNELS, PARAMETER_CHANNELS_OFFSET);
  await rpc.write(param, parameter);
  if ((await call(OPEN_WITH_EVENT, [audio, event, param])) !== 0n)
    throw Error('Socket AudioOut event overload failed');
  let opened = true;
  let started = false;
  let running = false;
  let stopped = false;
  let retained = false;
  let thread = null;
  let program = null;
  let cycleRows = null;
  let cycleCallCount = 0;
  let sent = 0;
  try {
    if (
      (await call('GetAudioOutSampleRate', [audio])) !== BigInt(SAMPLE_RATE) ||
      (await call('GetAudioOutChannelCount', [audio])) !== BigInt(CHANNELS) ||
      (await call('GetAudioOutSampleFormat', [audio])) !== SAMPLE_FORMAT_PCM_INT16
    )
      throw Error('Unexpected socket AudioOut format');
    for (const slot of slots)
      await call('SetAudioOutBufferInfo', [slot.descriptor, slot.data, PCM_STRIDE, bufferBytes]);
    const finite = await createFinite(rpc, {
      verified: new Set([transport.recvFunction, functions.AppendAudioOutBuffer])
    });
    const workerBase = await allocate(rpc, WORKER_BYTES, {
      failed: 'Socket audio recycle worker allocation failed',
      invalid: 'Invalid socket audio recycle worker allocation'
    });
    const options = {
      sdk: rpc.a.sdk,
      base: workerBase,
      fd: transport.fd,
      audio,
      event,
      recv: transport.recvFunction,
      append: functions.AppendAudioOutBuffer,
      getReleased: functions.GetReleasedAudioOutBuffer,
      slots,
      bufferBytes
    };

    /** Runs a finite native job; a failed job may still hold the buffers, so retain. */
    function runRetaining(calls) {
      return finite.run(calls).catch(error => {
        retained = true;
        throw error;
      });
    }

    /** @param {Buffer} bytes */
    async function send(bytes) {
      if (stopped || retained) throw Error('Socket audio is no longer writable');
      await transport.send(checkedPcm(bytes, bufferBytes));
      sent++;
    }

    /**
     * Sends two chunks, receives and appends them (nothing is appended unless both arrived
     * whole), writes the recycle frame, starts AudioOut and spawns the recycle worker.
     * @param {Buffer} first
     * @param {Buffer} second
     */
    async function start(first, second) {
      if (started || stopped || retained) throw Error('Socket audio start is not available');
      checkedPcm(first, bufferBytes);
      checkedPcm(second, bufferBytes);
      await send(first);
      await send(second);
      const received = await runRetaining(
        slots.map(slot => ({
          function: transport.recvFunction,
          args: [transport.fd, slot.data, bufferBytes, MSG_WAITALL]
        }))
      );
      if (received.some(value => Number(BigInt.asIntN(64, value)) !== bufferBytes))
        throw Error('Socket audio prime receive was short; append gate remains closed');
      const appended = await runRetaining(
        slots.map(slot => ({
          function: functions.AppendAudioOutBuffer,
          args: [audio, slot.descriptor, 0, 0]
        }))
      );
      if (appended.some(value => value !== APPENDED))
        throw Error('Socket AudioOut rejected prime buffer');
      const cycle = audioSocket.cycle(options);
      cycleRows = cycle.rows;
      cycleCallCount = cycle.calls.length;
      program = await repeating.prepare(rpc, {
        base: workerBase,
        code: CODE,
        calls: cycle.calls,
        verified: cycle.verified
      });
      if ((await call('StartAudioOut', [audio])) !== 0n)
        throw Error('Socket AudioOut start failed');
      started = true;
      try {
        thread = await spawn(rpc, workerBase, program.live, {
          failed: 'Socket audio recycle worker creation failed',
          outputBytes: SHORT
        });
      } catch (error) {
        retained = true;
        throw error;
      }
      running = true;
    }

    async function health() {
      if (!running || !program) return {sent, running, retained};
      const bytes = await rpc.read(program.results, cycleCallCount * RESULT_BYTES);
      return {
        sent,
        running,
        retained,
        results: resultWords(bytes, cycleCallCount).map(String)
      };
    }

    /**
     * Sends the worker to its exit and unblocks its recv and release wait with two silent
     * chunks, then waits for it and joins it. The objects are retained when any of that
     * fails, since the worker may still be running. A bad recycle result is thrown only
     * after AudioOut is closed.
     */
    async function stop() {
      if (stopped) {
        if (retained) throw Error('Socket audio objects retained for safety');
        return;
      }
      stopped = true;
      let cycleError = null;
      if (running) {
        try {
          await program.stop();
          await transport.send(Buffer.alloc(bufferBytes));
          await transport.send(Buffer.alloc(bufferBytes));
        } catch (error) {
          retained = true;
          throw error;
        }
        try {
          const done = await wait(rpc, thread, {
            timeoutMs,
            pollMs: STOP_POLL_MS,
            invalid: 'Socket audio recycle worker state invalid',
            outputBytes: SHORT
          });
          if (!done) throw Error('Socket audio recycle worker did not stop; restart SmileBASIC');
          await join(rpc, thread, workerBase + EXIT_SLOT_OFFSET, {
            failed: 'Socket audio recycle worker join failed',
            outputBytes: SHORT
          });
        } catch (error) {
          retained = true;
          throw error;
        }
        running = false;
        const bytes = await rpc.read(program.results, cycleCallCount * RESULT_BYTES);
        const results = resultWords(bytes, cycleCallCount);
        try {
          audioSocket.checkedCycle(results, cycleRows, slots, bufferBytes);
        } catch (error) {
          cycleError = error;
        }
      }
      if (retained) throw Error('Socket audio objects retained for safety');
      if (started) await call('StopAudioOut', [audio]);
      if (opened) {
        await call('FlushAudioOutBuffers', [audio]);
        await call('CloseAudioOut', [audio]);
        opened = false;
      }
      if (cycleError) throw cycleError;
    }

    return {
      start,
      send,
      health,
      stop,
      get retained() {
        return retained;
      }
    };
  } catch (error) {
    if (opened) {
      await call('FlushAudioOutBuffers', [audio]).catch(() => {});
      await call('CloseAudioOut', [audio]).catch(() => {});
    }
    throw error;
  }
}

export {create, checkedPcm};
