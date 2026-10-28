// The HBV1 and HBV2 codecs and the protocol 3 RPC round trip.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const hbv = require('../../../tools/moonlight/hbv.js');
const {psnr} = require('../../../tools/moonlight/reference.js');
const hbv2 = require('../../../tools/moonlight/hbv2.js');
const {
  NativeClient,
  MAX_DATA_BYTES,
  DATA_LENGTH_OFFSET
} = require('../../../../hbl-platform/smilebasic/engine/lib/native.js');
const {
  Connection,
  parseHello
} = require('../../../../hbl-platform/smilebasic/engine/lib/connection.js');
const {attach, defaultAddresses} = require('./fake-console/shared/console.cjs');

// hbv.js
function gradient(width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      rgb[at] = (x * 255) / width;
      rgb[at + 1] = (y * 255) / height;
      rgb[at + 2] = 128;
    }
  return rgb;
}

test('640x352 fits one bridge exchange', () => {
  const map = hbv.layout(640, 352);
  assert.strictEqual(map.slotBytes, hbv.EXCHANGE_BYTES);
  assert.ok(map.payloadBytes <= map.slotBytes);
  assert.strictEqual(map.exchanges, 1);
});

test('field extraction matches across the 32-bit boundary', () => {
  assert.strictEqual(hbv.extract(0xf0000000, 0x3, 28, 6), 0x3f);
  assert.strictEqual(hbv.signExtend(0x3f, 6), -1);
  assert.strictEqual(hbv.signExtend(0x1f, 6), 31);
});

test('slot round trip keeps header, trailer and image', () => {
  const rgb = gradient(64, 48),
    slot = hbv.encode(rgb, 64, 48, 7),
    header = hbv.readHeader(slot);
  assert.strictEqual(header.sequence, 7);
  assert.ok(psnr(rgb, hbv.decode(slot)) > 35);
});

test('torn slot is rejected', () => {
  const slot = hbv.encode(gradient(64, 48), 64, 48, 9);
  slot.writeUInt32LE(10, 4);
  assert.strictEqual(hbv.readHeader(slot), null);
});

test('committed GLSL include matches the generator', () => {
  const fs = require('node:fs'),
    path = require('node:path');
  const file = path.join(__dirname, '../../../apps/moonlight/backends/hblauncher.gpu-app/hbv.glsl');
  if (!fs.existsSync(file)) return;
  assert.strictEqual(fs.readFileSync(file, 'utf8'), hbv.glsl());
});

// hbv2.js
function scene(width, height, shift = 0) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3,
        sx = x + shift;
      rgb[at] = (sx * 3 + y) & 255;
      rgb[at + 1] = ((sx >> 2) ^ (y >> 3)) & 1 ? 230 : 20;
      rgb[at + 2] = Math.round(128 + 100 * Math.sin(sx / 9 + y / 13));
    }
  return rgb;
}

function planePsnr(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return sum ? 10 * Math.log10((255 * 255 * a.length) / sum) : 99;
}

const keyframe = (source, sequence, qp = 8) => hbv2.words(hbv2.encode(source, {sequence, qp}));

test('ue and se round trip through the bit reader', () => {
  const writer = new hbv2.BitWriter(),
    values = [0, 1, 2, 7, 8, 255, 4096, 70000];
  for (const v of values) writer.ue(v);
  for (const v of [0, -1, 1, -300, 300]) writer.se(v);
  writer.put(0x5a, 7);
  const reader = new hbv2.BitReader(writer.words, 0, writer.words.length, 0);
  assert.deepStrictEqual(
    values.map(() => reader.ue()),
    values
  );
  assert.deepStrictEqual(
    [0, -1, 1, -300, 300].map(() => reader.se()),
    [0, -1, 1, -300, 300]
  );
  assert.strictEqual(reader.bits(7), 0x5a);
});

test('integer IDCT inverts the forward DCT within rounding', () => {
  const pixels = Float64Array.from({length: 64}, (_, i) => ((i * 37) % 255) - 128);
  const coefficients = Int32Array.from(hbv2.forwardDct(pixels), Math.round),
    out = new Int32Array(64);
  hbv2.idct(coefficients, out);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(out[i] - pixels[i]) <= 1);
});

test('entries pack chunk index and bit offset; header and trailer agree', () => {
  const source = hbv2.toFrame(scene(320, 176), 320, 176),
    words = keyframe(source, 5),
    header = hbv2.readHeader(words);
  assert.strictEqual(header.kind, 2);
  assert.strictEqual(header.reference, 0);
  assert.strictEqual(header.count, hbv2.layout(320, 176).chunks);
  assert.strictEqual(words[hbv2.HEADER_WORDS] & (hbv2.MAX_CHUNKS - 1), 0);
  assert.strictEqual(words[hbv2.HEADER_WORDS] >>> hbv2.CHUNK_INDEX_BITS, 0);
  assert.strictEqual(words[header.trailer], 5);
  assert.strictEqual(words.length % (hbv2.EXCHANGE_BYTES / 4), 0);
});

test('keyframe decodes close to the source', () => {
  const source = hbv2.toFrame(scene(320, 176), 320, 176),
    decoder = new hbv2.Decoder();
  assert.strictEqual(decoder.step([keyframe(source, 1, 4)]), 1);
  assert.ok(planePsnr(source.y, decoder.frame.y) > 40);
  assert.strictEqual(decoder.applied, 1);
});

test('torn slot is rejected', () => {
  const words = keyframe(hbv2.toFrame(scene(64, 48), 64, 48), 9);
  words[words.length - 1] = 8;
  assert.strictEqual(hbv2.readHeader(words), null);
  assert.strictEqual(new hbv2.Decoder().step([words]), 0);
});

test('apply refuses a slot that is not newer than the applied one', () => {
  const words = keyframe(hbv2.toFrame(scene(64, 48), 64, 48), 1),
    decoder = new hbv2.Decoder();
  decoder.apply(words);
  assert.throws(() => decoder.apply(words), /Slot is not eligible/);
  assert.strictEqual(decoder.applied, 1);
});

test('P frames apply in order and only on their reference', () => {
  const first = hbv2.toFrame(scene(320, 176), 320, 176),
    moved = hbv2.toFrame(scene(320, 176, 3), 320, 176),
    plan = () => ({mode: 'inter', mvx: 3, mvy: 0});
  const key = keyframe(first, 1, 4);
  const decoder = new hbv2.Decoder();
  decoder.step([key]);
  const reference = decoder.frame;
  const p2 = hbv2.words(
    hbv2.encode(moved, {sequence: 2, reference, referenceSequence: 1, qp: 8, plan})
  );
  const p3 = hbv2.words(
    hbv2.encode(moved, {sequence: 3, reference, referenceSequence: 2, qp: 8, plan})
  );
  const stray = hbv2.words(
    hbv2.encode(moved, {sequence: 4, reference, referenceSequence: 7, qp: 8, plan})
  );
  assert.strictEqual(decoder.pick([p3, stray, p2]), 2);
  assert.strictEqual(decoder.step([p3, stray, p2], 1), 1);
  assert.ok(planePsnr(moved.y, decoder.frame.y) > 35);
  assert.strictEqual(decoder.step([p3, stray, p2]), 1);
  assert.strictEqual(decoder.applied, 3);
  const fresh = new hbv2.Decoder();
  assert.strictEqual(fresh.step([p2, p3]), 0);
});

test('a newer keyframe wins over the P chain', () => {
  const source = hbv2.toFrame(scene(64, 48), 64, 48),
    decoder = new hbv2.Decoder();
  decoder.step([keyframe(source, 1)]);
  const p = hbv2.words(
    hbv2.encode(source, {
      sequence: 2,
      reference: decoder.frame,
      referenceSequence: 1,
      qp: 8,
      plan: () => ({mode: 'skip'})
    })
  );
  assert.strictEqual(decoder.pick([p, keyframe(source, 3)]), 1);
  assert.strictEqual(decoder.pick([p, keyframe(source, 2)]), 0);
});

test('skipped macroblocks are copied lazily from the previous frame', () => {
  const a = hbv2.toFrame(scene(64, 48), 64, 48),
    b = hbv2.toFrame(scene(64, 48, 5), 64, 48),
    decoder = new hbv2.Decoder();
  decoder.step([keyframe(a, 1, 4)]);
  const kept = Uint8Array.from(decoder.frame.y);
  const recode = mb => (mb === 0 ? {mode: 'intra'} : {mode: 'skip'});
  const p = sequence =>
    hbv2.words(
      hbv2.encode(b, {
        sequence,
        reference: decoder.frame,
        referenceSequence: sequence - 1,
        qp: 4,
        plan: recode
      })
    );
  decoder.step([p(2)]);
  decoder.step([p(3)]);
  const y = decoder.frame.y;
  for (let row = 0; row < 48; row++)
    for (let x = 16; x < 64; x++) assert.strictEqual(y[row * 64 + x], kept[row * 64 + x]);
});

test('generated tables match the checked-in shader header', () => {
  const here = path.join(__dirname, '../../../tools/moonlight'),
    shaders = path.join(here, '../../apps/moonlight/backends/hblauncher.gpu-app');
  const glsl = path.join(shaders, 'hbv2-tables.glsl');
  if (fs.existsSync(glsl)) assert.strictEqual(fs.readFileSync(glsl, 'utf8'), hbv2.glslTables());
});

// Round-trips the real host RPC code (native.cjs over a TCP Connection) against
// the byte-level fake console (fake-console/shared/console.cjs) for console
// protocols 1, 2 and 3, over a loopback socket. Proves small writes still work
// on every protocol, a 200 KiB write lands byte-exact in one protocol-3
// exchange, short reads work, and the data-length cap is enforced.
const TOKEN = [1, 2, 3, 4];
const ADDRESSES = defaultAddresses();
const TARGET = ADDRESSES.scratch + 0x80000;
const SOURCE = ADDRESSES.scratch + 0x90000;

// Bring up a loopback link: the server end runs the fake console, the client end
// is wrapped in the real Connection and driven by a real NativeClient.
function link(protocol) {
  return new Promise((resolve, reject) => {
    let fake, serverSocket;
    const server = net.createServer(socket => {
      socket.on('error', () => {});
      serverSocket = socket;
      fake = attach(socket, {protocol, token: TOKEN, addresses: ADDRESSES});
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const client = net.connect(server.address().port, '127.0.0.1');
      client.on('error', () => {});
      const connection = new Connection(client, 5000);
      connection
        .read(128)
        .then(bytes => {
          const addresses = parseHello(bytes, TOKEN);
          const native = new NativeClient(connection, addresses);
          const cleanup = async () => {
            try {
              await native.stop();
            } catch {}
            serverSocket?.destroy();
            server.close();
          };
          resolve({native, addresses, fake, cleanup});
        })
        .catch(reject);
    });
  });
}

test('small writes round-trip on protocol 1, 2 and 3', async () => {
  for (const protocol of [1, 2, 3]) {
    const {native, addresses, fake, cleanup} = await link(protocol);
    assert.equal(addresses.protocol, protocol);
    const payload = crypto.randomBytes(0x1000);
    await native.write(TARGET, payload);
    assert.ok(fake.slice(TARGET, payload.length).equals(payload), `protocol ${protocol} write`);
    await cleanup();
  }
});

test('a 200 KiB protocol-3 write arrives byte-exact in one exchange', async () => {
  const {native, fake, cleanup} = await link(3);
  const big = crypto.randomBytes(200 * 1024);
  assert.ok(big.length < MAX_DATA_BYTES);
  await native.guard(TARGET, big.length, 2); // warm the region cache (one query)
  const exchanges = fake.exchanges;
  const memmoves = fake.memmoves;
  await native.write(TARGET, big);
  assert.equal(fake.exchanges - exchanges, 1, 'one exchange carried the whole write');
  assert.equal(fake.memmoves - memmoves, 1, 'one memmove carried the whole write');
  assert.ok(fake.slice(TARGET, big.length).equals(big));
  await cleanup();
});

test('combined writes call the qualified consumer after copying data in one exchange', async () => {
  for (const protocol of [1, 2, 3]) {
    const {native, addresses, fake, cleanup} = await link(protocol);
    try {
      const target = addresses.sdk + 0x586fb0;
      const payload = crypto.randomBytes(4096);
      await native.guard(TARGET, payload.length, 2);
      const exchanges = fake.exchanges;
      await assert.rejects(
        native.writeAndCall(TARGET, payload, target, [SOURCE, TARGET, payload.length]),
        /not been verified/
      );
      assert.equal(fake.exchanges, exchanges);
      native.functions.add(target);
      const reply = await native.writeAndCall(TARGET, payload, target, [
        SOURCE,
        TARGET,
        payload.length
      ]);
      assert.equal(reply.result, BigInt(SOURCE));
      assert.equal(fake.exchanges - exchanges, 1);
      assert.ok(fake.slice(SOURCE, payload.length).equals(payload));
      await assert.rejects(native.writeAndCall(TARGET, Buffer.alloc(32769), target, []), /32768/);
    } finally {
      await cleanup();
    }
  }
});

test('the same write needs many exchanges on protocol 2', async () => {
  const {native, fake, cleanup} = await link(2);
  const big = crypto.randomBytes(200 * 1024);
  await native.guard(TARGET, big.length, 2);
  const memmoves = fake.memmoves;
  await native.write(TARGET, big);
  assert.equal(fake.memmoves - memmoves, Math.ceil(big.length / 0x8000));
  assert.ok(fake.slice(TARGET, big.length).equals(big));
  await cleanup();
});

test('HB_WRITE_CHUNK caps the per-exchange size on protocol 3', async () => {
  const {native, fake, cleanup} = await link(3);
  const big = crypto.randomBytes(200 * 1024);
  await native.guard(TARGET, big.length, 2);
  const previous = process.env.HB_WRITE_CHUNK;
  process.env.HB_WRITE_CHUNK = '32768';
  try {
    const memmoves = fake.memmoves;
    await native.write(TARGET, big);
    assert.equal(fake.memmoves - memmoves, Math.ceil(big.length / 0x8000));
    assert.ok(fake.slice(TARGET, big.length).equals(big));
  } finally {
    if (previous === undefined) delete process.env.HB_WRITE_CHUNK;
    else process.env.HB_WRITE_CHUNK = previous;
  }
  await cleanup();
});

test('short reads work on protocol 2 and 3', async () => {
  for (const protocol of [2, 3]) {
    const {native, fake, cleanup} = await link(protocol);
    const pattern = crypto.randomBytes(300);
    pattern.copy(fake.slice(SOURCE, pattern.length));
    const got = await native.read(SOURCE, pattern.length);
    assert.ok(got.equals(pattern), `protocol ${protocol} read`);
    await cleanup();
  }
});

test('the protocol-3 data-length cap is enforced', async () => {
  const {native, cleanup} = await link(3);
  await assert.rejects(
    native.exchange(
      [{offset: 0x5872f0, args: [TARGET, ADDRESSES.scratch + 0x40080, MAX_DATA_BYTES + 1, 0]}],
      Buffer.alloc(MAX_DATA_BYTES + 1)
    ),
    /Invalid native request/
  );
  await cleanup();
});

// The host rejects before sending, so exercise the console's own cap directly:
// a raw header claiming more than the cap must make the model close the link.
test('the console closes on an over-cap data length', async () => {
  await new Promise((resolve, reject) => {
    const server = net.createServer(socket => {
      socket.on('error', () => {});
      attach(socket, {protocol: 3, token: TOKEN, addresses: ADDRESSES});
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const client = net.connect(server.address().port, '127.0.0.1');
      client.on('error', () => {});
      client.on('data', () => {}); // drain the hello so the FIN closes the socket
      const guard = setTimeout(() => {
        client.destroy();
        server.close();
        reject(Error('console did not close on an over-cap length'));
      }, 2000);
      client.once('close', () => {
        clearTimeout(guard);
        server.close();
        resolve();
      });
      client.once('connect', () => {
        const header = Buffer.alloc(128);
        header.writeBigUInt64LE(BigInt(ADDRESSES.sdk + 0x5872f0), 0); // non-sentinel
        header.writeUInt32LE(MAX_DATA_BYTES + 1, DATA_LENGTH_OFFSET);
        client.write(header);
      });
    });
  });
});

test('protocol 2 still rejects data over 0x8000', async () => {
  const {native, cleanup} = await link(2);
  await assert.rejects(
    native.exchange(
      [{offset: 0x5872f0, args: [TARGET, ADDRESSES.scratch + 0x40080, 0x8001, 0]}],
      Buffer.alloc(0x8001)
    ),
    /Invalid native request/
  );
  await cleanup();
});
