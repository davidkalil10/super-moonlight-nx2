const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hbv2 = require('./hbv2.cjs');
const {NPAD} = require('./controller.cjs');
const menu = require('./menu.cjs');

// --- host list load/save/seed -----------------------------------------

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hbmenu-')), 'hosts.json');
}

test('loadHosts returns [] for a missing or corrupt file', () => {
  assert.deepEqual(menu.loadHosts('/no/such/file.json'), []);
  const file = tempFile();
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(menu.loadHosts(file), []);
  fs.writeFileSync(file, '{"not":"an array"}');
  assert.deepEqual(menu.loadHosts(file), []);
});

test('saveHosts then loadHosts round-trips and names default from address', () => {
  const file = tempFile();
  menu.saveHosts(file, [{name: 'Rig', address: '192.168.8.245'}, {address: '10.0.0.5'}]);
  assert.deepEqual(menu.loadHosts(file), [
    {name: 'Rig', address: '192.168.8.245'},
    {name: '10.0.0.5', address: '10.0.0.5'}
  ]);
});

test('seedHosts dedupes, keeps order and always includes the default host', () => {
  const seeded = menu.seedHosts(
    [{name: 'Rig', address: '192.168.8.245'}],
    ['10.0.0.5', '10.0.0.5']
  );
  assert.deepEqual(seeded, [
    {name: 'Rig', address: '192.168.8.245'},
    {name: '10.0.0.5', address: '10.0.0.5'}
  ]);
  const fresh = menu.seedHosts([]);
  assert.deepEqual(fresh, [menu.DEFAULT_HOST]);
  assert.equal(fresh.find(h => h.address === menu.DEFAULT_HOST.address).name, 'Sunshine');
});

// --- list JSON parsing -------------------------------------------------

test('parseList reads currentGame and apps from the helper line', () => {
  const stdout =
    '{"event":"connected"}\n{"currentGame":12,"apps":[{"id":1,"name":"Desktop"},{"id":881448767,"name":"Steam Big Picture"}]}\n';
  assert.deepEqual(menu.parseList(stdout), {
    currentGame: 12,
    apps: [
      {id: 1, name: 'Desktop'},
      {id: 881448767, name: 'Steam Big Picture'}
    ]
  });
});

test('parseList defaults currentGame to 0 and throws without an app list', () => {
  assert.deepEqual(menu.parseList('{"currentGame":0,"apps":[]}'), {currentGame: 0, apps: []});
  assert.throws(() => menu.parseList('{"event":"error"}'));
});

// --- navigation: up/down/wrap, A selects, B backs ----------------------

const hosts = [
  {name: 'Sunshine', address: '192.168.8.245'},
  {name: 'Den', address: '10.0.0.5'}
];

function hostsModel() {
  return menu.toHosts(menu.makeModel(hosts));
}

test('rows lists hosts plus Exit, and games plus Back', () => {
  const labels = menu.rows(hostsModel()).map(r => r.kind);
  assert.deepEqual(labels, ['host', 'host', 'exit']);
  const games = menu.toGames(hostsModel(), {apps: [{id: 1, name: 'Desktop'}], currentGame: 0});
  assert.deepEqual(
    menu.rows(games).map(r => r.kind),
    ['game', 'back']
  );
});

test('navigate moves the cursor and wraps both ends', () => {
  let model = hostsModel(); // 3 rows
  assert.equal(model.cursor, 0);
  model = menu.navigate(model, 1);
  assert.equal(model.cursor, 1);
  model = menu.navigate(model, -1);
  model = menu.navigate(model, -1);
  assert.equal(model.cursor, 2, 'wraps past the top to the last row');
  model = menu.navigate(model, 1);
  assert.equal(model.cursor, 0, 'wraps past the bottom to the first row');
});

test('A on a host opens it; A on Exit requests exit', () => {
  const onHost = menu.activate(hostsModel());
  assert.equal(onHost.intent.type, 'openHost');
  assert.equal(onHost.intent.host.address, '192.168.8.245');
  let model = menu.navigate(hostsModel(), -1); // Exit row
  const onExit = menu.activate(model);
  assert.equal(onExit.intent.type, 'exit');
  assert.equal(onExit.model.exit, true);
});

test('A on a game launches and switches to streaming; Back/B return to hosts', () => {
  let model = menu.toGames(hostsModel(), {apps: [{id: 7, name: 'Kameo'}], currentGame: 0});
  model.host = hosts[0];
  const launch = menu.activate(model);
  assert.equal(launch.intent.type, 'launch');
  assert.equal(launch.intent.game.name, 'Kameo');
  assert.equal(launch.model.screen, 'streaming');
  const backedByRow = menu.activate(menu.navigate(model, -1)); // Back row
  assert.equal(backedByRow.model.screen, 'hosts');
  assert.equal(menu.back(model).model.screen, 'hosts');
});

// --- RETURN chord detector --------------------------------------------

test('createChord fires once after L+R held N ticks, then only after release', () => {
  const chord = menu.createChord(3);
  const both = NPAD.l | NPAD.r;
  assert.equal(chord.tick(NPAD.l), false, 'one shoulder is not the chord');
  assert.equal(chord.tick(both), false);
  assert.equal(chord.tick(both), false);
  assert.equal(chord.tick(both), true, 'fires on the third held tick');
  assert.equal(chord.tick(both), false, 'does not refire while still held');
  assert.equal(chord.tick(0), false, 'release');
  chord.tick(both);
  chord.tick(both);
  assert.equal(chord.tick(both), true, 'fires again after a fresh hold');
});

test('pressed detects a rising edge only', () => {
  assert.equal(menu.pressed(0, NPAD.a, NPAD.a), true);
  assert.equal(menu.pressed(NPAD.a, NPAD.a, NPAD.a), false);
  assert.equal(menu.pressed(NPAD.a, 0, NPAD.a), false);
});

test('touchTarget maps a down event to the row under it', () => {
  const y = menu.LAYOUT.listTop + menu.LAYOUT.rowHeight * 1.5;
  const events = [{action: 'down', x: 0.5, y: y / menu.LAYOUT.height}];
  assert.equal(menu.touchTarget(events, 3), 1);
  assert.equal(menu.touchTarget([{action: 'move', x: 0.5, y: 0.5}], 3), -1);
  assert.equal(menu.touchTarget([{action: 'down', x: 0.5, y: 0.01}], 3), -1, 'above the list');
});

// --- onInput: edge-detected pad + touch, native A/B ------------------

test('onInput moves on D-pad press, not while held', () => {
  const start = hostsModel(); // cursor 0
  const down = menu.onInput(start, 0, NPAD.down, []);
  assert.equal(down.model.cursor, 1);
  assert.equal(down.intent, null);
  const held = menu.onInput(down.model, NPAD.down, NPAD.down, []);
  assert.equal(held.model, down.model, 'a held direction does not re-trigger');
});

test('onInput activates on physical A and backs on physical B', () => {
  const opened = menu.onInput(hostsModel(), 0, NPAD.a, []);
  assert.equal(opened.intent.type, 'openHost');
  const games = menu.toGames(hostsModel(), {apps: [{id: 1, name: 'Desktop'}], currentGame: 0});
  games.host = hosts[0];
  const backed = menu.onInput(games, 0, NPAD.b, []);
  assert.equal(backed.model.screen, 'hosts');
});

test('onInput with nothing pressed returns the same model reference', () => {
  const start = hostsModel();
  const quiet = menu.onInput(start, 0, 0, []);
  assert.equal(quiet.model, start);
  assert.equal(quiet.intent, null);
});

test('onInput taps a row via touch when no button is pressed', () => {
  const y = menu.LAYOUT.listTop + menu.LAYOUT.rowHeight * 1.5; // the Den row
  const tap = menu.onInput(hostsModel(), 0, 0, [
    {action: 'down', x: 0.5, y: y / menu.LAYOUT.height}
  ]);
  assert.equal(tap.model.cursor, 1);
  assert.equal(tap.intent.type, 'openHost');
  assert.equal(tap.intent.host.address, '10.0.0.5');
});

// --- state machine: splash -> hosts -> [pair] -> games -> streaming ----

test('the full menu flow transitions screen by screen', () => {
  let model = menu.makeModel(hosts);
  assert.equal(model.screen, 'splash');
  ({model} = menu.activate(model));
  assert.equal(model.screen, 'hosts');

  // Open a host that is not paired -> pair screen with a PIN -> games.
  ({model} = menu.activate(model));
  assert.equal(model.host.address, '192.168.8.245');
  model = menu.hostListed(model, {paired: false});
  assert.equal(model.screen, 'pair');
  model = menu.pinReceived(model, {pin: '0423', url: 'https://192.168.8.245:47990/pin'});
  assert.equal(model.pin.pin, '0423');
  model = menu.toGames(model, {apps: [{id: 1, name: 'Desktop'}], currentGame: 0});
  assert.equal(model.screen, 'games');

  // Launch, stream, return.
  const launch = menu.activate(model);
  assert.equal(launch.model.screen, 'streaming');
  model = menu.streamEnded(launch.model);
  assert.equal(model.screen, 'games');

  // A paired host instead skips straight to games.
  const paired = menu.hostListed(menu.toHosts(model), {
    paired: true,
    apps: [{id: 2, name: 'Steam'}],
    currentGame: 2
  });
  assert.equal(paired.screen, 'games');
  assert.equal(paired.currentGame, 2);

  // An unreachable host drops back to hosts with a message.
  const failed = menu.errored(model, 'Cannot reach 10.0.0.5');
  assert.equal(failed.screen, 'hosts');
  assert.equal(failed.message, 'Cannot reach 10.0.0.5');
});

// --- screenSpec reflects the model ------------------------------------

test('screenSpec carries geometry, rows, cursor and the pin', () => {
  const games = menu.toGames(hostsModel(), {apps: [{id: 1, name: 'Desktop'}], currentGame: 0});
  const spec = menu.screenSpec(menu.navigate(games, 0));
  assert.equal(spec.screen, 'games');
  assert.deepEqual(spec.rows, ['Desktop', 'Back to hosts']);
  assert.equal(spec.cursor, 0);
  assert.equal(spec.layout.rowHeight, menu.LAYOUT.rowHeight);
  const pair = menu.screenSpec(
    menu.pinReceived(menu.toPair(hostsModel()), {pin: '9999', url: 'u'})
  );
  assert.equal(pair.pin, '9999');
});

// --- re-stamping a real keyframe slot ---------------------------------

test('restampSlot rewrites the sequence so readHeader still validates', () => {
  const width = 64;
  const height = 48;
  const rgb = Buffer.alloc(width * height * 3, 120);
  const frame = hbv2.toFrame(rgb, width, height);
  const slot = hbv2.encode(frame, {sequence: 5, qp: 8});
  assert.equal(hbv2.readHeader(hbv2.words(slot)).sequence, 5);
  const stamped = menu.restampSlot(slot, 42);
  const header = hbv2.readHeader(hbv2.words(stamped));
  assert.ok(header, 'stamped slot still validates');
  assert.equal(header.sequence, 42);
  assert.equal(header.kind, 2);
  // The original buffer is untouched (restampSlot copies).
  assert.equal(hbv2.readHeader(hbv2.words(slot)).sequence, 5);
});
