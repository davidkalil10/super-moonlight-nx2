const net = require('node:net');
const crypto = require('node:crypto');
const {allocate} = require('../../sdk/native/allocate.cjs');
const {verify} = require('../../sdk/native/symbols.cjs');
const {create: createFinite} = require('../../sdk/native/finite.cjs');
const definitions = require('../../sdk/native/socket-functions.json');

const MAX_ACCESS_UNIT = 0x100000;
const SHORT = 2;
const signed = value => Number(BigInt.asIntN(32, value));

function endpoint(host, port) {
  if (!net.isIPv4(host) || !Number.isInteger(port) || port < 0 || port > 65535)
    throw Error('Native TCP requires an IPv4 address and valid port');
  return {host, port};
}

async function create({
  rpc,
  host,
  port = 0,
  timeoutMs = 5000,
  createServer = net.createServer,
  makeToken = () => crypto.randomBytes(16),
  createWorker = createFinite
}) {
  endpoint(host, port);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw Error('Invalid native TCP setup timeout');
  const token = makeToken();
  if (!Buffer.isBuffer(token) || token.length !== 16) throw Error('Invalid native TCP token');
  const server = createServer();
  let socket = null;
  let fd = null;
  let safeToClose = true;
  let closed = false;
  let listening = false;
  const closeServer = () => {
    if (!listening) return;
    listening = false;
    server.close();
  };
  let acceptResolve;
  let acceptReject;
  const accepted = new Promise((resolve, reject) => {
    acceptResolve = resolve;
    acceptReject = reject;
  });
  accepted.catch(() => {});
  const timer = setTimeout(() => acceptReject(Error('Native TCP connection timed out')), timeoutMs);
  server.on('error', acceptReject);
  server.on('connection', candidate => {
    const received = Buffer.alloc(token.length);
    let used = 0;
    candidate.on('error', () => {});
    candidate.on('data', chunk => {
      if (used + chunk.length > token.length) {
        candidate.destroy();
        return;
      }
      chunk.copy(received, used);
      used += chunk.length;
      if (used < token.length) return;
      candidate.pause();
      if (!crypto.timingSafeEqual(received, token) || socket) {
        candidate.destroy();
        return;
      }
      socket = candidate;
      socket.setNoDelay(true);
      clearTimeout(timer);
      acceptResolve(socket);
      closeServer();
    });
  });
  const addresses = {};
  const call = async (name, args = []) =>
    (await rpc.callAddress(addresses[name], args, SHORT)).result;
  const errno = async () => Number(BigInt.asUintN(32, await call('errno')));
  let base = null;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        listening = true;
        resolve();
      });
    });
    for (const [name, definition] of Object.entries(definitions)) {
      const address = rpc.a.sdk + definition.offset;
      await verify(rpc, address, definition.hex);
      addresses[name] = address;
    }
    if (signed(await call('socketInitialized')) !== 1)
      throw Error('Console sockets are not initialized');
    base = await allocate(rpc, 0x1000, {
      failed: 'Native TCP address allocation failed',
      invalid: 'Invalid native TCP address allocation'
    });
    const listeningPort = server.address().port;
    if (!Number.isInteger(listeningPort) || listeningPort < 1024 || listeningPort > 65535)
      throw Error('Native TCP listener has no usable port');
    const address = Buffer.alloc(0x30);
    address[0] = 16;
    address[1] = 2;
    address.writeUInt16BE(listeningPort, 2);
    host.split('.').forEach((part, index) => {
      address[4 + index] = Number(part);
    });
    token.copy(address, 0x20);
    await rpc.write(base, address);
    fd = signed(await call('socket', [2, 1, 6]));
    if (fd < 0) throw Error('Console TCP socket failed (errno ' + (await errno()) + ')');
    const worker = await createWorker(rpc);
    safeToClose = false;
    const [connected] = await worker.run([{function: addresses.connect, args: [fd, base, 16, 0]}]);
    safeToClose = true;
    if (signed(connected) !== 0)
      throw Error('Console TCP connect failed (errno ' + (await errno()) + ')');
    let sent = 0;
    while (sent < token.length) {
      safeToClose = false;
      const [result] = await worker.run([
        {function: addresses.send, args: [fd, base + 0x20 + sent, token.length - sent, 0]}
      ]);
      safeToClose = true;
      const count = signed(result);
      if (count <= 0 || count > token.length - sent)
        throw Error('Console TCP token send failed (errno ' + (await errno()) + ')');
      sent += count;
    }
    await accepted;
    return {
      fd,
      port: listeningPort,
      maxAccessUnit: MAX_ACCESS_UNIT,
      recvFunction: addresses.recv,
      async send(bytes) {
        if (closed || !socket || socket.destroyed) throw Error('Native TCP data socket is closed');
        if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_ACCESS_UNIT)
          throw Error('Native TCP access unit exceeds the limit');
        await new Promise((resolve, reject) => {
          socket.write(bytes, error => (error ? reject(error) : resolve()));
        });
      },
      abort() {
        socket?.destroy();
        closeServer();
      },
      async close() {
        if (closed) return;
        closed = true;
        socket?.destroy();
        closeServer();
        if (signed(await call('socketClose', [fd])) < 0)
          throw Error('Console TCP close failed (errno ' + (await errno()) + ')');
      }
    };
  } catch (error) {
    clearTimeout(timer);
    socket?.destroy();
    closeServer();
    if (fd !== null && safeToClose) await call('socketClose', [fd]).catch(() => {});
    throw error;
  }
}

module.exports = {create, endpoint, MAX_ACCESS_UNIT};
