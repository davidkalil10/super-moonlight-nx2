// HBV2 against HBV1 at 1080p over a simulated bridge link. Each run replays a
// 60 fps sequence: whenever the link is free the sender takes the newest
// frame (its encode overlapping the previous write), the write costs one
// 32 KiB exchange per started 32 KiB, and the console shows a frame from the
// first vsync after its write lands. Displayed PSNR compares what the screen
// shows at every vsync with the source frame of that vsync, so dropped
// frames count against it. All PSNR figures are luma.
// Usage: node tools/moonlight/evaluate-hbv2.cjs OUT SEQUENCE... [--frames N]
//        [--budgets 64,96,128,160] [--rates 5.7,12] [--crop x,y,w,h]
// A SEQUENCE is raw 1920x1080 RGB24 (.rgb) or any video ffmpeg can open.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const hbv = require('../../../hbl-moonlight/tools/moonlight/hbv.cjs');
const hbv2 = require('../../../hbl-moonlight/tools/moonlight/hbv2.cjs');
const {psnr} = require('../../../hbl-moonlight/tools/moonlight/reference.cjs');
const {Encoder} = require('../../../hbl-moonlight/tools/moonlight/hbv2-encoder.cjs');
const cli = require('../../../hbl-platform/sdk/cli.cjs');

const WIDTH = 1920,
  HEIGHT = 1080,
  CODED_HEIGHT = 1088,
  FRAME_BYTES = WIDTH * HEIGHT * 3,
  RECON_BYTES = (WIDTH * CODED_HEIGHT * 3) / 2,
  TICK_MS = 1000 / 60,
  EXCHANGE = hbv2.EXCHANGE_BYTES;

function rawSequence(file, out) {
  if (file.endsWith('.rgb')) return file;
  const raw = path.join(out, path.basename(file).replace(/\.[^.]+$/, '') + '.rgb');
  if (!fs.existsSync(raw)) {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf'];
    args.push(`scale=${WIDTH}:${HEIGHT}:flags=bicubic`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw);
    if (spawnSync('ffmpeg', args, {stdio: 'inherit'}).status) throw Error('ffmpeg failed');
  }
  return raw;
}

function readFrame(fd, index) {
  const rgb = Buffer.alloc(FRAME_BYTES);
  fs.readSync(fd, rgb, 0, FRAME_BYTES, index * FRAME_BYTES);
  return rgb;
}

function padRows(rgb) {
  const row = WIDTH * 3,
    padded = Buffer.alloc(row * CODED_HEIGHT);
  rgb.copy(padded);
  for (let y = HEIGHT; y < CODED_HEIGHT; y++) rgb.copy(padded, y * row, (HEIGHT - 1) * row);
  return padded;
}

function luma(rgb) {
  const y = new Uint8Array(WIDTH * HEIGHT);
  for (let i = 0; i < y.length; i++)
    y[i] = Math.min(
      255,
      Math.round(0.299 * rgb[3 * i] + 0.587 * rgb[3 * i + 1] + 0.114 * rgb[3 * i + 2])
    );
  return y;
}

function reconFrame(file, index) {
  const fd = fs.openSync(file, 'r'),
    buffer = Buffer.alloc(RECON_BYTES);
  fs.readSync(fd, buffer, 0, RECON_BYTES, index * RECON_BYTES);
  fs.closeSync(fd);
  const frame = hbv2.createFrame(WIDTH, CODED_HEIGHT),
    chroma = frame.cb.length;
  frame.y.set(buffer.subarray(0, frame.y.length));
  frame.cb.set(buffer.subarray(frame.y.length, frame.y.length + chroma));
  frame.cr.set(buffer.subarray(frame.y.length + chroma));
  return frame;
}

// Returns the sent frames as {capture, shownAt, bytes, y, rgb?} plus codec stats.
async function sendHbv2(fd, count, budget, exchangeMs, out, keepLast) {
  const recon = path.join(out, 'recon.yuv'),
    encoder = new Encoder({recon}),
    sent = [];
  let linkFree = 0,
    capture = -1,
    encodeMs = 0,
    reconCount = 0,
    lastEncode = 0;
  try {
    for (;;) {
      const index = Math.max(capture + 1, Math.floor((linkFree - lastEncode) / TICK_MS));
      if (index >= count) break;
      capture = index;
      const result = await encoder.encode(readFrame(fd, index), WIDTH, HEIGHT, {
        sequence: sent.length + 1,
        keyframe: sent.length === 0,
        budget: budget * 1024,
        cap: 256 * 1024,
        qpMin: 4,
        qpMax: 40,
        refresh: 2
      });
      lastEncode = result.encodeMicros / 1000;
      encodeMs += lastEncode;
      if (!result.slotBytes) {
        linkFree = Math.max(linkFree, (index + 1) * TICK_MS);
        continue;
      }
      const start = Math.max(linkFree, index * TICK_MS + lastEncode),
        landed = start + Math.ceil(result.slotBytes / EXCHANGE) * exchangeMs,
        frame = reconFrame(recon, reconCount++);
      sent.push({
        capture: index,
        shownAt: Math.ceil(landed / TICK_MS),
        bytes: result.slotBytes,
        qp: result.qp,
        y: frame.y.subarray(0, WIDTH * HEIGHT),
        frame: keepLast ? frame : null
      });
      linkFree = landed;
    }
  } finally {
    await encoder.close();
    fs.rmSync(recon, {force: true});
  }
  return {sent, encodeMs: encodeMs / Math.max(1, capture + 1)};
}

function sendHbv1(fd, count, exchangeMs, keepLast) {
  const sent = [],
    exchanges = hbv.layout(WIDTH, CODED_HEIGHT).exchanges;
  let linkFree = 0,
    capture = -1;
  for (;;) {
    const index = Math.max(capture + 1, Math.floor(linkFree / TICK_MS));
    if (index >= count) break;
    capture = index;
    const slot = hbv.encode(padRows(readFrame(fd, index)), WIDTH, CODED_HEIGHT, sent.length + 1),
      rgb = hbv.decode(slot, WIDTH, CODED_HEIGHT).subarray(0, FRAME_BYTES),
      landed = Math.max(linkFree, index * TICK_MS) + exchanges * exchangeMs;
    sent.push({
      capture: index,
      shownAt: Math.ceil(landed / TICK_MS),
      bytes: slot.length,
      y: luma(rgb),
      rgb: keepLast ? rgb : null
    });
    linkFree = landed;
  }
  return {sent, encodeMs: 0};
}

function score(sent, sources) {
  let coded = 0,
    displayed = 0,
    shownTicks = 0,
    next = 0,
    showing = null;
  for (const frame of sent) coded += psnr(frame.y, sources[frame.capture]);
  for (let tick = 0; tick < sources.length; tick++) {
    while (next < sent.length && sent[next].shownAt <= tick) showing = sent[next++].y;
    if (!showing) continue;
    displayed += psnr(showing, sources[tick]);
    shownTicks++;
  }
  const shown = sent.filter(frame => frame.shownAt < sources.length);
  return {
    fps: +((shown.length * 60) / sources.length).toFixed(1),
    kib: +(sent.reduce((sum, f) => sum + f.bytes, 0) / sent.length / 1024).toFixed(1),
    codedDb: +(coded / sent.length).toFixed(2),
    displayedDb: +(displayed / Math.max(1, shownTicks)).toFixed(2)
  };
}

function saveCrop(rgb, crop, file) {
  const [x, y, w, h] = crop,
    image = Buffer.alloc(w * h * 3);
  for (let row = 0; row < h; row++)
    rgb.copy(image, row * w * 3, ((y + row) * WIDTH + x) * 3, ((y + row) * WIDTH + x + w) * 3);
  const ppm = Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), image]);
  fs.writeFileSync(file.replace(/\.png$/, '.ppm'), ppm);
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', file.replace(/\.png$/, '.ppm'), file]);
  fs.rmSync(file.replace(/\.png$/, '.ppm'));
}

async function main() {
  const args = process.argv.slice(2),
    option = (name, fallback) => cli.option(args, name, fallback);
  const optionValues = new Set(
    ['--frames', '--budgets', '--rates', '--crop'].map(name => option(name))
  );
  const [out, ...inputs] = args.filter(arg => !arg.startsWith('--') && !optionValues.has(arg));
  if (!out || !inputs.length) throw Error('Usage: evaluate-hbv2.cjs OUT SEQUENCE...');
  fs.mkdirSync(out, {recursive: true});
  const limit = Number(option('--frames', Infinity)),
    budgets = option('--budgets', '64,96,128,160').split(',').map(Number),
    rates = option('--rates', '5.7,12').split(',').map(Number),
    crop = args.includes('--crop') ? option('--crop').split(',').map(Number) : null,
    rows = [];

  for (const input of inputs) {
    const raw = rawSequence(input, out),
      name = path.basename(raw, '.rgb'),
      fd = fs.openSync(raw, 'r'),
      count = Math.min(limit, Math.floor(fs.statSync(raw).size / FRAME_BYTES)),
      sources = Array.from({length: count}, (_, i) => luma(readFrame(fd, i)));
    for (const rate of rates) {
      const exchangeMs = (EXCHANGE / (rate * 1e6)) * 1000,
        runs = [['HBV1', null], ...budgets.map(budget => ['HBV2', budget])];
      for (const [codec, budget] of runs) {
        const {sent, encodeMs} =
          codec === 'HBV1'
            ? sendHbv1(fd, count, exchangeMs, crop)
            : await sendHbv2(fd, count, budget, exchangeMs, out, crop);
        const row = {
          sequence: name,
          rate,
          codec,
          budget: budget ?? 288,
          ...score(sent, sources),
          encodeMs: +encodeMs.toFixed(1)
        };
        rows.push(row);
        console.log(JSON.stringify(row));
        if (crop) {
          const last = sent[sent.length - 1],
            rgb = last.rgb ?? hbv2.toRgb(last.frame, WIDTH, HEIGHT),
            label = codec === 'HBV1' ? 'hbv1' : `hbv2-${budget}k`;
          saveCrop(rgb, crop, path.join(out, `${name}-${rate}MBs-${label}.png`));
        }
      }
    }
    if (crop) saveCrop(readFrame(fd, count - 1), crop, path.join(out, `${name}-source.png`));
    fs.closeSync(fd);
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(rows, null, 2) + '\n');
}

main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
