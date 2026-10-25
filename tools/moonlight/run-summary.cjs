// Scores a native H.264 live run from its one-second stats rows.
const LIMITS = {
  fps: (summary, value) => summary.fps >= value,
  minFps: (summary, value) => summary.minFps >= value,
  dropped: (summary, value) => summary.dropped <= value,
  idr: (summary, value) => summary.idr <= value,
  resyncs: (summary, value) => summary.resyncs <= value,
  requests: (summary, value) => summary.requestsPerFrame <= value
};

function parseExpect(text) {
  if (text === undefined) return {};
  const expect = {};
  for (const part of text.split(',')) {
    const [name, value] = part.split('=');
    if (!(name in LIMITS) || value === undefined || value === '' || !Number.isFinite(+value))
      throw Error('--expect takes ' + Object.keys(LIMITS).join('|') + '=<number>, comma separated');
    expect[name] = +value;
  }
  return expect;
}

function summarize(rows, {warmup = 3} = {}) {
  const steady = rows.slice(warmup);
  const sum = key => steady.reduce((total, row) => total + (row[key] || 0), 0);
  const presented = sum('presented');
  const perFrame = value => (presented ? +(value / presented).toFixed(2) : null);
  const stages = {};
  for (const row of steady)
    for (const [name, value] of Object.entries(row.bridgeByStage || {})) {
      const stage = (stages[name] ||= {exchanges: 0, bridgeMs: 0});
      stage.exchanges += value.exchanges;
      stage.bridgeMs += value.bridgeMs;
    }
  return {
    seconds: steady.length,
    warmup: Math.min(warmup, rows.length),
    presented,
    fps: steady.length ? +(presented / steady.length).toFixed(2) : 0,
    minFps: steady.length ? Math.min(...steady.map(row => row.presented)) : 0,
    dropped: sum('dropped'),
    idr: sum('idr'),
    resyncs: sum('resyncs'),
    requestsPerFrame: perFrame(sum('exchanges')),
    bridgeMsPerFrame: perFrame(sum('bridgeMs')),
    stages: Object.fromEntries(
      Object.entries(stages).map(([name, stage]) => [
        name,
        {requestsPerFrame: perFrame(stage.exchanges), bridgeMsPerFrame: perFrame(stage.bridgeMs)}
      ])
    )
  };
}

function verdict(summary, expect) {
  const failures = Object.entries(expect)
    .filter(([name, value]) => !LIMITS[name](summary, value))
    .map(([name, value]) => name + ' ' + value);
  if (!summary.seconds) failures.unshift('no steady rows');
  return {pass: failures.length === 0, failures};
}

module.exports = {parseExpect, summarize, verdict};
