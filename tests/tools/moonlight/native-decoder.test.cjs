const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {NativeClient} = require('../../smilebasic/engine/lib/native.cjs');
const definitions = require('../../sdk/native/movie-functions.json');
const {create: createDecoder} = require('./native-decoder.cjs');

// A faithful in-process console: the real NativeClient frames exchanges onto a
// fake connection that executes the two call records against a memory model and
// the movie::Decoder ABI, so every wire exchange is counted exactly as the
// console loop would see it. Worker gadget calls (six.cjs) run their target
// synchronously, matching the frame layout six.cjs writes.
const SCRATCH = 0x20000000;
const SDK = 0x40000000;
const MODULE_BASE = 0x50000000;
const HEAP = 0x60000000;
const COPY = 0x5872f0;
const ALLOCATE = 5732112;
const QUERY = 0x158314;
const READ = 0x586fb0;
const code = require('../../smilebasic/engine/switch2/app/thread-code.json').functions;

function createConsole() {
  const regions = [];
  const add = (start, size, perm = 3) => {
    const region = {start, end: start + size, buf: Buffer.alloc(size), perm};
    regions.push(region);
    return region;
  };
  add(SCRATCH, 0x80000);
  let heap = HEAP;
  const regionOf = address => regions.find(r => address >= r.start && address < r.end);
  const peek = (address, length) => {
    const region = regionOf(address);
    if (!region) throw Error('Unmapped read at 0x' + address.toString(16));
    return region.buf.subarray(address - region.start, address - region.start + length);
  };
  const poke = (address, bytes) => {
    const region = regionOf(address);
    if (!region) throw Error('Unmapped write at 0x' + address.toString(16));
    bytes.copy(region.buf, address - region.start);
  };
  const peek64 = address => Number(peek(address, 8).readBigUInt64LE());
  const poke32 = (address, value) => poke(address, Buffer.from(Int32Array.of(value).buffer));
  const poke64 = (address, value) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(value));
    poke(address, b);
  };
  const cstr = address => {
    const region = regionOf(address);
    const start = address - region.start;
    let end = start;
    while (region.buf[end]) end++;
    return region.buf.toString('latin1', start, end);
  };

  const functions = new Map(
    Object.entries(definitions).map(([k, d]) => [MODULE_BASE + d.offset, k])
  );
  const log = [];
  let available = 0;
  let inputBuffer = 0;
  let lastThread = 0n;

  function movie(address, args) {
    const name = functions.get(address);
    if (!name) throw Error('No movie function at 0x' + address.toString(16));
    log.push(name);
    const a = args.map(Number);
    switch (name) {
      case 'decoderCreate':
        poke64(a[0] + 8, 0x11n);
        return 0n;
      case 'mediaCreate':
        poke64(a[0], 0x22n);
        return 0n;
      case 'bufferCreate':
        return 0n;
      case 'createH264Configuration':
        // The five-argument configuration call travels the wide frame through the
        // x4/x5 preamble. a[0] is pointer('sps') (module base + 0x1000), so a[2]
        // (pps, +0x2000) and a[4] (configuration, +0x100) prove x2 and the
        // preamble-set x4 arrived intact. a[1]/a[3] are the NAL lengths.
        assert.equal(a[2], a[0] + 0x1000, 'createH264Configuration x2');
        assert.equal(a[4], a[0] - 0xf00, 'createH264Configuration x4 via preamble');
        assert.ok(a[1] > 0 && a[3] > 0);
        return 1n;
      case 'mediaFindInt': {
        const key = cstr(a[1]);
        const table = {width: 1920, height: 1080, stride: 1920, 'slice-height': 1080};
        if (!(key in table)) return 0n;
        poke32(a[2], table[key]);
        return 1n;
      }
      case 'mediaSetInt':
      case 'configure':
      case 'start':
      case 'stop':
        return 0n;
      case 'acquireInput':
        poke32(a[1], 0);
        poke32(a[2], 4);
        return 0n;
      case 'getInput':
        return 0n;
      case 'bufferData':
        if (!inputBuffer) inputBuffer = add(heap, 0x200000).start;
        heap = regions[regions.length - 1].end;
        return BigInt(inputBuffer);
      case 'bufferCapacity':
        return 0x200000n;
      case 'sendInput':
        available++;
        return 0n;
      case 'acquireOutput':
        if (available <= 0) {
          poke32(a[1], -1);
          return 0x100en;
        }
        available--;
        poke32(a[1], 0);
        poke64(a[2], 90000);
        poke32(a[3], 0);
        poke32(a[4], 1);
        return 0n;
      case 'getOutputSize':
        poke32(a[1], (1920 * 1080 * 3) / 2);
        poke32(a[2], 0x1000);
        return 0n;
      case 'bufferSetData':
      case 'getOutput':
      case 'releaseOutput':
        return 0n;
      default:
        throw Error('Unhandled movie function ' + name);
    }
  }

  // A gadget-level emulator for any worker frame six.cjs or frames.cjs build()
  // produces. It only knows the thread-code gadget semantics (shared by both and
  // device-proven through six.cjs), not any one layout, so it walks the chain and
  // runs each movie/memcpy call exactly as the console thread would.
  const LOAD_TABLE = SDK + code.loadTable.offset;
  const CALL4 = SDK + code.call4.offset;
  const SAVE = SDK + code.saveResult64.offset;
  const PREAMBLE = SDK + 0x5604a8;
  const EXIT = SDK + code.exit.offset;

  function emulate(entry) {
    const r = {x4: 0, x5: 0, x8: 0, x19: 0, x20: 0, x21: 0, x25: 0, x30: 0, sp: 0};
    // longjmp restores x19..x30 and sp from the jmpbuf at the frame entry.
    r.x19 = peek64(entry + 0x00);
    r.x20 = peek64(entry + 0x08);
    r.x21 = peek64(entry + 0x10);
    r.x25 = peek64(entry + 0x30);
    r.x30 = peek64(entry + 0x58);
    r.sp = peek64(entry + 0x68);
    let pc = r.x30,
      acc = 0n;
    for (let steps = 0; steps < 1 << 16; steps++) {
      if (pc === EXIT) return acc;
      if (pc === PREAMBLE) {
        r.x4 = r.x21;
        r.x5 = r.x20;
        pc = r.x19;
      } else if (pc === LOAD_TABLE || pc === LOAD_TABLE + 8) {
        if (pc === LOAD_TABLE) r.x8 = peek64(r.x21);
        r.x20 = peek64(r.sp + 0x20);
        r.x19 = peek64(r.sp + 0x28);
        r.x21 = peek64(r.sp + 0x10);
        r.x30 = peek64(r.sp + 8);
        r.sp += 0x30;
        pc = r.x30;
      } else if (pc === CALL4) {
        acc = exec(peek64(r.x8 + 0x68), [r.x25, r.x21, r.x20, r.x19, r.x4, r.x5].map(BigInt));
        // x4/x5 are caller-saved; the device leaves them stale after the call too,
        // so a four-argument callee must never read them. Clear them here so the
        // mock can't accidentally depend on a leaked wide value.
        r.x4 = r.x5 = 0;
        r.x20 = peek64(r.sp + 0xe0);
        r.x19 = peek64(r.sp + 0xe8);
        r.x21 = peek64(r.sp + 0xd8);
        r.x25 = peek64(r.sp + 0xb8);
        r.x30 = peek64(r.sp + 0xa8);
        r.sp += 0xf0;
        pc = r.x30;
      } else if (pc === SAVE) {
        poke64(r.x19, acc);
        r.x19 = peek64(r.sp + 0x10);
        r.x30 = peek64(r.sp + 8);
        r.sp += 0x20;
        pc = r.x30;
      } else throw Error('emulator: unknown gadget at 0x' + pc.toString(16));
    }
    throw Error('emulator: frame did not exit');
  }

  function gadget(address, args) {
    if (address === SDK + code.create.offset) {
      lastThread = emulate(Number(args[3]));
      poke64(Number(args[0]), 0x7000n);
      return 0n;
    }
    if (address === SDK + code.tryWait.offset) return 1n;
    if (address === SDK + code.join.offset) {
      poke64(Number(args[1]), lastThread);
      return 0n;
    }
    throw Error('Unhandled gadget at 0x' + address.toString(16));
  }

  function exec(target, args) {
    if (target === SDK + COPY) {
      const [dst, src, len] = args.map(Number);
      if (len) poke(dst, Buffer.from(peek(src, len)));
      return BigInt(dst);
    }
    if (target === SDK + ALLOCATE) {
      const [out, align, bytes] = args.map(Number);
      heap = Math.ceil(heap / align) * align;
      const region = add(heap, bytes);
      heap = region.end;
      poke64(out, region.start);
      return 0n;
    }
    if (target === SDK + QUERY) {
      const info = Buffer.alloc(0x40);
      const region = regionOf(Number(args[2])) || {
        start: Number(args[2]),
        end: Number(args[2]) + 0x1000,
        perm: 3
      };
      info.writeBigUInt64LE(BigInt(region.start), 0);
      info.writeBigUInt64LE(BigInt(region.end - region.start), 8);
      info.writeUInt32LE(2, 16);
      info.writeUInt32LE(region.perm, 24);
      poke(Number(args[0]), info);
      return 0n;
    }
    if (target === SDK + READ) {
      const [out, src, len] = args.map(Number);
      poke(out, Buffer.from(peek(src, len)));
      return BigInt(out);
    }
    if (target >= SDK && target < SDK + 0x1000000) return gadget(target, args);
    return movie(target, args);
  }

  let counter = 0;
  const connection = {
    error: null,
    close() {},
    pending: null,
    read(length) {
      return new Promise(resolve => {
        this.pending = {length, resolve};
      });
    },
    async write(packet) {
      counter++;
      const protocol3 = packet.length !== 0x8080;
      const dataLength = protocol3 ? packet.readUInt32LE(88) : 0;
      if (dataLength) poke(SCRATCH + 0x40080, packet.subarray(0x80, 0x80 + dataLength));
      const record = index => {
        const base = index * 40;
        return {
          target: Number(packet.readBigUInt64LE(base)),
          args: [8, 16, 24, 32].map(o => packet.readBigUInt64LE(base + o))
        };
      };
      const r0 = record(0);
      const r1 = record(1);
      const result0 = exec(r0.target, r0.args);
      const result1 = r1.target ? exec(r1.target, r1.args) : 0n;
      const {length, resolve} = this.pending;
      this.pending = null;
      const reply = Buffer.alloc(length);
      reply.writeBigUInt64LE(BigInt.asUintN(64, result1), 0);
      reply.writeBigUInt64LE(BigInt.asUintN(64, result0), 8);
      Buffer.from(peek(SCRATCH + 0x4040, length - 16)).copy(reply, 16);
      resolve(reply);
    }
  };

  const native = new NativeClient(connection, {
    sdk: SDK,
    scratch: SCRATCH,
    session: 'test',
    platform: 2,
    protocol: 3
  });

  // Mirror smilebasic/engine/shared/rpc.cjs + bridge.cjs dispatch onto the client.
  const invoke = (op, args = [], outputBytes) => {
    const padded = [...args, ...Array(Math.max(0, 4 - args.length)).fill(0)];
    if (outputBytes === undefined)
      return op.address !== undefined
        ? native.callAddress(op.address, ...padded)
        : native.call(op.offset, ...padded);
    return native.exchange(
      [
        op.address !== undefined
          ? {address: op.address, args: padded}
          : {offset: op.offset, args: padded}
      ],
      undefined,
      outputBytes
    );
  };
  const rpc = {
    a: native.addresses,
    output: native.output,
    async request(req) {
      if (req.command === 'verify-function') {
        native.functions.add(req.address);
        return {verified: true};
      }
      throw Error('Unhandled bridge command ' + req.command);
    },
    call: (offset, args, outputBytes) => invoke({offset}, args, outputBytes),
    callAddress: (address, args, outputBytes) => invoke({address}, args, outputBytes),
    read: (address, length) => native.read(address, length),
    write: (address, bytes) => native.write(address, bytes),
    query: address => native.query(address),
    writeAndCall: (address, bytes, target, args) =>
      native.writeAndCall(address, bytes, target, args),
    pair: calls => native.exchange(calls)
  };

  return {
    rpc,
    log,
    reset() {
      counter = 0;
      log.length = 0;
    },
    get count() {
      return counter;
    }
  };
}

async function fixture() {
  const root = path.join(os.tmpdir(), 'hbl-native-decoder');
  await fs.mkdir(root, {recursive: true});
  const directory = await fs.mkdtemp(path.join(root, 'dec-'));
  const symbols = Object.values(definitions).map(d => ({
    name: d.symbol,
    section: '.text',
    offset: d.offset,
    size: d.size
  }));
  await fs.writeFile(
    path.join(directory, 'compatibility-module.json'),
    JSON.stringify({base: MODULE_BASE, symbols})
  );
  return directory;
}

const STEADY_STATE_EXCHANGES = 10;
const sps = Buffer.from('6742001eab', 'hex');
const pps = Buffer.from('68ce0100', 'hex');

async function build() {
  const directory = await fixture();
  const consoleMock = createConsole();
  const decoder = await createDecoder({
    rpc: consoleMock.rpc,
    directory,
    workerDirectory: path.join(directory, 'worker')
  });
  const destination = {address: 0x70000000, bytes: (1920 * 1080 * 3) / 2 + 0x1000};
  return {consoleMock, decoder, directory, destination};
}

async function frame(decoder, destination, pts) {
  await decoder.submit({data: Buffer.alloc(96000, 7), pts});
  const result = await decoder.receive(destination);
  return result;
}

test('steady-state H.264 submit+receive holds its exchange budget and call order', async () => {
  const {consoleMock, decoder, destination, directory} = await build();
  try {
    await decoder.configure(sps, pps, 30);
    // Cold frame warms the input-buffer, sizing and layout caches.
    assert.ok(await frame(decoder, destination, 1000));
    consoleMock.reset();
    const result = await frame(decoder, destination, 2000);
    assert.equal(result.format, 'nv12');
    assert.equal(result.width, 1920);
    assert.equal(result.stride, 1920);
    const exchanges = consoleMock.count;
    // Live steady-state budget. Bump this down (never up) as the path tightens,
    // and record the before/after in the commit message. One finite worker now
    // runs SendInput, AcquireOutput and the next frame's AcquireInput together,
    // and the host pairs bufferSetData with getOutput, so the frame went from 18
    // exchanges to 10.
    assert.equal(exchanges, STEADY_STATE_EXCHANGES, 'steady-state exchanges per frame');
    assert.deepEqual(consoleMock.log, [
      'sendInput',
      'acquireOutput',
      'acquireInput',
      'bufferSetData',
      'getOutput',
      'releaseOutput'
    ]);
  } finally {
    await decoder.close().catch(() => {});
    await fs.rm(directory, {recursive: true, force: true});
  }
});

module.exports = {createConsole};
