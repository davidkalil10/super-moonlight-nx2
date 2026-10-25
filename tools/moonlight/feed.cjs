// Live test feeder: streams pre-encoded HBV1 slots into the running Moonlight
// app's frame ring and reports the sustained write rate.
// Usage: node tools/moonlight/feed.cjs runs/launcher-XXXX CLIP.hbv [--fps 60] [--seconds 60] [--depth 1]
const fs = require('node:fs/promises');
const path = require('node:path');
const ring = require('./ring.cjs');
const hbv = require('./hbv.cjs');
const hbv2 = require('./hbv2.cjs');
const session = require('../../../hbl-platform/sdk/host/session.cjs');
const cli = require('../../../hbl-platform/sdk/cli.cjs');

const SLOT = 32768;
const HOST_COHERENT = 4;

async function findPrivateStorage(directory) {
  const waiting = 'Waiting for the Moonlight app to open on the console...';
  return (await session.appReport(directory, 'moonlight', waiting)).privateStorage;
}

// First sequence number newer than anything the console applied or that is
// still in its ring, so a new sender never collides with an old session.
async function nextSequence(rpc, mapped) {
  let newest = (await rpc.read(mapped + ring.CONTROL.applied, 4)).readUInt32LE();
  for (let slot = 0; slot < ring.SLOTS; slot++) {
    const header = await rpc.read(mapped + ring.slotOffset(slot), 8);
    if ([hbv.MAGIC, hbv2.MAGIC].includes(header.readUInt32LE()))
      newest = Math.max(newest, header.readUInt32LE(4));
  }
  return newest + 1;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main() {
  const args = process.argv.slice(2);
  const [run, clip] = args;
  if (!run || !clip)
    throw Error(
      'Usage: feed.cjs runs/launcher-XXXX CLIP.hbv [--fps 60] [--seconds 60] [--depth 1]'
    );
  const option = (name, fallback) => cli.number(args, name, fallback);
  const fps = option('--fps', 60),
    seconds = option('--seconds', 60),
    depth = option('--depth', 1),
    inFlight = new Set();
  const directory = path.resolve(run);
  const rpc = session.rpc(directory);
  const slots = await fs.readFile(clip);
  if (slots.length % SLOT) throw Error(clip + ' is not a whole number of 32 KiB HBV1 slots');
  const count = slots.length / SLOT;

  const storage = await findPrivateStorage(directory);
  console.log(
    `Private storage at 0x${storage.mapped.toString(16)}, ${storage.bytes} bytes, ` +
      `memory flags 0x${storage.memoryFlags.toString(16)} ` +
      `(${storage.memoryFlags & HOST_COHERENT ? 'host coherent' : 'NOT host coherent'})`
  );

  const first = await nextSequence(rpc, storage.mapped),
    interval = 1000 / fps,
    exchanges = [],
    started = performance.now();
  let sequence = 0,
    dropped = 0,
    stopping = false;
  process.on('SIGINT', () => (stopping = true));
  while (!stopping && performance.now() - started < seconds * 1000) {
    const due = started + sequence * interval;
    const now = performance.now();
    if (now - due > interval) {
      const skip = Math.floor((now - due) / interval);
      dropped += skip;
      sequence += skip;
    } else if (due > now) await new Promise(resolve => setTimeout(resolve, due - now));
    const slot = Buffer.from(
      slots.subarray((sequence % count) * SLOT, ((sequence % count) + 1) * SLOT)
    );
    slot.writeUInt32LE(first + sequence, 4);
    slot.writeUInt32LE(first + sequence, SLOT - 4);
    while (inFlight.size >= depth) await Promise.race(inFlight);
    const before = performance.now();
    const write = rpc
      .write(storage.mapped + ring.slotOffset(first + sequence), slot)
      .then(() => exchanges.push(performance.now() - before))
      .finally(() => inFlight.delete(write));
    inFlight.add(write);
    sequence++;
  }
  await Promise.all(inFlight);

  const elapsed = (performance.now() - started) / 1000;
  const sorted = [...exchanges].sort((a, b) => a - b);
  const result = {
    clip,
    targetFps: fps,
    depth,
    seconds: +elapsed.toFixed(2),
    written: exchanges.length,
    deliveredFps: +(exchanges.length / elapsed).toFixed(1),
    dropped,
    exchangeMs: {
      p50: +percentile(sorted, 0.5).toFixed(1),
      p90: +percentile(sorted, 0.9).toFixed(1),
      p99: +percentile(sorted, 0.99).toFixed(1),
      max: +sorted[sorted.length - 1].toFixed(1)
    },
    megabytesPerSecond: +((exchanges.length * SLOT) / elapsed / 1e6).toFixed(2),
    memoryFlags: storage.memoryFlags
  };
  const out = path.join(directory, `moonlight-feed-${Date.now()}.json`);
  await fs.writeFile(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log('Saved ' + out);
}

module.exports = {findPrivateStorage, nextSequence};

if (require.main === module)
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
