const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TOUCH_BYTES,
  parseTouch,
  createTracker,
  step,
  flush,
  touchLine
} = require('../../../hbl-moonlight/tools/moonlight/touch.js');
const {frame} = require('../../../hbl-moonlight/tools/moonlight/input-feeder.js');

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
