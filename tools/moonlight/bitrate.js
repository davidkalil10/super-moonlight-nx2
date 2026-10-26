/**
 * Moonlight's default bitrate: the Shield's resolution table, interpolated by pixel count, scaled
 * linearly with frame rate up to 60 and by its square root beyond. `--bitrate` overrides it.
 */

/** Pixel count and bitrate factor pairs, in increasing pixel count. */
const TABLE = [
  [640 * 360, 1],
  [854 * 480, 2],
  [1280 * 720, 5],
  [1920 * 1080, 10],
  [2560 * 1440, 20],
  [3840 * 2160, 40]
];
/** Above this frame rate the bitrate grows with the square root of the rate. */
const LINEAR_FPS = 60;
/** Frame rate the table factors are given for. */
const TABLE_FPS = 30;
const KBPS_PER_FACTOR = 1000;
const MIN_KBPS = 500;
const MAX_KBPS = 150000;

/**
 * Table factor for a pixel count, interpolated between the surrounding rows.
 * @param {number} pixels
 * @returns {number}
 */
function tableFactor(pixels) {
  for (let i = 0; i < TABLE.length; i++) {
    const [limit, value] = TABLE[i];
    if (pixels > limit) continue;
    if (i === 0 || pixels === limit) return value;
    const [lower, base] = TABLE[i - 1];
    return ((pixels - lower) / (limit - lower)) * (value - base) + base;
  }
  return TABLE.at(-1)[1];
}

/**
 * Default bitrate in kbps.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @returns {number}
 */
function defaultBitrate(width, height, fps) {
  const factor = tableFactor(width * height);
  const rate = (fps <= LINEAR_FPS ? fps : Math.sqrt(fps / LINEAR_FPS) * LINEAR_FPS) / TABLE_FPS;
  return Math.round(factor * rate) * KBPS_PER_FACTOR;
}

/**
 * The bitrate in kbps, as a string: `--bitrate N` from args, or the default for `--bitrate auto`
 * or no flag.
 * @param {string[]} args
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @returns {string}
 */
function bitrate(args, width, height, fps) {
  const at = args.indexOf('--bitrate');
  if (at < 0 || args[at + 1] === 'auto') return String(defaultBitrate(width, height, fps));
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value < MIN_KBPS || value > MAX_KBPS)
    throw Error('--bitrate is auto or 500..150000 kbps');
  return String(value);
}

export {defaultBitrate, bitrate};
