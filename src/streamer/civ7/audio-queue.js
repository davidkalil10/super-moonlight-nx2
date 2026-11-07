// Audio pacing policy: the console jitter queue and crossfade (shipped by toString, so each is
// self-contained), the PC safety cap and its pending queue. Policy: civ7/README.md, Audio.

/**
 * Received chunks wait here until AudioOut has room. AudioOut never holds more than `outputMs`,
 * so the rest of the depth stays droppable: above `burstMs` it is cut to `targetMs` at once, and
 * a depth that never fell to `targetMs` within `windowMs` is cut by that standing excess.
 * @template T
 * @param {{chunkMs: number, targetMs: number, burstMs: number, windowMs: number, outputMs: number}} policy
 */
export function createJitterQueue({chunkMs, targetMs, burstMs, windowMs, outputMs}) {
  /** @type {T[]} */
  const waiting = [];
  let output = 0;
  let windowStarted = -1;
  let windowLowest = Infinity;
  const stats = {dropped: 0, cuts: 0, depthMs: 0, maxDepthMs: 0};

  const depth = () => (waiting.length + output) * chunkMs;

  /** @param {number} limitMs */
  function dropTo(limitMs) {
    const excess = Math.floor((depth() - limitMs) / chunkMs);
    const count = Math.min(Math.max(excess, 0), waiting.length);
    if (count) {
      stats.dropped += count;
      stats.cuts++;
    }
    return waiting.splice(0, count);
  }

  /** @param {number} now */
  function restartWindow(now) {
    windowStarted = now;
    windowLowest = Infinity;
  }

  return {
    stats,
    get waiting() { return waiting.length; },
    get output() { return output; },

    /** @param {T} chunk */
    push(chunk) { waiting.push(chunk); },

    release() {
      if (output < 1) throw Error('Audio queue released more than it appended');
      output--;
    },

    /**
     * @param {number} now milliseconds
     * @returns {{dropped: T[], appended: T[]}} oldest first
     */
    step(now) {
      const current = depth();
      stats.depthMs = current;
      stats.maxDepthMs = Math.max(stats.maxDepthMs, current);
      if (windowStarted < 0) restartWindow(now);
      windowLowest = Math.min(windowLowest, current);

      /** @type {T[]} */
      let dropped = [];
      if (current > burstMs) {
        dropped = dropTo(targetMs);
        restartWindow(now);
      } else if (now - windowStarted >= windowMs) {
        const standing = windowLowest - targetMs;
        if (standing > 0) dropped = dropTo(current - standing);
        restartWindow(now);
      }

      const appended = [];
      while (waiting.length && (output + 1) * chunkMs <= outputMs) {
        appended.push(/** @type {T} */ (waiting.shift()));
        output++;
      }

      stats.depthMs = depth();
      return {dropped, appended};
    }
  };
}

/**
 * Linear crossfade over the first `frames` frames of `to`, starting from `from`, the audio the
 * cut removed. Both are little-endian 16-bit PCM; returns a new head for `to`.
 * @param {Uint8Array} from
 * @param {Uint8Array} to
 * @param {number} frames
 * @param {number} channels
 */
export function crossfadePcm(from, to, frames, channels) {
  const result = Uint8Array.from(to);
  const samples = Math.min(frames * channels, from.length >> 1, to.length >> 1);

  for (let index = 0; index < samples; index++) {
    const at = index * 2;
    const weight = (Math.floor(index / channels) + 1) / (frames + 1);
    const start = ((from[at] | (from[at + 1] << 8)) << 16) >> 16;
    const end = ((to[at] | (to[at + 1] << 8)) << 16) >> 16;
    const value = Math.round(start + (end - start) * weight);
    result[at] = value & 255;
    result[at + 1] = (value >> 8) & 255;
  }
  return result;
}

/**
 * Whole chunks the PC drops from the oldest end once `queued` passes `capBytes`. It is only a
 * safety cap for a console that stops acknowledging; pacing is the console's.
 * @param {number} queued
 * @param {number} capBytes
 * @param {number} chunkBytes
 */
export function pendingExcess(queued, capBytes, chunkBytes) {
  if (queued <= capBytes) return 0;

  const chunks = Math.ceil((queued - capBytes) / chunkBytes);
  return Math.min(chunks, Math.floor(queued / chunkBytes)) * chunkBytes;
}

/**
 * Send-to-acknowledgement times over the last `spanMs`, for the per-second telemetry.
 * @param {number} [spanMs]
 */
export function createReleaseTimes(spanMs = 1000) {
  /** @type {{at: number, ms: number}[]} */
  const samples = [];
  let total = 0;

  /** @param {number} now */
  function prune(now) {
    while (samples.length && now - samples[0].at > spanMs) samples.shift();
  }

  return {
    /** @param {number} ms @param {number} now */
    add(ms, now) {
      samples.push({at: now, ms});
      total++;
      prune(now);
    },

    /** @param {number} now */
    summary(now) {
      prune(now);
      const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
      const max = sorted.length ? sorted[sorted.length - 1] : 0;
      return {count: sorted.length, p50Ms: median, maxMs: max, total};
    }
  };
}

/** The PC's pending PCM: Buffers in arrival order, pulled and dropped by byte count. */
export class ByteQueue {
  constructor() {
    /** @type {Buffer[]} */
    this.chunks = [];
    this.bytes = 0;
  }

  /** @param {Buffer} buf */
  push(buf) {
    if (buf.length) {
      this.chunks.push(buf);
      this.bytes += buf.length;
    }
  }

  /**
   * Removes the oldest `n` bytes, which must be queued.
   * @param {number} n
   * @returns {Buffer}
   */
  pull(n) {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - filled);
      head.copy(out, filled, 0, take);
      filled += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }

    this.bytes -= n;
    return out;
  }

  /**
   * Discards up to `n` of the oldest bytes.
   * @param {number} n
   * @returns {number} The bytes dropped.
   */
  dropOldest(n) {
    const target = Math.min(n, this.bytes);
    let dropped = 0;
    while (dropped < target) {
      const head = this.chunks[0];
      const take = Math.min(head.length, target - dropped);
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
      dropped += take;
    }

    this.bytes -= dropped;
    return dropped;
  }
}
