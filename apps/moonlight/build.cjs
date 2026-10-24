// Generates the HBV decoder include, ring constants, a test-card frame for
// the initial private memory, the text atlas, then compiles the shaders.
const fs = require('node:fs/promises'), path = require('node:path');
const {execFileSync} = require('node:child_process');
const ring = require('./ring.cjs');

function root() {
  let directory = __dirname;
  while (!require('node:fs').existsSync(path.join(directory, 'sdk/build.cjs'))) {
    const up = path.dirname(directory);
    if (up === directory) throw Error('HBLauncher root not found');
    directory = up;
  }
  return directory;
}

function testCard(width, height) {
  const bars = [[235, 235, 235], [235, 235, 16], [16, 235, 235], [16, 235, 16], [235, 16, 235], [235, 16, 16], [16, 16, 235]];
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const color = y < height * 2 / 3 ? bars[Math.floor(x * bars.length / width)] : Array(3).fill(Math.round(x * 255 / (width - 1)));
      color.forEach((value, c) => { rgb[(y * width + x) * 3 + c] = value; });
    }
  return rgb;
}

async function main() {
  const hbv = require(path.join(root(), 'tools/moonlight/hbv.cjs'));
  const state = Buffer.alloc(1024);
  state.writeFloatLE(1, 960);
  await fs.writeFile(path.join(__dirname, 'assets/state.bin'), state);
  await fs.writeFile(path.join(__dirname, 'shaders/hbv.glsl'), hbv.glsl());
  await fs.writeFile(path.join(__dirname, 'shaders/ring.glsl'), ring.glsl());
  const [width, height] = ring.TEST_CARD;
  await fs.writeFile(path.join(__dirname, 'assets/memory.bin'), hbv.encode(testCard(width, height), width, height, 1));
  execFileSync('python3', [path.join(__dirname, 'assets.py')], {stdio: 'inherit'});
  await require(path.join(root(), 'sdk/build.cjs')).buildApp(__dirname);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {testCard};
