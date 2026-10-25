const test = require('node:test');
const assert = require('node:assert/strict');
const definitions = require('../../sdk/native/movie-functions.json');
const registration = require('../../sdk/native/movie-event-functions.json').registerClientEvents;
const {CODE} = require('../../sdk/native/thread.cjs');
const ring = require('./ring.cjs');
const status = require('./staggered-status.cjs');
const inputPlan = require('./staggered-input-plan.cjs');
const outputPlan = require('./staggered-output-plan.cjs');
const {create} = require('./staggered-worker.cjs');

function fixture() {
  const sdk = 0x40000000;
  const moduleBase = 0x50000000;
  const mapped = 0x80000000;
  const regions = [{base: mapped, bytes: Buffer.alloc(ring.CONTROL_BYTES)}];
  const calls = [];
  let allocations = 0;
  const regionAt = address =>
    regions.find(region => address >= region.base && address < region.base + region.bytes.length);
  const read = (address, length) => {
    const region = regionAt(address);
    assert.ok(region, `unmapped read at ${address.toString(16)}`);
    return Buffer.from(region.bytes.subarray(address - region.base, address - region.base + length));
  };
  const write = (address, bytes) => {
    const region = regionAt(address);
    assert.ok(region, `unmapped write at ${address.toString(16)}`);
    bytes.copy(region.bytes, address - region.base);
  };
  const rpc = {
    a: {sdk},
    output: 0x20000000,
    async request() {
      return {verified: true};
    },
    async call(_offset, args) {
      const base = 0x60000000 + allocations++ * 0x1000000;
      regions.push({base, bytes: Buffer.alloc(args[2])});
      const output = Buffer.alloc(8);
      output.writeBigUInt64LE(BigInt(base));
      return {result: 0n, output};
    },
    async callAddress(address, args) {
      calls.push({address, args});
      if (address === sdk + CODE.create.offset) {
        const thread = Buffer.alloc(8);
        thread.writeBigUInt64LE(BigInt(0x1234 + calls.length));
        write(args[0], thread);
      }
      if (address === sdk + CODE.tryWait.offset) return {result: 1n};
      if (address === moduleBase + definitions.bufferData.offset)
        return {result: 0x7900000000n};
      if (address === moduleBase + definitions.bufferCapacity.offset)
        return {result: 0x100000n};
      if (address === moduleBase + definitions.acquireInput.offset) {
        const index = Buffer.alloc(4);
        index.writeInt32LE(1);
        write(args[1], index);
      }
      return {result: 0n};
    },
    read: async (address, length) => read(address, length),
    write: async (address, bytes) => write(address, bytes),
    async writeAndCall(address, bytes, target, args) {
      write(address, bytes);
      calls.push({address: target, args, combined: true});
      return {result: 0n};
    }
  };
  const transport = {
    fd: 12,
    maxAccessUnit: 0x100000,
    recvFunction: sdk + 0x1234,
    aborted: false,
    async send() {},
    abort() {
      this.aborted = true;
    }
  };
  const module = {
    base: moduleBase,
    symbols: [{
      name: registration.symbol,
      section: '.text',
      offset: registration.offset,
      size: registration.size
    }]
  };
  const functions = Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [name, moduleBase + definition.offset])
  );
  const publication = {mapped, color: 1};
  return {rpc, transport, module, functions, publication, read, write, calls, sdk};
}

async function started(fixture) {
  const worker = await create({
    rpc: fixture.rpc,
    module: fixture.module,
    functions: fixture.functions,
    decoder: 0x70000000,
    output: 0x70000300,
    format: 0x70000180,
    transport: fixture.transport,
    publication: fixture.publication
  });
  await worker.register();
  await worker.start({sequence: 1, length: 40000, pts: 1n});
  return worker;
}

test('staggered workers install two alternating frames and can stop both waits', async () => {
  const f = fixture();
  const worker = await started(f);
  assert.equal(worker.diagnostics.started, true);
  assert.equal(worker.diagnostics.decodeGateSignals, 0);
  await worker.stopInput();
  assert.equal(f.transport.aborted, true);
  await worker.stopOutput();
  assert.deepEqual(worker.diagnostics.joined, [true, true]);
  await worker.stop();
  await worker.finalize();
  assert.equal(worker.diagnostics.retained, false);
  const control = 0x62000000;
  const inputExit = 0x60000000 + 0x3f0000;
  const outputExit = 0x61000000 + 0x3f0000;
  for (const offset of [
    ...inputPlan.CONTROL.sendDispatch,
    ...inputPlan.CONTROL.receiveDispatch
  ])
    assert.equal(f.read(control + offset, 8).readBigUInt64LE(), BigInt(inputExit));
  for (const offset of [
    ...outputPlan.CONTROL.fetchDispatch,
    ...outputPlan.CONTROL.acquireDispatch
  ])
    assert.equal(f.read(control + offset, 8).readBigUInt64LE(), BigInt(outputExit));
});

test('short receive keeps staggered decode and fetch gates closed', async () => {
  const f = fixture();
  const worker = await started(f);
  const receive = Buffer.alloc(12);
  receive.writeBigInt64LE(39999n);
  receive.writeUInt32LE(1, 8);
  f.write(f.publication.mapped + status.STATUS.receive, receive);
  const before = f.calls.filter(call => call.combined).length;
  await assert.rejects(
    () => worker.openGates({
      snapshot: status.parse(f.read(
        f.publication.mapped + status.READ_START,
        status.READ_END - status.READ_START
      )),
      expected: {receive: {sequence: 1, bytes: 40000}},
      inputSlot: {index: 0, address: 0x7900000000, capacity: 0x100000},
      current: {sequence: 1, length: 40000, pts: 1n},
      next: {sequence: 2, length: 40000, pts: 2n}
    }),
    /Short receive/
  );
  assert.equal(f.calls.filter(call => call.combined).length, before);
  assert.equal(worker.diagnostics.decodeGateSignals, 0);
  await worker.stop();
  await worker.finalize();
});

test('a checked bootstrap receive opens exactly one combined native gate write', async () => {
  const f = fixture();
  const worker = await started(f);
  const receive = Buffer.alloc(12);
  receive.writeBigInt64LE(40000n);
  receive.writeUInt32LE(1, 8);
  f.write(f.publication.mapped + status.STATUS.receive, receive);
  await worker.openGates({
    snapshot: await worker.readStatus(),
    expected: {receive: {sequence: 1, bytes: 40000}},
    inputSlot: {index: 0, address: 0x7900000000, capacity: 0x100000},
    current: {sequence: 1, length: 40000, pts: 1n},
    next: {sequence: 2, length: 40000, pts: 2n}
  });
  const combined = f.calls.filter(call => call.combined);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].args[0], 0x62000000 + inputPlan.CONTROL.decodeGate);
  assert.equal(worker.diagnostics.decodeGateSignals, 1);
  await worker.stop();
  await worker.finalize();
});

test('stopping a held output releases the checked decoder slot once', async () => {
  const f = fixture();
  const worker = await started(f);
  const acquired = Buffer.alloc(28);
  acquired.writeInt32LE(2, 8);
  acquired.writeBigUInt64LE(3n, 16);
  acquired.writeUInt32LE(3, 24);
  f.write(f.publication.mapped + status.STATUS.acquire, acquired);
  await worker.stop();
  await worker.stop();
  const releases = f.calls.filter(call => call.address === f.functions.releaseOutput);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].args[1], 2);
  await worker.finalize();
});

test('input buffers are cached and a missing slot can be reacquired exceptionally', async () => {
  const f = fixture();
  const worker = await started(f);
  assert.deepEqual(await worker.inputSlot(1), {
    index: 1,
    address: 0x7900000000,
    capacity: 0x100000
  });
  await worker.inputSlot(1);
  assert.equal(f.calls.filter(call => call.address === f.functions.getInput).length, 1);
  const pending = Buffer.alloc(16);
  pending.writeBigUInt64LE(0x100en);
  pending.writeInt32LE(-1, 8);
  pending.writeUInt32LE(1, 12);
  f.write(f.publication.mapped + status.STATUS.input + 8, pending);
  assert.deepEqual(await worker.retryInputSlot(1), {status: 0, index: 1});
  assert.equal(
    f.read(f.publication.mapped + status.STATUS.input + 8, 8).readBigUInt64LE(),
    0n
  );
  await worker.stop();
  await worker.finalize();
  assert.equal(f.calls.filter(call => call.address === f.functions.bufferDestroy).length, 1);
});
