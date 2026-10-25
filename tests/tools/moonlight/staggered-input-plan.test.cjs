const test = require('node:test');
const assert = require('node:assert/strict');
const input = require('./staggered-input-plan.cjs');
const status = require('./staggered-status.cjs');
const ring = require('./ring.cjs');
const SYNC = require('../../sdk/native/os-sync-functions.json');
const {CODE} = require('../../sdk/native/thread.cjs');

const addresses = {
  sdk: 0x7100000000,
  base: 0x7200000000,
  control: 0x7300000000,
  mapped: 0x7400000000,
  scratch: 0x7500000000,
  fd: 4,
  recvFunction: 0x7600000000,
  functions: {sendInput: 0x7700000000, acquireInput: 0x7700001000},
  decoder: 0x7800000000,
  acquireAck: 0x7300000030
};

function checkedSnapshot() {
  const bytes = Buffer.alloc(status.READ_END - status.READ_START);
  const at = offset => offset - status.READ_START;
  bytes.writeUInt32LE(2, at(ring.CONTROL.current));
  bytes.writeUInt32LE(11, at(ring.CONTROL.nativeApplied));
  bytes.writeBigInt64LE(40000n, at(status.STATUS.receive));
  bytes.writeUInt32LE(5, at(status.STATUS.receive + 8));
  bytes.writeBigUInt64LE(0n, at(status.STATUS.input));
  bytes.writeBigUInt64LE(0n, at(status.STATUS.input + 8));
  bytes.writeInt32LE(1, at(status.STATUS.input + 16));
  bytes.writeUInt32LE(4, at(status.STATUS.input + 20));
  bytes.writeBigUInt64LE(0n, at(status.STATUS.acquire));
  bytes.writeInt32LE(0, at(status.STATUS.acquire + 8));
  bytes.writeBigUInt64LE(3n, at(status.STATUS.acquire + 16));
  bytes.writeUInt32LE(3, at(status.STATUS.acquire + 24));
  bytes.writeBigUInt64LE(0n, at(status.STATUS.fetch));
  bytes.writeBigUInt64LE(0n, at(status.STATUS.fetch + 8));
  bytes.writeBigUInt64LE(0n, at(status.STATUS.fetch + 16));
  bytes.writeUInt32LE(2, at(status.STATUS.fetch + 24));
  return status.parse(bytes);
}

const gate = {
  expected: {
    receive: {sequence: 5, bytes: 40000},
    input: {sequence: 4},
    acquire: {sequence: 3, pts: 3n},
    fetch: {sequence: 2},
    ack: {sequence: 11, index: 2}
  },
  input: {index: 1, address: 0x7900000000, capacity: 0x100000},
  current: {sequence: 5, length: 40000, pts: 5n},
  next: {sequence: 6, length: 41000, pts: 6n},
  fetchGate: 0x7300000040,
  ignoredFetchGate: 0x7300000010
};

test('staggered input frames alternate receive and send while stamping checked status', () => {
  const built = input.plan(addresses);
  for (let slot = 0; slot < 2; slot++) {
    assert.ok(built.receive[slot].frame.length < 0x70000);
    assert.ok(built.send[slot].frame.length < 0x70000);
    assert.equal(built.calls.receive[slot][0].args[1], addresses.scratch);
    assert.equal(built.calls.receive[slot][0].args[3], 0x40);
    assert.equal(
      built.calls.receive[slot].at(-1).args[0].u64,
      addresses.control + input.CONTROL.sendDispatch[slot]
    );
    assert.equal(
      built.calls.send[slot].at(-1).args[0].u64,
      addresses.control + input.CONTROL.receiveDispatch[slot]
    );
    assert.equal(built.calls.send[slot][1].function, addresses.functions.sendInput);
    assert.equal(built.calls.send[slot][2].function, addresses.functions.acquireInput);
  }
  assert.equal(built.calls.receive[0][3].args[0].u64, addresses.control + 0x120);
  assert.equal(built.calls.receive[1][3].args[0].u64, addresses.control + 0x1a0);
});

test('the input worker releases N-2, waits for the N-1 acquisition, then submits N', () => {
  const built = input.plan(addresses);
  const sync = name => addresses.sdk + SYNC[name].offset;
  for (let slot = 0; slot < 2; slot++) {
    const descriptor = addresses.control + input.CONTROL.descriptors[slot];
    const [, , gate, fetch, ack, dispatch] = built.calls.receive[slot];
    assert.equal(built.calls.receive[slot].length, 6);
    assert.deepEqual(gate, {
      function: sync('waitLightEvent'),
      args: [addresses.control + input.CONTROL.decodeGate, 0, 0, 0]
    });
    assert.deepEqual(fetch, {
      function: sync('signalLightEvent'),
      args: [{u64: descriptor + input.DESCRIPTOR.fetchGate}, 0, 0, 0]
    });
    assert.deepEqual(ack, {
      function: sync('waitLightEvent'),
      args: [addresses.acquireAck, 0, 0, 0]
    });
    assert.equal(dispatch.function, addresses.sdk + CODE.longjmp.offset);
    assert.deepEqual(dispatch.args[0], {u64: addresses.control + input.CONTROL.sendDispatch[slot]});
    const send = built.calls.send[slot].map(call => call.function);
    assert.equal(send.indexOf(addresses.functions.sendInput), 1);
    assert.ok(!send.includes(sync('signalLightEvent')));
    assert.ok(!send.includes(sync('waitLightEvent')));
  }
  assert.throws(() => input.plan({...addresses, acquireAck: 0}), /addresses/);
});

test('one gate write carries checked current input and next receive descriptor', () => {
  const bytes = input.gateWrite({snapshot: checkedSnapshot(), ...gate});
  assert.equal(bytes.length, 0x100);
  assert.equal(bytes.readUInt32LE(0), 5);
  assert.equal(bytes.readUInt32LE(4), 40000);
  assert.equal(bytes.readBigUInt64LE(16), BigInt(gate.input.address));
  assert.equal(bytes.readUInt32LE(24), 1);
  assert.equal(bytes.readBigUInt64LE(32), BigInt(gate.fetchGate));
  assert.equal(bytes.readUInt32LE(0x80), 6);
  assert.equal(bytes.readUInt32LE(0x80 + 4), 41000);
  assert.equal(bytes.readBigUInt64LE(0x80 + 16), 0n);
});

test('a failed receive or unchecked input slot cannot produce a decode gate write', () => {
  const short = checkedSnapshot();
  short.receive.count = 39999n;
  assert.throws(() => input.gateWrite({snapshot: short, ...gate}), /Short receive/);
  assert.throws(
    () => input.gateWrite({snapshot: checkedSnapshot(), ...gate, input: {...gate.input, index: 2}}),
    /checked decoder buffer/
  );
  assert.throws(
    () => input.gateWrite({snapshot: checkedSnapshot(), ...gate, input: {...gate.input, capacity: 30000}}),
    /checked decoder buffer/
  );
});
