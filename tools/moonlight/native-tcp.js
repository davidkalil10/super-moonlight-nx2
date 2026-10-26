/**
 * A TCP connection from the console back to the host, for streaming data straight into
 * console memory with nn::socket calls instead of bridge writes.
 *
 * create() listens on the host, verifies the console's socket functions and writes a
 * sockaddr_in plus a random token into a console allocation. The console then opens a
 * socket, connects and sends the token with finite native jobs. The host accepts only the
 * connection that presents the token, so a stray client cannot take the data path.
 *
 * While a connect or send job may still be running on the console, the socket is not
 * closed on failure: the job could otherwise touch a reused descriptor.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import {allocate} from '../../../hbl-platform/sdk/native/allocate.js';
import {verify} from '../../../hbl-platform/sdk/native/symbols.js';
import {create as createFinite} from '../../../hbl-platform/sdk/native/finite.js';
import definitions from '../../../hbl-platform/sdk/native/socket-functions.json' with {type: 'json'};

/** Largest access unit send() accepts. */
const MAX_ACCESS_UNIT = 0x100000;
const SHORT_RESPONSE_BYTES = 2;
const TOKEN_BYTES = 16;
const MAX_PORT = 65535;
/** The listener must sit on an unprivileged port the console can reach. */
const MIN_LISTENING_PORT = 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 60000;
const SCRATCH_BYTES = 0x1000;

/**
 * The console scratch block: a BSD sockaddr_in (length, family, big-endian port, IPv4
 * address) at 0, and the token at TOKEN_OFFSET.
 */
const ADDRESS_BLOCK_BYTES = 0x30;
const SOCKADDR_BYTES = 16;
const SOCKADDR_FAMILY_OFFSET = 1;
const SOCKADDR_PORT_OFFSET = 2;
const SOCKADDR_ADDRESS_OFFSET = 4;
const TOKEN_OFFSET = 0x20;

const AF_INET = 2;
const SOCK_STREAM = 1;
const IPPROTO_TCP = 6;

/** @param {bigint} value */
const signed = value => Number(BigInt.asIntN(32, value));

/**
 * @param {string} host
 * @param {number} port
 * @returns {{host: string, port: number}}
 */
function endpoint(host, port) {
  if (!net.isIPv4(host) || !Number.isInteger(port) || port < 0 || port > MAX_PORT)
    throw Error('Native TCP requires an IPv4 address and valid port');
  return {host, port};
}

/**
 * The sockaddr_in the console connects to, with the token after it.
 * @param {string} host
 * @param {number} port
 * @param {Buffer} token
 */
function addressBlock(host, port, token) {
  const block = Buffer.alloc(ADDRESS_BLOCK_BYTES);
  block[0] = SOCKADDR_BYTES;
  block[SOCKADDR_FAMILY_OFFSET] = AF_INET;
  block.writeUInt16BE(port, SOCKADDR_PORT_OFFSET);
  host.split('.').forEach((part, index) => {
    block[SOCKADDR_ADDRESS_OFFSET + index] = Number(part);
  });
  token.copy(block, TOKEN_OFFSET);
  return block;
}

/**
 * @typedef {object} NativeTcp
 * @property {number} fd The console socket descriptor.
 * @property {number} port The host listening port.
 * @property {number} maxAccessUnit
 * @property {number} recvFunction Address of nn::socket::Recv, for console workers.
 * @property {(bytes: Buffer) => Promise<void>} send Writes to the authenticated connection.
 * @property {() => void} abort Drops the host side without touching the console.
 * @property {() => Promise<void>} close
 */

/**
 * @param {object} options
 * @param {import('../../../hbl-platform/sdk/native/allocate.js').Rpc} options.rpc
 * @param {string} options.host The host IPv4 address the console connects to.
 * @param {number} [options.port] 0 picks a free port.
 * @param {number} [options.timeoutMs] How long to wait for the authenticated connection.
 * @param {typeof net.createServer} [options.createServer]
 * @param {() => Buffer} [options.makeToken]
 * @param {typeof createFinite} [options.createWorker]
 * @returns {Promise<NativeTcp>}
 */
async function create({
  rpc,
  host,
  port = 0,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createServer = net.createServer,
  makeToken = () => crypto.randomBytes(TOKEN_BYTES),
  createWorker = createFinite
}) {
  endpoint(host, port);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
    throw Error('Invalid native TCP setup timeout');
  const token = makeToken();
  if (!Buffer.isBuffer(token) || token.length !== TOKEN_BYTES)
    throw Error('Invalid native TCP token');
  const server = createServer();
  /** @type {net.Socket | null} */
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

  /** @type {Record<string, number>} */
  const addresses = {};
  const call = async (name, args = []) =>
    (await rpc.callAddress(addresses[name], args, SHORT_RESPONSE_BYTES)).result;
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
    base = await allocate(rpc, SCRATCH_BYTES, {
      failed: 'Native TCP address allocation failed',
      invalid: 'Invalid native TCP address allocation'
    });
    const listeningPort = /** @type {net.AddressInfo} */ (server.address()).port;
    if (
      !Number.isInteger(listeningPort) ||
      listeningPort < MIN_LISTENING_PORT ||
      listeningPort > MAX_PORT
    )
      throw Error('Native TCP listener has no usable port');
    await rpc.write(base, addressBlock(host, listeningPort, token));
    fd = signed(await call('socket', [AF_INET, SOCK_STREAM, IPPROTO_TCP]));
    if (fd < 0) throw Error('Console TCP socket failed (errno ' + (await errno()) + ')');
    const worker = await createWorker(rpc);
    safeToClose = false;
    const [connected] = await worker.run([
      {function: addresses.connect, args: [fd, base, SOCKADDR_BYTES, 0]}
    ]);
    safeToClose = true;
    if (signed(connected) !== 0)
      throw Error('Console TCP connect failed (errno ' + (await errno()) + ')');
    let sent = 0;
    while (sent < token.length) {
      safeToClose = false;
      const [result] = await worker.run([
        {
          function: addresses.send,
          args: [fd, base + TOKEN_OFFSET + sent, token.length - sent, 0]
        }
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

export {create, endpoint, MAX_ACCESS_UNIT};
