/**
 * Native H.264 route: the helper's ordered access units are decoded on the console into
 * console-written NV12 surfaces.
 *
 * run() spawns the helper with its raw H.264 and PCM pipes, the input feeder and the audio
 * stream or the socket audio source. The first frames take the host-driven decoder path, which
 * is drained fully before the staggered workers take over the rest. A stats row goes out every
 * statsMs and the run record keeps manifest.json, events.jsonl, stats.jsonl and summary.json.
 * The stream stops on SIGINT/SIGTERM, --duration, Moonlight leaving the console or a console
 * that stops answering, and the summary scores the steady rows against --expect.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {spawn, execFileSync} from 'node:child_process';
import os from 'node:os';
import {AccessUnits, parameterSets} from './h264-stream.js';
import {instrument, watchBridge} from './bridge-counter.js';
import * as cli from '../../../hbl-platform/sdk/cli.js';
import {builds} from '../../../hbl-platform/sdk/build.js';
import * as scoring from './run-summary.js';
import {bitrate as streamBitrate} from './bitrate.js';
import {create as createNativeDecoder} from './native-decoder.js';
import {create as createNativeTransport} from './native-tcp.js';
import {create as createNativeSink} from './native-sink.js';
import {create as createSocketAudioSource} from '../audio/socket-audio-source.js';
import {create as createStaggeredLive} from './staggered-live.js';
import * as exchangeTiming from './exchange-timing.js';
import * as padAge from '../input/pad-age.js';

/** Shortest gap between two keyframe requests to Sunshine. */
const IDR_COOLDOWN_MS = 100;
/**
 * A backlog while the console is not answering is the console's, so asking Sunshine for a
 * keyframe cannot help; past CONSOLE_STALL_MS the stream reports the console and stops.
 */
const IDR_QUIET_MS = 1000;
const CONSOLE_STALL_MS = 5000;
/** The host runs at present pace, so it needs room for a source burst (batch C2). */
const QUEUE = 8;
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
/** The helper's pipes: raw H.264 on fd 4, PCM on fd 3. */
const H264_FD = 4;
const AUDIO_FD = 3;
/** A PCM frame is 4 bytes; audio buffers come in steps of 240 frames. */
const FRAME_BYTES = 4;
const FRAME_STEP = 240;
/** The most frames the socket audio source buffers. */
const SOCKET_AUDIO_FRAMES = 3840;
/** The run record is private to the user. */
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;

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

/** The counts in `now` that moved since `before`, leaving out the ones that did not. */
function countsSince(now, before) {
  return Object.fromEntries(
    Object.entries(now)
      .map(([key, count]) => [key, count - (before[key] || 0)])
      .filter(([, count]) => count)
  );
}

/** Rounds to one decimal. */
const tenths = value => Math.round(value * 10) / 10;

/**
 * Where a unit spent the time before arrivedAt, from the helper's stamps: receiveMs from its
 * first packet to its write, queueMs in common-c's decode-unit queue behind `queued` others,
 * `unread` bytes still in the raw channel before the write, and pipeMs from the write to
 * arrivedAt. Null for a helper that does not stamp.
 * @param {any} unit
 * @param {number} arrivedMonotonic arrivedAt on CLOCK_MONOTONIC, the helper's clock
 */
function hiddenQueue(unit, arrivedMonotonic) {
  if (typeof unit.writtenAt !== 'number') return null;
  const pipeMs = arrivedMonotonic - unit.writtenAt;
  const {receiveMs, queueMs, queued, unread, writeMs, hostMs = 0} = unit;
  return {totalMs: receiveMs + pipeMs, pipeMs, receiveMs, queueMs, queued, unread, writeMs, hostMs};
}

/**
 * One stats row's time before arrivedAt: the mean and longest of each part over the units the
 * helper stamped, or null when it stamped none.
 * @param {{hidden?: ReturnType<typeof hiddenQueue>}[]} samples
 */
function hiddenTiming(samples) {
  const hidden = samples.map(sample => sample.hidden).filter(value => value);
  if (!hidden.length) return null;
  /** @param {number[]} values */
  const meanMax = values => ({
    mean: tenths(values.reduce((sum, value) => sum + value, 0) / values.length),
    max: tenths(Math.max(...values))
  });
  /** @param {string} key */
  const spread = key => meanMax(hidden.map(value => /** @type {any} */ (value)[key]));
  // The host leaves its processing time at 0 when it sends none, or for a repeated frame, so
  // hostMs counts its own units.
  const hosted = hidden.map(value => /** @type {any} */ (value).hostMs).filter(ms => ms > 0);
  return {
    units: hidden.length,
    totalMs: spread('totalMs'),
    pipeMs: spread('pipeMs'),
    receiveMs: spread('receiveMs'),
    queueMs: spread('queueMs'),
    queued: spread('queued'),
    unread: spread('unread'),
    writeMs: spread('writeMs'),
    ...(hosted.length ? {hostMs: {units: hosted.length, ...meanMax(hosted)}} : {})
  };
}

/** @param {ReturnType<typeof hiddenTiming>} hidden */
const withHidden = hidden => (hidden ? {hidden} : {});

/**
 * One stats row's receive-wait sleeps, and the fixed-latency estimate at its end.
 * @param {{sleeps: number, ms: number, fixedMs: number}} now
 * @param {{sleeps: number, ms: number} | null} before the counts at the row's start
 */
function receiveRow(now, before) {
  return {
    sleeps: now.sleeps - (before?.sleeps ?? 0),
    sleptMs: tenths(now.ms - (before?.ms ?? 0)),
    fixedMs: tenths(now.fixedMs)
  };
}

/**
 * One stats row's access-unit timing: the mean and longest wait from host arrival to send, and
 * over the units that went through a gate, the mean age at gate and how many were in hand.
 * @param {{arrivedAt: number, gatedAt: number | null, sentAt: number,
 *   inHand: number | null}[]} samples
 */
function auTiming(samples) {
  const gated = samples.filter(sample => sample.gatedAt !== null);
  const mean = values =>
    values.length ? tenths(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  const waits = samples.map(sample => sample.sentAt - sample.arrivedAt);
  return {
    units: samples.length,
    gated: gated.length,
    waitMs: mean(waits),
    maxWaitMs: waits.length ? tenths(Math.max(...waits)) : null,
    gateAgeMs: mean(gated.map(sample => sample.gatedAt - sample.arrivedAt)),
    inHand: mean(gated.map(sample => sample.inHand)),
    maxInHand: gated.length ? Math.max(...gated.map(sample => sample.inHand)) : null
  };
}

/**
 * Adds the input feeder's bridge counts to a row's bridgeByStage, leaving the row's own
 * exchange totals to the video process.
 * @param {{bridgeByStage: Record<string, {exchanges: number, bridgeMs: number}>}} counts
 * @param {{exchanges: number, bridgeMs: number}} input
 */
function withInputStage(counts, input) {
  if (input.exchanges)
    counts.bridgeByStage.input = {exchanges: input.exchanges, bridgeMs: Math.round(input.bridgeMs)};
  return counts;
}

/** Input feeder ms per exchange at or under which the console link counts as ok, then weak. */
const LINK_MS = {ok: 3.5, weak: 6};
/** The steady rows the link event is read from. */
const LINK_ROWS = 3;
/** Shares of the steady seconds over which the summary calls the link bad. */
const LINK_VOID = {bad: 0.1, weakOrBad: 0.5};

/**
 * The console link read from the input feeder's bridge cost: its exchanges are the same every
 * second, so their mean time tracks the link rather than the stream. Null without input.
 * @param {{exchanges: number, bridgeMs: number}} input
 * @returns {{inputMsPerExchange: number, verdict: 'ok' | 'weak' | 'bad'} | null}
 */
function linkQuality(input) {
  if (!input.exchanges) return null;
  const inputMsPerExchange = Math.round((input.bridgeMs / input.exchanges) * 100) / 100;
  const verdict =
    inputMsPerExchange <= LINK_MS.ok ? 'ok' : inputMsPerExchange <= LINK_MS.weak ? 'weak' : 'bad';
  return {inputMsPerExchange, verdict};
}

/**
 * The link of the first LINK_ROWS steady rows, from their summed input exchanges; null until
 * they exist or without input. The warmup rows carry the feeder's start-up cost.
 * @param {{bridgeByStage: Record<string, {exchanges: number, bridgeMs: number}>}[]} rows
 * @param {number} warmup
 */
function steadyLink(rows, warmup) {
  if (rows.length < warmup + LINK_ROWS) return null;
  const total = {exchanges: 0, bridgeMs: 0};
  for (const row of rows.slice(warmup, warmup + LINK_ROWS)) {
    const input = row.bridgeByStage.input;
    if (!input) continue;
    total.exchanges += input.exchanges;
    total.bridgeMs += input.bridgeMs;
  }
  return linkQuality(total);
}

/**
 * How many rows had each link verdict, and the run's: bad when over LINK_VOID of the rows
 * with input were bad, or weak or bad together, else ok; null without input. Rows without
 * input count in none.
 * @param {{link?: {verdict: string} | null}[]} rows
 */
function linkSeconds(rows) {
  const seconds = {ok: 0, weak: 0, bad: 0};
  for (const row of rows) if (row.link) seconds[row.link.verdict]++;
  const total = seconds.ok + seconds.weak + seconds.bad;
  const voided =
    seconds.bad > LINK_VOID.bad * total || seconds.weak + seconds.bad > LINK_VOID.weakOrBad * total;
  return {...seconds, verdict: total ? (voided ? 'bad' : 'ok') : null};
}

/** The range checks of the stream flags, in the order they are reported. */
function checkFlags(args, flags) {
  const {inputHz, presentHz, skipBacklog, skipRule, decodeWait, receiveWait, trimBacklogMs} = flags;
  const {avoidWindow, gateOnReceive, outputLag, audioFrames, socketAudio, queue} = flags;
  const {duration, warmup, gateQueue} = flags;
  if (!Number.isInteger(inputHz) || inputHz < 10 || inputHz > 120)
    throw Error('--input-hz takes 10 to 120');
  if (presentHz !== 60 && presentHz !== 120) throw Error('--present-hz takes 60 or 120');
  if (skipBacklog !== Infinity && !(Number.isInteger(skipBacklog) && skipBacklog >= 0))
    throw Error('--skip-backlog takes a unit count or off');
  if (!['backlog', 'vsync'].includes(skipRule)) throw Error('--skip-rule takes backlog or vsync');
  if (skipRule === 'vsync' && skipBacklog === Infinity)
    throw Error('--skip-rule vsync needs a --skip-backlog unit count');
  if (decodeWait && skipRule !== 'vsync') throw Error('--decode-wait needs --skip-rule vsync');
  if (trimBacklogMs !== null && !(trimBacklogMs > 0))
    throw Error('--trim-backlog-ms takes a unit age in milliseconds');
  if (trimBacklogMs !== null && skipRule === 'vsync')
    throw Error('--trim-backlog-ms needs --skip-rule backlog');
  if (trimBacklogMs !== null && skipBacklog < 1)
    throw Error('--trim-backlog-ms needs --skip-backlog 1 or more');
  if (avoidWindow && !(decodeWait || receiveWait))
    throw Error('--avoid-window needs --decode-wait or --receive-wait to predict the events');
  if (gateOnReceive && presentHz === 120)
    throw Error('--gate-on-receive is untested at --present-hz 120');
  if (gateQueue && !gateOnReceive) throw Error('--gate-queue needs --gate-on-receive');
  if (outputLag !== null && outputLag !== 0 && outputLag !== 1 && outputLag !== 2)
    throw Error('--output-lag takes 0, 1 or 2');
  if (outputLag === 0 && gateQueue) throw Error('--output-lag 0 is untested with --gate-queue');
  if (outputLag === 0 && gateOnReceive)
    throw Error('--output-lag 0 is untested with --gate-on-receive');
  if (outputLag === 0 && presentHz !== 60)
    throw Error('--output-lag 0 is untested at --present-hz 120');
  if (!Number.isInteger(audioFrames) || audioFrames < FRAME_STEP || audioFrames % FRAME_STEP)
    throw Error('--audio-frames takes a multiple of 240');
  if (socketAudio && audioFrames > SOCKET_AUDIO_FRAMES)
    throw Error('--audio-frames takes up to 3840 with --socket-audio');
  if (!Number.isInteger(queue) || queue < 1 || queue > 16)
    throw Error('--queue takes 1 to 16 units');
  if (duration !== null && !(duration > 0)) throw Error('--duration takes seconds');
  if (!Number.isInteger(warmup) || warmup < 0) throw Error('--warmup takes whole seconds');
  if (args.includes('--expect') && !/^[a-z]/i.test(cli.option(args, '--expect') ?? ''))
    throw Error('--expect needs a value such as fps=30,dropped=0,idr=0');
}

/** Reads the stream flags; throws on the first one that is missing or out of range. */
function parseOptions(args, rpc, width, height, fps) {
  const at = args.indexOf('--moonlight');
  const host = args[at + 1];
  const app = args[at + 2];
  if (at < 0 || !host || !app) throw Error('Native H.264 requires --moonlight HOST APP');
  const audio = !args.includes('--no-audio');
  const socketTone = args.includes('--socket-audio-tone');
  const socketAudio = socketTone || args.includes('--socket-audio');
  if (socketAudio && !audio) throw Error('--socket-audio cannot be combined with --no-audio');
  const inputPush = args.includes('--input-push');
  if (inputPush && args.includes('--no-input'))
    throw Error('--input-push cannot be combined with --no-input');
  const skipRule = cli.option(args, '--skip-rule') ?? 'backlog';
  const flags = {
    host,
    app,
    audio,
    socketTone,
    socketAudio,
    duration: cli.number(args, '--duration', null),
    warmup: cli.number(args, '--warmup', 3),
    queue: cli.number(args, '--queue', QUEUE),
    inputHz: cli.number(args, '--input-hz', inputPush ? 120 : 60),
    inputPush,
    presentHz: cli.number(args, '--present-hz', 60),
    skipRule,
    trimBacklogMs: cli.number(args, '--trim-backlog-ms', null),
    gateOnReceive: args.includes('--gate-on-receive'),
    gateQueue: args.includes('--gate-queue'),
    outputLag: cli.number(args, '--output-lag', null),
    decodeWait: args.includes('--decode-wait'),
    receiveWait: args.includes('--receive-wait'),
    avoidWindow: exchangeTiming.parseAvoid(cli.option(args, '--avoid-window') ?? undefined),
    skipBacklog:
      cli.option(args, '--skip-backlog') === 'off'
        ? Infinity
        : cli.number(args, '--skip-backlog', skipRule === 'vsync' ? 1 : 2),
    audioFrames: cli.number(
      args,
      '--audio-frames',
      socketAudio ? 1920 : rpc.a.protocol >= 3 ? 960 : 1920
    ),
    input: !args.includes('--no-input')
  };
  checkFlags(args, flags);
  return {
    ...flags,
    expect: scoring.parseExpect(cli.option(args, '--expect') ?? undefined),
    bitrate: streamBitrate(args, width, height, fps)
  };
}

/** The per-row counters, in stats-row order. */
function freshStats() {
  return {
    received: 0,
    submitted: 0,
    decoded: 0,
    presented: 0,
    skipped: 0,
    bytes: 0,
    keyframes: 0,
    resyncs: 0,
    idr: 0
  };
}

/** The commit this host runs from, for the manifest and the record name. */
function headRevision() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    encoding: 'utf8'
  }).trim();
}

/** HB_NATIVE_LOG_DIR, or a new record named after the start time and the revision. */
function recordDirectory(revision) {
  return (
    process.env.HB_NATIVE_LOG_DIR ||
    path.join(
      builds('native-h264'),
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + revision.slice(0, 8)
    )
  );
}

async function writeManifest(output, session, revision) {
  await fs.mkdir(output, {recursive: true, mode: PRIVATE_DIRECTORY});
  await fs.writeFile(
    path.join(output, 'manifest.json'),
    JSON.stringify(
      {
        session,
        sourceRevision: revision,
        builder: os.hostname(),
        targetArchitecture: 'aarch64',
        command: process.argv,
        started: new Date().toISOString()
      },
      null,
      2
    ) + '\n',
    {mode: PRIVATE_FILE}
  );
}

/** The helper's stream command: raw H.264 on H264_FD and, with audio, PCM on AUDIO_FD. */
function helperArgs(host, app, {width, height, fps, bitrate, audio}) {
  return [
    'stream',
    host,
    app,
    '--size',
    `${width}x${height}`,
    '--fps',
    String(fps),
    '--bitrate',
    bitrate,
    '--raw-h264-fd',
    String(H264_FD),
    ...(audio ? ['--audio-fd', String(AUDIO_FD)] : [])
  ];
}

/**
 * The run's summary record, before scoring; the steady rows are those after the warmup.
 * @param {ReturnType<typeof parseOptions>} options
 */
function buildSummary(
  options,
  {rows, staggeredLive, tail, socketAudioReport, inputPushStop, stopReason}
) {
  const {presentHz, skipBacklog, skipRule, trimBacklogMs, gateOnReceive, outputLag} = options;
  const {decodeWait, receiveWait, avoidWindow, queue, inputHz, audioFrames, audio} = options;
  const {socketAudio, input, inputPush, warmup, expect, gateQueue} = options;
  const steadyRows = rows.slice(warmup);
  return {
    workerMode: 'staggered',
    decoded: steadyRows.reduce((sum, row) => sum + row.decoded, 0),
    presentHz,
    skipBacklog: skipBacklog === Infinity ? 'off' : skipBacklog,
    skipRule,
    ...(trimBacklogMs !== null && {trimBacklogMs}),
    ...(gateOnReceive && {gateOnReceive}),
    ...(gateQueue && {gateQueue}),
    ...(outputLag !== null && {outputLag}),
    decodeWait,
    receiveWait,
    avoidWindow,
    staggered: {...(staggeredLive?.counts ?? {}), tail},
    queue,
    inputHz,
    ...(inputPush && {inputPush, inputPushStop}),
    audioFrames,
    audio,
    ...(socketAudio ? {socketAudio: socketAudioReport} : {}),
    input,
    link: linkSeconds(steadyRows),
    ...scoring.summarize(rows, {warmup}),
    expect,
    stopReason
  };
}

/** @typedef {ReturnType<typeof buildSummary> & ReturnType<typeof scoring.verdict>} Scored */

/** Scores the summary against --expect and the stop reason, and merges the verdict into it. */
function score(summary, {expect, duration, socketAudioReport, inputPushStop, stopReason}) {
  const result = scoring.verdict(summary, expect);
  if (socketAudioReport?.error) result.failures.push('socket audio: ' + socketAudioReport.error);
  if (inputPushStop?.error || inputPushStop?.retained)
    result.failures.push('input push: ' + (inputPushStop.error ?? 'worker retained'));
  if (stopReason === 'console-stalled') result.failures.push('console stopped answering');
  if (duration !== null && stopReason !== 'duration')
    result.failures.push('ended before duration: ' + stopReason);
  result.pass = result.failures.length === 0;
  Object.assign(summary, result);
  return result;
}

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
  const {host, app, audio, socketTone, socketAudio, duration, queue, inputHz, inputPush} = options;
  const {presentHz, skipRule, trimBacklogMs, gateOnReceive, outputLag} = options;
  const {decodeWait, receiveWait, avoidWindow, skipBacklog, audioFrames, bitrate} = options;
  const {gateQueue} = options;
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
  let socketAudioReport = null;
  let helper = null;
  let reader = null;
  let statusLines = null;
  let monitor = null;
  let printing = null;
  let ending = null;
  let stopped = false;
  let stopReason = null;
  const rows = [];
  const children = [];
  let inputBridge = {exchanges: 0, bridgeMs: 0};
  /** @type {import('../input/pad-age.js').PadRow[]} */
  let inputPad = [];
  let pushCounts = {pushed: 0, dropped: 0, gapMaxMs: 0};
  /** @type {{child: any, done: Promise<unknown>} | null} */
  let inputFeeder = null;
  /** @type {{stopped: boolean, retained: boolean, error: string | null} | null} */
  let inputPushStop = null;
  let trimmed = 0;
  let auSamples = [];
  const stats = freshStats();
  // The decoder generations and what the current one has been fed.
  let resets = [];
  let generation = 0;
  let sps;
  let pps;
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
  const idrRequester = createIdrRequester(() => {
    if (stopping) return;
    stats.idr++;
    helper.stdin.write(JSON.stringify({type: 'request-idr'}) + '\n');
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
    stopped = stopping = true;
    stopReason = reason;
    log({event: 'native-stop', reason});
    idrRequester.close();
    for (const child of children) child.kill('SIGINT');
    helper?.stdin.end();
    helper?.kill('SIGINT');
    reader?.close();
    soundSource?.halt();
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
    staggeredLive = createStaggered({
      presentHz,
      skipBacklog,
      skipRule: /** @type {'backlog' | 'vsync'} */ (skipRule),
      ...(trimBacklogMs !== null && {trimBacklogMs}),
      ...(gateOnReceive && {gateOnReceive}),
      ...(gateQueue && {gateQueue}),
      ...(outputLag !== null && {lag: /** @type {0 | 1 | 2} */ (outputLag)}),
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

  /** The helper's JSON stderr: unit metadata goes to the reader, other events to the log. */
  function relayStatus(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      console.error('hbmoonlight ' + line);
      return;
    }
    if (record.type === 'au') reader.announce(record);
    else if (record.event !== 'stats') log(record);
  }

  function spawnHelper() {
    helper = spawnProcess(helperPath, helperArgs(host, app, {width, height, fps, bitrate, audio}), {
      stdio: ['pipe', 'ignore', 'pipe', audio ? 'pipe' : 'ignore', 'pipe']
    });
    reader = new AccessUnits(
      /** @type {import('node:stream').Readable} */ (helper.stdio[H264_FD]),
      {
        maxQueuedUnits: queue,
        onBacklog: requestIdr,
        now
      }
    );
    helper.stdin.on('error', error => {
      if (!stopping) reader.fail(error);
    });
    helper.on('error', error => reader.fail(error));
    helper.on('exit', (code, signal) => {
      log({event: 'helper-exit', code, signal, stopping});
      if (!stopping && code !== 0) reader.fail(Error('hbmoonlight exited: ' + (signal || code)));
    });
    statusLines = readline.createInterface({input: helper.stderr});
    statusLines.on('line', relayStatus);
    statusLines.on('close', () => reader.endMetadata());
  }

  /** Fails the stream when a child cannot start or exits uninvited with a non-zero code. */
  function watchChild(child, name) {
    child.on('error', error => reader.fail(error));
    child.on('exit', (code, signal) => {
      if (!stopping && code !== 0) reader.fail(Error(name + ' exited: ' + (signal || code)));
    });
    children.push(child);
  }

  /**
   * The input feeder writes to the helper's stdin and its bridge counts to fd 3, plus its
   * record counts and, last, its stop report with --input-push.
   */
  function spawnInputFeeder() {
    const child = spawnProcess(
      process.execPath,
      [
        path.join(import.meta.dirname, '../input/input-feeder.js'),
        directory,
        '--hz',
        String(inputHz),
        '--counts-fd',
        '3',
        ...(inputPush ? ['--push'] : [])
      ],
      {
        stdio: ['ignore', helper.stdin, 'inherit', 'pipe']
      }
    );
    const done = [new Promise(resolve => child.once('exit', resolve))];
    if (child.stdio?.[3]) {
      const lines = readline.createInterface({
        input: /** @type {import('node:stream').Readable} */ (child.stdio[3])
      });
      if (inputPush) done.push(new Promise(resolve => lines.once('close', resolve)));
      lines
        .on('line', line => {
          try {
            const counts = JSON.parse(line);
            if (counts.stopped !== undefined) {
              inputPushStop = counts;
              return;
            }
            inputBridge.exchanges += counts.exchanges;
            inputBridge.bridgeMs += counts.bridgeMs;
            if (counts.pad) inputPad.push(counts.pad);
            if (counts.pushed === undefined) return;
            pushCounts.pushed += counts.pushed;
            pushCounts.dropped += counts.dropped;
            pushCounts.gapMaxMs = Math.max(pushCounts.gapMaxMs, counts.gapMaxMs);
          } catch {}
        })
        .on('error', error => log({event: 'input-counts-error', message: error.message}));
    }
    inputFeeder = {child, done: Promise.all(done)};
    watchChild(child, 'Moonlight input feed');
  }

  /**
   * Waits for the input feeder to stop its console worker and report, and kills it past
   * feederExitMs. A push feeder that was killed or did not report may have left its worker
   * running, so that counts as retained.
   */
  async function awaitInputFeeder(errors) {
    if (!inputFeeder) return;
    let timer;
    const late = new Promise(resolve => (timer = setTimeout(resolve, feederExitMs, false)));
    const exited = await Promise.race([inputFeeder.done.then(() => true), late]);
    clearTimeout(timer);
    if (!exited) {
      inputFeeder.child.kill('SIGKILL');
      log({event: 'input-feeder-killed', afterMs: feederExitMs});
    }
    if (!inputPush) return;
    if (!exited || !inputPushStop)
      inputPushStop = {
        stopped: false,
        retained: true,
        error: exited ? 'input feeder sent no stop report' : 'input feeder did not exit'
      };
    log({event: 'input-push-stop', ...inputPushStop});
    if (inputPushStop.retained)
      errors.push(Error('Input push worker retained for safety; restart SmileBASIC'));
  }

  /** The audio stream reads the helper's PCM pipe as its stdin. */
  function spawnAudioStream() {
    const child = spawnProcess(
      process.execPath,
      [
        path.join(import.meta.dirname, '../audio/audio-stream.js'),
        directory,
        '--buffer-frames',
        String(audioFrames),
        '--queue',
        '2',
        '--prime',
        '2',
        '--stats'
      ],
      {
        stdio: [helper.stdio[AUDIO_FD], 'inherit', 'inherit']
      }
    );
    watchChild(child, 'Moonlight audio stream');
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
      reader.fail(error);
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
    return {
      codec: 'h264',
      ...stats,
      dropped: reader.dropped - dropped,
      queued,
      ...(staggeredLive ? {waiting: countsSince(staggeredLive.counts.waiting, waited)} : {}),
      ...(staggeredLive?.counts.receive
        ? {receive: receiveRow(staggeredLive.counts.receive, slept)}
        : {}),
      au: auTiming(auSamples),
      ...withHidden(hiddenTiming(auSamples)),
      ...(trimBacklogMs !== null ? {trimmed} : {}),
      ...withInputStage(bridge.take(), inputBridge),
      ...(inputPad.length ? {inputPad: padAge.merge(inputPad)} : {}),
      link: linkQuality(inputBridge),
      ...(inputPush ? {inputPush: pushCounts} : {}),
      at: stage + '/' + (decoder?.step ?? '-'),
      ms: Object.fromEntries(Object.entries(stageMs).map(([k, v]) => [k, Math.round(v)]))
    };
  }

  function startRow() {
    stageMs = {};
    inputBridge = {exchanges: 0, bridgeMs: 0};
    inputPad = [];
    pushCounts = {pushed: 0, dropped: 0, gapMaxMs: 0};
    auSamples = [];
    trimmed = 0;
    dropped = reader.dropped;
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
      backlog: reader.ready.length,
      onGate: at => {
        sample.gatedAt = at;
        sample.inHand = 1 + reader.ready.length;
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
      ...(trimBacklogMs !== null && {trimBacklogMs}),
      ...(gateOnReceive && {gateOnReceive}),
      ...(gateQueue && {gateQueue}),
      ...(outputLag !== null && {outputLag})
    });
  }

  /** Submits a unit on the host-driven path and publishes every frame it owes. */
  async function submitHostPath(unit) {
    enter('submit');
    await decoder.submit(unit);
    stats.submitted++;
    outstanding++;
    // Frames before the staggered workers take the host-driven path, which is
    // drained fully so the workers start with no output owed.
    const drainUntil = Date.now() + DRAIN_MS;
    for (let pull = true; pull || outstanding > 0; pull = false) {
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
    }
  }

  /** Socket audio report, written next to the run directory's other Moonlight records. */
  async function closeSocketAudio(errors) {
    socketAudioReport = await soundSource.close();
    log({event: 'socket-audio', ...socketAudioReport});
    await fs
      .writeFile(
        path.join(directory, `moonlight-audio-${Date.now()}.json`),
        JSON.stringify(
          {
            session: rpc.a.session,
            mode: 'socket',
            completed: new Date().toISOString(),
            ...socketAudioReport
          },
          null,
          2
        )
      )
      .catch(error => errors.push(error));
    if (socketAudioReport.retainedForSafety) errors.push(Error(socketAudioReport.error));
  }

  /**
   * Stops the workers, then closes the decoder and the sink; with a lost bridge or a failed
   * worker stop the native objects are left alone instead.
   */
  async function releaseNative(errors) {
    let retained = Boolean(rpc.bridgeLost);
    if (staggeredLive && !retained) {
      try {
        await staggeredLive.stop();
      } catch (error) {
        errors.push(error);
        retained = true;
      }
      const dropped = staggeredLive.gateError;
      if (dropped && dropped !== failed)
        log({
          event: 'staggered-gate-dropped-error',
          error: dropped.message,
          ...(dropped.expected && {expected: dropped.expected, checked: dropped.checked})
        });
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
    spawnHelper();
    if (options.input) spawnInputFeeder();
    if (socketAudio) {
      soundSource = await createSocketAudio({
        rpc,
        host: rpc.host,
        bufferBytes: audioFrames * FRAME_BYTES,
        tone: socketTone,
        onError: error => reader.fail(error)
      });
      soundSource.attach(helper.stdio[AUDIO_FD]);
      log({event: 'socket-audio', started: true, bufferBytes: audioFrames * FRAME_BYTES});
    } else if (audio) spawnAudioStream();
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
    const sets = parameterSets(unit.data);
    if (configured && ((sets.sps && !sets.sps.equals(sps)) || (sets.pps && !sets.pps.equals(pps))))
      await resync(Error('H.264 parameter sets changed'));
    sps = sets.sps || sps;
    pps = sets.pps || pps;
    if (configured) return true;
    if (!unit.keyframe || !sps || !pps) return false;
    await decoder.configure(sps, pps, fps);
    configured = true;
    return true;
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
    queued = Math.max(queued, reader.ready.length);
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
    } else tail = {drained: 0, skipped: stopReason};
    log({event: 'staggered-tail', ...tail});
  }

  async function streamUnits() {
    for await (const unit of reader) if (await feedUnit(unit)) break;
    if (staggeredLive?.pending) await finishTail();
  }

  /** Logs a failed stream, with the workers' snapshot while the bridge still answers. */
  async function logFailure(error) {
    if (staggeredLive?.exists && !rpc.bridgeLost)
      log({
        event: 'staggered-snapshot',
        snapshot: await staggeredLive
          .snapshot()
          .catch(snapshotError => ({error: snapshotError.message})),
        ...(error.expected && {
          expected: error.expected,
          checked: error.checked,
          previous: error.previous
        })
      });
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
    statusLines?.close();
    const errors = [];
    await awaitInputFeeder(errors);
    if (soundSource) await closeSocketAudio(errors);
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
      socketAudioReport,
      inputPushStop,
      stopReason
    });
    const result = score(summary, {
      expect: options.expect,
      duration,
      socketAudioReport,
      inputPushStop,
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
