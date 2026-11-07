/**
 * Console controller state (NpadState in binding 0) to moonlight-common-c gamepad fields
 * (LiSendMultiControllerEvent). Mapping rules are in CLAUDE.md.
 */

/** NpadState button bits, from hbl-platform sdk/host/npad.js. */
const NPAD = {
  a: 1 << 0,
  b: 1 << 1,
  x: 1 << 2,
  y: 1 << 3,
  stickL: 1 << 4,
  stickR: 1 << 5,
  l: 1 << 6,
  r: 1 << 7,
  zl: 1 << 8,
  zr: 1 << 9,
  plus: 1 << 10,
  minus: 1 << 11,
  left: 1 << 12,
  up: 1 << 13,
  right: 1 << 14,
  down: 1 << 15
};

/** Bytes of one NpadState. */
const NPAD_BYTES = 40;

/**
 * The pad mapping as one self-contained function: civ7/payload.js ships it to the console with
 * toString(), so it reads nothing outside its argument (civ7/test/payload-scope.test.cjs).
 * @param {Record<string, number>} npad NPAD button bits
 */
function controllerMapping(npad) {
  /** Limelight.h button flags. */
  const FLAG = {
    up: 0x0001,
    down: 0x0002,
    left: 0x0004,
    right: 0x0008,
    play: 0x0010,
    back: 0x0020,
    lsClick: 0x0040,
    rsClick: 0x0080,
    lb: 0x0100,
    rb: 0x0200,
    special: 0x0400,
    a: 0x1000,
    b: 0x2000,
    x: 0x4000,
    y: 0x8000
  };
  /** NPAD face button to FLAG, per layout. */
  const FACE = {
    position: {b: FLAG.a, a: FLAG.b, y: FLAG.x, x: FLAG.y},
    labels: {a: FLAG.a, b: FLAG.b, x: FLAG.x, y: FLAG.y}
  };
  /** NPAD button to FLAG for everything but the face buttons and triggers. */
  const SHARED = {
    up: FLAG.up,
    down: FLAG.down,
    left: FLAG.left,
    right: FLAG.right,
    plus: FLAG.play,
    minus: FLAG.back,
    stickL: FLAG.lsClick,
    stickR: FLAG.rsClick,
    l: FLAG.lb,
    r: FLAG.rb
  };
  /** NPAD buttons that, held together, press PC Start in place of themselves. */
  const START_CHORD = ['stickL', 'stickR'];
  /** NPAD buttons that, held together, end the stream: upstream Moonlight's L+R+Select+Start. */
  const STOP_CHORD = ['l', 'r', 'minus', 'plus'];
  /** ZL and ZR are digital, so a trigger is either released or fully pressed. */
  const TRIGGER_PRESSED = 255;
  const INT16_MIN = -32768;
  const INT16_MAX = 32767;
  /** NpadState byte offsets, from hbl-platform sdk/host/npad.js. */
  const STATE = {buttons: 8, leftStick: 16, rightStick: 24, attributes: 32, stickY: 4};
  const CONNECTED_BIT = 1;

  const NEUTRAL = {connected: false, buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0};

  /**
   * @param {Uint8Array} bytes
   * @param {number} offset
   */
  const int32 = (bytes, offset) =>
    bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);

  /**
   * The NpadState fields the mapping uses, from plain bytes so it runs on the console too.
   * @param {Uint8Array} bytes
   * @returns {typeof NEUTRAL}
   */
  function readPad(bytes) {
    const leftStick = STATE.leftStick;
    const rightStick = STATE.rightStick;

    return {
      connected: (int32(bytes, STATE.attributes) & CONNECTED_BIT) !== 0,
      buttons: int32(bytes, STATE.buttons) >>> 0,
      lx: int32(bytes, leftStick),
      ly: int32(bytes, leftStick + STATE.stickY),
      rx: int32(bytes, rightStick),
      ry: int32(bytes, rightStick + STATE.stickY)
    };
  }

  /**
   * @param {Uint8Array} bytes the selected NpadState
   * @returns {typeof NEUTRAL}
   */
  function decodePad(bytes) {
    const pad = readPad(bytes);
    return pad.connected ? pad : NEUTRAL;
  }

  /**
   * @param {number} value
   * @returns {number}
   */
  const int16 = value => Math.max(INT16_MIN, Math.min(INT16_MAX, value | 0));

  /**
   * True when every button of a non-empty chord is held on the decoded pad.
   * @param {typeof NEUTRAL} pad
   * @param {string[]} chord NPAD button names
   * @returns {boolean}
   */
  function holds(pad, chord) {
    if (chord.length === 0) return false;

    return chord.every(name => (pad.buttons & npad[name]) !== 0);
  }

  /**
   * Maps a decoded pad to LiSendMultiControllerEvent fields. Opposite d-pad directions held
   * together cancel out, and the start chord held in full becomes PC Start.
   * @param {typeof NEUTRAL} pad
   * @param {'position' | 'labels'} [layout]
   * @param {string[]} [startChord] NPAD button names, empty for no chord
   */
  function toMoonlight(pad, layout = 'position', startChord = START_CHORD) {
    const held = (/** @type {number} */ bit) => (pad.buttons & bit) !== 0;
    /** @type {Record<string, number>} */
    const flags = {...FACE[layout], ...SHARED};

    let buttonFlags = 0;
    for (const [name, flag] of Object.entries(flags)) {
      if (held(npad[name])) buttonFlags |= flag;
    }

    if (holds(pad, startChord)) {
      for (const name of startChord) buttonFlags &= ~flags[name];
      buttonFlags |= FLAG.play;
    }

    if (held(npad.left) && held(npad.right)) buttonFlags &= ~(FLAG.left | FLAG.right);
    if (held(npad.up) && held(npad.down)) buttonFlags &= ~(FLAG.up | FLAG.down);

    return {
      connected: pad.connected,
      buttonFlags,
      leftTrigger: held(npad.zl) ? TRIGGER_PRESSED : 0,
      rightTrigger: held(npad.zr) ? TRIGGER_PRESSED : 0,
      leftStickX: int16(pad.lx),
      leftStickY: int16(pad.ly),
      rightStickX: int16(pad.rx),
      rightStickY: int16(pad.ry)
    };
  }

  /**
   * True when both states exist and every field of `a` matches `b`.
   * @param {Record<string, unknown> | null | undefined} a
   * @param {Record<string, unknown> | null | undefined} b
   * @returns {boolean}
   */
  function same(a, b) {
    return !!a && !!b && Object.keys(a).every(key => a[key] === b[key]);
  }

  return {FLAG, FACE, SHARED, START_CHORD, STOP_CHORD, NEUTRAL, readPad, decodePad, holds, toMoonlight, same};
}

const {FLAG, START_CHORD, STOP_CHORD, NEUTRAL, decodePad: decode, holds, toMoonlight, same} =
  controllerMapping(NPAD);

export {
  FLAG,
  NPAD,
  NPAD_BYTES,
  NEUTRAL,
  START_CHORD,
  STOP_CHORD,
  controllerMapping,
  decode,
  holds,
  toMoonlight,
  same
};
