const test = require('node:test');
const assert = require('node:assert/strict');
const definitions = require('../../sdk/native/movie-functions.json');
const registration = require('../../sdk/native/movie-event-functions.json').registerClientEvents;
const sync = require('../../sdk/native/os-sync-functions.json');
const {CODE} = require('../../sdk/native/thread.cjs');
const {PREAMBLE} = require('../../smilebasic/engine/shared/frames.cjs');
const {create} = require('./persistent-decoder-worker.cjs');

const SDK = 0x40000000;
const MODULE = 0x50000000;
const decoder = 0x70000000;
const output = decoder + 0x300;
const format = decoder + 0x180;

function fixture({
  invalidOutput = false,
  noAcquired = false,
  noFetchCompleted = false,
  threadStuck = false,
  spawnFails = false
} = {}) {
  const regions = [];
  const calls = [];
  const add = (base, size) => {
    const region = {base, buffer: Buffer.alloc(size)};
    regions.push(region);
    return region;
  };
  const regionAt = address =>
    regions.find(region => address >= region.base && address < region.base + region.buffer.length);
  const write = (address, bytes) => {
    const region = regionAt(address);
    assert.ok(region, `unmapped write at 0x${address.toString(16)}`);
    bytes.copy(region.buffer, address - region.base);
  };
  const read = (address, length) => {
    const region = regionAt(address);
    assert.ok(region, `unmapped read at 0x${address.toString(16)}`);
    return Buffer.from(
      region.buffer.subarray(address - region.base, address - region.base + length)
    );
  };
  let allocations = 0;
  let control = 0;
  const rpc = {
    a: {sdk: SDK},
    output: 0x20000000,
    async request(request) {
      assert.equal(request.command, 'verify-function');
      return {verified: true};
    },
    async call(offset, args) {
      assert.equal(args[1], 4096);
      const base = allocations++ ? 0x61000000 : 0x60000000;
      add(base, args[2]);
      if (args[2] === 4096) control = base;
      const result = Buffer.alloc(8);
      result.writeBigUInt64LE(BigInt(base));
      return {result: 0n, output: result};
    },
    async callAddress(address, args) {
      calls.push({address, args});
      if (address === SDK + CODE.create.offset) {
        if (spawnFails) throw Error('Bridge dropped during thread creation');
        const thread = Buffer.alloc(8);
        thread.writeBigUInt64LE(0x1234n);
        write(args[0], thread);
      }
      if (address === SDK + CODE.tryWait.offset) return {result: threadStuck ? 0n : 1n};
      if (address === SDK + sync.tryWaitLightEvent.offset) return {result: 1n};
      return {result: 0n};
    },
    read,
    write: async (address, bytes) => write(address, bytes),
    async pair(operations, outputBytes) {
      assert.equal(operations[0].address, SDK + sync.tryWaitLightEvent.offset);
      assert.equal(operations[1].offset, 0x586fb0);
      assert.equal(outputBytes, 44);
      calls.push({address: operations[0].address, paired: true});
      return {
        results: [
          noAcquired && operations[0].args[0] === control + 0x10 ? 0n : 1n,
          BigInt(rpc.output)
        ],
        output: read(operations[1].args[1], outputBytes)
      };
    },
    async writeAndCall(address, bytes, target, args) {
      write(address, bytes);
      assert.equal(target, SDK + sync.signalLightEvent.offset);
      if (args[0] === control) {
        const result = Buffer.alloc(44);
        result.writeInt32LE(invalidOutput ? -1 : 2, 16);
        result.writeBigUInt64LE(read(control + 0x1a0 + 16, 8).readBigUInt64LE(), 24);
        result.writeUInt32LE(read(control + 0x1a0, 4).readUInt32LE(), 40);
        write(control + 0x120, result);
      } else if (args[0] === control + 0x20) {
        const result = Buffer.alloc(44);
        result.writeInt32LE(1, 32);
        result.writeUInt32LE(noFetchCompleted ? 0 : read(control + 0x1a0, 4).readUInt32LE(), 40);
        write(control + 0x160, result);
      } else assert.fail('unexpected gate');
      calls.push({address: target, args, combined: true});
      return {result: 0n};
    }
  };
  const module = {
    base: MODULE,
    symbols: [
      {
        name: registration.symbol,
        section: '.text',
        offset: registration.offset,
        size: registration.size
      }
    ]
  };
  const functions = Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [name, MODULE + definition.offset])
  );
  return {
    rpc,
    module,
    functions,
    calls,
    read,
    write,
    get control() {
      return control;
    }
  };
}

function emulate(f, entry, onCall) {
  const loadTable = SDK + CODE.loadTable.offset;
  const call4 = SDK + CODE.call4.offset;
  const save = SDK + CODE.saveResult64.offset;
  const exit = SDK + CODE.exit.offset;
  const jump = SDK + CODE.longjmp.offset;
  const peek64 = address => Number(f.read(address, 8).readBigUInt64LE());
  const poke64 = (address, value) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)));
    f.write(address, bytes);
  };
  let registers;
  let pc;
  let result = 0n;
  function enter(address) {
    registers = {
      x4: 0,
      x5: 0,
      x8: 0,
      x19: peek64(address),
      x20: peek64(address + 8),
      x21: peek64(address + 0x10),
      x25: peek64(address + 0x30),
      sp: peek64(address + 0x68)
    };
    pc = peek64(address + 0x58);
  }
  enter(entry);
  for (let steps = 0; steps < 10000; steps++) {
    if (pc === exit) return;
    if (pc === SDK + PREAMBLE) {
      registers.x4 = registers.x21;
      registers.x5 = registers.x20;
      pc = registers.x19;
    } else if (pc === loadTable || pc === loadTable + 8) {
      if (pc === loadTable) registers.x8 = peek64(registers.x21);
      registers.x20 = peek64(registers.sp + 0x20);
      registers.x19 = peek64(registers.sp + 0x28);
      registers.x21 = peek64(registers.sp + 0x10);
      pc = peek64(registers.sp + 8);
      registers.sp += 0x30;
    } else if (pc === call4) {
      const target = peek64(registers.x8 + 0x68);
      const args = [
        registers.x25,
        registers.x21,
        registers.x20,
        registers.x19,
        registers.x4,
        registers.x5
      ];
      if (target === jump) {
        enter(args[0]);
        continue;
      }
      if (target === SDK + 0x586fb0 || target === SDK + 0x5872f0) {
        f.write(args[0], f.read(args[1], args[2]));
        result = BigInt(args[0]);
      } else {
        result = BigInt(onCall(target, args) ?? 0);
      }
      registers.x4 = registers.x5 = 0;
      registers.x20 = peek64(registers.sp + 0xe0);
      registers.x19 = peek64(registers.sp + 0xe8);
      registers.x21 = peek64(registers.sp + 0xd8);
      registers.x25 = peek64(registers.sp + 0xb8);
      pc = peek64(registers.sp + 0xa8);
      registers.sp += 0xf0;
    } else if (pc === save) {
      poke64(registers.x19, result);
      registers.x19 = peek64(registers.sp + 0x10);
      pc = peek64(registers.sp + 8);
      registers.sp += 0x20;
    } else {
      throw Error('Unknown worker gadget at 0x' + pc.toString(16));
    }
  }
  throw Error('Worker frame did not exit');
}

test('persistent decoder uses separate acquire and fetch gates, then joins', async () => {
  const f = fixture();
  const worker = await create({
    rpc: f.rpc,
    module: f.module,
    functions: f.functions,
    decoder,
    output,
    format
  });
  await worker.register();
  await worker.start();
  for (const pts of [90000, 180000]) {
    const job = await worker.begin({index: 1, length: 4096, pts});
    assert.equal(f.calls.filter(call => call.combined).length, pts === 90000 ? 1 : 3);
    const completed = await worker.finish(job, {address: 0x72000000, bytes: 0x400000});
    assert.equal(completed.pts, BigInt(pts));
    assert.deepEqual(completed.input, {status: 0, index: 1});
  }
  assert.equal(f.calls.filter(call => call.combined).length, 4);
  assert.equal(f.calls.filter(call => call.paired).length, 4);
  assert.equal(f.read(f.control + 0x1c0, 8).readBigUInt64LE(), 0x72000000n);
  await worker.stop();
  await worker.finalize();
  assert.equal(
    f.calls.filter(call => call.address === SDK + sync.finalizeLightEvent.offset).length,
    5
  );
  assert.equal(f.calls.filter(call => call.address === SDK + sync.finalizeEvent.offset).length, 1);
});

test('invalid acquired index never opens the output fetch gate', async () => {
  const f = fixture({invalidOutput: true});
  const worker = await create({
    rpc: f.rpc,
    module: f.module,
    functions: f.functions,
    decoder,
    output,
    format
  });
  await worker.register();
  await worker.start();
  await assert.rejects(
    worker.run({
      index: 1,
      length: 4096,
      pts: 90000,
      destination: {address: 0x72000000, bytes: 0x400000}
    }),
    /acquire returned 0x100e/
  );
  assert.equal(f.calls.filter(call => call.combined).length, 1);
  await worker.stop();
  await worker.finalize();
});

test('a timed out worker keeps the decoder events alive', async () => {
  const f = fixture({noAcquired: true, threadStuck: true});
  const worker = await create({
    rpc: f.rpc,
    module: f.module,
    functions: f.functions,
    decoder,
    output,
    format,
    pollTimeoutMs: 10,
    stopTimeoutMs: 10
  });
  await worker.register();
  await worker.start();
  await assert.rejects(
    worker.run({
      index: 1,
      length: 4096,
      pts: 90000,
      destination: {address: 0x72000000, bytes: 0x400000}
    }),
    /output acquire timed out/
  );
  await assert.rejects(worker.stop(), /decoder and events retained/);
  await assert.rejects(worker.finalize(), /events retained/);
  assert.equal(f.calls.filter(call => call.address === SDK + sync.finalizeEvent.offset).length, 0);
});

test('an uncertain thread creation retains decoder resources', async () => {
  const f = fixture({spawnFails: true});
  const worker = await create({
    rpc: f.rpc,
    module: f.module,
    functions: f.functions,
    decoder,
    output,
    format
  });
  await worker.register();
  await assert.rejects(worker.start(), /Bridge dropped/);
  await assert.rejects(worker.stop(), /creation is uncertain/);
  await assert.rejects(worker.finalize(), /events retained/);
});

test('diagnostic stages stop after their selected first-job call', async () => {
  for (const stage of ['gate', 'dispatch', 'send', 'wait', 'acquire']) {
    const f = fixture();
    const worker = await create({
      rpc: f.rpc,
      module: f.module,
      functions: f.functions,
      decoder,
      output,
      format
    });
    await worker.register();
    await worker.start({stage});
    const result = await worker.run({
      index: 1,
      length: 4096,
      pts: 90000,
      destination: {address: 0x72000000, bytes: 0x400000}
    });
    assert.equal(result.probe.stage, stage);
    assert.equal(f.calls.filter(call => call.combined).length, 1);
    assert.equal(f.calls.filter(call => call.paired).length, 1);
    await worker.stop();
    await worker.finalize();
  }
});

test('first gated wide call forwards the access-unit index, length and timestamp', async () => {
  const f = fixture();
  const worker = await create({
    rpc: f.rpc,
    module: f.module,
    functions: f.functions,
    decoder,
    output,
    format
  });
  await worker.register();
  await worker.start({stage: 'send'});
  const job = Buffer.alloc(24);
  job.writeUInt32LE(1, 0);
  job.writeInt32LE(3, 4);
  job.writeUInt32LE(4096, 8);
  job.writeBigUInt64LE(90000n, 16);
  f.write(f.control + 0x1a0, job);
  const seen = [];
  emulate(f, 0x60000000 + 0x10000, (target, args) => {
    seen.push({target, args});
    return 0;
  });
  const send = seen.find(call => call.target === f.functions.sendInput);
  assert.deepEqual(send.args, [decoder, 3, 0, 4096, 90000, 0]);
  await worker.stop();
  await worker.finalize();
});

test('first full gated job carries the acquired index into output fetch', async () => {
  const f = fixture();
  const worker = await create({
    rpc: f.rpc,
    module: f.module,
    functions: f.functions,
    decoder,
    output,
    format
  });
  await worker.register();
  await worker.start();
  const job = Buffer.alloc(24);
  job.writeUInt32LE(1, 0);
  job.writeInt32LE(3, 4);
  job.writeUInt32LE(4096, 8);
  job.writeBigUInt64LE(90000n, 16);
  f.write(f.control + 0x1a0, job);
  const destination = Buffer.alloc(16);
  destination.writeBigUInt64LE(0x72000000n, 0);
  destination.writeBigUInt64LE(0x400000n, 8);
  f.write(f.control + 0x1c0, destination);
  const seen = [];
  const done = Error('done');
  assert.throws(
    () =>
      emulate(f, 0x60000000 + 0x10000, (target, args) => {
        if (target === f.functions.acquireOutput) {
          const index = Buffer.alloc(4);
          index.writeInt32LE(2);
          f.write(args[1], index);
          const pts = Buffer.alloc(8);
          pts.writeBigUInt64LE(90000n);
          f.write(args[2], pts);
        }
        if (target === SDK + sync.signalLightEvent.offset && args[0] === f.control + 0x30)
          throw done;
        seen.push({target, args});
        return 0;
      }),
    error => error === done
  );
  assert.deepEqual(seen.find(call => call.target === f.functions.bufferSetData).args.slice(0, 3), [
    output,
    0x72000000,
    0x400000
  ]);
  assert.deepEqual(seen.find(call => call.target === f.functions.getOutput).args.slice(0, 4), [
    decoder,
    2,
    output,
    format
  ]);
  assert.equal(seen.find(call => call.target === f.functions.releaseOutput).args[1], 2);
  await worker.stop();
  await worker.finalize();
});

test('full fetch re-enters the gate frame after signalling completion', async () => {
  const f = fixture();
  const worker = await create({
    rpc: f.rpc,
    module: f.module,
    functions: f.functions,
    decoder,
    output,
    format
  });
  await worker.register();
  await worker.start();
  const job = Buffer.alloc(24);
  job.writeUInt32LE(1, 0);
  job.writeInt32LE(3, 4);
  job.writeUInt32LE(4096, 8);
  job.writeBigUInt64LE(90000n, 16);
  f.write(f.control + 0x1a0, job);
  const destination = Buffer.alloc(16);
  destination.writeBigUInt64LE(0x72000000n, 0);
  destination.writeBigUInt64LE(0x400000n, 8);
  f.write(f.control + 0x1c0, destination);
  const reachedGate = Error('re-entered gate');
  let gates = 0;
  let done = false;
  const entry = address => f.read(address + 0x58, 8).readBigUInt64LE();
  const gateFrame = 0x60000000 + 0x10000;
  const decodeFrame = 0x60000000 + 0x110000;
  const fetchFrame = 0x60000000 + 0x210000;
  assert.throws(
    () =>
      emulate(f, gateFrame, (target, args) => {
        if (target === SDK + sync.waitLightEvent.offset && args[0] === f.control) {
          gates++;
          if (gates === 2) throw reachedGate;
        }
        if (target === f.functions.sendInput) {
          f.write(gateFrame + 0x58, Buffer.alloc(8));
          f.write(decodeFrame + 0x58, Buffer.alloc(8));
        }
        if (target === f.functions.acquireOutput) {
          const index = Buffer.alloc(4);
          index.writeInt32LE(2);
          f.write(args[1], index);
        }
        if (target === f.functions.bufferSetData) f.write(fetchFrame + 0x58, Buffer.alloc(8));
        if (target === SDK + sync.signalLightEvent.offset && args[0] === f.control + 0x30)
          done = true;
        return 0;
      }),
    error => error === reachedGate
  );
  assert.equal(done, true);
  assert.equal(entry(gateFrame), entry(0x60000000 + 0x80000));
  assert.equal(entry(decodeFrame), entry(0x60000000 + 0x180000));
  assert.equal(entry(fetchFrame), entry(0x60000000 + 0x280000));
  await worker.stop();
  await worker.finalize();
});

test('fetch probe stages stop after the selected native call', async () => {
  const fetchNames = ['bufferSetData', 'getOutput', 'releaseOutput', 'acquireInput'];
  const stages = [
    ['setData', ['bufferSetData']],
    ['getOutput', ['bufferSetData', 'getOutput']],
    ['release', ['bufferSetData', 'getOutput', 'releaseOutput']],
    ['input', ['bufferSetData', 'getOutput', 'releaseOutput', 'acquireInput']],
    ['done', ['bufferSetData', 'getOutput', 'releaseOutput', 'acquireInput']],
    ['restore', ['bufferSetData', 'getOutput', 'releaseOutput', 'acquireInput']]
  ];
  for (const [stage, expected] of stages) {
    const f = fixture();
    const worker = await create({
      rpc: f.rpc,
      module: f.module,
      functions: f.functions,
      decoder,
      output,
      format
    });
    await worker.register();
    await worker.start({stage});
    const job = Buffer.alloc(24);
    job.writeUInt32LE(1, 0);
    job.writeInt32LE(3, 4);
    job.writeUInt32LE(4096, 8);
    job.writeBigUInt64LE(90000n, 16);
    f.write(f.control + 0x1a0, job);
    const destination = Buffer.alloc(16);
    destination.writeBigUInt64LE(0x72000000n, 0);
    destination.writeBigUInt64LE(0x400000n, 8);
    f.write(f.control + 0x1c0, destination);
    const seen = [];
    const done = Error('probe done');
    assert.throws(
      () =>
        emulate(f, 0x60000000 + 0x10000, (target, args) => {
          if (target === f.functions.acquireOutput) {
            const index = Buffer.alloc(4);
            index.writeInt32LE(2);
            f.write(args[1], index);
          }
          if (target === SDK + sync.signalLightEvent.offset && args[0] === f.control + 0x1d0)
            throw done;
          seen.push(target);
          return 0;
        }),
      error => error === done
    );
    assert.deepEqual(
      seen.filter(target => fetchNames.some(name => target === f.functions[name])),
      expected.map(name => f.functions[name]),
      stage
    );
    await worker.stop();
    await worker.finalize();
  }
});

test('fetch probes release an acquired output only when their body did not', async () => {
  for (const stage of ['setData', 'getOutput', 'release', 'input', 'done', 'restore']) {
    const f = fixture({noFetchCompleted: true});
    const worker = await create({
      rpc: f.rpc,
      module: f.module,
      functions: f.functions,
      decoder,
      output,
      format
    });
    await worker.register();
    await worker.start({stage});
    const result = await worker.run({
      index: 1,
      length: 4096,
      pts: 90000,
      destination: {address: 0x72000000, bytes: 0x400000}
    });
    assert.equal(result.probe.stage, stage);
    assert.equal(f.read(f.control + 0x1c0, 16).readBigUInt64LE(), 0x72000000n);
    await worker.stop();
    assert.equal(
      f.calls.filter(call => call.address === f.functions.releaseOutput).length,
      ['setData', 'getOutput'].includes(stage) ? 1 : 0,
      stage
    );
    await worker.finalize();
  }
});
