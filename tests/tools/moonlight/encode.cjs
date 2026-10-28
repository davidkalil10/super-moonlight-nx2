// Encodes a video file into a stream of HBV1 slots, the exact bytes the host
// would write into the app's frame ring (one slot per frame).
// Usage: node tools/moonlight/encode.cjs CLIP OUT.hbv [--size 640x352] [--frames N]
const fs = require('node:fs');
const hbv = require('../../../tools/moonlight/hbv.js');
const {readFrames} = require('../../../tools/moonlight/frames.js');
const cli = require('../../../../hbl-platform/sdk/cli.js');

async function main() {
  const args = process.argv.slice(2),
    [clip, output] = args;
  if (!clip || !output) throw Error('Usage: encode.cjs CLIP OUT.hbv [--size WxH] [--frames N]');
  const [width, height] = (cli.option(args, '--size') || '640x352').split('x').map(Number);
  const frames = Number(cli.option(args, '--frames') || Infinity);
  const map = hbv.layout(width, height),
    out = fs.createWriteStream(output);
  let sequence = 0,
    encodeMs = 0;
  for await (const rgb of readFrames(clip, width, height, frames)) {
    const started = process.hrtime.bigint();
    const slot = hbv.encode(rgb, width, height, ++sequence);
    encodeMs += Number(process.hrtime.bigint() - started) / 1e6;
    if (!out.write(slot)) await new Promise(resolve => out.once('drain', resolve));
  }
  await new Promise(resolve => out.end(resolve));
  console.log(
    JSON.stringify({
      output,
      width,
      height,
      frames: sequence,
      slotBytes: map.slotBytes,
      payloadBytes: map.payloadBytes,
      exchangesPerFrame: map.exchanges,
      encodeMsPerFrame: sequence ? +(encodeMs / sequence).toFixed(2) : 0
    })
  );
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
