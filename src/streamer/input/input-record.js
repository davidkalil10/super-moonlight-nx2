/**
 * Input records from the console to the PC on the civ7 video channel: the console maps pad and
 * touch, and the PC validates and forwards. Wire format in this directory's CLAUDE.md.
 */

/** Record version and the largest encoded record, in bytes. */
const INPUT_RECORD = {version: 1, limit: 0xf00};
/** Most touch events one record carries: a move for each point plus an up for each lost one. */
const MAX_TOUCH_EVENTS = 32;
const RECORD_KEYS = ['v', 'pad', 'touch', 'stop'];
const PAD_RANGES = {
  buttonFlags: [0, 0xffff],
  leftTrigger: [0, 255],
  rightTrigger: [0, 255],
  leftStickX: [-32768, 32767],
  leftStickY: [-32768, 32767],
  rightStickX: [-32768, 32767],
  rightStickY: [-32768, 32767]
};
const TOUCH_KEYS = ['id', 'action', 'x', 'y', 'pressure'];
const TOUCH_ACTIONS = ['down', 'move', 'up'];

/**
 * @typedef {ReturnType<ReturnType<typeof import('./controller.js').controllerMapping>['toMoonlight']>} PadRecord
 * @typedef {{v: number, pad?: PadRecord, touch?: import('./touch.js').TouchEvent[], stop?: true}} InputRecord
 * @typedef {{controller: ReturnType<typeof import('./controller.js').controllerMapping>,
 *   touch: ReturnType<typeof import('./touch.js').touchMapping>, record: typeof INPUT_RECORD}} InputMapping
 */

/**
 * Console side, shipped by civ7/payload.js with toString(), so it reads only its argument.
 * Each call takes one frame's pad and touch reads and returns the changes as a record, or null.
 * The stop chord releases the pad and lifts the touches once, asks for a stop, and ends input.
 * Buttons held while input was gated stay released until they lift, as fingers do.
 * @param {InputMapping} mapping
 */
function createInputRecorder(mapping) {
  const {controller, touch} = mapping;
  const tracker = touch.createTracker();
  const forwarded = touch.createTracker();
  /** @type {PadRecord | null} */
  let lastPad = null;
  let heldAcrossGate = 0;
  let stopped = false;

  /** @param {PadRecord} pad */
  function changed(pad) {
    if (controller.same(pad, lastPad)) return null;

    lastPad = pad;
    return pad;
  }

  /** @param {boolean} connected */
  function stopRecord(connected) {
    /** @type {InputRecord} */
    const record = {v: mapping.record.version, stop: true};

    const released = changed(controller.toMoonlight({...controller.NEUTRAL, connected}, []));
    if (released) record.pad = released;

    const lifted = touch.flush(forwarded);
    if (lifted.length) record.touch = lifted;

    return record;
  }

  /**
   * @param {Uint8Array} padBytes the selected NpadState
   * @param {Uint8Array | null} touchBytes the touch block, up to its last point
   */
  return function record(padBytes, touchBytes, allowed = true) {
    if (stopped) return null;

    const state = controller.decodePad(padBytes);
    if (controller.holds(state, controller.STOP_CHORD)) {
      stopped = true;
      return stopRecord(state.connected);
    }

    heldAcrossGate = allowed ? heldAcrossGate & state.buttons : state.buttons;
    const open = {...state, buttons: state.buttons & ~heldAcrossGate};
    const gated = {...controller.NEUTRAL, connected: state.connected};

    /** @type {InputRecord} */
    const result = {v: mapping.record.version};
    const pad = changed(controller.toMoonlight(allowed ? open : gated, []));
    if (pad) result.pad = pad;

    if (touchBytes) {
      const raw = touch.step(tracker, touch.parseTouch(touchBytes)).events;
      const events = allowed ? raw.filter(event => {
        if (event.action !== 'down' && !forwarded.active.has(event.id)) return false;
        if (event.action === 'up') forwarded.active.delete(event.id);
        else forwarded.active.set(event.id, {x: event.x, y: event.y});
        return true;
      }) : touch.flush(forwarded);
      if (events.length) result.touch = events;
    }

    if (!result.pad && !result.touch) return null;
    return result;
  };
}

/**
 * @param {unknown} value
 * @param {number} minimum
 * @param {number} maximum
 * @returns {value is number}
 */
function isInteger(value, minimum, maximum) {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

/** @param {unknown} value */
function isUnit(value) {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @param {boolean} exact all keys must be present
 * @returns {value is Record<string, unknown>}
 */
function hasKeys(value, keys, exact) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const present = Object.keys(value);
  const known = present.every(key => keys.includes(key));
  const complete = !exact || present.length === keys.length;
  return known && complete;
}

/**
 * @param {unknown} pad parsed JSON
 * @returns {pad is PadRecord}
 */
function isPad(pad) {
  if (!hasKeys(pad, ['connected', ...Object.keys(PAD_RANGES)], true)) return false;
  if (typeof pad.connected !== 'boolean') return false;

  return Object.entries(PAD_RANGES).every(([key, [minimum, maximum]]) => isInteger(pad[key], minimum, maximum));
}

/**
 * @param {unknown} event parsed JSON
 * @returns {event is import('./touch.js').TouchEvent}
 */
function isTouchEvent(event) {
  if (!hasKeys(event, TOUCH_KEYS, true)) return false;

  const idOk = isInteger(event.id, 0, 0xffffffff);
  const actionOk = typeof event.action === 'string' && TOUCH_ACTIONS.includes(event.action);
  const placeOk = isUnit(event.x) && isUnit(event.y) && isUnit(event.pressure);
  return idOk && actionOk && placeOk;
}

/**
 * @param {unknown} touch parsed JSON
 * @returns {touch is import('./touch.js').TouchEvent[]}
 */
function isTouch(touch) {
  if (!Array.isArray(touch)) return false;
  if (touch.length < 1 || touch.length > MAX_TOUCH_EVENTS) return false;

  return touch.every(isTouchEvent);
}

/**
 * @param {unknown} record parsed JSON
 * @returns {record is InputRecord}
 */
function isInputRecord(record) {
  if (!hasKeys(record, RECORD_KEYS, false)) return false;
  if (record.v !== INPUT_RECORD.version) return false;

  const padOk = record.pad === undefined || isPad(record.pad);
  const touchOk = record.touch === undefined || isTouch(record.touch);
  const stopOk = record.stop === undefined || record.stop === true;
  if (!padOk || !touchOk || !stopOk) return false;

  return record.pad !== undefined || record.touch !== undefined || record.stop !== undefined;
}

/**
 * PC side: parses and validates one encoded record.
 * @param {Buffer} bytes
 * @returns {InputRecord}
 */
function readInputRecord(bytes) {
  if (bytes.length < 1 || bytes.length > INPUT_RECORD.limit) throw Error('Invalid input record length');

  let record;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw Error('Invalid input record');
  }

  if (!isInputRecord(record)) throw Error('Invalid input record');
  return record;
}

export {INPUT_RECORD, MAX_TOUCH_EVENTS, createInputRecorder, readInputRecord};
