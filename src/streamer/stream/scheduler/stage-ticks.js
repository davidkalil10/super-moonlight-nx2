/**
 * Books the console stage ticks of HBL_STAGE_TICKS=1 per access unit: receive→submit, decode,
 * ready→publish, publish→applied on the host clock, and their sum from submit as sendPresent.
 */
import {isApplied} from './staggered-checks.js';

/** The console counter runs at 31.25 MHz (hbl-dev console-tick-frequency.cjs). */
const TICKS_PER_MS = 31250;
/** Access units the per-unit map keeps. */
const MAX_UNITS = 64;
const STAGES = ['receiveSubmit', 'decode', 'readyPublish', 'publishApplied', 'sendPresent'];

/** Each tick and the sequence of the group it is stamped before. */
const SEQUENCES = {
  receive: snapshot => snapshot.receive.sequence,
  submit: snapshot => snapshot.input.sequence,
  ready: snapshot => snapshot.acquire.sequence,
  publish: snapshot => snapshot.fetch.sequence
};

/**
 * @typedef {object} Unit What the reads have shown of one access unit.
 * @property {Partial<Record<keyof SEQUENCES, bigint>>} ticks Paired ticks.
 * @property {number} [publication] The publication sequence its fetch commits.
 * @property {number} [fetchSeenAt] Host time of the first read showing its fetch.
 * @property {number} [publishApplied] Host ms from that read to the first showing it applied.
 * @property {Set<string>} booked
 */

/**
 * @param {bigint | undefined} from
 * @param {bigint | undefined} to
 * @returns {number | null} The ms between two console ticks, or null without both in order.
 */
function ticksMs(from, to) {
  if (from === undefined || to === undefined || to < from) return null;
  return Number(to - from) / TICKS_PER_MS;
}

/**
 * @param {number[]} values
 * @returns {{p50: number | null, p95: number | null, max: number | null, n: number}}
 */
function stats(values) {
  if (!values.length) return {p50: null, p95: null, max: null, n: 0};

  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const round = ms => Math.round(ms * 1000) / 1000;
  return {p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)), n: sorted.length};
}

/** One recorder per staggered scheduler; observe() takes every gate's status reads. */
function create() {
  /** @type {Map<number, Unit>} */
  const units = new Map();
  /** @type {Record<string, number[]>} */
  const samples = Object.fromEntries(STAGES.map(stage => [stage, []]));
  /** Each tick's (sequence, tick) in the previous read. */
  let last = {};
  let torn = 0;
  let paired = 0;

  /** @returns {Unit} */
  function unit(sequence) {
    let entry = units.get(sequence);
    if (entry) return entry;

    entry = {ticks: {}, booked: new Set()};
    units.set(sequence, entry);
    for (const old of units.keys()) if (old <= sequence - MAX_UNITS) units.delete(old);
    return entry;
  }

  function book(entry, stage, ms) {
    if (ms === null || entry.booked.has(stage)) return;
    entry.booked.add(stage);
    samples[stage].push(ms);
  }

  /** @param {Unit} entry */
  function bookStages(entry) {
    const {receive, submit, ready, publish} = entry.ticks;
    book(entry, 'receiveSubmit', ticksMs(receive, submit));
    book(entry, 'decode', ticksMs(submit, ready));
    book(entry, 'readyPublish', ticksMs(ready, publish));
    if (entry.publishApplied === undefined) return;

    book(entry, 'publishApplied', entry.publishApplied);
    const submitPublish = ticksMs(submit, publish);
    if (submitPublish !== null) book(entry, 'sendPresent', submitPublish + entry.publishApplied);
  }

  /** A read with any sequence behind the previous one starts a new generation. */
  function wentBack(snapshot) {
    return Object.entries(SEQUENCES).some(
      ([stamp, sequenceOf]) => last[stamp] && sequenceOf(snapshot) < last[stamp].sequence
    );
  }

  /** Pairs a tick with its sequence once two reads in a row show both unchanged. */
  function pair(stamp, sequence, tick) {
    const before = last[stamp];
    last[stamp] = {sequence, tick};
    if (!before || before.sequence !== sequence) return;
    if (before.tick !== tick) {
      torn++;
      return;
    }
    if (tick === 0n || sequence === 0) return;

    const entry = unit(sequence);
    if (entry.ticks[stamp] !== undefined) return;
    entry.ticks[stamp] = tick;
    paired++;
    bookStages(entry);
  }

  /** Notes the first read showing a published unit fetched, then the first showing it applied. */
  function seePublications(snapshot, at) {
    for (const [sequence, entry] of units) {
      if (entry.publication === undefined || entry.publishApplied !== undefined) continue;
      if (entry.fetchSeenAt === undefined && snapshot.fetch.sequence >= sequence)
        entry.fetchSeenAt = at;
      if (entry.fetchSeenAt === undefined) continue;
      if (!isApplied(snapshot.nativeApplied, entry.publication)) continue;

      entry.publishApplied = at - entry.fetchSeenAt;
      bookStages(entry);
    }
  }

  return {
    /**
     * @param {import('../worker/staggered-status.js').Snapshot} snapshot
     * @param {number} at Host time of the read.
     */
    observe(snapshot, at) {
      if (!snapshot.ticks) return;
      if (wentBack(snapshot)) {
        units.clear();
        last = {};
      }

      for (const [stamp, sequenceOf] of Object.entries(SEQUENCES))
        pair(stamp, sequenceOf(snapshot), snapshot.ticks[stamp]);
      seePublications(snapshot, at);
    },

    /**
     * Access unit `sequence` is fetched into publication `publication`, which its fetch frame
     * commits as nativeSequence; a skipped unit commits none of its own.
     * @param {number} sequence
     * @param {number} publication
     */
    publishes(sequence, publication) {
      unit(sequence).publication = publication;
    },

    get summary() {
      const stages = Object.fromEntries(STAGES.map(stage => [stage, stats(samples[stage])]));
      return {...stages, torn, paired};
    }
  };
}

export {TICKS_PER_MS, create};
