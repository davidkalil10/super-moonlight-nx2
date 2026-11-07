/**
 * Per-frame latency legs from the console's timing blocks on the video channel, summarized per
 * second as `civ7-latency` events. Wire format and legs in README.md, "Latency".
 */
import {createClockSync, pcNow} from './clock.js';

/** Timing block: magic "TIM1", sequence, u64 base µs, four u32 µs offsets from the base. */
export const TIMING = {magic: 0x314d4954, bytes: 32, none: 0xffffffff};
export const LEGS = ['network', 'decode', 'present', 'input', 'ack'];

/**
 * Loop block, once a second after a timing block: magic "LOP2", units, presented, pipelined,
 * elapsed µs, the second's µs per stage, the sum and max µs from arrival to present over the
 * presented units, then the units whose work ran while the next one decoded and that work's µs;
 * README.md, "Pipelined decode".
 */
const LOOP_STAGES = ['idle', 'receive', 'submit', 'decodeWait', 'output', 'present', 'ack', 'acquire', 'gpuWait'];
export const LOOP = {magic: 0x32504f4c, bytes: 36 + LOOP_STAGES.length * 4, stages: LOOP_STAGES};

/**
 * @typedef {{sequence: number, header: number, arrived: number, decoded: number | null,
 *   presented: number | null, input: number | null}} Timing  console clock, ms
 * @typedef {{sequence: number, sentMs: number, acknowledgedMs: number,
 *   forwardedMs: number | null, timing: Timing}} TimedFrame  PC clock, ms
 * @typedef {{count: number, p50: number, p90: number, max: number}} LegSummary
 * @typedef {Record<string, number | null>} Legs  ms per LEGS name, null when not measured
 */

/**
 * The logged events latencyReport reads, as createLatencyMonitor and stream.js write them.
 * @typedef {{type: 'civ7-latency', frames: number, caughtUp?: number, legs: Record<string, LegSummary | null>,
 *   clock: {offsetMs: number, uncertaintyMs: number, rttMs: number, syncs: number} | null}} LatencyEvent
 * @typedef {{type: 'civ7-stats', queueAgeMs?: number, caughtUp?: number}} StatsEvent
 * @typedef {{type: 'civ7-clock-error', message: string}} ClockErrorEvent
 */

/**
 * @param {Buffer} bytes one whole block
 * @returns {Timing}
 */
export function readTiming(bytes) {
  if (bytes.length !== TIMING.bytes || bytes.readUInt32LE(0) !== TIMING.magic)
    throw Error('Invalid video timing block');

  const baseUs = bytes.readUInt32LE(8) + bytes.readUInt32LE(12) * 0x100000000;
  const mark = (/** @type {number} */ offset) => {
    const value = bytes.readUInt32LE(offset);
    if (value === TIMING.none) return null;
    return (baseUs + value) / 1000;
  };

  const arrived = mark(16);
  if (arrived === null) throw Error('Video timing has no arrival');
  return {sequence: bytes.readUInt32LE(4), header: baseUs / 1000, arrived,
    decoded: mark(20), presented: mark(24), input: mark(28)};
}

/**
 * @typedef {{units: number, presented: number, pipelined: number, elapsedMs: number, busyMs: number,
 *   unitMs: number | null, perUnitMs: Record<string, number> | null,
 *   receiveToPresentMs: {mean: number, max: number} | null, overlapped: number,
 *   overlappedMs: number | null}} ConsoleLoop
 *   `unitMs` is the console's busy time (elapsed minus idle) per unit, the cost the frame
 *   period must cover; `receiveToPresentMs` runs from a unit's arrival to its present returning;
 *   `overlappedMs` is the mean ms of an `overlapped` unit's work that ran while the next decoded
 */

/**
 * @param {Buffer} bytes one whole block
 * @returns {ConsoleLoop}
 */
export function readLoop(bytes) {
  if (bytes.length !== LOOP.bytes || bytes.readUInt32LE(0) !== LOOP.magic)
    throw Error('Invalid video loop block');

  const units = bytes.readUInt32LE(4);
  const ms = (/** @type {number} */ offset) => bytes.readUInt32LE(offset) / 1000;
  const totals = Object.fromEntries(LOOP.stages.map((stage, index) => [stage, ms(20 + index * 4)]));
  const elapsedMs = ms(16);
  const busyMs = Math.max(elapsedMs - totals.idle, 0);

  const perUnit = (/** @type {number} */ value) => round(value / units);
  const presented = bytes.readUInt32LE(8);
  const latencyAt = 20 + LOOP.stages.length * 4;
  const receiveToPresentMs = presented
    ? {mean: round(ms(latencyAt) / presented), max: round(ms(latencyAt + 4))}
    : null;
  const overlapped = bytes.readUInt32LE(latencyAt + 8);
  const overlappedMs = overlapped ? round(ms(latencyAt + 12) / overlapped) : null;
  return {units, presented, pipelined: bytes.readUInt32LE(12),
    elapsedMs: round(elapsedMs), busyMs: round(busyMs), unitMs: units ? perUnit(busyMs) : null,
    perUnitMs: units ? Object.fromEntries(LOOP.stages.map(stage => [stage, perUnit(totals[stage])])) : null,
    receiveToPresentMs, overlapped, overlappedMs};
}

/**
 * Legs in ms. network and input cross clocks and stay null without a clock estimate.
 * @param {TimedFrame} frame
 * @param {{offsetMs: number} | null} clock console = PC + offsetMs
 */
export function frameLegs(frame, clock) {
  const {timing} = frame;
  /** @type {Legs} */
  const legs = {network: null, decode: null, present: null, input: null,
    ack: frame.acknowledgedMs - frame.sentMs};

  if (timing.decoded !== null) legs.decode = timing.decoded - timing.arrived;
  if (timing.decoded !== null && timing.presented !== null) legs.present = timing.presented - timing.decoded;
  if (!clock) return legs;

  legs.network = timing.arrived - clock.offsetMs - frame.sentMs;
  if (timing.input !== null && frame.forwardedMs !== null)
    legs.input = frame.forwardedMs - (timing.input - clock.offsetMs);
  return legs;
}

/**
 * Decoded but never presented: the console caught up past it (README.md, "Catching up").
 * @param {Timing} timing
 */
export const isCaughtUp = timing => timing.decoded !== null && timing.presented === null;

/** @param {number} value */
const round = value => Math.round(value * 100) / 100;

/**
 * Nearest-rank percentiles.
 * @param {number[]} values
 * @returns {LegSummary | null}
 */
export function summarize(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const rank = (/** @type {number} */ fraction) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
  return {count: sorted.length, p50: round(rank(0.5)), p90: round(rank(0.9)), max: round(sorted[sorted.length - 1])};
}

/**
 * Collects timed frames, keeps the console clock synced through `request` (payload.js `time`)
 * and logs one `civ7-latency` event per `reportMs`.
 * @param {{request: () => Promise<Record<string, unknown>>, log: (event: object) => void,
 *   now?: () => number, syncMs?: number, reportMs?: number, pings?: number}} options
 */
export function createLatencyMonitor({request, log, now = pcNow, syncMs = 5000, reportMs = 1000, pings = 5}) {
  let clockFailed = false;
  const clock = createClockSync({now, pings, intervalMs: syncMs,
    request: async () => {
      const {now: remote} = await request();
      return typeof remote === 'number' ? remote : NaN;
    },
    onError(error) {
      if (clockFailed) return;
      clockFailed = true;
      log({type: 'civ7-clock-error', message: String(error.message || error)});
    }});
  /** @type {Record<string, number[]>} */
  const pending = Object.fromEntries(LEGS.map(leg => [leg, []]));
  let frames = 0;
  let caughtUp = 0;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;

  function report() {
    if (!frames) return;

    const estimate = clock.estimate();
    const legs = Object.fromEntries(LEGS.map(leg => [leg, summarize(pending[leg])]));
    log({type: 'civ7-latency', frames, caughtUp, legs, clock: estimate && {offsetMs: round(estimate.offsetMs),
      uncertaintyMs: round(estimate.uncertaintyMs), rttMs: round(estimate.rttMs), syncs: clock.syncs}});

    for (const leg of LEGS) pending[leg].length = 0;
    frames = 0;
    caughtUp = 0;
  }

  return {
    clock,
    /** @param {TimedFrame} frame */
    frame(frame) {
      const legs = frameLegs(frame, clock.estimate(frame.acknowledgedMs));
      for (const leg of LEGS) {
        const value = legs[leg];
        if (value !== null && value !== undefined) pending[leg].push(value);
      }

      if (isCaughtUp(frame.timing)) caughtUp++;
      frames++;
    },
    start() {
      if (timer) return;
      clock.start();
      timer = setInterval(report, reportMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      clock.stop();
      report();
    }
  };
}

/**
 * Runs logged before 2026-11-07 also hold each event a second time as a `stream-event` copy.
 * @param {string} type
 */
const eventsOf = type => (/** @type {object} */ event) => 'type' in event && event.type === type &&
  !('event' in event && event.event === 'stream-event');

/**
 * @param {unknown} value
 * @returns {value is number}
 */
const finite = value => Number.isFinite(value);

/**
 * The run-level view of `civ7-latency` and `civ7-stats` events: per leg, the median of the
 * per-second p50 and p90 and the largest max; the per-second summaries cannot be re-ranked.
 * @param {object[]} events
 */
export function latencyReport(events) {
  const seconds = /** @type {LatencyEvent[]} */ (events.filter(eventsOf('civ7-latency')));
  const median = (/** @type {number[]} */ values) => summarize(values)?.p50 ?? null;
  /** @type {Record<string, {seconds: number, frames: number, p50: number | null, p90: number | null, max: number}>} */
  const legs = {};
  for (const leg of LEGS) {
    const rows = seconds.map(event => event.legs?.[leg]).filter(row => !!row);
    if (!rows.length) continue;
    legs[leg] = {seconds: rows.length, frames: rows.reduce((sum, row) => sum + row.count, 0),
      p50: median(rows.map(row => row.p50)), p90: median(rows.map(row => row.p90)),
      max: Math.max(...rows.map(row => row.max))};
  }

  const clocks = seconds.map(event => event.clock).filter(clock => !!clock);
  const uncertainty = clocks.map(clock => clock.uncertaintyMs);
  const stats = /** @type {StatsEvent[]} */ (events.filter(eventsOf('civ7-stats')));
  const queueAge = stats.map(event => event.queueAgeMs).filter(finite);

  return {
    seconds: seconds.length,
    frames: seconds.reduce((sum, event) => sum + event.frames, 0),
    caughtUp: seconds.reduce((sum, event) => sum + (event.caughtUp ?? 0), 0),
    legs,
    clock: clocks.length ? {uncertaintyMs: median(uncertainty), worstUncertaintyMs: Math.max(...uncertainty),
      offsetDriftMs: round(clocks[clocks.length - 1].offsetMs - clocks[0].offsetMs)} : null,
    queueAgeMaxMs: queueAge.length ? {p50: median(queueAge), max: Math.max(...queueAge)} : null,
    clockErrors: /** @type {ClockErrorEvent[]} */ (events.filter(eventsOf('civ7-clock-error'))).map(event => event.message)
  };
}
