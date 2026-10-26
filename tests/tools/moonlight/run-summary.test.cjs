const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseExpect,
  summarize,
  verdict
} = require('../../../hbl-moonlight/tools/moonlight/run-summary.js');

const row = (presented, extra = {}) => ({
  presented,
  dropped: 0,
  idr: 0,
  resyncs: 0,
  exchanges: presented * 10,
  bridgeMs: presented * 20,
  bridgeByStage: {persistent: {exchanges: presented * 8, bridgeMs: presented * 16}},
  ms: {persistent: presented * 20, read: presented * 5},
  ...extra
});

test('summary skips warm-up rows and reports per-frame bridge cost', () => {
  const rows = [row(3, {idr: 3, dropped: 50}), row(20), row(29), row(30), row(30, {dropped: 2})];
  const summary = summarize(rows);
  assert.equal(summary.seconds, 2);
  assert.equal(summary.presented, 60);
  assert.equal(summary.fps, 30);
  assert.equal(summary.minFps, 30);
  assert.equal(summary.dropped, 2);
  assert.equal(summary.idr, 0);
  assert.equal(summary.requestsPerFrame, 10);
  assert.equal(summary.bridgeMsPerFrame, 20);
  assert.deepEqual(summary.stages.persistent, {
    requestsPerFrame: 8,
    bridgeMsPerFrame: 16,
    wallMsPerFrame: 20,
    waitMsPerFrame: 4
  });
  assert.equal(summary.stages.read.waitMsPerFrame, 5);
});

test('expectations parse strictly and score the summary', () => {
  assert.deepEqual(parseExpect(undefined), {});
  assert.deepEqual(parseExpect('fps=29.5,dropped=0,idr=0'), {fps: 29.5, dropped: 0, idr: 0});
  for (const bad of ['fps', 'fps=', 'speed=3', 'fps=abc', ''])
    assert.throws(() => parseExpect(bad), /--expect/);
  const summary = summarize([row(30), row(30), row(30), row(28), row(30, {idr: 1})]);
  assert.deepEqual(verdict(summary, {fps: 28, idr: 1}), {pass: true, failures: []});
  assert.deepEqual(verdict(summary, {fps: 30, idr: 0, requests: 10}), {
    pass: false,
    failures: ['fps 30', 'idr 0']
  });
});

test('a dropped frame or an IDR after the warmup fails unless the limits allow it', () => {
  const rows = [row(30, {dropped: 9, idr: 2}), row(30), row(30), row(30), row(6, {dropped: 24, idr: 4}), row(30)];
  const summary = summarize(rows);
  assert.deepEqual(verdict(summary, {}), {pass: false, failures: ['dropped 0', 'idr 0']});
  assert.deepEqual(verdict(summary, {dropped: 24, idr: 4}), {pass: true, failures: []});
  assert.deepEqual(verdict(summarize(rows.slice(0, 4)), {}), {pass: true, failures: []});
});

test('a run with no steady rows fails', () => {
  const summary = summarize([row(1), row(2)]);
  assert.equal(summary.seconds, 0);
  assert.deepEqual(verdict(summary, {}), {pass: false, failures: ['no steady rows']});
});

test('staggered rows report decoded fps, skipped presents and the deepest queue', () => {
  const rows = [
    row(10),
    row(60, {decoded: 120, skipped: 60, queued: 2}),
    row(60, {decoded: 118, skipped: 58, queued: 3})
  ];
  const summary = summarize(rows, {warmup: 1});
  assert.equal(summary.decodedFps, 119);
  assert.equal(summary.skipped, 118);
  assert.equal(summary.maxQueued, 3);
  assert.deepEqual(parseExpect('decoded=115,queued=2'), {decoded: 115, queued: 2});
  assert.deepEqual(verdict(summary, {fps: 59, decoded: 115, queued: 2}), {
    pass: false,
    failures: ['queued 2']
  });
});
