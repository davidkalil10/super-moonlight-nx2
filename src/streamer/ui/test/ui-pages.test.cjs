// The UI render side: pages, the page format, the rasteriser and the input feeder gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createPages, COVER} = require('../pages.js');
const {ITEM, makeModel, reduce} = require('../model.js');
const settings = require('../settings.js');
const {createRaster} = require('../raster.js');
const {gate, readStorage, OVERLAY_READ} = require('../../input/input-feeder.js');
const {UI, UI_MAGIC} = require('../../shared/ring.js');
const {uiPage} = require('../../test-support/test-helpers.cjs');

// Every screen's page goes through the serializer and the validator the shader mirrors, with
// a fake rasteriser whose strips have deterministic sizes.
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

// page.js
const load = () => import('../page.js');
const ring = () => import('../../shared/ring.js');

function samplePage(overrides = {}) {
  return {
    epoch: 1700000000,
    sequence: 3,
    background: 0xff100806,
    cursorHome: 1,
    items: [
      {id: 7, x: 100, y: 200, w: 800, h: 60},
      {id: 9, x: 100, y: 280, w: 800, h: 60, flags: 4},
      {id: 11, x: 100, y: 360, w: 800, h: 60, flags: 1}
    ],
    texts: [
      {x: 120, y: 212, w: 7, h: 3, alpha: Buffer.alloc(21, 200), color: 0xffe0e0e0},
      {x: 120, y: 292, w: 4, h: 4, alpha: Buffer.alloc(16, 90)}
    ],
    images: [{x: 1000, y: 200, w: 2, h: 3, rgba: Buffer.alloc(24, 1)}],
    ...overrides
  };
}

test('a page serializes to tables plus a 4-aligned body and parses back', async () => {
  const {serialize, parse, validate, BODY_OFFSET, checksum} = await load();
  const page = serialize(samplePage());
  assert.equal(page.readUInt32LE(0), 0x47504248);
  assert.equal(page.readUInt32LE(28), 24 + 16 + 24, 'strips padded to 4 bytes');
  assert.equal(page.length, BODY_OFFSET + 64);
  assert.equal(page.readUInt32LE(40), checksum(page));
  assert.deepEqual(validate(page, {epoch: 1700000000, sequence: 3}), {
    epoch: 1700000000,
    sequence: 3,
    items: 3,
    texts: 2,
    images: 1,
    bodyBytes: 64
  });
  const parsed = parse(page);
  assert.deepEqual(parsed.items, [
    {id: 7, x: 100, y: 200, w: 800, h: 60, flags: 0},
    {id: 9, x: 100, y: 280, w: 800, h: 60, flags: 4},
    {id: 11, x: 100, y: 360, w: 800, h: 60, flags: 1}
  ]);
  assert.equal(parsed.texts[0].color, 0xffe0e0e0);
  assert.equal(parsed.texts[1].color, 0xffffffff, 'white by default');
  assert.equal(Buffer.from(parsed.texts[0].alpha).equals(Buffer.alloc(21, 200)), true);
  assert.equal(Buffer.from(parsed.images[0].rgba).equals(Buffer.alloc(24, 1)), true);
  assert.equal(parsed.background, 0xff100806);
  assert.equal(parsed.cursorHome, 1);
});

test('the validator refuses what the shader refuses', async () => {
  const {serialize, validate} = await load();
  const page = serialize(samplePage());
  assert.throws(() => validate(page, {epoch: 1}), /epoch/);
  assert.throws(() => validate(page, {sequence: 4}), /sequence/);
  const torn = Buffer.from(page);
  torn.writeUInt32LE(0xdeadbeef, 64 + 4);
  assert.throws(() => validate(torn), /checksum/);
  const offScreen = Buffer.from(page);
  offScreen.writeUInt32LE(1900, 64 + 4);
  offScreen.writeUInt32LE(0, 40);
  assert.throws(() => validate(offScreen), /checksum/, 'rects are under the checksum');
  assert.throws(() => validate(page.subarray(0, page.length - 8)), /body bytes/);
  assert.throws(() => validate(Buffer.alloc(0x1000)), /magic/);
});

test('the serializer refuses pages the console could not show', async () => {
  const {serialize, MAX_ITEMS, MAX_TEXT} = await load();
  assert.throws(() => serialize(samplePage({epoch: 0})), /epoch/);
  assert.throws(() => serialize(samplePage({sequence: 0})), /sequence/);
  assert.throws(() => serialize(samplePage({cursorHome: 3})), /cursor home/);
  assert.throws(
    () => serialize(samplePage({cursorHome: 0, items: [{id: 0, x: 0, y: 0, w: 10, h: 10}]})),
    /nonzero id/
  );
  assert.throws(
    () => serialize(samplePage({cursorHome: 0, items: [{id: 1, x: 1900, y: 0, w: 40, h: 10}]})),
    /off screen/
  );
  const many = Array.from({length: MAX_ITEMS + 1}, (_, i) => ({id: i + 1, x: 0, y: i, w: 8, h: 1}));
  assert.throws(() => serialize(samplePage({items: many})), /Too many UI items/);
  assert.throws(
    () => serialize(samplePage({texts: [{x: 0, y: 0, w: 4, h: 2, alpha: Buffer.alloc(7)}]})),
    /do not match/
  );
  assert.throws(
    () =>
      serialize(
        samplePage({
          texts: [{x: 0, y: 0, w: 4, h: MAX_TEXT.height + 1, alpha: Buffer.alloc(4 * 97)}]
        })
      ),
    /text rect/
  );
  assert.throws(
    () => serialize(samplePage({images: [{x: 0, y: 0, w: 400, h: 10, rgba: Buffer.alloc(16000)}]})),
    /image rect/
  );
});

test('page addresses, host words and the command read follow the control block', async () => {
  const {pageAddress, hostWords, readCommand, COMMAND_READ} = await load();
  const {UI, UI_OFFSET, UI_PAGE_BYTES, UI_MAGIC, MEMORY_BYTES} = await ring();
  assert.equal(pageAddress(0x1000000, 1), 0x1000000 + UI_OFFSET + UI_PAGE_BYTES);
  assert.equal(UI_OFFSET + 2 * UI_PAGE_BYTES, MEMORY_BYTES);
  assert.equal(UI.uiMagic, 0xc000);
  assert.ok(UI.hostBusy + 4 <= 0x10000, 'inside the control page');
  const words = hostWords({magic: UI_MAGIC, epoch: 5, sequence: 9, page: 1});
  assert.deepEqual([...new Uint32Array(words.buffer, words.byteOffset, 4)], [UI_MAGIC, 5, 9, 1]);
  assert.deepEqual(COMMAND_READ, {offset: 0xc010, bytes: 40});
  const block = Buffer.alloc(40);
  const at = name => UI[name] - COMMAND_READ.offset;
  block.writeUInt32LE(9, at('uiApplied'));
  block.writeUInt32LE(2, at('uiCursor'));
  block.writeUInt32LE(1, at('uiOverlay'));
  block.writeUInt32LE(4, at('cmdSequence'));
  block.writeUInt32LE(5, at('cmdOp'));
  block.writeUInt32LE(77, at('cmdItem'));
  block.writeUInt32LE(0xffffffff, at('cmdValue'));
  block.writeUInt32LE(9, at('cmdPage'));
  block.writeUInt32LE(5, at('cmdEpoch'));
  assert.deepEqual(readCommand(block), {
    applied: 9,
    cursor: 2,
    overlay: true,
    touchItem: 0,
    command: {sequence: 4, op: 5, item: 77, value: -1, page: 9, epoch: 5}
  });
});

// The rasteriser paints what pages.js lays out; sizes and coverage are checked, never exact
// bytes, since they depend on the PIL and font builds of the host.
let pil = true;
try {
  execFileSync('python3', ['-c', 'import PIL'], {stdio: 'ignore'});
} catch {
  pil = false;
}
const ink = bytes => bytes.filter(byte => byte > 0).length;
const cjk = [
  '/usr/share/fonts/google-noto-sans-cjk-vf-fonts/NotoSansCJK-VF.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/google-droid-sans-fonts/DroidSansFallbackFull.ttf',
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf'
].some(file => fs.existsSync(file));

test(
  'text strips are one line high, as wide as asked, and shortened to fit',
  {skip: !pil},
  async () => {
    const raster = createRaster();
    try {
      const strip = await raster.text('Desktop', 36, 400);
      assert.equal(strip.width, 400);
      assert.ok(strip.height > 30 && strip.height <= 96, 'line height ' + strip.height);
      assert.equal(strip.bytes.length, 400 * strip.height);
      assert.ok(ink(strip.bytes) > 200, 'the text left ink');
      const empty = await raster.text('', 36, 400);
      assert.equal(ink(empty.bytes), 0);
      const long = await raster.text('A'.repeat(200), 36, 120);
      assert.equal(long.width, 120);
      assert.ok(ink(long.bytes) > 0);
      const big = await raster.text('4821', 160, 600, 'center');
      assert.equal(big.height, 96, 'strips never exceed the page limit');
      const [left, right] = await Promise.all([
        raster.text('x', 36, 300),
        raster.text('x', 36, 300, 'right')
      ]);
      const firstInk = bytes => bytes.findIndex(byte => byte > 0) % 300;
      assert.ok(firstInk(left.bytes) < firstInk(right.bytes), 'alignment moves the ink');
    } finally {
      raster.close();
    }
  }
);

test(
  'cover tiles keep the whole art over its blur and the letter tile carries initials',
  {skip: !pil},
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hbraster-'));
    const png = path.join(directory, 'cover.png');
    execFileSync('python3', [
      '-c',
      `from PIL import Image; Image.new('RGB', (300, 400), (200, 30, 30)).save(${JSON.stringify(png)})`
    ]);
    const raster = createRaster();
    try {
      const tile = await raster.tile(png, 160, 90);
      assert.equal(tile.width, 160);
      assert.equal(tile.height, 90);
      assert.equal(tile.bytes.length, 160 * 90 * 4);
      const pixel = x => tile.bytes.subarray((45 * 160 + x) * 4, (45 * 160 + x) * 4 + 4);
      assert.equal(pixel(2)[3], 255, 'a portrait cover fills the sides');
      assert.ok(pixel(2)[0] > 30 && pixel(2)[0] < 120, 'with its own art, darkened');
      assert.equal(pixel(80)[3], 255);
      assert.equal(pixel(80)[0], 200, 'the art itself in the middle, red channel first');
      const letters = await raster.letters('Elden Ring', 160, 90);
      assert.equal(letters.bytes.length, 160 * 90 * 4);
      const light = [];
      for (let i = 3; i < letters.bytes.length; i += 4) {
        assert.equal(letters.bytes[i], 255, 'opaque');
        if (letters.bytes[i - 3] > 200) light.push(i);
      }
      assert.ok(light.length > 100, 'initials in a light ink');
      const other = await raster.letters('Hades', 160, 90);
      assert.notDeepEqual(other.bytes.subarray(0, 4), letters.bytes.subarray(0, 4), 'hue per name');
      const truncated = path.join(directory, 'truncated.png');
      fs.writeFileSync(truncated, fs.readFileSync(png).subarray(0, 100));
      const broken = await raster.tile(truncated, 160, 90);
      assert.deepEqual(
        [broken.width, broken.height, broken.bytes.length],
        [0, 0, 0],
        'a cut file is refused'
      );
      const wide = path.join(directory, 'wide.png');
      execFileSync('python3', [
        '-c',
        `from PIL import Image; Image.new('L', (5000, 1)).save(${JSON.stringify(wide)})`
      ]);
      const oversized = await raster.tile(wide, 160, 90);
      assert.equal(oversized.width, 0, 'a cover over 4096 px is refused');
      assert.equal((await raster.tile(path.join(directory, 'missing.png'), 160, 90)).width, 0);
      const after = await raster.tile(png, 160, 90);
      assert.equal(after.width, 160, 'the child keeps serving after a refusal');
    } finally {
      raster.close();
      fs.rmSync(directory, {recursive: true, force: true});
    }
  }
);

test('weights, letter spacing, glyph fallback and the legend strip', {skip: !pil}, async () => {
  const raster = createRaster();
  try {
    const [medium, bold] = await Promise.all([
      raster.text('Settings', 40, 400, 'left', {weight: 500}),
      raster.text('Settings', 40, 400, 'left', {weight: 700})
    ]);
    assert.ok(ink(bold.bytes) > ink(medium.bytes), 'a heavier weight leaves more ink');
    const lastInk = strip => {
      let last = 0;
      strip.bytes.forEach((byte, i) => byte > 0 && (last = Math.max(last, i % strip.width)));
      return last;
    };
    const [tight, spaced] = await Promise.all([
      raster.text('FRAME RATE', 22, 600),
      raster.text('FRAME RATE', 22, 600, 'left', {tracking: 4})
    ]);
    assert.ok(lastInk(spaced) > lastInk(tight) + 30, 'tracking widens the line');
    const [arrow, box] = await Promise.all([
      raster.text('\u25c0', 40, 100),
      raster.text('\u0378', 40, 100)
    ]);
    assert.ok(ink(arrow.bytes) > 0, 'a glyph the UI font lacks still draws');
    assert.notDeepEqual(arrow.bytes, box.bytes, 'and is not the missing-glyph box');
    const legend = await raster.legend(
      [
        ['A', 'Launch'],
        ['B', 'PCs']
      ],
      26,
      800
    );
    assert.equal(legend.width, 800);
    assert.ok(legend.height >= 36 && legend.height <= 96, 'legend height ' + legend.height);
    assert.equal(lastInk(legend) < 400, true, 'two entries stay on the left');
    assert.ok(ink(legend.bytes) > 500, 'rings and labels left ink');
  } finally {
    raster.close();
  }
});

test('CJK names draw through the CJK fallback', {skip: !pil || !cjk}, async () => {
  const raster = createRaster();
  try {
    const [name, box] = await Promise.all([
      raster.text('\u539f', 40, 100),
      raster.text('\u0378', 40, 100)
    ]);
    assert.ok(ink(name.bytes) > 0, 'the character draws');
    assert.notDeepEqual(name.bytes, box.bytes, 'and is not the missing-glyph box');
    const [medium, bold] = await Promise.all([
      raster.text('\u539f', 40, 100, 'left', {weight: 500}),
      raster.text('\u539f', 40, 100, 'left', {weight: 700})
    ]);
    assert.ok(ink(bold.bytes) > ink(medium.bytes), 'the CJK face follows the weight');
    const light = tile => {
      const mask = [];
      for (let i = 0; i < tile.bytes.length; i += 4) mask.push(tile.bytes[i] > 200 ? 1 : 0);
      return mask;
    };
    const [initials, boxes] = await Promise.all([
      raster.letters('\u539f\u795e', 160, 90),
      raster.letters('\u0378', 160, 90)
    ]);
    assert.ok(light(initials).filter(Boolean).length > 100, 'CJK initials in a light ink');
    assert.notDeepEqual(light(initials), light(boxes), 'not the box');
  } finally {
    raster.close();
  }
});

test('a dead rasteriser rejects what is queued', async () => {
  const {EventEmitter} = require('node:events');
  const {PassThrough} = require('node:stream');
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough()
  });
  const raster = createRaster({spawnProcess: () => child});
  const strip = raster.text('a', 36, 100);
  child.emit('exit', 1, null);
  await assert.rejects(strip, /text.py exited: 1/);
  await assert.rejects(raster.text('b', 36, 100), /exited/);
});

// input-feeder.js
function block(magic, overlay) {
  const bytes = Buffer.alloc(OVERLAY_READ.bytes);
  bytes.writeUInt32LE(magic, 0);
  bytes.writeUInt32LE(overlay, UI.uiOverlay - UI.uiMagic);
  return bytes;
}

test('input stops the frame the overlay goes up, with one release, and resumes when it drops', () => {
  assert.equal(OVERLAY_READ.offset, UI.uiMagic);
  assert.deepEqual(gate(false, block(UI_MAGIC, 0)), {paused: false, release: false});
  assert.deepEqual(gate(false, block(UI_MAGIC, 1)), {paused: true, release: true});
  assert.deepEqual(gate(true, block(UI_MAGIC, 1)), {paused: true, release: false});
  assert.deepEqual(gate(true, block(UI_MAGIC, 0)), {paused: false, release: false});
  assert.deepEqual(
    gate(false, block(0, 1)),
    {paused: false, release: false},
    'no service, no gate'
  );
});

test('the gate reads the newest Moonlight app report for the private storage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hbfeeder-'));
  try {
    assert.equal(readStorage(directory), null);
    fs.writeFileSync(
      path.join(directory, 'app-moonlight-1.json'),
      JSON.stringify({started: '2026-10-26T10:00:00Z', privateStorage: {mapped: 0x1000, bytes: 4}})
    );
    fs.writeFileSync(
      path.join(directory, 'app-moonlight-2.json'),
      JSON.stringify({started: '2026-10-26T11:00:00Z', privateStorage: {mapped: 0x2000, bytes: 4}})
    );
    fs.writeFileSync(
      path.join(directory, 'app-smilebasic-3.json'),
      JSON.stringify({started: '2026-10-26T12:00:00Z', privateStorage: {mapped: 0x3000}})
    );
    assert.deepEqual(readStorage(directory), {mapped: 0x2000, bytes: 4});
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
