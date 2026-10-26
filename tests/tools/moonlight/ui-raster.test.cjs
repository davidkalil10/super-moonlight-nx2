// The rasteriser paints what ui-pages.js lays out; sizes and coverage are checked, never exact
// bytes, since they depend on the PIL and font builds of the host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createRaster} = require('../../../hbl-moonlight/tools/moonlight/ui-raster.js');

let pil = true;
try {
  execFileSync('python3', ['-c', 'import PIL'], {stdio: 'ignore'});
} catch {
  pil = false;
}
const ink = bytes => bytes.filter(byte => byte > 0).length;

test(
  'text strips are one line high, as wide as asked, and shortened to fit',
  {skip: !pil},
  async () => {
    const raster = createRaster();
    try {
      const strip = await raster.text('Desktop', 36, 400);
      assert.equal(strip.width, 400);
      assert.ok(strip.height > 30 && strip.height <= 96, 'line height ' + strip.height);
      assert.equal(strip.bytes.length, 400 * strip.height);
      assert.ok(ink(strip.bytes) > 200, 'the text left ink');
      const empty = await raster.text('', 36, 400);
      assert.equal(ink(empty.bytes), 0);
      const long = await raster.text('A'.repeat(200), 36, 120);
      assert.equal(long.width, 120);
      assert.ok(ink(long.bytes) > 0);
      const big = await raster.text('4821', 160, 600, 'center');
      assert.equal(big.height, 96, 'strips never exceed the page limit');
      const [left, right] = await Promise.all([
        raster.text('x', 36, 300),
        raster.text('x', 36, 300, 'right')
      ]);
      const firstInk = bytes => bytes.findIndex(byte => byte > 0) % 300;
      assert.ok(firstInk(left.bytes) < firstInk(right.bytes), 'alignment moves the ink');
    } finally {
      raster.close();
    }
  }
);

test(
  'cover tiles keep the aspect ratio and the letter tile carries initials',
  {skip: !pil},
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hbraster-'));
    const png = path.join(directory, 'cover.png');
    execFileSync('python3', [
      '-c',
      `from PIL import Image; Image.new('RGB', (300, 400), (200, 30, 30)).save(${JSON.stringify(png)})`
    ]);
    const raster = createRaster();
    try {
      const tile = await raster.tile(png, 160, 90);
      assert.equal(tile.width, 160);
      assert.equal(tile.height, 90);
      assert.equal(tile.bytes.length, 160 * 90 * 4);
      const alpha = x => tile.bytes[(45 * 160 + x) * 4 + 3];
      assert.equal(alpha(2), 0, 'a portrait cover leaves the sides transparent');
      assert.equal(alpha(80), 255, 'and fills the middle');
      assert.equal(tile.bytes[(45 * 160 + 80) * 4], 200, 'red channel first');
      const letters = await raster.letters('Elden Ring', 160, 90);
      assert.equal(letters.bytes.length, 160 * 90 * 4);
      const light = [];
      for (let i = 3; i < letters.bytes.length; i += 4) {
        assert.equal(letters.bytes[i], 255, 'opaque');
        if (letters.bytes[i - 3] > 200) light.push(i);
      }
      assert.ok(light.length > 100, 'initials in a light ink');
      const other = await raster.letters('Hades', 160, 90);
      assert.notDeepEqual(other.bytes.subarray(0, 4), letters.bytes.subarray(0, 4), 'hue per name');
      const truncated = path.join(directory, 'truncated.png');
      fs.writeFileSync(truncated, fs.readFileSync(png).subarray(0, 100));
      const broken = await raster.tile(truncated, 160, 90);
      assert.deepEqual(
        [broken.width, broken.height, broken.bytes.length],
        [0, 0, 0],
        'a cut file is refused'
      );
      const wide = path.join(directory, 'wide.png');
      execFileSync('python3', [
        '-c',
        `from PIL import Image; Image.new('L', (5000, 1)).save(${JSON.stringify(wide)})`
      ]);
      const oversized = await raster.tile(wide, 160, 90);
      assert.equal(oversized.width, 0, 'a cover over 4096 px is refused');
      assert.equal((await raster.tile(path.join(directory, 'missing.png'), 160, 90)).width, 0);
      const after = await raster.tile(png, 160, 90);
      assert.equal(after.width, 160, 'the child keeps serving after a refusal');
    } finally {
      raster.close();
      fs.rmSync(directory, {recursive: true, force: true});
    }
  }
);

test('weights, letter spacing, glyph fallback and the legend strip', {skip: !pil}, async () => {
  const raster = createRaster();
  try {
    const [medium, bold] = await Promise.all([
      raster.text('Settings', 40, 400, 'left', {weight: 500}),
      raster.text('Settings', 40, 400, 'left', {weight: 700})
    ]);
    assert.ok(ink(bold.bytes) > ink(medium.bytes), 'a heavier weight leaves more ink');
    const lastInk = strip => {
      let last = 0;
      strip.bytes.forEach((byte, i) => byte > 0 && (last = Math.max(last, i % strip.width)));
      return last;
    };
    const [tight, spaced] = await Promise.all([
      raster.text('FRAME RATE', 22, 600),
      raster.text('FRAME RATE', 22, 600, 'left', {tracking: 4})
    ]);
    assert.ok(lastInk(spaced) > lastInk(tight) + 30, 'tracking widens the line');
    const [arrow, box] = await Promise.all([
      raster.text('\u25c0', 40, 100),
      raster.text('\u0378', 40, 100)
    ]);
    assert.ok(ink(arrow.bytes) > 0, 'a glyph the UI font lacks still draws');
    assert.notDeepEqual(arrow.bytes, box.bytes, 'and is not the missing-glyph box');
    const legend = await raster.legend(
      [
        ['A', 'Launch'],
        ['B', 'PCs']
      ],
      26,
      800
    );
    assert.equal(legend.width, 800);
    assert.ok(legend.height >= 36 && legend.height <= 96, 'legend height ' + legend.height);
    assert.equal(lastInk(legend) < 400, true, 'two entries stay on the left');
    assert.ok(ink(legend.bytes) > 500, 'rings and labels left ink');
  } finally {
    raster.close();
  }
});

test('a dead rasteriser rejects what is queued', async () => {
  const {EventEmitter} = require('node:events');
  const {PassThrough} = require('node:stream');
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough()
  });
  const raster = createRaster({spawnProcess: () => child});
  const strip = raster.text('a', 36, 100);
  child.emit('exit', 1, null);
  await assert.rejects(strip, /ui-text.py exited: 1/);
  await assert.rejects(raster.text('b', 36, 100), /exited/);
});
