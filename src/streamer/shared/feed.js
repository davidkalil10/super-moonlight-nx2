/**
 * Live test feeder: streams a pre-encoded HBV1 clip into the running app's ring, paced to
 * --fps with up to --depth writes in flight, and reports the sustained write rate.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as ring from './ring.js';
import * as hbv from '../../renderer/hbv.js';
import * as hbv2 from '../../renderer/hbv2.js';
import * as session from '../../../../hbl-platform/sdk/host/session.js';
import * as cli from '../../../../hbl-platform/sdk/cli.js';

const USAGE = 'Usage: feed.js runs/launcher-XXXX CLIP.hbv [--fps 60] [--seconds 60] [--depth 1]';
/** One HBV1 slot in the clip file. */
const SLOT = 32768;
/** Byte offset of the sequence in a slot header, also repeated in the slot's last word. */
const SEQUENCE_OFFSET = 4;
/** Bytes of a ring slot header read to find its magic and sequence. */
const SLOT_HEADER_BYTES = 8;
/** Vulkan VK_MEMORY_PROPERTY_HOST_COHERENT_BIT. */
const HOST_COHERENT = 4;

/**
 * Waits for the Moonlight app to report its private storage.
 * @param {string} directory the run directory
 */
async function findPrivateStorage(directory) {
  const waiting = 'Waiting for the Moonlight app to open on the console...';
  return (await session.appReport(directory, 'moonlight', waiting)).privateStorage;
}

/**
 * First sequence number newer than anything the console applied or that is still in its ring,
 * so a new sender never collides with an old session.
 * @param {{read(address: number, bytes: number): Promise<Buffer>}} rpc
 * @param {number} mapped the private storage's mapped address
 * @returns {Promise<number>}
 */
async function nextSequence(rpc, mapped) {
  let newest = (await rpc.read(mapped + ring.CONTROL.applied, 4)).readUInt32LE();

  for (let slot = 0; slot < ring.SLOTS; slot++) {
    const header = await rpc.read(mapped + ring.slotOffset(slot), SLOT_HEADER_BYTES);
    const magic = header.readUInt32LE();
    if ([hbv.MAGIC, hbv2.MAGIC].includes(magic))
      newest = Math.max(newest, header.readUInt32LE(SEQUENCE_OFFSET));
  }

  return newest + 1;
}

/**
 * @param {number[]} sorted ascending
 * @param {number} p 0..1
 * @returns {number}
 */
function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * A copy of the clip's slot for a frame, stamped with the frame's ring sequence.
 * @param {Buffer} slots the whole clip
 * @param {number} frame
 * @param {number} sequence
 * @returns {Buffer}
 */
function stampedSlot(slots, frame, sequence) {
  const index = frame % (slots.length / SLOT);
  const slot = Buffer.from(slots.subarray(index * SLOT, (index + 1) * SLOT));
  slot.writeUInt32LE(sequence, SEQUENCE_OFFSET);
  slot.writeUInt32LE(sequence, SLOT - 4);
  return slot;
}

/**
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
const fixed = (value, digits) => Number(value.toFixed(digits));

async function main() {
  const args = process.argv.slice(2);
  const [run, clip] = args;
  if (!run || !clip) throw Error(USAGE);

  const option = (name, fallback) => cli.number(args, name, fallback);
  const fps = option('--fps', 60);
  const seconds = option('--seconds', 60);
  const depth = option('--depth', 1);
  const inFlight = new Set();
  const directory = path.resolve(run);
  const rpc = session.rpc(directory);
  const slots = await fs.readFile(clip);
  if (slots.length % SLOT) throw Error(clip + ' is not a whole number of 32 KiB HBV1 slots');

  const storage = await findPrivateStorage(directory);
  const coherence = storage.memoryFlags & HOST_COHERENT ? 'host coherent' : 'NOT host coherent';
  console.log(
    `Private storage at 0x${storage.mapped.toString(16)}, ${storage.bytes} bytes, ` +
      `memory flags 0x${storage.memoryFlags.toString(16)} (${coherence})`
  );

  const first = await nextSequence(rpc, storage.mapped);
  const interval = 1000 / fps;
  const exchanges = [];
  const started = performance.now();
  let sequence = 0;
  let dropped = 0;
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });

  while (!stopping && performance.now() - started < seconds * 1000) {
    const due = started + sequence * interval;
    const now = performance.now();

    // A frame more than one interval late is dropped rather than sent in a burst.
    if (now - due > interval) {
      const skip = Math.floor((now - due) / interval);
      dropped += skip;
      sequence += skip;
    } else if (due > now) {
      await new Promise(resolve => setTimeout(resolve, due - now));
    }

    const slot = stampedSlot(slots, sequence, first + sequence);
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
    seconds: fixed(elapsed, 2),
    written: exchanges.length,
    deliveredFps: fixed(exchanges.length / elapsed, 1),
    dropped,
    exchangeMs: {
      p50: fixed(percentile(sorted, 0.5), 1),
      p90: fixed(percentile(sorted, 0.9), 1),
      p99: fixed(percentile(sorted, 0.99), 1),
      max: fixed(sorted[sorted.length - 1], 1)
    },
    megabytesPerSecond: fixed((exchanges.length * SLOT) / elapsed / 1e6, 2),
    memoryFlags: storage.memoryFlags
  };

  const out = path.join(directory, `moonlight-feed-${Date.now()}.json`);
  await fs.writeFile(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log('Saved ' + out);
}

export {findPrivateStorage, nextSequence};

if (cli.isMain(import.meta))
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
