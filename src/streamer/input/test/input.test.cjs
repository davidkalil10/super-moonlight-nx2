// Console input: the controller and touch decoders and the console push worker.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decode,
  toMoonlight,
  same,
  readController,
  parseStartChord,
  NEUTRAL,
  NPAD
} = require('../controller.js');
const {TOUCH_BYTES, parseTouch, createTracker, step, flush, touchLine} = require('../touch.js');
const {frame, keysWatch, createProbe, probeFromEnv} = require('../input-feeder.js');
const padAge = require('../pad-age.js');

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

test('L3+R3 held together is PC Start in place of both clicks; the chord is configurable', () => {
  const l3 = 1 << 4;
  const r3 = 1 << 5;
  const a = 1 << 0;
  assert.equal(map({buttons: l3 | r3}).buttonFlags, 0x0010);
  assert.equal(map({buttons: l3 | r3 | a}).buttonFlags, 0x0010 | 0x2000);
  assert.equal(map({buttons: l3}).buttonFlags, 0x0040);
  assert.equal(map({buttons: r3}).buttonFlags, 0x0080);
  const none = parseStartChord('none');
  assert.equal(toMoonlight(decode(npad({buttons: l3 | r3})), 'position', none).buttonFlags, 0x00c0);
  const minusA = parseStartChord('minus+a');
  const chord = toMoonlight(decode(npad({buttons: (1 << 11) | a | r3})), 'labels', minusA);
  assert.equal(chord.buttonFlags, 0x0010 | 0x0080);
  for (const bad of ['stickL', 'stickL+zl', 'stickL+stickL', ''])
    assert.throws(() => parseStartChord(bad), /Invalid start chord/);
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

test('the loopback probe presses D-pad Up once a period and holds it briefly', () => {
  const probe = createProbe(1000, () => 0);
  const flags = change => change && JSON.parse(change.line).buttonFlags;
  assert.equal(probe.due(0), null);
  assert.equal(probe.due(999), null);

  const press = probe.due(1000);
  assert.deepEqual([press.edge, press.pressed, flags(press)], [1, true, 0x0001]);
  assert.equal(press.controller.connected, true);
  assert.equal(probe.due(1099), null);

  const release = probe.due(1100);
  assert.deepEqual([release.edge, release.pressed, flags(release)], [1, false, 0]);
  assert.equal(probe.due(1999), null);
  assert.deepEqual([probe.due(2000).edge, probe.due(2100).pressed], [2, false]);

  assert.throws(() => createProbe(150), /at least 200/);
  assert.throws(() => createProbe(Number('1s')), /a number of ms/);
});

test('without HBL_PROBE_PRESS_MS the feeder takes no probe and reads the pad', () => {
  assert.equal(probeFromEnv({}), null);
  assert.equal(probeFromEnv({HBL_PROBE_PRESS_MS: ''}), null);
  assert.equal(probeFromEnv({HBL_PROBE_PRESS_MS: '1000'}).periodMs, 1000);
  assert.throws(() => probeFromEnv({HBL_PROBE_PRESS_MS: 'x'}), /a number of ms/);
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

// input-push-plan.js: the real repeating frame on the gadget-level fake console. Every advance
// is one period: the sleep parks once, returns on the next advance, and the pass after it
// parks in the sleep again.
const {ADDRESS} = require('../../../../../hbl-platform/tests/recording-rpc.cjs');
const {gateConsole, BLOCK} = require('../../../../../hbl-platform/tests/gate-worker-mock.cjs');
const {prepareRepeating} = require('../../../../../hbl-platform/sdk/native/jobs.js');
const {CODE, spawn} = require('../../../../../hbl-platform/sdk/native/thread.js');
const socketFunctions = require('../../../../../hbl-platform/sdk/native/socket-functions.json');
const hidFunctions = require('../../../../../hbl-platform/sdk/native/hid-functions.json');
const pushPlan = require('../input-push-plan.js');

const PUSH_FD = 9;
const SEND = ADDRESS.sdk + socketFunctions.send.offset;
const STATE_AT = ADDRESS.mapped;
const UI_AT = ADDRESS.mapped + 0x10c000;
const PUSH_BASE = ADDRESS.heap + 0x1000000;
const PUSH_COUNTER = ADDRESS.heap + 0x2000000;
const PUSH_BUFFER = PUSH_COUNTER + 0x100;
const PUSH_PAD_ID = PUSH_COUNTER + 0x10;
const PAD_HANDHELD = ADDRESS.sdk + hidFunctions.padHandheld.offset;

/** The 40-byte NpadState the fake handheld read writes on its nth call: sampling n, then 0x33. */
function padSample(n) {
  const bytes = Buffer.alloc(40, 0x33);
  bytes.writeBigUInt64LE(BigInt(n), 0);
  return bytes;
}

/**
 * A gate console whose send logs each block and hands it to deliver; short(count) may replace
 * a send's result, and hang keeps the worker asleep for good. The handheld pad read logs the
 * npad id it was given and writes padSample.
 */
function pushConsole({short = () => null, deliver = () => {}, hang = false} = {}) {
  const sends = [];
  const padIds = [];
  let asleep = false;
  const fake = gateConsole({
    natives: {
      'hid.padHandheld'([out, id], memory) {
        padIds.push(memory.read(id, 4).readUInt32LE());
        memory.write(out, padSample(padIds.length));
        return 0;
      },
      'socket.send'([fd, address, length], memory) {
        const bytes = memory.read(address, length);
        sends.push({fd, address, length, bytes});
        deliver(bytes);
        return short(sends.length) ?? length;
      },
      'thread.sleep'() {
        asleep = hang || !asleep;
        return asleep ? BLOCK : 0;
      }
    }
  });
  fake.rpc.names.set(SEND, 'socket.send');
  fake.rpc.names.set(PAD_HANDHELD, 'hid.padHandheld');
  return {...fake, sends, padIds};
}

/** Writes and spawns the push frame the way the worker does; `pad` adds the handheld read. */
async function startPush(fake, ui = UI_AT, pad = false) {
  const plan = pushPlan.cycle({
    sdk: ADDRESS.sdk,
    base: PUSH_BASE,
    fd: PUSH_FD,
    send: SEND,
    state: STATE_AT,
    ui,
    buffer: ui === null && !pad ? null : PUSH_BUFFER,
    counter: PUSH_COUNTER,
    hz: 120,
    ...(pad && {padId: PUSH_PAD_ID})
  });
  const program = await prepareRepeating(fake.rpc, {
    base: PUSH_BASE,
    code: CODE,
    calls: plan.calls,
    verified: plan.verified
  });
  const thread = await spawn(fake.rpc, PUSH_BASE, program.live, {failed: 'Push spawn failed'});
  const results = async () => {
    const bytes = await fake.rpc.read(program.results, plan.calls.length * 8);
    return plan.calls.map((_, index) => bytes.readBigUInt64LE(index * 8));
  };
  return {plan, program, thread, results};
}

const PASS = ['socket.send', 'add'];

test('each push period sends the state and UI blocks as one record', async () => {
  const fake = pushConsole();
  fake.memory.write(STATE_AT, Buffer.alloc(pushPlan.STATE_BYTES, 0x11));
  fake.memory.write(UI_AT, Buffer.alloc(pushPlan.UI_BYTES, 0x22));
  const {plan, results} = await startPush(fake);
  assert.equal(plan.recordBytes, 784 + 28);
  for (let period = 1; period < 5; period++) fake.advanceAll();
  assert.equal(fake.sends.length, 5);
  for (const send of fake.sends) {
    assert.deepEqual([send.fd, send.address, send.length], [PUSH_FD, PUSH_BUFFER, 812]);
    assert.ok(send.bytes.subarray(0, 784).every(byte => byte === 0x11));
    assert.ok(send.bytes.subarray(784).every(byte => byte === 0x22));
  }
  const next = ['thread.sleep', 'restart', ...PASS];
  assert.deepEqual(fake.trace, [...PASS, ...next, ...next, ...next, ...next]);
  assert.equal(fake.memory.read(PUSH_COUNTER, 4).readUInt32LE(), 5);
  const last = await results();
  assert.doesNotThrow(() => pushPlan.checkedPush(last, plan.row));
  assert.equal(plan.calls[plan.row.sleep].args[0], 8333333);
});

test('a stop during the push sleep ends the worker at the loop tail without a send', async () => {
  const fake = pushConsole();
  const {program, thread} = await startPush(fake);
  fake.advanceAll();
  assert.equal(fake.sends.length, 2);
  await program.stop();
  fake.advanceAll();
  assert.equal(fake.sends.length, 2);
  assert.deepEqual(fake.trace.slice(-2), ['thread.sleep', 'exit']);
  assert.equal(fake.workers.get(thread).exited, true);
  assert.equal(fake.memory.read(PUSH_COUNTER, 4).readUInt32LE(), 2);
});

test('a short or failed push send fails the check, and the exit then ends the worker', async () => {
  const fake = pushConsole({short: count => (count === 2 ? 100 : null)});
  const {plan, program, thread, results} = await startPush(fake);
  fake.advanceAll();
  const last = await results();
  assert.equal(last[plan.row.send], 100n);
  assert.throws(() => pushPlan.checkedPush(last, plan.row), /short or failed/);
  last[plan.row.send] = 0xffffffffffffffffn;
  assert.throws(() => pushPlan.checkedPush(last, plan.row), /short or failed/);
  last[plan.row.send] = 812n;
  assert.doesNotThrow(() => pushPlan.checkedPush(last, plan.row));
  await program.stop();
  fake.advanceAll();
  assert.equal(fake.sends.length, 2);
  assert.equal(fake.workers.get(thread).exited, true);
});

test('the input push plan refuses a bad rate or block and drops the UI send without one', () => {
  const options = {
    sdk: ADDRESS.sdk,
    base: PUSH_BASE,
    fd: PUSH_FD,
    send: SEND,
    state: STATE_AT,
    ui: null,
    buffer: null,
    counter: PUSH_COUNTER,
    hz: 120
  };
  const bads = [{hz: 1000}, {hz: 60.5}, {state: 0}, {counter: PUSH_COUNTER + 2}, {fd: -1}];
  for (const bad of [...bads, {ui: UI_AT}])
    assert.throws(() => pushPlan.cycle({...options, ...bad}), /Input push needs/);
  const plan = pushPlan.cycle(options);
  assert.deepEqual(plan.row.copies, []);
  assert.deepEqual(plan.calls[plan.row.send].args, [PUSH_FD, STATE_AT, 784, 0]);
  assert.equal(plan.calls.length, 3);
  assert.equal(plan.recordBytes, 784);
  assert.doesNotThrow(() => pushPlan.checkedPush([784n, 0n, 0n], plan.row));
  assert.throws(() => pushPlan.checkedPush([784n, 0n], plan.row), /Invalid input push results/);
});

// sha256 of the flag-off frames and exit contexts for these inputs, computed on be4d481.
const PUSH_PLAN_SHA256 = 'cc9be187264c60ecfff1a853208f67ad4f6ad568b03b7865831e47697a4c1162';

test('the push plan without the pad read builds the same frames as before the flag', () => {
  const hash = require('node:crypto').createHash('sha256');
  for (const ui of [UI_AT, null]) {
    const {program} = pushPlan.cycle({
      sdk: ADDRESS.sdk,
      base: PUSH_BASE,
      fd: PUSH_FD,
      send: SEND,
      state: STATE_AT,
      ui,
      buffer: ui === null ? null : PUSH_BUFFER,
      counter: PUSH_COUNTER,
      hz: 120
    });
    hash.update(program.frame).update(program.stop);
  }
  assert.equal(hash.digest('hex'), PUSH_PLAN_SHA256);
});

test('the pad read overwrites the copied pad and the record ends with its count', async () => {
  const fake = pushConsole();
  fake.memory.write(STATE_AT, Buffer.alloc(pushPlan.STATE_BYTES, 0x11));
  fake.memory.write(UI_AT, Buffer.alloc(pushPlan.UI_BYTES, 0x22));
  fake.memory.write(PUSH_PAD_ID, Buffer.from([0x20, 0, 0, 0]));
  const {plan, results} = await startPush(fake, UI_AT, true);

  const {copies, pad, sequence, send, count, sleep} = plan.row;
  assert.deepEqual([...copies, pad, sequence, send, count, sleep], [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(plan.calls.length, 7);
  assert.deepEqual(plan.calls[pad], {
    function: PAD_HANDHELD,
    args: [PUSH_BUFFER, PUSH_PAD_ID, 0, 0]
  });
  assert.deepEqual(plan.calls[sequence].args, [PUSH_BUFFER + 812, PUSH_COUNTER, 4, 0]);
  assert.equal(plan.recordBytes, 812 + 4);

  for (let period = 1; period < 4; period++) fake.advanceAll();
  assert.equal(fake.sends.length, 4);
  fake.sends.forEach((sent, index) => {
    assert.deepEqual([sent.fd, sent.address, sent.length], [PUSH_FD, PUSH_BUFFER, 816]);
    assert.ok(sent.bytes.subarray(0, 40).equals(padSample(index + 1)), 'a fresh pad per pass');
    assert.ok(sent.bytes.subarray(40, 784).every(byte => byte === 0x11));
    assert.ok(sent.bytes.subarray(784, 812).every(byte => byte === 0x22));
    assert.equal(sent.bytes.readUInt32LE(812), index, 'the count before this pass');
  });

  assert.deepEqual(fake.padIds, [32, 32, 32, 32]);
  assert.ok(
    fake.memory.read(STATE_AT, 40).every(byte => byte === 0x11),
    'STATE is not written'
  );
  assert.deepEqual(fake.trace.slice(0, 3), ['hid.padHandheld', 'socket.send', 'add']);
  const last = await results();
  assert.doesNotThrow(() => pushPlan.checkedPush(last, plan.row));
});

test('without a UI block the pad read still copies into the buffer and sends 788 bytes', () => {
  const options = {
    sdk: ADDRESS.sdk,
    base: PUSH_BASE,
    fd: PUSH_FD,
    send: SEND,
    state: STATE_AT,
    ui: null,
    buffer: PUSH_BUFFER,
    counter: PUSH_COUNTER,
    hz: 240,
    padId: PUSH_PAD_ID
  };
  const plan = pushPlan.cycle(options);
  assert.deepEqual(plan.calls[plan.row.copies[0]].args, [PUSH_BUFFER, STATE_AT, 784, 0]);
  assert.deepEqual(plan.calls[plan.row.sequence].args, [PUSH_BUFFER + 784, PUSH_COUNTER, 4, 0]);
  assert.deepEqual(plan.calls[plan.row.send].args, [PUSH_FD, PUSH_BUFFER, 788, 0]);
  assert.equal(plan.calls.length, 6);
  assert.equal(plan.calls[plan.row.sleep].args[0], 4166667);

  for (const bad of [{buffer: null}, {padId: PUSH_PAD_ID + 2}, {padId: 0}, {hz: 241}])
    assert.throws(() => pushPlan.cycle({...options, ...bad}), /Input push needs/);
});

// input-push-worker.js: the real worker on the same fake console, behind a host transport
// that hands each console send to onData.
const {create: createPushWorker} = require('../input-push-worker.js');

/** Creates and, unless `before` throws, starts a push worker; `before(fake)` runs first. */
async function pushWorker({before = () => {}, pad = false, ...options} = {}) {
  let listener = null;
  const fake = pushConsole({...options, deliver: bytes => listener?.(bytes)});
  const received = [];
  const log = [];
  const transport = {
    fd: PUSH_FD,
    sendFunction: SEND,
    receive(onData) {
      listener = onData;
    },
    abort() {
      log.push(['abort']);
    },
    async close() {
      log.push(['close', fake.rpc.lines.length]);
    }
  };
  const worker = await createPushWorker({
    rpc: fake.rpc,
    host: '192.0.2.10',
    state: STATE_AT,
    ui: UI_AT,
    pad,
    onData: bytes => received.push(bytes),
    timeoutMs: 1000,
    createTransport: async ({host}) => {
      log.push(['connect', host]);
      return transport;
    }
  });
  before(fake);
  return {fake, worker, received, log};
}

test('the push worker verifies its calls and streams records to onData until stop', async () => {
  const {fake, worker, received, log} = await pushWorker();
  const verified = fake.rpc.lines.filter(line => line.startsWith('verify '));
  for (const name of ['thread.sleep', 'os.atomicAddU32'])
    assert.ok(
      verified.some(line => line.startsWith(`verify ${name} `)),
      name
    );
  assert.equal(worker.recordBytes, 812);
  await worker.start();
  await assert.rejects(worker.start(), /start is not available/);
  fake.advanceAll();
  fake.advanceAll();
  assert.equal(Buffer.concat(received).length, 3 * 812);
  const from = fake.rpc.lines.length;
  assert.deepEqual(await worker.stop(), {pushed: 3});
  assert.equal(fake.sends.length, 3, 'no send after the stop');
  const tail = fake.rpc.lines.slice(from);
  const at = pattern => tail.findIndex(line => pattern.test(line));
  assert.equal(at(/^write /), 0, 'the exit is selected first');
  assert.ok(at(/thread\.tryWait/) < at(/thread\.join/));
  assert.ok(at(/thread\.join/) < at(/^read /));
  assert.deepEqual(log, [
    ['connect', '192.0.2.10'],
    ['close', fake.rpc.lines.length]
  ]);
  assert.equal(worker.running, false);
  assert.deepEqual(await worker.stop(), {pushed: 3});
});

test('a push worker that does not stop is retained with its socket open', async () => {
  const {fake, worker, log} = await pushWorker({hang: true});
  await worker.start();
  await assert.rejects(worker.stop(), /did not stop; restart SmileBASIC/);
  assert.equal(worker.retained, true);
  const calls = fake.rpc.lines.filter(line => !line.startsWith('verify '));
  assert.ok(!calls.some(line => /thread\.join/.test(line)), 'no join of a running worker');
  assert.deepEqual(log, [['connect', '192.0.2.10'], ['abort']], 'only the host end is dropped');
  await assert.rejects(worker.stop(), /retained for safety/);
});

test('a failed push join or spawn retains the socket', async () => {
  const joined = await pushWorker({before: fake => (fake.handlers['thread.join'] = () => 1n)});
  await joined.worker.start();
  await assert.rejects(joined.worker.stop(), /push worker join failed/);
  assert.equal(joined.worker.retained, true);
  assert.deepEqual(joined.log.at(-1), ['abort']);
  const spawned = await pushWorker({before: fake => (fake.handlers['thread.create'] = () => 1n)});
  await assert.rejects(spawned.worker.start(), /push worker creation failed/);
  assert.equal(spawned.worker.retained, true);
  await assert.rejects(spawned.worker.stop(), /retained for safety/);
  assert.deepEqual(spawned.log.slice(1), [['abort']]);
});

test('a short push send closes the socket and rejects with the console count', async () => {
  const {fake, worker, log} = await pushWorker({short: count => (count === 2 ? 100 : null)});
  await worker.start();
  fake.advanceAll();
  await assert.rejects(worker.stop(), error => {
    assert.match(error.message, /short or failed/);
    assert.equal(error.pushed, 2);
    return true;
  });
  assert.equal(worker.retained, false);
  assert.equal(log.at(-1)[0], 'close');
});

test('a push setup that fails after the connection closes it', async () => {
  const fake = pushConsole();
  const closed = [];
  const transport = {
    fd: PUSH_FD,
    sendFunction: SEND,
    receive() {},
    close: async () => closed.push(1)
  };
  await assert.rejects(
    createPushWorker({
      rpc: fake.rpc,
      state: 0,
      onData: () => {},
      createTransport: async () => transport
    }),
    /Input push needs a socket/
  );
  assert.deepEqual(closed, [1]);
  await assert.rejects(createPushWorker({rpc: fake.rpc, state: STATE_AT}), /data callback/);
});

test('a pad-reading push worker verifies the read, gives it the handheld id and counts', async () => {
  const {fake, worker, received} = await pushWorker({pad: true});
  const verified = fake.rpc.lines.filter(line => line.startsWith('verify '));
  assert.ok(verified.some(line => line.startsWith('verify hid.padHandheld ')));
  assert.equal(worker.recordBytes, 816);

  await worker.start();
  fake.advanceAll();
  assert.deepEqual(await worker.stop(), {pushed: 2});
  const records = Buffer.concat(received);
  assert.equal(records.length, 2 * 816);
  assert.deepEqual([records.readUInt32LE(812), records.readUInt32LE(816 + 812)], [0, 1]);
  assert.deepEqual(fake.padIds, [32, 32]);
});

test('a push worker without the pad read does not verify it', async () => {
  const {fake} = await pushWorker();
  assert.ok(!fake.rpc.lines.some(line => line.startsWith('verify hid.padHandheld ')));
});

// input-feeder.js --push: the record reader's rules, then end to end through the real native
// TCP listener with a TCP client playing the console.
const net = require('node:net');
const {UI_MAGIC} = require('../../shared/ring.js');
const {create: createTcp} = require('../../stream/native/native-tcp.js');
const {createPushReader, runPush} = require('../input-feeder.js');

const BUTTON_A = 0b0001;

/**
 * One pushed record: the state block with its app frame count, then the UI words. frameIndex
 * (word 52) stays 0 unless given, as under time service version 1.
 */
function pushRecord(frames, {buttons = 0, touch = [], overlay = false, frameIndex = 0} = {}) {
  const state = stateBytes({buttons, touch});
  state.writeUInt32LE(frames, 88);
  state.writeUInt32LE(frameIndex, 52);
  const ui = Buffer.alloc(pushPlan.UI_BYTES);
  ui.writeUInt32LE(UI_MAGIC, 0);
  ui.writeUInt32LE(overlay ? 1 : 0, 24);
  return Buffer.concat([state, ui]);
}

const parsed = lines => lines.map(line => JSON.parse(line));
const touchActions = lines =>
  parsed(lines)
    .filter(line => line.type === 'touch')
    .flatMap(line => line.events.map(event => `${event.action} ${event.id}`));

test('the push reader skips repeated frames, follows the overlay and resets on a step back', () => {
  const lines = [];
  const logs = [];
  let clock = 0;
  const reader = createPushReader({
    layout: 'position',
    write: line => lines.push(line),
    log: message => logs.push(message),
    now: () => clock
  });
  reader.attach(812);
  const held = pushRecord(5, {buttons: BUTTON_A, touch: [{id: 1, x: 10, y: 10}]});
  reader.data(Buffer.concat([held, held]).subarray(0, 1000));
  reader.data(Buffer.concat([held, held]).subarray(1000));
  assert.deepEqual(touchActions(lines), ['down 1']);
  assert.equal(parsed(lines).filter(line => line.type === 'controller').length, 1);
  reader.data(pushRecord(6, {buttons: BUTTON_A, touch: [{id: 1, x: 10, y: 10}], overlay: true}));
  assert.deepEqual(touchActions(lines), ['down 1', 'up 1']);
  assert.equal(parsed(lines).at(-1).buttonFlags, 0, 'the overlay releases the pad');
  const before = lines.length;
  reader.data(pushRecord(7, {buttons: BUTTON_A, overlay: true}));
  assert.equal(lines.length, before, 'nothing reaches the PC under the overlay');
  reader.data(pushRecord(2, {buttons: BUTTON_A}));
  assert.match(logs[0], /went back from 7 to 2/);
  assert.equal(parsed(lines).at(-1).buttonFlags, 0x2000);
  clock = 40;
  // Frames 5 and 2 are applied; the repeat and the overlay frames are not.
  assert.deepEqual(reader.take(), {pushed: 5, dropped: 0, gapMaxMs: 40, applied: 2, changes: 3});
  clock = 1999;
  reader.check();
  clock = 2000;
  assert.throws(() => reader.check(), /heard nothing from the console for 2000 ms/);
  reader.check();
});

test('the push reader presses Start from its chord and logs only the pad + and -', () => {
  const lines = [];
  const logs = [];
  const reader = createPushReader({
    layout: 'position',
    write: line => lines.push(line),
    log: message => logs.push(message),
    startChord: ['l', 'r']
  });
  reader.attach(812);
  reader.data(pushRecord(1, {buttons: NPAD.l | NPAD.r}));
  assert.ok(parsed(lines).at(-1).buttonFlags & 0x0010, 'the chord presses Start');
  assert.deepEqual(logs, [], 'a chord is not a + press');
  reader.data(pushRecord(2, {buttons: NPAD.plus}));
  assert.match(logs.at(-1), /^Input keys: \+ down, - up at /);
});

test('the push reader steps on the app frame count, not on frameIndex', () => {
  const lines = [];
  const reader = createPushReader({layout: 'position', write: line => lines.push(line), log() {}});
  const controllers = () => parsed(lines).filter(line => line.type === 'controller');
  reader.attach(812);

  // Version 1: frameIndex stays 0 while the app counts frames.
  reader.data(pushRecord(1, {buttons: BUTTON_A}));
  reader.data(pushRecord(2));
  reader.data(pushRecord(3, {buttons: BUTTON_A}));
  assert.deepEqual(
    controllers().map(line => line.buttonFlags),
    [0x2000, 0, 0x2000]
  );

  const before = lines.length;
  reader.data(pushRecord(3, {frameIndex: 7}));
  assert.equal(lines.length, before, 'a frame already seen stays skipped whatever frameIndex says');
  const {applied, changes} = reader.take();
  assert.deepEqual({applied, changes}, {applied: 3, changes: 3});
});

test('once the UI magic was seen, a shifted idle record no longer passes as detached', () => {
  const lines = [];
  const reader = createPushReader({layout: 'position', write: line => lines.push(line), log() {}});
  reader.attach(812);
  reader.data(pushRecord(1, {buttons: BUTTON_A}));
  // 784 bytes of an idle record shift a zero buttons word onto the next record's uiMagic.
  const cut = pushRecord(2).subarray(0, 784);
  assert.throws(() => reader.data(Buffer.concat([cut, pushRecord(3)])), /lost the record framing/);
  assert.equal(reader.take().pushed, 1);
  assert.equal(lines.length, 1);
});

test('a short send of 40 or 800 bytes after the UI magic fails the reader', () => {
  for (const bytes of [40, 800]) {
    const reader = createPushReader({layout: 'position', write() {}, log() {}});
    reader.attach(812);
    reader.data(Buffer.concat([pushRecord(10), pushRecord(11)]));
    const cut = pushRecord(12).subarray(0, bytes);
    const later = [13, 14, 15].map(frameIndex => pushRecord(frameIndex));
    assert.throws(() => reader.data(Buffer.concat([cut, ...later])), /lost the record framing/);
  }
});

test('a new attach takes a 0 uiMagic again, as for a relaunched app', () => {
  const lines = [];
  const reader = createPushReader({layout: 'position', write: line => lines.push(line), log() {}});
  reader.attach(812);
  reader.data(pushRecord(1));
  reader.attach(812);
  const detached = pushRecord(1, {buttons: BUTTON_A});
  detached.writeUInt32LE(0, 784);
  reader.data(detached);
  assert.equal(reader.take().pushed, 2);
});

test('a short send that shifts the push framing fails the reader before any shifted line', () => {
  const lines = [];
  const reader = createPushReader({layout: 'position', write: line => lines.push(line), log() {}});
  reader.attach(812);
  const detached = pushRecord(1, {buttons: BUTTON_A});
  detached.writeUInt32LE(0, 784);
  reader.data(detached);
  assert.equal(lines.length, 1, 'a record before any service attached is framed');
  // 776 bytes of a record, then whole ones: the word at 784 is the next record's buttons.
  const cut = pushRecord(2, {buttons: 0b0010}).subarray(0, 776);
  assert.throws(
    () => reader.data(Buffer.concat([cut, pushRecord(3, {buttons: BUTTON_A})])),
    /lost the record framing/
  );
  reader.data(Buffer.concat([pushRecord(4, {buttons: 0b0100}), pushRecord(5)]));
  assert.equal(lines.length, 1, 'no controller line from shifted or later bytes');
  assert.equal(reader.take().pushed, 1);
});

/**
 * A push worker double that opens the real native TCP listener: its connect and token jobs
 * start a TCP client playing the console, which the test then writes records on.
 */
function tcpPushWorker({beforeStop = async () => {}} = {}) {
  const consoles = [];
  const created = [];
  const closed = [];
  async function createWorker({state, ui, hz, onData, onClose}) {
    created.push({state, ui, hz});
    let block = null;
    let client = null;
    const rpc = {
      a: {sdk: ADDRESS.sdk},
      output: 0x20000000,
      request: async () => ({verified: true}),
      async call() {
        const output = Buffer.alloc(8);
        output.writeBigUInt64LE(BigInt(ADDRESS.heap));
        return {result: 0n, output};
      },
      async callAddress(address) {
        if (address === ADDRESS.sdk + socketFunctions.socketInitialized.offset) return {result: 1n};
        if (address === ADDRESS.sdk + socketFunctions.socket.offset) return {result: 7n};
        return {result: 0n};
      },
      async write(address, bytes) {
        block = Buffer.from(bytes);
      }
    };
    const transport = await createTcp({
      rpc,
      host: '127.0.0.1',
      createWorker: async () => ({
        async run([call]) {
          if (call.function === ADDRESS.sdk + socketFunctions.connect.offset) {
            client = net.connect(block.readUInt16BE(2), '127.0.0.1');
            client.on('error', () => {});
            return [0n];
          }
          const [, address, length] = call.args;
          client.write(block.subarray(address - ADDRESS.heap, address - ADDRESS.heap + length));
          return [BigInt(length)];
        },
        // As createFinite: true once the worker is freed, so the transport frees its block.
        async close() {
          closed.push(true);
          return true;
        }
      })
    });
    transport.receive(onData, onClose);
    return {
      recordBytes: 812,
      async start() {
        consoles.push(client);
      },
      async stop() {
        await beforeStop(client);
        await transport.close();
        client.destroy();
        return {pushed: 9};
      }
    };
  }
  return {createWorker, consoles, created, closed};
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, timeoutMs = 2000) {
  for (const end = Date.now() + timeoutMs; !condition(); await pause(5))
    if (Date.now() > end) throw Error('Timed out waiting for the push feed');
}

test('push mode feeds records, drops a backlog burst and releases after a silence', async () => {
  const lines = [];
  const logs = [];
  const fake = tcpPushWorker();
  const push = runPush({
    rpc: {},
    directory: 'unused',
    hz: 120,
    layout: 'position',
    write: line => lines.push(line),
    log: message => logs.push(message),
    createWorker: fake.createWorker,
    readSource: () => ({package: {id: 'moonlight'}, mapped: STATE_AT}),
    readAppStorage: () => ({mapped: 0x71000000})
  });
  try {
    await until(() => fake.consoles.length === 1);
    assert.deepEqual(fake.created, [{state: STATE_AT, ui: 0x71000000 + 0xc000, hz: 120}]);
    const client = fake.consoles[0];
    const pressed = ({index, points}) => pushRecord(index, {buttons: BUTTON_A, touch: points});
    client.write(
      Buffer.concat([
        pressed({index: 1, points: [{id: 1, x: 10, y: 10}]}),
        pressed({index: 1, points: [{id: 1, x: 10, y: 10}]}),
        pressed({index: 2, points: [{id: 1, x: 10, y: 10}]})
      ])
    );
    await until(() => lines.length === 2);
    assert.equal(parsed(lines)[0].buttonFlags, 0x2000);
    assert.deepEqual(touchActions(lines), ['down 1']);

    const burst = [3, 4, 5, 6, 7].map(index => pressed({index, points: [{id: 1, x: 10, y: 10}]}));
    burst.push(pressed({index: 8, points: [{id: 2, x: 600, y: 300}]}));
    client.write(Buffer.concat(burst));
    await until(() => touchActions(lines).length === 3);
    assert.deepEqual(touchActions(lines), ['down 1', 'up 1', 'down 2']);
    assert.equal(lines.length, 4, 'the held pad sends no new controller line');

    await until(() => logs.length === 1);
    assert.deepEqual(touchActions(lines), ['down 1', 'up 1', 'down 2', 'up 2']);
    assert.equal(parsed(lines).at(-1).buttonFlags, 0, 'a silence sends the pad back to neutral');
    assert.deepEqual(logs, ['Input push stalled at frame 8']);
    const counts = push.take();
    assert.equal(counts.pushed, 9);
    assert.equal(counts.dropped, 5);
    assert.ok(counts.gapMaxMs >= 250, String(counts.gapMaxMs));
  } finally {
    await push.stop();
  }
  assert.match(logs.at(-1), /console counted 9 records/);
  assert.equal(fake.closed.length, 1, 'stop closes the TCP worker');
});

test('a stopping push worker no longer feeds the PC', async () => {
  const lines = [];
  const fake = tcpPushWorker({
    async beforeStop(client) {
      client.write(pushRecord(1, {buttons: BUTTON_A}));
      await pause(50);
    }
  });
  const push = runPush({
    rpc: {},
    directory: 'unused',
    hz: 120,
    layout: 'position',
    write: line => lines.push(line),
    log() {},
    createWorker: fake.createWorker,
    readSource: () => ({package: {id: 'moonlight'}, mapped: STATE_AT}),
    readAppStorage: () => ({mapped: 0x71000000})
  });
  await until(() => fake.consoles.length === 1);
  await push.stop();
  assert.deepEqual(lines, []);
});

test('push mode fails when the console never sends or closes the socket', async () => {
  for (const ending of ['silent', 'closed']) {
    let clock = 0;
    const failures = [];
    const fake = tcpPushWorker();
    const push = runPush({
      rpc: {},
      directory: 'unused',
      hz: 120,
      layout: 'position',
      write() {},
      log() {},
      onFailure: error => failures.push(error.message),
      createWorker: fake.createWorker,
      readSource: () => ({package: {id: 'moonlight'}, mapped: STATE_AT}),
      readAppStorage: () => ({mapped: 0x71000000}),
      now: () => clock
    });
    try {
      await until(() => fake.consoles.length === 1);
      if (ending === 'silent') {
        clock = 1999;
        await pause(120);
        assert.deepEqual(failures, [], 'no failure inside the bound');
        clock = 2000;
      } else fake.consoles[0].destroy();
      await until(() => failures.length === 1);
      assert.match(failures[0], ending === 'silent' ? /nothing .* for 2000 ms/ : /closed by/);
    } finally {
      await push.stop();
    }
    assert.equal(failures.length, 1, 'the stop is no second failure');
  }
});

// input-feeder.js --push --push-pad: records carry their own pad read and end with the worker's
// record count, which the reader steps on instead of STATE.frames.
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {checkHandheld} = require('../input-feeder.js');

/** A pad-reading record: pushRecord with the pad's sampling word, then the record count. */
function padRecord(sequence, frames, {sampling = 0, ...fields} = {}) {
  const record = pushRecord(frames, fields);
  record.writeBigUInt64LE(BigInt(sampling), 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(sequence);
  return Buffer.concat([record, count]);
}

function padReader(clock = () => 0) {
  const lines = [];
  const logs = [];
  const reader = createPushReader({
    layout: 'position',
    write: line => lines.push(line),
    log: message => logs.push(message),
    pad: true,
    now: clock
  });
  reader.attach(816);
  const flags = () =>
    parsed(lines)
      .filter(line => line.type === 'controller')
      .map(line => line.buttonFlags);
  return {reader, lines, logs, flags};
}

test('with the pad read every new record count applies, even on a repeated STATE.frames', () => {
  const {reader, flags} = padReader();
  reader.data(padRecord(0, 5, {buttons: BUTTON_A}));
  reader.data(padRecord(1, 5));
  reader.data(padRecord(1, 5, {buttons: BUTTON_A}));
  reader.data(padRecord(2, 5, {buttons: BUTTON_A}));

  assert.deepEqual(flags(), [0x2000, 0, 0x2000], 'the repeated count 1 is dropped');
  const {pushed, applied} = reader.take();
  assert.deepEqual({pushed, applied}, {pushed: 4, applied: 3});
});

test('a record count going back is a new worker: logged, released, then applied', () => {
  const {reader, logs, flags} = padReader();
  reader.data(padRecord(7, 1, {buttons: BUTTON_A}));
  reader.data(padRecord(3, 1, {buttons: BUTTON_A}));

  assert.match(logs[0], /record count went back from 7 to 3; new worker/);
  assert.deepEqual(flags(), [0x2000, 0, 0x2000]);
  assert.equal(reader.take().applied, 2);
});

test('the pad read keeps the overlay gate and the framing check', () => {
  const {reader, flags} = padReader();
  reader.data(padRecord(0, 1, {buttons: BUTTON_A}));
  reader.data(padRecord(1, 1, {buttons: BUTTON_A, overlay: true}));
  reader.data(padRecord(2, 1, {buttons: BUTTON_A, overlay: true}));
  assert.deepEqual(flags(), [0x2000, 0], 'the overlay releases and holds the pad');
  assert.equal(reader.take().applied, 1);

  const cut = padRecord(3, 1).subarray(0, 40);
  const later = [4, 5, 6].map(sequence => padRecord(sequence, 1));
  assert.throws(() => reader.data(Buffer.concat([cut, ...later])), /lost the record framing/);
});

test('pad read stats: arrival intervals and sampling steps of the applied records', () => {
  let clock = 0;
  const {reader} = padReader(() => clock);
  const at = (time, ...records) => {
    clock = time;
    reader.data(Buffer.concat(records));
  };
  at(0, padRecord(0, 1, {sampling: 100}));
  at(4, padRecord(1, 1, {sampling: 101}));
  at(8, padRecord(1, 1, {sampling: 102}));
  at(12, padRecord(2, 1, {sampling: 103}));
  at(20, padRecord(3, 1, {sampling: 104}), padRecord(4, 2, {sampling: 105}));

  const taken = reader.take();
  assert.deepEqual(taken.arrivals, [4, 8, 8, 0]);
  assert.deepEqual(taken.samplingStep, {1: 3, 2: 1});
  assert.deepEqual(reader.take().arrivals, [], 'a take empties the window');

  const row = padAge.mergePushPad([taken, {arrivals: [2], samplingStep: {1: 1}}]);
  assert.deepEqual(row, {arrivalMs: {p50: 4, p95: 8, max: 8}, samplingStep: {1: 4, 2: 1}});
  assert.deepEqual(padAge.mergePushPad([]), {
    arrivalMs: {p50: null, p95: null, max: null},
    samplingStep: {}
  });
});

test('without the pad read a repeated STATE.frames stays dropped and takes carry no pad stats', () => {
  const lines = [];
  const reader = createPushReader({layout: 'position', write: line => lines.push(line), log() {}});
  reader.attach(812);
  reader.data(pushRecord(4, {buttons: BUTTON_A}));
  reader.data(pushRecord(4));
  reader.data(pushRecord(4, {buttons: BUTTON_A}));

  assert.equal(lines.length, 1);
  const taken = reader.take();
  assert.deepEqual({pushed: taken.pushed, applied: taken.applied}, {pushed: 3, applied: 1});
  assert.ok(!('arrivals' in taken) && !('samplingStep' in taken));
});

test('the pad read needs a session recorded as handheld', () => {
  const directory = fsSync.mkdtempSync(path.join(os.tmpdir(), 'hbl-push-pad-'));
  const launch = dock =>
    fsSync.writeFileSync(path.join(directory, 'auto-launch.json'), JSON.stringify({dock}));

  assert.throws(() => checkHandheld(directory), /handheld session; .* no auto-launch.json/);
  launch('docked');
  assert.throws(() => checkHandheld(directory), /handheld session; this run has dock=docked/);
  launch('handheld');
  assert.doesNotThrow(() => checkHandheld(directory));
  fsSync.rmSync(directory, {recursive: true});
});
