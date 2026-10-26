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
    2 + 2 * HOSTS.length + 1,
    'title, subtitle, name and address per host, hint'
  );
  assert.equal(parsed.flags, 0, 'the cursor shows');
  assert.equal(parsed.background >>> 24, 0xff);
  const again = await pages.page(model);
  assert.deepEqual(
    again.texts.map(text => text.alpha),
    page.texts.map(text => text.alpha)
  );
  assert.equal(raster.calls.text, 2 + 2 * HOSTS.length + 1, 'strips are painted once');
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
    [1000, Promise.resolve({width: 160, height: 90, bytes: Buffer.alloc(160 * 90 * 4, 9)})],
    [1001, Promise.resolve({width: 0, height: 0, bytes: Buffer.alloc(0)})],
    [1002, Promise.reject(Error('rasteriser gone'))]
  ]);
  const first = await roundTrip(await pages.page(apps, covers));
  assert.equal(first.summary.images, 20);
  assert.equal(first.summary.items, 23);
  assert.ok(first.summary.texts <= 48);
  assert.equal(raster.calls.letters, 19, 'one cover came from the host, the rest are letter tiles');
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
  const previous = items.find(item => item.id === ITEM.previous),
    next = items.find(item => item.id === ITEM.next);
  assert.equal(previous.flags, ITEM_FLAG.greyed, 'no page before the first');
  assert.equal(next.flags, 0);
  assert.ok(items.every(item => item.x + item.w <= 1920 && item.y + item.h <= 1080));
  const last = reduce(reduce(apps, command('a', ITEM.next)).model, command('a', ITEM.next)).model;
  const third = await roundTrip(await pages.page(last, covers));
  assert.equal(third.summary.images, 5);
  assert.equal(third.parsed.items[0].id, ITEM.app + 40);
  assert.equal(third.parsed.items.find(item => item.id === ITEM.next).flags, ITEM_FLAG.greyed);
  assert.equal(third.parsed.items.find(item => item.id === ITEM.previous).flags, 0);
  assert.equal(raster.calls.letters, 24, 'letter tiles are cached by name');
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
  assert.equal(status.summary.texts, first.summary.texts, 'the status joins the subtitle strip');
  assert.equal(raster.calls.text, painted + 1, 'only the subtitle is painted again');
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

test('the streaming overlay, the quit question and the error page carry their items', async () => {
  const pages = createPages(fakeRaster());
  const {PAGE_FLAG} = await uiPage();
  const apps = reduce(
    reduce(reduce(makeModel(HOSTS), {type: 'attached'}).model, command('a', ITEM.host)).model,
    {type: 'listed', apps: APPS.slice(0, 2), currentGame: 1001}
  ).model;
  const streaming = reduce(reduce(apps, command('a', ITEM.app)).model, {
    type: 'streamStarted'
  }).model;
  const overlay = await roundTrip(await pages.page(streaming));
  assert.equal(overlay.parsed.flags, PAGE_FLAG.overlay);
  assert.equal(overlay.parsed.background, 0, 'the overlay shows the dimmed video through');
  assert.deepEqual(
    overlay.parsed.items.map(item => item.id),
    [ITEM.returnToApps, ITEM.quitHost]
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
  const launching = reduce(apps, command('a', ITEM.app)).model;
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
