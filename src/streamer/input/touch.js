/**
 * Console touch screen to moonlight-common-c multi-touch (LiSendTouchEvent). The touch block
 * layout and the id and pressure rules are in CLAUDE.md.
 */

/**
 * @typedef {{id: number, x: number, y: number, ended: boolean}} TouchPoint
 * @typedef {{id: number, action: 'down' | 'move' | 'up', x: number, y: number,
 *   pressure: number}} TouchEvent
 * @typedef {{active: Map<number, {x: number, y: number}>}} Tracker
 */

/**
 * The touch mapping as one self-contained function: civ7/payload.js ships it to the console
 * with toString(), so it reads nothing outside itself (civ7/test/payload-scope.test.cjs).
 */
function touchMapping() {
  /** Panel coordinate range the touch points are reported in. */
  const PANEL = {width: 1280, height: 720};
  const MAX_POINTS = 16;
  const WORD_BYTES = 4;
  const HEADER_WORDS = 4;
  const POINT_WORDS = 10;
  const TOUCH_WORDS = HEADER_WORDS + MAX_POINTS * POINT_WORDS;
  const TOUCH_BYTES = TOUCH_WORDS * WORD_BYTES;
  /** Header word holding the point count. */
  const COUNT_WORD = 2;
  /** Word offsets inside one TouchState entry. */
  const POINT = {attributes: 2, fingerId: 3, x: 4, y: 5};
  /** Attributes bit set when the finger lifted this frame. */
  const ATTR_END = 0x2;
  const PRESSURE_UNKNOWN = 0;

  /**
   * @param {Uint8Array} bytes
   * @param {number} word
   */
  function int32(bytes, word) {
    const offset = word * WORD_BYTES;
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
  }

  /** @param {number} v */
  function clamp01(v) {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  /** @param {number} v */
  const round4 = v => Math.round(v * 1e4) / 1e4;

  /**
   * Reads the points of a touch block, with x and y normalised to 0..1 at four decimals. The
   * block may end after the last reported point.
   * @param {Uint8Array} bytes the touch block, from STATE.touch
   * @param {{width: number, height: number}} [panel]
   * @returns {TouchPoint[]}
   */
  function parseTouch(bytes, panel = PANEL) {
    const reported = int32(bytes, COUNT_WORD) >>> 0;
    const present = Math.floor((bytes.length / WORD_BYTES - HEADER_WORDS) / POINT_WORDS);
    const count = Math.min(reported, MAX_POINTS, present);

    const points = [];
    for (let i = 0; i < count; i++) {
      const word = HEADER_WORDS + i * POINT_WORDS;
      const attributes = int32(bytes, word + POINT.attributes);
      const x = int32(bytes, word + POINT.x);
      const y = int32(bytes, word + POINT.y);

      points.push({
        id: int32(bytes, word + POINT.fingerId) >>> 0,
        x: round4(clamp01(x / panel.width)),
        y: round4(clamp01(y / panel.height)),
        ended: (attributes & ATTR_END) !== 0
      });
    }
    return points;
  }

  /** @returns {Tracker} */
  function createTracker() {
    return {active: new Map()};
  }

  /**
   * @param {number} id
   * @param {TouchEvent['action']} action
   * @param {{x: number, y: number}} at
   * @returns {TouchEvent}
   */
  function touchEvent(id, action, at) {
    return {id, action, x: at.x, y: at.y, pressure: PRESSURE_UNKNOWN};
  }

  /**
   * Advances the tracker by one frame of points and returns the events it produced: down for a
   * new finger, move when one moved, and up when it ended or disappeared (at its last position).
   * @param {Tracker} tracker
   * @param {TouchPoint[]} points
   * @returns {{tracker: Tracker, events: TouchEvent[]}}
   */
  function step(tracker, points) {
    const events = [];
    const seen = new Set();

    for (const point of points) {
      const previous = tracker.active.get(point.id);
      if (point.ended) {
        if (previous) {
          events.push(touchEvent(point.id, 'up', point));
          tracker.active.delete(point.id);
        }
        continue;
      }

      seen.add(point.id);
      if (!previous) {
        events.push(touchEvent(point.id, 'down', point));
      } else if (previous.x !== point.x || previous.y !== point.y) {
        events.push(touchEvent(point.id, 'move', point));
      }
      tracker.active.set(point.id, {x: point.x, y: point.y});
    }

    for (const [id, previous] of tracker.active) {
      if (seen.has(id)) continue;
      events.push(touchEvent(id, 'up', previous));
      tracker.active.delete(id);
    }

    return {tracker, events};
  }

  /**
   * Lifts every active finger.
   * @param {Tracker} tracker
   * @returns {TouchEvent[]}
   */
  function flush(tracker) {
    const events = [];
    for (const [id, previous] of tracker.active) events.push(touchEvent(id, 'up', previous));
    tracker.active.clear();

    return events;
  }

  return {PANEL, MAX_POINTS, TOUCH_BYTES, PRESSURE_UNKNOWN, parseTouch, createTracker, step, flush};
}

const {PANEL, MAX_POINTS, TOUCH_BYTES, PRESSURE_UNKNOWN, parseTouch, createTracker, step, flush} =
  touchMapping();

/**
 * The JSON line hbmoonlight reads for a batch of touch events.
 * @param {TouchEvent[]} events
 * @returns {string}
 */
function touchLine(events) {
  return JSON.stringify({type: 'touch', events});
}

export {
  PANEL,
  MAX_POINTS,
  TOUCH_BYTES,
  PRESSURE_UNKNOWN,
  touchMapping,
  parseTouch,
  createTracker,
  step,
  flush,
  touchLine
};
