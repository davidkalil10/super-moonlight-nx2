/**
 * The --surface-check probe: hashes a sample of every Kth published surface once its fetch has
 * checked, then again before the decoder writes that surface next (lag0-re.md, Q1).
 */
const SAMPLE_BYTES = 512;

/**
 * FNV-1a, as 8 hex digits.
 * @param {Buffer} bytes
 */
function hash(bytes) {
  let value = 0x811c9dc5;
  for (const byte of bytes) value = Math.imul(value ^ byte, 0x01000193) >>> 0;
  return value.toString(16).padStart(8, '0');
}

/**
 * The middle of the last luma row, the last luma a top-down copy writes.
 * @param {{width: number, height: number, stride: number}} frame
 */
function sampleSpan({width, height, stride}) {
  const bytes = Math.min(SAMPLE_BYTES, width);
  return {offset: (height - 1) * stride + Math.floor((width - bytes) / 2), bytes};
}

/**
 * @param {{every: number,
 *   read: (index: number, offset: number, bytes: number) => Promise<Buffer>}} options
 */
function create({every, read}) {
  /** @type {{offset: number, bytes: number} | null} */
  let span = null;
  /** @type {Map<number, {seq: number, surface: number, hash: string}>} */
  const stash = new Map();
  /** @type {any[]} */
  let samples = [];
  const counts = {every, sampled: 0, rereads: 0, torn: 0};
  return {
    /** @param {{width: number, height: number, stride: number}} frame */
    start(frame) {
      span = sampleSpan(frame);
    },

    /**
     * First read of output `sequence`, after the gate that checked its fetch opened.
     * @param {number} sequence
     * @param {{index: number, skip?: boolean} | undefined} destination
     */
    async first(sequence, destination) {
      if (!span || sequence % every || !destination || destination.skip) return;
      const value = hash(await read(destination.index, span.offset, span.bytes));
      stash.set(destination.index, {seq: sequence, surface: destination.index, hash: value});
      counts.sampled++;
    },

    /**
     * Re-read of the sample on `destination` before the gate that refills it opens.
     * @param {{index: number} | null} destination
     */
    async reuse(destination) {
      const entry = destination && span && stash.get(destination.index);
      if (!entry || !span) return;
      stash.delete(entry.surface);
      const reread = hash(await read(entry.surface, span.offset, span.bytes));
      const torn = reread !== entry.hash;
      counts.rereads++;
      if (torn) counts.torn++;
      samples.push({...entry, reread, torn});
    },

    /** The re-read samples since the last call, for a stats row. */
    take() {
      const taken = samples;
      samples = [];
      return taken;
    },

    get counts() {
      return {...counts, pending: stash.size, ...span};
    }
  };
}

export {create, hash, sampleSpan, SAMPLE_BYTES};
