/**
 * Predicts the renderer's vsync so a staggered gate waiting for a publication to be applied
 * sleeps off the bridge instead of polling the status. The phase is learned from status reads:
 * a read that finds the publication applied right after one that did not brackets a vsync.
 * While reads keep succeeding on the first try the phase is pulled earlier by driftMs, so a late
 * estimate does not add latency for long.
 *
 * The period starts at periodMs, the display's refresh, but the console may apply only every
 * other refresh (a 1/60 s cadence on a 120 Hz panel). Then every second predicted read misses
 * and its hit comes one periodMs later; enough of those in a row of predicted reads and the
 * pacer moves to twice the period. On the long period one predicted read in PROBE_EVERY aims at
 * the midpoint instead; MID_HITS hits there in a row bring the short period back.
 *
 * windowMs must cover marginMs plus one status read, or a slightly early estimate sleeps a whole
 * frame (request-budget.cjs staggeredHostWait).
 */

/** Predicted first reads remembered for the half-period test. */
const HALF_WINDOW = 16;
/** Half-period misses among them that move the pacer to the long period. */
const HALF_MISSES = 6;
/** On the long period, one predicted read in this many with a midpoint ahead probes it. */
const PROBE_EVERY = 16;
/** Midpoint hits in a row that bring the short period back. */
const MID_HITS = 4;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {object} [options]
 * @param {number} [options.periodMs] display refresh period
 * @param {number} [options.marginMs] how long after the predicted vsync to read
 * @param {number} [options.pollMs] short sleep when the prediction is in doubt
 * @param {number} [options.windowMs] how long after a predicted vsync to keep polling
 * @param {number} [options.driftMs] how far each first-try success pulls the phase earlier
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<unknown>} [options.sleep]
 */
function create({
  periodMs = 1000 / 60,
  marginMs = 1,
  pollMs = 2,
  windowMs = 5,
  driftMs = 0.1,
  now = Date.now,
  sleep = delay
} = {}) {
  /** Time of a past vsync, or null until one has been bracketed. */
  let phase = null;
  /** A read since the last success found the publication not applied. */
  let missed = false;
  /** The last beforeRead slept until a predicted vsync. */
  let predicted = false;
  /** Refresh periods per apply: 1, or 2 once the console is seen applying every other one. */
  let grid = 1;
  /** Start of the first missing read of a predicted gate. */
  let missAt = null;
  /** Whether each recent predicted gate missed by half a long period. */
  let halfMisses = [];
  /** Predicted reads on the long period, for the midpoint probe. */
  let probes = 0;
  /** The current gate's predicted read aims at the midpoint. */
  let probing = false;
  /** Midpoint probes that found the publication applied, in a row. */
  let midHits = 0;
  /** A vsync bracketed within one poll, which the drift never moves; the probe's reference. */
  let bracketed = null;
  /** Start of the latest read that found the publication not applied. */
  let lastMissAt = null;

  const period = () => grid * periodMs;
  const nextVsync = at => phase + Math.ceil((at - phase) / period()) * period();
  const anchor = at => {
    phase = at;
    if (at - lastMissAt <= 2 * pollMs) bracketed = at;
  };
  const midpointAfter = at =>
    bracketed === null
      ? null
      : bracketed + Math.ceil((at - bracketed) / period()) * period() - periodMs;
  const sleepUntil = async at => {
    const ms = at - now();
    if (ms > 0) await sleep(ms);
  };
  const remember = half => {
    halfMisses.push(half);
    if (halfMisses.length > HALF_WINDOW) halfMisses.shift();
    if (grid === 1 && halfMisses.filter(Boolean).length >= HALF_MISSES) {
      grid = 2;
      halfMisses = [];
    }
  };

  return {
    /**
     * Before the first status read of a gate: waits for the vsync that applies a publication
     * whose fetch the host opened at openedAt.
     * @param {number | null | undefined} openedAt
     */
    async beforeRead(openedAt) {
      missed = false;
      predicted = false;
      probing = false;
      missAt = null;
      if (phase === null || openedAt === null || openedAt === undefined) return;
      let due = nextVsync(openedAt) + marginMs;
      const midpoint = grid === 2 ? midpointAfter(openedAt) : null;
      if (midpoint !== null && midpoint > openedAt && ++probes % PROBE_EVERY === 0) {
        due = midpoint + marginMs;
        probing = true;
      }
      if (due <= now()) return;
      predicted = true;
      await sleepUntil(due);
    },

    /**
     * After each read that checked the publication, with the time the read started.
     * @param {number} startedAt
     * @param {boolean} applied
     */
    observe(startedAt, applied) {
      if (!applied) {
        if (!missed && predicted) missAt = startedAt;
        missed = true;
        lastMissAt = startedAt;
        return;
      }
      if (probing) {
        midHits = missed ? 0 : midHits + 1;
        if (missed) anchor(startedAt);
        if (midHits >= MID_HITS) {
          grid = 1;
          midHits = 0;
          phase = startedAt;
        }
      } else if (missed) {
        anchor(startedAt);
        if (missAt !== null) {
          const late = (startedAt - missAt) / periodMs;
          remember(late >= 0.75 && late <= 1.25);
        }
      } else if (predicted) {
        phase -= driftMs;
        remember(false);
      }
      missed = false;
      predicted = false;
      probing = false;
      missAt = null;
    },

    /**
     * A read found the publication not applied yet. Just after a predicted vsync the estimate
     * is probably a little early, so this polls shortly; otherwise it sleeps to the next one.
     */
    async pending() {
      const at = now();
      if (phase === null) return sleep(pollMs);
      if (at - (nextVsync(at) - period()) < windowMs) return sleep(pollMs);
      await sleepUntil(nextVsync(at) + marginMs);
    },

    /** @returns {number | null} */
    get phase() {
      return phase;
    },

    /** The period applies are expected on: the refresh, or twice it. */
    get periodMs() {
      return period();
    }
  };
}

export {create};
