// Console HBV2 decode timing. Feeds the Moonlight app's own compute pipeline
// the same synthetic 1080p chain as apps/moonlight/check.cjs (keyframe, P
// frames, one 3-frame catch-up) and times submit + vkQueueWaitIdle per frame
// with the SDK tick on-console, so rig and console numbers compare directly.
//
// Needs: a session with Moonlight prepared (app-moonlight-*.json) and the
// launcher loop stopped (touch RUN_DIR/launcher-loop.stop). Private storage and
// the app's state block are saved first and restored afterwards; a copy of
// both is kept in the session directory in case the probe dies part way.
const fs = require('node:fs/promises'),
  path = require('node:path');
const {struct, latest, compat, job, report} = require('../../../hbl-dev/sdk/tools/probe-job.cjs');
const {allocate} = require('../../../hbl-platform/sdk/native/allocate.cjs');
const ring = require('../../../hbl-moonlight/tools/moonlight/ring.cjs');
const hbv2 = require('../../../hbl-moonlight/tools/moonlight/hbv2.cjs');

const STATE_BYTES = 4096;

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

function chain(count) {
  const [width, height] = [1920, 1088],
    decoder = new hbv2.Decoder(),
    plan = mb => [{mode: 'skip'}, {mode: 'inter', mvx: 3, mvy: -2}, {mode: 'intra'}][mb % 3],
    slots = [];
  for (let sequence = 1; sequence <= count; sequence++) {
    const slot = hbv2.encode(
      hbv2.toFrame(scene(width, height, sequence > 1 ? sequence * 3 : 0), width, height),
      {
        sequence,
        reference: sequence > 1 ? decoder.frame : null,
        referenceSequence: sequence - 1,
        qp: sequence > 1 ? 40 : 30,
        plan: sequence > 1 ? plan : undefined
      }
    );
    decoder.apply(hbv2.words(slot));
    slots.push(slot);
  }
  return slots;
}

async function main(directory) {
  directory = path.resolve(directory);
  const rpc = require(path.join(directory, 'shared/rpc.cjs'));
  const launcher = await latest(
    directory,
    /^launcher(-[a-z0-9-]+)?\.json$/,
    v => v.resources?.pool && v.controls?.mapped
  );
  const app = await latest(directory, /^app-moonlight-.*\.json$/, v => v.ready && v.privateStorage);
  const loop = await latest(directory, /^launcher.*-loop\.json$/);
  if (!launcher || !app) throw Error('Need a launcher report and a ready Moonlight app report');
  if (loop?.value.threadRunning) throw Error('Stop the launcher loop first (launcher-loop.stop)');
  const storage = app.value.privateStorage;
  if (storage.bytes !== ring.MEMORY_BYTES)
    throw Error(
      `Private storage is ${storage.bytes} bytes, this tree expects ${ring.MEMORY_BYTES}`
    );
  const device = BigInt(launcher.value.resources.device),
    queue = BigInt(launcher.value.resources.queue),
    pool = BigInt(launcher.value.resources.pool),
    state = launcher.value.controls.mapped,
    memory = storage.mapped;
  const out = {
    session: rpc.a.session,
    started: new Date().toISOString(),
    launcher: path.basename(launcher.file),
    app: path.basename(app.file),
    shaderLocalSize: ring.LOCAL_SIZE,
    steps: []
  };
  const save = await report(directory, 'probe-hbv2-decode.json', out);
  const {functions: f, base} = await compat(rpc, directory, [
    'vkAllocateCommandBuffers',
    'vkFreeCommandBuffers',
    'vkBeginCommandBuffer',
    'vkEndCommandBuffer',
    'vkCmdPipelineBarrier2',
    'vkCmdBindDescriptorSets2',
    'vkCmdBindPipeline',
    'vkCmdDispatch',
    'vkQueueSubmit',
    'vkQueueWaitIdle'
  ]);
  const ok = async (name, ...args) => {
    const r = Number(BigInt.asIntN(32, (await rpc.callAddress(f[name], args)).result));
    if (r !== 0) throw Error(`${name}: VkResult ${r}`);
  };
  const p = await allocate(rpc, 0x4000, {
    failed: 'Probe allocation failed',
    invalid: 'Invalid probe allocation'
  });
  await rpc.write(p, Buffer.alloc(0x4000));

  console.log('Encoding the synthetic chain...');
  const slots = chain(10);
  console.log('Saving private storage and app state...');
  const savedMemory = await rpc.read(memory, storage.bytes),
    savedState = await rpc.read(state, STATE_BYTES);
  await fs.writeFile(path.join(directory, 'probe-hbv2-decode-memory.bin'), savedMemory, {
    mode: 0o600
  });
  await fs.writeFile(path.join(directory, 'probe-hbv2-decode-state.bin'), savedState, {
    mode: 0o600
  });
  out.saved = true;
  await save();

  let command = 0n;
  try {
    await rpc.write(p, struct(32, 40, {24: 0, 28: 1}, {16: pool}));
    await ok('vkAllocateCommandBuffers', device, p, p + 0x40);
    command = (await rpc.read(p + 0x40, 8)).readBigUInt64LE();
    await rpc.write(p + 0x100, struct(32, 42));
    await ok('vkBeginCommandBuffer', command, p + 0x100);
    const set = Buffer.alloc(8);
    set.writeBigUInt64LE(BigInt(storage.descriptor));
    await rpc.write(p + 0x200, set);
    await rpc.write(
      p + 0x240,
      struct(64, 1000545003, {16: 0x20, 36: 1}, {24: app.value.layout, 40: p + 0x200})
    );
    await rpc.callAddress(f.vkCmdBindDescriptorSets2, [command, p + 0x240]);
    await rpc.callAddress(f.vkCmdBindPipeline, [command, 1, app.value.computePipeline]);
    await rpc.callAddress(f.vkCmdDispatch, [command, 1, 1, 1]);
    await rpc.write(
      p + 0x300,
      struct(48, 1000314000, {}, {16: 0x800, 24: 0x40, 32: 0x4000, 40: 0x2000})
    );
    await rpc.write(p + 0x340, struct(64, 1000314003, {20: 1}, {24: p + 0x300}));
    await rpc.callAddress(f.vkCmdPipelineBarrier2, [command, p + 0x340]);
    await ok('vkEndCommandBuffer', command);
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(command);
    await rpc.write(p + 0x80, handle);
    await rpc.write(p + 0x400, struct(72, 4, {40: 1}, {48: p + 0x80}));

    const worker = await job(rpc, new Set([f.vkQueueSubmit, f.vkQueueWaitIdle]), base);
    const hz = await worker.frequency();
    const control = async () => {
      const b = await rpc.read(memory, 16);
      return {
        applied: b.readUInt32LE(ring.CONTROL.applied),
        mode: b.readUInt32LE(ring.CONTROL.mode)
      };
    };
    const time = async (label, bytes) => {
      const r = await worker.run([
        {function: worker.tick, args: []},
        {function: f.vkQueueSubmit, args: [queue, 1, p + 0x400, 0]},
        {function: f.vkQueueWaitIdle, args: [queue]},
        {function: worker.tick, args: []}
      ]);
      if (r[1] !== 0n || r[2] !== 0n) throw Error(`${label}: submit ${r[1]}, wait ${r[2]}`);
      const row = {label, bytes, ms: (Number(r[3] - r[0]) / hz) * 1000, ...(await control())};
      out.steps.push(row);
      await save();
      console.log(label.padEnd(16), row.ms.toFixed(2), 'ms', 'applied', row.applied);
      return row;
    };

    await rpc.write(memory, Buffer.alloc(ring.RING_OFFSET + ring.SLOTS * ring.SLOT_BYTES));
    await time('idle', 0);
    for (let sequence = 1; sequence <= 7; sequence++) {
      const slot = slots[sequence - 1];
      await rpc.write(memory + ring.slotOffset(sequence), slot);
      const row = await time(sequence === 1 ? 'keyframe' : 'P' + sequence, slot.length);
      if (row.applied !== sequence) throw Error(`Expected sequence ${sequence} applied`);
    }
    for (let sequence = 8; sequence <= 10; sequence++)
      await rpc.write(memory + ring.slotOffset(sequence), slots[sequence - 1]);
    const catchUp = await time(
      'catch-up P8-P10',
      slots.slice(7).reduce((s, b) => s + b.length, 0)
    );
    out.catchUpApplied = catchUp.applied;
    const inter = out.steps.filter(s => /^P\d/.test(s.label)).map(s => s.ms);
    out.summary = {
      idleMs: out.steps[0].ms,
      keyframeMs: out.steps[1].ms,
      pMeanMs: inter.reduce((s, x) => s + x, 0) / inter.length,
      pMaxMs: Math.max(...inter),
      catchUpMs: catchUp.ms
    };
  } finally {
    if (command) {
      const handle = Buffer.alloc(8);
      handle.writeBigUInt64LE(command);
      await rpc.write(p + 0x80, handle);
      await rpc.callAddress(f.vkFreeCommandBuffers, [device, pool, 1, p + 0x80]);
    }
    await rpc.write(memory, savedMemory);
    await rpc.write(state, savedState);
    out.restored = (await rpc.read(memory, 4096)).equals(savedMemory.subarray(0, 4096));
    out.completed = new Date().toISOString();
    await save();
  }
  console.log(JSON.stringify(out.summary));
  return out;
}

module.exports = {main};
if (require.main === module)
  main(process.argv[2]).catch(e => {
    console.error(e);
    process.exitCode = 1;
  });
