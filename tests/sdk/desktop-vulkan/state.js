/**
 * The binding-0 control block as the desktop.vulkan backend drives it: the initial state, the
 * `hb-desktop-frame-script` v1 input script, the per-frame words the host writes before each
 * compute dispatch and the decoder of the words a run reports.
 *
 * Ownership: the host writes buttons (+8) and connected (+32) every frame and nothing else the
 * app owns. The clock is a provider: `host` (the default, time service 2) writes the fixed-step
 * clock t(N) in whole milliseconds at +48 and the frame index N at +52 before each dispatch;
 * `none` writes nothing. Neither touches time (+64) or frames (+88), which the current
 * hello-world shader advances itself. Other offsets come from layout.js.
 */
import fs from 'node:fs';
import {STATE, STATE_BYTES, CONNECTED_BIT} from '../../../hbl-platform/sdk/host/layout.js';
import {NPAD} from '../../../hbl-platform/sdk/host/npad.js';

const SCRIPT_FORMAT = 'hb-desktop-frame-script';
const SCRIPT_VERSION = 1;
const MAX_FRAMES = 3600;
/** Largest backend data image; data ends below the host extension block at 0x7f0000. */
const MAX_DATA_BYTES = 7 * 1024 * 1024;
const WORD_BYTES = 4;
const MAX_WRITES = 64;
/** Time service 2 words in raw[3].xy, unused by every ABI-1 shader and host. */
const CLOCK_MS = STATE.clockMs;
const FRAME_INDEX = STATE.frameIndex;
/** The clock word is a u32 of milliseconds; a script must stay below its wrap. */
const CLOCK_LIMIT_MS = 2 ** 32;

/** @typedef {[offset: number, value: number]} Write A u32 the host stores before a dispatch. */

/**
 * @typedef {object} Snapshot
 * @property {number} frame
 * @property {boolean} connected
 * @property {string[]} buttons
 * @property {number} mask
 */

/**
 * @typedef {object} FrameScript
 * @property {number} frameCount
 * @property {{mode: 'fixed-step', originMs: number, rateHz: number}} clock
 * @property {Snapshot[]} inputs Indexed by frame.
 */

/**
 * @typedef {object} Clock
 * @property {string} mode
 * @property {(script: FrameScript, frame: number) => Write[]} writes
 */

/**
 * @param {unknown} value
 * @param {string} message
 */
const check = (value, message) => {
  if (!value) throw Error(message);
};

/** @returns {Buffer} A zeroed control block with the screen fully faded in. */
function initialState() {
  const state = Buffer.alloc(STATE_BYTES);
  state.writeFloatLE(1, STATE.fade);
  return state;
}

/** @param {Buffer} state */
function checkState(state) {
  check(
    Buffer.isBuffer(state) && state.length === STATE_BYTES,
    'Initial state must be exactly ' + STATE_BYTES + ' bytes'
  );
}

/** @param {Buffer} data */
function checkData(data) {
  check(
    Buffer.isBuffer(data) &&
      data.length > 0 &&
      data.length % WORD_BYTES === 0 &&
      data.length <= MAX_DATA_BYTES,
    'Data must be 1 to ' + MAX_DATA_BYTES + ' bytes in whole words'
  );
}

/**
 * @param {string[]} buttons Button names as the manifest writes them (B, MINUS, ...).
 * @returns {number} The NPAD mask.
 */
function buttonMask(buttons) {
  check(Array.isArray(buttons), 'Buttons must be a list');
  let mask = 0;
  for (const name of buttons) {
    const bit = typeof name === 'string' ? NPAD[name.toLowerCase()] : undefined;
    check(bit !== undefined, 'Unknown button: ' + name);
    mask |= bit;
  }
  return mask >>> 0;
}

/**
 * @param {unknown} json The parsed script.
 * @returns {FrameScript}
 */
function parseFrameScript(json) {
  const script = /** @type {Record<string, any>} */ (json);
  check(script && typeof script === 'object', 'Frame script must be an object');
  check(script.format === SCRIPT_FORMAT, 'Not an ' + SCRIPT_FORMAT);
  check(script.version === SCRIPT_VERSION, 'Unsupported frame script version');
  const {frameCount, clock, inputs} = script;
  check(
    Number.isInteger(frameCount) && frameCount > 0 && frameCount <= MAX_FRAMES,
    'Invalid frameCount'
  );
  check(
    clock &&
      clock.mode === 'fixed-step' &&
      Number.isFinite(clock.originMs) &&
      Number.isFinite(clock.rateHz) &&
      clock.rateHz > 0,
    'Invalid clock'
  );
  const lastMs = clock.originMs + ((frameCount - 1) * 1000) / clock.rateHz;
  check(clock.originMs >= 0 && lastMs < CLOCK_LIMIT_MS, 'Clock must stay within 0 and 2^32 ms');
  check(Array.isArray(inputs) && inputs.length === frameCount, 'Need one input per frame');
  const snapshots = inputs.map((input, index) => {
    check(input && input.frame === index, 'Input ' + index + ' must be frame ' + index);
    check(typeof input.connected === 'boolean', 'Frame ' + index + ' connected must be boolean');
    check(Array.isArray(input.buttons), 'Frame ' + index + ' buttons must be a list');
    return {
      frame: index,
      connected: input.connected,
      buttons: [...input.buttons],
      mask: buttonMask(input.buttons)
    };
  });
  return {
    frameCount,
    clock: {mode: 'fixed-step', originMs: clock.originMs, rateHz: clock.rateHz},
    inputs: snapshots
  };
}

/**
 * @param {string | object} source A script file, or the parsed script itself.
 * @returns {FrameScript}
 */
const loadFrameScript = source =>
  parseFrameScript(
    typeof source === 'string' ? JSON.parse(fs.readFileSync(source, 'utf8')) : source
  );

/**
 * @param {Snapshot} snapshot
 * @returns {Write[]} Buttons and connected, the only input words the host owns.
 */
const inputWrites = snapshot => [
  [STATE.buttons, snapshot.mask],
  [STATE.connected, snapshot.connected ? CONNECTED_BIT : 0]
];

/**
 * @param {Buffer} state A control block.
 * @param {Write[]} writes
 */
function applyWrites(state, writes) {
  checkState(state);
  for (const [offset, value] of writes) state.writeUInt32LE(value >>> 0, offset);
}

/**
 * @param {Buffer} state
 * @param {Snapshot} snapshot
 */
const applyFrameInput = (state, snapshot) => applyWrites(state, inputWrites(snapshot));

/**
 * @param {FrameScript} script
 * @param {number} frame Zero-based.
 */
const frameTimeMs = (script, frame) => script.clock.originMs + (frame * 1000) / script.clock.rateHz;

/** @type {Record<string, Clock>} */
const CLOCKS = {
  host: {
    mode: 'host-fixed-step',
    writes: (script, frame) => [
      [CLOCK_MS, Math.floor(frameTimeMs(script, frame))],
      [FRAME_INDEX, frame]
    ]
  },
  none: {mode: 'none', writes: () => []}
};

/**
 * @param {string} [name] `host` (default) or `none`.
 * @returns {Clock}
 */
function clockProvider(name = 'host') {
  check(Object.hasOwn(CLOCKS, name), 'Unknown clock provider: ' + name);
  return CLOCKS[name];
}

/**
 * The runner's frame file: per frame a u32 write count, then u32 offset/value pairs.
 * @param {FrameScript} script
 * @param {Clock} [clock]
 * @returns {Buffer}
 */
function encodeFrames(script, clock = CLOCKS.host) {
  const words = [];
  for (const snapshot of script.inputs) {
    const writes = [...inputWrites(snapshot), ...clock.writes(script, snapshot.frame)];
    words.push(writes.length, ...writes.flat());
  }
  const bytes = Buffer.alloc(words.length * WORD_BYTES);
  words.forEach((word, index) => bytes.writeUInt32LE(word >>> 0, index * WORD_BYTES));
  return bytes;
}

/**
 * Checks a frame file the way the runner does, so a truncated record never reaches Vulkan.
 * @param {Buffer} bytes
 * @returns {number} The frame count.
 */
function checkFrames(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length % WORD_BYTES === 0, 'Truncated frame file');
  let at = 0;
  let frames = 0;
  while (at < bytes.length) {
    const count = bytes.readUInt32LE(at);
    at += WORD_BYTES;
    check(count <= MAX_WRITES, 'Too many writes in frame ' + frames);
    check(at + count * 2 * WORD_BYTES <= bytes.length, 'Truncated input record in frame ' + frames);
    for (let i = 0; i < count; i++, at += 2 * WORD_BYTES) {
      const offset = bytes.readUInt32LE(at);
      check(
        offset % WORD_BYTES === 0 && offset + WORD_BYTES <= STATE_BYTES,
        'Write outside the control block in frame ' + frames
      );
    }
    frames++;
  }
  check(frames > 0, 'Frame file has no frames');
  return frames;
}

/**
 * The words a run reports.
 * @param {Buffer} state
 */
function decodeState(state) {
  checkState(state);
  return {
    buttons: state.readUInt32LE(STATE.buttons),
    connected: state.readUInt32LE(STATE.connected),
    clockMs: state.readUInt32LE(CLOCK_MS),
    frameIndex: state.readUInt32LE(FRAME_INDEX),
    time: state.readFloatLE(STATE.time),
    previousButtons: state.readUInt32LE(STATE.previousButtons),
    frames: state.readUInt32LE(STATE.frames),
    fade: state.readFloatLE(STATE.fade),
    exitRequest: state.readUInt32LE(STATE.exitRequest)
  };
}

export {
  MAX_DATA_BYTES,
  CLOCK_MS,
  FRAME_INDEX,
  initialState,
  checkState,
  checkData,
  buttonMask,
  parseFrameScript,
  loadFrameScript,
  inputWrites,
  applyFrameInput,
  frameTimeMs,
  clockProvider,
  encodeFrames,
  checkFrames,
  decodeState
};
