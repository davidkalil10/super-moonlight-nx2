/**
 * PC-side estimate of the console clock (payload.js `time`): NTP-style pings, offset bounded by
 * every sample, re-synced on an interval. Method in README.md, "Latency".
 */

/** Assumed worst relative drift between the two clocks, for aging an old estimate. */
const DRIFT = 1e-4;

/**
 * @typedef {{sent: number, remote: number, received: number}} ClockSample
 *   PC send and receive times around one ping and the console's reply, all in ms.
 * @typedef {{offsetMs: number, uncertaintyMs: number, rttMs: number, at: number}} ClockEstimate
 *   console time = PC time + offsetMs, within ±uncertaintyMs, measured at PC time `at`.
 */

export const pcNow = () => performance.timeOrigin + performance.now();

/**
 * Each sample bounds the offset to [remote - received, remote - sent] whatever the delay split,
 * so the estimate is the intersection of all bounds. Disjoint bounds (a clock step or drift
 * within the burst) fall back to the lowest-RTT sample.
 * @param {ClockSample[]} samples
 * @returns {ClockEstimate | null}
 */
export function estimateOffset(samples) {
  const valid = samples.filter(sample => sample.received >= sample.sent);
  if (!valid.length) return null;

  const best = valid.reduce((a, b) => (b.received - b.sent < a.received - a.sent ? b : a));
  const rttMs = best.received - best.sent;
  const at = Math.max(...valid.map(sample => sample.received));

  const low = Math.max(...valid.map(sample => sample.remote - sample.received));
  const high = Math.min(...valid.map(sample => sample.remote - sample.sent));
  if (low <= high) return {offsetMs: (low + high) / 2, uncertaintyMs: (high - low) / 2, rttMs, at};

  return {offsetMs: best.remote - (best.sent + best.received) / 2, uncertaintyMs: rttMs / 2, rttMs, at};
}

/**
 * An estimate's uncertainty grows with its age by the drift bound.
 * @param {ClockEstimate} estimate
 * @param {number} at
 */
export function agedUncertainty(estimate, at) {
  return estimate.uncertaintyMs + Math.max(0, at - estimate.at) * DRIFT;
}

/**
 * A fresh burst replaces the current estimate unless it is looser than the current one has
 * become with age, so one burst caught in a stall does not undo a good sync.
 * @param {ClockEstimate | null} current
 * @param {ClockEstimate | null} next
 */
export function chooseEstimate(current, next) {
  if (!next) return current;
  if (!current) return next;

  if (next.uncertaintyMs <= agedUncertainty(current, next.at)) return next;
  return current;
}

/**
 * @param {{request: () => Promise<number>, now?: () => number, pings?: number,
 *   intervalMs?: number, onSync?: (estimate: ClockEstimate) => void,
 *   onError?: (error: Error) => void}} options
 *   request resolves to the console's clock in ms.
 */
export function createClockSync({request, now = pcNow, pings = 5, intervalMs = 5000,
  onSync = estimate => {}, onError = error => {}}) {
  /** @type {ClockEstimate | null} */
  let current = null;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  let running = false;
  let syncs = 0;

  async function sync() {
    const samples = [];
    for (let index = 0; index < pings; index++) {
      const sent = now();
      const remote = await request();
      const received = now();
      if (!Number.isFinite(remote)) throw Error('Invalid console time');
      samples.push({sent, remote, received});
    }

    current = chooseEstimate(current, estimateOffset(samples));
    syncs++;
    if (current) onSync(current);
    return current;
  }

  async function loop() {
    try {
      await sync();
    } catch (error) {
      onError(/** @type {Error} */ (error));
    }
    if (!running) return;

    timer = setTimeout(loop, intervalMs);
    timer.unref?.();
  }

  return {
    sync,
    start() {
      if (running) return;
      running = true;
      loop();
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
    get syncs() { return syncs; },
    /**
     * The current estimate with its uncertainty aged to `at`, or null before the first sync.
     * @param {number} [at]
     * @returns {ClockEstimate | null}
     */
    estimate(at = now()) {
      if (!current) return null;
      return {...current, uncertaintyMs: agedUncertainty(current, at)};
    }
  };
}
