/**
 * The PC queue between the helper's access units and the video channel: waits while the window
 * is full, latest-wins only across keyframes; README.md, "Send window".
 */

/** @typedef {import('../session/h264-stream.js').AccessUnit} AccessUnit */
/** @typedef {'superseded' | 'queue-age' | 'queue-full' | 'awaiting-idr' | 'udp-loss'} DropReason */

/**
 * Whether u32 sequence `a` came after `b`.
 * @param {number} a
 * @param {number} b
 */
const after = (a, b) => {
  const distance = (a - b) >>> 0;
  return distance !== 0 && distance < 0x80000000;
};

/**
 * Drains `source` as fast as it delivers so the helper's pipe never blocks. A queue whose oldest
 * unit waited over its age limit (or that holds over `maxUnits`) drops everything up to the next
 * keyframe and asks for one, at most once per `idrIntervalMs`; inside that interval it keeps the
 * units (`held`). Over `hardUnits` it always drops. A keyframe is never dropped for a limit: one
 * queued or in flight suspends the limits, and past `hardUnits` the queue asks for a fresh one
 * to supersede it. A request is repeated only when no keyframe answered it in `idrRetryMs`.
 * Units age from the keyframe's ack at the earliest. The age limit is the median age of the last
 * second's sent units plus two periods, kept between `maxAgeMs` and twice that; README.md,
 * "Send window".
 * @param {{source: {next(): Promise<{value?: AccessUnit, done?: boolean}>}, fps: number,
 *   onIdrRequest: (reason: DropReason) => void, now?: () => number, maxAgeMs?: number,
 *   maxUnits?: number, hardUnits?: number, idrIntervalMs?: number, idrRetryMs?: number}} options
 */
export function createVideoQueue({source, fps, onIdrRequest, now = Date.now,
  maxAgeMs = Math.max(6000 / fps, 50), maxUnits = Math.max(4, Math.ceil(fps / 8)),
  hardUnits = Math.max(2 * maxUnits, Math.ceil(fps / 4)), idrIntervalMs = 2000, idrRetryMs = 500}) {
  /** @type {{unit: AccessUnit, at: number}[]} */
  const units = [];
  /** @type {number[]} */
  const sentAges = [];
  const periodMs = 1000 / fps;
  let held = 0;
  /** @type {Record<string, number>} */
  let drops = {};
  /** @type {Record<string, number>} */
  let idrs = {};
  let dropped = 0;
  let idrRequests = 0;
  let lastDrop = -Infinity;
  let requestedAt = -Infinity;
  let unanswered = false;
  let dropping = false;
  let ended = false;
  /** @type {unknown} */
  let failure = null;
  /** @type {number | null} */
  let keyframeInFlight = null;
  let keyframeAckedAt = -Infinity;
  /** @type {(() => void) | null} */
  let waiter = null;

  function wake() {
    waiter?.();
    waiter = null;
  }

  /**
   * @param {number} count
   * @param {DropReason} reason
   */
  function drop(count, reason) {
    if (!count) return;

    dropped += count;
    drops[reason] = (drops[reason] ?? 0) + count;
  }

  /**
   * Asks for an IDR unless one asked under `idrRetryMs` ago is still unanswered.
   * @param {DropReason} reason
   */
  function requestIdr(reason) {
    const at = now();
    if (unanswered && at - requestedAt < idrRetryMs) return;

    requestedAt = at;
    unanswered = true;
    idrRequests++;
    idrs[reason] = (idrs[reason] ?? 0) + 1;
    onIdrRequest(reason);
  }

  /** @param {DropReason} reason */
  function dropToKeyframe(reason) {
    drop(units.splice(0).length, reason);
    dropping = true;
    lastDrop = now();
    requestIdr(reason);
  }

  const keyed = () => keyframeInFlight !== null || Boolean(units[0]?.unit.keyframe);

  /**
   * @param {number} at
   * @returns {DropReason | null}
   */
  function overdue(at) {
    if (units.length > maxUnits) return 'queue-full';

    const waitingSince = Math.max(units[0].at, keyframeAckedAt);
    return at - waitingSince > ageLimit() ? 'queue-age' : null;
  }

  function ageLimit() {
    if (!sentAges.length) return maxAgeMs;

    const sorted = [...sentAges].sort((a, b) => a - b);
    const steady = sorted[Math.floor(sorted.length / 2)];
    return Math.min(Math.max(maxAgeMs, steady + 2 * periodMs), 2 * maxAgeMs);
  }

  /** @param {{unit: AccessUnit, at: number}} entry */
  function sentAge(entry) {
    if (keyframeInFlight !== null || entry.unit.keyframe) return;

    sentAges.push(now() - Math.max(entry.at, keyframeAckedAt));
    if (sentAges.length > fps) sentAges.shift();
  }

  /** @param {number} at */
  function enforceLimits(at) {
    const full = units.length > hardUnits;
    if (keyed()) {
      if (full) requestIdr('queue-full');
      return;
    }

    const reason = full ? 'queue-full' : overdue(at);
    if (!reason) return;

    if (!full && at - lastDrop < idrIntervalMs) {
      held++;
      return;
    }
    dropToKeyframe(reason);
  }

  /** @param {AccessUnit} unit */
  function push(unit) {
    if (unit.keyframe) {
      dropping = false;
      unanswered = false;
      drop(units.splice(0).length, 'superseded');
    } else if (dropping) {
      drop(1, 'awaiting-idr');
      requestIdr('awaiting-idr');
      return;
    }

    const at = now();
    units.push({unit, at});
    enforceLimits(at);
    wake();
  }

  async function pull() {
    try {
      for (;;) {
        const next = await source.next();
        if (next.done || !next.value) break;
        push(next.value);
      }
    } catch (error) {
      failure = error;
    }
    ended = true;
    wake();
  }
  pull();

  return {
    /** @returns {Promise<{value: AccessUnit, done: false} | {value?: undefined, done: true}>} */
    async next() {
      for (;;) {
        if (failure) throw failure;
        const entry = units.shift();
        if (entry) {
          sentAge(entry);
          if (entry.unit.keyframe) keyframeInFlight = entry.unit.seq >>> 0;
          return {value: entry.unit, done: false};
        }
        if (ended) return {done: true};
        await new Promise(resolve => { waiter = () => resolve(undefined); });
      }
    },
    /** @param {number} sequence the u32 sequence the console acknowledged */
    acknowledged(sequence) {
      if (sequence !== keyframeInFlight) return;

      keyframeInFlight = null;
      keyframeAckedAt = now();
    },
    /**
     * The console dropped this unit over UDP, so the decoder waits for a keyframe: unless one is
     * queued or was sent after it, drop to the next keyframe and ask for one (README.md, "UDP
     * transport"). A keyframe never drops here; units queued before one do.
     * @param {number} sequence the unit's u32 sequence
     */
    lost(sequence) {
      if (sequence === keyframeInFlight) keyframeInFlight = null;

      const keyIndex = units.findIndex(entry => entry.unit.keyframe);
      if (keyIndex >= 0) {
        drop(units.splice(0, keyIndex).length, 'udp-loss');
        return;
      }
      const answered = keyframeInFlight !== null && after(keyframeInFlight, sequence);
      if (answered) return;

      drop(units.splice(0).length, 'udp-loss');
      dropping = true;
      requestIdr('udp-loss');
    },
    get dropped() { return dropped; },
    get idrRequests() { return idrRequests; },
    get length() { return units.length; },
    /** Drops and IDR requests by reason, and units held past a limit, since the last call. */
    take() {
      const taken = {drops, idrs, held};
      drops = {};
      idrs = {};
      held = 0;
      return taken;
    }
  };
}
