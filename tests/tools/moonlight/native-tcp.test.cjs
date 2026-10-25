const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const definitions = require('../../sdk/native/socket-functions.json');
const {create, endpoint} = require('./native-tcp.cjs');

const SDK = 0x40000000;
const BASE = 0x60000000;

test('native TCP setup verifies the socket API and authenticates a separate connection', async () => {
  const verified = [];
  const calls = [];
  const written = [];
  const server = new EventEmitter();
  server.listen = (port, host, callback) => {
    assert.equal(port, 0);
    assert.equal(host, '192.0.2.10');
    callback();
  };
  server.address = () => ({port: 42123});
  server.close = () => calls.push('server-close');
  const candidate = new EventEmitter();
  candidate.destroyed = false;
  candidate.pause = () => calls.push('pause');
  candidate.setNoDelay = enabled => assert.equal(enabled, true);
  candidate.destroy = () => {
    candidate.destroyed = true;
  };
  candidate.write = (bytes, callback) => {
    written.push(Buffer.from(bytes));
    callback();
  };
  let addressBlock;
  const rpc = {
    a: {sdk: SDK},
    output: 0x20000000,
    async request(request) {
      assert.equal(request.command, 'verify-function');
      verified.push(request.address);
      return {verified: true};
    },
    async call() {
      const output = Buffer.alloc(8);
      output.writeBigUInt64LE(BigInt(BASE));
      return {result: 0n, output};
    },
    async callAddress(address, args) {
      calls.push(address);
      if (address === SDK + definitions.socketInitialized.offset) return {result: 1n};
      if (address === SDK + definitions.socket.offset) return {result: 7n};
      if (address === SDK + definitions.socketClose.offset) {
        assert.equal(args[0], 7);
        return {result: 0n};
      }
      if (address === SDK + definitions.errno.offset) return {result: 0n};
      throw Error('Unexpected direct socket call');
    },
    async write(address, bytes) {
      assert.equal(address, BASE);
      addressBlock = Buffer.from(bytes);
    }
  };
  const transport = await create({
    rpc,
    host: '192.0.2.10',
    createServer: () => server,
    makeToken: () => Buffer.alloc(16, 0x5a),
    createWorker: async () => ({
      async run([call]) {
        if (call.function === SDK + definitions.connect.offset) {
          assert.deepEqual(call.args, [7, BASE, 16, 0]);
          server.emit('connection', candidate);
          return [0n];
        }
        assert.equal(call.function, SDK + definitions.send.offset);
        const [fd, address, remaining] = call.args;
        assert.equal(fd, 7);
        const count = Math.min(8, remaining);
        candidate.emit('data', addressBlock.subarray(address - BASE, address - BASE + count));
        return [BigInt(count)];
      }
    })
  });
  assert.equal(transport.fd, 7);
  assert.equal(transport.port, 42123);
  assert.equal(transport.recvFunction, SDK + definitions.recv.offset);
  assert.equal(transport.maxAccessUnit, 0x100000);
  assert.equal(addressBlock.readUInt16BE(2), 42123);
  assert.deepEqual([...addressBlock.subarray(4, 8)], [192, 0, 2, 10]);
  assert.equal(verified.length, Object.keys(definitions).length);
  await transport.send(Buffer.from([1, 2, 3]));
  assert.deepEqual(written, [Buffer.from([1, 2, 3])]);
  await transport.close();
  assert.equal(candidate.destroyed, true);
  assert.equal(calls.filter(call => call === SDK + definitions.socketClose.offset).length, 1);
});

test('native TCP rejects invalid endpoints before opening a listener', () => {
  assert.deepEqual(endpoint('192.0.2.10', 0), {host: '192.0.2.10', port: 0});
  assert.throws(() => endpoint('not-an-address', 0), /IPv4/);
  assert.throws(() => endpoint('192.0.2.10', 65536), /port/);
});
