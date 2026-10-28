/**
 * Predicts when the console has received a unit, so a gate whose receive is pending sleeps off
 * the bridge instead of rereading back to back (request-budget.cjs receiveWait).
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {object} [options]
 * @param {number} [options.baseMs] first estimate of the latency independent of the size
 * @param {number} [options.perKbMs] link time per kilobyte
 * @param {number} [options.growMs] added to the estimate when a read past a prediction finds
 *   the receive pending
 * @param {number} [options.shrinkMs] taken off when a read that slept finds it received
 * @param {number} [options.maxSleepMs] the longest a read sleeps, and the estimate's ceiling
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<unknown>} [options.sleep]
 */
function create({
  baseMs = 1,
  perKbMs = 0.2,
  growMs = 0.5,
  shrinkMs = 0.1,
  maxSleepMs = 1000 / 60,
  now = Date.now,
  sleep = delay
} = {}) {
  /** @type {Map<number, {at: number, kb: number, grown?: boolean}>} */
  const sends = new Map();
  let fixedMs = Math.min(baseMs, maxSleepMs);
  let bound = false;

  /** @param {number} unit */
  const predicted = unit => {
    const send = /** @type {{at: number, kb: number, grown?: boolean}} */ (sends.get(unit));
    return send.at + fixedMs + send.kb * perKbMs;
  };

  return {
    /**
     * When `unit` of `bytes` went out on the transport.
     * @param {number} unit
     * @param {number} bytes
     * @param {number} [at]
     */
    sent(unit, bytes, at = now()) {
      sends.set(unit, {at, kb: Math.max(bytes, 1) / 1024});
      sends.delete(unit - 4);
    },
    /**
     * Before a status read that expects `unit` received. `pending` says an earlier read of
     * this gate found it pending; `readMs` is how long a status read takes.
     * @param {number} unit
     * @param {boolean} pending
     * @param {number} readMs
     * @returns {Promise<boolean>} whether it slept
     */
    async beforeRead(unit, pending, readMs) {
      if (!pending && !bound) return false;
      if (!sends.has(unit)) return false;

      const start = predicted(unit) - readMs;
      if (start <= now()) return false;
      await sleep(Math.min(start - now(), maxSleepMs));
      return true;
    },
    /**
     * After that read ended at `at`. `pendingSeen` says an earlier read of this gate found
     * the receive pending.
     * @param {number} unit
     * @param {number} at
     * @param {boolean} received
     * @param {{waited?: boolean, pendingSeen?: boolean}} [seen]
     */
    observe(unit, at, received, {waited = false, pendingSeen = false} = {}) {
      const send = sends.get(unit);
      if (!send) return;

      if (!received) {
        if (at >= predicted(unit) && !send.grown) {
          fixedMs = Math.min(maxSleepMs, fixedMs + growMs);
          send.grown = true;
        }
        return;
      }

      if (waited) fixedMs = Math.max(0, fixedMs - shrinkMs);
      bound = waited || pendingSeen;
    },
    /**
     * When `unit` is predicted received, or null before its send.
     * @param {number} unit
     */
    predictedAt(unit) {
      return sends.has(unit) ? predicted(unit) : null;
    },
    get fixedMs() {
      return fixedMs;
    }
  };
}

export {create};
