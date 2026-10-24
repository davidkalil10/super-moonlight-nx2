// Live test feeder: streams pre-encoded HBV1 slots into the running Moonlight
// app's frame ring and reports the sustained write rate.
// Usage: node tools/moonlight/feed.cjs runs/launcher-XXXX CLIP.hbv [--fps 60] [--seconds 60] [--depth 1]
const fs = require('node:fs/promises');
const path = require('node:path');
const ring = require('../../apps/moonlight/ring.cjs');

const SLOT = 32768;
const HOST_COHERENT = 4;

async function findPrivateStorage(directory) {
  for (;;) {
    const names = (await fs.readdir(directory)).filter(n => /^app-moonlight-.*\.json$/.test(n));
    const reports = await Promise.all(
      names.map(async n => JSON.parse(await fs.readFile(path.join(directory, n), 'utf8')))
    );
    const storage = reports
      .filter(r => r.privateStorage)
      .sort((a, b) => b.started.localeCompare(a.started))[0]?.privateStorage;
    if (storage) return storage;
    console.log('Waiting for the Moonlight app to open on the console...');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
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
  const option = (name, fallback) =>
    args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback;
  const fps = option('--fps', 60),
    seconds = option('--seconds', 60),
    depth = option('--depth', 1),
    inFlight = new Set();
  const directory = path.resolve(run);
  const rpc = require(path.join(directory, 'shared/rpc.cjs'));
  const slots = await fs.readFile(clip);
  if (slots.length % SLOT) throw Error(clip + ' is not a whole number of 32 KiB HBV1 slots');
  const count = slots.length / SLOT;

  const storage = await findPrivateStorage(directory);
  console.log(
    `Private storage at 0x${storage.mapped.toString(16)}, ${storage.bytes} bytes, ` +
      `memory flags 0x${storage.memoryFlags.toString(16)} ` +
      `(${storage.memoryFlags & HOST_COHERENT ? 'host coherent' : 'NOT host coherent'})`
  );

  const interval = 1000 / fps,
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
    slot.writeUInt32LE(sequence + 1, 4);
    slot.writeUInt32LE(sequence + 1, SLOT - 4);
    while (inFlight.size >= depth) await Promise.race(inFlight);
    const before = performance.now();
    const write = rpc
      .write(storage.mapped + ring.slotOffset(sequence + 1), slot)
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

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
