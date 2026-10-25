// Feeds the same frames and requests to the hbv2enc process and to
// hbv2-encode-check (hbv2enc.c linked in process, as hbmoonlight-host does) and
// fails on the first slot or stat that differs. Build both from one compiler
// (tools/moonlight/helper/build.sh builds both targets).
// Usage: node tools/moonlight/helper/encode-check.cjs BUILD_DIR CLIP [--frames 120]
//        [--size 1920x1080]
const path = require('node:path');
const {spawn} = require('node:child_process');
const {Encoder} = require('../../../../hbl-moonlight/tools/moonlight/hbv2-encoder.cjs');

const FIELDS = ['sequence', 'slotBytes', 'qp', 'intra', 'inter', 'skip', 'deferred', 'keyframe'];

function encoder(file) {
  process.env.HBV2ENC = file;
  return new Encoder();
}

async function* frames(file, width, height, count) {
  const ffmpeg = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', String(count)].concat([
      '-vf',
      `scale=${width}:${height}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ]),
    {stdio: ['ignore', 'pipe', 'inherit']}
  );
  const bytes = width * height * 3;
  let pending = Buffer.alloc(0);
  for await (const chunk of ffmpeg.stdout) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= bytes) {
      yield pending.subarray(0, bytes);
      pending = pending.subarray(bytes);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const [build, clip] = args;
  if (!build || !clip) throw Error('Usage: encode-check.cjs BUILD_DIR CLIP [--frames 120]');
  const option = (name, fallback) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const count = Number(option('--frames', 120));
  const [width, height] = option('--size', '1920x1080').split('x').map(Number);
  const process_ = encoder(path.join(build, 'hbv2enc'));
  const linked = encoder(path.join(build, 'hbv2-encode-check'));
  let index = 0,
    bytes = 0;
  for await (const rgb of frames(clip, width, height, count)) {
    const options = {
      sequence: index + 1,
      keyframe: index === 0 || index === Math.floor(count / 2),
      budget: (index % 3 ? 96 : 48) * 1024,
      cap: 256 * 1024,
      qpMin: 4,
      qpMax: 40,
      refresh: 2
    };
    const [a, b] = await Promise.all([
      process_.encode(rgb, width, height, options),
      linked.encode(rgb, width, height, options)
    ]);
    for (const field of FIELDS)
      if (a[field] !== b[field]) throw Error(`frame ${index}: ${field} ${a[field]} != ${b[field]}`);
    if (!a.slot.equals(b.slot)) throw Error(`frame ${index}: slot bytes differ`);
    bytes += a.slotBytes;
    index++;
  }
  await Promise.all([process_.close(), linked.close()]);
  console.log(`${index} frames identical, ${Math.round(bytes / 1024)} KiB of slots`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
