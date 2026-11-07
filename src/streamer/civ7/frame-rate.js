const MEASUREMENT_FLOOR = 12;
const RATE_MARGIN = 0.9;
const BUSY_SHARE = 0.9;

/** @param {number} fps */
function validRate(fps) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 120)
    throw Error('Invalid stream frame rate');
}

/**
 * @param {number} requestedFps
 * @param {{frames: number, elapsedMs: number}} [measurement]
 */
export function selectFrameRate(requestedFps, measurement = undefined) {
  validRate(requestedFps);
  if (!measurement) return {requestedFps, effectiveFps: requestedFps, measuredFps: null};
  const {frames, elapsedMs} = measurement;
  if (!Number.isSafeInteger(frames) || frames < MEASUREMENT_FLOOR ||
      !Number.isFinite(elapsedMs) || elapsedMs <= 0)
    throw Error('Frame rate measurement requires at least 12 presented frames');

  const measuredFps = frames * 1000 / elapsedMs;
  if (measuredFps >= requestedFps * RATE_MARGIN)
    return {requestedFps, effectiveFps: requestedFps, measuredFps};

  const effectiveFps = [60, 30].find(rate => rate < requestedFps && measuredFps >= rate * RATE_MARGIN);
  if (!effectiveFps) throw Error('Console presentation is too slow for the requested stream');
  return {requestedFps, effectiveFps, measuredFps, reason: 'presentation-capacity'};
}

/**
 * Cumulative acknowledgements and backlog counters determine whether a high-rate session
 * remains overloaded. A recommendation ends this session; the next starts a fresh H.264 chain.
 * With the console's busy ms per unit (latency.js ConsoleLoop) it says which side was short:
 * `console` when that cost exceeds the frame period, else `transport`.
 * Only an overloaded short second counts toward the window; a starved one, where the console's
 * loop sat idle waiting for units, is only added to `starvedMs` (README.md, "Current evidence").
 * @param {{fps: number, startedAt?: number, warmupMs?: number, sustainedMs?: number}} options
 */
export function createFrameRateGuard({fps, startedAt = Date.now(), warmupMs = 1500, sustainedMs = 3000}) {
  validRate(fps);
  if (![startedAt, warmupMs, sustainedMs].every(Number.isFinite) || warmupMs < 0 || sustainedMs < 1000)
    throw Error('Invalid frame rate observation window');

  let previous = {at: startedAt, presented: 0, dropped: 0, idrRequests: 0};
  let bad = emptyWindow();
  let pending = emptyWindow();
  let starvedMs = 0;
  let recommended = false;

  function reset() {
    bad = emptyWindow();
    pending = emptyWindow();
  }

  /** @param {number} frameMs */
  function consoleCost(frameMs) {
    if (!bad.unitMs.length) return {};

    const total = bad.unitMs.reduce((sum, value) => sum + value, 0);
    const consoleUnitMs = Math.round(total / bad.unitMs.length * 100) / 100;
    return {consoleUnitMs, limit: consoleUnitMs > frameMs ? 'console' : 'transport'};
  }

  /**
   * Short seconds wait for the console's next loop block, which covers every second since the
   * last one; its idle share says whether they were overloaded or starved.
   * @param {{busyMs: number, elapsedMs: number} | undefined} loop
   */
  function settle(loop) {
    if (!loop) return;

    if (consoleSaturated(loop)) addWindow(bad, pending);
    else starvedMs += pending.ms;
    pending = emptyWindow();
  }

  return {
    /**
     * @param {{at: number, presented: number, dropped: number, idrRequests: number,
     *   queueAgeMs: number, acknowledgementMs: number, consoleUnitMs?: number,
     *   console?: {busyMs: number, elapsedMs: number} | null}} sample
     */
    observe(sample) {
      const {at, presented, dropped, idrRequests, queueAgeMs, acknowledgementMs} = sample;
      if (!Number.isFinite(at) || ![presented, dropped, idrRequests].every(value =>
        Number.isSafeInteger(value) && value >= 0) ||
          ![queueAgeMs, acknowledgementMs].every(value => Number.isFinite(value) && value >= 0))
        throw Error('Invalid frame rate sample');

      const elapsedMs = at - previous.at;
      const frames = presented - previous.presented;
      const drops = dropped - previous.dropped;
      const idrs = idrRequests - previous.idrRequests;
      const warmedUp = previous.at >= startedAt + warmupMs;
      previous = {at, presented, dropped, idrRequests};
      if (fps <= 60 || recommended) return null;
      if (!warmedUp || elapsedMs < 250 || elapsedMs > 2500 || frames < 0 || drops < 0 || idrs < 0) {
        reset();
        return null;
      }

      const measuredFps = frames * 1000 / elapsedMs;
      const frameMs = 1000 / fps;
      const pressure = drops >= 2 || idrs > 0 || queueAgeMs > frameMs * 2 ||
        acknowledgementMs > frameMs * 4;
      if (measuredFps >= fps * RATE_MARGIN || !pressure) {
        reset();
        return null;
      }

      addWindow(pending, {ms: elapsedMs, frames, drops, idrs, unitMs: []});
      if (Number.isFinite(sample.consoleUnitMs)) pending.unitMs.push(/** @type {number} */ (sample.consoleUnitMs));
      settle(sample.console ?? undefined);
      if (bad.ms < sustainedMs) return null;

      recommended = true;
      return {from: fps, to: 60, reason: 'presentation-overload',
        measuredFps: bad.frames * 1000 / bad.ms, elapsedMs: bad.ms,
        dropped: bad.drops, idrRequests: bad.idrs, starvedMs, ...consoleCost(frameMs)};
    }
  };
}

/** @typedef {{ms: number, frames: number, drops: number, idrs: number, unitMs: number[]}} ShortWindow */

/** @returns {ShortWindow} */
function emptyWindow() {
  return {ms: 0, frames: 0, drops: 0, idrs: 0, unitMs: []};
}

/** @param {ShortWindow} into @param {ShortWindow} from */
function addWindow(into, from) {
  into.ms += from.ms;
  into.frames += from.frames;
  into.drops += from.drops;
  into.idrs += from.idrs;
  into.unitMs.push(...from.unitMs);
}

/**
 * Busy for most of the loop block: units were there and the console could not keep up.
 * @param {{busyMs: number, elapsedMs: number}} loop
 */
function consoleSaturated(loop) {
  return loop.busyMs >= loop.elapsedMs * BUSY_SHARE;
}

/**
 * The panel refresh rate around a high-rate session (refresh-rate.js): `raise` to the session's
 * rate before the measurement, `measured` judges each batch until the raise is confirmed,
 * `restore` once the session runs at 60 or ends. None throws.
 * @typedef {{raise: (fps: number) => Promise<boolean>, restore: (reason: string) => Promise<unknown>,
 *   measured?: (measurement: {frames: number, elapsedMs: number}) =>
 *     Promise<'raised' | 'pending' | 'failed'>}} DisplayRate
 */

/**
 * A session that runs below the rate asked for, at selection or after a fallback; `run` gets it
 * so the new stream shows the rate badge (rate-badge.js).
 * @typedef {{from: number, to: number, reason?: string}} RateChange
 */

/**
 * Measures presentation before high-rate streaming, then allows one sustained-overload retry.
 * User settings remain unchanged; every attempt negotiates its own complete Sunshine session.
 * With `display`, a session above 60 runs only on a raised panel and falls to 60 otherwise.
 * @template {{presentedFps?: number, dropped?: number, idrRequests?: number,
 *   rateFallback?: {to: number} | null}} Result
 * @param {{fps: number, measure?: () => Promise<{frames: number, elapsedMs: number}>,
 *   run: (fps: number, change?: RateChange) => Promise<Result>, signal?: AbortSignal, display?: DisplayRate,
 *   log?: (event: object) => void}} options
 */
export async function runFrameRateSession({fps, measure, run, signal, display, log = event => {}}) {
  validRate(fps);
  signal?.throwIfAborted();
  const raised = fps > 60 && display ? await display.raise(fps) : false;
  try {
    return await runSessions({fps, measure, run, signal, display, raised, log});
  } finally {
    if (raised && display) await display.restore('end');
  }
}

/**
 * The measurement on a raised panel: the raise lands on a later present, so batches repeat while
 * `measured` answers pending. A failed raise is restored.
 * @param {{requested: boolean, measure?: () => Promise<{frames: number, elapsedMs: number}>,
 *   display: DisplayRate, signal?: AbortSignal}} options
 * @returns {Promise<{raised: boolean, measurement?: {frames: number, elapsedMs: number}}>}
 */
async function measureRaised({requested, measure, display, signal}) {
  if (!requested) return {raised: false};
  if (!measure) return {raised: true};

  for (;;) {
    const measurement = await measure();
    signal?.throwIfAborted();
    const state = display.measured ? await display.measured(measurement) : 'raised';
    if (state === 'raised') return {raised: true, measurement};
    if (state === 'failed') break;
  }

  await display.restore('raise-unconfirmed');
  return {raised: false};
}

/**
 * @template {{presentedFps?: number, dropped?: number, idrRequests?: number,
 *   rateFallback?: {to: number} | null}} Result
 * @param {{fps: number, measure?: () => Promise<{frames: number, elapsedMs: number}>,
 *   run: (fps: number, change?: RateChange) => Promise<Result>, signal?: AbortSignal, display?: DisplayRate,
 *   raised: boolean, log: (event: object) => void}} options
 */
async function runSessions({fps, measure, run, signal, display, raised: requested, log}) {
  signal?.throwIfAborted();
  const highRate = fps > 60;
  const panel = highRate && display ? await measureRaised({requested, measure, display, signal}) : null;
  let measurement = panel?.measurement;
  if (highRate && measure && !panel) measurement = await measure();
  signal?.throwIfAborted();

  const raised = panel?.raised ?? false;
  const unraised = Boolean(panel) && !raised;

  const selection = unraised
    ? {requestedFps: fps, effectiveFps: 60, measuredFps: null, reason: 'refresh-rate-unavailable'}
    : selectFrameRate(fps, measurement);
  let effectiveFps = selection.effectiveFps;
  if (fps > 60) log({type: 'frame-rate-selection', ...selection});
  if (raised && effectiveFps <= 60) await display?.restore(selection.reason ?? 'selection');

  const rateAttempts = [];
  /** @type {RateChange | undefined} */
  let change = effectiveFps < fps ? {from: fps, to: effectiveFps, reason: selection.reason} : undefined;
  for (;;) {
    signal?.throwIfAborted();
    const result = await run(effectiveFps, change);
    rateAttempts.push({fps: effectiveFps, presentedFps: result.presentedFps,
      dropped: result.dropped, idrRequests: result.idrRequests});
    const fallback = result.rateFallback;
    if (signal?.aborted || effectiveFps <= 60 || rateAttempts.length >= 2 || fallback?.to !== 60)
      return {...result, requestedFps: fps, effectiveFps, rateAttempts};

    log({type: 'frame-rate-fallback', requestedFps: fps, ...fallback});
    if (raised) await display?.restore('fallback');
    change = {from: effectiveFps, to: 60, reason: 'reason' in fallback ? String(fallback.reason) : undefined};
    effectiveFps = 60;
  }
}
