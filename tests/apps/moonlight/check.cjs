// Desktop check of the Moonlight shaders on desktop Vulkan through
// tools/moonlight/gpu-check.c, which runs compute + draw per frame like the
// launcher: exit handling, the waiting screen, the HBV2 test card, an HBV1
// slot, and an HBV2 P-frame chain with a torn slot and a stray reference.
// HBV2 planes must match the JS reference decoder bit for bit.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {testCard} = require('../../../hbl-moonlight/apps/moonlight/build.js');

const moonlight = path.resolve(__dirname, '../../../hbl-moonlight');
const app = path.join(moonlight, 'apps/moonlight');
const backend = path.join(app, 'backends/hblauncher.gpu-app');
const platform = path.resolve(__dirname, '../../../hbl-platform');
const ring = require(path.join(moonlight, 'tools/moonlight/ring.js'));
const {STATE} = require(path.join(platform, 'sdk/host/layout.js'));
const {NPAD} = require(path.join(platform, 'sdk/host/npad.js'));
const hbv = require(path.join(moonlight, 'tools/moonlight/hbv.js'));
const hbv2 = require(path.join(moonlight, 'tools/moonlight/hbv2.js'));
const {psnr} = require(path.join(moonlight, 'tools/moonlight/reference.js'));
const uiPage = () => import(path.join(moonlight, 'host/ui/page.js'));
const builds =
  process.env.HB_MOONLIGHT_CHECK_BUILDS ||
  path.join(os.homedir(), 'claude-builds/HBLauncher/gpu-check');

function harness() {
  const binary = path.join(builds, 'gpu-check');
  require('node:fs').mkdirSync(builds, {recursive: true});
  execFileSync('cc', [
    '-O2',
    path.join(__dirname, '../../tools/moonlight/gpu-check.c'),
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
        backend,
        path.join(dir, 'state'),
        path.join(app, 'assets/text.bin'),
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
  (await fs.readFile(path.join(backend, 'memory.bin'))).copy(memory);
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
  const memory = await fs.readFile(path.join(backend, 'memory.bin'));
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

// A published page: the compute shader validates and applies it, moves the cursor on a press
// and writes one command per press; the fragment shader draws strips, images and the cursor
// over the background, or over the dimmed video for a raised overlay.
async function uiCheck(dir) {
  const {serialize, PAGE_FLAG, UI_OP} = await uiPage();
  const UI = ring.UI,
    EPOCH = 5;
  const red = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) red.writeUInt32LE(0xff0000ff, i * 4);
  const page = flags =>
    serialize({
      epoch: EPOCH,
      sequence: 1,
      flags,
      background: flags ? 0x80000000 : 0xff201008,
      cursorHome: 0,
      items: [
        {id: 7, x: 100, y: 200, w: 800, h: 60},
        {id: 9, x: 100, y: 280, w: 800, h: 60},
        {id: 11, x: 100, y: 360, w: 800, h: 60, flags: 1}
      ],
      texts: [{x: 120, y: 212, w: 8, h: 4, alpha: Buffer.alloc(32, 255), color: 0xffffffff}],
      images: [{x: 1000, y: 200, w: 2, h: 2, rgba: red}]
    });
  const published = async (flags, torn = false) => {
    const memory = Buffer.alloc(ring.MEMORY_BYTES);
    (await fs.readFile(path.join(backend, 'memory.bin'))).copy(memory);
    const bytes = page(flags);
    if (torn) bytes.writeUInt32LE(0xdeadbeef, 64 + 4);
    bytes.copy(memory, ring.UI_OFFSET);
    for (const [field, value] of Object.entries({
      uiMagic: ring.UI_MAGIC,
      uiEpoch: EPOCH,
      uiSequence: 1,
      uiPage: 0
    }))
      memory.writeUInt32LE(value, UI[field]);
    return memory;
  };
  const state = (buttons = 0, extra = {}) => {
    const bytes = Buffer.alloc(1024);
    bytes.writeUInt32LE(buttons, 8);
    bytes.writeUInt32LE(1, STATE.connected);
    for (const [offset, value] of Object.entries(extra)) bytes.writeUInt32LE(value, Number(offset));
    return bytes;
  };
  const word = (result, field) => result.memory.readUInt32LE(UI[field]);
  const pixel = (result, x, y) => [
    ...result.rgb.subarray((y * 1920 + x) * 3, (y * 1920 + x) * 3 + 3)
  ];

  const shown = await run(dir, await published(0), [], state());
  assert.equal(word(shown, 'uiApplied'), 1, 'page applied');
  assert.equal(word(shown, 'uiShown'), 0);
  assert.equal(word(shown, 'uiCursor'), 0);
  assert.equal(word(shown, 'cmdSequence'), 0);
  assert.deepEqual(pixel(shown, 50, 50), [8, 16, 32], 'page background replaces the video');
  assert.deepEqual(pixel(shown, 124, 214), [255, 255, 255], 'text strip');
  assert.deepEqual(pixel(shown, 1001, 201), [255, 0, 0], 'image');
  assert.ok(pixel(shown, 96, 230)[2] > 150, 'cursor frame left of the first item');

  const down = await run(dir, await published(0), [], state(NPAD.down));
  assert.equal(word(down, 'uiCursor'), 1, 'down moves to the item below');
  const up = await run(dir, await published(0), [], state(NPAD.up));
  assert.equal(word(up, 'uiCursor'), 0, 'no wrap upwards');

  const pressed = await run(dir, await published(0), [], state(NPAD.a));
  assert.equal(word(pressed, 'cmdSequence'), 1);
  assert.equal(word(pressed, 'cmdOp'), UI_OP.a);
  assert.equal(word(pressed, 'cmdItem'), 7);
  assert.equal(word(pressed, 'cmdPage'), 1);
  assert.equal(word(pressed, 'cmdEpoch'), EPOCH);
  const back = await run(dir, await published(0), [], state(NPAD.b));
  assert.equal(word(back, 'cmdOp'), UI_OP.b);
  assert.equal(word(back, 'cmdItem'), 0);

  const stale = await published(0);
  stale.writeUInt32LE(1, UI.uiApplied);
  stale.writeUInt32LE(1, UI.uiShown);
  const restarted = await run(dir, stale, [], state());
  assert.equal(word(restarted, 'uiShown'), 0, 'a new epoch applies over a stale uiApplied');
  assert.deepEqual(pixel(restarted, 50, 50), [8, 16, 32]);

  const rejected = await run(dir, await published(0, true), [], state());
  assert.equal(word(rejected, 'uiApplied'), 0, 'torn page stays unapplied');
  assert.notDeepEqual(pixel(rejected, 50, 50), [8, 16, 32], 'the test card stays up');

  const overlay = await run(dir, await published(PAGE_FLAG.overlay), [], state());
  assert.equal(word(overlay, 'uiApplied'), 1);
  assert.equal(word(overlay, 'uiOverlay'), 0);
  assert.notDeepEqual(pixel(overlay, 124, 214), [255, 255, 255], 'overlay hidden until raised');
  const raised = await run(
    dir,
    await published(PAGE_FLAG.overlay),
    [],
    state(NPAD.l | NPAD.r, {788: 59})
  );
  assert.equal(word(raised, 'cmdOp'), UI_OP.chord, 'L+R held one second');
  assert.equal(word(raised, 'uiOverlay'), 1);
  assert.deepEqual(pixel(raised, 124, 214), [255, 255, 255], 'overlay text over the video');
  console.log(
    `Console UI: page apply, cursor, commands, torn page, overlay passed; draw ${shown.report.frames[0].drawMs} ms (test card ${rejected.report.frames[0].drawMs} ms)`
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
    await uiCheck(dir);
    console.log(
      'Passed: exit, waiting screen, native NV12, HBV2 test card, HBV1 slot, HBV2 P chain, console UI.'
    );
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
