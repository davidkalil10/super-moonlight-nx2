// Marks from a payload's hello to its first published UI page, logged once as `startup-timing`
// (README.md, "Startup timing").

/** @typedef {Record<string, unknown>} TimingEvent */

/**
 * The mark a startup log event sets, or null.
 * @param {TimingEvent} event
 */
function eventMark(event) {
  switch (event.event) {
    case 'resources-reaped': return 'reaped';
    case 'startup': return 'startup-' + String(event.stage);
    case 'compatibility':
    case 'graphics-ledger':
    case 'graphics-reused':
    case 'attach':
    case 'published':
      return String(event.event);
    default:
      return null;
  }
}

/**
 * The step between two consecutive marks that took longest.
 * @param {Record<string, number>} marks
 */
export function longestStep(marks) {
  const ordered = Object.entries({hello: 0, ...marks}).sort((a, b) => a[1] - b[1]);
  let longest = {from: 'hello', to: 'hello', ms: 0};
  for (let index = 1; index < ordered.length; index++) {
    const ms = ordered[index][1] - ordered[index - 1][1];
    if (ms > longest.ms) longest = {from: ordered[index - 1][0], to: ordered[index][0], ms};
  }

  return longest;
}

/**
 * Collects one attach's startup marks in ms since the hello: explicit ones through `mark`, the
 * rest from the startup events `observe` sees. The first `published` event finishes it.
 * @param {{now?: () => number, sentMs?: number | null, bridgeMs?: number | null}} [options]
 *   `sentMs` is the payload send to the hello, `bridgeMs` the console's bridge start to the hello
 */
export function createStartupTiming({now = () => performance.now(), sentMs = null, bridgeMs = null} = {}) {
  const started = now();
  /** @type {Record<string, number>} */
  const marks = {};
  let done = false;

  /** @param {string} name */
  function mark(name) {
    if (done || name in marks) return;
    marks[name] = Math.round(now() - started);
  }

  /**
   * @param {TimingEvent} event
   * @returns {TimingEvent | null} the `startup-timing` event once the first page is out
   */
  function observe(event) {
    if (done) return null;
    const name = eventMark(event);
    if (!name) return null;

    mark(name);
    if (name !== 'published') return null;

    done = true;
    const page = {screen: event.screen, composeMs: event.composeMs, encodeMs: event.encodeMs,
      writeMs: event.writeMs, showMs: event.showMs};
    return {event: 'startup-timing', marks, longest: longestStep(marks), page,
      console: {sentMs, bridgeMs}};
  }

  return {mark, observe};
}
