// The rest of src/streamer/stream: the native decoder, sink and TCP, live.js, pacing and summaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const fsSync = require('node:fs');
const {spawnSync} = require('node:child_process');
const {NativeClient} = require('../../../../../../hbl-platform/smilebasic/engine/lib/native.js');
const definitions = require('../../../console-api/movie-functions.json');
const {create: createDecoder} = require('../../native/native-decoder.js');
const code =
  require('../../../../../../hbl-platform/smilebasic/engine/switch2/app/thread-code.json').functions;
const TICK = require('../../../../../../hbl-platform/smilebasic/engine/switch2/app/timing-code.json')
  .functions.tick.offset;
const ring = require('../../../shared/ring.js');
const {create} = require('../../native/native-sink.js');
const socketDefinitions = require('../../../../../../hbl-platform/sdk/native/socket-functions.json');
const {create: createTcp, endpoint} = require('../../native/native-tcp.js');
const {metadata} = require('../../worker/publication-metadata.js');
const {parseExpect, summarize, verdict} = require('../run-summary.js');
const {defaultBitrate, bitrate} = require('../bitrate.js');
const {instrument, requestsFor, watchBridge} = require('../../native/bridge-counter.js');

// native-decoder.js

// A faithful in-process console: the real NativeClient frames exchanges onto a
// fake connection that executes the two call records against a memory model and
// the movie::Decoder ABI, so every wire exchange is counted exactly as the
// console loop would see it. Worker gadget calls (hbl-platform/sdk/native/six.js) run their
// target synchronously, matching the frame layout six.js writes.
const SCRATCH = 0x20000000;
const SDK = 0x40000000;
const MODULE_BASE = 0x50000000;
const HEAP = 0x60000000;
const COPY = 0x5872f0;
const ALLOCATE = 5732112;
const QUERY = 0x158314;
const READ = 0x586fb0;

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
      case 'decoderDestroy':
      case 'mediaDestroy':
      case 'bufferDestroy':
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

  // A gadget-level emulator for any worker frame hbl-platform/sdk/native/six.js or
  // hbl-platform/smilebasic/engine/shared/frames.js build() produces. It only knows the
  // thread-code gadget semantics (shared by both and device-proven through six.js), not any
  // one layout, so it walks the chain and runs each movie/memcpy call exactly as the console
  // thread would.
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
    if (target === SDK + TICK) {
      log.push('tick');
      return 0x123456789n;
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

  // Mirror hbl-platform/smilebasic/engine/shared/rpc.cjs + engine/lib/bridge.js dispatch onto the
  // client.
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

async function decodeFrame(decoder, destination, pts) {
  await decoder.submit({data: Buffer.alloc(96000, 7), pts});
  const result = await decoder.receive(destination);
  return result;
}

test('steady-state H.264 submit+receive holds its exchange budget and call order', async () => {
  const {consoleMock, decoder, destination, directory} = await build();
  try {
    await decoder.configure(sps, pps, 30);
    // Cold frame warms the input-buffer, sizing and layout caches.
    assert.ok(await decodeFrame(decoder, destination, 1000));
    consoleMock.reset();
    const result = await decodeFrame(decoder, destination, 2000);
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

test('configure runs beforeStart between Configure and Start', async () => {
  const {consoleMock, decoder, directory} = await build();
  try {
    let seen = null;
    await decoder.configure(sps, pps, 30, {
      beforeStart(decoderAddress) {
        seen = {decoderAddress, log: [...consoleMock.log]};
      }
    });
    assert.ok(Number.isSafeInteger(seen.decoderAddress) && seen.decoderAddress > 0);
    assert.equal(seen.log.at(-1), 'configure');
    assert.equal(consoleMock.log.at(-1), 'start');
  } finally {
    await decoder.close().catch(() => {});
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test('submit can leave the output acquire to receive', async () => {
  const {consoleMock, decoder, destination, directory} = await build();
  try {
    await decoder.configure(sps, pps, 30);
    consoleMock.reset();
    await decoder.submit({data: Buffer.alloc(4000, 7), pts: 1000}, {acquireOutput: false});
    assert.deepEqual(decoder.lastInput, {status: 0, index: 0});
    assert.deepEqual(consoleMock.log, [
      'acquireInput',
      'getInput',
      'bufferData',
      'bufferCapacity',
      'sendInput',
      'acquireInput'
    ]);
    consoleMock.reset();
    const result = await decoder.receive(destination);
    assert.equal(result.format, 'nv12');
    assert.equal(consoleMock.log[0], 'acquireOutput');
    assert.equal(await decoder.receive(destination), null);
  } finally {
    await decoder.close().catch(() => {});
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test('submit can stamp SendInput with an SDK call run just before it', async () => {
  const {consoleMock, decoder, directory} = await build();
  try {
    await decoder.configure(sps, pps, 30);
    await decoder.submit({data: Buffer.alloc(4000, 7), pts: 1000}, {acquireOutput: false});
    assert.equal(decoder.lastStamp, null);
    consoleMock.reset();
    await decoder.submit(
      {data: Buffer.alloc(4000, 7), pts: 2000},
      {acquireOutput: false, stamp: SDK + TICK}
    );
    assert.equal(decoder.lastStamp, 0x123456789n);
    assert.deepEqual(decoder.lastInput, {status: 0, index: 0});
    assert.deepEqual(consoleMock.log, ['tick', 'sendInput', 'acquireInput']);
  } finally {
    await decoder.close().catch(() => {});
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test('split mode registers its workers before Start and stops them before decoder cleanup', async () => {
  const directory = await fixture();
  const consoleMock = createConsole();
  const events = [];
  const destination = {address: 0x70000000, bytes: (1920 * 1080 * 3) / 2 + 0x1000};
  const publication = {mapped: 0x71000000, color: 1};
  const transport = {
    async close() {
      events.push('transport-close');
    }
  };
  await assert.rejects(
    createDecoder({rpc: consoleMock.rpc, directory, workerMode: 'split', transport}),
    /worker factory/
  );
  const decoder = await createDecoder({
    rpc: consoleMock.rpc,
    directory,
    workerDirectory: path.join(directory, 'worker'),
    workerMode: 'split',
    transport,
    publication,
    async splitWorkerFactory(options) {
      events.push({type: 'create', transport: options.transport, publication: options.publication});
      return {
        async register() {
          events.push('register:' + consoleMock.log.at(-1));
        },
        async stop() {
          events.push('stop-workers:' + consoleMock.log.includes('stop'));
        },
        async finalize() {
          events.push('finalize-events');
        }
      };
    }
  });
  try {
    await decoder.configure(sps, pps, 30);
    assert.deepEqual(events, [{type: 'create', transport, publication}, 'register:configure']);
    assert.equal(consoleMock.log.at(-1), 'start');
    assert.ok(await decodeFrame(decoder, destination, 1000));
    assert.ok(decoder.lastInput);
    await decoder.close();
    assert.deepEqual(events.slice(2), ['stop-workers:false', 'transport-close', 'finalize-events']);
    assert.ok(consoleMock.log.includes('stop'));
  } finally {
    await decoder.close().catch(() => {});
    await fs.rm(directory, {recursive: true, force: true});
  }
});

// native-sink.js
test('host publication fields occupy different cache lines from GPU-written control', () => {
  const gpu = [
    'applied',
    'applyCount',
    'mode',
    'current',
    'size',
    'hbv1Slot',
    'nativeReady',
    'nativeApplied',
    'currentStride',
    'currentSliceHeight',
    'currentColor'
  ];
  const host = [
    'nativeSequence',
    'nativeIndex',
    'nativeWidth',
    'nativeHeight',
    'nativeStride',
    'nativeSliceHeight',
    'nativeColor',
    'nativeCommit'
  ];
  const gpuLines = new Set(gpu.map(name => Math.floor(ring.CONTROL[name] / 128)));
  for (const name of host) assert.equal(gpuLines.has(Math.floor(ring.CONTROL[name] / 128)), false);
});

function sinkFixture() {
  const memory = Buffer.alloc(ring.CONTROL_BYTES);
  const writes = [];
  const reads = [];
  const storage = {mapped: 0x1000000, bytes: ring.MEMORY_BYTES, memoryFlags: 7};
  memory.writeUInt32LE(ring.NATIVE_ABI, ring.CONTROL.nativeReady);
  const rpc = {
    async read(address, length) {
      reads.push({address, length});
      return Buffer.from(
        memory.subarray(address - storage.mapped, address - storage.mapped + length)
      );
    },
    async query() {
      return {address: storage.mapped, size: storage.bytes, permissions: 3, ipcReferences: 0};
    },
    async write(address, bytes) {
      const offset = address - storage.mapped;
      writes.push({offset, bytes: Buffer.from(bytes)});
      bytes.copy(memory, offset);
      if (offset === ring.CONTROL.nativeSequence && bytes.readUInt32LE()) {
        memory.writeUInt32LE(memory.readUInt32LE(ring.CONTROL.nativeIndex), ring.CONTROL.current);
        memory.writeUInt32LE(bytes.readUInt32LE(), ring.CONTROL.nativeApplied);
      }
    }
  };
  return {rpc, storage, memory, writes, reads};
}

test('empty output polls keep selecting the inactive surface, and commits publish metadata first', async () => {
  const f = sinkFixture();
  const sink = await create(f.rpc, f.storage);
  const first = await sink.destination();
  const emptyPoll = await sink.destination();
  assert.equal(first.index, 1);
  assert.deepEqual(emptyPoll, first);
  await sink.publish(first, {format: 'nv12', width: 128, height: 96, stride: 128, sliceHeight: 96});
  assert.equal(f.writes[0].offset, ring.CONTROL.nativeIndex);
  assert.equal(f.writes[1].offset, ring.CONTROL.nativeSequence);
  await sink.wait();
  assert.equal((await sink.destination()).index, 0);
  await sink.close();
  assert.equal(f.memory.readUInt32LE(ring.CONTROL.nativeSequence), 0);
});

test('old shaders and noncoherent allocations are rejected before any frame is written', async () => {
  const f = sinkFixture();
  await assert.rejects(create(f.rpc, {...f.storage, memoryFlags: 3}), /coherent/);
  f.memory.writeUInt32LE(0, ring.CONTROL.nativeReady);
  await assert.rejects(create(f.rpc, f.storage), /Relaunch Moonlight/);
  assert.deepEqual(f.writes, []);
});

test('an unsupported color space is rejected before any frame is written', async () => {
  const f = sinkFixture();
  await assert.rejects(create(f.rpc, f.storage, {color: 3}), /Unsupported native video color/);
  assert.deepEqual(f.writes, []);
});

test('worker destinations avoid the displayed and unpublished surfaces', async () => {
  const f = sinkFixture();
  const sink = await create(f.rpc, f.storage);
  const first = await sink.workerDestination({current: 0, applied: 0});
  assert.deepEqual([first.index, first.sequence], [1, 1]);
  const reads = f.reads.length;
  const second = await sink.workerDestination({current: 0, applied: 0});
  assert.deepEqual([second.index, second.sequence], [2, 2]);
  assert.equal(f.reads.length, reads);
  const third = await sink.workerDestination({current: 1, applied: 1});
  assert.deepEqual([third.index, third.sequence], [0, 3]);
  assert.equal(f.reads.length, reads);
  assert.equal(sink.workerPublication.mapped, f.storage.mapped);
  assert.equal(sink.workerPublication.color, 1);
});

test('a discard surface avoids the displayed and unpublished surfaces without reserving one', async () => {
  const f = sinkFixture();
  const sink = await create(f.rpc, f.storage);
  await assert.rejects(sink.discardDestination({current: 0, applied: 0}), /No worker publication/);
  const first = await sink.workerDestination({current: 0, applied: 0});
  const discard = await sink.discardDestination({current: 0, applied: 0});
  assert.deepEqual([discard.index, discard.skip, discard.sequence], [2, true, undefined]);
  assert.equal(discard.address, f.storage.mapped + ring.frameOffset(2));
  const second = await sink.workerDestination({current: 0, applied: 0});
  assert.deepEqual([second.index, second.sequence], [2, first.sequence + 1]);
  assert.equal(await sink.discardDestination({current: 0, applied: 0}), null);
});

test('a torn presentation snapshot is refreshed before recycling a surface', async () => {
  const f = sinkFixture();
  const sink = await create(f.rpc, f.storage);
  await sink.workerDestination({current: 0, applied: 0});
  await sink.workerDestination({current: 0, applied: 0});
  f.memory.writeUInt32LE(2, ring.CONTROL.current);
  f.memory.writeUInt32LE(2, ring.CONTROL.nativeApplied);
  const before = f.reads.length;
  const destination = await sink.workerDestination({current: 0, applied: 2});
  assert.equal(destination.index, 0);
  assert.ok(f.reads.length > before);
});

// native-tcp.js
const BASE = 0x60000000;

test('native TCP setup verifies the socket API and authenticates a separate connection', async () => {
  const verified = [];
  const calls = [];
  const written = [];
  const server = new EventEmitter();
  server.listen = (port, host, callback) => {
    assert.equal(port, 0);
    assert.equal(host, '192.0.2.10');
    callback();
  };
  server.address = () => ({port: 42123});
  server.close = () => calls.push('server-close');
  const candidate = new EventEmitter();
  candidate.destroyed = false;
  candidate.pause = () => calls.push('pause');
  candidate.setNoDelay = enabled => assert.equal(enabled, true);
  candidate.destroy = () => {
    candidate.destroyed = true;
  };
  candidate.write = (bytes, callback) => {
    written.push(Buffer.from(bytes));
    callback();
  };
  let addressBlock;
  const rpc = {
    a: {sdk: SDK},
    output: 0x20000000,
    async request(request) {
      assert.equal(request.command, 'verify-function');
      verified.push(request.address);
      return {verified: true};
    },
    async call() {
      const output = Buffer.alloc(8);
      output.writeBigUInt64LE(BigInt(BASE));
      return {result: 0n, output};
    },
    async callAddress(address, args) {
      calls.push(address);
      if (address === SDK + socketDefinitions.socketInitialized.offset) return {result: 1n};
      if (address === SDK + socketDefinitions.socket.offset) return {result: 7n};
      if (address === SDK + socketDefinitions.socketClose.offset) {
        assert.equal(args[0], 7);
        return {result: 0n};
      }
      if (address === SDK + socketDefinitions.errno.offset) return {result: 0n};
      throw Error('Unexpected direct socket call');
    },
    async write(address, bytes) {
      assert.equal(address, BASE);
      addressBlock = Buffer.from(bytes);
    }
  };
  const transport = await createTcp({
    rpc,
    host: '192.0.2.10',
    createServer: () => server,
    makeToken: () => Buffer.alloc(16, 0x5a),
    createWorker: async () => ({
      async run([call]) {
        if (call.function === SDK + socketDefinitions.connect.offset) {
          assert.deepEqual(call.args, [7, BASE, 16, 0]);
          server.emit('connection', candidate);
          return [0n];
        }
        assert.equal(call.function, SDK + socketDefinitions.send.offset);
        const [fd, address, remaining] = call.args;
        assert.equal(fd, 7);
        const count = Math.min(8, remaining);
        candidate.emit('data', addressBlock.subarray(address - BASE, address - BASE + count));
        return [BigInt(count)];
      }
    })
  });
  assert.equal(transport.fd, 7);
  assert.equal(transport.port, 42123);
  assert.equal(transport.recvFunction, SDK + socketDefinitions.recv.offset);
  assert.equal(transport.sendFunction, SDK + socketDefinitions.send.offset);
  assert.equal(transport.maxAccessUnit, 0x100000);
  assert.equal(addressBlock.readUInt16BE(2), 42123);
  assert.deepEqual([...addressBlock.subarray(4, 8)], [192, 0, 2, 10]);
  assert.equal(verified.length, Object.keys(socketDefinitions).length);
  await transport.send(Buffer.from([1, 2, 3]));
  assert.deepEqual(written, [Buffer.from([1, 2, 3])]);
  const pushed = [];
  candidate.resume = () => calls.push('resume');
  transport.receive(bytes => pushed.push(bytes));
  candidate.emit('data', Buffer.from([4, 5]));
  assert.deepEqual(pushed, [Buffer.from([4, 5])], 'bytes after the token reach receive()');
  assert.equal(candidate.destroyed, false);
  await transport.close();
  assert.equal(candidate.destroyed, true);
  assert.equal(calls.filter(call => call === SDK + socketDefinitions.socketClose.offset).length, 1);
});

test('native TCP rejects invalid endpoints before opening a listener', () => {
  assert.deepEqual(endpoint('192.0.2.10', 0), {host: '192.0.2.10', port: 0});
  assert.throws(() => endpoint('not-an-address', 0), /IPv4/);
  assert.throws(() => endpoint('192.0.2.10', 65536), /port/);
});

function failingTcp(run) {
  const closes = [];
  const server = new EventEmitter();
  server.listen = (port, host, callback) => callback();
  server.address = () => ({port: 42123});
  server.close = () => {};
  const rpc = {
    a: {sdk: SDK},
    output: 0x20000000,
    request: async () => ({verified: true}),
    async call() {
      const output = Buffer.alloc(8);
      output.writeBigUInt64LE(BigInt(BASE));
      return {result: 0n, output};
    },
    async callAddress(address, args) {
      if (address === SDK + socketDefinitions.socketInitialized.offset) return {result: 1n};
      if (address === SDK + socketDefinitions.socket.offset) return {result: 7n};
      if (address === SDK + socketDefinitions.socketClose.offset) closes.push(args[0]);
      return {result: 0n};
    },
    async write() {}
  };
  const transport = createTcp({
    rpc,
    host: '192.0.2.10',
    createServer: () => server,
    createWorker: async () => ({run})
  });
  return {transport, closes};
}

test('a refused console connect closes the console socket', async () => {
  const {transport, closes} = failingTcp(async () => [-1n]);
  await assert.rejects(transport, /Console TCP connect failed/);
  assert.deepEqual(closes, [7]);
});

test('a worker lost mid-job leaves the console socket open', async () => {
  const {transport, closes} = failingTcp(async () => {
    throw Error('worker lost');
  });
  await assert.rejects(transport, /worker lost/);
  assert.deepEqual(closes, []);
});

// helper.js
test('the helper default is the main-c33e545 build and $HBMOONLIGHT wins', () => {
  const url = require('node:url').pathToFileURL(
    path.join(__dirname, '../protocol-binary.js')
  );
  const script = `import {HELPER} from '${url.href}'; console.log(HELPER);`;
  const helper = env =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env,
      encoding: 'utf8'
    }).stdout.trim();
  const env = {...process.env};
  delete env.HBMOONLIGHT;
  assert.equal(
    helper(env),
    '/media/storage2/builds/HBLauncher/moonlight-helper-main-c33e545/build/hbmoonlight'
  );
  assert.equal(helper({...env, HBMOONLIGHT: '/x/hbmoonlight'}), '/x/hbmoonlight');
});

// publication-metadata.js
const mapped = 0x40000000;
const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
const destination = {
  index: 1,
  address: mapped + ring.frameOffset(1),
  bytes: ring.FRAME_BYTES,
  sequence: 10,
  color: 1
};

test('publication metadata packs the surface, layout, checksum and sequence', () => {
  const bytes = metadata(destination, frame);
  assert.equal(bytes.length, 32);
  assert.deepEqual(
    [0, 4, 8, 12, 16, 20].map(offset => bytes.readUInt32LE(offset)),
    [1, 1920, 1080, 1920, 1088, 1]
  );
  assert.equal(bytes.readUInt32LE(24), ring.nativeChecksum(10, [1, 1920, 1080, 1920, 1088, 1]));
  assert.equal(bytes.readUInt32LE(28), 10);
});

test('publication metadata rejects an unknown surface and an oversized layout', () => {
  assert.throws(() => metadata({...destination, index: 3}, frame), /Invalid native output/);
  assert.throws(() => metadata({...destination, sequence: 0}, frame), /Invalid native output/);
  assert.throws(
    () => metadata(destination, {...frame, sliceHeight: 2000}),
    /Invalid native output/
  );
});

// live.js
const LIVE = path.resolve(__dirname, '../live.js');
const H264 = ['--codec', 'h264', '--moonlight', 'host', 'Desktop'];

function runDirectory() {
  const directory = fsSync.mkdtempSync(path.join(os.tmpdir(), 'live-dispatch-'));
  fsSync.mkdirSync(path.join(directory, 'shared'));
  fsSync.writeFileSync(
    path.join(directory, 'shared', 'rpc.cjs'),
    "module.exports = {a: {protocol: 3, session: 'launcher-Test01'}};\n"
  );
  fsSync.writeFileSync(
    path.join(directory, 'app-moonlight-1.json'),
    JSON.stringify({
      started: '2026-10-26T00:00:00Z',
      privateStorage: {mapped: 0x10000000, bytes: 0x40000000, memoryFlags: 7}
    })
  );
  return directory;
}

function live(directory, args) {
  const result = spawnSync(process.execPath, [LIVE, directory, ...args], {
    encoding: 'utf8',
    timeout: 20000
  });
  return {status: result.status, error: result.stderr.trim().split('\n').at(-1)};
}

test('live.js hands the staggered skip options to the native H.264 parser', t => {
  const directory = runDirectory();
  t.after(() => fsSync.rmSync(directory, {recursive: true, force: true}));
  assert.deepEqual(live(directory, [...H264, '--decode-wait']), {
    status: 1,
    error: '--decode-wait needs --skip-rule vsync'
  });
  assert.deepEqual(live(directory, [...H264, '--staggered', '--decode-wait']), {
    status: 1,
    error: '--decode-wait needs --skip-rule vsync'
  });
  assert.deepEqual(live(directory, [...H264, '--staggered', '--skip-rule', 'frames']), {
    status: 1,
    error: '--skip-rule takes backlog or vsync'
  });
  assert.deepEqual(
    live(directory, [...H264, '--staggered', '--skip-rule', 'vsync', '--skip-backlog', 'off']),
    {status: 1, error: '--skip-rule vsync needs a --skip-backlog unit count'}
  );
});

test('a valid vsync and decode-wait set passes parsing and stops at the session check', t => {
  const directory = runDirectory();
  t.after(() => fsSync.rmSync(directory, {recursive: true, force: true}));
  for (const staggered of [['--staggered'], []])
    assert.deepEqual(
      live(directory, [...H264, ...staggered, '--skip-rule', 'vsync', '--decode-wait']),
      {status: 1, error: 'Native TCP requires a fresh launcher session from this branch'}
    );
});

test('live.js streams H.264 by default and refuses any other codec', t => {
  const directory = runDirectory();
  t.after(() => fsSync.rmSync(directory, {recursive: true, force: true}));
  assert.deepEqual(live(directory, ['--moonlight', 'host', 'Desktop']), {
    status: 1,
    error: 'Native TCP requires a fresh launcher session from this branch'
  });
  for (const codec of ['hbv1', 'hbv2'])
    assert.deepEqual(live(directory, ['--codec', codec, '--moonlight', 'host', 'Desktop']), {
      status: 1,
      error: '--codec is h264'
    });
});

// present-pacer.js
const PERIOD = 1000 / 120;

/**
 * Drives the pacer through gates against a console that applies on a grid of applyMs: each gate
 * opens a fetch, waits for the pacer, reads (one read costs readMs) until the apply is seen.
 */
async function gates({
  applyMs,
  count,
  readMs = 1,
  pacer,
  clock,
  grid = () => applyMs,
  lateBy = () => 0
}) {
  const reads = [];
  for (let gate = 0; gate < count; gate++) {
    const openedAt = clock.now;
    const step = grid(gate);
    const applyAt = Math.ceil((openedAt + 1e-6) / step) * step;
    await pacer.beforeRead(openedAt);
    clock.now += lateBy(gate);
    let n = 0;
    for (;;) {
      const startedAt = clock.now;
      clock.now += readMs;
      n++;
      const applied = applyAt <= startedAt;
      pacer.observe(startedAt, applied);
      if (applied) break;
      await pacer.pending();
    }
    reads.push(n);
    clock.now += 0.5;
  }
  return reads;
}

async function pacerOn(options = {}) {
  const {create} = await import('../../scheduler/present-pacer.js');
  const clock = {now: 0.3};
  const pacer = create({
    periodMs: PERIOD,
    now: () => clock.now,
    sleep: async ms => {
      clock.now += ms;
    },
    ...options
  });
  return {pacer, clock};
}

test('a console applying every refresh keeps the refresh period and reads once per gate', async () => {
  const {pacer, clock} = await pacerOn();
  const reads = await gates({applyMs: PERIOD, count: 200, pacer, clock});
  assert.equal(pacer.periodMs, PERIOD);
  const extra = reads.slice(20).reduce((sum, n) => sum + n - 1, 0);
  assert.ok(extra <= 18, `${extra} rereads in 180 gates`);
});

test('a console applying every other refresh moves the pacer to the long period', async () => {
  const {pacer, clock} = await pacerOn();
  const learning = await gates({applyMs: 2 * PERIOD, count: 40, pacer, clock});
  assert.equal(pacer.periodMs, 2 * PERIOD);
  const settled = await gates({applyMs: 2 * PERIOD, count: 200, pacer, clock});
  const extra = settled.reduce((sum, n) => sum + n - 1, 0);
  const whileLearning = learning.reduce((sum, n) => sum + n - 1, 0);
  assert.ok(whileLearning >= 12, `${whileLearning} rereads while the short period held`);
  assert.ok(extra <= 20, `${extra} rereads on the long period`);
});

test('midpoint probes bring the short period back once the console applies every refresh', async () => {
  const {pacer, clock} = await pacerOn();
  await gates({applyMs: 2 * PERIOD, count: 60, pacer, clock});
  assert.equal(pacer.periodMs, 2 * PERIOD);
  await gates({applyMs: PERIOD, count: 1000, pacer, clock});
  assert.equal(pacer.periodMs, PERIOD);
  const reads = await gates({applyMs: PERIOD, count: 100, pacer, clock});
  const extra = reads.slice(10).reduce((sum, n) => sum + n - 1, 0);
  assert.ok(extra <= 9, `${extra} rereads back on the short period`);
});

test('a late apply now and then does not move the period', async () => {
  const {pacer, clock} = await pacerOn();
  await gates({applyMs: PERIOD, count: 40, pacer, clock});
  const jittery = gate => (gate % 5 === 0 ? 2 * PERIOD : PERIOD);
  await gates({applyMs: PERIOD, count: 200, pacer, clock, grid: jittery});
  assert.equal(pacer.periodMs, PERIOD);
});

test('a probe read that starts at the next long vsync counts for nothing', async () => {
  const {pacer, clock} = await pacerOn();
  await gates({applyMs: 2 * PERIOD, count: 60, pacer, clock});
  assert.equal(pacer.periodMs, 2 * PERIOD);
  await gates({applyMs: 2 * PERIOD, count: 1000, pacer, clock, lateBy: () => PERIOD + 2});
  assert.equal(pacer.periodMs, 2 * PERIOD, 'late reads on a 60 Hz apply grid never flip it');
});

test('a burst of six late applies flips to the long period and the probes recover it', async () => {
  const {pacer, clock} = await pacerOn();
  await gates({applyMs: PERIOD, count: 40, pacer, clock});
  const burst = gate => (gate < 6 ? 2 * PERIOD : PERIOD);
  const reads = await gates({applyMs: PERIOD, count: 600, pacer, clock, grid: burst});
  assert.equal(pacer.periodMs, PERIOD, 'back on the refresh within 600 gates');
  const extra = reads.reduce((sum, n) => sum + n - 1, 0);
  assert.ok(extra <= 40, `${extra} rereads around the burst`);
});

// receive-wait.js
const KB = 1024;

async function predictor(options = {}) {
  const {create} = await import('../../scheduler/receive-wait.js');
  const clock = {now: 0};
  const sleeps = [];
  const wait = create({
    now: () => clock.now,
    sleep: async ms => {
      sleeps.push(ms);
      clock.now += ms;
    },
    ...options
  });
  return {wait, clock, sleeps};
}

test('a gate whose receive keeps up reads at once', async () => {
  const {wait, sleeps} = await predictor();
  wait.sent(1, 24 * KB, 0);
  assert.equal(await wait.beforeRead(1, false, 2), false);
  wait.observe(1, 1, true);
  wait.sent(2, 24 * KB, 1);
  assert.equal(await wait.beforeRead(2, false, 2), false);
  assert.deepEqual(sleeps, []);
  assert.equal(await wait.beforeRead(9, true, 2), false, 'an unknown unit never waits');
});

test('a pending receive sleeps to its prediction less the read time', async () => {
  const {wait, clock, sleeps} = await predictor({baseMs: 1, perKbMs: 0.25});
  wait.sent(1, 24 * KB, 0);
  clock.now = 2;
  assert.equal(await wait.beforeRead(1, true, 2), true);
  assert.deepEqual(sleeps, [1 + 24 * 0.25 - 2 - 2]);
  assert.equal(clock.now, 1 + 24 * 0.25 - 2);
  clock.now = 20;
  assert.equal(await wait.beforeRead(1, true, 2), false, 'a prediction already past never waits');
});

test('the estimate grows on a late receive and shrinks on an early one', async () => {
  const {wait, clock} = await predictor({baseMs: 1, perKbMs: 0.2, growMs: 0.5, shrinkMs: 0.1});
  wait.sent(1, 10 * KB, 0);
  clock.now = 3;
  wait.observe(1, 3, false, {pendingSeen: false});
  assert.equal(wait.fixedMs, 1.5, 'a pending read past the prediction grows it');
  wait.observe(1, 4, false, {pendingSeen: true});
  assert.equal(wait.fixedMs, 1.5, 'a stalled unit grows it once, not per reread');
  clock.now = 1;
  wait.sent(2, 10 * KB, 1);
  wait.observe(2, 1.5, false, {pendingSeen: false});
  assert.equal(wait.fixedMs, 1.5, 'a pending read before the prediction changes nothing');
  wait.observe(2, 4, true, {waited: true, pendingSeen: true});
  assert.equal(wait.fixedMs, 1.4, 'a waited read that found it received shrinks it');
  wait.observe(2, 4, true, {waited: false, pendingSeen: false});
  assert.equal(wait.fixedMs, 1.4, 'a read that did not wait leaves it');
});

// The R4a collapse (research/r4a-collapse.md): late receives of small units grew a per-KB
// slope until each keyframe slept about 200 ms and the stream fell to keyframes alone.
test('late small receives move a keyframe prediction by the step alone', async () => {
  const {wait, clock} = await predictor({baseMs: 1, perKbMs: 0.2, growMs: 0.5});
  wait.sent(1, 210 * KB, 0);
  const before = wait.predictedAt(1);
  wait.sent(2, KB, 0);
  clock.now = 5;
  wait.observe(2, 5, false, {pendingSeen: false});
  const moved = wait.predictedAt(1) - before;
  assert.ok(Math.abs(moved - 0.5) < 1e-9, `moved ${moved} ms`);
});

test('a keyframe after many late receives sleeps at most one period', async () => {
  const {wait, clock, sleeps} = await predictor({baseMs: 1, perKbMs: 0.2});
  for (let unit = 1; unit <= 50; unit++) {
    wait.sent(unit, 31 * KB, clock.now);
    clock.now += 40;
    wait.observe(unit, clock.now, false, {pendingSeen: false});
    wait.observe(unit, clock.now + 1, true, {waited: false, pendingSeen: true});
  }
  wait.sent(51, 210 * KB, clock.now);
  assert.equal(await wait.beforeRead(51, false, 3), true, 'still bound by the late receives');
  assert.ok(sleeps.at(-1) <= 1000 / 60, `${sleeps.at(-1)} ms sleep`);
  assert.ok(wait.fixedMs <= 1000 / 60, `${wait.fixedMs} ms estimate`);
  const ceiling = wait.fixedMs;
  for (let unit = 52; unit <= 60; unit++) {
    wait.sent(unit, 210 * KB, clock.now);
    assert.equal(await wait.beforeRead(unit, false, 3), true);
    wait.observe(unit, clock.now + 3, true, {waited: true, pendingSeen: false});
  }
  assert.ok(Math.abs(wait.fixedMs - (ceiling - 9 * 0.1)) < 1e-9, 'each slept hit takes a step');
});

test('the link binds after a pending gate and the next first read waits', async () => {
  const {wait, clock, sleeps} = await predictor({baseMs: 1, perKbMs: 0.5});
  wait.sent(1, 8 * KB, 0);
  assert.equal(await wait.beforeRead(1, false, 1), false, 'unbound: the first read goes out');
  wait.observe(1, 1, false, {pendingSeen: false});
  wait.observe(1, 6, true, {waited: false, pendingSeen: true});
  wait.sent(2, 8 * KB, 6);
  clock.now = 6;
  assert.equal(await wait.beforeRead(2, false, 1), true, 'bound: the first read waits');
  assert.deepEqual(sleeps, [6 + 1 + 8 * 0.5 - 1 - 6]);
  wait.observe(2, clock.now + 1, true, {waited: true, pendingSeen: false});
  wait.sent(3, 8 * KB, clock.now);
  assert.equal(await wait.beforeRead(3, false, 1), true, 'a waited gate keeps the link bound');
  wait.observe(3, clock.now + 1, true, {waited: false, pendingSeen: false});
  wait.sent(4, 8 * KB, clock.now);
  assert.equal(await wait.beforeRead(4, false, 1), false, 'a gate that read at once unbinds it');
});

test('sends older than four units are forgotten', async () => {
  const {wait} = await predictor();
  for (let unit = 1; unit <= 6; unit++) wait.sent(unit, KB, unit);
  assert.equal(await wait.beforeRead(1, true, 1), false);
  assert.equal(await wait.beforeRead(2, true, 1), false);
  assert.equal(await wait.beforeRead(3, true, 1), true);
});

// run-summary.js
const row = (presented, extra = {}) => ({
  presented,
  dropped: 0,
  idr: 0,
  resyncs: 0,
  exchanges: presented * 10,
  bridgeMs: presented * 20,
  bridgeByStage: {persistent: {exchanges: presented * 8, bridgeMs: presented * 16}},
  ms: {persistent: presented * 20, read: presented * 5},
  ...extra
});

test('summary skips warm-up rows and reports per-frame bridge cost', () => {
  const rows = [row(3, {idr: 3, dropped: 50}), row(20), row(29), row(30), row(30, {dropped: 2})];
  const summary = summarize(rows);
  assert.equal(summary.seconds, 2);
  assert.equal(summary.presented, 60);
  assert.equal(summary.fps, 30);
  assert.equal(summary.minFps, 30);
  assert.equal(summary.dropped, 2);
  assert.equal(summary.idr, 0);
  assert.equal(summary.requestsPerFrame, 10);
  assert.equal(summary.bridgeMsPerFrame, 20);
  assert.deepEqual(summary.stages.persistent, {
    requestsPerFrame: 8,
    bridgeMsPerFrame: 16,
    wallMsPerFrame: 20,
    waitMsPerFrame: 4
  });
  assert.equal(summary.stages.read.waitMsPerFrame, 5);
});

test('expectations parse strictly and score the summary', () => {
  assert.deepEqual(parseExpect(undefined), {});
  assert.deepEqual(parseExpect('fps=29.5,dropped=0,idr=0'), {fps: 29.5, dropped: 0, idr: 0});
  for (const bad of ['fps', 'fps=', 'speed=3', 'fps=abc', ''])
    assert.throws(() => parseExpect(bad), /--expect/);
  const summary = summarize([row(30), row(30), row(30), row(28), row(30, {idr: 1})]);
  assert.deepEqual(verdict(summary, {fps: 28, idr: 1}), {pass: true, failures: []});
  assert.deepEqual(verdict(summary, {fps: 30, idr: 0, requests: 10}), {
    pass: false,
    failures: ['fps 30', 'idr 0']
  });
});

test('a dropped frame or an IDR after the warmup fails unless the limits allow it', () => {
  const rows = [row(30, {dropped: 9, idr: 2}), row(30), row(30), row(30), row(6, {dropped: 24, idr: 4}), row(30)];
  const summary = summarize(rows);
  assert.deepEqual(verdict(summary, {}), {pass: false, failures: ['dropped 0', 'idr 0']});
  assert.deepEqual(verdict(summary, {dropped: 24, idr: 4}), {pass: true, failures: []});
  assert.deepEqual(verdict(summarize(rows.slice(0, 4)), {}), {pass: true, failures: []});
});

test('a run with no steady rows fails', () => {
  const summary = summarize([row(1), row(2)]);
  assert.equal(summary.seconds, 0);
  assert.deepEqual(verdict(summary, {}), {pass: false, failures: ['no steady rows']});
});

test('staggered rows report decoded fps, skipped presents and the deepest queue', () => {
  const rows = [
    row(10),
    row(60, {decoded: 120, skipped: 60, queued: 2}),
    row(60, {decoded: 118, skipped: 58, queued: 3})
  ];
  const summary = summarize(rows, {warmup: 1});
  assert.equal(summary.decodedFps, 119);
  assert.equal(summary.skipped, 118);
  assert.equal(summary.maxQueued, 3);
  assert.deepEqual(parseExpect('decoded=115,queued=2'), {decoded: 115, queued: 2});
  assert.deepEqual(verdict(summary, {fps: 59, decoded: 115, queued: 2}), {
    pass: false,
    failures: ['queued 2']
  });
});

test('rows with access-unit timing are weighted by units, and rows without it still summarise', () => {
  const timed = (presented, au) => row(presented, {au});
  const summary = summarize(
    [
      row(30),
      timed(60, {
        units: 60,
        gated: 60,
        waitMs: 20,
        maxWaitMs: 31,
        gateAgeMs: 18,
        inHand: 1,
        maxInHand: 2
      }),
      timed(60, {
        units: 20,
        gated: 20,
        waitMs: 40,
        maxWaitMs: 52.5,
        gateAgeMs: 38,
        inHand: 2,
        maxInHand: 3
      }),
      row(60)
    ],
    {warmup: 1}
  );
  assert.deepEqual(summary.au, {
    units: 80,
    gated: 80,
    waitMs: 25,
    maxWaitMs: 52.5,
    gateAgeMs: 23,
    inHand: 1.3,
    maxInHand: 3
  });
  const old = summarize([row(30), row(30), row(30), row(30)]);
  assert.equal(old.au, undefined);
  assert.equal(old.fps, 30);
  assert.deepEqual(verdict(old, {}), {pass: true, failures: []});
});

test('backlog trims are summed apart from dropped frames and fail only an explicit limit', () => {
  const rows = [row(30), row(60, {trimmed: 2, skipped: 2}), row(60, {trimmed: 1, skipped: 3})];
  const summary = summarize(rows, {warmup: 1});
  assert.equal(summary.trimmed, 3);
  assert.equal(summary.skipped, 5);
  assert.equal(summary.dropped, 0);
  assert.deepEqual(verdict(summary, {}), {pass: true, failures: []});
  assert.deepEqual(parseExpect('trimmed=0'), {trimmed: 0});
  assert.deepEqual(verdict(summary, {trimmed: 0}), {pass: false, failures: ['trimmed 0']});
  const old = summarize([row(30), row(30), row(30), row(30)]);
  assert.equal('trimmed' in old, false);
  assert.deepEqual(verdict(old, {trimmed: 0}), {pass: true, failures: []});
});

// bitrate.js
test('default bitrate follows Moonlight for common modes', () => {
  assert.equal(defaultBitrate(1280, 720, 60), 10000);
  assert.equal(defaultBitrate(1920, 1080, 30), 10000);
  assert.equal(defaultBitrate(1920, 1080, 60), 20000);
  assert.equal(defaultBitrate(1920, 1080, 120), 28000);
  assert.equal(defaultBitrate(1280, 720, 120), 14000);
  assert.equal(defaultBitrate(1600, 900, 60), 15000);
});

test('an explicit bitrate wins and auto or absent computes one', () => {
  assert.equal(bitrate(['--bitrate', '8000'], 1920, 1080, 60), '8000');
  assert.equal(bitrate(['--bitrate', 'auto'], 1920, 1080, 90), '24000');
  assert.equal(bitrate([], 1920, 1080, 60), '20000');
  assert.throws(() => bitrate(['--bitrate', 'fast'], 1920, 1080, 60));
});

// bridge-counter.js
test('bridge counter attributes requests and elapsed time to the active stage', async () => {
  let clock = 0;
  let stage = 'split-input';
  const rpc = {
    a: {session: 'test'},
    async callAddress() {
      clock += 3;
      return {result: 0n};
    },
    async read() {
      clock += 5;
      return Buffer.alloc(0x80001);
    },
    async write() {
      clock += 2;
    }
  };
  const counter = instrument(
    rpc,
    () => stage,
    () => clock
  );
  assert.equal(counter.rpc.a, rpc.a);
  await counter.rpc.callAddress(12, []);
  stage = 'publish';
  await counter.rpc.read(24, 0x80001);
  await counter.rpc.write(32, Buffer.alloc(4));
  assert.deepEqual(counter.take(), {
    exchanges: 4,
    bridgeMs: 10,
    bridgeByStage: {
      'split-input': {exchanges: 1, bridgeMs: 3},
      publish: {exchanges: 3, bridgeMs: 7}
    }
  });
  assert.deepEqual(counter.take(), {exchanges: 0, bridgeMs: 0, bridgeByStage: {}});
});

test('failed requests still count and an invalid transfer does not mask its error', async () => {
  let clock = 0;
  const counter = instrument(
    {
      async read() {
        clock += 2;
        throw Error('Bridge disconnected');
      }
    },
    () => 'receive',
    () => clock
  );
  await assert.rejects(counter.rpc.read(0, 16), /Bridge disconnected/);
  await assert.rejects(counter.rpc.read(0, null), /Bridge disconnected/);
  assert.deepEqual(counter.take(), {
    exchanges: 1,
    bridgeMs: 4,
    bridgeByStage: {receive: {exchanges: 1, bridgeMs: 4}}
  });
  assert.equal(requestsFor('write', [0, Buffer.alloc(0x100001)]), 3);
});

test('silentMs is how long the console has left a call unanswered', async () => {
  let clock = 50;
  const answers = [];
  const counter = instrument(
    {request: () => new Promise(resolve => answers.push(resolve))},
    () => 'unit',
    () => clock
  );
  assert.equal(counter.silentMs(), 0, 'nothing pending is not silence');
  const first = counter.rpc.request();
  clock = 1250;
  const second = counter.rpc.request();
  clock = 6050;
  assert.equal(counter.silentMs(), 6000);
  clock = 6100;
  answers[0]();
  await first;
  clock = 6600;
  assert.equal(counter.silentMs(), 500, 'any answer restarts the count');
  answers[1]();
  await second;
  assert.equal(counter.silentMs(), 0);
  clock = 9000;
  const third = counter.rpc.request();
  clock = 9200;
  assert.equal(counter.silentMs(), 200, 'an idle bridge is not counted');
  answers[2]();
  await third;
});

test('a bridge timeout marks the session lost so cleanup skips device calls', async () => {
  const rpc = watchBridge({
    a: {session: 'x'},
    host: '192.0.2.1',
    read: async () => {
      throw Error('RPC read timed out');
    },
    write: async () => {
      throw Error('Invalid write');
    }
  });
  assert.equal(rpc.host, '192.0.2.1');
  await assert.rejects(rpc.write(1, Buffer.alloc(1)), /Invalid write/);
  assert.equal(rpc.bridgeLost, false);
  await assert.rejects(rpc.read(1, 4), /timed out/);
  assert.equal(rpc.bridgeLost, true);
});
