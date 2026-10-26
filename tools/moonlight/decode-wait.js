/**
 * Predicts when the decoder acquires a unit, so a staggered gate whose acquire is pending
 * sleeps off the bridge instead of rereading the status back to back. The host has no
 * console timestamps: a unit is predicted done at max(its gate, the previous unit done) plus
 * a decode estimate, and a unit is taken as done at the earlier of its prediction and the
 * read that saw it. A read past the prediction that still finds the acquire pending grows
 * the estimate by growMs; a read that slept and then saw the acquire shrinks it by shrinkMs,
 * so a faster decoder still shows. A gate's first read waits only while decode is bound,
 * that is, the previous gate found its acquire pending, so a gate whose decode keeps up
 * reads at once (request-budget.cjs staggeredDecodeWait).
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {object} [options]
 * @param {number} [options.startMs] first decode estimate
 * @param {number} [options.growMs] added when a read past the prediction finds it pending
 * @param {number} [options.shrinkMs] taken off when a read that slept finds it acquired
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<unknown>} [options.sleep]
 */
function create({startMs = 6, growMs = 0.5, shrinkMs = 0.1, now = Date.now, sleep = delay} = {}) {
  /** @type {Map<number, number>} */
  const gates = new Map();
  /** @type {Map<number, number>} */
  const done = new Map();
  let estimate = startMs;
  let bound = false;

  /** @param {number} unit */
  const predicted = unit =>
    Math.max(/** @type {number} */ (gates.get(unit)), done.get(unit - 1) ?? 0) + estimate;

  return {
    /**
     * When the gate that submits `unit` opened.
     * @param {number} unit
     * @param {number} [at]
     */
    opened(unit, at = now()) {
      gates.set(unit, at);
      gates.delete(unit - 4);
      done.delete(unit - 4);
    },
    /**
     * Before a status read that expects `unit` acquired. `pending` says an earlier read of
     * this gate found it pending; `readMs` is how long a status read takes.
     * @param {number} unit
     * @param {boolean} pending
     * @param {number} readMs
     * @returns {Promise<boolean>} whether it slept
     */
    async beforeRead(unit, pending, readMs) {
      if (!(pending || bound) || !gates.has(unit)) return false;
      const start = predicted(unit) - readMs;
      if (start <= now()) return false;
      await sleep(start - now());
      return true;
    },
    /**
     * After that read ended at `at`. `pendingSeen` says an earlier read of this gate found
     * the acquire pending.
     * @param {number} unit
     * @param {number} at
     * @param {boolean} acquired
     * @param {{waited?: boolean, pendingSeen?: boolean}} [seen]
     */
    observe(unit, at, acquired, {waited = false, pendingSeen = false} = {}) {
      if (!gates.has(unit)) return;
      if (!acquired) {
        if (at >= predicted(unit)) estimate += growMs;
        return;
      }
      done.set(unit, Math.min(predicted(unit), at));
      if (waited) estimate = Math.max(0, estimate - shrinkMs);
      bound = waited || pendingSeen;
    },
    /**
     * When `unit` is predicted acquired, or null before its gate.
     * @param {number} unit
     */
    predictedAt(unit) {
      return gates.has(unit) ? predicted(unit) : null;
    },
    get estimateMs() {
      return estimate;
    }
  };
}

export {create};
