// Fake console for live.cjs and feed.cjs: one serial link of 32 KiB exchanges
// at RATE bytes/s whose concurrent writes interleave at random, plus a 60 Hz
// "compute dispatch" running the JS HBV2 decoder over the ring. It lets the
// sender be developed and its resync path tested without a console.
//   RATE    link bytes/s (default 5.7e6, the measured rate)
//   STALL   ms@at: pause the dispatch once at `at` ms for `ms` ms, like the
//           HOME menu, to force a broken P-frame chain and a keyframe resync
//   DECODE  1 runs the full JS decoder (slower); otherwise a light apply that
//           only advances `applied`, enough for link/fps behaviour
// Point live.cjs or feed.cjs at this directory; it reads app-moonlight-*.json.
const ring = require('../../ring.cjs');
const hbv2 = require('../../hbv2.cjs');
const {mapped: BASE} = require('../app-moonlight-1.json').privateStorage;

const EXCHANGE = 0x8000,
  RATE = Number(process.env.RATE || 5.7e6),
  PAGE = 0x100000,
  memory = Buffer.alloc(ring.MEMORY_BYTES),
  pages = new Map(),
  decoder = new hbv2.Decoder(),
  queue = [],
  started = performance.now(),
  [stallMs, stallAt] = (process.env.STALL || '0@0').split('@').map(Number);
let busy = false,
  shown = 0,
  stalled = false;

function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue[Math.floor(Math.random() * queue.length)],
    part = job.parts.shift();
  setTimeout(
    () => {
      if (part.bytes) part.bytes.copy(...locate(part.address, part.bytes.length));
      else if (part.length) {
        const [bytes, at] = locate(part.address, part.length);
        job.result = Buffer.from(bytes.subarray(at, at + part.length));
      }
      if (!job.parts.length) {
        queue.splice(queue.indexOf(job), 1);
        job.done(job.result);
      }
      busy = false;
      pump();
    },
    (EXCHANGE / RATE) * 1000
  );
}

// Addresses outside private storage (launcher state, scratch, audio memory)
// land in sparse 1 MiB pages so the bridge shim can serve them too.
function locate(address, length) {
  if (address >= BASE && address + length <= BASE + memory.length) return [memory, address - BASE];
  const page = Math.floor(address / PAGE);
  if (Math.floor((address + length - 1) / PAGE) !== page) throw Error('Access crosses a fake page');
  if (!pages.has(page)) pages.set(page, Buffer.alloc(PAGE));
  return [pages.get(page), address - page * PAGE];
}

function enqueue(parts) {
  return new Promise(done => {
    queue.push({parts, done});
    pump();
  });
}

async function write(address, bytes) {
  const parts = [];
  for (let at = 0; at < bytes.length; at += EXCHANGE)
    parts.push({address: address + at, bytes: bytes.subarray(at, at + EXCHANGE)});
  await enqueue(parts);
}

async function read(address, length) {
  return enqueue([{address, length}]);
}

// One exchange with no memory transfer, the link cost of a native call.
async function exchange() {
  await enqueue([{address: BASE, length: 0}]);
}

// Immediate access without link cost, for the bridge shim's simulated natives.
function peek(address, length) {
  const [bytes, at] = locate(address, length);
  return bytes.subarray(at, at + length);
}

function poke(address, data) {
  data.copy(...locate(address, data.length));
}

// Without DECODE, skip the pixel work but keep the eligibility and sequence
// bookkeeping so the sender sees the same accept/reject behaviour.
if (!process.env.DECODE)
  decoder.apply = function (words) {
    const header = hbv2.readHeader(words);
    if (!this.eligible(header)) throw Error('Slot is not eligible');
    if (header.kind === 2) {
      this.mode = 2;
      this.frames[this.current] = {width: header.width, height: header.height};
    }
    this.applied = header.sequence;
    return header;
  };

const slots = Array.from(
  {length: ring.SLOTS},
  (_, i) =>
    new Uint32Array(memory.buffer, memory.byteOffset + ring.slotOffset(i), ring.SLOT_BYTES / 4)
);
setInterval(() => {
  const now = performance.now() - started;
  stalled = stallMs > 0 && now > stallAt && now < stallAt + stallMs;
  if (stalled) return;
  shown += decoder.step(slots);
  memory.writeUInt32LE(decoder.applied, ring.CONTROL.applied);
}, 1000 / 60).unref();
setInterval(() => {
  console.log(
    `console: applied ${decoder.applied}, ${shown} frames/s${stalled ? ' (stalled)' : ''}`
  );
  shown = 0;
}, 1000).unref();

module.exports = {read, write, exchange, peek, poke};
