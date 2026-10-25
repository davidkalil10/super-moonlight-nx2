const test = require('node:test');
const assert = require('node:assert/strict');
const definitions = require('../../sdk/native/movie-functions.json');
const registration = require('../../sdk/native/movie-event-functions.json').registerClientEvents;
const sync = require('../../sdk/native/os-sync-functions.json');
const {CODE} = require('../../sdk/native/thread.cjs');
const {create} = require('./persistent-decoder-worker.cjs');

const SDK = 0x40000000;
const MODULE = 0x50000000;
const decoder = 0x70000000;
const output = decoder + 0x300;
const format = decoder + 0x180;

function fixture({
  invalidOutput = false,
  noAcquired = false,
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
        result.writeUInt32LE(read(control + 0x1a0, 4).readUInt32LE(), 40);
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
    get control() {
      return control;
    }
  };
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
    const completed = await worker.run({
      index: 1,
      length: 4096,
      pts,
      destination: {address: 0x72000000, bytes: 0x400000}
    });
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
