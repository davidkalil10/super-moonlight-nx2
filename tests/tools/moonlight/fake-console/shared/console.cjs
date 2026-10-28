// Byte-level model of the bootstrap RPC() loop (smilebasic/bootstrap.bas), used
// to round-trip the real host (native.cjs over a TCP Connection) offline. It is
// not the timing sim in rpc.cjs; it parses actual request packets and mirrors
// the loop statement for statement:
//   protocol 1   single 0x8080 recv, response always 0x8000 bytes of output
//   protocol 2   single 0x8080 recv, honor the u16 response length at byte 80
//   protocol 3   two-phase recv: 0x80 header (data length u32 at byte 88, cap
//                0x3f000), then D data bytes into the request data region
// A flat memory buffer backs scratch and the app region. The loop dispatches the
// three SDK calls the host uses: memmove (0x5872f0), a memory read into the
// output area (0x586fb0), and QueryMemory (0x158314) so guard() is answered.
const {
  DATA_OFFSET,
  RESPONSE_LENGTH_OFFSET,
  DATA_LENGTH_OFFSET,
  MAX_DATA_BYTES,
  OUTPUT_BYTES
} = require('../../../../../../hbl-platform/smilebasic/engine/lib/native.js');

const MAGIC = 0x31545344;
const INPUT_OFFSET = 0x40000;
const OUTPUT_OFFSET = 0x4040;
const RESPONSE_OFFSET = 0x4030;
const MEMMOVE = 0x5872f0;
const MEMREAD = 0x586fb0;
const QUERY = 0x158314;

// Addresses satisfying every parseHello check; main/sdk 4096-aligned, scratch
// 16-aligned, got = main + 0x9c92f0, memmove = sdk + 0x5872f0. The flat memory
// starts at scratch, so the app write/read target lives just past scratch.
function defaultAddresses() {
  const main = 0x10000000;
  const sdk = 0x20000000;
  const scratch = 0x30000000;
  return {
    scratch,
    scratchBytes: 0x80000,
    main,
    sdk,
    got: main + 0x9c92f0,
    memmove: sdk + 0x5872f0,
    backing: 0x40000000,
    controller: 0x40001000
  };
}

function helloPacket(addresses, token, protocol) {
  const words = [
    MAGIC,
    protocol,
    2,
    addresses.scratch,
    addresses.scratchBytes,
    addresses.main,
    addresses.sdk,
    addresses.got,
    addresses.memmove,
    addresses.backing,
    addresses.controller,
    token[0],
    token[1],
    token[2],
    token[3],
    3925528160
  ];
  const bytes = Buffer.alloc(128);
  words.forEach((value, index) => bytes.writeBigUInt64LE(BigInt(value), index * 8));
  return bytes;
}

class FakeConsole {
  constructor(options = {}) {
    this.protocol = options.protocol ?? 3;
    this.addresses = options.addresses ?? defaultAddresses();
    this.token = options.token ?? [1, 2, 3, 4];
    this.base = this.addresses.scratch;
    this.memory = Buffer.alloc(options.memoryBytes ?? 0x100000);
    this.exchanges = 0;
    this.memmoves = 0;
    this.reads = 0;
    this.queries = 0;
  }

  slice(address, length) {
    const start = address - this.base;
    if (start < 0 || start + length > this.memory.length)
      throw Error('Console memory access out of range');
    return this.memory.subarray(start, start + length);
  }

  // Mirror one RAW# dispatch of a 40-byte call record and return its SVC result.
  run(record) {
    const func = Number(record.readBigUInt64LE(0) - BigInt(this.addresses.sdk));
    const a0 = Number(record.readBigUInt64LE(8));
    const a1 = Number(record.readBigUInt64LE(16));
    const a2 = Number(record.readBigUInt64LE(24));
    if (func === MEMMOVE) {
      if (a2) this.memmoves++;
      this.slice(a1, a2).copy(this.slice(a0, a2));
      return BigInt(a0);
    }
    if (func === MEMREAD) {
      this.reads++;
      this.slice(a1, a2).copy(this.slice(a0, a2));
      return BigInt(a0);
    }
    if (func === QUERY) {
      this.queries++;
      const info = this.slice(a0, 40);
      info.fill(0);
      info.writeBigUInt64LE(BigInt(this.base), 0);
      info.writeBigUInt64LE(BigInt(this.memory.length), 8);
      info.writeUInt32LE(3, 16);
      info.writeUInt32LE(3, 24);
      return 0n;
    }
    throw Error('Console received an unknown SDK call 0x' + func.toString(16));
  }

  // The all-zero first call record is the stop sentinel; the loop checks it
  // before recving data, just as bootstrap.bas does.
  isStop(header) {
    return header.subarray(0, 40).every(byte => byte === 0);
  }

  // Serve one request: land it in memory, dispatch both records, send 16 + N
  // bytes (second call result, first call result, then the output area).
  serve(header, data) {
    header.copy(this.slice(this.addresses.scratch + INPUT_OFFSET, header.length));
    if (data.length)
      data.copy(this.slice(this.addresses.scratch + INPUT_OFFSET + DATA_OFFSET, data.length));
    const request = this.slice(this.addresses.scratch + INPUT_OFFSET, 128);
    let n = request.readUInt16LE(RESPONSE_LENGTH_OFFSET);
    if (n < 1 || n > OUTPUT_BYTES) n = OUTPUT_BYTES;
    const first = this.run(request.subarray(0, 40));
    const second = this.run(request.subarray(40, 80));
    const response = Buffer.alloc(16 + n);
    response.writeBigUInt64LE(second, 0);
    response.writeBigUInt64LE(first, 8);
    this.slice(this.addresses.scratch + OUTPUT_OFFSET, n).copy(response, 16);
    this.exchanges++;
    return response;
  }
}

// Drive a FakeConsole over a connected socket: send the hello, then loop reading
// framed requests and writing responses until the stop sentinel or a disconnect.
function attach(socket, options) {
  const fake = new FakeConsole(options);
  let buffer = Buffer.alloc(0);
  const waiters = [];
  const want = size =>
    new Promise((resolve, reject) => {
      waiters.push({size, resolve, reject});
      pump();
    });
  function pump() {
    while (waiters.length && buffer.length >= waiters[0].size) {
      const waiter = waiters.shift();
      waiter.resolve(buffer.subarray(0, waiter.size));
      buffer = buffer.subarray(waiter.size);
    }
  }
  socket.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    pump();
  });
  const stop = error => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  socket.on('error', () => stop(Error('link error')));
  socket.on('end', () => stop(Error('link ended')));
  socket.write(helloPacket(fake.addresses, fake.token, fake.protocol));
  (async () => {
    try {
      while (true) {
        let header, data;
        if (fake.protocol >= 3) {
          header = Buffer.from(await want(DATA_OFFSET));
          if (fake.isStop(header)) break;
          const length = header.readUInt32LE(DATA_LENGTH_OFFSET);
          if (length > MAX_DATA_BYTES) break;
          data = length ? Buffer.from(await want(length)) : Buffer.alloc(0);
        } else {
          const packet = await want(DATA_OFFSET + OUTPUT_BYTES);
          header = Buffer.from(packet.subarray(0, DATA_OFFSET));
          if (fake.isStop(header)) break;
          data = Buffer.from(packet.subarray(DATA_OFFSET));
        }
        socket.write(fake.serve(header, data));
      }
    } catch (error) {
      if (!socket.destroyed) socket.destroy(error);
      return;
    }
    socket.end();
  })();
  return fake;
}

module.exports = {FakeConsole, attach, helloPacket, defaultAddresses};
