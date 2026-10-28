// Console input: the controller and touch decoders.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decode,
  toMoonlight,
  same,
  readController,
  NEUTRAL,
  NPAD
} = require('../../../host/input/controller.js');
const {
  TOUCH_BYTES,
  parseTouch,
  createTracker,
  step,
  flush,
  touchLine
} = require('../../../host/input/touch.js');
const {frame, keysWatch} = require('../../../host/input/input-feeder.js');
const padAge = require('../../../host/input/pad-age.js');

// controller.js
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

// touch.js

// Build the raw nn::hid TouchScreenState<16> region (what parseTouch receives).
function touchBytes(points, count) {
  const bytes = Buffer.alloc(TOUCH_BYTES);
  bytes.writeUInt32LE(count === undefined ? points.length : count, 2 * 4);
  points.forEach((point, i) => {
    if (i >= 16) return;
    const word = 4 + i * 10;
    if (point.ended) bytes.writeUInt32LE(0x2, (word + 2) * 4);
    bytes.writeUInt32LE(point.id, (word + 3) * 4);
    bytes.writeInt32LE(point.x, (word + 4) * 4);
    bytes.writeInt32LE(point.y, (word + 5) * 4);
  });
  return bytes;
}

const run = (tracker, points) => step(tracker, points).events;

test('normalizes panel coordinates onto the 1280x720 range', () => {
  const points = parseTouch(touchBytes([{id: 1, x: 640, y: 360}]));
  assert.deepEqual(points, [{id: 1, x: 0.5, y: 0.5, ended: false}]);
  const corner = parseTouch(touchBytes([{id: 1, x: 1280, y: 720}]));
  assert.deepEqual(corner[0], {id: 1, x: 1, y: 1, ended: false});
});

test('clamps out-of-range coordinates to [0,1]', () => {
  const points = parseTouch(touchBytes([{id: 1, x: 1920, y: -10}]));
  assert.deepEqual(points[0], {id: 1, x: 1, y: 0, ended: false});
});

test('clamps the reported count to 16 points', () => {
  const many = Array.from({length: 20}, (_, i) => ({id: i, x: i, y: i}));
  const points = parseTouch(touchBytes(many, 20));
  assert.equal(points.length, 16);
});

test('empty state parses to no points and emits no events', () => {
  const tracker = createTracker();
  assert.deepEqual(parseTouch(touchBytes([])), []);
  assert.deepEqual(run(tracker, []), []);
});

test('appear, persist and disappear map to down, move and up', () => {
  const tracker = createTracker();
  assert.deepEqual(run(tracker, parseTouch(touchBytes([{id: 7, x: 128, y: 72}]))), [
    {id: 7, action: 'down', x: 0.1, y: 0.1, pressure: 0}
  ]);
  assert.deepEqual(run(tracker, parseTouch(touchBytes([{id: 7, x: 256, y: 144}]))), [
    {id: 7, action: 'move', x: 0.2, y: 0.2, pressure: 0}
  ]);
  assert.deepEqual(run(tracker, parseTouch(touchBytes([{id: 7, x: 256, y: 144}]))), []);
  assert.deepEqual(run(tracker, parseTouch(touchBytes([]))), [
    {id: 7, action: 'up', x: 0.2, y: 0.2, pressure: 0}
  ]);
});

test('the End attribute bit releases a touch promptly', () => {
  const tracker = createTracker();
  run(tracker, parseTouch(touchBytes([{id: 3, x: 640, y: 360}])));
  const events = run(tracker, parseTouch(touchBytes([{id: 3, x: 640, y: 360, ended: true}])));
  assert.deepEqual(events, [{id: 3, action: 'up', x: 0.5, y: 0.5, pressure: 0}]);
  assert.equal(tracker.active.size, 0);
});

test('a reused pointer id starts a fresh down after it lifts', () => {
  const tracker = createTracker();
  run(tracker, parseTouch(touchBytes([{id: 5, x: 640, y: 360}])));
  run(tracker, parseTouch(touchBytes([])));
  assert.deepEqual(run(tracker, parseTouch(touchBytes([{id: 5, x: 0, y: 0}]))), [
    {id: 5, action: 'down', x: 0, y: 0, pressure: 0}
  ]);
});

test('independent fingers track their own transitions', () => {
  const tracker = createTracker();
  run(tracker, parseTouch(touchBytes([{id: 1, x: 0, y: 0}])));
  const events = run(
    tracker,
    parseTouch(
      touchBytes([
        {id: 1, x: 0, y: 0},
        {id: 2, x: 640, y: 360}
      ])
    )
  );
  assert.deepEqual(events, [{id: 2, action: 'down', x: 0.5, y: 0.5, pressure: 0}]);
});

test('flush releases every active touch', () => {
  const tracker = createTracker();
  run(
    tracker,
    parseTouch(
      touchBytes([
        {id: 1, x: 0, y: 0},
        {id: 2, x: 1280, y: 720}
      ])
    )
  );
  const ups = flush(tracker);
  assert.equal(ups.length, 2);
  assert.ok(ups.every(event => event.action === 'up'));
  assert.equal(tracker.active.size, 0);
});

test('touchLine emits a compact tagged line', () => {
  const line = touchLine([{id: 1, action: 'down', x: 0.5, y: 0.5, pressure: 0}]);
  assert.equal(
    line,
    '{"type":"touch","events":[{"id":1,"action":"down","x":0.5,"y":0.5,"pressure":0}]}'
  );
  assert.ok(!line.includes(' '));
});

// Feeder: one 784-byte read carries both the pad (0..40) and touch (128..784).
function stateBytes({buttons = 0, connected = true, touch = []} = {}) {
  const bytes = Buffer.alloc(128 + TOUCH_BYTES);
  bytes.writeUInt32LE(buttons, 8);
  bytes.writeUInt32LE(connected ? 1 : 0, 32);
  touchBytes(touch).copy(bytes, 128);
  return bytes;
}

test('frame tags controller and touch lines and remembers the pad', () => {
  const tracker = createTracker();
  const first = frame(
    null,
    stateBytes({buttons: 0b0010, touch: [{id: 1, x: 640, y: 360}]}),
    tracker
  );
  assert.equal(first.lines.length, 2);
  const controller = JSON.parse(first.lines[0]);
  assert.equal(controller.type, 'controller');
  assert.equal(controller.buttonFlags, 0x1000);
  assert.deepEqual(JSON.parse(first.lines[1]), {
    type: 'touch',
    events: [{id: 1, action: 'down', x: 0.5, y: 0.5, pressure: 0}]
  });
  const second = frame(
    first.controller,
    stateBytes({buttons: 0b0010, touch: [{id: 1, x: 640, y: 360}]}),
    tracker
  );
  assert.deepEqual(second.lines, []);
});

/** A state block whose app frame counter reads `frames`. */
const block = frames => {
  const bytes = Buffer.alloc(784);
  bytes.writeUInt32LE(frames >>> 0, 88);
  return bytes;
};

test('pad age counts stalls and gaps and ages each read against the freshest', () => {
  const pad = padAge.create({periodMs: 10});
  pad.sample(block(100), 0, 2);
  pad.sample(block(101), 10, 13);
  pad.sample(block(101), 20, 22);
  pad.sample(block(104), 30, 36);
  assert.deepEqual(pad.take(), {
    reads: 4,
    readMeanMs: 3.3,
    readMaxMs: 6,
    stepMax: 3,
    stalls: 1,
    gaps: 1,
    ageMeanMs: 7.3,
    ageMaxMs: 16
  });
  assert.deepEqual(pad.take(), {reads: 0}, 'a take starts the next window');
  pad.sample(block(105), 0, 1);
  pad.sample(block(106), 10, 11);
  assert.equal(pad.take().stepMax, 1);
});

test('the frame step survives the counter wrapping', () => {
  const pad = padAge.create();
  pad.sample(block(0xffffffff), 0, 1);
  pad.sample(block(0), 17, 18);
  assert.deepEqual([pad.take().stepMax, pad.take().reads], [1, 0]);
});

test('pad rows from one stats row merge with means weighted by reads', () => {
  const a = {
    reads: 3,
    readMeanMs: 2,
    readMaxMs: 5,
    stepMax: 1,
    stalls: 1,
    gaps: 0,
    ageMeanMs: 1,
    ageMaxMs: 4
  };
  const b = {
    reads: 1,
    readMeanMs: 6,
    readMaxMs: 6,
    stepMax: 3,
    stalls: 0,
    gaps: 1,
    ageMeanMs: 9,
    ageMaxMs: 9
  };
  assert.deepEqual(padAge.merge([a, {reads: 0}, b]), {
    reads: 4,
    readMeanMs: 3,
    readMaxMs: 6,
    stepMax: 3,
    stalls: 1,
    gaps: 1,
    ageMeanMs: 3,
    ageMaxMs: 9
  });
  assert.deepEqual(padAge.merge([{reads: 0}]), {reads: 0});
});

test('the keys watch notes each change of the pad + and -, and nothing else', () => {
  const note = keysWatch();
  const keys = buttons => note(stateBytes({buttons}));
  assert.equal(keys(0), null);
  assert.equal(keys(NPAD.plus), 'Input keys: + down, - up');
  assert.equal(keys(NPAD.plus | NPAD.a), null);
  assert.equal(keys(NPAD.plus | NPAD.minus), 'Input keys: + down, - down');
  assert.equal(keys(0), 'Input keys: + up, - up');
  assert.equal(keys(NPAD.stickL | NPAD.stickR), null, 'a Start chord is not a + press');
  assert.equal(keys(NPAD.minus), 'Input keys: + up, - down');
});
