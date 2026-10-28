/**
 * Bins the cost of each staggered exchange by when it started relative to the frame events
 * the host knows, per exchange kind and reference, over -windowMs..windowMs.
 */

const KINDS = ['status', 'gate'];
const REFERENCES = ['gate', 'send', 'decodeDone', 'receiveDone'];

/** @typedef {{n: number, ms: number}} Bin */
/** @typedef {{exchanges: number, ms: number, offsets: Record<string, Record<string, Bin>>}} KindCounts */

/** @param {number} ms */
const round2 = ms => +ms.toFixed(2);

/**
 * @param {Record<string, Bin>} bins
 * @returns {Record<string, Bin>}
 */
function roundedBins(bins) {
  return Object.fromEntries(
    Object.entries(bins).map(([offset, bin]) => [offset, {n: bin.n, ms: round2(bin.ms)}])
  );
}

/**
 * @param {KindCounts} counts
 * @returns {KindCounts}
 */
function roundedCounts(counts) {
  return {
    exchanges: counts.exchanges,
    ms: round2(counts.ms),
    offsets: Object.fromEntries(
      Object.entries(counts.offsets).map(([name, bins]) => [name, roundedBins(bins)])
    )
  };
}

/**
 * @param {{binMs?: number, windowMs?: number}} [options]
 */
function create({binMs = 1, windowMs = 10} = {}) {
  /** @type {Record<string, KindCounts>} */
  let kinds = {};
  const reset = () => {
    kinds = Object.fromEntries(KINDS.map(kind => [kind, {exchanges: 0, ms: 0, offsets: {}}]));
  };
  reset();

  /** @param {number} offset */
  const label = offset => {
    if (offset < -windowMs) return '<';
    if (offset >= windowMs) return '>';
    return String(Math.floor(offset / binMs) * binMs);
  };

  return {
    /**
     * One exchange of `kind` that ran from `startedAt` to `endedAt`.
     * @param {string} kind
     * @param {number} startedAt
     * @param {number} endedAt
     * @param {Partial<Record<string, number | null | undefined>>} references Event times.
     */
    record(kind, startedAt, endedAt, references) {
      const counts = kinds[kind];
      if (!counts) throw Error('Unknown exchange kind ' + kind);

      const ms = endedAt - startedAt;
      counts.exchanges++;
      counts.ms += ms;

      for (const name of REFERENCES) {
        const at = references[name];
        if (typeof at !== 'number') continue;

        const bins = (counts.offsets[name] ||= {});
        const bin = (bins[label(startedAt - at)] ||= {n: 0, ms: 0});
        bin.n++;
        bin.ms += ms;
      }
    },

    /** The counts so far, milliseconds rounded to two decimals. */
    get counts() {
      return Object.fromEntries(
        Object.entries(kinds).map(([kind, counts]) => [kind, roundedCounts(counts)])
      );
    },

    reset
  };
}

/**
 * Where a status read must not start: within beforeMs before or afterMs after a predicted
 * event; such a read is delayed to afterMs past the event.
 * @param {number} at When the read would start.
 * @param {(number | null | undefined)[]} events Predicted event times.
 * @param {{beforeMs: number, afterMs: number} | null | undefined} avoid
 * @returns {number} How long to delay, 0 when the read may start.
 */
function delayFor(at, events, avoid) {
  if (!avoid) return 0;

  const known = events.filter(event => typeof event === 'number').sort((a, b) => a - b);
  let until = at;
  let moved = true;
  while (moved) {
    moved = false;
    for (const event of known) {
      const inWindow = until >= event - avoid.beforeMs && until < event + avoid.afterMs;
      if (!inWindow) continue;

      until = event + avoid.afterMs;
      moved = true;
    }
  }

  return until - at;
}

/**
 * Parses `before-after` milliseconds, as --avoid-window takes them.
 * @param {string | undefined} text
 * @returns {{beforeMs: number, afterMs: number} | null}
 */
function parseAvoid(text) {
  if (text === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) throw Error('--avoid-window takes <beforeMs>-<afterMs>');
  return {beforeMs: Number(match[1]), afterMs: Number(match[2])};
}

export {KINDS, REFERENCES, create, delayFor, parseAvoid};
