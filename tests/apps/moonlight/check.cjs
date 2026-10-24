// Desktop check: exit handling through the compute shader, then the real
// fragment shader rendered offscreen on desktop Vulkan and compared with the
// JS reference decoder. Optional: node check.cjs CLIP to also test a video frame.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const ring = require('./ring.cjs');
const {testCard} = require('./build.cjs');

const root = path.resolve(__dirname, '../..');
const hbv = require(path.join(root, 'tools/moonlight/hbv.cjs'));
const {psnr} = require(path.join(root, 'tools/moonlight/reference.cjs'));
const {readFrames} = require(path.join(root, 'tools/moonlight/frames.cjs'));

async function exitChecks(dir) {
  for (const [name, buttons, connected, previous, want] of [
    ['idle', 0, 1, 0, 0],
    ['B', 2, 1, 0, 1],
    ['Minus', 2048, 1, 0, 1],
    ['held B', 2, 1, 2, 0],
    ['disconnected', 2, 0, 0, 0]
  ]) {
    const state = Buffer.alloc(1024),
      input = Buffer.alloc(64);
    state.writeUInt32LE(previous, 84);
    state.writeFloatLE(1, 960);
    input.writeUInt32LE(buttons, 8);
    input.writeUInt32LE(connected, 32);
    await fs.writeFile(path.join(dir, 'state'), state);
    await fs.writeFile(path.join(dir, 'input'), input);
    execFileSync(
      path.join(root, 'homebrew-launcher/game-compute-check'),
      [
        path.join(dir, 'state'),
        path.join(dir, 'output'),
        path.join(__dirname, 'app.comp.spv'),
        path.join(dir, 'input'),
        '1'
      ],
      {stdio: 'pipe'}
    );
    assert.equal((await fs.readFile(path.join(dir, 'output'))).readUInt32LE(1016), want, name);
  }
}

// game-render binds its data file as both the atlas and binding 1.
async function render(dir, memory) {
  await fs.writeFile(path.join(dir, 'state'), Buffer.alloc(1024));
  await fs.writeFile(path.join(dir, 'memory'), memory);
  execFileSync(
    path.join(root, 'homebrew-launcher/game-render'),
    [path.join(dir, 'state'), path.join(dir, 'memory'), __dirname, path.join(dir, 'frame.rgba')],
    {env: {...process.env, HB_SHADER_PREFIX: 'app', HB_PRIVATE_VM: '1'}, stdio: 'pipe'}
  );
  const rgba = await fs.readFile(path.join(dir, 'frame.rgba')),
    rgb = Buffer.alloc(1920 * 1080 * 3);
  for (let i = 0; i < 1920 * 1080; i++) rgba.copy(rgb, i * 3, i * 4, i * 4 + 3);
  return rgb;
}

async function compare(dir, name, rgb, width, height) {
  const memory = Buffer.alloc(ring.MEMORY_BYTES);
  hbv.encode(rgb, width, height, 5).copy(memory, ring.slotOffset(5));
  const gpu = await render(dir, memory);
  const reference = hbv.decode(
    memory.subarray(ring.slotOffset(5), ring.slotOffset(5) + ring.SLOT_BYTES),
    1920,
    1080
  );
  const score = psnr(gpu, reference);
  console.log(`${name}: GPU shader vs JS decoder at 1920x1080, PSNR ${score.toFixed(1)} dB`);
  assert.ok(score > 40, name + ' shader output differs from the reference decoder');
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moonlight-check-'));
  await exitChecks(dir);
  const waiting = await render(dir, Buffer.alloc(ring.MEMORY_BYTES));
  assert.ok(waiting.readUInt8(0) < 40, 'Empty ring should show the waiting screen');
  const [width, height] = ring.TEST_CARD;
  await compare(dir, 'test card', testCard(width, height), width, height);
  if (process.argv[2])
    for await (const frame of readFrames(process.argv[2], width, height, 1))
      await compare(dir, path.basename(process.argv[2]), frame, width, height);
  console.log('Passed: B/Minus exit, waiting screen, HBV1 shader decode.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
