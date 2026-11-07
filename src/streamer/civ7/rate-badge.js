// The badge shown top right when a stream runs other than requested (rate, size, a codec or
// transport fallback): the PC composes it and the renderer draws it as a UI quad.
import {BADGE, BADGE_OFFSET, BADGE_BYTES, WIDTH, HEIGHT} from '../../renderer/civ7/layout.js';

/** @import {Civ7Rpc} from './transport.js' */
/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */

export const BADGE_MS = 4000;

const REFERENCE_HEIGHT = 1080;
const FONTS = [{size: 26, weight: 600}, {size: 24, weight: 600}, {size: 22, weight: 600}, {size: 18, weight: 700}];
const PADDING_X = 14;
const PADDING_Y = 4;
const MARGIN = 24;
const ACCENT_WIDTH = 4;
const MAX_WIDTH = 960;
const MAX_HEIGHT = 64;
const BACKGROUND = [12, 16, 24];
const INK = [240, 246, 250];
const ACCENT = [64, 217, 230];

/** @typedef {{height: number, fps: number}} StreamShape */
/** @typedef {{width: number, height: number}} FrameSize */
/** @typedef {{x: number, y: number, width: number, height: number, rgba: Uint8Array}} Badge */
/**
 * @typedef {{text: (text: string, size: number, width: number, align?: 'left' | 'center' | 'right',
 *   style?: {weight?: number}) => {width: number, height: number, bytes: Uint8Array}}} TextRaster
 */

const hex = (/** @type {number | bigint | string} */ value) => '0x' + BigInt(value).toString(16);
const even = (/** @type {number} */ value) => Math.round(value / 2) * 2;

/**
 * "AV1 ▸ H.264": what was asked for, then what runs. The atlas has no arrow.
 * @param {string} from
 * @param {string} to
 */
export function changeText(from, to) {
  return `${from} ▸ ${to}`;
}

/**
 * Several changes on one badge: "1080p120 ▸ 1080p60 · UDP ▸ TCP".
 * @param {string[]} changes
 */
export function badgeText(changes) {
  return changes.join(' · ');
}

/**
 * "1080p120 ▸ 1080p60" for a rate change, "1080p ▸ 720p" for a size change.
 * @param {StreamShape} from
 * @param {StreamShape} to
 */
export function rateChangeText(from, to) {
  const sameHeight = from.height === to.height;
  const sameRate = from.fps === to.fps;
  if (sameRate && !sameHeight) return changeText(`${from.height}p`, `${to.height}p`);

  return changeText(`${from.height}p${from.fps}`, `${to.height}p${to.fps}`);
}

/** @param {number} scale */
function fontFor(scale) {
  const wanted = FONTS[0].size * scale + 0.5;
  return FONTS.find(font => font.size <= wanted) || FONTS[FONTS.length - 1];
}

/** @param {{width: number, height: number, bytes: Uint8Array}} strip */
function inkWidth(strip) {
  for (let x = strip.width - 1; x >= 0; x--)
    for (let y = 0; y < strip.height; y++) if (strip.bytes[y * strip.width + x]) return x + 1;
  return 0;
}

/**
 * The badge in `frame` pixels, top right; the quad badge composes it at the display size.
 * @param {TextRaster} raster
 * @param {string} text
 * @param {FrameSize} frame
 * @returns {Badge}
 */
export function composeBadge(raster, text, frame) {
  const scale = frame.height / REFERENCE_HEIGHT;
  const font = fontFor(scale);
  const strip = raster.text(text, font.size, Math.floor(frame.width / 2), 'left', {weight: font.weight});
  const paddingX = even(PADDING_X * scale);
  const paddingY = even(PADDING_Y * scale);
  const accent = Math.max(2, even(ACCENT_WIDTH * scale));
  const width = even(inkWidth(strip) + accent + 2 * paddingX);
  const height = even(strip.height + 2 * paddingY);
  if (width > MAX_WIDTH || height > MAX_HEIGHT || width > frame.width || height > frame.height)
    throw Error('Badge does not fit the frame');

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const textX = x - accent - paddingX;
      const textY = y - paddingY;
      const inStrip = textX >= 0 && textX < strip.width && textY >= 0 && textY < strip.height;
      const alpha = inStrip ? strip.bytes[textY * strip.width + textX] / 255 : 0;
      const under = x < accent ? ACCENT : BACKGROUND;
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        rgba[at + channel] = Math.round(under[channel] + (INK[channel] - under[channel]) * alpha);
      rgba[at + 3] = 255;
    }
  }

  const margin = even(MARGIN * scale);
  return {x: frame.width - margin - width, y: margin, width, height, rgba};
}

/**
 * One stream's badge: `show` composes it at the display size, writes its pixels and rectangle
 * into private storage and asks the console to show the quad. Nothing to create or destroy; the
 * console hides it with its presentation. A failure is logged as `overlay-failed`.
 * @param {Pick<Civ7Rpc, 'write' | 'request'>} rpc
 * @param {{text: string, raster: TextRaster, storage: {mapped: number}, durationMs?: number,
 *   log?: (event: object) => void}} options
 */
export function createQuadBadge(rpc, {text, raster, storage, durationMs = BADGE_MS, log = event => {}}) {
  let failed = false;

  async function show() {
    if (failed) return;

    try {
      const badge = composeBadge(raster, text, {width: WIDTH, height: HEIGHT});
      if (badge.rgba.length > BADGE_BYTES) throw Error('Badge exceeds its pixel area');
      await rpc.write(storage.mapped + BADGE_OFFSET, Buffer.from(badge.rgba));
      const words = Buffer.alloc(20);
      [0, badge.x, badge.y, badge.width, badge.height].forEach((value, index) => words.writeUInt32LE(value, index * 4));
      await rpc.write(storage.mapped + BADGE.visible, words);
      await rpc.request({command: 'overlay-show', quad: hex(storage.mapped + BADGE.visible), durationMs});
      log({type: 'overlay-shown', text, x: badge.x, y: badge.y, width: badge.width, height: badge.height,
        durationMs, quad: true});
    } catch (error) {
      failed = true;
      log({type: 'overlay-failed', stage: 'show', text, message: String(/** @type {Error} */ (error)?.message || error)});
    }
  }

  return {text, prepare: async () => {}, show, close: async () => {}};
}

/**
 * The console half: `overlay-show` sets the quad's visible word and arms the badge; while armed
 * each present counts toward `durationMs` after the first such present, then hides it. Hidden,
 * the present pays one property read. Shipped by toString().
 * @param {Pick<ConsoleNative, 'address' | 'integer' | 'checkMemory' | 'write32'> & {now?: () => number}} native
 */
export function createOverlay(native) {
  const {address, integer, checkMemory, write32} = native;
  const now = native.now || (() => Date.now());
  let attached = false;
  let durationMs = 0;
  let until = 0;
  /** @type {bigint | null} */
  let visible = null;

  /** @param {boolean} shown */
  function setVisible(shown) {
    if (visible !== null) write32(visible, shown ? 1n : 0n);
  }

  const overlay = {
    armed: false,

    /** Called by createPresentation; a badge armed before it shows again. */
    attach() {
      attached = true;
      if (overlay.armed) setVisible(true);
      return overlay;
    },

    /** The presentation is gone; its stream's badge goes with it. */
    detach() {
      overlay.hide();
      attached = false;
      visible = null;
    },

    frame() {
      const at = now();
      if (!until) until = at + durationMs;
      else if (at >= until) overlay.hide();
    },

    /** @param {ConsoleRequest} request */
    show(request) {
      if (!attached) throw Error('No presentation for the overlay');
      const word = address(request.quad);
      checkMemory(word, 4, 3);

      overlay.hide();
      visible = word;
      durationMs = integer(request.durationMs, 1, 60000);
      until = 0;
      overlay.armed = true;
      setVisible(true);
      return {armed: true};
    },

    hide() {
      if (overlay.armed) setVisible(false);
      overlay.armed = false;
      return {armed: false};
    }
  };
  return overlay;
}
