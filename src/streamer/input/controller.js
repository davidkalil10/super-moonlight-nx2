/**
 * Console controller state (NpadState in binding 0) to moonlight-common-c gamepad fields
 * (LiSendMultiControllerEvent). Mapping rules are in CLAUDE.md.
 */
import {NPAD, NPAD_BYTES, readPad} from '../../../../hbl-platform/sdk/host/npad.js';
import {OFFSET, FIELD} from '../../../../hbl-platform/sdk/host/layout.js';

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
/** The extra pad sources: byte offset in the mapped state, NpadState count and spacing. */
const PAD_SOURCES = {offset: OFFSET + FIELD.padSources, count: 5, stride: 64};

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
/** ZL and ZR are digital, so a trigger is either released or fully pressed. */
const TRIGGER_PRESSED = 255;
const INT16_MIN = -32768;
const INT16_MAX = 32767;

const NEUTRAL = {connected: false, buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0};

/**
 * Decodes the selected pad. With pad sources, the buttons of every connected source are merged
 * in, and the result is connected when any of them is; sticks only come from the selected pad.
 * @param {Buffer} selected the selected NpadState
 * @param {Buffer | null} [sources] PAD_SOURCES.count NpadStates, PAD_SOURCES.stride apart
 * @returns {typeof NEUTRAL}
 */
function decode(selected, sources) {
  const pad = readPad(selected);
  if (!sources) return pad.connected ? pad : NEUTRAL;

  let buttons = pad.connected ? pad.buttons : 0;
  let connected = pad.connected;
  for (let i = 0; i < PAD_SOURCES.count; i++) {
    const source = readPad(sources, i * PAD_SOURCES.stride);
    if (!source.connected) continue;
    connected = true;
    buttons |= source.buttons;
  }

  if (!connected) return NEUTRAL;
  return pad.connected ? {...pad, buttons} : {...NEUTRAL, connected, buttons};
}

/**
 * @param {number} value
 * @returns {number}
 */
const int16 = value => Math.max(INT16_MIN, Math.min(INT16_MAX, value | 0));

/**
 * Parses a --start-chord value: NPAD button names joined by '+', or 'none' for no chord.
 * @param {string} text
 * @returns {string[]}
 */
function parseStartChord(text) {
  if (text === 'none') return [];

  const names = text.split('+');
  const known = {...FACE.position, ...SHARED};
  const tooFew = names.length < 2;
  const unknown = names.some(name => !(name in known));
  const repeated = new Set(names).size < names.length;
  if (tooFew || unknown || repeated)
    throw Error(`Invalid start chord ${text}: two or more of ${Object.keys(known).join(', ')}`);

  return names;
}

/**
 * Maps a decoded pad to LiSendMultiControllerEvent fields. Opposite d-pad directions held
 * together cancel out, and the start chord held in full becomes PC Start.
 * @param {typeof NEUTRAL} pad
 * @param {'position' | 'labels'} [layout]
 * @param {string[]} [startChord] NPAD button names, empty for no chord
 */
function toMoonlight(pad, layout = 'position', startChord = START_CHORD) {
  const held = bit => (pad.buttons & bit) !== 0;
  const flags = {...FACE[layout], ...SHARED};

  let buttonFlags = 0;
  for (const [name, flag] of Object.entries(flags)) {
    if (held(NPAD[name])) buttonFlags |= flag;
  }

  const chordHeld = startChord.length > 0 && startChord.every(name => held(NPAD[name]));
  if (chordHeld) {
    for (const name of startChord) buttonFlags &= ~flags[name];
    buttonFlags |= FLAG.play;
  }

  if (held(NPAD.left) && held(NPAD.right)) buttonFlags &= ~(FLAG.left | FLAG.right);
  if (held(NPAD.up) && held(NPAD.down)) buttonFlags &= ~(FLAG.up | FLAG.down);

  return {
    connected: pad.connected,
    buttonFlags,
    leftTrigger: held(NPAD.zl) ? TRIGGER_PRESSED : 0,
    rightTrigger: held(NPAD.zr) ? TRIGGER_PRESSED : 0,
    leftStickX: int16(pad.lx),
    leftStickY: int16(pad.ly),
    rightStickX: int16(pad.rx),
    rightStickY: int16(pad.ry)
  };
}

/**
 * True when both states exist and every field of `a` matches `b`.
 * @param {object | null | undefined} a
 * @param {object | null | undefined} b
 * @returns {boolean}
 */
function same(a, b) {
  return !!a && !!b && Object.keys(a).every(key => a[key] === b[key]);
}

/**
 * Reads and decodes the controller of a running app whose binding 0 is mapped at `mapped`.
 * @param {{read(address: number, bytes: number): Promise<Buffer>}} rpc
 * @param {number} mapped
 * @param {{sources?: boolean}} [options] also merge the pad sources (one more read)
 */
async function readController(rpc, mapped, {sources = false} = {}) {
  const selected = await rpc.read(mapped, NPAD_BYTES);

  let extra = null;
  if (sources) {
    extra = await rpc.read(mapped + PAD_SOURCES.offset, PAD_SOURCES.count * PAD_SOURCES.stride);
  }

  return decode(selected, extra);
}

export {
  FLAG,
  NPAD,
  NPAD_BYTES,
  PAD_SOURCES,
  NEUTRAL,
  START_CHORD,
  decode,
  toMoonlight,
  parseStartChord,
  same,
  readController
};
