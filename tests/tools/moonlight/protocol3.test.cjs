// Round-trips the real host RPC code (native.cjs over a TCP Connection) against
// the byte-level fake console (fake-console/shared/console.cjs) for console
// protocols 1, 2 and 3, over a loopback socket. Proves small writes still work
// on every protocol, a 200 KiB write lands byte-exact in one protocol-3
// exchange, short reads work, and the data-length cap is enforced.
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');

const {
  NativeClient,
  MAX_DATA_BYTES,
  DATA_LENGTH_OFFSET
} = require('../../smilebasic/engine/lib/native.cjs');
const {Connection, parseHello} = require('../../smilebasic/engine/lib/connection.cjs');
const {attach, defaultAddresses} = require('./fake-console/shared/console.cjs');

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
