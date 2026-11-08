// The badge shown top right when a stream runs other than requested (rate, size, a codec
// fallback), or all stream long with the stream info setting, and the frame counter
// line under it: the PC composes it and the renderer draws it as a UI quad.
import {BADGE, BADGE_OFFSET, BADGE_BYTES, WIDTH, HEIGHT} from '../../renderer/civ7/layout.js';

/** @import {Civ7Rpc} from './transport.js' */
/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */

export const BADGE_MS = 4000;
/** A badge with this duration stays until its stream's presentation ends (stream info). */
export const BADGE_STAYS = 0;
/** How long a note a stream raises mid-way (`note`) stays up. */
export const NOTE_MS = 7000;
/** The note when the PC's Sunshine takes no touch: its Input setting, as its web UI names it. */
export const TOUCH_NOTE = 'Touch is off on this PC · enable Native Pen/Touch Support in Sunshine';

const REFERENCE_HEIGHT = 1080;
const FONTS = [{size: 26, weight: 600}, {size: 24, weight: 600}, {size: 22, weight: 600}, {size: 18, weight: 700}];
const PADDING_X = 14;
const PADDING_Y = 4;
const MARGIN = 24;
const ACCENT_WIDTH = 4;
const MAX_WIDTH = 960;
const MAX_HEIGHT = 96;
const BACKGROUND = [12, 16, 24];
const INK = [240, 246, 250];
const ACCENT = [64, 217, 230];

/** @typedef {{height: number, fps: number}} StreamShape */
/** @typedef {{width: number, height: number}} FrameSize */
/**
 * `counter` is where a counter line's rows start and where its text sits, in badge rows.
 * @typedef {{x: number, y: number, width: number, height: number, rgba: Uint8Array,
 *   counter?: {from: number, top: number}}} Badge
 */
/**
 * One civ7-stats second (stream.js): `dropped` counts the whole stream.
 * @typedef {{type: 'civ7-stats', presented: number, caughtUp?: number, dropped?: number}} CounterStats
 */
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
 * Several changes on one badge: "1080p120 ▸ 1080p60 · AV1 ▸ H.264".
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

/**
 * The frame counter line: frames presented in the last second, then those decoded but skipped
 * to catch up and those dropped before decode.
 * @param {{presented: number | string, caughtUp: number | string, dropped: number | string}} counts
 */
export function counterText({presented, caughtUp, dropped}) {
  return `${presented} fps · ${caughtUp} skipped · ${dropped} dropped`;
}

/** The counter line before the first second, and the widest one, which sets the badge width. */
const COUNTER_START = counterText({presented: '-', caughtUp: '-', dropped: '-'});
const COUNTER_WIDEST = counterText({presented: 888, caughtUp: 888, dropped: 888});

/**
 * Calls `note` with TOUCH_NOTE the first time the helper reports that the host takes no touch
 * (`{"event":"touch","supported":false}`, protocol/src/input.c), and never again.
 * @param {(text: string) => void} note
 */
export function createTouchNotice(note) {
  let noted = false;
  return (/** @type {object} */ event) => {
    if (noted || !('event' in event) || event.event !== 'touch') return;
    if (!('supported' in event) || event.supported !== false) return;

    noted = true;
    note(TOUCH_NOTE);
  };
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

/** @param {FrameSize} frame */
function metrics(frame) {
  const scale = frame.height / REFERENCE_HEIGHT;
  return {font: fontFor(scale), paddingX: even(PADDING_X * scale), paddingY: even(PADDING_Y * scale),
    accent: Math.max(2, even(ACCENT_WIDTH * scale)), margin: even(MARGIN * scale)};
}

/**
 * @param {TextRaster} raster @param {string} text @param {FrameSize} frame
 * @param {{size: number, weight: number}} font
 */
function line(raster, text, frame, font) {
  return raster.text(text, font.size, Math.floor(frame.width / 2), 'left', {weight: font.weight});
}

/**
 * Badge rows `from` to `to` into `rgba`, which starts at row `from`: the accent, the background
 * and `strip` with its first row at badge row `top`.
 * @param {Uint8Array} rgba @param {number} width @param {number} from @param {number} to
 * @param {{width: number, height: number, bytes: Uint8Array}} strip @param {number} top
 * @param {ReturnType<typeof metrics>} metric
 */
function paintRows(rgba, width, from, to, strip, top, metric) {
  for (let y = from; y < to; y++) {
    for (let x = 0; x < width; x++) {
      const textX = x - metric.accent - metric.paddingX;
      const textY = y - top;
      const inStrip = textX >= 0 && textX < strip.width && textY >= 0 && textY < strip.height;
      const alpha = inStrip ? strip.bytes[textY * strip.width + textX] / 255 : 0;
      const under = x < metric.accent ? ACCENT : BACKGROUND;
      const at = ((y - from) * width + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        rgba[at + channel] = Math.round(under[channel] + (INK[channel] - under[channel]) * alpha);
      rgba[at + 3] = 255;
    }
  }
}

/**
 * The badge in `frame` pixels, top right; the quad badge composes it at the display size. With
 * `counter`, a frame counter line follows `text` (or stands alone when `text` is empty), as wide
 * as the widest counter so the badge keeps its size as the numbers change.
 * @param {TextRaster} raster
 * @param {string} text
 * @param {FrameSize} frame
 * @param {string | null} [counter]
 * @returns {Badge}
 */
export function composeBadge(raster, text, frame, counter = null) {
  const metric = metrics(frame);
  const lines = counter === null ? [text] : [...(text ? [text] : []), counter];
  const strips = lines.map(entry => line(raster, entry, frame, metric.font));
  const sized = counter === null ? strips : [...strips, line(raster, COUNTER_WIDEST, frame, metric.font)];
  const lineHeight = strips[0].height;
  const width = even(Math.max(...sized.map(inkWidth)) + metric.accent + 2 * metric.paddingX);
  const height = even(lineHeight * lines.length + 2 * metric.paddingY);
  if (width > MAX_WIDTH || height > MAX_HEIGHT || width > frame.width || height > frame.height)
    throw Error('Badge does not fit the frame');

  const rgba = new Uint8Array(width * height * 4);
  const tops = strips.map((_, index) => metric.paddingY + index * lineHeight);
  strips.forEach((strip, index) => {
    const from = index ? tops[index] : 0;
    const to = index === strips.length - 1 ? height : tops[index + 1];
    paintRows(rgba.subarray(from * width * 4), width, from, to, strip, tops[index], metric);
  });

  const x = frame.width - metric.margin - width;
  const badge = {x, y: metric.margin, width, height, rgba};
  if (counter === null) return badge;

  const last = tops.length - 1;
  return {...badge, counter: {from: last ? tops[last] : 0, top: tops[last]}};
}

/**
 * The counter rows of a badge composed with a counter line, painted with `counter`, and their
 * byte offset in the badge pixels: one contiguous write.
 * @param {TextRaster} raster
 * @param {Badge} badge
 * @param {string} counter
 * @param {FrameSize} frame
 */
export function composeCounter(raster, badge, counter, frame) {
  if (!badge.counter) throw Error('The badge has no counter line');

  const metric = metrics(frame);
  const {from, top} = badge.counter;
  const rgba = new Uint8Array((badge.height - from) * badge.width * 4);
  paintRows(rgba, badge.width, from, badge.height, line(raster, counter, frame, metric.font), top, metric);
  return {offset: from * badge.width * 4, rgba};
}

/**
 * One stream's badge: `show` composes it at the display size, writes its pixels and rectangle
 * into private storage and asks the console to show the quad for `durationMs` (BADGE_STAYS:
 * until the stream ends). Nothing to create or destroy; the console hides it with its
 * presentation. With `counter`, `observe` takes the stream's events and, on each civ7-stats
 * second, rewrites only the counter rows when its line changes. `note` puts a line in its place
 * for NOTE_MS, then a staying badge comes back. A failure is logged as `overlay-failed`.
 * @param {Pick<Civ7Rpc, 'write' | 'request'>} rpc
 * @param {{text: string, raster: TextRaster, storage: {mapped: number}, durationMs?: number,
 *   counter?: boolean, log?: (event: object) => void}} options
 */
export function createQuadBadge(rpc, {text, raster, storage, durationMs = BADGE_MS, counter = false,
  log = event => {}}) {
  const frame = {width: WIDTH, height: HEIGHT};
  let failed = false;
  /** @type {Badge | null} */
  let shown = null;
  let counted = COUNTER_START;
  let dropped = 0;
  let writing = Promise.resolve();
  /** @type {NodeJS.Timeout | undefined} */
  let restore;

  /** @param {string} stage @param {unknown} error */
  function fail(stage, error) {
    failed = true;
    log({type: 'overlay-failed', stage, text, message: String(/** @type {Error} */ (error)?.message || error)});
  }

  /** @param {Badge} badge @param {string} line @param {number} ms */
  async function put(badge, line, ms) {
    if (badge.rgba.length > BADGE_BYTES) throw Error('Badge exceeds its pixel area');
    await rpc.write(storage.mapped + BADGE_OFFSET, Buffer.from(badge.rgba));
    const words = Buffer.alloc(20);
    [0, badge.x, badge.y, badge.width, badge.height].forEach((value, index) => words.writeUInt32LE(value, index * 4));
    await rpc.write(storage.mapped + BADGE.visible, words);
    await rpc.request({command: 'overlay-show', quad: hex(storage.mapped + BADGE.visible), durationMs: ms});
    log({type: 'overlay-shown', text: line, x: badge.x, y: badge.y, width: badge.width, height: badge.height,
      durationMs: ms, quad: true});
  }

  async function show() {
    if (failed) return;

    try {
      const badge = composeBadge(raster, text, frame, counter ? counted : null);
      await put(badge, text, durationMs);
      shown = badge;
    } catch (error) {
      fail('show', error);
    }
  }

  /** @param {string} line */
  function note(line) {
    writing = writing.then(async () => {
      if (failed) return;

      const back = durationMs === BADGE_STAYS && shown !== null;
      shown = null;
      try {
        await put(composeBadge(raster, line, frame), line, back ? BADGE_STAYS : NOTE_MS);
        if (back) restore = setTimeout(() => void show(), NOTE_MS);
      } catch (error) {
        fail('note', error);
      }
    });
    return writing;
  }

  /** @param {object} event */
  function observe(event) {
    if (!counter || !('type' in event) || event.type !== 'civ7-stats') return writing;

    const {presented, caughtUp = 0, dropped: total = 0} = /** @type {CounterStats} */ (event);
    const line = counterText({presented, caughtUp, dropped: Math.max(0, total - dropped)});
    dropped = total;
    if (line === counted) return writing;

    counted = line;
    writing = writing.then(async () => {
      if (failed || !shown || line !== counted) return;
      try {
        const rows = composeCounter(raster, shown, line, frame);
        await rpc.write(storage.mapped + BADGE_OFFSET + rows.offset, Buffer.from(rows.rgba));
      } catch (error) {
        fail('count', error);
      }
    });
    return writing;
  }

  return {text, prepare: async () => {}, show, observe, note,
    close: () => { clearTimeout(restore); return writing; }};
}

/**
 * The console half: `overlay-show` sets the quad's visible word and arms the badge; while armed
 * each present counts toward `durationMs` after the first such present, then hides it; a
 * duration of 0 (BADGE_STAYS) stays until detach. Hidden, the present pays one property read.
 * Shipped by toString().
 * @param {Pick<ConsoleNative, 'address' | 'integer' | 'checkMemory' | 'write32'> & {now?: () => number}} native
 */
export function createOverlay(native) {
  const {address, integer, checkMemory, write32} = native;
  const now = native.now || (() => Date.now());
  const STAYS = 0;
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
      if (durationMs === STAYS) return;

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
      durationMs = integer(request.durationMs, STAYS, 60000);
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
