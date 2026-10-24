const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const hbv2 = require('./hbv2.cjs');

function scene(width, height, shift = 0) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3,
        sx = x + shift;
      rgb[at] = (sx * 3 + y) & 255;
      rgb[at + 1] = ((sx >> 2) ^ (y >> 3)) & 1 ? 230 : 20;
      rgb[at + 2] = Math.round(128 + 100 * Math.sin(sx / 9 + y / 13));
    }
  return rgb;
}

function planePsnr(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return sum ? 10 * Math.log10((255 * 255 * a.length) / sum) : 99;
}

const keyframe = (source, sequence, qp = 8) => hbv2.words(hbv2.encode(source, {sequence, qp}));

test('ue and se round trip through the bit reader', () => {
  const writer = new hbv2.BitWriter(),
    values = [0, 1, 2, 7, 8, 255, 4096, 70000];
  for (const v of values) writer.ue(v);
  for (const v of [0, -1, 1, -300, 300]) writer.se(v);
  writer.put(0x5a, 7);
  const reader = new hbv2.BitReader(writer.words, 0, writer.words.length, 0);
  assert.deepStrictEqual(
    values.map(() => reader.ue()),
    values
  );
  assert.deepStrictEqual(
    [0, -1, 1, -300, 300].map(() => reader.se()),
    [0, -1, 1, -300, 300]
  );
  assert.strictEqual(reader.bits(7), 0x5a);
});

test('integer IDCT inverts the forward DCT within rounding', () => {
  const pixels = Float64Array.from({length: 64}, (_, i) => ((i * 37) % 255) - 128);
  const coefficients = Int32Array.from(hbv2.forwardDct(pixels), Math.round),
    out = new Int32Array(64);
  hbv2.idct(coefficients, out);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(out[i] - pixels[i]) <= 1);
});

test('entries pack chunk index and bit offset; header and trailer agree', () => {
  const source = hbv2.toFrame(scene(320, 176), 320, 176),
    words = keyframe(source, 5),
    header = hbv2.readHeader(words);
  assert.strictEqual(header.kind, 2);
  assert.strictEqual(header.reference, 0);
  assert.strictEqual(header.count, hbv2.layout(320, 176).chunks);
  assert.strictEqual(words[hbv2.HEADER_WORDS] & (hbv2.MAX_CHUNKS - 1), 0);
  assert.strictEqual(words[hbv2.HEADER_WORDS] >>> hbv2.CHUNK_INDEX_BITS, 0);
  assert.strictEqual(words[header.trailer], 5);
  assert.strictEqual(words.length % (hbv2.EXCHANGE_BYTES / 4), 0);
});

test('keyframe decodes close to the source', () => {
  const source = hbv2.toFrame(scene(320, 176), 320, 176),
    decoder = new hbv2.Decoder();
  assert.strictEqual(decoder.step([keyframe(source, 1, 4)]), 1);
  assert.ok(planePsnr(source.y, decoder.frame.y) > 40);
  assert.strictEqual(decoder.applied, 1);
});

test('torn slot is rejected', () => {
  const words = keyframe(hbv2.toFrame(scene(64, 48), 64, 48), 9);
  words[words.length - 1] = 8;
  assert.strictEqual(hbv2.readHeader(words), null);
  assert.strictEqual(new hbv2.Decoder().step([words]), 0);
});

test('P frames apply in order and only on their reference', () => {
  const first = hbv2.toFrame(scene(320, 176), 320, 176),
    moved = hbv2.toFrame(scene(320, 176, 3), 320, 176),
    plan = () => ({mode: 'inter', mvx: 3, mvy: 0});
  const key = keyframe(first, 1, 4);
  const decoder = new hbv2.Decoder();
  decoder.step([key]);
  const reference = decoder.frame;
  const p2 = hbv2.words(
    hbv2.encode(moved, {sequence: 2, reference, referenceSequence: 1, qp: 8, plan})
  );
  const p3 = hbv2.words(
    hbv2.encode(moved, {sequence: 3, reference, referenceSequence: 2, qp: 8, plan})
  );
  const stray = hbv2.words(
    hbv2.encode(moved, {sequence: 4, reference, referenceSequence: 7, qp: 8, plan})
  );
  assert.strictEqual(decoder.pick([p3, stray, p2]), 2);
  assert.strictEqual(decoder.step([p3, stray, p2], 1), 1);
  assert.ok(planePsnr(moved.y, decoder.frame.y) > 35);
  assert.strictEqual(decoder.step([p3, stray, p2]), 1);
  assert.strictEqual(decoder.applied, 3);
  const fresh = new hbv2.Decoder();
  assert.strictEqual(fresh.step([p2, p3]), 0);
});

test('a newer keyframe wins over the P chain', () => {
  const source = hbv2.toFrame(scene(64, 48), 64, 48),
    decoder = new hbv2.Decoder();
  decoder.step([keyframe(source, 1)]);
  const p = hbv2.words(
    hbv2.encode(source, {
      sequence: 2,
      reference: decoder.frame,
      referenceSequence: 1,
      qp: 8,
      plan: () => ({mode: 'skip'})
    })
  );
  assert.strictEqual(decoder.pick([p, keyframe(source, 3)]), 1);
  assert.strictEqual(decoder.pick([p, keyframe(source, 2)]), 0);
});

test('skipped macroblocks are copied lazily from the previous frame', () => {
  const a = hbv2.toFrame(scene(64, 48), 64, 48),
    b = hbv2.toFrame(scene(64, 48, 5), 64, 48),
    decoder = new hbv2.Decoder();
  decoder.step([keyframe(a, 1, 4)]);
  const kept = Uint8Array.from(decoder.frame.y);
  const recode = mb => (mb === 0 ? {mode: 'intra'} : {mode: 'skip'});
  const p = sequence =>
    hbv2.words(
      hbv2.encode(b, {
        sequence,
        reference: decoder.frame,
        referenceSequence: sequence - 1,
        qp: 4,
        plan: recode
      })
    );
  decoder.step([p(2)]);
  decoder.step([p(3)]);
  const y = decoder.frame.y;
  for (let row = 0; row < 48; row++)
    for (let x = 16; x < 64; x++) assert.strictEqual(y[row * 64 + x], kept[row * 64 + x]);
});

test('generated tables match the checked-in headers', () => {
  const here = __dirname,
    shaders = path.join(here, '../../apps/moonlight/shaders');
  assert.strictEqual(fs.readFileSync(path.join(here, 'hbv2-tables.h'), 'utf8'), hbv2.cTables());
  const glsl = path.join(shaders, 'hbv2-tables.glsl');
  if (fs.existsSync(glsl)) assert.strictEqual(fs.readFileSync(glsl, 'utf8'), hbv2.glslTables());
});

function compiler() {
  for (const cc of ['gcc', 'cc'])
    try {
      execFileSync(cc, ['--version'], {stdio: 'ignore'});
      return cc;
    } catch {}
  return null;
}

test(
  'native encoder slots decode bit-exactly to its reconstruction',
  {skip: !compiler()},
  async () => {
    const build = fs.mkdtempSync(path.join(os.tmpdir(), 'hbv2enc-'));
    try {
      execFileSync('bash', [path.join(__dirname, 'build-hbv2enc.sh')], {
        env: {...process.env, HBV2_BUILD: build},
        stdio: 'ignore'
      });
      process.env.HBV2ENC = path.join(build, 'hbv2enc');
      const {Encoder} = require('./hbv2-encoder.cjs');
      const recon = path.join(build, 'recon.bin'),
        encoder = new Encoder({threads: 2, recon}),
        decoder = new hbv2.Decoder(),
        [width, height] = [320, 176],
        frameBytes = width * height * 1.5,
        emitted = [];
      for (let t = 0; t < 6; t++) {
        const result = await encoder.encode(scene(width, height, t * 2), width, height, {
          sequence: t + 1,
          budget: 12000,
          qpMax: 40,
          refresh: 1
        });
        if (result.slotBytes) emitted.push(hbv2.words(result.slot));
      }
      await encoder.close();
      const data = fs.readFileSync(recon);
      assert.strictEqual(data.length, emitted.length * frameBytes);
      emitted.forEach((words, i) => {
        assert.strictEqual(decoder.step([words]), 1);
        const frame = decoder.frame,
          at = i * frameBytes;
        assert.ok(Buffer.from(frame.y).equals(data.subarray(at, at + width * height)));
        assert.ok(
          Buffer.from(frame.cb).equals(
            data.subarray(at + width * height, at + width * height * 1.25)
          )
        );
        assert.ok(
          Buffer.from(frame.cr).equals(data.subarray(at + width * height * 1.25, at + frameBytes))
        );
      });
    } finally {
      fs.rmSync(build, {recursive: true, force: true});
    }
  }
);
