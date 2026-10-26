// Every screen's page goes through the serializer and the validator the shader mirrors, with
// a fake rasteriser whose strips have deterministic sizes.
const test = require('node:test');
const assert = require('node:assert/strict');
const {createPages, COVER} = require('../../../hbl-moonlight/tools/moonlight/ui-pages.js');
const {ITEM, makeModel, reduce} = require('../../../hbl-moonlight/tools/moonlight/ui-model.js');
const settings = require('../../../hbl-moonlight/tools/moonlight/ui-settings.js');
const uiPage = () => import('../../../hbl-moonlight/tools/moonlight/ui-page.js');

function fakeRaster() {
  const calls = {text: 0, letters: 0, tile: 0};
  return {
    calls,
    async text(text, size, width) {
      calls.text++;
      const height = Math.min(96, Math.round(size * 1.17));
      return {width, height, bytes: Buffer.alloc(width * height, text.length ? 200 : 0)};
    },
    async legend(keys, size, width) {
      calls.text++;
      const height = Math.round(size * 1.55);
      return {width, height, bytes: Buffer.alloc(width * height, keys.length ? 200 : 0)};
    },
    async letters(text, width, height) {
      calls.letters++;
      return {width, height, bytes: Buffer.alloc(width * height * 4, text.charCodeAt(0))};
    },
    async tile(png, width, height) {
      calls.tile++;
      return {width, height, bytes: Buffer.alloc(width * height * 4, 7)};
    },
    close() {}
  };
}

const HOSTS = [
  {name: 'Rig', address: '192.168.8.245'},
  {name: 'Laptop', address: '192.168.8.9'}
];
const APPS = Array.from({length: 45}, (_, i) => ({id: 1000 + i, name: 'Game ' + (i + 1)}));
const command = (op, item = 0, value = 0) => ({type: 'command', op, item, value});

async function roundTrip(page) {
  const {serialize, validate, parse} = await uiPage();
  const bytes = serialize({...page, epoch: 7, sequence: 3});
  const summary = validate(bytes, {epoch: 7, sequence: 3});
  return {bytes, summary, parsed: parse(bytes)};
}

test('the hosts page lists hosts as items and round-trips', async () => {
  const raster = fakeRaster();
  const pages = createPages(raster);
  const model = reduce(makeModel(HOSTS), {type: 'attached'}).model;
  const page = await pages.page(model);
  const {summary, parsed} = await roundTrip(page);
  assert.deepEqual(
    parsed.items.map(item => item.id),
    [ITEM.host, ITEM.host + 1]
  );
  assert.equal(
    summary.texts,
    2 + 3 + 3 * HOSTS.length + 1,
    'chip, heading, a card with name and address per host, legend'
  );
  assert.equal(parsed.flags, 0, 'the cursor shows');
  assert.equal(parsed.background >>> 24, 0xff);
  const again = await pages.page(model);
  assert.deepEqual(
    again.texts.map(text => text.alpha),
    page.texts.map(text => text.alpha)
  );
  assert.equal(raster.calls.text, 1 + 3 + 2 * HOSTS.length + 1, 'strips are painted once');
});

test('status pages hide the cursor and carry the host or app name', async () => {
  const pages = createPages(fakeRaster());
  const {PAGE_FLAG} = await uiPage();
  const connecting = reduce(
    reduce(makeModel(HOSTS), {type: 'attached'}).model,
    command('a', ITEM.host)
  ).model;
  const page = await pages.page(connecting);
  const {parsed} = await roundTrip(page);
  assert.equal(parsed.flags, PAGE_FLAG.hideCursor);
  assert.equal(parsed.items.length, 0);
  const pairing = reduce(connecting, {type: 'notPaired'}).model;
  const waiting = await roundTrip(await pages.page(pairing));
  assert.equal(waiting.parsed.flags, PAGE_FLAG.hideCursor);
  const pinned = reduce(pairing, {
    type: 'pin',
    pin: '4821',
    url: 'https://192.168.8.245:47990/pin'
  }).model;
  const shown = await pages.page(pinned);
  const tallest = texts => Math.max(...texts.map(text => text.h));
  assert.ok(tallest(shown.texts) > tallest(waiting.parsed.texts), 'the PIN is the largest strip');
  assert.ok(shown.texts.length > waiting.parsed.texts.length);
});

test('the apps grid pages covers and letter tiles with the current app marked', async () => {
  const raster = fakeRaster();
  const pages = createPages(raster);
  const {ITEM_FLAG} = await uiPage();
  const apps = reduce(
    reduce(reduce(makeModel(HOSTS), {type: 'attached'}).model, command('a', ITEM.host)).model,
    {type: 'listed', apps: APPS, currentGame: 1003}
  ).model;
  const covers = new Map([
    [1000, Promise.resolve({width: 240, height: 135, bytes: Buffer.alloc(240 * 135 * 4, 9)})],
    [1001, Promise.resolve({width: 0, height: 0, bytes: Buffer.alloc(0)})],
    [1002, Promise.reject(Error('rasteriser gone'))]
  ]);
  const first = await roundTrip(await pages.page(apps, covers));
  assert.equal(first.summary.images, 10);
  assert.equal(first.summary.items, 13, 'ten covers, back, previous and next');
  assert.ok(first.summary.texts <= 48);
  assert.equal(raster.calls.letters, 9, 'one cover came from the host, the rest are letter tiles');
  assert.equal(
    first.parsed.images[1].rgba[0],
    'G'.charCodeAt(0),
    'a refused cover falls back to letters'
  );
  assert.equal(first.parsed.images[2].w, COVER.width, 'a failed tile falls back to letters');
  assert.equal(first.parsed.images[0].rgba[0], 9, 'the fetched cover is used');
  assert.equal(first.parsed.images[0].w, COVER.width);
  const items = first.parsed.items;
  assert.equal(items[3].id, ITEM.app + 3);
  assert.equal(items[3].flags, ITEM_FLAG.current);
  assert.equal(items[0].flags, 0);
  const tag = first.parsed.texts.filter(t => t.x === items[3].x + 8 && t.y === items[3].y + 8);
  assert.equal(tag.length, 1, 'the running tag sits on the cover corner');
  assert.ok(
    first.parsed.texts.some(
      t => t.x === items[3].x && t.y === items[3].y + COVER.height + 16 && t.w === COVER.width
    ),
    'the running app keeps its name'
  );
  const previous = items.find(item => item.id === ITEM.previous),
    next = items.find(item => item.id === ITEM.next);
  assert.equal(previous.flags, ITEM_FLAG.greyed, 'no page before the first');
  assert.equal(next.flags, 0);
  assert.ok(items.every(item => item.x + item.w <= 1920 && item.y + item.h <= 1080));
  const last = [1, 2, 3, 4].reduce(model => reduce(model, command('a', ITEM.next)).model, apps);
  const third = await roundTrip(await pages.page(last, covers));
  assert.equal(third.summary.images, 5);
  assert.equal(third.parsed.items[0].id, ITEM.app + 40);
  assert.equal(third.parsed.items.find(item => item.id === ITEM.next).flags, ITEM_FLAG.greyed);
  assert.equal(third.parsed.items.find(item => item.id === ITEM.previous).flags, 0);
  assert.equal(raster.calls.letters, 14, 'letter tiles are cached by name');
  const painted = raster.calls.text;
  const quit = reduce(
    reduce(reduce(apps, command('y')).model, command('a', ITEM.confirmQuit)).model,
    {type: 'quitDone'}
  ).model;
  const marked = reduce(quit, {
    type: 'listed',
    apps: APPS,
    currentGame: 0,
    message: 'Quit confirmed'
  }).model;
  assert.equal(marked.message, 'Quit confirmed');
  const status = await roundTrip(await pages.page(marked, covers));
  assert.equal(
    status.summary.texts,
    first.summary.texts - 2,
    'the status joins the subtitle strip; the quit app loses its tag and its card'
  );
  assert.equal(raster.calls.text, painted + 1, 'only the subtitle is painted; the name is cached');
});

test('back from a stream, the cursor starts on the app that streamed', async () => {
  const pages = createPages(fakeRaster());
  const apps = reduce(
    reduce(reduce(makeModel(HOSTS), {type: 'attached'}).model, command('a', ITEM.host)).model,
    {type: 'listed', apps: APPS, currentGame: 0}
  ).model;
  const second = reduce(apps, command('a', ITEM.next)).model;
  const ended = [
    command('a', ITEM.app + 12),
    {type: 'streamStarted'},
    {type: 'streamEnded'},
    {type: 'listed', apps: APPS, currentGame: 1012}
  ].reduce((model, event) => reduce(model, event).model, second);
  assert.equal(ended.appPage, 1);
  const {parsed} = await roundTrip(await pages.page(ended));
  assert.equal(parsed.items[parsed.cursorHome].id, ITEM.app + 12);
  const fresh = await roundTrip(await pages.page(apps));
  assert.equal(fresh.parsed.cursorHome, 0, 'a host opened afresh starts on its first app');
});

test('settings rows are adjustable unless locked or unbacked', async () => {
  const pages = createPages(fakeRaster());
  const {ITEM_FLAG} = await uiPage();
  const model = reduce(reduce(makeModel(HOSTS), {type: 'attached'}).model, command('x')).model;
  const {parsed} = await roundTrip(await pages.page(model));
  const rows = settings.rows(model.settings);
  assert.equal(parsed.items.length, rows.length);
  rows.forEach((row, i) => {
    assert.equal(parsed.items[i].id, ITEM.setting + i);
    assert.equal((parsed.items[i].flags & ITEM_FLAG.adjustable) !== 0, row.adjustable, row.id);
    assert.equal((parsed.items[i].flags & ITEM_FLAG.greyed) !== 0, row.greyed, row.id);
  });
});

test('settings are two columns of cards the cursor frame fits around', async () => {
  const pages = createPages(fakeRaster());
  const {MAX_TEXTS} = await uiPage();
  const attached = reduce(makeModel(HOSTS), {type: 'attached'}).model;
  const connected = reduce(attached, command('a', ITEM.host)).model;
  const listed = reduce(connected, {type: 'listed', apps: APPS.slice(0, 2), currentGame: 0}).model;
  const model = reduce(listed, command('x')).model;
  assert.equal(model.screen, 'settings');
  const {parsed} = await roundTrip(await pages.page(model));
  assert.ok(parsed.texts.length < MAX_TEXTS, `${parsed.texts.length} strips`);
  assert.deepEqual([...new Set(parsed.items.map(item => item.x))].length, 2, 'two columns');
  const frame = 6;
  parsed.items.forEach((item, i) => {
    assert.ok(item.x - frame >= 16 && item.x + item.w + frame <= 1920 - 16, 'on screen');
    const card = parsed.texts.find(
      text => text.x === item.x && text.y === item.y && text.w === item.w && text.h === item.h
    );
    assert.ok(card && card.alpha.every(value => value === 255), 'a solid card under the item');
    const index = parsed.texts.indexOf(card);
    const inside = parsed.texts.filter(
      text =>
        text !== card &&
        text.x >= item.x &&
        text.x + text.w <= item.x + item.w &&
        text.y >= item.y &&
        text.y + text.h <= item.y + item.h
    );
    assert.ok(inside.length >= 2, 'label and value on the card');
    assert.ok(
      inside.every(text => parsed.texts.indexOf(text) > index),
      'card drawn first'
    );
    parsed.items.slice(i + 1).forEach(other => {
      const apartX = Math.max(other.x - (item.x + item.w), item.x - (other.x + other.w));
      const apartY = Math.max(other.y - (item.y + item.h), item.y - (other.y + other.h));
      assert.ok(Math.max(apartX, apartY) >= 2 * frame + 4, 'frames never touch');
    });
  });
});

test('every Horizon screen keeps its cursor frames on screen and apart', async () => {
  const pages = createPages(fakeRaster());
  const {MAX_TEXTS} = await uiPage();
  const many = Array.from({length: 9}, (_, i) => ({name: 'PC ' + i, address: '10.0.0.' + i}));
  const listed = reduce(
    reduce(reduce(makeModel(many), {type: 'attached'}).model, command('a', ITEM.host)).model,
    {type: 'listed', apps: APPS.slice(0, 2), currentGame: 1001}
  ).model;
  const screens = {
    hosts: reduce(makeModel(many), {type: 'attached'}).model,
    quitConfirm: reduce(listed, command('y')).model,
    streaming: reduce(reduce(listed, command('a', ITEM.app)).model, {type: 'streamStarted'}).model,
    error: reduce(listed, {type: 'failed', message: 'Cannot reach the PC'}).model
  };
  const frame = 6;
  for (const [name, model] of Object.entries(screens)) {
    const {parsed} = await roundTrip(await pages.page(model));
    assert.ok(parsed.texts.length < MAX_TEXTS, name + ' strips');
    assert.ok(parsed.items.length > 0, name + ' items');
    parsed.items.forEach((item, i) => {
      assert.ok(item.x - frame >= 16 && item.x + item.w + frame <= 1904, name + ' x');
      assert.ok(item.y - frame >= 16 && item.y + item.h + frame <= 1064, name + ' y');
      parsed.items.slice(i + 1).forEach(other => {
        const apartX = Math.max(other.x - (item.x + item.w), item.x - (other.x + other.w));
        const apartY = Math.max(other.y - (item.y + item.h), item.y - (other.y + other.h));
        assert.ok(Math.max(apartX, apartY) >= 2 * frame + 4, name + ' frames apart');
      });
    });
  }
  const shown = (await roundTrip(await pages.page(screens.hosts))).parsed.items;
  assert.deepEqual(
    shown.map(item => item.id),
    [0, 1, 2, 3, 4, 5].map(i => ITEM.host + i).concat(ITEM.previous, ITEM.next),
    'six PCs per page and the pager'
  );
  const second = reduce(screens.hosts, command('a', ITEM.next)).model;
  const opened = reduce(second, command('a', ITEM.host + 7)).model;
  const back = reduce(
    reduce(opened, {type: 'listed', apps: APPS.slice(0, 2), currentGame: 0}).model,
    command('b')
  ).model;
  const returned = (await roundTrip(await pages.page(back))).parsed;
  assert.deepEqual(
    returned.items.slice(0, 3).map(item => item.id),
    [ITEM.host + 6, ITEM.host + 7, ITEM.host + 8],
    'hosts keep their ids on the second page'
  );
  assert.equal(returned.cursorHome, 1, 'the cursor comes back to the host it left');
});

test('the streaming overlay, the quit question and the error page carry their items', async () => {
  const pages = createPages(fakeRaster());
  const {PAGE_FLAG} = await uiPage();
  const apps = reduce(
    reduce(reduce(makeModel(HOSTS), {type: 'attached'}).model, command('a', ITEM.host)).model,
    {type: 'listed', apps: APPS.slice(0, 2), currentGame: 1001}
  ).model;
  const streaming = reduce(reduce(apps, command('a', ITEM.app + 1)).model, {
    type: 'streamStarted'
  }).model;
  const overlay = await roundTrip(await pages.page(streaming));
  assert.equal(overlay.parsed.flags, PAGE_FLAG.overlay);
  assert.equal(overlay.parsed.background, 0, 'the overlay shows the dimmed video through');
  assert.deepEqual(
    overlay.parsed.items.map(item => item.id),
    [ITEM.returnToApps, ITEM.quitHost]
  );
  const [first] = overlay.parsed.items;
  const under = overlay.parsed.texts.filter(
    t =>
      t.color === 0xff17191c &&
      t.x <= first.x &&
      t.x + t.w >= overlay.parsed.items[1].x + overlay.parsed.items[1].w
  );
  assert.ok(under.length >= 2, 'the heading and buttons sit on an opaque panel');
  const covered = y => under.some(t => t.y <= y && y < t.y + t.h);
  assert.ok(
    [first.y, first.y + first.h / 2, first.y + first.h - 1].every(covered),
    'the panel covers the buttons'
  );
  const asked = await roundTrip(await pages.page(reduce(apps, command('y')).model));
  assert.deepEqual(
    asked.parsed.items.map(item => item.id),
    [ITEM.confirmQuit, ITEM.cancel]
  );
  assert.equal(asked.parsed.cursorHome, 1, 'the cursor starts on Cancel');
  assert.ok(asked.parsed.texts.length >= 4);
  const failed = reduce(apps, {type: 'failed', message: 'Cannot reach the PC'}).model;
  const error = await roundTrip(await pages.page(failed));
  assert.deepEqual(
    error.parsed.items.map(item => item.id),
    [ITEM.back]
  );
  const launching = reduce(apps, command('a', ITEM.app + 1)).model;
  const staged = reduce(launching, {type: 'stage', message: 'RTSP handshake'}).model;
  assert.equal((await roundTrip(await pages.page(staged))).parsed.flags, PAGE_FLAG.hideCursor);
  assert.equal(await pages.page(makeModel(HOSTS)), null, 'splash is the static atlas');
});

test('cover tiles from PNGs go through the tile cache', async () => {
  const raster = fakeRaster();
  const pages = createPages(raster);
  const tile = await pages.cover('host:1000', '/tmp/does-not-matter.png');
  assert.equal(tile.bytes.length, COVER.width * COVER.height * 4);
  await pages.cover('host:1000', '/tmp/does-not-matter.png');
  assert.equal(raster.calls.tile, 1);
});
