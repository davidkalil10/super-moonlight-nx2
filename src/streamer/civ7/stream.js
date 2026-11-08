import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {Readable} from 'node:stream';
import {AccessUnits, scanUnit} from '../session/h264-stream.js';
import {decodedSize, isMain8, obuKeyframes, streamSizes} from '../session/av1-stream.js';
import {create} from './decoder.js';
import {createAv1Decoder} from './av1-decoder.js';
import {videoChannel} from './video-channel.js';
import {createVideoQueue} from './video-queue.js';
import {createInput} from './input.js';
import {createAudio} from './audio.js';
import {toMoonlight, same, NEUTRAL} from '../input/controller.js';
import * as touch from '../input/touch.js';
import * as ring from '../shared/ring.js';
import {cleanup, stopChild} from './lifecycle.js';
import {createFrameRateGuard} from './frame-rate.js';
import {isCaughtUp} from './latency.js';
import {receiveBufferReports, receiveBufferRequest, REPORT_OFFSET} from './socket-options.js';
import {sdkResolver} from './sdk.js';
import {createUdpVideoSender, UDP_VIDEO} from './udp-video.js';
import {VIDEO, MODE} from '../../renderer/civ7/layout.js';

/** @import {Civ7Rpc, NativeValue} from './transport.js' */
/** @import {PadRecord} from '../input/input-record.js' */
/** @import {TimedFrame} from './latency.js' */

/** @param {NativeValue} value */
const address = value => '0x' + BigInt(value).toString(16);
const CAPACITY = 8 * 1024 * 1024;
const COPY_OFFSET = 0x5224e0;
const COPY_SIGNATURE = 'ec0301cb8a0940924b000aeb69040054e90301aae80300aa6a0100b4e80301aa';

const RELEASED_PAD = toMoonlight(NEUTRAL);

/** @param {unknown} error */
const errorText = error => error instanceof Error ? error.message : String(error);

/**
 * Forwards the console's input records (input/input-record.js) to the helper. The console maps
 * gates input and detects the stop chord. This side forwards records and ends the stream on
 * a stop request; the optional host gate supports legacy callers. Called per acknowledged frame.
 * @param {{write(line: string): void, allowInput?: () => boolean, onStop(): void,
 *   log?: (event: object) => void}} options
 */
export function createInputForwarder({write, allowInput = () => true, onStop, log = event => {}}) {
  const touches = touch.createTracker();
  /** @type {PadRecord | undefined} */
  let consolePad;
  /** @type {PadRecord | undefined} */
  let sentPad;
  let changes = 0;
  let touchEvents = 0;
  let stopping = false;

  function forwardPad() {
    const pad = allowInput() ? consolePad : RELEASED_PAD;
    if (!pad || same(pad, sentPad)) return;

    sentPad = pad;
    changes++;
    write(JSON.stringify({type: 'controller', ...pad}) + '\n');
  }

  /**
   * Keeps the helper's fingers consistent across gating: a finger down while input was not
   * allowed is ignored until it lifts.
   * @param {import('../input/touch.js').TouchEvent} event
   */
  function accept(event) {
    if (event.action === 'down') {
      touches.active.set(event.id, {x: event.x, y: event.y});
      return true;
    }
    if (!touches.active.has(event.id)) return false;

    if (event.action === 'up') touches.active.delete(event.id);
    else touches.active.set(event.id, {x: event.x, y: event.y});
    return true;
  }

  /** @param {import('../input/touch.js').TouchEvent[]} events */
  function forwardTouch(events) {
    const forwarded = allowInput() ? events.filter(accept) : touch.flush(touches);
    if (!forwarded.length) return;

    touchEvents += forwarded.length;
    write(touch.touchLine(forwarded) + '\n');
  }

  return {
    /** @param {import('../input/input-record.js').InputRecord | null} record */
    onInput(record) {
      if (stopping) return;

      if (record?.pad) consolePad = record.pad;
      forwardPad();
      forwardTouch(record?.touch || []);
      if (!record?.stop) return;

      stopping = true;
      log({type: 'stop-chord'});
      onStop();
    },
    /** Releases the pad and lifts every forwarded finger, for the end of the stream. */
    release() {
      write(JSON.stringify({type: 'controller', ...RELEASED_PAD}) + '\n');
      const lifted = touch.flush(touches);
      if (lifted.length) write(touch.touchLine(lifted) + '\n');
    },
    changes: () => changes,
    touchEvents: () => touchEvents
  };
}

/** Frames the console decoded without presenting, counted per `civ7-stats` second. */
export function createCaughtUpCounter() {
  let count = 0;

  return {
    /** @param {TimedFrame} frame */
    onTiming(frame) {
      if (isCaughtUp(frame.timing)) count++;
    },
    take() {
      const taken = count;
      count = 0;
      return taken;
    }
  };
}

/**
 * Logs a failed console stream request with the console's message and keeps it, so the stream
 * fails with that cause rather than with the "Video closed" errors the rejection leads to. Lines
 * after the first (the AV1 step trace) go to the log only.
 * @param {Promise<unknown>} request
 * @param {{log: (event: object) => void, onFailure: (error: unknown) => void}} options
 */
export function watchConsoleRequest(request, {log, onFailure}) {
  /** @type {{error: unknown} | undefined} */
  let failed;

  request.catch(error => {
    const message = String(/** @type {{message?: unknown}} */ (error)?.message || error);
    const [cause, ...details] = message.split('\n');
    failed = {error: details.length ? Error(cause) : error};
    log({type: 'video-stream-error', message: cause, ...(details.length ? {details} : {})});
    onFailure(error);
  });
  return {failure: () => failed};
}

/**
 * Cleanup steps that need the console, skipped once `rpc` is disconnected: the next attach reaps
 * them from the resource ledger, and each would only fail on the closed connection. One
 * `cleanup-skipped` event names what was left.
 * @param {{connected?: boolean}} rpc
 * @param {[string, () => unknown][]} steps
 * @param {(event: object) => void} log
 * @returns {[string, () => unknown][]}
 */
export function consoleCleanup(rpc, steps, log) {
  let skipping = false;

  return steps.map(([name, run], index) => [name, () => {
    if (rpc.connected !== false) return run();
    if (skipping) return;

    skipping = true;
    log({event: 'cleanup-skipped', reason: 'console disconnected', resources: steps.slice(index).map(([step]) => step)});
  }]);
}

/**
 * A rate badge for one stream, as createQuadBadge makes it; none of its methods throws.
 * @typedef {{prepare(): Promise<void>, show(frame: {width: number, height: number}): Promise<void>,
 *   close(): Promise<void>}} StreamBadge
 */

/**
 * The helper's status lines that end an AV1 start: a codec Sunshine chose over AV1, or a helper
 * that streams something else. Returns the error to fail with, or null.
 * @param {string} codec the requested codec
 * @param {Record<string, unknown>} event
 */
export function codecRefusal(codec, event) {
  const negotiated = event.event === 'error' && typeof event.received === 'string';
  if (negotiated)
    return Error('Sunshine negotiated ' + String(event.received).toUpperCase() + ' instead of ' +
      codec.toUpperCase() + '; check that the host encoder supports it, or choose H.264');

  const announced = event.event === 'video' && typeof event.codec === 'string';
  if (announced && event.codec !== codec)
    return Error('The helper streams ' + String(event.codec) + ', not ' + codec);
  return null;
}

/** What the console shows when the UDP video stream does not start (README.md, "UDP transport"). */
export const UDP_START_ERROR = 'Could not open the UDP video stream; check firewall on the PC';

/**
 * The setup failures a device test forces through `MOONLIGHT_FORCE_FALLBACK` (README.md,
 * "Fallbacks"): `codec` or nothing.
 * @param {string | undefined} value
 * @returns {Set<'codec'>}
 */
export function forcedFallbacks(value) {
  /** @type {Set<'codec'>} */
  const forced = new Set();
  const words = (value ?? '').split(',').map(word => word.trim()).filter(Boolean);

  for (const word of words) {
    if (word !== 'codec') throw Error('MOONLIGHT_FORCE_FALLBACK takes codec, not ' + word);
    forced.add(word);
  }
  return forced;
}

/**
 * `error` marked with the fallback it allows, unless it already names one.
 * @param {unknown} error
 * @param {'codec' | null} fallback
 */
export function withFallback(error, fallback) {
  const markable = fallback && error instanceof Error && !('fallback' in error);
  if (markable) Object.assign(error, {fallback});
  return error;
}

/**
 * The error a start that failed in `stage` ends with (README.md, "Fallbacks"): the UDP message,
 * also its console notice, while the UDP stream opens, until the first acknowledged unit; marked
 * for the H.264 fallback while an AV1 start is checked and opened; as it is otherwise.
 * @param {unknown} error
 * @param {'start' | 'av1' | 'udp' | 'streaming'} stage
 */
export function startFailure(error, stage) {
  if (stage === 'udp') return Object.assign(Error(UDP_START_ERROR, {cause: error}), {notice: UDP_START_ERROR});
  return withFallback(error, stage === 'av1' ? 'codec' : null);
}

/**
 * How the console loop runs a stream (README.md, "Overlapped output"): above 1080p, AV1 only, the
 * next unit is submitted before the ready frame's output; then and above 60 fps the GPU wait
 * moves to the frame slot's next use.
 * @param {{fps: number, codec: 'h264' | 'av1', height: number}} stream
 */
export function streamTuning({fps, codec, height}) {
  const overlapOutput = codec === 'av1' && height > 1080;
  const deferWait = fps > 60 || overlapOutput;
  return {deferWait, overlapOutput};
}

/**
 * The UDP sender, console area and the request's `stream.udp`; RecvMMsg, Poll and GetLastErrno
 * must verify, SetSockOpt is optional as on the TCP sockets.
 * @param {Civ7Rpc} rpc
 * @param {number} fps
 * @param {number} copy the verified native memcpy the decoder uses
 */
async function udpTransport(rpc, fps, copy) {
  const resolve = sdkResolver(rpc);
  const functions = {copy, errno: await resolve('GetLastErrno'), poll: await resolve('Poll'),
    recvMMsg: await resolve('RecvMMsg')};
  const sender = await createUdpVideoSender({fps, maxUnitBytes: Math.floor(CAPACITY / UDP_VIDEO.unitSlots)});
  try {
    const area = await rpc.allocate(UDP_VIDEO.areaBytes);
    const receiveBuffer = await receiveBufferRequest(rpc, area + UDP_VIDEO.reportOffset, {resolve});
    const {timing} = sender;
    const request = {port: sender.port, token: sender.token, buffer: address(area),
      functions: Object.fromEntries(Object.entries(functions).map(([key, value]) => [key, address(value)])),
      deadlineUs: Math.round(timing.deadlineMs * 1000), spreadUs: Math.round(timing.spreadMs * 1000),
      paceBytesPerMs: timing.paceBytesPerMs, ...(receiveBuffer ? {receiveBuffer} : {})};
    return {sender, area, request};
  } catch (error) {
    sender.close();
    throw error;
  }
}

/**
 * One Sunshine session: the helper's H.264 or AV1 goes to the console's video-stream request over
 * UDP (README.md, "UDP transport") and its PCM over the audio socket; the console's input records
 * come back to the helper.
 * @param {{rpc: Civ7Rpc, directory: string, hostAddress: string, host: string, app: string, helper: string,
 *   presentation: {configuration: unknown, storage: {mapped: number, bytes: number, memoryFlags: number}},
 *   helperPrefix?: string[], helperArgs?: string[], buttons?: 'position' | 'labels', fps?: number, bitrate?: number, duration?: number | null, width?: number,
 *   height?: number, controls?: number, signal?: AbortSignal, allowInput?: () => boolean,
 *   audioEnabled?: boolean, badge?: StreamBadge, codec?: 'h264' | 'av1',
 *   log?: (event: object) => void}} options
 *   `badge` is shown from the first acknowledged frame (rate-badge.js). A failed start's error
 *   carries `fallback` when H.264 may succeed instead (startFailure). `helperArgs` are launch
 *   flags passed through to the helper (--local-audio, --sops); `buttons` is the console's face
 *   button layout, `labels` for the Nintendo controller layout and `position` for Xbox.
 */
export async function streamVideo({rpc, directory, presentation, hostAddress, host, app,
  helper, helperPrefix = [], helperArgs = [], buttons = 'labels', fps = 60, bitrate = 20000, duration = 30, width = 1920, height = 1080,
  controls = undefined, signal = undefined, allowInput = () => true, audioEnabled = true, badge = undefined,
  codec = 'h264', log = event => {}}) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 120 || (duration !== null && !(duration > 0)))
    throw Error('Invalid video stream duration or rate');
  if (codec !== 'h264' && codec !== 'av1') throw Error('Expected codec h264 or av1');
  const av1 = codec === 'av1';
  const forced = forcedFallbacks(process.env.MOONLIGHT_FORCE_FALLBACK);
  if (forced.size) log({type: 'stream-forced-fallback', kinds: [...forced]});
  const {deferWait, overlapOutput} = streamTuning({fps, codec, height});
  if (deferWait) log({type: 'stream-tuning', deferWait, overlapOutput});
  const videoArgs = ['--codec', codec, '--raw-fd', '4'];
  const storage = presentation.storage;
  if (storage.bytes < ring.MEMORY_BYTES || !(storage.memoryFlags & 4))
    throw Error('Video requires coherent Moonlight storage');
  const child = spawn(helper, [...helperPrefix, 'stream', host, app, '--size', `${width}x${height}`,
    '--fps', String(fps), '--bitrate', String(bitrate), ...videoArgs, ...helperArgs,
    ...(audioEnabled ? ['--audio-fd', '3'] : [])],
    {stdio: ['pipe', 'ignore', 'pipe', 'pipe', 'pipe']});
  const audio = child.stdio[3];
  if (audio instanceof Readable && !audioEnabled) audio.resume();
  const video = child.stdio[4];
  const {stdin, stderr} = child;
  if (!(video instanceof Readable) || !stdin || !stderr) throw Error('Missing helper video pipe');
  const reader = new AccessUnits(video, {maxUnitBytes: CAPACITY, maxQueuedUnits: 4, now: Date.now});
  const units = createVideoQueue({source: av1 ? obuKeyframes(reader) : reader, fps,
    onIdrRequest: () => stdin.write('{"type":"request-idr"}\n')});
  child.on('error', error => reader.fail(error));
  stdin.on('error', error => reader.fail(error));
  const lines = readline.createInterface({input: stderr});
  let announcedCodec = '';
  lines.on('line', line => {
    try {
      const event = JSON.parse(line);
      if (reader.announce(event)) return;
      log(event);
      if (event.event === 'video') announcedCodec = String(event.codec);
      const refusal = av1 ? codecRefusal(codec, event) : null;
      if (refusal) reader.fail(withFallback(refusal, 'codec'));
    } catch { log({type: 'helper-log', line}); }
  });
  lines.on('close', () => reader.endMetadata());
  const startup = setTimeout(() => reader.fail(Error('Sunshine did not produce a keyframe')), 20000);
  /** @type {Awaited<ReturnType<typeof create>> | Awaited<ReturnType<typeof createAv1Decoder>> | undefined} */
  let decoder;
  /** @type {number | undefined} */
  let source;
  /** @type {number | undefined} */
  let header;
  /** @type {Awaited<ReturnType<typeof videoChannel>> | undefined} */
  let channel;
  /** @type {import('./udp-video.js').UdpVideoSender | undefined} */
  let datagrams;
  /** @type {number | undefined} */
  let udpArea;
  /** @type {Awaited<ReturnType<typeof createInput>> | undefined} */
  let input;
  /** @type {Awaited<ReturnType<typeof createAudio>> | undefined} */
  let audioOut;
  /** @type {NodeJS.Timeout | undefined} */
  let deadline;
  /** @type {Promise<import('./protocol.js').Civ7Reply> | undefined} */
  let streamRequest;
  /** @type {ReturnType<typeof watchConsoleRequest> | undefined} */
  let consoleRequest;
  /** @type {NodeJS.Timeout | undefined} */
  let telemetry;
  let previousFrames = 0;
  let firstStats = true;
  /** @type {Awaited<ReturnType<typeof receiveBufferReports>> | undefined} */
  let rcvbuf;
  let queueAgeMs = 0;
  let acknowledgementMs = 0;
  let sent = 0;
  /** @type {import('./latency.js').ConsoleLoop | null} */
  let consoleLoop = null;
  const caughtUp = createCaughtUpCounter();
  /** @type {Promise<void> | undefined} */
  let badgeShown;
  /** @type {ReturnType<ReturnType<typeof createFrameRateGuard>['observe']> | undefined} */
  let rateFallback;
  /** @type {unknown} */
  let failure;
  /** @type {'start' | 'av1' | 'udp' | 'streaming'} */
  let stage = 'start';
  /** @type {'start' | 'av1' | 'udp' | 'streaming'} */
  let failedStage = 'start';
  const stop = () => { rateFallback = undefined; reader.close(); };
  signal?.addEventListener('abort', stop, {once: true});
  const inputs = createInputForwarder({write: line => stdin.write(line), allowInput, onStop: stop, log});
  try {
    const first = await units.next();
    clearTimeout(startup);
    if (first.done || !first.value.keyframe) throw Error('Sunshine did not start with a keyframe');
    let dimensions;
    if (av1) {
      stage = 'av1';
      if (announcedCodec !== 'av1') throw Error('This helper does not stream AV1; bundle the AV1 helper');
      const start = /** @type {{sequence?: import('../session/av1-stream.js').SequenceHeader,
        size?: import('../session/av1-stream.js').FrameSize}} */ (first.value);
      const sequence = start.sequence;
      if (!sequence || !isMain8(sequence)) throw Error('Sunshine did not start AV1 with a Main 8-bit sequence header');
      log({type: 'av1-size', requested: {width, height}, ...streamSizes(sequence, start.size)});
      const coded = decodedSize({width, height}, sequence, start.size);
      if (forced.has('codec')) throw Error('AV1 decoder open forced to fail (MOONLIGHT_FORCE_FALLBACK)');
      const av1Decoder = decoder = await createAv1Decoder({rpc, directory, ...coded, display: {width, height}, log});
      dimensions = av1Decoder.dimensions;
      stage = 'start';
    } else {
      const sets = scanUnit(first.value.data);
      if (!sets.sps || !sets.pps || sets.bSlice) throw Error('Unsupported initial H.264 access unit');
      const movie = decoder = await create({rpc, directory, log});
      dimensions = await movie.configure(sets.sps, sets.pps, fps);
    }
    header = await rpc.allocate(0x1000);
    source = await rpc.allocate(CAPACITY);
    const copy = rpc.a.sdk + COPY_OFFSET;
    await rpc.request({command: 'verify-function', address: copy, hex: COPY_SIGNATURE});
    stage = 'udp';
    const udp = await udpTransport(rpc, fps, copy);
    const sender = datagrams = udp.sender;
    udpArea = udp.area;
    stage = 'start';
    if (controls !== undefined) input = await createInput(rpc, controls);
    if (audioEnabled) {
      if (!(audio instanceof Readable)) throw Error('Missing helper audio pipe');
      audioOut = await createAudio(rpc, audio, hostAddress);
    }
    const videoOut = channel = await videoChannel({fps, input: Boolean(input),
      onInput: inputs.onInput,
      latency: {rpc, log},
      onAcknowledged: event => {
        stage = 'streaming';
        acknowledgementMs = Math.max(acknowledgementMs, event.elapsedMs);
        units.acknowledged(event.sequence);
        if (badge && !badgeShown) badgeShown = badge.show(dimensions);
      },
      onTiming: caughtUp.onTiming,
      onLoop: loop => { consoleLoop = loop; },
      datagrams: sender,
      onDropped: event => { if (event.reason === 'late' || event.keyframe) units.lost(event.sequence); }});
    const context = decoder.nativeContext;
    await badge?.prepare();
    const receiveBuffer = await receiveBufferRequest(rpc, header + REPORT_OFFSET);
    stage = 'udp';
    const request = streamRequest = rpc.request({command: 'video-stream', memory: address(context.memory),
      functions: Object.fromEntries(Object.entries({...context.functions, copy})
        .map(([key, value]) => [key, address(value)])), layout: context.layout,
      ...('av1' in context ? {av1: context.av1} : {}),
      destination: {address: address(storage.mapped + ring.frameOffset(0)), bytes: ring.FRAME_BYTES,
        ...(deferWait ? {alternate: address(storage.mapped + ring.frameOffset(1))} : {})},
      presentation: {.../** @type {object} */ (presentation.configuration),
        ...(deferWait ? {deferWait: true} : {})},
      ...(input ? {input: input.configuration} : {}),
      ...(audioOut ? {audio: audioOut.configuration} : {}),
      publication: {address: address(storage.mapped), index: 0, color: 1, ...dimensions,
        ...(deferWait ? {alternate: 1} : {}), slots: {...VIDEO, mode: MODE.native}},
      stream: {host: hostAddress, port: videoOut.port, token: videoOut.token,
        header: address(header), buffer: address(source), capacity: CAPACITY, frames: 0x7fffffff, fps,
        ...(overlapOutput ? {overlapOutput} : {}),
        ...(buttons === 'position' ? {buttons} : {}),
        ...(receiveBuffer ? {receiveBuffer} : {}), udp: udp.request}}, undefined, 0);
    consoleRequest = watchConsoleRequest(request, {log,
      onFailure: error => { reader.fail(error); videoOut.close(); }});
    audioOut?.done.catch(error => { reader.fail(error); videoOut.close(); });
    await videoOut.connected;
    rcvbuf = await receiveBufferReports(rpc, {video: receiveBuffer, audio: audioOut?.configuration.receiveBuffer,
      udp: udp.request.receiveBuffer});
    log({type: 'video-connected', ...dimensions, fps, rcvbuf});
    log({type: 'video-rate', fps, bitrate});
    const frameRate = createFrameRateGuard({fps});
    telemetry = setInterval(() => {
      const recommendation = frameRate.observe({at: Date.now(), presented: videoOut.acknowledged,
        dropped: units.dropped, idrRequests: units.idrRequests, queueAgeMs, acknowledgementMs,
        consoleUnitMs: consoleLoop?.unitMs ?? undefined, console: consoleLoop});
      if (recommendation) {
        rateFallback = recommendation;
        log({type: 'frame-rate-overload', ...recommendation});
        reader.close();
      }
      const {drops, idrs, held} = units.take();
      log({type: 'civ7-stats', presented: videoOut.acknowledged - previousFrames, caughtUp: caughtUp.take(),
        dropped: units.dropped, idrRequests: units.idrRequests, queueAgeMs, acknowledgementMs,
        window: videoOut.adaptWindow(), drops, idrs, held, console: consoleLoop,
        inputChanges: inputs.changes(), touchEvents: inputs.touchEvents(), audio: audioOut?.stats,
        udp: sender.take(), udpDropped: videoOut.dropped,
        ...(firstStats ? {rcvbuf} : {})});
      firstStats = false;
      previousFrames = videoOut.acknowledged;
      queueAgeMs = 0;
      acknowledgementMs = 0;
      consoleLoop = null;
    }, 1000);
    if (duration !== null) deadline = setTimeout(stop, duration * 1000);
    if (signal?.aborted) stop();
    await videoOut.send(first.value);
    sent++;
    for (;;) {
      const next = await units.next();
      if (next.done) break;
      const unit = next.value;
      queueAgeMs = Math.max(queueAgeMs, Date.now() - (unit.arrivedAt ?? Date.now()));
      if (!av1 && scanUnit(unit.data).bSlice) throw Error('Sunshine emitted a B slice');
      await videoOut.send(unit);
      sent++;
    }
    await videoOut.finish();
    const result = await request;
    if (result.av1) log({type: 'av1-frames', report: result.av1});
    const {frames, elapsedMs} = result;
    const settled = videoOut.acknowledged + videoOut.dropped;
    if (frames !== sent - videoOut.dropped || settled !== sent)
      throw Error('Video frame acknowledgements do not match the sent frames');
    if (typeof elapsedMs !== 'number') throw Error('Invalid console stream result');
    return {...result, ...dimensions, sent, acknowledged: videoOut.acknowledged,
      dropped: units.dropped, idrRequests: units.idrRequests,
      udpDropped: videoOut.dropped, udpSender: sender.stats(), inputChanges: inputs.changes(), touchEvents: inputs.touchEvents(), requestedFps: fps,
      audioSource: audioOut?.stats,
      rateFallback, rcvbuf,
      presentedFps: sent * 1000 / elapsedMs};
  } catch (error) {
    failure = error;
    const live = !signal?.aborted && rpc.connected !== false;
    failedStage = live ? stage : 'start';
    if (failedStage === 'udp') log({type: 'udp-start-failed', message: errorText(error)});
    throw startFailure(error, failedStage);
  } finally {
    clearTimeout(startup);
    clearTimeout(deadline);
    clearInterval(telemetry);
    signal?.removeEventListener('abort', stop);
    const errors = await cleanup([
      ['video-reader', () => reader.close()],
      ['input-release', () => input && inputs.release()],
      ['helper-interrupt', () => child.kill('SIGINT')],
      ['video-channel', () => channel?.close()],
      ['udp-video', () => datagrams?.close()],
      ['video-request', async () => {
        if (!streamRequest) return;
        const timer = setTimeout(() => rpc.disconnect?.(Error('Console stream did not stop')), 5000);
        try { await streamRequest.catch(() => {}); }
        finally { clearTimeout(timer); }
      }],
      ['rate-badge', async () => {
        await badgeShown;
        await badge?.close();
      }],
      ['audio', () => audioOut?.stop()],
      ...consoleCleanup(rpc, [
        ['audio-out', () => audioOut?.release()],
        ['decoder', () => decoder?.close()],
        ['input', () => input?.close()],
        ['video-source', () => source && rpc.release(source)],
        ['video-header', () => header && rpc.release(header)],
        ['udp-area', () => udpArea && rpc.release(udpArea)]
      ], log),
      ['helper', () => stopChild(child)]
    ], log);
    const consoleFailure = consoleRequest?.failure();
    if (failure && consoleFailure) throw startFailure(consoleFailure.error, failedStage);
    if (!failure && errors.length) throw new AggregateError(errors, 'Stream cleanup failed');
  }
}
