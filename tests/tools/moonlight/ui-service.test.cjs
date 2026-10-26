// The service against a fake console that applies pages the way the shader does, and fake
// children standing in for the helper and live.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const {createService} = require('../../../hbl-moonlight/tools/moonlight/ui-service.js');
const {
  UI,
  UI_MAGIC,
  UI_OP,
  UI_OFFSET,
  UI_PAGE_BYTES,
  MEMORY_BYTES
} = require('../../../hbl-moonlight/tools/moonlight/ring.js');
const {ITEM} = require('../../../hbl-moonlight/tools/moonlight/ui-model.js');
const {createPages} = require('../../../hbl-moonlight/tools/moonlight/ui-pages.js');
const settings = require('../../../hbl-moonlight/tools/moonlight/ui-settings.js');
const uiPage = () => import('../../../hbl-moonlight/tools/moonlight/ui-page.js');

const HOSTS = [
  {name: 'Rig', address: '192.168.8.245'},
  {name: 'Laptop', address: '192.168.8.9'}
];
const APPS = [
  {id: 881448767, name: 'Desktop'},
  {id: 1217, name: 'Steam'}
];
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
    async read(address, length) {
      if (console.reverting && --console.reverting.reads < 0) {
        console.reverting.words.copy(bytes, UI.uiMagic);
        console.reverting = null;
      }
      return Buffer.from(bytes.subarray(address - MAPPED, address - MAPPED + length));
    },
    async write(address, data) {
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
