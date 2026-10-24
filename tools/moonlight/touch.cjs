// Console touch screen -> moonlight-common-c multi-touch (LiSendTouchEvent).
//
// Touch lives in the same binding-0 state buffer as the controller, in the
// `touch` uint[] that begins at STATE.touch (byte 128). The layout is
// nn::hid::TouchScreenState<16>: an 8-byte sampling number, a u32 count, a u32
// pad, then sixteen 40-byte TouchState entries {deltaTime u64, attributes u32,
// fingerId u32, x, y, diameterX, diameterY, rotationAngle, reserved}. The
// launcher shader reads c.touch[2] as the count and c.touch[8]/[9] as point 0
// x/y, scaling them by 1.5 onto the 1920x1080 screen
// (homebrew-launcher/shaders/launcher.comp), so the panel reports 1280x720
// coordinates. attributes bit 1 means the finger lifted this frame (the same
// bit the shader tests as `touch[6]&2u`).
//
// fingerId is the pointer id tracked across frames: slots compact when a finger
// lifts, so the slot index is not stable. The panel reports no pressure, so
// down/move carry 0.0, which LiSendTouchEvent documents as "pressure unknown".

const PANEL = {width: 1280, height: 720};
const MAX_POINTS = 16;
const HEADER_WORDS = 4;
const POINT_WORDS = 10;
const TOUCH_WORDS = HEADER_WORDS + MAX_POINTS * POINT_WORDS;
const TOUCH_BYTES = TOUCH_WORDS * 4;
const ATTR_END = 0x2;
const PRESSURE_UNKNOWN = 0;

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const round4 = v => Math.round(v * 1e4) / 1e4;

function parseTouch(bytes, panel = PANEL) {
  const count = Math.min(bytes.readUInt32LE(2 * 4), MAX_POINTS);
  const points = [];
  for (let i = 0; i < count; i++) {
    const word = HEADER_WORDS + i * POINT_WORDS;
    const attributes = bytes.readUInt32LE((word + 2) * 4);
    const id = bytes.readUInt32LE((word + 3) * 4);
    const x = bytes.readInt32LE((word + 4) * 4);
    const y = bytes.readInt32LE((word + 5) * 4);
    points.push({
      id,
      x: round4(clamp01(x / panel.width)),
      y: round4(clamp01(y / panel.height)),
      ended: (attributes & ATTR_END) !== 0
    });
  }
  return points;
}

function createTracker() {
  return {active: new Map()};
}

function step(tracker, points) {
  const events = [];
  const seen = new Set();
  for (const point of points) {
    const previous = tracker.active.get(point.id);
    if (point.ended) {
      if (previous) {
        events.push({
          id: point.id,
          action: 'up',
          x: point.x,
          y: point.y,
          pressure: PRESSURE_UNKNOWN
        });
        tracker.active.delete(point.id);
      }
      continue;
    }
    seen.add(point.id);
    if (!previous)
      events.push({
        id: point.id,
        action: 'down',
        x: point.x,
        y: point.y,
        pressure: PRESSURE_UNKNOWN
      });
    else if (previous.x !== point.x || previous.y !== point.y)
      events.push({
        id: point.id,
        action: 'move',
        x: point.x,
        y: point.y,
        pressure: PRESSURE_UNKNOWN
      });
    tracker.active.set(point.id, {x: point.x, y: point.y});
  }
  for (const [id, previous] of tracker.active)
    if (!seen.has(id)) {
      events.push({id, action: 'up', x: previous.x, y: previous.y, pressure: PRESSURE_UNKNOWN});
      tracker.active.delete(id);
    }
  return {tracker, events};
}

function flush(tracker) {
  const events = [];
  for (const [id, previous] of tracker.active)
    events.push({id, action: 'up', x: previous.x, y: previous.y, pressure: PRESSURE_UNKNOWN});
  tracker.active.clear();
  return events;
}

function touchLine(events) {
  return JSON.stringify({type: 'touch', events});
}

module.exports = {
  PANEL,
  MAX_POINTS,
  TOUCH_BYTES,
  PRESSURE_UNKNOWN,
  parseTouch,
  createTracker,
  step,
  flush,
  touchLine
};
