const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decode,
  toMoonlight,
  same,
  readController,
  NEUTRAL
} = require('../../../hbl-moonlight/host/input/controller.js');

function npad({buttons = 0, lx = 0, ly = 0, rx = 0, ry = 0, connected = true} = {}) {
  const bytes = Buffer.alloc(64);
  bytes.writeBigUInt64LE(7n, 0);
  bytes.writeUInt32LE(buttons, 8);
  bytes.writeInt32LE(lx, 16);
  bytes.writeInt32LE(ly, 20);
  bytes.writeInt32LE(rx, 24);
  bytes.writeInt32LE(ry, 28);
  bytes.writeUInt32LE(connected ? 1 : 0, 32);
  return bytes;
}

const map = (fields, layout) => toMoonlight(decode(npad(fields)), layout);

test('face buttons map by position by default', () => {
  assert.equal(map({buttons: 0b0010}).buttonFlags, 0x1000);
  assert.equal(map({buttons: 0b0001}).buttonFlags, 0x2000);
  assert.equal(map({buttons: 0b1000}).buttonFlags, 0x4000);
  assert.equal(map({buttons: 0b0100}).buttonFlags, 0x8000);
});

test('face buttons map by label on request', () => {
  assert.equal(map({buttons: 0b0001}, 'labels').buttonFlags, 0x1000);
  assert.equal(map({buttons: 0b0010}, 'labels').buttonFlags, 0x2000);
  assert.equal(map({buttons: 0b0100}, 'labels').buttonFlags, 0x4000);
  assert.equal(map({buttons: 0b1000}, 'labels').buttonFlags, 0x8000);
});

test('shoulders, sticks clicks, plus, minus and dpad use Limelight flags', () => {
  const cases = [
    [1 << 4, 0x0040],
    [1 << 5, 0x0080],
    [1 << 6, 0x0100],
    [1 << 7, 0x0200],
    [1 << 10, 0x0010],
    [1 << 11, 0x0020],
    [1 << 12, 0x0004],
    [1 << 13, 0x0001],
    [1 << 14, 0x0008],
    [1 << 15, 0x0002]
  ];
  for (const [bit, flag] of cases) assert.equal(map({buttons: bit}).buttonFlags, flag);
});

test('ZL and ZR become full triggers', () => {
  const state = map({buttons: (1 << 8) | (1 << 9)});
  assert.equal(state.buttonFlags, 0);
  assert.equal(state.leftTrigger, 255);
  assert.equal(state.rightTrigger, 255);
  assert.equal(map({buttons: 1 << 8}).rightTrigger, 0);
});

test('opposite dpad directions cancel', () => {
  assert.equal(map({buttons: (1 << 12) | (1 << 14) | (1 << 13)}).buttonFlags, 0x0001);
});

test('sticks keep the Switch Y-up sign and clamp to int16', () => {
  const state = map({lx: -32768, ly: 40000, rx: 1234, ry: -32769});
  assert.equal(state.leftStickX, -32768);
  assert.equal(state.leftStickY, 32767);
  assert.equal(state.rightStickX, 1234);
  assert.equal(state.rightStickY, -32768);
});

test('a disconnected pad reads neutral', () => {
  const state = map({buttons: 0xffff, lx: 9000, connected: false});
  assert.deepEqual(state, toMoonlight(NEUTRAL));
  assert.equal(state.connected, false);
  assert.equal(state.buttonFlags, 0);
});

test('pad sources add buttons from connected controllers only', () => {
  const sources = Buffer.concat([
    npad({buttons: 1 << 6, connected: false}),
    npad({buttons: 1 << 1}),
    npad(),
    npad(),
    npad()
  ]).subarray(0, 320);
  const state = toMoonlight(decode(npad({buttons: 1 << 0, lx: 5}), sources));
  assert.equal(state.buttonFlags, 0x2000 | 0x1000);
  assert.equal(state.leftStickX, 5);
  const detached = toMoonlight(decode(npad({connected: false}), sources));
  assert.equal(detached.connected, true);
  assert.equal(detached.buttonFlags, 0x1000);
});

test('same detects changes field by field', () => {
  const a = map({buttons: 1});
  assert.ok(same(a, map({buttons: 1})));
  assert.ok(!same(a, map({buttons: 2})));
  assert.ok(!same(null, a));
});

test('readController reads the selected state and optional sources', async () => {
  const reads = [];
  const rpc = {
    async read(address, length) {
      reads.push([address, length]);
      return length === 40 ? npad({buttons: 1}).subarray(0, 40) : Buffer.alloc(length);
    }
  };
  assert.equal(toMoonlight(await readController(rpc, 0x1000)).buttonFlags, 0x2000);
  await readController(rpc, 0x1000, {sources: true});
  assert.deepEqual(reads, [
    [0x1000, 40],
    [0x1000, 40],
    [0x1000 + 0x7f0000 + 640, 320]
  ]);
});
