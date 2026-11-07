import {sdkResolver} from './sdk.js';
import {videoChannel} from './video-channel.js';
import {ByteQueue, createReleaseTimes, pendingExcess} from './audio-queue.js';
import {cleanup} from './lifecycle.js';
import {receiveBufferRequest, REPORT_OFFSET} from './socket-options.js';
import {replyInteger} from './protocol.js';

/** @import {Readable} from 'node:stream' */
/** @import {Civ7Rpc, NativeValue} from './transport.js' */
/** @import {ConsoleNative} from './console-runtime.js' */
/** @import {ReceiveBufferRequest} from './socket-options.js' */

/**
 * What createAudio sends and createAudioPump reads; the console re-checks every address and
 * number, so those stay unknown here.
 * @typedef {object} AudioConfiguration
 * @property {string} host
 * @property {unknown} port
 * @property {string} token
 * @property {unknown} memory
 * @property {unknown} header
 * @property {unknown} chunkBytes
 * @property {{descriptor: unknown, data: unknown}[]} slots
 * @property {{rate: unknown, channels: unknown}} format
 * @property {Record<string, unknown>} policy
 * @property {Record<string, unknown>} functions
 * @property {ReceiveBufferRequest} [receiveBuffer]
 */

/**
 * A console AudioOut buffer: free, receiving a chunk, waiting in the jitter queue, or appended.
 * @typedef {object} AudioSlot
 * @property {bigint} descriptor
 * @property {bigint} data
 * @property {'free' | 'receiving' | 'waiting' | 'output'} state
 * @property {{header: Uint8Array, done: boolean} | null} entry
 */

/** @param {NativeValue} value */
const address = value => '0x' + BigInt(value).toString(16);
const RATE = 48000;
const CHANNELS = 2;
const CHUNK_BYTES = 1920;
const SLOT_COUNT = 16;
const SLOT_BYTES = 0x1000;
const DESCRIPTORS_OFFSET = 0x400;
const HEADER_OFFSET = 0x1000;
const DATA_OFFSET = 0x2000;
const MEMORY_BYTES = DATA_OFFSET + SLOT_COUNT * SLOT_BYTES;
const PENDING_CAP_BYTES = CHUNK_BYTES * 10;

const PARAMETER_OFFSET = 0x300;
const PARAMETER_BYTES = 8;
const PARAMETER_CHANNELS_OFFSET = 4;
const SAMPLE_FORMAT_PCM_INT16 = 2n;
/** What OpenDefaultAudioOut returned while a leaked AudioOut stayed open (device run 2026-11-07). */
const AUDIO_OUT_HELD = 2713n;

export const AUDIO_RESTART_MESSAGE = 'Console audio is still open from an earlier stream. ' +
  'Restart Moonlight on the console';

/**
 * Closes the AudioOut an earlier attach left open in this console process (audio-out-record.js).
 * Never throws: a failure is logged and the next open reports it.
 * @param {Pick<Civ7Rpc, 'request'>} rpc
 * @param {(event: object) => void} log
 */
export async function closeLeftAudioOut(rpc, log) {
  try {
    const reply = await rpc.request({command: 'audio-out', action: 'close'});
    if (reply.closed) log({event: 'audio-out-reaped', memory: reply.memory});
  } catch (error) {
    log({event: 'audio-out-reap-failed', message: error instanceof Error ? error.message : String(error)});
  }
}

/**
 * The console records the AudioOut before opening it, so whatever ends this stream, the next
 * attach can close it. A leftover that cannot be closed needs a console app restart.
 * @param {Civ7Rpc} rpc
 * @param {number} out
 * @param {number} parameter
 * @param {Record<string, {address: string, hex: string}>} functions
 */
async function openRecorded(rpc, out, parameter, functions) {
  try {
    await rpc.request({command: 'audio-out', action: 'close'});
  } catch (error) {
    throw Error(AUDIO_RESTART_MESSAGE, {cause: error});
  }

  const reply = await rpc.request({command: 'audio-out', action: 'open', memory: address(out),
    parameter: address(parameter), functions});
  const opened = replyInteger(reply, 'result');
  if (opened === AUDIO_OUT_HELD) throw Error(AUDIO_RESTART_MESSAGE + ' (AudioOut open returned ' + opened + ')');
  if (opened !== 0n) throw Error('Civ7 AudioOut open failed: ' + opened);
}

/**
 * Opens the default AudioOut at 48 kHz stereo and checks the stream it opened, as hbl-platform
 * sdk/host/audio-out.js does.
 * @param {Civ7Rpc} rpc
 * @param {(name: string, ...args: NativeValue[]) => Promise<bigint>} call
 * @param {number} out The AudioOut object.
 * @param {number} parameter Its parameter block.
 * @param {Record<string, {address: string, hex: string}>} functions What the console records.
 */
async function openAudioOut(rpc, call, out, parameter, functions) {
  await call('InitializeAudioOutParameter', parameter);
  const fields = await rpc.read(parameter, PARAMETER_BYTES);
  fields.writeUInt32LE(RATE);
  fields.writeUInt16LE(CHANNELS, PARAMETER_CHANNELS_OFFSET);
  await rpc.write(parameter, fields);

  await openRecorded(rpc, out, parameter, functions);

  const rateOk = (await call('GetAudioOutSampleRate', out)) === BigInt(RATE);
  const channelsOk = (await call('GetAudioOutChannelCount', out)) === BigInt(CHANNELS);
  const formatOk = (await call('GetAudioOutSampleFormat', out)) === SAMPLE_FORMAT_PCM_INT16;
  if (!rateOk || !channelsOk || !formatOk) throw Error('Unexpected Civ7 AudioOut format');
}

/** Console queue policy (civ7/README.md, Audio). */
export const AUDIO_POLICY = {targetMs: 20, burstMs: 70, windowMs: 500, outputMs: 20, fadeFrames: 72};

/**
 * Opens AudioOut and the PCM channel and forwards `source` chunks to the console's audio pump.
 * @param {Civ7Rpc} rpc
 * @param {Readable} source PCM chunks of CHUNK_BYTES
 * @param {string} hostAddress
 * @param {{channelFactory?: typeof videoChannel}} [options]
 */
export async function createAudio(rpc, source, hostAddress, {channelFactory = videoChannel} = {}) {
  const resolve = sdkResolver(rpc);
  /** @type {Record<string, number>} */
  const functions = {};
  for (const [key, name] of Object.entries({append: 'AppendAudioOutBuffer', released: 'GetReleasedAudioOutBuffer',
    count: 'GetAudioOutBufferCount',
    start: '_ZN2nn5audio13StartAudioOut', stop: '_ZN2nn5audio12StopAudioOut', flush: 'FlushAudioOutBuffers',
    close: '_ZN2nn5audio13CloseAudioOut', errno: 'GetLastErrno'})) functions[key] = await resolve(name);
  const opener = await resolve('OpenDefaultAudioOutEPNS0_8AudioOutER');
  const recorded = (/** @type {number} */ fn) => {
    const hex = rpc.verifiedFunctions.get(address(fn));
    if (!hex) throw Error('Cannot record an unverified AudioOut function');
    return {address: address(fn), hex};
  };
  const lifetime = {open: recorded(opener), stop: recorded(functions.stop), flush: recorded(functions.flush),
    released: recorded(functions.released), close: recorded(functions.close)};
  const memory = await rpc.allocate(MEMORY_BYTES);
  let consoleClosed = false;
  /** @type {Awaited<ReturnType<typeof videoChannel>> | undefined} */
  let channel;
  let stopped = false;
  /** @type {(() => void) | null | undefined} */
  let wake;
  /** @type {Promise<void> | undefined} */
  let sender;
  /** @type {Promise<void> | undefined} */
  let stopping;
  /** @type {Promise<void> | undefined} */
  let releasing;
  const call = async (/** @type {string} */ name, /** @type {NativeValue[]} */ ...args) =>
    (await rpc.callAddress(await resolve(name), args)).result;
  const pending = new ByteQueue();
  const releases = createReleaseTimes();
  const stats = {receivedBytes: 0, droppedBytes: 0, sent: 0,
    get releaseMs() { return releases.summary(Date.now()); }};
  const onData = (/** @type {Buffer} */ chunk) => {
    pending.push(chunk);
    stats.receivedBytes += chunk.length;
    const excess = pendingExcess(pending.bytes, PENDING_CAP_BYTES, CHUNK_BYTES);
    if (excess) stats.droppedBytes += pending.dropOldest(excess);
    wake?.();
    wake = null;
  };
  /** The PC side: input, PCM channel and sender. */
  function stop() {
    return stopping ??= (async () => {
      stopped = true;
      wake?.();
      const errors = await cleanup([
        ['audio-input', () => source.removeListener('data', onData)],
        ['audio-channel', () => channel?.close()],
        ['audio-sender', () => sender?.catch(() => {})]
      ]);
      if (errors.length) throw new AggregateError(errors, 'Audio stop failed');
    })();
  }

  /** The console side: the recorded AudioOut, then its memory once nothing backs it. */
  function release() {
    return releasing ??= (async () => {
      const errors = await cleanup([
        ['audio-out', async () => {
          await rpc.request({command: 'audio-out', action: 'close', memory: address(memory)});
          consoleClosed = true;
        }],
        ['audio-memory', () => consoleClosed && rpc.release(memory)]
      ]);
      if (errors.length) throw new AggregateError(errors, 'Audio cleanup failed');
    })();
  }

  async function close() {
    /** @type {unknown[]} */
    const errors = [];
    for (const step of [stop, release]) {
      try { await step(); }
      catch (error) { errors.push(error); }
    }

    if (errors.length) throw new AggregateError(errors, 'Audio cleanup failed');
  }
  try {
    await rpc.write(memory, Buffer.alloc(MEMORY_BYTES));
    await openAudioOut(rpc, call, memory, memory + PARAMETER_OFFSET, lifetime);
    const slots = [];
    for (let index = 0; index < SLOT_COUNT; index++) {
      const descriptor = memory + DESCRIPTORS_OFFSET + index * 0x40;
      const data = memory + DATA_OFFSET + index * SLOT_BYTES;
      await call('SetAudioOutBufferInfo', descriptor, data, SLOT_BYTES, CHUNK_BYTES);
      slots.push({descriptor: address(descriptor), data: address(data)});
    }
    const pcm = channel = await channelFactory({window: SLOT_COUNT,
      onAcknowledged: event => releases.add(event.elapsedMs, Date.now())});
    source.on('data', onData);
    source.resume();
    sender = (async () => {
      await pcm.connected;
      while (!stopped) {
        if (pending.bytes < CHUNK_BYTES) {
          await new Promise(resolve => { wake = () => resolve(undefined); });
          continue;
        }
        const seq = stats.sent++;
        await pcm.send({seq, pts: seq * 10000, data: pending.pull(CHUNK_BYTES)});
      }
    })();
    sender.catch(() => {});
    /** @type {AudioConfiguration} */
    const configuration = {host: hostAddress, port: pcm.port, token: pcm.token,
      memory: address(memory), header: address(memory + HEADER_OFFSET), chunkBytes: CHUNK_BYTES, slots,
      format: {rate: RATE, channels: CHANNELS}, policy: AUDIO_POLICY,
      functions: Object.fromEntries(Object.entries(functions).map(([key, value]) => [key, address(value)]))};
    const receiveBuffer = await receiveBufferRequest(rpc, memory + HEADER_OFFSET + REPORT_OFFSET, {resolve});
    if (receiveBuffer) configuration.receiveBuffer = receiveBuffer;
    return {configuration, stats, done: sender, stop, release, close};
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/**
 * Console side, shipped by payload.js: receives PCM chunks into AudioOut slots through the
 * jitter queue and acknowledges each one once AudioOut releases it.
 * @param {Pick<ConsoleNative, 'address' | 'integer' | 'checkMemory' | 'verified' | 'call' | 'read32' |
 *   'readMemory' | 'writeBuffer' | 'socket' | 'connect' | 'receive' | 'send' | 'close' | 'encode'> &
 *   {createJitterQueue: typeof import('./audio-queue.js').createJitterQueue,
 *   crossfadePcm: typeof import('./audio-queue.js').crossfadePcm,
 *   setReceiveBuffer?: typeof import('./socket-options.js').setReceiveBuffer}} native
 * @param {AudioConfiguration} configuration
 */
export function createAudioPump(native, configuration) {
  const {address, integer, checkMemory, verified, call, read32, readMemory, writeBuffer,
    socket, connect, receive, send, close, encode, createJitterQueue, crossfadePcm} = native;
  const memory = address(configuration.memory);
  const header = address(configuration.header);
  const chunkBytes = integer(configuration.chunkBytes, 4, 4096);
  checkMemory(memory, 0x200, 3);
  checkMemory(header, 0x1000, 3);
  /** @type {Record<string, bigint>} */
  const functions = {};
  for (const name of ['append', 'released', 'count', 'start', 'errno']) {
    functions[name] = address(configuration.functions[name]);
    if (!verified.has('0x' + functions[name].toString(16))) throw Error('Unverified audio function: ' + name);
  }
  /** @type {AudioSlot[]} */
  const slots = configuration.slots.map(slot => ({descriptor: address(slot.descriptor), data: address(slot.data),
    state: 'free', entry: null}));
  integer(slots.length, 2, 32);
  for (const slot of slots) {
    checkMemory(slot.descriptor, 0x28, 3);
    checkMemory(slot.data, 4096, 3);
    if (slot.data % 4096n) throw Error('Unaligned audio slot');
  }

  const rate = integer(configuration.format.rate, 8000, 192000);
  const channels = integer(configuration.format.channels, 1, 8);
  if (chunkBytes % (channels * 2)) throw Error('Audio chunk is not whole frames');
  const chunkMs = chunkBytes * 1000 / (rate * channels * 2);
  const capacityMs = slots.length * chunkMs;
  const policy = configuration.policy;
  const outputMs = integer(policy.outputMs, Math.ceil(chunkMs * 2), Math.floor(capacityMs));
  const targetMs = integer(policy.targetMs, outputMs, Math.floor(capacityMs));
  const burstMs = integer(policy.burstMs, targetMs, Math.floor(capacityMs - chunkMs));
  const windowMs = integer(policy.windowMs, 50, 10000);
  const fadeFrames = integer(policy.fadeFrames, 0, chunkBytes / (channels * 2));
  const fadeBytes = fadeFrames * channels * 2;
  /** @type {ReturnType<typeof createJitterQueue<AudioSlot>>} */
  const queue = createJitterQueue({chunkMs, targetMs, burstMs, windowMs, outputMs});

  const host = configuration.host.split('.').map(value => integer(Number(value), 0, 255));
  if (host.length !== 4 || !/^[0-9a-f]{64}$/.test(configuration.token)) throw Error('Invalid audio endpoint');
  const port = integer(configuration.port, 1, 65535);
  const endpoint = new Uint8Array(16);
  endpoint.set([16, 2, port >> 8, port & 255, ...host]);
  writeBuffer(header + 0x100n, endpoint);
  const channel = socket(2, 1, 6);
  if (channel < 0n) throw Error('Audio socket failed');

  let started = false;
  let ended = false;
  let headerBytes = 0;
  let dataBytes = 0;
  /** @type {AudioSlot | undefined} */
  let current;
  let ackBytes = 0;
  /** @type {Uint8Array | null} */
  let fadeHead = null;
  let lastPump = -1;
  let lastPlaying = -1;
  let starvedSince = -1;
  /** @type {NonNullable<AudioSlot['entry']>[]} */
  const order = [];
  const stats = {appended: 0, released: 0, dropped: 0, cuts: 0, crossfades: 0, depthMs: 0, maxDepthMs: 0,
    polledStarvations: 0, starvedMsAtLeast: 0, starvedMsAtMost: 0, longestPumpGapMs: 0, pumpGapsOverOutput: 0};
  try {
    if (configuration.receiveBuffer && native.setReceiveBuffer)
      native.setReceiveBuffer(native, channel, configuration.receiveBuffer);
    if (connect(channel, header + 0x100n, 16) !== 0n) throw Error('Audio connect failed');
    writeBuffer(header + 0x200n, encode(configuration.token));
    let sent = 0;
    while (sent < 64) {
      const count = Number(send(channel, header + 0x200n + BigInt(sent), 64 - sent, 0));
      if (count <= 0 || count > 64 - sent) throw Error('Audio authentication failed');
      sent += count;
    }
  } catch (error) { close(channel); throw error; }

  /**
   * @param {typeof receive} operation receive or send
   * @param {bigint} pointer
   * @param {number} length
   */
  function transfer(operation, pointer, length) {
    const count = Number(operation(channel, pointer, length, 0x80));
    if (count < 0) {
      const errno = Number(call(functions.errno));
      if (errno === 11 || errno === 4) return 0;
      throw Error('Audio socket error: ' + errno);
    }
    if (count === 0) ended = true;
    if (count > length) throw Error('Invalid audio transfer length');
    return count;
  }

  /** @param {AudioSlot} slot */
  function finish(slot) {
    if (slot.entry) slot.entry.done = true;
    slot.entry = null;
    slot.state = 'free';
  }

  /** @param {number} now */
  function trackPumpGap(now) {
    if (lastPump >= 0) {
      const gap = now - lastPump;
      stats.longestPumpGapMs = Math.max(stats.longestPumpGapMs, gap);
      if (gap > outputMs) stats.pumpGapsOverOutput++;
    }
    lastPump = now;
  }

  function collectReleased() {
    for (let index = 0; index < slots.length; index++) {
      const released = call(functions.released, memory);
      if (released === 0n) break;
      const slot = slots.find(slot => slot.descriptor === released);
      if (!slot || slot.state !== 'output') throw Error('Unexpected released audio buffer');
      queue.release();
      finish(slot);
      stats.released++;
    }
  }

  /** @param {number} now */
  function pollStarvation(now) {
    if (!started || ended || starvedSince >= 0) return;
    if (queue.output > 1) {
      lastPlaying = now;
      return;
    }
    if (Number(call(functions.count, memory)) > 0) {
      lastPlaying = now;
      return;
    }
    stats.polledStarvations++;
    starvedSince = now;
  }

  /** @param {number} now */
  function endStarvation(now) {
    if (starvedSince < 0) return;
    stats.starvedMsAtLeast += now - starvedSince;
    stats.starvedMsAtMost += now - lastPlaying;
    starvedSince = -1;
  }

  /**
   * @param {{dropped: AudioSlot[], appended: AudioSlot[]}} step
   * @param {number} now
   */
  function apply({dropped, appended}, now) {
    if (dropped.length && !fadeHead && fadeBytes) fadeHead = readMemory(dropped[0].data, fadeBytes);
    for (const slot of dropped) finish(slot);
    for (const slot of appended) {
      if (fadeHead) {
        writeBuffer(slot.data, crossfadePcm(fadeHead, readMemory(slot.data, fadeBytes), fadeFrames, channels));
        fadeHead = null;
        stats.crossfades++;
      }
      if (call(functions.append, memory, slot.descriptor) !== 1n) throw Error('Audio append refused');
      slot.state = 'output';
      stats.appended++;
      endStarvation(now);
    }
    if (!started && queue.output >= 2) {
      call(functions.start, memory);
      started = true;
      lastPlaying = now;
    }
  }

  /** @param {number} now */
  function receiveChunk(now) {
    current ||= slots.find(slot => slot.state === 'free');
    if (!current) {
      apply(queue.step(now), now);
      current = slots.find(slot => slot.state === 'free');
      if (!current) return false;
    }
    current.state = 'receiving';
    if (headerBytes < 16) {
      headerBytes += transfer(receive, header + BigInt(headerBytes), 16 - headerBytes);
      if (headerBytes < 16) return false;
      if (Number(read32(header)) !== chunkBytes) throw Error('Unexpected PCM chunk size');
    }
    dataBytes += transfer(receive, current.data + BigInt(dataBytes), chunkBytes - dataBytes);
    if (dataBytes < chunkBytes) return false;

    current.entry = {header: readMemory(header, 16), done: false};
    order.push(current.entry);
    current.state = 'waiting';
    queue.push(current);
    current = undefined;
    headerBytes = 0;
    dataBytes = 0;
    return true;
  }

  function sendAcknowledgements() {
    while (order.length && order[0].done && !ended) {
      writeBuffer(header + 0x800n, order[0].header);
      ackBytes += transfer(send, header + 0x800n + BigInt(ackBytes), 16 - ackBytes);
      if (ackBytes < 16) return;
      order.shift();
      ackBytes = 0;
    }
  }

  return {
    stats,
    retry() {
      const errno = Number(call(functions.errno));
      if (errno !== 11 && errno !== 4) throw Error('Stream socket error: ' + errno);
    },
    pump() {
      const now = Date.now();
      trackPumpGap(now);
      collectReleased();
      pollStarvation(now);
      for (let round = 0; round < slots.length * 2 && !ended; round++) {
        if (!receiveChunk(now)) break;
      }
      apply(queue.step(now), now);
      sendAcknowledgements();
      Object.assign(stats, queue.stats);
    },
    close() { close(channel); }
  };
}
