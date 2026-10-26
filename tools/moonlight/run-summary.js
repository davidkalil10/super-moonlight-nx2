/**
 * Scores a native H.264 live run from its one-second stats rows: `summarize` averages the
 * steady rows after a warmup, `parseExpect` reads the `--expect` limits and `verdict` checks
 * the summary against them. Dropped frames and IDR requests fail a run unless `--expect`
 * allows some.
 */

/** Steady-state rows start after this many seconds by default. */
const DEFAULT_WARMUP = 3;
/** Each `--expect` name and the test its limit must pass. */
const LIMITS = {
  fps: (summary, value) => summary.fps >= value,
  minFps: (summary, value) => summary.minFps >= value,
  decoded: (summary, value) => summary.decodedFps >= value,
  queued: (summary, value) => summary.maxQueued <= value,
  dropped: (summary, value) => summary.dropped <= value,
  idr: (summary, value) => summary.idr <= value,
  resyncs: (summary, value) => summary.resyncs <= value,
  requests: (summary, value) => summary.requestsPerFrame <= value
};
/** Limits that apply when `--expect` leaves them out. */
const DEFAULT_LIMITS = {dropped: 0, idr: 0};

/**
 * Parses `name=value,name=value` into limits.
 * @param {string | undefined} text
 * @returns {Record<string, number>}
 */
function parseExpect(text) {
  if (text === undefined) return {};
  /** @type {Record<string, number>} */
  const expect = {};
  for (const part of text.split(',')) {
    const [name, value] = part.split('=');
    if (!(name in LIMITS) || value === undefined || value === '' || !Number.isFinite(+value))
      throw Error('--expect takes ' + Object.keys(LIMITS).join('|') + '=<number>, comma separated');
    expect[name] = +value;
  }
  return expect;
}

/**
 * Totals the bridge counts and wall time of each stage over the steady rows.
 * @param {object[]} steady
 * @returns {Record<string, {exchanges: number, bridgeMs: number, wallMs: number}>}
 */
function stageTotals(steady) {
  /** @type {Record<string, {exchanges: number, bridgeMs: number, wallMs: number}>} */
  const stages = {};
  const stageOf = name => (stages[name] ||= {exchanges: 0, bridgeMs: 0, wallMs: 0});
  for (const row of steady) {
    for (const [name, value] of Object.entries(row.bridgeByStage || {})) {
      const stage = stageOf(name);
      stage.exchanges += value.exchanges;
      stage.bridgeMs += value.bridgeMs;
    }
    for (const [name, value] of Object.entries(row.ms || {})) stageOf(name).wallMs += value;
  }
  return stages;
}

/**
 * The access-unit timing of the steady rows that carry it (staggered rows), weighted by units;
 * null for rows from before it was recorded.
 * @param {object[]} steady
 */
function auTotals(steady) {
  const timed = steady.filter(row => row.au?.units);
  if (!timed.length) return null;
  const total = weight => timed.reduce((sum, row) => sum + (row.au[weight] ?? 0), 0);
  const mean = (key, weight) =>
    +(
      timed.reduce((sum, row) => sum + (row.au[key] ?? 0) * (row.au[weight] ?? 0), 0) /
      (total(weight) || 1)
    ).toFixed(1);
  return {
    units: total('units'),
    gated: total('gated'),
    waitMs: mean('waitMs', 'units'),
    maxWaitMs: Math.max(...timed.map(row => row.au.maxWaitMs ?? 0)),
    gateAgeMs: mean('gateAgeMs', 'gated'),
    inHand: mean('inHand', 'gated'),
    maxInHand: Math.max(...timed.map(row => row.au.maxInHand ?? 0))
  };
}

/**
 * Summarizes the rows after the warmup, with per-frame figures rounded to two decimals.
 * @param {object[]} rows
 * @param {{warmup?: number}} [options]
 */
function summarize(rows, {warmup = DEFAULT_WARMUP} = {}) {
  const steady = rows.slice(warmup);
  const sum = key => steady.reduce((total, row) => total + (row[key] || 0), 0);
  const presented = sum('presented');
  const perFrame = value => (presented ? +(value / presented).toFixed(2) : null);
  const stages = stageTotals(steady);
  const au = auTotals(steady);
  return {
    seconds: steady.length,
    warmup: Math.min(warmup, rows.length),
    presented,
    fps: steady.length ? +(presented / steady.length).toFixed(2) : 0,
    minFps: steady.length ? Math.min(...steady.map(row => row.presented)) : 0,
    decodedFps: steady.length ? +(sum('decoded') / steady.length).toFixed(2) : 0,
    skipped: sum('skipped'),
    maxQueued: steady.length ? Math.max(...steady.map(row => row.queued || 0)) : 0,
    dropped: sum('dropped'),
    idr: sum('idr'),
    resyncs: sum('resyncs'),
    requestsPerFrame: perFrame(sum('exchanges')),
    bridgeMsPerFrame: perFrame(sum('bridgeMs')),
    stages: Object.fromEntries(
      Object.entries(stages).map(([name, stage]) => [
        name,
        {
          requestsPerFrame: perFrame(stage.exchanges),
          bridgeMsPerFrame: perFrame(stage.bridgeMs),
          wallMsPerFrame: perFrame(stage.wallMs),
          waitMsPerFrame: perFrame(Math.max(0, stage.wallMs - stage.bridgeMs))
        }
      ])
    ),
    ...(au ? {au} : {})
  };
}

/**
 * Checks a summary against the limits and the defaults; a run with no steady rows always fails.
 * @param {ReturnType<typeof summarize>} summary
 * @param {Record<string, number>} expect
 * @returns {{pass: boolean, failures: string[]}}
 */
function verdict(summary, expect) {
  const limits = {...expect};
  for (const [name, value] of Object.entries(DEFAULT_LIMITS)) limits[name] ??= value;
  const failures = Object.entries(limits)
    .filter(([name, value]) => !LIMITS[name](summary, value))
    .map(([name, value]) => name + ' ' + value);
  if (!summary.seconds) failures.unshift('no steady rows');
  return {pass: failures.length === 0, failures};
}

export {parseExpect, summarize, verdict};
