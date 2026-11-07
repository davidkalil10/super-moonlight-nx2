import dgram from 'node:dgram';
import crypto from 'node:crypto';

/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */
/** @import {Civ7Rpc} from './transport.js' */
/** @import {ReceiveBufferRequest, ReceiveBufferReport} from './socket-options.js' */

/** The probe's datagrams and hello (little-endian): civ7/README.md, "UDP probe". */
export const UDP_PROBE = {magic: 0x31504455, helloMagic: 0x48504455, payloadBytes: 1400, headerBytes: 20,
  endFlag: 1, bufferBytes: 0x12000, reportOffset: 0x40};

/**
 * Console side, shipped by payload.js: opens a UDP socket to the PC, sends a hello until the
 * first datagram arrives, then drains datagrams until the end marker or a second of silence and
 * returns histograms of what it saw. `request.buffer` holds UDP_PROBE.bufferBytes.
 * @param {Pick<ConsoleNative, 'address' | 'integer' | 'checkMemory' | 'verified' | 'call' | 'socket' |
 *   'connect' | 'receive' | 'send' | 'close' | 'writeBuffer' | 'readMemory' | 'read32' | 'encode'> & {
 *   now: () => number, setReceiveBuffer?: typeof import('./socket-options.js').setReceiveBuffer}} native
 * @param {ConsoleRequest} request
 */
export function udpProbe(native, request) {
  const {address, integer, checkMemory, verified, call, socket, connect, receive, send, close,
    writeBuffer, readMemory, encode, now} = native;
  const magic = 0x31504455;
  const helloMagic = 0x48504455;
  const slotCount = 32;
  const slotBytes = 2048;
  const vectorOffset = 0x1000;
  const iovOffset = 0x1800;
  const slotsOffset = 0x2000;
  const nonBlocking = 0x80;

  if (typeof request.host !== 'string' || typeof request.token !== 'string' || !/^[0-9a-f]{64}$/.test(request.token))
    throw Error('Invalid UDP probe endpoint');
  const host = request.host.split('.').map(value => integer(Number(value), 0, 255));
  if (host.length !== 4) throw Error('Invalid UDP probe endpoint');
  const port = integer(request.port, 1, 65535);
  const buffer = address(request.buffer);
  const durationMs = integer(request.durationMs, 100, 60000);
  const maxDatagrams = integer(request.maxDatagrams, 1, 1 << 20);
  const idleMs = request.idleMs === undefined ? 1000 : integer(request.idleMs, 10, 10000);
  const helloMs = request.helloMs === undefined ? 5000 : integer(request.helloMs, 100, 30000);
  checkMemory(buffer, slotsOffset + slotCount * slotBytes, 3);

  const functions = /** @type {Record<string, unknown>} */ (request.functions || {});
  /** @param {string} name */
  const optional = name => {
    if (functions[name] === undefined) return null;
    const pointer = address(functions[name]);
    return verified.has('0x' + pointer.toString(16)) ? pointer : null;
  };
  const errnoFunction = optional('errno');
  if (errnoFunction === null) throw Error('UDP probe needs a verified GetLastErrno');
  const errno = errnoFunction;
  const poll = optional('poll');
  const recvMMsg = optional('recvMMsg');
  let mode = request.mode === 'mmsg' && recvMMsg !== null ? 'mmsg' : 'recv';

  /** @param {number[]} bounds */
  function histogram(bounds) {
    const counts = new Array(bounds.length + 1).fill(0);
    /** @param {number} value */
    const add = value => {
      let index = 0;
      while (index < bounds.length && value >= bounds[index]) index++;
      counts[index]++;
    };
    return {bounds, counts, add};
  }
  /** @param {{bounds: number[], counts: number[]}} item */
  const compact = item => ({bounds: item.bounds, counts: item.counts});
  /** @param {bigint} value */
  const signed = value => Number(BigInt.asIntN(32, value));

  const callUs = {data: histogram([5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]),
    empty: histogram([5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000])};
  const drainBatch = histogram([2, 3, 5, 9, 17, 33]);
  const arrivalGapMs = histogram([1, 2, 5, 10, 20, 50, 100]);
  const seen = new Uint8Array(maxDatagrams);
  const delays = new Float64Array(maxDatagrams);
  const counts = {received: 0, duplicates: 0, reorders: 0, gapEvents: 0, foreign: 0, outOfRange: 0,
    polls: 0, hellos: 0};
  let highest = -1;
  let total = -1;
  let firstArrival = -1;
  let lastArrival = -1;
  let maxArrivalGapMs = 0;
  /** @type {number | undefined} */
  let mmsgErrno;

  function clockResolutionUs() {
    let smallest = Infinity;
    for (let round = 0; round < 3; round++) {
      const start = now();
      let next = now();
      while (next === start) next = now();
      smallest = Math.min(smallest, (next - start) * 1000);
    }
    return Math.round(smallest * 1000) / 1000;
  }

  /**
   * @param {bigint} pointer
   * @param {number} arrival
   */
  function accept(pointer, arrival) {
    const bytes = readMemory(pointer, 20);
    const view = new DataView(bytes.buffer, bytes.byteOffset, 20);
    if (view.getUint32(0, true) !== magic) {
      counts.foreign++;
      return;
    }

    const seq = view.getUint32(8, true);
    if (view.getUint32(16, true) & 1) {
      total = seq;
      return;
    }
    if (seq >= maxDatagrams) {
      counts.outOfRange++;
      return;
    }
    if (seen[seq]) {
      counts.duplicates++;
      return;
    }

    seen[seq] = 1;
    if (seq < highest) counts.reorders++;
    else if (seq > highest + 1) counts.gapEvents++;
    highest = Math.max(highest, seq);
    delays[counts.received++] = arrival * 1000 - view.getUint32(12, true);
    if (firstArrival < 0) firstArrival = arrival;
    if (lastArrival >= 0) {
      arrivalGapMs.add(arrival - lastArrival);
      maxArrivalGapMs = Math.max(maxArrivalGapMs, arrival - lastArrival);
    }
    lastArrival = arrival;
  }

  function prepareVectors() {
    const vector = new Uint8Array(slotCount * 56);
    const iov = new Uint8Array(slotCount * 16);
    const vectorView = new DataView(vector.buffer);
    const iovView = new DataView(iov.buffer);
    for (let index = 0; index < slotCount; index++) {
      const slot = buffer + BigInt(slotsOffset + index * slotBytes);
      iovView.setBigUint64(index * 16, slot, true);
      iovView.setBigUint64(index * 16 + 8, BigInt(slotBytes), true);
      vectorView.setBigUint64(index * 56 + 0x10, buffer + BigInt(iovOffset + index * 16), true);
      vectorView.setUint32(index * 56 + 0x18, 1, true);
    }
    writeBuffer(buffer + BigInt(vectorOffset), vector);
    writeBuffer(buffer + BigInt(iovOffset), iov);
  }

  /** One non-blocking receive: datagrams accepted, or -1 with the errno. */
  function receiveOnce() {
    const started = now();
    let result;
    if (mode === 'mmsg') {
      result = signed(call(/** @type {bigint} */ (recvMMsg), channel, buffer + BigInt(vectorOffset),
        BigInt(slotCount), BigInt(nonBlocking), 0n));
    } else {
      result = signed(receive(channel, buffer + BigInt(slotsOffset), slotBytes, nonBlocking));
    }
    const finished = now();

    if (result < 0) {
      callUs.empty.add((finished - started) * 1000);
      return {count: -1, error: Number(call(errno) & 0xffffffffn)};
    }
    callUs.data.add((finished - started) * 1000);
    if (mode === 'recv' && result < 20) {
      counts.foreign++;
      return {count: 1, error: 0};
    }
    const datagrams = mode === 'mmsg' ? result : 1;
    for (let index = 0; index < datagrams; index++)
      accept(buffer + BigInt(slotsOffset + index * slotBytes), finished);
    return {count: datagrams, error: 0};
  }

  function waitBriefly() {
    if (poll === null) return;
    const descriptor = new Uint8Array(8);
    const view = new DataView(descriptor.buffer);
    view.setInt32(0, Number(channel), true);
    view.setInt16(4, 1, true);
    writeBuffer(buffer + 0x20n, descriptor);
    counts.polls++;
    call(poll, buffer + 0x20n, 1n, 1n);
  }

  function lossBursts() {
    const end = total >= 0 ? Math.min(total, maxDatagrams) : highest + 1;
    const bursts = histogram([2, 3, 5, 9, 17, 65]);
    let run = 0;
    let lost = 0;
    for (let seq = 0; seq <= end; seq++) {
      if (seq < end && !seen[seq]) {
        run++;
        lost++;
        continue;
      }
      if (run) bursts.add(run);
      run = 0;
    }
    return {expected: end, lost, bursts: compact(bursts)};
  }

  function delayHistogram() {
    const received = delays.subarray(0, counts.received);
    let minimum = Infinity;
    for (const value of received) minimum = Math.min(minimum, value);
    const relative = histogram([1, 2, 5, 10, 20, 50, 100, 200]);
    let maximum = 0;
    for (const value of received) {
      relative.add((value - minimum) / 1000);
      maximum = Math.max(maximum, (value - minimum) / 1000);
    }
    return {...compact(relative), maxMs: Math.round(maximum * 1000) / 1000};
  }

  const endpoint = new Uint8Array(16);
  endpoint.set([16, 2, port >> 8, port & 255, ...host]);
  writeBuffer(buffer, endpoint);
  const hello = new Uint8Array(68);
  new DataView(hello.buffer).setUint32(0, helloMagic, true);
  hello.set(encode(request.token), 4);
  writeBuffer(buffer + 0x100n, hello);

  const channel = socket(2, 2, 17);
  if (channel < 0n) throw Error('UDP probe socket failed');
  try {
    const bufferRequest = /** @type {ReceiveBufferRequest | undefined} */ (request.receiveBuffer);
    /** @type {ReceiveBufferReport | null} */
    const rcvbuf = bufferRequest && native.setReceiveBuffer
      ? native.setReceiveBuffer(native, channel, bufferRequest) : null;
    if (connect(channel, buffer, 16) !== 0n) throw Error('UDP probe connect failed');

    const errnoStart = now();
    for (let index = 0; index < 1000; index++) call(errno);
    const errnoCallUs = Math.round((now() - errnoStart) * 1000) / 1000;
    const resolutionUs = clockResolutionUs();
    if (mode === 'mmsg') prepareVectors();

    const started = now();
    let lastHello = -Infinity;
    let drained = 0;
    for (;;) {
      const current = now();
      if (firstArrival < 0 && current - started > helloMs) break;
      if (firstArrival >= 0 && current - lastArrival > idleMs) break;
      if (firstArrival >= 0 && current - firstArrival > durationMs + 5000) break;
      if (total >= 0) break;
      if (firstArrival < 0 && current - lastHello >= 200) {
        if (signed(send(channel, buffer + 0x100n, hello.length, 0)) !== hello.length)
          throw Error('UDP probe hello failed');
        counts.hellos++;
        lastHello = current;
      }

      const {count, error} = receiveOnce();
      if (count > 0) {
        drained += count;
        continue;
      }
      if (count === 0) continue;
      if (error !== 11 && error !== 4) {
        if (mode !== 'mmsg') throw Error('UDP probe receive failed: ' + error);
        mmsgErrno = error;
        mode = 'recv';
        continue;
      }
      if (drained) drainBatch.add(drained);
      drained = 0;
      waitBriefly();
    }
    if (drained) drainBatch.add(drained);

    const losses = lossBursts();
    return {mode, ...(mmsgErrno === undefined ? {} : {mmsgErrno}), rcvbuf, errnoCallUs,
      clockResolutionUs: resolutionUs, hellos: counts.hellos, polls: counts.polls,
      waitedMs: firstArrival < 0 ? null : Math.round(firstArrival - started),
      elapsedMs: firstArrival < 0 ? 0 : Math.round(lastArrival - firstArrival),
      endSeen: total >= 0, expected: losses.expected, received: counts.received, lost: losses.lost,
      gapEvents: counts.gapEvents, reorders: counts.reorders, duplicates: counts.duplicates,
      foreign: counts.foreign, outOfRange: counts.outOfRange,
      lossBursts: losses.bursts, drainBatch: compact(drainBatch),
      callUs: {data: compact(callUs.data), empty: compact(callUs.empty)},
      arrivalGapMs: compact(arrivalGapMs), maxArrivalGapMs: Math.round(maxArrivalGapMs * 1000) / 1000,
      delayMs: delayHistogram()};
  } finally {
    close(channel);
  }
}

/**
 * One probe datagram: magic, run, seq, PC send µs since the phase start, flags, then padding.
 * @param {{run: number, seq: number, sentUs: number, end?: boolean}} fields
 */
export function probeDatagram({run, seq, sentUs, end = false}) {
  const datagram = Buffer.alloc(UDP_PROBE.payloadBytes);
  datagram.writeUInt32LE(UDP_PROBE.magic, 0);
  datagram.writeUInt32LE(run >>> 0, 4);
  datagram.writeUInt32LE(seq >>> 0, 8);
  datagram.writeUInt32LE(Math.max(0, Math.floor(sentUs)) >>> 0, 12);
  datagram.writeUInt32LE(end ? UDP_PROBE.endFlag : 0, 16);
  return datagram;
}

/**
 * @param {Buffer} message
 * @param {string} token
 */
export function isProbeHello(message, token) {
  const sizeOk = message.length === 68;
  return sizeOk && message.readUInt32LE(0) === UDP_PROBE.helloMagic && message.subarray(4).toString() === token;
}

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * PC side of one phase: listens on an ephemeral UDP port, starts the console's `udp-probe`,
 * waits for its hello and sends paced datagrams at `rateMbps` for `seconds`, then the end marker.
 * @param {{rpc: Pick<Civ7Rpc, 'request'>, hostAddress: string, buffer: number,
 *   functions: Record<string, string>, receiveBuffer?: ReceiveBufferRequest | null, rateMbps: number,
 *   seconds: number, mode?: 'recv' | 'mmsg', run?: number, helloTimeoutMs?: number,
 *   now?: () => number}} options
 */
export async function runUdpProbe({rpc, hostAddress, buffer, functions, receiveBuffer = null, rateMbps,
  seconds, mode = 'recv', run = 1, helloTimeoutMs = 8000, now = () => performance.now()}) {
  const rate = rateMbps * 1e6 / 8 / UDP_PROBE.payloadBytes;
  const count = Math.round(rate * seconds);
  if (!(count > 0) || count > 1 << 20) throw Error('Invalid UDP probe rate or duration');

  const token = crypto.randomBytes(32).toString('hex');
  const socket = dgram.createSocket('udp4');
  /** @type {(peer: dgram.RemoteInfo) => void} */
  let onHello = () => {};
  const hello = new Promise(resolve => { onHello = resolve; });
  socket.on('message', (message, peer) => { if (isProbeHello(message, token)) onHello(peer); });
  await new Promise(resolve => socket.bind(0, '0.0.0.0', () => resolve(undefined)));
  try { socket.setSendBufferSize(4 << 20); } catch {}

  let sendErrors = 0;
  /**
   * @param {Buffer} datagram
   * @param {dgram.RemoteInfo} peer
   */
  const transmit = (datagram, peer) => socket.send(datagram, peer.port, peer.address, error => {
    if (error) sendErrors++;
  });

  try {
    const port = socket.address().port;
    const reply = rpc.request({command: 'udp-probe', host: hostAddress, port, token, buffer: '0x' + buffer.toString(16),
      durationMs: Math.round(seconds * 1000), maxDatagrams: count, mode, functions,
      ...(receiveBuffer ? {receiveBuffer} : {})}, undefined, Math.round(seconds * 1000) + 30000);
    reply.catch(() => {});
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Console sent no UDP probe hello')), helloTimeoutMs);
    });
    const peer = /** @type {dgram.RemoteInfo} */ (await Promise.race([hello, timeout, reply.then(() => {
      throw Error('UDP probe ended before its hello');
    })]).finally(() => clearTimeout(timer)));

    const started = now();
    let sent = 0;
    while (sent < count) {
      const elapsed = now() - started;
      const due = Math.min(count, Math.floor(elapsed / 1000 * rate) + 1);
      for (; sent < due; sent++) transmit(probeDatagram({run, seq: sent, sentUs: (now() - started) * 1000}), peer);
      if (sent < count) await sleep(1);
    }
    const sendMs = now() - started;
    for (let index = 0; index < 5; index++) {
      transmit(probeDatagram({run, seq: count, sentUs: (now() - started) * 1000, end: true}), peer);
      await sleep(20);
    }

    const result = await reply;
    const {id, ok, ...fields} = result;
    return {rateMbps, seconds, sent: count, sendMs: Math.round(sendMs), sendErrors, ...fields};
  } finally {
    socket.close();
  }
}
