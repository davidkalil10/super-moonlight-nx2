// The supervised refresh-rate probe: per candidate rate, raise the panel (above 60), present about
// a second at the 1/rate swap interval, read 354 and restore; it stops at the first error and always
// restores. 75 and 90 have no panel mode and presented at 60 on the device.

/** @import {createRefreshRate} from './refresh-rate.js' */

/** @typedef {{frames: number, elapsedMs: number, intervals?: number[]}} Batch */

/**
 * @typedef {object} RateResult
 * @property {number} rate
 * @property {string} verdict `even`, `uneven`, `off-rate`, `rate-only` (no intervals) or `error`
 * @property {string | null} flagsBefore
 * @property {string | null} flagsAfter 354 read while the panel was still raised
 * @property {number} [frames]
 * @property {number} [elapsedMs]
 * @property {number} [measuredHz]
 * @property {boolean} [withinRate]
 * @property {{minMs: number, maxMs: number, counts: Record<string, number>} | null} [intervals]
 * @property {boolean} [restored]
 * @property {string} [error]
 */

export const PROBE = {confirmFrames: 24, confirmBatches: 20, rateTolerance: 0.03, intervalSlackMs: 2};

const round2 = (/** @type {number} */ value) => Math.round(value * 100) / 100;

/** @param {bigint | null} flags */
const flagText = flags => flags === null ? null : '0x' + flags.toString(16);

/**
 * Presents/s against the rate and, with intervals, whether every present after the first sits
 * within `intervalSlackMs` of the period: a 1,1,2 vblank pattern at 90 fails it.
 * @param {number} rate
 * @param {Batch} batch
 */
export function pacing(rate, {frames, elapsedMs, intervals}) {
  const measuredHz = round2(frames * 1000 / elapsedMs);
  const withinRate = Math.abs(measuredHz - rate) <= rate * PROBE.rateTolerance;
  const steady = Array.isArray(intervals) && intervals.length > 1 ? intervals.slice(1) : null;
  if (!steady) return {measuredHz, withinRate, intervals: null, verdict: withinRate ? 'rate-only' : 'off-rate'};

  const periodMs = 1000 / rate;
  /** @type {Record<string, number>} */
  const counts = {};
  for (const ms of steady) counts[Math.round(ms)] = (counts[Math.round(ms)] ?? 0) + 1;
  const even = steady.every(ms => Math.abs(ms - periodMs) <= PROBE.intervalSlackMs);
  const summary = {minMs: Math.min(...steady), maxMs: Math.max(...steady), counts};

  let verdict = 'off-rate';
  if (withinRate) verdict = even ? 'even' : 'uneven';
  return {measuredHz, withinRate, intervals: summary, verdict};
}

/**
 * @param {{controller: ReturnType<typeof createRefreshRate>,
 *   present: (frames: number, options?: {intervals?: boolean}) => Promise<Batch>,
 *   rates: number[], seconds?: number, log?: (event: object) => void}} options
 * @returns {Promise<RateResult[]>}
 */
export async function runRefreshRateProbe({controller, present, rates, seconds = 1, log = () => {}}) {
  const validRates = rates.length > 0 && rates.every(rate => Number.isInteger(rate) && rate >= 1 && rate <= 120);
  const framesOk = rates.every(rate => Math.round(rate * seconds) >= PROBE.confirmFrames &&
    Math.round(rate * seconds) <= 240);
  if (!validRates || !framesOk) throw Error('Probe rates must be 1-120 with 24-240 frames each');

  /** @type {RateResult[]} */
  const results = [];
  try {
    for (const rate of rates) {
      const result = await probeRate({controller, present, rate, seconds});
      results.push(result);
      log({event: 'refresh-rate-probe', ...result});
      if (result.verdict === 'error') break;
    }
  } finally {
    const final = await controller.restore('probe-end');
    log({event: 'refresh-rate-probe-end', restored: final.ok});
  }

  return results;
}

/**
 * One rate: raise and confirm, measure, read, restore. Any failure ends in `error`.
 * @param {{controller: ReturnType<typeof createRefreshRate>,
 *   present: (frames: number, options?: {intervals?: boolean}) => Promise<Batch>,
 *   rate: number, seconds: number}} options
 * @returns {Promise<RateResult>}
 */
async function probeRate({controller, present, rate, seconds}) {
  const before = await controller.read();
  /** @type {RateResult} */
  const result = {rate, verdict: 'error', flagsBefore: flagText(before.flags), flagsAfter: null};
  if (before.flags === null) return {...result, error: 'baseline read failed: ' + before.reason};

  const raising = rate > 60;
  try {
    const raiseError = raising ? await raiseAndConfirm(controller, present, rate) : '';
    if (raiseError) result.error = raiseError;
    else await measure(controller, present, rate, seconds, result);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  if (raising) result.restored = (await controller.restore('probe')).ok;
  if (result.error || result.restored === false)
    return {...result, verdict: 'error', error: result.error ?? 'restore failed'};
  return result;
}

/**
 * About `seconds` of presents with their intervals, then 354 while the panel is still raised.
 * @param {ReturnType<typeof createRefreshRate>} controller
 * @param {(frames: number, options?: {intervals?: boolean}) => Promise<Batch>} present
 * @param {number} rate
 * @param {number} seconds
 * @param {RateResult} result
 */
async function measure(controller, present, rate, seconds, result) {
  const batch = await present(Math.round(rate * seconds), {intervals: true});
  const after = await controller.read();

  Object.assign(result, {frames: batch.frames, elapsedMs: batch.elapsedMs, flagsAfter: flagText(after.flags),
    ...pacing(rate, batch)});
}

/**
 * The raise, then 24-frame batches until `measured` confirms it; the error text, or '' once
 * raised.
 * @param {ReturnType<typeof createRefreshRate>} controller
 * @param {(frames: number) => Promise<Batch>} present
 * @param {number} rate
 */
async function raiseAndConfirm(controller, present, rate) {
  const set = await controller.set(rate);
  if (!set.ok) return 'raise refused';

  for (let batch = 0; batch < PROBE.confirmBatches; batch++) {
    const state = await controller.measured(await present(PROBE.confirmFrames));
    if (state === 'raised') return '';
    if (state === 'failed') return 'raise unconfirmed';
  }
  return 'raise unconfirmed after ' + PROBE.confirmBatches + ' batches';
}
