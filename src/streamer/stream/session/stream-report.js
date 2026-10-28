/**
 * The run report: stats-row and link helpers, the manifest and the scored summary.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import {builds} from '../../../../../hbl-platform/sdk/build.js';
import * as scoring from './run-summary.js';

/** The run record is private to the user. */
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;

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
  const timing = {
    units: hidden.length,
    totalMs: spread('totalMs'),
    pipeMs: spread('pipeMs'),
    receiveMs: spread('receiveMs'),
    queueMs: spread('queueMs'),
    queued: spread('queued'),
    unread: spread('unread'),
    writeMs: spread('writeMs')
  };
  if (hosted.length) timing.hostMs = {units: hosted.length, ...meanMax(hosted)};
  return timing;
}

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
 * gateAgeMs is the age of the unit whose push ran the gate; ownGateMs is the age of the unit the
 * gate opened, which under the default gate is the one before it.
 * @param {{arrivedAt: number, gatedAt: number | null, sentAt: number,
 *   ownGateMs?: number | null, inHand: number | null}[]} samples
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
    ownGateMs: mean(gated.map(sample => sample.ownGateMs).filter(ms => ms != null)),
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
 * The socket audio counters so far, so a long run shows when they moved.
 * @param {{late: number, overruns: number, underruns: number}} report
 */
const audioCounters = ({late, overruns, underruns}) => ({late, overruns, underruns});

/**
 * The console link read from the input feeder's bridge cost: its exchanges are the same every
 * second, so their mean time tracks the link rather than the stream. Null without input.
 * @param {{exchanges: number, bridgeMs: number}} input
 * @returns {{inputMsPerExchange: number, verdict: 'ok' | 'weak' | 'bad'} | null}
 */
function linkQuality(input) {
  if (!input.exchanges) return null;
  const inputMsPerExchange = Math.round((input.bridgeMs / input.exchanges) * 100) / 100;
  return {inputMsPerExchange, verdict: linkVerdict(inputMsPerExchange)};
}

/**
 * @param {number} msPerExchange
 * @returns {'ok' | 'weak' | 'bad'}
 */
function linkVerdict(msPerExchange) {
  if (msPerExchange <= LINK_MS.ok) return 'ok';
  if (msPerExchange <= LINK_MS.weak) return 'weak';
  return 'bad';
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
  const tooBad = seconds.bad > LINK_VOID.bad * total;
  const tooWeak = seconds.weak + seconds.bad > LINK_VOID.weakOrBad * total;

  /** @type {'ok' | 'bad' | null} */
  let verdict = null;
  if (total) verdict = tooBad || tooWeak ? 'bad' : 'ok';
  return {...seconds, verdict};
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
    cwd: path.resolve(import.meta.dirname, '../../../..'),
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

/**
 * The gate flags that are on, for the summary and the worker-start event.
 * @param {{trimBacklogMs: number | null, gateOnReceive: boolean, gateQueue: boolean,
 *   outputLag: number | null}} flags
 * @returns {{trimBacklogMs?: number, gateOnReceive?: boolean, gateQueue?: boolean,
 *   outputLag?: number}}
 */
function activeGateFlags({trimBacklogMs, gateOnReceive, gateQueue, outputLag}) {
  const active = {};
  if (trimBacklogMs !== null) active.trimBacklogMs = trimBacklogMs;
  if (gateOnReceive) active.gateOnReceive = gateOnReceive;
  if (gateQueue) active.gateQueue = gateQueue;
  if (outputLag !== null) active.outputLag = outputLag;
  return active;
}

/**
 * The run's summary record, before scoring; the steady rows are those after the warmup.
 * @param {ReturnType<typeof import('./stream-options.js').parseOptions>} options
 */
function buildSummary(
  options,
  {rows, staggeredLive, tail, socketAudioReport, inputPushStop, stopReason, lagEnd, stream}
) {
  const {presentHz, skipBacklog, skipRule, decodeWait, receiveWait, avoidWindow} = options;
  const {queue, inputHz, audioFrames, audio, socketAudio, input, inputPush, warmup, expect} =
    options;
  const steadyRows = rows.slice(warmup);
  return {
    workerMode: 'staggered',
    decoded: steadyRows.reduce((sum, row) => sum + row.decoded, 0),
    presentHz,
    skipBacklog: skipBacklog === Infinity ? 'off' : skipBacklog,
    skipRule,
    ...activeGateFlags(options),
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
    stopReason,
    ...(lagEnd && {lagEnd}),
    ...(stream.sps && {sps: stream.sps}),
    ...(stream.bSlices && {bSlices: stream.bSlices})
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
  if (stopReason === 'lag0-timeout')
    result.failures.push('lag 0 decoder wait timed out; rerun with --output-lag 1');
  if (stopReason === 'lag0-reorder')
    result.failures.push('lag 0 refused, the stream can reorder; rerun with --output-lag 1');
  const torn = summary.staggered?.surfaceCheck?.torn;
  if (torn) result.failures.push(`surface check: ${torn} surfaces changed before reuse`);
  if (duration !== null && stopReason !== 'duration')
    result.failures.push('ended before duration: ' + stopReason);
  result.pass = result.failures.length === 0;
  Object.assign(summary, result);
  return result;
}

export {
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
};
