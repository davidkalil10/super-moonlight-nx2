// The UI state side: the model, the service, mDNS discovery, saved hosts and settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {ITEM, APPS_PER_PAGE, HOSTS_PER_PAGE, makeModel, reduce} = require('../model.js');
const settings = require('../settings.js');
const {createService} = require('../service.js');
const {
  UI,
  UI_MAGIC,
  UI_OP,
  UI_OFFSET,
  UI_PAGE_BYTES,
  MEMORY_BYTES
} = require('../../shared/ring.js');
const {createPages} = require('../pages.js');
const {SERVICE, TYPE, query, parsePacket, candidates, merge, discover} = require('../discover.js');
const hosts = require('../hosts.js');
const {tempFile, uiPage} = require('../../test-support/test-helpers.cjs');

// model.js
const HOSTS = [
  {name: 'Rig', address: '192.168.8.245'},
  {name: 'Laptop', address: '192.168.8.9'}
];
const APPS = [
  {id: 881448767, name: 'Desktop'},
  {id: 1217, name: 'Steam'}
];
const command = (op, item = 0, value = 0) => ({type: 'command', op, item, value});

function walk(model, events) {
  const intents = [];
  for (const event of events) {
    const step = reduce(model, event);
    model = step.model;
    intents.push(...step.intents);
  }
  return {model, intents};
}

test('attach shows the hosts, A opens one, a list lands on the apps page', () => {
  const {model, intents} = walk(makeModel(HOSTS), [
    {type: 'attached'},
    command('a', ITEM.host + 1),
    {type: 'listed', apps: APPS, currentGame: 1217}
  ]);
  assert.equal(model.screen, 'apps');
  assert.equal(model.host, HOSTS[1]);
  assert.deepEqual(model.apps, APPS);
  assert.equal(model.currentGame, 1217);
  assert.equal(model.message, null);
  assert.deepEqual(
    intents.map(intent => intent.type),
    ['list', 'covers']
  );
  assert.equal(intents[0].host, HOSTS[1]);
});

test('an unpaired host goes through pairing and lists again once paired', () => {
  const {model, intents} = walk(makeModel(HOSTS), [
    {type: 'attached'},
    command('a', ITEM.host),
    {type: 'notPaired'},
    {type: 'pin', pin: '4821', url: 'https://192.168.8.245:47990/pin'},
    {type: 'paired'}
  ]);
  assert.equal(model.screen, 'connecting');
  assert.equal(model.pin, null, 'the PIN leaves the model with the pairing screen');
  assert.deepEqual(
    intents.map(intent => intent.type),
    ['list', 'pair', 'list']
  );
  const shown = walk(makeModel(HOSTS), [
    {type: 'attached'},
    command('a', ITEM.host),
    {type: 'notPaired'},
    {type: 'pin', pin: '4821', url: 'u'}
  ]).model;
  assert.equal(shown.screen, 'pairing');
  assert.equal(shown.pin, '4821');
  const cancelled = reduce(shown, command('b'));
  assert.equal(cancelled.model.screen, 'hosts');
  assert.deepEqual(cancelled.intents, [{type: 'cancelPair'}]);
});

test('errors show a page whose Back returns where the failure happened', () => {
  const connecting = walk(makeModel(HOSTS), [{type: 'attached'}, command('a', ITEM.host)]).model;
  const failed = reduce(connecting, {
    type: 'failed',
    message: 'Cannot reach 192.168.8.245',
    back: 'hosts'
  });
  assert.equal(failed.model.screen, 'error');
  assert.equal(failed.model.message, 'Cannot reach 192.168.8.245');
  const back = reduce(failed.model, command('a', ITEM.back));
  assert.equal(back.model.screen, 'hosts');
  assert.deepEqual(back.intents, []);
  const apps = walk(connecting, [{type: 'listed', apps: APPS, currentGame: 0}]).model;
  const launchFailed = reduce(apps, {type: 'failed', message: 'RTSP failed'});
  assert.equal(launchFailed.model.back, 'apps');
  const relist = reduce(launchFailed.model, command('b'));
  assert.equal(relist.model.screen, 'connecting');
  assert.deepEqual(relist.intents, [{type: 'list', host: HOSTS[0]}]);
});

test('launch carries the settings, the stream screens and the overlay actions follow', () => {
  const custom = {...settings.defaults(), fps: 30};
  const apps = walk(makeModel(HOSTS, custom), [
    {type: 'attached'},
    command('a', ITEM.host),
    {type: 'listed', apps: APPS, currentGame: 0}
  ]).model;
  const launch = reduce(apps, command('a', ITEM.app + 1));
  assert.equal(launch.model.screen, 'launching');
  assert.deepEqual(launch.intents, [
    {type: 'launch', host: HOSTS[0], app: APPS[1], settings: custom}
  ]);
  const staged = reduce(launch.model, {type: 'stage', message: 'Connecting to 192.168.8.245'});
  assert.equal(staged.model.message, 'Connecting to 192.168.8.245');
  const streaming = reduce(staged.model, {type: 'streamStarted'}).model;
  assert.equal(streaming.screen, 'streaming');
  const chord = reduce(streaming, command('chord'));
  assert.equal(chord.model.overlay, true);
  assert.deepEqual(chord.intents, [{type: 'pauseInput'}]);
  const hidden = reduce(chord.model, command('b'));
  assert.equal(hidden.model.overlay, false);
  assert.deepEqual(hidden.intents, [{type: 'resumeInput'}]);
  const returned = reduce(chord.model, command('a', ITEM.returnToApps));
  assert.equal(returned.model.screen, 'connecting');
  assert.deepEqual(returned.intents, [{type: 'stopStream'}]);
  const ended = reduce(returned.model, {type: 'streamEnded'});
  assert.deepEqual(ended.intents, [{type: 'list', host: HOSTS[0]}]);
  const quit = reduce(chord.model, command('a', ITEM.quitHost));
  assert.equal(quit.model.screen, 'quitting');
  assert.deepEqual(
    quit.intents.map(intent => intent.type),
    ['stopStream', 'quitHost']
  );
  assert.deepEqual(
    reduce(quit.model, {type: 'streamEnded'}).intents,
    [],
    'quitting waits for the quit'
  );
  const done = reduce(quit.model, {type: 'quitDone'});
  assert.equal(done.model.screen, 'connecting');
  assert.deepEqual(done.intents, [{type: 'list', host: HOSTS[0]}]);
  const ignored = reduce(streaming, command('a', ITEM.returnToApps));
  assert.equal(ignored.model, streaming, 'overlay items do nothing while the overlay is down');
});

test('a stream that ends by itself returns to a fresh app list', () => {
  const streaming = walk(makeModel(HOSTS), [
    {type: 'attached'},
    command('a', ITEM.host),
    {type: 'listed', apps: APPS, currentGame: 0},
    command('a', ITEM.app),
    {type: 'streamStarted'}
  ]).model;
  const ended = reduce(streaming, {type: 'streamEnded'});
  assert.equal(ended.model.screen, 'connecting');
  assert.equal(ended.model.app, null);
  assert.deepEqual(ended.intents, [{type: 'list', host: HOSTS[0]}]);
});

test('id groups leave room for long lists; leaving a host forgets its app place', () => {
  assert.ok(ITEM.host + 9999 < ITEM.app && ITEM.app + 9999 < ITEM.setting);
  const many = Array.from({length: 150}, (_, i) => ({id: 5000 + i, name: 'App ' + i}));
  const apps = walk(makeModel(HOSTS), [
    {type: 'attached'},
    command('a', ITEM.host),
    {type: 'listed', apps: many, currentGame: 0}
  ]).model;
  const launched = reduce(apps, command('a', ITEM.app + 120)).model;
  assert.equal(launched.app.id, 5120);
  assert.equal(launched.appIndex, 120);
  const left = reduce(
    walk(launched, [{type: 'streamEnded'}, {type: 'listed', apps: many, currentGame: 5120}]).model,
    command('b')
  ).model;
  assert.equal(left.screen, 'hosts');
  assert.equal(left.appIndex, 0);
  assert.equal(left.appPage, 0);
});

test('quit host app asks first, then quits and lists again', () => {
  const apps = walk(makeModel(HOSTS), [
    {type: 'attached'},
    command('a', ITEM.host),
    {type: 'listed', apps: APPS, currentGame: 1217}
  ]).model;
  const ask = reduce(apps, command('y'));
  assert.equal(ask.model.screen, 'quitConfirm');
  assert.equal(reduce(ask.model, command('a', ITEM.cancel)).model.screen, 'apps');
  assert.equal(reduce(ask.model, command('b')).model.screen, 'apps');
  const quit = reduce(ask.model, command('a', ITEM.confirmQuit));
  assert.equal(quit.model.screen, 'quitting');
  assert.deepEqual(quit.intents, [{type: 'quitHost', host: HOSTS[0]}]);
  const listed = reduce(reduce(quit.model, {type: 'quitDone'}).model, {
    type: 'listed',
    apps: APPS,
    currentGame: 0,
    message: 'Quit confirmed'
  });
  assert.equal(listed.model.screen, 'apps');
  assert.equal(listed.model.currentGame, 0);
  assert.equal(listed.model.message, 'Quit confirmed', 'the quit result rides on the list');
  assert.equal(reduce(listed.model, command('b')).model.message, 'Quit confirmed');
  const reopened = reduce(reduce(listed.model, command('b')).model, command('a', ITEM.host));
  assert.equal(reopened.model.message, null, 'opening a host clears it');
});

test('settings open with X from hosts or apps, adjust, reset and go back where they came from', () => {
  const hosts = reduce(makeModel(HOSTS), {type: 'attached'}).model;
  const opened = reduce(hosts, command('x'));
  assert.equal(opened.model.screen, 'settings');
  assert.equal(opened.model.from, 'hosts');
  const fpsRow = settings.CATALOG.findIndex(setting => setting.id === 'fps');
  const lower = reduce(opened.model, command('adjust', ITEM.setting + fpsRow, -1));
  assert.equal(lower.model.settings.fps, 30);
  assert.deepEqual(lower.intents, [{type: 'saveSettings'}]);
  const clamped = reduce(lower.model, command('adjust', ITEM.setting + fpsRow, -1));
  assert.equal(clamped.model, lower.model, 'no change means no save');
  const codecRow = settings.CATALOG.findIndex(setting => setting.id === 'codec');
  assert.equal(
    reduce(lower.model, command('adjust', ITEM.setting + codecRow, 1)).intents.length,
    0
  );
  const reset = reduce(lower.model, command('y'));
  assert.deepEqual(reset.model.settings, settings.defaults());
  assert.deepEqual(reset.intents, [{type: 'saveSettings'}]);
  assert.equal(reduce(reset.model, command('b')).model.screen, 'hosts');
  const apps = walk(hosts, [
    command('a', ITEM.host),
    {type: 'listed', apps: APPS, currentGame: 0}
  ]).model;
  const fromApps = reduce(apps, command('x')).model;
  assert.equal(fromApps.from, 'apps');
  assert.equal(reduce(fromApps, command('b')).model.screen, 'apps');
});

test('the apps grid pages past ten apps and a shorter list pulls the page back', () => {
  const many = Array.from({length: 45}, (_, i) => ({id: i + 1, name: 'App ' + (i + 1)}));
  const apps = walk(makeModel(HOSTS), [
    {type: 'attached'},
    command('a', ITEM.host),
    {type: 'listed', apps: many, currentGame: 0}
  ]).model;
  assert.equal(APPS_PER_PAGE, 10);
  const second = reduce(apps, command('a', ITEM.next)).model;
  assert.equal(second.appPage, 1);
  const last = [2, 3, 4, 5].reduce(model => reduce(model, command('a', ITEM.next)).model, second);
  assert.equal(last.appPage, 4, 'next stops at the last page');
  const third = {...last, appPage: 2};
  const launch = reduce(last, command('a', ITEM.app + 44));
  assert.equal(launch.model.screen, 'launching');
  assert.equal(launch.model.app.id, 45);
  assert.equal(
    reduce(reduce(third, command('a', ITEM.previous)).model, command('a', ITEM.previous)).model
      .appPage,
    0
  );
  assert.equal(reduce(apps, command('a', ITEM.previous)).model.appPage, 0);
  const shorter = reduce(
    {...third, screen: 'connecting'},
    {type: 'listed', apps: APPS, currentGame: 0}
  );
  assert.equal(shorter.model.appPage, 0);
});

test('hosts page by six and the opened host is remembered for the way back', () => {
  const eight = Array.from({length: 8}, (_, i) => ({name: 'PC ' + i, address: '10.0.0.' + i}));
  const hosts = reduce(makeModel(eight), {type: 'attached'}).model;
  assert.equal(HOSTS_PER_PAGE, 6);
  const second = reduce(hosts, command('a', ITEM.next)).model;
  assert.equal(second.hostPage, 1);
  assert.equal(reduce(second, command('a', ITEM.next)).model.hostPage, 1, 'stops at the last');
  const opened = reduce(second, command('a', ITEM.host + 7));
  assert.equal(opened.model.host, eight[7]);
  assert.equal(opened.model.hostIndex, 7);
  const listed = reduce(opened.model, {type: 'listed', apps: APPS, currentGame: 0}).model;
  const back = reduce(listed, command('b')).model;
  assert.equal(back.screen, 'hosts');
  assert.equal(back.hostPage, 1, 'back on the page of the host it left');
  assert.equal(back.hostIndex, 7);
  const fewer = reduce(back, {type: 'hosts', hosts: eight.slice(0, 3)}).model;
  assert.equal(fewer.hostPage, 0, 'a shorter list pulls the page back');
});

test('results for another screen are ignored and the app going away stops the service', () => {
  const hosts = reduce(makeModel(HOSTS), {type: 'attached'}).model;
  assert.equal(reduce(hosts, {type: 'listed', apps: APPS, currentGame: 0}).model, hosts);
  assert.equal(reduce(hosts, {type: 'pin', pin: '1', url: 'u'}).model, hosts);
  assert.equal(reduce(hosts, {type: 'streamStarted'}).model, hosts);
  assert.equal(reduce(hosts, command('a', ITEM.host + 7)).model, hosts, 'no such host');
  const refreshed = reduce(hosts, {type: 'hosts', hosts: [HOSTS[0]]});
  assert.deepEqual(refreshed.model.hosts, [HOSTS[0]]);
  assert.deepEqual(reduce(hosts, command('y')).intents, [{type: 'refreshHosts'}]);
  const gone = reduce(hosts, {type: 'appGone'});
  assert.equal(gone.model.screen, 'stopped');
  assert.deepEqual(gone.intents, [{type: 'exit'}]);
});

test('a different app waits until the running one is quit, since the PC would resume it', () => {
  const apps = walk(makeModel(HOSTS), [
    {type: 'attached'},
    command('a', ITEM.host),
    {type: 'listed', apps: APPS, currentGame: 1217}
  ]).model;
  const blocked = reduce(apps, command('a', ITEM.app));
  assert.equal(blocked.model.screen, 'apps');
  assert.deepEqual(blocked.intents, []);
  assert.equal(blocked.model.message, 'Steam is still running on the PC; press Y to quit it first');
  const resumed = reduce(apps, command('a', ITEM.app + 1));
  assert.equal(resumed.model.screen, 'launching');
  assert.equal(resumed.model.app.id, 1217);
  const unknown = reduce({...apps, currentGame: 42}, command('a', ITEM.app)).model;
  assert.match(unknown.message, /^Another app is still running/);
  const quit = walk(blocked.model, [
    command('y'),
    command('a', ITEM.confirmQuit),
    {type: 'quitDone'}
  ]);
  const relisted = reduce(quit.model, {type: 'listed', apps: APPS, currentGame: 0}).model;
  assert.equal(relisted.message, null, 'the block message clears once the app is quit');
  assert.equal(reduce(relisted, command('a', ITEM.app)).model.screen, 'launching');
});

// The service against a fake console that applies pages the way the shader does, and fake
// children standing in for the helper and live.js.
const MAPPED = 0x4000000;
const list = (currentGame = 0) => JSON.stringify({currentGame, apps: APPS}) + '\n';

async function until(predicate, what = 'condition', ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('timed out waiting for ' + what);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

function fakeRaster() {
  return {
    async text(text, size, width) {
      const height = Math.min(96, Math.round(size * 1.2));
      return {width, height, bytes: Buffer.alloc(width * height, text.length % 251)};
    },
    async legend(keys, size, width) {
      return {width, height: 40, bytes: Buffer.alloc(width * 40, 200)};
    },
    async letters(text, width, height) {
      return {width, height, bytes: Buffer.alloc(width * height * 4, 1)};
    },
    async tile(png, width, height) {
      return {width, height, bytes: Buffer.alloc(width * height * 4, 2)};
    },
    close() {}
  };
}

/** What the rpc throws once the launcher has closed the bridge. */
const refused = () =>
  Object.assign(Error('connect ECONNREFUSED 127.0.0.1:43355'), {code: 'ECONNREFUSED'});

async function fakeConsole() {
  const {validate, parse} = await uiPage();
  const bytes = Buffer.alloc(MEMORY_BYTES);
  const word = offset => bytes.readUInt32LE(offset);
  const setWord = (offset, value) => bytes.writeUInt32LE(value >>> 0, offset);
  const writes = [];
  const console = {
    bytes,
    writes,
    word,
    setWord,
    loseHeader: 0,
    revertAfterReads: 0,
    reverting: null,
    gone: false,
    async read(address, length) {
      if (console.gone) throw refused();
      if (console.reverting && --console.reverting.reads < 0) {
        console.reverting.words.copy(bytes, UI.uiMagic);
        console.reverting = null;
      }
      return Buffer.from(bytes.subarray(address - MAPPED, address - MAPPED + length));
    },
    async write(address, data) {
      if (console.gone) throw refused();
      const offset = address - MAPPED;
      const before = Buffer.from(bytes.subarray(UI.uiMagic, UI.uiMagic + 16));
      data.copy(bytes, offset);
      writes.push(offset);
      if (offset !== UI.uiMagic || word(UI.uiMagic) !== UI_MAGIC || console.frozen) return;
      if (console.loseHeader > 0) {
        console.loseHeader--;
        console.reverting = {words: before, reads: console.revertAfterReads};
        return;
      }
      const sequence = word(UI.uiSequence),
        page = word(UI.uiPage),
        base = UI_OFFSET + page * UI_PAGE_BYTES;
      validate(bytes.subarray(base, base + UI_PAGE_BYTES), {epoch: word(UI.uiEpoch), sequence});
      setWord(UI.uiShown, page);
      setWord(UI.uiApplied, sequence);
    },
    shown() {
      const base = UI_OFFSET + word(UI.uiShown) * UI_PAGE_BYTES;
      return parse(bytes.subarray(base, base + UI_PAGE_BYTES));
    },
    press(op, item = 0, value = 0) {
      const sequence = word(UI.cmdSequence) + 1;
      setWord(UI.cmdItem, item);
      setWord(UI.cmdValue, value < 0 ? 0xffffffff : value);
      setWord(UI.cmdPage, word(UI.uiApplied));
      setWord(UI.cmdEpoch, word(UI.uiEpoch));
      setWord(UI.cmdOp, UI_OP[op]);
      setWord(UI.cmdSequence, sequence);
      return sequence;
    }
  };
  return console;
}

function fakeChildren() {
  const spawned = [];
  function child(kind, args, onLine) {
    let finish;
    const record = {
      kind,
      args,
      kills: [],
      done: false,
      exited: new Promise(resolve => (finish = resolve)),
      finish(result) {
        record.done = true;
        finish({code: 0, signal: null, out: '', err: '', ...result});
      },
      line: (channel, text) => onLine(channel, text),
      cancel(signal) {
        record.kills.push(signal);
        if (signal === 'SIGKILL') record.finish({code: null, signal});
      }
    };
    spawned.push(record);
    return record;
  }
  return {
    spawned,
    last: kind => [...spawned].reverse().find(record => record.kind === kind),
    helper: args => child(args[0], args),
    pair: (address, onLine) => child('pair', ['pair', address], onLine),
    stream: (directory, host, app, args, onLine) =>
      child('stream', [directory, host.address, String(app.id), ...args], onLine)
  };
}

async function setup(options = {}) {
  const console = await fakeConsole();
  const children = fakeChildren();
  const saved = [];
  const events = [];
  const service = createService({
    memory: console,
    mapped: MAPPED,
    pages: createPages(fakeRaster()),
    children,
    directory: '/run/dir',
    readHosts: () => HOSTS,
    discoverHosts: async () => [],
    saveSettings: values => saved.push(values),
    settings: settings.defaults(),
    log: event => events.push(event),
    epoch: 1700000000,
    activeApp: () => 'moonlight',
    timeouts: {apply: 200, helper: 50, stop: 50},
    ...options
  });
  return {console, children, saved, events, service};
}

async function openHost(fixture, currentGame = 0) {
  const {console, children, service} = fixture;
  console.press('a', ITEM.host);
  await service.poll();
  assert.equal(service.model().screen, 'connecting');
  await until(() => children.last('list'), 'list helper');
  assert.equal(console.word(UI.hostBusy), 1, 'busy while the helper runs');
  children.last('list').finish({out: list(currentGame)});
  await until(() => service.model().screen === 'apps', 'apps page');
  assert.equal(console.word(UI.hostBusy), 0);
}

test('attach seeds after the stale sequence, ignores old commands and leaves magic 0', async () => {
  const fixture = await setup();
  const {console, service} = fixture;
  console.setWord(UI.uiApplied, 7);
  console.setWord(UI.cmdSequence, 3);
  console.setWord(UI.cmdOp, UI_OP.a);
  await service.attach();
  assert.equal(service.model().screen, 'hosts');
  assert.equal(console.word(UI.uiMagic), UI_MAGIC);
  assert.equal(console.word(UI.uiEpoch), 1700000000);
  assert.equal(console.word(UI.uiSequence), 8);
  assert.equal(console.word(UI.uiApplied), 8);
  assert.equal(console.word(UI.uiPage), 0);
  assert.equal(console.writes[0], UI.uiMagic, 'magic 0 goes first');
  assert.equal(console.word(UI.hostBusy), 0);
  assert.deepEqual(
    console.shown().items.map(item => item.id),
    [ITEM.host, ITEM.host + 1]
  );
  await service.poll();
  assert.equal(service.model().screen, 'hosts', 'the press before attach is not replayed');
  assert.equal(console.word(UI.hostAck), 3, 'and is acked so the cursor does not pulse');
  await service.stop();
  assert.equal(console.word(UI.uiMagic), 0);
});

test('A on a host lists it and lands on the app grid; stale commands are acked and dropped', async () => {
  const fixture = await setup();
  const {console, children, service} = fixture;
  await service.attach();
  await openHost(fixture, 1217);
  assert.deepEqual(children.spawned[0].args, ['list', '192.168.8.245']);
  const page = console.shown();
  assert.equal(console.word(UI.uiSequence), 3, 'hosts, connecting, apps');
  assert.equal(console.word(UI.uiPage), 1);
  assert.ok(
    page.items.some(item => item.id === ITEM.app + 1 && item.flags & 2),
    'Steam is current'
  );
  const stale = console.press('a', ITEM.app);
  console.setWord(UI.cmdPage, 1);
  await service.poll();
  assert.equal(console.word(UI.hostAck), stale, 'dropped commands are still acked');
  assert.equal(service.model().screen, 'apps');
  const foreign = console.press('a', ITEM.app);
  console.setWord(UI.cmdEpoch, 1699999999);
  await service.poll();
  assert.equal(console.word(UI.hostAck), foreign, 'another epoch is acked');
  assert.equal(service.model().screen, 'apps', 'and dropped');
  assert.equal(children.spawned.length, 1);
});

test('covers from the helper cache land on the grid, letter tiles fill the rest', async () => {
  const fixture = await setup({coversDir: '/covers'});
  const {console, children, service} = fixture;
  await service.attach();
  console.press('a', ITEM.host);
  await service.poll();
  await until(() => children.last('list'), 'list helper');
  assert.deepEqual(children.last('list').args, ['list', '192.168.8.245', '--covers', '/covers']);
  const apps = [{...APPS[0], cover: '/covers/192.168.8.245-881448767.png'}, APPS[1]];
  children.last('list').finish({out: JSON.stringify({currentGame: 0, apps}) + '\n'});
  await until(() => service.model().screen === 'apps', 'apps page');
  await until(() => console.shown().images[0].rgba[0] === 2, 'cover tile on the grid');
  const shown = console.shown();
  assert.equal(shown.images.length, 2);
  assert.equal(shown.images[1].rgba[0], 1, 'the second app keeps its letter tile');
});

test('an unreachable or hung helper ends on the error page', async () => {
  const fixture = await setup();
  const {console, children, service} = fixture;
  await service.attach();
  console.press('a', ITEM.host + 1);
  await service.poll();
  await until(() => children.last('list'), 'list helper');
  children
    .last('list')
    .finish({code: 1, err: '{"event":"error","message":"connection refused"}\n'});
  await until(() => service.model().screen === 'error', 'error page');
  assert.equal(service.model().message, 'connection refused');
  assert.deepEqual(
    console.shown().items.map(item => item.id),
    [ITEM.back]
  );
  console.press('a', ITEM.back);
  await service.poll();
  assert.equal(service.model().screen, 'hosts');
  console.press('a', ITEM.host);
  await service.poll();
  await until(() => children.last('list').kills.includes('SIGKILL'), 'helper timeout');
  await until(() => service.model().screen === 'error', 'timeout error');
  assert.equal(service.model().message, 'The helper timed out');
});

test('an unpaired host pairs with the PIN on screen, B cancels, success relists', async () => {
  const fixture = await setup();
  const {console, children, service} = fixture;
  await service.attach();
  console.press('a', ITEM.host);
  await service.poll();
  await until(() => children.last('list'), 'list helper');
  children.last('list').finish({code: 1, err: 'not paired\n'});
  await until(() => children.last('pair'), 'pair helper');
  assert.equal(service.model().screen, 'pairing');
  const waiting = console.shown().texts.length;
  children
    .last('pair')
    .line('stdout', '{"event":"pin","pin":"4821","url":"https://192.168.8.245:47990/pin"}');
  await until(() => service.model().pin === '4821', 'pin');
  await until(() => console.shown().texts.length > waiting, 'pin page');
  console.press('b');
  await service.poll();
  assert.equal(service.model().screen, 'hosts');
  assert.deepEqual(children.last('pair').kills, ['SIGINT']);
  children.last('pair').finish({code: 1, signal: 'SIGINT'});
  console.press('a', ITEM.host);
  await service.poll();
  await until(
    () => children.spawned.filter(child => child.kind === 'list').length === 2,
    'second list'
  );
  children.last('list').finish({code: 1, err: 'not paired\n'});
  await until(
    () => children.spawned.filter(child => child.kind === 'pair').length === 2,
    'second pair'
  );
  children.last('pair').finish({code: 0});
  await until(() => children.spawned.filter(child => child.kind === 'list').length === 3, 'relist');
  assert.equal(service.model().screen, 'connecting');
  children.last('list').finish({out: list()});
  await until(() => service.model().screen === 'apps', 'apps after pairing');
});

test('launch streams with the chosen settings; the chord is free; return relists', async () => {
  const fixture = await setup();
  const {console, children, service} = fixture;
  await service.attach();
  await openHost(fixture);
  console.press('x');
  await service.poll();
  const bitrate = settings.CATALOG.findIndex(setting => setting.id === 'bitrate');
  console.press('adjust', ITEM.setting + bitrate, 1);
  await service.poll();
  assert.deepEqual(fixture.saved.at(-1).bitrate, 22.5);
  console.press('b');
  await service.poll();
  assert.equal(service.model().screen, 'apps');
  console.press('a', ITEM.app + 1);
  await service.poll();
  assert.equal(service.model().screen, 'launching');
  const stream = children.last('stream');
  assert.deepEqual(stream.args.slice(0, 3), ['/run/dir', '192.168.8.245', '1217']);
  assert.deepEqual(
    stream.args.slice(3),
    settings.streamArgs({...settings.defaults(), bitrate: 22.5})
  );
  stream.line('stderr', 'hbmoonlight {"event":"log","message":"RTSP handshake"}');
  await until(() => service.model().message === 'RTSP handshake', 'stage');
  stream.line('stdout', '{"captured":60}');
  stream.line('stderr', 'hbmoonlight Connecting to 192.168.8.245');
  stream.line('stderr', '{"event":"connected"}');
  await until(() => service.model().screen === 'streaming', 'streaming');
  const sequence = console.word(UI.uiSequence);
  assert.equal(console.shown().flags & 1, 1, 'the overlay page is up while streaming');
  console.press('chord');
  await service.poll();
  assert.equal(service.model().overlay, true);
  assert.equal(
    console.word(UI.uiSequence),
    sequence,
    'the identical overlay page is not republished'
  );
  console.press('b');
  await service.poll();
  assert.equal(service.model().overlay, false);
  console.press('chord');
  await service.poll();
  console.press('a', ITEM.returnToApps);
  await service.poll();
  assert.equal(service.model().screen, 'connecting');
  assert.deepEqual(stream.kills, ['SIGINT']);
  stream.finish({code: null, signal: 'SIGINT'});
  await until(() => children.spawned.filter(child => child.kind === 'list').length === 2, 'relist');
  children.last('list').finish({out: list(1217)});
  await until(() => service.model().screen === 'apps', 'apps again');
  assert.equal(service.model().message, null);
  assert.equal(service.model().currentGame, 1217, 'the host game keeps running');
  assert.ok(fixture.events.some(event => event.event === 'stream-stats'));
  assert.ok(
    fixture.events.some(event => event.event === 'stream-line' && /Connecting/.test(event.line))
  );
  assert.ok(
    fixture.events.some(
      event => event.event === 'stream-event' && event.message === 'RTSP handshake'
    )
  );
});

test('quit stops the stream first, cancels on the host and confirms on the list', async () => {
  const fixture = await setup();
  const {console, children, service} = fixture;
  await service.attach();
  await openHost(fixture, 1217);
  console.press('a', ITEM.app + 1);
  await service.poll();
  const stream = children.last('stream');
  stream.line('stderr', '{"event":"connected"}');
  await until(() => service.model().screen === 'streaming', 'streaming');
  console.press('chord');
  await service.poll();
  console.press('a', ITEM.quitHost);
  await service.poll();
  assert.equal(service.model().screen, 'quitting');
  await until(() => stream.kills.length, 'stream stop');
  assert.deepEqual(stream.kills, ['SIGINT'], 'one stop for two intents');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(children.last('quit'), undefined, 'no /cancel before the stream is down');
  stream.finish({code: null, signal: 'SIGINT'});
  await until(() => children.last('quit'), 'quit helper');
  assert.deepEqual(children.last('quit').args, ['quit', '192.168.8.245']);
  children.last('quit').finish({code: 0});
  await until(
    () => children.spawned.filter(child => child.kind === 'list').length === 2,
    'verify list'
  );
  children.last('list').finish({out: list(0)});
  await until(() => service.model().screen === 'apps', 'apps');
  assert.equal(service.model().message, 'Quit confirmed');
  assert.deepEqual(
    fixture.events
      .filter(event => event.event === 'quit')
      .map(event => [event.cancelled, event.code]),
    [[true, 0]]
  );
  console.press('y');
  await service.poll();
  console.press('a', ITEM.confirmQuit);
  await service.poll();
  await until(
    () => children.spawned.filter(child => child.kind === 'quit').length === 2,
    'second quit'
  );
  children.last('quit').finish({code: 1, err: '{"event":"error","message":"cancel refused"}\n'});
  await until(
    () => children.spawned.filter(child => child.kind === 'list').length === 3,
    'list after failure'
  );
  children.last('list').finish({out: list(1217)});
  await until(() => service.model().screen === 'apps', 'apps after failed quit');
  assert.equal(service.model().message, 'Quit failed: cancel refused');
  assert.equal(service.model().currentGame, 1217);
  console.press('y');
  await service.poll();
  console.press('a', ITEM.confirmQuit);
  await service.poll();
  await until(
    () => children.spawned.filter(child => child.kind === 'quit').length === 3,
    'third quit'
  );
  await until(() => children.last('quit').kills.includes('SIGKILL'), 'quit timeout');
  await until(
    () => children.spawned.filter(child => child.kind === 'list').length === 4,
    'list after timeout'
  );
  children.last('list').finish({out: list(0)});
  await until(() => service.model().screen === 'apps', 'apps after late quit');
  assert.equal(
    service.model().message,
    'Host closed the game on its own; the quit request failed',
    'a cleared host after a failed request is said so, not confirmed'
  );
});

test('a helper timeout logs the step the helper names', async () => {
  const fixture = await setup();
  const {console, children, service} = fixture;
  await service.attach();
  await openHost(fixture, 1217);
  console.press('y');
  await service.poll();
  console.press('a', ITEM.confirmQuit);
  await service.poll();
  await until(() => children.last('quit'), 'quit helper');
  children.last('quit').finish({
    code: 3,
    err: '{"event":"error","message":"timed out","stage":"reconnect"}\n'
  });
  await until(
    () => fixture.events.some(event => event.event === 'helper' && event.args[0] === 'quit'),
    'quit helper event'
  );
  const event = fixture.events.find(event => event.event === 'helper' && event.args[0] === 'quit');
  assert.deepEqual(event.error, {message: 'timed out', stage: 'reconnect'});
  assert.equal(
    fixture.events.find(event => event.event === 'helper' && event.args[0] === 'list').error,
    undefined,
    'a helper that succeeded logs no error'
  );
});

test('a console that stops answering mid-stream ends on the error page', async () => {
  const fixture = await setup();
  const {console, children, service} = fixture;
  await service.attach();
  await openHost(fixture);
  console.press('a', ITEM.app);
  await service.poll();
  const stream = children.last('stream');
  stream.line('stderr', '{"event":"connected"}');
  await until(() => service.model().screen === 'streaming', 'streaming');
  stream.line('stderr', '{"event":"console-stalled","silentMs":5000}');
  await until(() => service.model().screen === 'error', 'error page');
  assert.match(service.model().message, /console stopped answering/);
  stream.finish({code: 1});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.model().screen, 'error', 'the stream exit keeps the reason on screen');
});

test('a stream that dies before connecting is an error; the service leaves with the app', async () => {
  let active = 'moonlight';
  const fixture = await setup({activeApp: () => active});
  const {console, children, service} = fixture;
  const finished = service.start();
  await until(() => service.model().screen === 'hosts', 'attach');
  await openHost(fixture);
  console.press('a', ITEM.app);
  await until(() => children.last('stream'), 'stream child');
  children.last('stream').finish({code: 1});
  await until(() => service.model().screen === 'error', 'error page');
  assert.match(service.model().message, /did not start/);
  active = 'smilebasic';
  await finished;
  assert.equal(service.model().screen, 'stopped');
  assert.equal(console.word(UI.uiMagic), 0);
});

test('a page the console never applies keeps the next page off the shown buffer', async () => {
  const fixture = await setup();
  const {console, service} = fixture;
  await service.attach();
  assert.equal(console.word(UI.uiPage), 1, 'first page in buffer 1 after the stale 0');
  console.frozen = true;
  console.press('x');
  await service.poll();
  assert.equal(service.model().screen, 'settings');
  assert.equal(console.word(UI.uiSequence), 2, 'published into buffer 0, never applied');
  assert.ok(fixture.events.some(event => event.event === 'apply-timeout'));
  console.frozen = false;
  await service.poll();
  assert.equal(console.word(UI.uiSequence), 4, 'republished, skipping the sequence for buffer 1');
  assert.equal(console.word(UI.uiPage), 0);
  assert.equal(console.word(UI.uiApplied), 4);
  console.press('b');
  await service.poll();
  assert.equal(service.model().screen, 'hosts');
  assert.equal(console.word(UI.uiApplied), 5);
  assert.equal(console.word(UI.uiPage), 1);
});

for (const [when, reads] of [
  ['at once', 0],
  ['after the readback', 1]
]) {
  test(`a header the console reverts ${when} is written again, not republished`, async () => {
    const fixture = await setup();
    const {console, service} = fixture;
    await service.attach();
    const pageWrites = () =>
      console.writes.filter(offset => offset === UI_OFFSET || offset === UI_OFFSET + UI_PAGE_BYTES)
        .length;
    const headerWrites = () => console.writes.filter(offset => offset === UI.uiMagic).length;
    const [pagesBefore, headersBefore] = [pageWrites(), headerWrites()];
    console.loseHeader = 1;
    console.revertAfterReads = reads;
    console.press('x');
    await service.poll();
    assert.equal(service.model().screen, 'settings');
    assert.equal(console.word(UI.uiApplied), console.word(UI.uiSequence), 'applied');
    assert.equal(console.word(UI.uiSequence), 2);
    assert.ok(!fixture.events.some(event => event.event === 'apply-timeout'));
    assert.equal(pageWrites() - pagesBefore, 1, 'one page write');
    assert.ok(headerWrites() - headersBefore >= 2, 'the header went out again');
    const rewrite = fixture.events.find(event => event.event === 'header-rewrite');
    assert.equal(rewrite.sequence, 2);
    assert.equal(rewrite.reverted[2], 1, 'the previous sequence came back');
  });
}

test('stopping a running service detaches once', async () => {
  const fixture = await setup();
  const {console, service} = fixture;
  const finished = service.start();
  await until(() => service.model().screen === 'hosts', 'attach');
  await Promise.all([service.stop(), finished]);
  assert.equal(fixture.events.filter(event => event.event === 'detach').length, 1);
  assert.equal(console.word(UI.uiMagic), 0);
});

test('nothing is published after the service detaches', async () => {
  const fixture = await setup();
  const {console, service} = fixture;
  await service.attach();
  const stopping = service.stop();
  const late = service.dispatch({
    type: 'hosts',
    hosts: [...HOSTS, {name: 'Late', address: '10.0.0.9'}]
  });
  await Promise.all([stopping, late]);
  assert.equal(console.word(UI.uiMagic), 0);
  assert.equal(console.writes.at(-1), UI.uiMagic, 'magic 0 is the last write');
});

/** Runs `body` and returns the rejections nothing handled while it ran. */
async function unhandled(body) {
  const seen = [];
  const spy = reason => seen.push(reason);
  process.on('unhandledRejection', spy);
  try {
    await body();
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', spy);
  }
  return seen;
}

/** A fixture with a stream up on the streaming screen. */
async function streaming() {
  const fixture = await setup();
  const {console, children, service} = fixture;
  await service.attach();
  await openHost(fixture);
  console.press('a', ITEM.app);
  await service.poll();
  const stream = children.last('stream');
  stream.line('stderr', '{"event":"connected"}');
  await until(() => service.model().screen === 'streaming', 'streaming');
  return {...fixture, stream};
}

const named = (events, name) => events.filter(event => event.event === name);

test('a stream ending after the bridge closed detaches instead of crashing', async () => {
  const fixture = await streaming();
  const {console, events, service, stream} = fixture;
  const seen = await unhandled(async () => {
    console.gone = true;
    const writes = console.writes.length;
    stream.finish({code: 1});
    await until(() => named(events, 'detach').length, 'detach');
    assert.equal(console.writes.length, writes, 'nothing is written to the closed bridge');
  });
  assert.deepEqual(seen, []);
  assert.equal(named(events, 'stream-exit-failed').length, 1);
  assert.match(named(events, 'bridge-gone')[0].hint, /restart SmileBASIC 4/);
  assert.equal(service.lost(), true);
  await service.stop();
  assert.equal(named(events, 'detach').length, 1, 'a later stop does not detach again');
});

test('a stream line after the bridge closed is caught and detaches once', async () => {
  const fixture = await streaming();
  const {console, events, service, stream} = fixture;
  const seen = await unhandled(async () => {
    console.gone = true;
    const writes = console.writes.length;
    stream.line('stderr', '{"event":"console-stalled","silentMs":5000}');
    stream.line('stderr', '{"event":"log","message":"late"}');
    await until(() => named(events, 'detach').length, 'detach');
    assert.equal(console.writes.length, writes, 'stopping the stream writes no busy flag');
  });
  assert.deepEqual(seen, []);
  assert.deepEqual(stream.kills, ['SIGINT', 'SIGKILL'], 'the live stream is still stopped');
  assert.ok(named(events, 'dispatch-failed').length >= 1);
  assert.equal(named(events, 'bridge-gone').length, 1);
  assert.equal(named(events, 'detach').length, 1);
  assert.equal(named(events, 'detach-failed').length, 0);
  assert.equal(service.lost(), true);
});

test('the poll loop ends on a closed bridge and stop still resolves', async () => {
  const fixture = await setup();
  const {console, events, service} = fixture;
  const finished = service.start();
  await until(() => service.model().screen === 'hosts', 'attach');
  console.gone = true;
  await finished;
  assert.equal(named(events, 'poll-failed').length, 1);
  assert.equal(named(events, 'bridge-gone').length, 1);
  await service.stop();
  assert.equal(named(events, 'detach').length, 1);
  assert.equal(service.lost(), true);
});

test('other failures leave the bridge alone', async () => {
  const fixture = await setup();
  const {console, events, service} = fixture;
  await service.attach();
  const read = console.read;
  console.read = async () => {
    throw Error('Invalid response');
  };
  await assert.rejects(service.poll(), /Invalid response/);
  console.read = read;
  assert.equal(service.lost(), false);
  assert.equal(named(events, 'bridge-gone').length, 0);
});

test('mDNS hosts join the list after the manual ones and are saved once', async () => {
  const written = [];
  let found = [{name: 'rig', address: '192.168.8.245', port: 47989}];
  const fixture = await setup({
    discoverHosts: async () => found,
    writeHosts: hosts => written.push(hosts)
  });
  const {console, service} = fixture;
  await service.attach();
  await until(() => fixture.events.some(event => event.event === 'discovered'), 'discovery');
  assert.deepEqual(written, [], 'a host already listed changes nothing');
  assert.equal(console.shown().items.length, 2);
  found = [{name: 'Office PC', address: '10.0.0.7', port: 47989}];
  console.press('y');
  await service.poll();
  await until(() => console.shown().items.length === 3, 'the new host on the page');
  assert.deepEqual(written, [[...HOSTS, {name: 'Office PC', address: '10.0.0.7'}]]);
  assert.equal(service.model().hosts[2].name, 'Office PC');
});

test('a restart inside the same second takes a fresh epoch from the shown page', async () => {
  const fixture = await setup();
  const {console, service} = fixture;
  const {MAGIC} = await uiPage();
  console.setWord(UI.uiApplied, 9);
  console.setWord(UI.uiShown, 1);
  console.setWord(UI_OFFSET + UI_PAGE_BYTES, MAGIC);
  console.setWord(UI_OFFSET + UI_PAGE_BYTES + 4, 1700000000);
  await service.attach();
  assert.equal(service.state().epoch, 1700000001, 'not the epoch the console still shows');
  assert.equal(console.word(UI.uiEpoch), 1700000001);
  assert.equal(console.word(UI.uiSequence), 10);
  const other = await setup();
  other.console.setWord(UI.uiShown, 1);
  other.console.setWord(UI_OFFSET + UI_PAGE_BYTES, MAGIC);
  other.console.setWord(UI_OFFSET + UI_PAGE_BYTES + 4, 1699999999);
  await other.service.attach();
  assert.equal(other.service.state().epoch, 1700000000, 'an older stored epoch changes nothing');
  const ahead = await setup();
  ahead.console.setWord(UI.uiShown, 0);
  ahead.console.setWord(UI_OFFSET, MAGIC);
  ahead.console.setWord(UI_OFFSET + 4, 1700000005);
  await ahead.service.attach();
  assert.equal(ahead.service.state().epoch, 1700000006, 'a clock behind the console moves past it');
});

// The parser against a Sunshine answer recorded on the LAN (rig, avahi, compressed names,
// TXT, SRV, AAAA and A in one packet) and against packets built here for the edge cases.
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/mdns-sunshine.bin'));

function name(text) {
  return Buffer.concat([
    ...text
      .split('.')
      .filter(Boolean)
      .map(part => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)])),
    Buffer.from([0])
  ]);
}
function record(owner, type, data) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([Buffer.isBuffer(owner) ? owner : name(owner), head, data]);
}
function packet(answers, additionals = []) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0x8400, 2);
  head.writeUInt16BE(answers.length, 6);
  head.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([head, ...answers, ...additionals]);
}
const srv = (port, target) => {
  const data = Buffer.alloc(6);
  data.writeUInt16BE(port, 4);
  return Buffer.concat([data, name(target)]);
};

test('the query asks for the service with a unicast reply', () => {
  const bytes = query();
  assert.equal(bytes.readUInt16BE(4), 1);
  assert.equal(bytes.readUInt16BE(bytes.length - 4), TYPE.ptr);
  assert.equal(bytes.readUInt16BE(bytes.length - 2), 0x8001);
  assert.deepEqual(bytes.subarray(12, bytes.length - 4), name(SERVICE));
});

test('the recorded Sunshine answer yields one host with its SRV port and A address', () => {
  const records = parsePacket(FIXTURE);
  assert.deepEqual(
    records.map(r => [r.type, r.name]),
    [
      [TYPE.ptr, '_nvstream._tcp.local'],
      [TYPE.txt, 'rig._nvstream._tcp.local'],
      [TYPE.srv, 'rig._nvstream._tcp.local'],
      [TYPE.aaaa, 'rig.local'],
      [TYPE.a, 'rig.local']
    ]
  );
  assert.deepEqual(records[0].data, {target: 'rig._nvstream._tcp.local'});
  assert.deepEqual(records[1].data, {strings: ['']}, 'the empty TXT avahi sends is fine');
  assert.deepEqual(records[2].data, {port: 47989, target: 'rig.local'});
  assert.match(records[3].data.address, /^fe80:|^fd|^2/);
  assert.deepEqual(candidates(records), [{name: 'rig', address: '192.168.8.245', port: 47989}]);
});

test('records may sit in the additional section in any order; other services are ignored', () => {
  const built = packet(
    [
      record(SERVICE, TYPE.ptr, name('Office PC.' + SERVICE)),
      record('_http._tcp.local', TYPE.ptr, name('nas._http._tcp.local'))
    ],
    [
      record('office.local', TYPE.a, Buffer.from([10, 0, 0, 7])),
      record('Office PC.' + SERVICE, TYPE.srv, srv(47990, 'office.local')),
      record('nas._http._tcp.local', TYPE.srv, srv(80, 'nas.local')),
      record('nas.local', TYPE.a, Buffer.from([10, 0, 0, 8]))
    ]
  );
  assert.deepEqual(candidates(parsePacket(built)), [
    {name: 'Office PC', address: '10.0.0.7', port: 47990}
  ]);
  const pointer = Buffer.from([0xc0, 12]);
  const box = Buffer.concat([name('Box').subarray(0, -1), pointer]);
  const compressed = packet(
    [record(SERVICE, TYPE.ptr, box)],
    [
      record(box, TYPE.srv, srv(47989, 'box.local')),
      record('box.local', TYPE.a, Buffer.from([10, 0, 0, 9]))
    ]
  );
  assert.deepEqual(candidates(parsePacket(compressed)), [
    {name: 'Box', address: '10.0.0.9', port: 47989}
  ]);
  const twice = packet([
    record(SERVICE, TYPE.ptr, name('A.' + SERVICE)),
    record(SERVICE, TYPE.ptr, name('B.' + SERVICE)),
    record('A.' + SERVICE, TYPE.srv, srv(47989, 'same.local')),
    record('B.' + SERVICE, TYPE.srv, srv(47989, 'same.local')),
    record('same.local', TYPE.a, Buffer.from([10, 0, 0, 1]))
  ]);
  assert.equal(candidates(parsePacket(twice)).length, 1, 'one host per address');
  assert.deepEqual(
    candidates(parsePacket(packet([record(SERVICE, TYPE.ptr, name('Lonely.' + SERVICE))]))),
    []
  );
});

test('truncated and malformed packets are rejected, not misread', () => {
  assert.throws(() => parsePacket(FIXTURE.subarray(0, 11)), /too short/);
  assert.throws(() => parsePacket(FIXTURE.subarray(0, 100)), /past the packet/);
  const loop = packet([record(SERVICE, TYPE.ptr, Buffer.from([0xc0, 12]))]);
  loop.writeUInt8(0xc0, 12);
  loop.writeUInt8(12, 13);
  assert.throws(() => parsePacket(loop), /pointer loop|past the packet/);
  const short = packet([record(SERVICE, TYPE.a, Buffer.from([1, 2]))]);
  assert.throws(() => parsePacket(short), /four bytes/);
  const many = Buffer.from(FIXTURE);
  many.writeUInt16BE(1000, 6);
  assert.throws(() => parsePacket(many), /too many/);
});

test('merge keeps the manual list first and intact, appends new hosts once', () => {
  const manual = [
    {name: 'Rig', address: '192.168.8.245'},
    {name: 'Laptop', address: '192.168.8.9'}
  ];
  const merged = merge(manual, [
    {name: 'rig', address: '192.168.8.245', port: 47989},
    {name: 'Laptop', address: '192.168.8.99', port: 47989},
    {name: 'Office PC', address: '10.0.0.7', port: 47989},
    {name: 'Office PC', address: '10.0.0.7', port: 47989}
  ]);
  assert.deepEqual(merged, [...manual, {name: 'Office PC', address: '10.0.0.7'}]);
  assert.deepEqual(merge(manual, []), manual, 'absence removes nothing');
  assert.notEqual(merge(manual, [])[0], manual[0], 'the manual entries are copied, not shared');
});

test('discover sends the query, collects answers for the window and closes the socket', async () => {
  const sent = [];
  const socket = Object.assign(new EventEmitter(), {
    bind: (port, ready) => {
      assert.equal(port, 5353);
      setImmediate(ready);
    },
    addMembership: group => sent.push('join ' + group),
    send: (bytes, port, address, done) => {
      sent.push(`${address}:${port} ${bytes.length}`);
      done();
      setImmediate(() => socket.emit('message', FIXTURE, {address: '192.168.8.245'}));
      setImmediate(() => socket.emit('message', Buffer.from('junk'), {address: '192.168.8.1'}));
    },
    close: () => sent.push('close')
  });
  const hosts = await discover({windowMs: 30, createSocket: () => socket});
  assert.deepEqual(hosts, [{name: 'rig', address: '192.168.8.245', port: 47989}]);
  assert.deepEqual(sent, ['join 224.0.0.251', `224.0.0.251:5353 ${query().length}`, 'close']);
});

// --- host list load/save/seed -----------------------------------------

const hostsFile = () => tempFile('hbhosts-', 'hosts.json');

test('loadHosts returns [] for a missing or corrupt file', () => {
  assert.deepEqual(hosts.loadHosts('/no/such/file.json'), []);
  const file = hostsFile();
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(hosts.loadHosts(file), []);
  fs.writeFileSync(file, '{"not":"an array"}');
  assert.deepEqual(hosts.loadHosts(file), []);
});

test('saveHosts then loadHosts round-trips and names default from address', () => {
  const file = hostsFile();
  hosts.saveHosts(file, [{name: 'Rig', address: '192.168.8.245'}, {address: '10.0.0.5'}]);
  assert.deepEqual(hosts.loadHosts(file), [
    {name: 'Rig', address: '192.168.8.245'},
    {name: '10.0.0.5', address: '10.0.0.5'}
  ]);
});

test('seedHosts dedupes, keeps order and always includes the default host', () => {
  const seeded = hosts.seedHosts(
    [{name: 'Rig', address: '192.168.8.245'}],
    ['10.0.0.5', '10.0.0.5']
  );
  assert.deepEqual(seeded, [
    {name: 'Rig', address: '192.168.8.245'},
    {name: '10.0.0.5', address: '10.0.0.5'}
  ]);
  const fresh = hosts.seedHosts([]);
  assert.deepEqual(fresh, [hosts.DEFAULT_HOST]);
  assert.equal(fresh.find(h => h.address === hosts.DEFAULT_HOST.address).name, 'Sunshine');
});

// --- list JSON parsing -------------------------------------------------

test('parseList reads currentGame and apps from the helper line', () => {
  const stdout =
    '{"event":"connected"}\n{"currentGame":12,"apps":[{"id":1,"name":"Desktop"},{"id":881448767,"name":"Steam Big Picture"}]}\n';
  assert.deepEqual(hosts.parseList(stdout), {
    currentGame: 12,
    apps: [
      {id: 1, name: 'Desktop'},
      {id: 881448767, name: 'Steam Big Picture'}
    ]
  });
});

test('parseList defaults currentGame to 0 and throws without an app list', () => {
  assert.deepEqual(hosts.parseList('{"currentGame":0,"apps":[]}'), {currentGame: 0, apps: []});
  assert.throws(() => hosts.parseList('{"event":"error"}'));
});

// settings.js
const settingsFile = () => tempFile('hbsettings-', 'settings.json');

test('defaults are the tested 1080p60 control shape', () => {
  const values = settings.defaults();
  assert.deepEqual(values, {
    size: '1920x1080',
    fps: 60,
    bitrate: 20,
    codec: 'h264',
    audio: 'stereo',
    quitOnReturn: false,
    optimise: false,
    presentHz: 60
  });
  assert.deepEqual(settings.streamArgs(values), [
    '--codec',
    'h264',
    '--size',
    '1920x1080',
    '--fps',
    '60',
    '--bitrate',
    '20000',
    '--staggered',
    '--socket-audio'
  ]);
});

test('load falls back per value for a missing, corrupt or out-of-range file', () => {
  assert.deepEqual(settings.load('/no/such/settings.json'), settings.defaults());
  const file = settingsFile();
  fs.writeFileSync(file, 'nope');
  assert.deepEqual(settings.load(file), settings.defaults());
  fs.writeFileSync(file, JSON.stringify({fps: 30, bitrate: 7, size: '640x480', extra: 1}));
  assert.deepEqual(settings.load(file), {...settings.defaults(), fps: 30});
});

test('save then load round-trips and lives beside hosts.json', () => {
  const file = settingsFile();
  const values = {...settings.defaults(), size: '1280x720', bitrate: 7.5, presentHz: 120};
  settings.save(file, values);
  assert.deepEqual(settings.load(file), values);
  assert.equal(path.basename(settings.settingsFile()), 'settings.json');
  assert.equal(path.basename(path.dirname(settings.settingsFile())), 'moonlight');
});

test('adjust steps without wrapping and leaves locked and unbacked rows alone', () => {
  let values = settings.defaults();
  values = settings.adjust(values, 'bitrate', 1);
  assert.equal(values.bitrate, 22.5);
  values = settings.adjust(values, 'fps', -1);
  assert.equal(values.fps, 30);
  assert.equal(settings.adjust(values, 'fps', -1), values, 'no wrap below the first value');
  values = settings.adjust(values, 'presentHz', 1);
  values = settings.adjust(values, 'presentHz', 1);
  assert.equal(values.presentHz, 120, 'no wrap above the last value');
  assert.equal(settings.adjust(values, 'codec', 1).codec, 'h264');
  assert.equal(settings.adjust(values, 'quitOnReturn', 1).quitOnReturn, false);
  assert.equal(settings.adjust(values, 'nothing', 1), values);
});

test('rows carry the value text and grey the unbacked toggles', () => {
  const rows = settings.rows({...settings.defaults(), presentHz: 120, bitrate: 7.5});
  assert.deepEqual(
    rows.map(row => [row.id, row.value, row.adjustable, row.greyed]),
    [
      ['size', '1920 × 1080', true, false],
      ['fps', '60 fps', true, false],
      ['bitrate', '7.5 Mbps', true, false],
      ['codec', 'H.264', false, false],
      ['audio', 'Stereo', false, false],
      ['quitOnReturn', 'Off', false, true],
      ['optimise', 'Off', false, true],
      ['presentHz', '120 Hz (experimental)', true, false]
    ]
  );
});

test('streamArgs adds the present rate only at 120 and keeps the bitrate in kbps', () => {
  const args = settings.streamArgs({...settings.defaults(), presentHz: 120, bitrate: 7.5});
  assert.deepEqual(args.slice(-2), ['--present-hz', '120']);
  assert.equal(args[args.indexOf('--bitrate') + 1], '7500');
  assert.ok(args.includes('--staggered'), 'present-hz needs the staggered form');
});
