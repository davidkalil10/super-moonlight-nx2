// Desktop check of the Moonlight shaders on desktop Vulkan through
// tools/moonlight/gpu-check.c, which runs compute + draw per frame like the
// launcher: exit handling, the waiting screen, the HBV2 test card, an HBV1
// slot, and an HBV2 P-frame chain with a torn slot and a stray reference.
// HBV2 planes must match the JS reference decoder bit for bit.
//   node check.cjs [CLIP]   CLIP also streams through the native encoder.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {testCard} = require('./build.cjs');

const root = path.resolve(__dirname, '../..');
const ring = require(path.join(root, 'tools/moonlight/ring.cjs'));
const {STATE} = require(path.join(root, 'sdk/host/state-layout.cjs'));
const {NPAD} = require(path.join(root, 'sdk/host/npad.cjs'));
const hbv = require(path.join(root, 'tools/moonlight/hbv.cjs'));
const hbv2 = require(path.join(root, 'tools/moonlight/hbv2.cjs'));
const {psnr} = require(path.join(root, 'tools/moonlight/reference.cjs'));
const {readFrames} = require(path.join(root, 'tools/moonlight/frames.cjs'));
const builds =
  process.env.HB_MOONLIGHT_CHECK_BUILDS ||
  path.join(os.homedir(), 'claude-builds/HBLauncher/gpu-check');

function harness() {
  const binary = path.join(builds, 'gpu-check');
  require('node:fs').mkdirSync(builds, {recursive: true});
  execFileSync('cc', [
    '-O2',
    path.join(root, 'tools/moonlight/gpu-check.c'),
    '-lvulkan',
    '-o',
    binary
  ]);
  return binary;
}

// Runs one frame on memory, then one more per patch ([offset, bytes]).
async function run(dir, memory, patches = [], state = Buffer.alloc(1024)) {
  await fs.writeFile(path.join(dir, 'state'), state);
  await fs.writeFile(path.join(dir, 'memory'), memory);
  const files = [];
  for (const [index, [offset, bytes]] of patches.entries()) {
    const file = path.join(dir, `patch${index}`),
      head = Buffer.alloc(4);
    head.writeUInt32LE(offset);
    await fs.writeFile(file, Buffer.concat([head, bytes]));
    files.push(file);
  }
  const report = JSON.parse(
    execFileSync(
      run.binary,
      [
        __dirname,
        path.join(dir, 'state'),
        path.join(__dirname, 'assets/text.bin'),
        path.join(dir, 'memory'),
        dir,
        ...files
      ],
      {env: {...process.env, HB_PRIVATE_BYTES: String(ring.MEMORY_BYTES)}}
    )
  );
  const rgba = await fs.readFile(path.join(dir, 'frame.rgba')),
    rgb = Buffer.alloc(1920 * 1080 * 3);
  for (let i = 0; i < 1920 * 1080; i++) rgba.copy(rgb, i * 3, i * 4, i * 4 + 3);
  return {
    report,
    rgb,
    state: await fs.readFile(path.join(dir, 'state.bin')),
    memory: await fs.readFile(path.join(dir, 'memory.bin'))
  };
}

async function exitChecks(dir) {
  for (const [name, buttons, connected, held, want] of [
    ['idle', 0, 1, 0, 0],
    ['B', NPAD.b, 1, 59, 0],
    ['Minus', NPAD.minus, 1, 59, 0],
    ['+/- first frame', NPAD.plus | NPAD.minus, 1, 0, 0],
    ['+/- short of one second', NPAD.plus | NPAD.minus, 1, 58, 0],
    ['+/- held one second', NPAD.plus | NPAD.minus, 1, 59, 1],
    ['disconnected', NPAD.plus | NPAD.minus, 0, 59, 0]
  ]) {
    const state = Buffer.alloc(1024);
    state.writeUInt32LE(buttons, 8);
    state.writeUInt32LE(connected, STATE.connected);
    state.writeUInt32LE(held, 784);
    state.writeFloatLE(1, STATE.fade);
    const result = await run(dir, Buffer.alloc(ring.CONTROL_BYTES), [], state);
    assert.equal(result.state.readUInt32LE(STATE.exitRequest), want, name);
  }
}

async function nativeCheck(dir) {
  const memory = Buffer.alloc(ring.MEMORY_BYTES);
  (await fs.readFile(path.join(__dirname, 'assets/memory.bin'))).copy(memory);
  const width = 128,
    height = 96,
    index = 2;
  const frame = ring.frameOffset(index);
  for (let y = 0; y < height; y++) {
    memory.fill(16, frame + y * width, frame + y * width + width / 2);
    memory.fill(235, frame + y * width + width / 2, frame + (y + 1) * width);
  }
  memory.fill(128, frame + width * height, frame + (width * height * 3) / 2);
  for (const [field, value] of Object.entries({
    nativeSequence: 1,
    nativeIndex: index,
    nativeWidth: width,
    nativeHeight: height,
    nativeStride: width,
    nativeSliceHeight: height,
    nativeColor: 1,
    nativeCommit: ring.nativeChecksum(1, [index, width, height, width, height, 1])
  }))
    memory.writeUInt32LE(value, ring.CONTROL[field]);
  const shown = await run(dir, memory);
  assert.equal(shown.memory.readUInt32LE(ring.CONTROL.mode), ring.MODE.native);
  assert.equal(shown.memory.readUInt32LE(ring.CONTROL.nativeApplied), 1);
  assert.equal(shown.memory.readUInt32LE(ring.CONTROL.nativeReady), ring.NATIVE_ABI);
  assert.ok(
    shown.memory
      .subarray(frame, frame + (width * height * 3) / 2)
      .equals(memory.subarray(frame, frame + (width * height * 3) / 2))
  );
  const pixel = x => [...shown.rgb.subarray((540 * 1920 + x) * 3, (540 * 1920 + x) * 3 + 3)];
  assert.deepEqual(pixel(20), [0, 0, 0], 'native letterbox');
  assert.deepEqual(pixel(400), [0, 0, 0], 'limited-range black');
  assert.deepEqual(pixel(1500), [255, 255, 255], 'limited-range white');
  const torn = Buffer.from(memory);
  torn.writeUInt32LE(0, ring.CONTROL.nativeCommit);
  const rejected = await run(dir, torn);
  assert.equal(rejected.memory.readUInt32LE(ring.CONTROL.nativeApplied), 0);
  console.log('Native NV12: metadata publication, limited-range sampling and letterboxing passed');
}

function samePlanes(memory, frame, name) {
  const gpu = ring.readFrame(memory, frame.width, frame.height);
  for (const plane of ['y', 'cb', 'cr'])
    assert.ok(
      Buffer.from(gpu[plane]).equals(Buffer.from(frame[plane])),
      `${name}: ${plane} differs`
    );
}

function control(memory) {
  return Object.fromEntries(
    Object.entries(ring.CONTROL)
      .filter(([name]) =>
        ['applied', 'applyCount', 'mode', 'current', 'size', 'hbv1Slot'].includes(name)
      )
      .map(([name, offset]) => [name, memory.readUInt32LE(offset)])
  );
}

const slotBytes = slot => Buffer.from(slot.buffer, slot.byteOffset, slot.byteLength);
const ringWords = (memory, sequence) =>
  new Uint32Array(
    memory.buffer.slice(ring.slotOffset(sequence), ring.slotOffset(sequence) + ring.SLOT_BYTES)
  );

function scene(width, height, shift) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3,
        sx = x + shift,
        sy = y + shift;
      rgb[at] = (sx * 3 + sy) & 255;
      rgb[at + 1] = ((sx >> 3) ^ (sy >> 4)) & 1 ? 220 : 30;
      rgb[at + 2] = Math.round(128 + 100 * Math.sin(sx / 23 + sy / 17));
    }
  return rgb;
}

async function testCardCheck(dir) {
  const memory = await fs.readFile(path.join(__dirname, 'assets/memory.bin'));
  const {rgb, memory: after, report} = await run(dir, memory);
  const decoder = new hbv2.Decoder();
  decoder.apply(ringWords(memory, ring.TEST_CARD_SEQUENCE));
  samePlanes(after, decoder.frame, 'test card');
  const score = psnr(rgb, hbv2.toRgb(decoder.frame, 1920, 1080));
  console.log(
    `test card: planes bit-exact, display vs JS ${score.toFixed(1)} dB, compute ${report.frames[0].computeMs} ms`
  );
  assert.ok(score > 45);
}

async function hbv1Check(dir) {
  const [width, height] = ring.TEST_CARD,
    memory = Buffer.alloc(ring.MEMORY_BYTES);
  hbv.encode(testCard(width, height), width, height, 5).copy(memory, ring.slotOffset(5));
  const {rgb, memory: after} = await run(dir, memory);
  assert.equal(after.readUInt32LE(ring.CONTROL.mode), ring.MODE.hbv1);
  const shown = (height * 1920) / width,
    slot = memory.subarray(ring.slotOffset(5), ring.slotOffset(5) + ring.SLOT_BYTES);
  const score = psnr(rgb.subarray(0, shown * 1920 * 3), hbv.decode(slot, 1920, shown));
  console.log(`HBV1 slot: display vs JS ${score.toFixed(1)} dB`);
  assert.ok(score > 40);
}

// Keyframe, then P frames mixing skip, inter and intra blocks. Patch 2 is
// torn and patch 3 references a frame that was never shown: both are ignored.
// The last patch holds two P frames, which one dispatch must apply in order.
async function chainCheck(dir) {
  const [width, height] = [1920, 1088],
    decoder = new hbv2.Decoder(),
    patches = [],
    plan = mb => [{mode: 'skip'}, {mode: 'inter', mvx: 3, mvy: -2}, {mode: 'intra'}][mb % 3];
  const key = hbv2.encode(hbv2.toFrame(scene(width, height, 0), width, height), {
    sequence: 1,
    qp: 30
  });
  decoder.apply(hbv2.words(key));
  patches.push([ring.slotOffset(1), key]);
  for (let sequence = 2; sequence <= 7; sequence++) {
    const slot = hbv2.encode(hbv2.toFrame(scene(width, height, sequence * 3), width, height), {
      sequence,
      reference: decoder.frame,
      referenceSequence: sequence - 1,
      qp: 40,
      plan
    });
    if (sequence === 3) {
      const torn = Buffer.from(slot);
      torn.writeUInt32LE(sequence + 8, torn.length - 4);
      const stray = hbv2.encode(hbv2.toFrame(scene(width, height, 1), width, height), {
        sequence: 6,
        reference: decoder.frame,
        referenceSequence: 42,
        qp: 40,
        plan
      });
      patches.push([ring.slotOffset(3), torn], [ring.slotOffset(6), stray]);
    }
    decoder.apply(hbv2.words(slot));
    if (sequence === 7) {
      const pair = Buffer.alloc(ring.SLOT_BYTES + slot.length);
      patches.pop()[1].copy(pair);
      slot.copy(pair, ring.SLOT_BYTES);
      patches.push([ring.slotOffset(6), pair]);
    } else patches.push([ring.slotOffset(sequence), slot]);
  }
  const {memory, rgb, report} = await run(dir, Buffer.alloc(ring.MEMORY_BYTES), patches);
  assert.deepEqual(control(memory), {
    applied: 7,
    applyCount: 7,
    mode: ring.MODE.hbv2,
    current: decoder.current,
    size: width | (height << 16),
    hbv1Slot: 0
  });
  samePlanes(memory, decoder.frame, 'P chain');
  const score = psnr(rgb, hbv2.toRgb(decoder.frame, 1920, 1080));
  const times = report.frames.map(f => f.computeMs.toFixed(2)).join(' ');
  console.log(
    `1080p P chain with catch-up: planes bit-exact, display ${score.toFixed(1)} dB, compute ms ${times}`
  );
  assert.ok(score > 45);
}

async function clipCheck(dir, clip) {
  const {Encoder} = require(path.join(root, 'tools/moonlight/hbv2-encoder.cjs'));
  const encoder = new Encoder(),
    decoder = new hbv2.Decoder(),
    patches = [];
  let sequence = 0;
  for await (const frame of readFrames(clip, 1920, 1080, 6)) {
    const result = await encoder.encode(frame, 1920, 1080, {
      sequence: ++sequence,
      budget: 96 * 1024,
      refresh: 2
    });
    if (!result.slotBytes) continue;
    decoder.apply(hbv2.words(result.slot));
    patches.push([ring.slotOffset(result.sequence), result.slot]);
  }
  await encoder.close();
  const {memory, report} = await run(dir, Buffer.alloc(ring.MEMORY_BYTES), patches);
  samePlanes(memory, decoder.frame, path.basename(clip));
  const times = report.frames.map(f => f.computeMs.toFixed(2)).join(' ');
  console.log(
    `${path.basename(clip)}: native slots decode bit-exact on the GPU, compute ms ${times}`
  );
}

async function main() {
  run.binary = harness();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moonlight-check-'));
  try {
    await exitChecks(dir);
    const waiting = await run(dir, Buffer.alloc(ring.CONTROL_BYTES));
    assert.ok(waiting.rgb.readUInt8(0) < 40, 'Empty memory should show the waiting screen');
    await testCardCheck(dir);
    await nativeCheck(dir);
    await hbv1Check(dir);
    await chainCheck(dir);
    if (process.argv[2]) await clipCheck(dir, process.argv[2]);
    console.log(
      'Passed: exit, waiting screen, native NV12, HBV2 test card, HBV1 slot, HBV2 P chain.'
    );
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
