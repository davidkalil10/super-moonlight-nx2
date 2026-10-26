// Desktop decode check: encodes a clip in each candidate format, decodes it
// with shader-equivalent math and reports bytes/frame, bridge exchanges per
// frame and PSNR. Usage: node tools/moonlight/evaluate.cjs CLIP [--frames N] [--json OUT]
const fs = require('node:fs/promises');
const hbv = require('../../../hbl-moonlight/tools/moonlight/hbv.js');
const {
  bc1,
  yuv420,
  bilinear,
  psnr,
  changedFraction
} = require('../../../hbl-moonlight/tools/moonlight/reference.js');
const {readFrames} = require('../../../hbl-moonlight/tools/moonlight/frames.js');
const cli = require('../../../hbl-platform/sdk/cli.js');

const EXCHANGE_MS = 13;
const DISPLAY = [1280, 720];

const hbvFormat = {
  name: 'HBV1',
  bytes: (width, height) => hbv.layout(width, height).slotBytes,
  payload: (width, height) => hbv.layout(width, height).payloadBytes,
  encode: (rgb, width, height, sequence) => hbv.encode(rgb, width, height, sequence),
  decode: (data, width, height) => hbv.decode(data, width, height),
  upscale: (data, outWidth, outHeight) => hbv.decode(data, outWidth, outHeight),
  blockBytes: hbv.MACROBLOCK_WORDS * 4,
  lumaRange: (width, height) => [hbv.HEADER_WORDS * 4, hbv.layout(width, height).payloadBytes - 4]
};
const bc1Format = {
  ...bc1,
  payload: bc1.bytes,
  blockBytes: 8,
  lumaRange: (w, h) => [0, bc1.bytes(w, h)]
};
const yuvFormat = {
  ...yuv420,
  payload: yuv420.bytes,
  blockBytes: 64,
  lumaRange: (w, h) => [0, w * h]
};

const NATIVE = [
  [bc1Format, 1280, 720],
  [yuvFormat, 1280, 720],
  [hbvFormat, 1280, 720],
  [bc1Format, 960, 540],
  [yuvFormat, 960, 540],
  [hbvFormat, 960, 544]
];
const BUDGET = [
  [yuvFormat, 192, 108],
  [bc1Format, 320, 180],
  [hbvFormat, 640, 352],
  [yuvFormat, 256, 144],
  [bc1Format, 448, 252],
  [hbvFormat, 864, 480]
];

function exchanges(bytes) {
  return Math.ceil(bytes / hbv.EXCHANGE_BYTES);
}

async function measure(clip, format, width, height, frames, upscale) {
  const source = readFrames(clip, width, height, frames)[Symbol.asyncIterator]();
  const reference = upscale ? readFrames(clip, ...DISPLAY, frames)[Symbol.asyncIterator]() : null;
  const native = [],
    shown = [],
    changed = [];
  let previous = null,
    sequence = 0,
    payload = 0;
  for (;;) {
    const {value: rgb, done} = await source.next();
    if (done) break;
    const data = format.encode(rgb, width, height, ++sequence);
    payload = format.payload(width, height);
    native.push(psnr(rgb, format.decode(data, width, height)));
    const [start, end] = format.lumaRange(width, height);
    if (previous) changed.push(changedFraction(previous, data, format.blockBytes, start, end));
    previous = data;
    if (reference) {
      const {value: target} = await reference.next();
      const decoded = format.upscale
        ? format.upscale(data, ...DISPLAY)
        : bilinear(format.decode(data, width, height), width, height, ...DISPLAY);
      shown.push(psnr(target, decoded));
    }
  }
  const mean = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
  const count = exchanges(format.bytes(width, height));
  return {
    format: format.name,
    width,
    height,
    frames: native.length,
    payloadBytes: payload,
    bytesPerFrame: format.bytes(width, height),
    bitsPerPixel: (payload * 8) / (width * height),
    exchangesPerFrame: count,
    fpsAt13ms: Math.min(60, 1000 / (count * EXCHANGE_MS)),
    psnr: mean(native),
    psnrMin: Math.min(...native),
    psnrAt720p: mean(shown),
    changedLumaBlocks: mean(changed)
  };
}

function table(rows, upscaled) {
  const fixed = (value, digits = 1) => (value === null ? '-' : value.toFixed(digits));
  const head = [
    'format',
    'size',
    'bytes/frame',
    'bpp',
    'exch/frame',
    'fps@13ms',
    'PSNR',
    upscaled ? 'PSNR@720p' : 'min PSNR',
    'changed blocks'
  ];
  const lines = rows.map(r => [
    r.format,
    `${r.width}x${r.height}`,
    r.payloadBytes,
    fixed(r.bitsPerPixel, 2),
    r.exchangesPerFrame,
    fixed(r.fpsAt13ms),
    fixed(r.psnr, 2),
    upscaled ? fixed(r.psnrAt720p, 2) : fixed(r.psnrMin, 2),
    r.changedLumaBlocks === null ? '-' : (r.changedLumaBlocks * 100).toFixed(0) + '%'
  ]);
  return [head, head.map(() => '---'), ...lines]
    .map(line => '| ' + line.join(' | ') + ' |')
    .join('\n');
}

async function main() {
  const args = process.argv.slice(2),
    clip = args[0];
  if (!clip) throw Error('Usage: evaluate.cjs CLIP [--frames N] [--json OUT]');
  const frames = Number(cli.option(args, '--frames') || 30);
  const report = {clip, frames, exchangeMs: EXCHANGE_MS, native: [], budget: []};
  for (const [format, width, height] of NATIVE)
    report.native.push(await measure(clip, format, width, height, frames, false));
  for (const [format, width, height] of BUDGET)
    report.budget.push(await measure(clip, format, width, height, frames, true));
  console.log(
    `## ${clip} (${frames} frames)\n\nFull-size formats:\n\n${table(report.native, false)}\n`
  );
  console.log(
    `Budget-fitting (1 and 2 exchanges per frame), PSNR after upscale to 1280x720:\n\n${table(report.budget, true)}\n`
  );
  const json = cli.option(args, '--json');
  if (json) await fs.writeFile(json, JSON.stringify(report, null, 2) + '\n');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
