/**
 * Predicts the renderer's vsync, learned from status reads, so a staggered gate waiting for a
 * publication to apply sleeps off the bridge; it also learns whether the console applies on
 * every refresh or every other one.
 */

/** Votes remembered for the long-period test. */
const HALF_WINDOW = 16;
/** Skipped-refresh votes among them that move the pacer to the long period. */
const HALF_MISSES = 6;
/** On the long period, one timed read in this many with an odd refresh ahead probes it. */
const PROBE_EVERY = 16;
/** Odd-refresh votes in a row that bring the short period back. */
const MID_HITS = 4;

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
 * @param {number} [options.nudgeMs] how far a read outside a bracket may move the phase
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<unknown>} [options.sleep]
 */
function create({
  periodMs = 1000 / 60,
  marginMs = 1,
  pollMs = 2,
  windowMs = 5,
  driftMs = 0.1,
  nudgeMs = 0.5,
  now = Date.now,
  sleep = delay
} = {}) {
  /** Time of a past vsync, or null until one has been bracketed. */
  let phase = null;
  /** A read since the last success found the publication not applied, and when it started. */
  let missed = false;
  let missStartedAt = null;
  /** The last beforeRead slept until a predicted vsync. */
  let predicted = false;
  /** Refresh periods per apply: 1, or 2 once the console is seen applying every other one. */
  let grid = 1;
  /** The publication the reads are judging: when its fetch opened, what they saw, its vote. */
  let judging = null;
  /** Recent votes while on the short period: true for a skipped refresh. */
  let votes = [];
  /** Timed reads on the long period, for the odd-refresh probe. */
  let probes = 0;
  /** Odd-refresh votes in a row on the long period. */
  let midHits = 0;
  const counters = {reads: 0, predicted: 0, probes: 0, lateVotes: 0, earlyVotes: 0, flips: 0};

  const period = () => grid * periodMs;
  const vsyncAfter = (at, step) => phase + Math.ceil((at - phase) / step) * step;
  const nextVsync = at => vsyncAfter(at, period());

  const sleepUntil = async at => {
    const ms = at - now();
    if (ms > 0) await sleep(ms);
  };

  /** Moves the phase a little toward a vsync seen at `at`, by the shorter way round the grid. */
  const nudgeToward = at => {
    const residual = at - (nextVsync(at) - period());
    if (residual < period() / 2) phase += Math.min(residual, nudgeMs);
    else phase -= Math.min(period() - residual, nudgeMs);
  };

  const judge = openedAt => {
    if (judging === null || judging.openedAt !== openedAt)
      judging = {openedAt, lateMiss: false, voted: false};
    return judging;
  };

  const flip = to => {
    grid = to;
    votes = [];
    midHits = 0;
    counters.flips++;
  };

  /**
   * One vote per publication. 'skipped': the console let the refresh it was due on pass.
   * 'odd': it applied on a refresh the long period would skip. 'onTime': applied on its refresh,
   * which says nothing against the long period when that refresh is an even one.
   * @param {'skipped' | 'odd' | 'onTime'} kind
   */
  const vote = kind => {
    judging.voted = true;
    if (kind === 'skipped') counters.lateVotes++;
    else if (kind === 'odd') counters.earlyVotes++;

    if (grid === 1) {
      votes.push(kind === 'skipped');
      if (votes.length > HALF_WINDOW) votes.shift();
      if (votes.filter(Boolean).length >= HALF_MISSES) flip(2);
      return;
    }

    if (kind === 'odd') {
      midHits++;
      if (midHits >= MID_HITS) flip(1);
    } else if (kind === 'skipped') {
      midHits = 0;
    }
  };

  /**
   * The vote of a read that found `current` applied, if it can tell anything.
   * @param {{lateMiss: boolean}} current
   * @param {number} refresh The refresh the publication was due on.
   * @param {number} even The next refresh the long period would apply on.
   * @param {number} endedAt
   */
  const voteApplied = (current, refresh, even, endedAt) => {
    if (current.lateMiss) {
      const skipped = endedAt - refresh >= periodMs / 2;
      vote(skipped ? 'skipped' : 'onTime');
      return;
    }

    const beforeEven = even > refresh && endedAt < even - marginMs;
    if (beforeEven) vote('odd');
    else if (endedAt < refresh + periodMs / 2) vote('onTime');
  };

  /**
   * Votes on the publication opened at `openedAt` and nudges the phase toward what a read saw.
   * @param {number} startedAt
   * @param {number} endedAt
   * @param {boolean} applied
   * @param {number} openedAt
   */
  const judgeRead = (startedAt, endedAt, applied, openedAt) => {
    const current = judge(openedAt);
    const refresh = vsyncAfter(openedAt, periodMs);
    const even = vsyncAfter(openedAt, 2 * periodMs);
    const expected = nextVsync(openedAt);

    if (!applied) {
      const late = startedAt - expected;
      if (startedAt >= refresh + marginMs + pollMs) current.lateMiss = true;
      else if (late >= marginMs) phase += Math.min(late, nudgeMs);
      return;
    }

    if (!current.voted) voteApplied(current, refresh, even, endedAt);
    if (expected > endedAt && !missed) phase -= Math.min(expected - endedAt, nudgeMs);
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

      judge(openedAt);
      let due = nextVsync(openedAt) + marginMs;
      const odd = grid === 2 ? nextVsync(openedAt) - periodMs : null;
      if (odd !== null && odd > openedAt) {
        probes++;
        if (probes % PROBE_EVERY === 0) {
          due = odd + marginMs;
          counters.probes++;
        }
      }
      if (due <= now()) return;

      predicted = true;
      counters.predicted++;
      await sleepUntil(due);
    },

    /**
     * After each read that checked the publication, with the time the read started. openedAt
     * names the publication when the gate did not go through beforeRead for it.
     * @param {number} startedAt
     * @param {boolean} applied
     * @param {number | null} [openedAt]
     */
    observe(startedAt, applied, openedAt = judging?.openedAt ?? null) {
      const endedAt = now();
      counters.reads++;
      if (phase !== null && openedAt !== null) judgeRead(startedAt, endedAt, applied, openedAt);

      if (!applied) {
        if (!missed) missStartedAt = startedAt;
        missed = true;
        return;
      }

      if (missed) {
        const bracketed = phase === null || startedAt - missStartedAt <= period();
        if (bracketed) phase = startedAt;
        else nudgeToward(startedAt);
      } else if (predicted) {
        phase -= driftMs;
      }
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

      const sinceVsync = at - (nextVsync(at) - period());
      if (sinceVsync < windowMs) return sleep(pollMs);

      await sleepUntil(nextVsync(at) + marginMs);
    },

    /** @returns {number | null} */
    get phase() {
      return phase;
    },

    /** The period applies are expected on: the refresh, or twice it. */
    get periodMs() {
      return period();
    },

    /** Reads seen, reads the pacer timed, odd-refresh probes, votes each way, period flips. */
    get counters() {
      return {...counters, grid};
    }
  };
}

export {create};
