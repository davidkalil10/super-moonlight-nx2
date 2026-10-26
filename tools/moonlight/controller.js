// Console controller state -> moonlight-common-c gamepad state.
//
// The launcher worker writes the selected NpadState to binding 0 every frame
// (and five pad sources at 0x7f0000 + 640, see sdk/host/hardware.js). This
// module reads those bytes and maps them to the fields of
// LiSendMultiControllerEvent: buttonFlags (Limelight.h *_FLAG bits),
// leftTrigger/rightTrigger 0-255, stick axes int16 with Y up.
//
// Face buttons map by position by default (Nintendo B -> A_FLAG, A -> B_FLAG,
// Y -> X_FLAG, X -> Y_FLAG); layout 'labels' maps by printed letter. HOME and
// Capture are not in NpadState, so SPECIAL_FLAG is never set.

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
import {NPAD, NPAD_BYTES, readPad} from '../../../hbl-platform/sdk/host/npad.js';
import {OFFSET, FIELD} from '../../../hbl-platform/sdk/host/layout.js';
const PAD_SOURCES = {offset: OFFSET + FIELD.padSources, count: 5, stride: 64};

const FACE = {
  position: {b: FLAG.a, a: FLAG.b, y: FLAG.x, x: FLAG.y},
  labels: {a: FLAG.a, b: FLAG.b, x: FLAG.x, y: FLAG.y}
};
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

const NEUTRAL = {connected: false, buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0};

function decode(selected, sources) {
  const pad = readPad(selected);
  if (!sources) return pad.connected ? pad : NEUTRAL;
  let buttons = pad.connected ? pad.buttons : 0,
    connected = pad.connected;
  for (let i = 0; i < PAD_SOURCES.count; i++) {
    const source = readPad(sources, i * PAD_SOURCES.stride);
    if (!source.connected) continue;
    connected = true;
    buttons |= source.buttons;
  }
  if (!connected) return NEUTRAL;
  return pad.connected ? {...pad, buttons} : {...NEUTRAL, connected, buttons};
}

const int16 = value => Math.max(-32768, Math.min(32767, value | 0));

function toMoonlight(pad, layout = 'position') {
  const held = bit => (pad.buttons & bit) !== 0;
  let buttonFlags = 0;
  for (const [name, flag] of Object.entries({...FACE[layout], ...SHARED}))
    if (held(NPAD[name])) buttonFlags |= flag;
  if (held(NPAD.left) && held(NPAD.right)) buttonFlags &= ~(FLAG.left | FLAG.right);
  if (held(NPAD.up) && held(NPAD.down)) buttonFlags &= ~(FLAG.up | FLAG.down);
  return {
    connected: pad.connected,
    buttonFlags,
    leftTrigger: held(NPAD.zl) ? 255 : 0,
    rightTrigger: held(NPAD.zr) ? 255 : 0,
    leftStickX: int16(pad.lx),
    leftStickY: int16(pad.ly),
    rightStickX: int16(pad.rx),
    rightStickY: int16(pad.ry)
  };
}

function same(a, b) {
  return !!a && !!b && Object.keys(a).every(key => a[key] === b[key]);
}

async function readController(rpc, mapped, {sources = false} = {}) {
  const selected = await rpc.read(mapped, NPAD_BYTES);
  const extra = sources
    ? await rpc.read(mapped + PAD_SOURCES.offset, PAD_SOURCES.count * PAD_SOURCES.stride)
    : null;
  return decode(selected, extra);
}

export {FLAG, NPAD, NPAD_BYTES, PAD_SOURCES, NEUTRAL, decode, toMoonlight, same, readController};
