// Moonlight's default bitrate: the Shield's resolution table, interpolated by pixel count,
// scaled linearly with frame rate up to 60 and by its square root beyond.
const TABLE = [
  [640 * 360, 1],
  [854 * 480, 2],
  [1280 * 720, 5],
  [1920 * 1080, 10],
  [2560 * 1440, 20],
  [3840 * 2160, 40]
];

function defaultBitrate(width, height, fps) {
  const pixels = width * height;
  let factor = TABLE.at(-1)[1];
  for (let i = 0; i < TABLE.length; i++) {
    const [limit, value] = TABLE[i];
    if (pixels > limit) continue;
    if (i === 0 || pixels === limit) factor = value;
    else {
      const [lower, base] = TABLE[i - 1];
      factor = ((pixels - lower) / (limit - lower)) * (value - base) + base;
    }
    break;
  }
  const rate = (fps <= 60 ? fps : Math.sqrt(fps / 60) * 60) / 30;
  return Math.round(factor * rate) * 1000;
}

function bitrate(args, width, height, fps) {
  const at = args.indexOf('--bitrate');
  if (at < 0 || args[at + 1] === 'auto') return String(defaultBitrate(width, height, fps));
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value < 500 || value > 150000)
    throw Error('--bitrate is auto or 500..150000 kbps');
  return String(value);
}

module.exports = {defaultBitrate, bitrate};
