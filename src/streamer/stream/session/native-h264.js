/**
 * Native H.264 route: the helper's access units are decoded on the console into NV12 surfaces.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {scanUnit} from './h264-stream.js';
import {parseSps, reorderOf} from './h264-sps.js';
import {instrument, watchBridge} from '../native/bridge-counter.js';
import {create as createNativeDecoder} from '../native/native-decoder.js';
import {create as createNativeTransport} from '../native/native-tcp.js';
import {create as createNativeSink} from '../native/native-sink.js';
import {create as createSocketAudioSource} from '../../audio/socket-audio-source.js';
import {create as createStaggeredLive} from '../scheduler/staggered-live.js';
import * as padAge from '../../input/pad-age.js';
import {parseOptions, AUDIO_FD} from './stream-options.js';
import {createChildren} from './stream-children.js';
import {
  countsSince,
  tenths,
  hiddenQueue,
  hiddenTiming,
  receiveRow,
  auTiming,
  withInputStage,
  LINK_ROWS,
  linkQuality,
  audioCounters,
  steadyLink,
  linkSeconds,
  freshStats,
  headRevision,
  recordDirectory,
  writeManifest,
  activeGateFlags,
  buildSummary,
  score,
  PRIVATE_FILE
} from './stream-report.js';

/** Shortest gap between two keyframe requests to Sunshine. */
const IDR_COOLDOWN_MS = 100;
// Invariant 16.
const IDR_QUIET_MS = 1000;
const CONSOLE_STALL_MS = 5000;
/** Default stats row interval. */
const STATS_MS = 1000;
/** How long the input feeder gets to exit after SIGINT: its 5 s worker stop and the calls around. */
const FEEDER_EXIT_MS = 8000;
/** How often app-runtime.json is read to see whether Moonlight still runs. */
const RUNTIME_CHECK_MS = 500;
/** Decoder resyncs allowed inside RESYNC_WINDOW_MS; the next error ends the stream. */
const RESYNC_LIMIT = 3;
const RESYNC_WINDOW_MS = 30000;
/** How long the host-driven path keeps polling for owed frames, and the gap between polls. */
const DRAIN_MS = 200;
const DRAIN_POLL_MS = 5;
/** A PCM frame is 4 bytes. */
const FRAME_BYTES = 4;

/**
 * Coalesces keyframe requests into one send at most every IDR_COOLDOWN_MS, none after close().
 * The clock and the timer functions can be replaced for tests.
 */
function createIdrRequester(
  send,
  {now = Date.now, schedule = setTimeout, cancel = clearTimeout} = {}
) {
  let lastSent = -Infinity;
  let timer = null;
  let closed = false;
  return {
    request() {
      if (closed || timer !== null) return;
      timer = schedule(
        () => {
          timer = null;
          if (closed) return;
          lastSent = now();
          send();
        },
        Math.max(0, lastSent + IDR_COOLDOWN_MS - now())
      );
    },
    close() {
      closed = true;
      if (timer !== null) cancel(timer);
      timer = null;
    }
  };
}

/** @typedef {import('./stream-report.js').Scored} Scored */

/**
 * @typedef {object} RunOptions
 * @property {string[]} args The command line, flags as parsed by parseOptions.
 * @property {string} directory The launcher run directory.
 * @property {any} rpc The session rpc of that run.
 * @property {any} storage The app's private storage (feed.js findPrivateStorage).
 * @property {string} helperPath The hbmoonlight binary.
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {string} [sourceRevision] Recorded in the manifest; defaults to the git head.
 * @property {typeof createNativeDecoder} [createDecoder]
 * @property {typeof createNativeTransport} [createTransport]
 * @property {typeof createNativeSink} [createSink]
 * @property {typeof createSocketAudioSource} [createSocketAudio]
 * @property {typeof createStaggeredLive} [createStaggered]
 * @property {typeof spawn} [spawnProcess]
 * @property {number} [consoleStallMs]
 * @property {number} [statsMs]
 * @property {number} [feederExitMs]
 * @property {() => number} [now]
 */

/**
 * Streams HOST APP from the --moonlight flags until a stop, then writes and returns the scored
 * summary. Throws on bad flags, on a stream error that was not caused by a stop, and with an
 * AggregateError when the shutdown fails or native objects had to be retained.
 * @param {RunOptions} options
 */
async function run({
  args,
  directory,
  rpc,
  storage,
  helperPath,
  width,
  height,
  fps,
  sourceRevision,
  createDecoder = createNativeDecoder,
  createTransport = createNativeTransport,
  createSink = createNativeSink,
  createSocketAudio = createSocketAudioSource,
  createStaggered = createStaggeredLive,
  spawnProcess = spawn,
  consoleStallMs = CONSOLE_STALL_MS,
  statsMs = STATS_MS,
  feederExitMs = FEEDER_EXIT_MS,
  now = () => performance.now()
}) {
  const options = parseOptions(args, rpc, width, height, fps);
  const {audio, socketTone, socketAudio, duration, inputPush, audioFrames} = options;
  const {presentHz, skipRule, trimBacklogMs, gateOnReceive, outputLag, surfaceCheck} = options;
  const {decodeWait, receiveWait, avoidWindow, skipBacklog, gateQueue} = options;
  if (!rpc.host) throw Error('Native TCP requires a fresh launcher session from this branch');
  /** Moves `now` onto CLOCK_MONOTONIC, the clock of the helper's writtenAt. */
  const monotonicOffset = Number(process.hrtime.bigint()) / 1e6 - now();
  const revision = sourceRevision || headRevision();
  const output = recordDirectory(revision);
  await writeManifest(output, rpc.a.session, revision);

  let stage = 'setup';
  const bridge = instrument(rpc, () => stage);
  rpc = watchBridge(bridge.rpc);
  let stopping = false;
  /** The error that ended the stream, already logged by logFailure(). */
  let failed = null;
  let pairing = false;
  let decoder = null;
  let transport = null;
  let staggeredLive = null;
  let tail = null;
  let sink = null;
  let soundSource = null;
  let monitor = null;
  let printing = null;
  let ending = null;
  let stopped = false;
  let stopReason = null;
  /** Set when a lag 0 decoder wait timed out (staggered-live.js lagEnd). */
  let lagEnd = null;
  const rows = [];
  let inputBridge = {exchanges: 0, bridgeMs: 0};
  /** @type {import('../../input/pad-age.js').PadRow[]} */
  let inputPad = [];
  let pushCounts = {pushed: 0, dropped: 0, gapMaxMs: 0, applied: 0, changes: 0};
  let trimmed = 0;
  let auSamples = [];
  // The last unit pushed, which the default gate opens on the next push.
  let heldSample = null;
  const stats = freshStats();
  // The decoder generations and what the current one has been fed.
  let resets = [];
  let generation = 0;
  let sps;
  let pps;
  /** The last SPS as h264-sps.js reads it and the B slices seen, for the log and summary. */
  const stream = {sps: null, bSlices: 0};
  let configured = false;
  let workerStarted = false;
  let firstFrame = null;
  let outstanding = 0;
  // What the next stats row counts from.
  let dropped = 0;
  let queued = 0;
  let waited = {};
  /** @type {{sleeps: number, ms: number} | null} */
  let slept = null;
  let stageAt;
  let stageMs = {};
  const statsFile = path.join(output, 'stats.jsonl');

  const log = value => {
    const line = JSON.stringify(value);
    fsSync.appendFileSync(
      path.join(output, 'events.jsonl'),
      JSON.stringify({at: new Date().toISOString(), ...value}) + '\n',
      {mode: PRIVATE_FILE}
    );
    console.error(line);
  };
  /** A queued gate is still pairing after its push returned (--gate-queue). */
  const cancelled = () => stopping && !pairing && !staggeredLive?.queued;
  const procs = createChildren({
    options,
    spawnProcess,
    helperPath,
    directory,
    rpc,
    width,
    height,
    fps,
    feederExitMs,
    now,
    log,
    requestIdr,
    addFeederCounts,
    isStopping: () => stopping
  });
  const idrRequester = createIdrRequester(() => {
    if (stopping) return;
    stats.idr++;
    procs.helper.stdin.write(JSON.stringify({type: 'request-idr'}) + '\n');
  });
  const countSkipped = count => {
    stats.skipped += count;
  };
  const countDecoded = count => {
    stats.decoded += count;
  };
  const countPresented = count => {
    stats.presented += count;
  };

  function stop(reason = 'cleanup') {
    if (stopped) return;
    stopped = true;
    stopping = true;
    stopReason = reason;
    log({event: 'native-stop', reason});
    idrRequester.close();
    for (const child of procs.children) child.kill('SIGINT');
    procs.helper?.stdin.end();
    procs.helper?.kill('SIGINT');
    procs.reader?.close();
    soundSource?.halt();
  }

  /**
   * Ends a lag 0 run; invariants 4 and 17.
   * @param {{at: number, reason: string, recommendedLag: number}} fallback
   * @param {string} [reason]
   */
  function endLagZero(fallback, reason = 'lag0-timeout') {
    lagEnd = fallback;
    log({event: 'lag-end', lagEnd: fallback});
    stop(reason);
  }

  /**
   * The lag 0 refusal for a stream that can reorder; invariant 17.
   * @param {any} unit
   * @param {string} reorder
   */
  function reorderRefusal(unit, reorder) {
    const fallback = {at: unit.seq, reason: reorder, recommendedLag: 1};
    return Object.assign(Error('--output-lag 0 refused: ' + reorder), {
      lagEnd: fallback,
      stopReason: 'lag0-reorder'
    });
  }

  /**
   * Reads and logs the SPS reorder before it is configured; invariant 17.
   * @param {any} unit
   */
  function checkSps(unit) {
    let reorder;
    try {
      const parsed = parseSps(sps);
      reorder = reorderOf(parsed);
      stream.sps = {...parsed, reorder};
    } catch (error) {
      reorder = 'unreadable SPS: ' + error.message;
      stream.sps = {error: error.message, reorder};
    }
    log({event: 'h264-sps', ...stream.sps});
    if (outputLag === 0 && reorder) throw reorderRefusal(unit, reorder);
  }

  /**
   * Counts B slices and logs the first; lag 0 ends on one.
   * @param {any} unit
   */
  function checkSlices(unit) {
    if (stream.bSlices === 0) log({event: 'h264-b-slice', seq: unit.seq});
    stream.bSlices++;
    if (outputLag === 0) throw reorderRefusal(unit, 'B slice in unit ' + unit.seq);
  }

  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  function requestIdr() {
    if (!stopping && bridge.silentMs() < IDR_QUIET_MS) idrRequester.request();
  }

  /** Opens a decoder generation on its own transport and staggered scheduler. */
  async function makeDecoder() {
    transport = await createTransport({rpc, host: rpc.host});
    heldSample = null;
    staggeredLive = createStaggered({
      presentHz,
      skipBacklog,
      skipRule: /** @type {'backlog' | 'vsync'} */ (skipRule),
      ...(trimBacklogMs !== null && {trimBacklogMs}),
      ...(gateOnReceive && {gateOnReceive}),
      ...(gateQueue && {gateQueue}),
      ...(outputLag !== null && {lag: /** @type {0 | 1 | 2} */ (outputLag)}),
      ...(surfaceCheck && {surfaceCheck}),
      decodeWait,
      receiveWait,
      avoid: avoidWindow,
      now
    });
    try {
      return await createDecoder({
        rpc,
        directory,
        workerDirectory: path.join(output, 'decoder-' + generation),
        workerMode: 'split',
        transport,
        publication: sink.workerPublication,
        splitWorkerFactory: staggeredLive.factory,
        log,
        cancelled
      });
    } catch (error) {
      await transport?.close().catch(() => {});
      throw error;
    }
  }

  /** One counts line of the input feeder: its stop report, or bridge, pad and push counts. */
  function addFeederCounts(counts) {
    if (counts.stopped !== undefined) {
      procs.inputPushStop = counts;
      return;
    }
    inputBridge.exchanges += counts.exchanges;
    inputBridge.bridgeMs += counts.bridgeMs;
    if (counts.pad) inputPad.push(counts.pad);

    if (counts.pushed === undefined) return;
    pushCounts.pushed += counts.pushed;
    pushCounts.dropped += counts.dropped;
    pushCounts.gapMaxMs = Math.max(pushCounts.gapMaxMs, counts.gapMaxMs);
    pushCounts.applied += counts.applied;
    pushCounts.changes += counts.changes;
  }

  /** Closes this decoder generation and opens the next, unless resyncs come too often. */
  async function resync(error) {
    if (staggeredLive?.exists) throw error;
    resets = resets.filter(time => Date.now() - time < RESYNC_WINDOW_MS);
    if (resets.length >= RESYNC_LIMIT) throw error;
    resets.push(Date.now());
    stats.resyncs++;
    log({event: 'native-resync', message: error.message, result: error.result});
    await decoder.close();
    generation++;
    decoder = await makeDecoder();
    configured = false;
    workerStarted = false;
    outstanding = 0;
    requestIdr();
  }

  async function checkRuntime() {
    try {
      const file = await fs.readFile(path.join(directory, 'app-runtime.json'));
      const runtime = JSON.parse(/** @type {any} */ (file));
      if (runtime.active?.id !== 'moonlight') stop('app-exit');
    } catch (error) {
      procs.reader.fail(error);
    }
  }

  /** Books the time since the last stage change to the stage being left. */
  const enter = name => {
    const time = performance.now();
    stageMs[stage] = (stageMs[stage] || 0) + time - stageAt;
    stageAt = time;
    stage = name;
  };

  function statsRow() {
    /** @type {any} */
    const row = {codec: 'h264', ...stats, dropped: procs.reader.dropped - dropped, queued};
    if (staggeredLive) row.waiting = countsSince(staggeredLive.counts.waiting, waited);
    if (staggeredLive?.counts.receive)
      row.receive = receiveRow(staggeredLive.counts.receive, slept);

    row.au = auTiming(auSamples);
    const hidden = hiddenTiming(auSamples);
    if (hidden) row.hidden = hidden;
    if (trimBacklogMs !== null) row.trimmed = trimmed;

    Object.assign(row, withInputStage(bridge.take(), inputBridge));
    if (inputPad.length) row.inputPad = padAge.merge(inputPad);
    row.link = linkQuality(inputBridge);
    if (inputPush) row.inputPush = pushCounts;
    if (surfaceCheck) row.surfaces = staggeredLive?.takeSurfaces() ?? [];
    if (soundSource) row.audio = audioCounters(soundSource.report());

    row.at = stage + '/' + (decoder?.step ?? '-');
    row.ms = Object.fromEntries(Object.entries(stageMs).map(([k, v]) => [k, Math.round(v)]));
    return row;
  }

  function startRow() {
    stageMs = {};
    inputBridge = {exchanges: 0, bridgeMs: 0};
    inputPad = [];
    pushCounts = {pushed: 0, dropped: 0, gapMaxMs: 0, applied: 0, changes: 0};
    auSamples = [];
    trimmed = 0;
    dropped = procs.reader.dropped;
    queued = 0;
    waited = staggeredLive?.counts.waiting ?? {};
    slept = staggeredLive?.counts.receive ?? null;
    Object.keys(stats).forEach(key => {
      stats[key] = 0;
    });
  }

  /** Stops on a stalled console, then prints and records one stats row. */
  function printRow() {
    const silent = bridge.silentMs();
    if (silent >= consoleStallMs && !stopping) {
      log({
        event: 'console-stalled',
        silentMs: Math.round(silent),
        message: 'The console stopped answering'
      });
      stop('console-stalled');
    }
    const row = statsRow();
    rows.push(row);
    if (rows.length === options.warmup + LINK_ROWS) {
      const link = steadyLink(rows, options.warmup);
      if (link) log({event: 'link', ...link});
    }
    const line = JSON.stringify(row);
    console.log(line);
    fs.appendFile(statsFile, line + '\n', {mode: PRIVATE_FILE}).catch(() => {});
    startRow();
  }

  /** The staggered push callbacks, which time the unit into `sample` and count the frames. */
  function pushOptions(sample) {
    return {
      sink,
      enter,
      backlog: procs.reader.ready.length,
      onGate: at => {
        const gated = gateOnReceive ? sample : heldSample;
        sample.gatedAt = at;
        sample.ownGateMs = gated ? at - gated.arrivedAt : null;
        sample.inHand = 1 + procs.reader.ready.length;
        if (sample.queued) auSamples.push(sample);
        sample.queued = false;
      },
      onSent: at => {
        sample.sentAt = at;
      },
      onTrimmed: ageMs => {
        trimmed++;
        log({event: 'backlog-trim', ageMs: tenths(ageMs), trimBacklogMs});
      },
      onSkipped: countSkipped,
      onDecoded: countDecoded,
      onPresented: countPresented
    };
  }

  function startWorkers() {
    staggeredLive.start({input: decoder.lastInput, frame: firstFrame});
    workerStarted = true;
    log({
      event: 'staggered-worker',
      started: true,
      ...activeGateFlags(options),
      ...(stream.sps && {sps: stream.sps})
    });
  }

  /** Submits a unit on the host-driven path and publishes every frame it owes. */
  async function submitHostPath(unit) {
    enter('submit');
    await decoder.submit(unit);
    stats.submitted++;
    outstanding++;

    // Drained fully so the workers start with no output owed.
    const drainUntil = Date.now() + DRAIN_MS;
    do {
      enter('destination');
      const destination = await sink.destination();
      enter('receive');
      const frame = await decoder.receive(destination);
      if (!frame) {
        if (Date.now() > drainUntil) break;
        await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_MS));
        continue;
      }
      outstanding--;
      stats.decoded++;
      enter('publish');
      await sink.publish(destination, frame);
      stats.presented++;
      firstFrame ||= frame;
      if (outstanding === 0 && !workerStarted) {
        await sink.wait();
        startWorkers();
      }
    } while (outstanding > 0);
  }

  /** Stops the workers, then closes the decoder and the sink; invariant 8. */
  async function releaseNative(errors) {
    let retained = Boolean(rpc.bridgeLost);
    if (staggeredLive && !retained) {
      try {
        await staggeredLive.stop();
      } catch (error) {
        errors.push(error);
        retained = true;
      }

      const gateError = staggeredLive.gateError;
      if (gateError && gateError !== failed) {
        log({
          event: 'staggered-gate-dropped-error',
          error: gateError.message,
          ...(gateError.expected && {expected: gateError.expected, checked: gateError.checked})
        });
      }
    }

    if (retained) {
      transport?.abort?.();
      errors.push(Error('Native objects retained for safety; restart SmileBASIC'));
      log({
        event: 'native-retained',
        reason: 'staggered worker or bridge state is uncertain'
      });
    } else {
      try {
        await decoder?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await sink?.close();
      } catch (error) {
        errors.push(error);
      }
    }
  }

  /** Opens the sink and the first decoder, starts the children and the timers. */
  async function openStream() {
    sink = await createSink(rpc, storage, {cancelled});
    decoder = await makeDecoder();
    procs.spawnHelper();
    if (options.input) procs.spawnInputFeeder();
    if (socketAudio) {
      soundSource = await createSocketAudio({
        rpc,
        host: rpc.host,
        bufferBytes: audioFrames * FRAME_BYTES,
        tone: socketTone,
        onError: error => procs.reader.fail(error)
      });
      soundSource.attach(procs.helper.stdio[AUDIO_FD]);
      log({event: 'socket-audio', started: true, bufferBytes: audioFrames * FRAME_BYTES});
    } else if (audio) procs.spawnAudioStream();
    monitor = setInterval(checkRuntime, RUNTIME_CHECK_MS);
    stage = 'read';
    stageAt = performance.now();
    printing = setInterval(printRow, statsMs);
    if (duration !== null) ending = setTimeout(() => stop('duration'), duration * 1000);
  }

  /**
   * Resyncs on changed parameter sets and configures the decoder on the first keyframe that
   * carries both; false while the unit has to be skipped.
   */
  async function readyToDecode(unit) {
    const sets = scanUnit(unit.data);
    if (sets.bSlice) checkSlices(unit);
    if (configured && setsChanged(sets)) await resync(Error('H.264 parameter sets changed'));
    sps = sets.sps || sps;
    pps = sets.pps || pps;
    if (configured) return true;

    if (!unit.keyframe || !sps || !pps) return false;
    checkSps(unit);
    await decoder.configure(sps, pps, fps);
    configured = true;
    return true;
  }

  /** Whether a configured stream's unit carries a different SPS or PPS. */
  function setsChanged(sets) {
    if (sets.sps && !sets.sps.equals(sps)) return true;
    return Boolean(sets.pps && !sets.pps.equals(pps));
  }

  /** Hands a unit to the running staggered workers, timing it into the row's samples. */
  async function pushStaggered(unit) {
    pairing = true;
    const sample = {
      arrivedAt: unit.arrivedAt,
      gatedAt: null,
      sentAt: null,
      inHand: null,
      hidden: hiddenQueue(unit, unit.arrivedAt + monotonicOffset)
    };
    try {
      await staggeredLive.push(unit, pushOptions(sample));
      heldSample = sample;
    } finally {
      pairing = false;
    }
    // A queued gate times its unit later, into whichever row is open then.
    if (gateQueue && sample.gatedAt === null) sample.queued = true;
    else auSamples.push(sample);
    stats.submitted++;
    enter('read');
  }

  /** One unit from the reader; true once the stream is stopping and the loop must end. */
  async function feedUnit(unit) {
    enter('unit');
    queued = Math.max(queued, procs.reader.ready.length);
    if (stopping) return true;
    stats.received++;
    stats.bytes += unit.data.length;
    if (unit.keyframe) stats.keyframes++;
    if (!(await readyToDecode(unit))) return false;
    try {
      if (workerStarted) {
        await pushStaggered(unit);
        return false;
      }
      await submitHostPath(unit);
    } catch (error) {
      if (stopping || error.result === undefined) throw error;
      await resync(error);
    }
    enter('read');
    return false;
  }

  /** Drains the units the workers still hold, unless a stop other than --duration cut it. */
  async function finishTail() {
    if (!stopping || stopReason === 'duration') {
      pairing = true;
      try {
        tail = await staggeredLive.finish({
          sink,
          enter,
          onDecoded: countDecoded,
          onPresented: countPresented,
          onSkipped: countSkipped
        });
      } finally {
        pairing = false;
      }
    } else {
      tail = {drained: 0, skipped: stopReason};
    }
    log({event: 'staggered-tail', ...tail});
  }

  async function streamUnits() {
    for await (const unit of procs.reader) {
      if (await feedUnit(unit)) break;
    }
    if (staggeredLive?.pending) await finishTail();
  }

  /** Logs a failed stream, with the workers' snapshot while the bridge still answers. */
  async function logFailure(error) {
    if (staggeredLive?.exists && !rpc.bridgeLost) {
      const snapshot = await staggeredLive
        .snapshot()
        .catch(snapshotError => ({error: snapshotError.message}));
      log({
        event: 'staggered-snapshot',
        snapshot,
        ...(error.expected && {
          expected: error.expected,
          checked: error.checked,
          previous: error.previous
        })
      });
    }
    log({
      event: 'native-error',
      message: error.message,
      pending: error.pending,
      control: error.control,
      ...(stopping ? {stopping} : {})
    });
  }

  /** Stops everything and releases the native objects; throws what failed on the way. */
  async function shutdown() {
    clearInterval(monitor);
    clearInterval(printing);
    clearTimeout(ending);
    stop('cleanup');
    procs.statusLines?.close();
    const errors = [];
    await procs.awaitInputFeeder(errors);
    if (soundSource) await procs.closeSocketAudio(soundSource, errors);
    await releaseNative(errors);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    if (errors.length) throw new AggregateError(errors, 'Native H.264 shutdown failed');
  }

  /** Scores the run, writes summary.json and logs the verdict. */
  async function writeSummary() {
    const summary = buildSummary(options, {
      rows,
      staggeredLive,
      tail,
      socketAudioReport: procs.socketAudioReport,
      inputPushStop: procs.inputPushStop,
      stopReason,
      lagEnd,
      stream
    });
    const result = score(summary, {
      expect: options.expect,
      duration,
      socketAudioReport: procs.socketAudioReport,
      inputPushStop: procs.inputPushStop,
      stopReason
    });
    await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', {
      mode: PRIVATE_FILE
    });
    log({
      event: 'summary',
      verdict: result.pass ? 'PASS' : 'FAIL',
      failures: result.failures,
      mode: 'split',
      fps: summary.fps,
      minFps: summary.minFps,
      dropped: summary.dropped,
      ...(summary.trimmed !== undefined && {trimmed: summary.trimmed}),
      idr: summary.idr,
      requestsPerFrame: summary.requestsPerFrame,
      bridgeMsPerFrame: summary.bridgeMsPerFrame,
      stopReason,
      record: output
    });
    return /** @type {Scored} */ (summary);
  }

  try {
    await openStream();
    await streamUnits();
  } catch (error) {
    failed = error;
    await logFailure(error);
    if (error.lagEnd && !stopping) endLagZero(error.lagEnd, error.stopReason);
    if (!stopping) throw error;
  } finally {
    await shutdown();
  }
  return writeSummary();
}

export {
  run,
  createIdrRequester,
  countsSince,
  receiveRow,
  auTiming,
  hiddenQueue,
  hiddenTiming,
  withInputStage,
  linkQuality,
  linkSeconds,
  steadyLink
};
