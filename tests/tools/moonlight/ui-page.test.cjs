const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../../host/ui/page.js');
const ring = () => import('../../../tools/moonlight/ring.js');

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
