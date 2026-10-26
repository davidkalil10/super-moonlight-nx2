/**
 * Predicts when the console has received a unit, so a staggered gate whose receive is pending
 * sleeps off the bridge instead of rereading the status back to back. The console starts
 * receiving unit N+1 when gate N opens and the host sends it right after, so a unit is
 * predicted received at its send plus a base plus its size times a per-kilobyte estimate. A
 * read past the prediction that still finds the receive pending grows the estimate by growMs
 * for that unit's size; a read that slept and then saw the receive shrinks it by shrinkMs, so
 * a faster link still shows. A gate's first read waits only while the link is bound, that is,
 * the previous gate found its receive pending, so a gate whose receive keeps up reads at once
 * (request-budget.cjs receiveWait).
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {object} [options]
 * @param {number} [options.baseMs] receive latency independent of the size
 * @param {number} [options.startPerKbMs] first per-kilobyte estimate
 * @param {number} [options.growMs] added to a unit's prediction when a read past it finds
 *   the receive pending
 * @param {number} [options.shrinkMs] taken off when a read that slept finds it received
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<unknown>} [options.sleep]
 */
function create({
  baseMs = 1,
  startPerKbMs = 0.2,
  growMs = 0.5,
  shrinkMs = 0.1,
  now = Date.now,
  sleep = delay
} = {}) {
  /** @type {Map<number, {at: number, kb: number}>} */
  const sends = new Map();
  let perKbMs = startPerKbMs;
  let bound = false;

  /** @param {number} unit */
  const predicted = unit => {
    const send = /** @type {{at: number, kb: number}} */ (sends.get(unit));
    return send.at + baseMs + send.kb * perKbMs;
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
      if (!(pending || bound) || !sends.has(unit)) return false;
      const start = predicted(unit) - readMs;
      if (start <= now()) return false;
      await sleep(start - now());
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
        if (at >= predicted(unit)) perKbMs += growMs / send.kb;
        return;
      }
      if (waited) perKbMs = Math.max(0, perKbMs - shrinkMs / send.kb);
      bound = waited || pendingSeen;
    },
    get perKbMs() {
      return perKbMs;
    }
  };
}

export {create};
