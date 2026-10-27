const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ITEM,
  APPS_PER_PAGE,
  HOSTS_PER_PAGE,
  makeModel,
  reduce
} = require('../../../hbl-moonlight/host/ui/model.js');
const settings = require('../../../hbl-moonlight/host/ui/settings.js');

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
