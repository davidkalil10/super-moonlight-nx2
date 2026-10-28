/**
 * How fresh the pad state is at each feeder read, from the STATE.frames counter the logic
 * shader bumps once per launcher frame. CLAUDE.md has how age is defined.
 */
import {STATE} from '../../../../hbl-platform/sdk/host/layout.js';

/** Rounds to one decimal. */
const tenths = value => Math.round(value * 10) / 10;

/**
 * @typedef {object} PadRow
 * @property {number} reads
 * @property {number} [readMeanMs]
 * @property {number} [readMaxMs]
 * @property {number} [stepMax] largest frame step between two reads
 * @property {number} [stalls] reads that found the same frame as the last one
 * @property {number} [gaps] reads that found the frame more than one step on
 * @property {number} [ageMeanMs]
 * @property {number} [ageMaxMs]
 */

/** @param {{periodMs?: number}} [options] */
function create({periodMs = 1000 / 60} = {}) {
  /** @type {number | null} */
  let last = null;
  /** @type {{readMs: number, step: number | null, offset: number}[]} */
  let samples = [];

  return {
    /**
     * One feeder read of the state block.
     * @param {Buffer} bytes the block from offset 0, at least through STATE.frames
     * @param {number} startedAt
     * @param {number} endedAt
     */
    sample(bytes, startedAt, endedAt) {
      const frames = bytes.readUInt32LE(STATE.frames);
      const step = last === null ? null : (frames - last) >>> 0;
      last = frames;

      samples.push({readMs: endedAt - startedAt, step, offset: endedAt - frames * periodMs});
    },
    /** @returns {PadRow} the reads since the last take */
    take() {
      const taken = samples;
      samples = [];
      if (!taken.length) return {reads: 0};

      const steps = /** @type {number[]} */ (
        taken.map(sample => sample.step).filter(step => step !== null)
      );
      const freshest = Math.min(...taken.map(sample => sample.offset));
      const ages = taken.map(sample => sample.offset - freshest);
      const reads = taken.map(sample => sample.readMs);
      /** @param {number[]} values */
      const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

      return {
        reads: taken.length,
        readMeanMs: tenths(mean(reads)),
        readMaxMs: tenths(Math.max(...reads)),
        stepMax: steps.length ? Math.max(...steps) : 0,
        stalls: steps.filter(step => step === 0).length,
        gaps: steps.filter(step => step > 1).length,
        ageMeanMs: tenths(mean(ages)),
        ageMaxMs: tenths(Math.max(...ages))
      };
    }
  };
}

/**
 * Folds the feeder's takes that arrived during one stats row into one, means weighted by
 * reads.
 * @param {PadRow[]} rows
 * @returns {PadRow}
 */
function merge(rows) {
  const read = rows.filter(row => row.reads);
  const reads = read.reduce((sum, row) => sum + row.reads, 0);
  if (!reads) return {reads: 0};

  /** @param {keyof PadRow} key */
  const weighted = key =>
    tenths(read.reduce((sum, row) => sum + (row[key] ?? 0) * row.reads, 0) / reads);
  /** @param {keyof PadRow} key */
  const most = key => Math.max(...read.map(row => row[key] ?? 0));
  /** @param {keyof PadRow} key */
  const total = key => read.reduce((sum, row) => sum + (row[key] ?? 0), 0);

  return {
    reads,
    readMeanMs: weighted('readMeanMs'),
    readMaxMs: most('readMaxMs'),
    stepMax: most('stepMax'),
    stalls: total('stalls'),
    gaps: total('gaps'),
    ageMeanMs: weighted('ageMeanMs'),
    ageMaxMs: most('ageMaxMs')
  };
}

export {create, merge};
