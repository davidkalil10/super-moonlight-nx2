/**
 * The video channel's in-flight window, sized each second from the ack round trip; README.md,
 * "Send window".
 */
import {summarize} from './latency.js';

export const WINDOW = {min: 2, max: 8, assumedRttMs: 30, holdSeconds: 5};

/**
 * Units in flight that cover a round trip: one per frame period it lasts, plus the one acked.
 * @param {number} rttMs
 * @param {number} fps
 */
export function windowFor(rttMs, fps) {
  const periods = Math.ceil(rttMs * fps / 1000);

  return Math.min(Math.max(periods + 1, WINDOW.min), WINDOW.max);
}

/**
 * @typedef {{size: number, need: number | null, rttP90Ms: number | null, samples: number,
 *   reason: 'initial' | 'few-samples' | 'grow' | 'steady' | 'hold' | 'shrink'}} WindowReport
 */

/**
 * Grows as soon as a second's ack p90 needs more units and shrinks only to the largest need of
 * the last `holdSeconds`, so one quiet second cannot cut it under the steady need.
 * @param {{fps: number, minSamples?: number}} options
 */
export function createSendWindow({fps, minSamples = Math.max(4, Math.round(fps / 10))}) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 240) throw Error('Invalid send window rate');

  /** @type {number[]} */
  const samples = [];
  const initial = windowFor(WINDOW.assumedRttMs, fps);
  const needs = [initial];
  /** @type {WindowReport} */
  let report = {size: initial, need: null, rttP90Ms: null, samples: 0, reason: 'initial'};

  /** @param {number} need */
  function settle(need) {
    needs.push(need);
    if (needs.length > WINDOW.holdSeconds) needs.shift();

    const size = Math.max(...needs);
    if (size > report.size) return {size, reason: /** @type {const} */ ('grow')};
    if (size < report.size) return {size, reason: /** @type {const} */ ('shrink')};
    if (need < size) return {size, reason: /** @type {const} */ ('hold')};
    return {size, reason: /** @type {const} */ ('steady')};
  }

  return {
    get size() { return report.size; },
    /** @param {number} ackMs one acknowledgement's round trip */
    sample(ackMs) {
      if (Number.isFinite(ackMs) && ackMs >= 0) samples.push(ackMs);
    },
    /** Sizes the window from the samples since the last call; call once per second. */
    adapt() {
      const summary = summarize(samples);
      const count = samples.length;
      samples.length = 0;

      if (!summary || count < minSamples) {
        report = {...report, need: null, rttP90Ms: summary?.p90 ?? null, samples: count, reason: 'few-samples'};
        return report;
      }

      const need = windowFor(summary.p90, fps);
      report = {...settle(need), need, rttP90Ms: summary.p90, samples: count};
      return report;
    }
  };
}
