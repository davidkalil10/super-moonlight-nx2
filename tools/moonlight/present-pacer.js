/**
 * Predicts the renderer's vsync so a staggered gate waiting for a publication to be applied
 * sleeps off the bridge instead of polling the status. The phase is learned from status reads:
 * a read that finds the publication applied right after one that did not brackets a vsync.
 * While reads keep succeeding on the first try the phase is pulled earlier by driftMs, so a late
 * estimate does not add latency for long.
 *
 * windowMs must cover marginMs plus one status read, or a slightly early estimate sleeps a whole
 * frame (request-budget.cjs staggeredHostWait).
 */

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

  const nextVsync = at => phase + Math.ceil((at - phase) / periodMs) * periodMs;
  const sleepUntil = async at => {
    const ms = at - now();
    if (ms > 0) await sleep(ms);
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
      if (phase === null || openedAt === null || openedAt === undefined) return;
      const due = nextVsync(openedAt) + marginMs;
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
        missed = true;
        return;
      }
      if (missed) phase = startedAt;
      else if (predicted) phase -= driftMs;
      missed = false;
      predicted = false;
    },

    /**
     * A read found the publication not applied yet. Just after a predicted vsync the estimate
     * is probably a little early, so this polls shortly; otherwise it sleeps to the next one.
     */
    async pending() {
      const at = now();
      if (phase === null) return sleep(pollMs);
      if (at - (nextVsync(at) - periodMs) < windowMs) return sleep(pollMs);
      await sleepUntil(nextVsync(at) + marginMs);
    },

    /** @returns {number | null} */
    get phase() {
      return phase;
    }
  };
}

export {create};
