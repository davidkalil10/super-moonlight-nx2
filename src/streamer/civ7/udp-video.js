/**
 * UDP video transport, PC side: packetizes each access unit, paces it, keeps it for resends and
 * answers the console's NACKs; civ7/README.md, "UDP transport". The console side is udp-receiver.js.
 */
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import {pcNow} from './clock.js';

/** Wire constants, little-endian; udp-receiver.js repeats the ones it needs. */
export const UDP_VIDEO = {
  magic: 0x31564455,
  helloMagic: 0x48564455,
  nackMagic: 0x314e4455,
  statsMagic: 0x31534455,
  dropMagic: 0x31505244,
  headerBytes: 40,
  fragmentBytes: 1360,
  maxFragments: 0xfff,
  flags: {keyframe: 1, end: 2, resend: 4},
  dropReasons: {1: 'late', 2: 'skipped'},
  dropBytes: 16,
  unitSlots: 8,
  areaBytes: 0x19000,
  reportOffset: 0x40,
  nackRanges: 16,
  nackRangeLimit: 256,
  paceBytesPerMs: 12500,
  stats: ['received', 'lost', 'repaired', 'nacks', 'lateDrops', 'reorders', 'drainCalls', 'drainUs',
    'duplicates', 'skipped', 'stale', 'copies']
};

/**
 * @typedef {{deadlineMs: number, spreadMs: number, paceBytesPerMs: number}} UdpTiming
 * @typedef {{seq: number, pts: number, data: Buffer, keyframe?: boolean}} UdpUnit
 */

/**
 * The base repair deadline (two periods, at least 12 ms) and the pacing spread (a third of a
 * period, or longer at `paceBytesPerMs` for a big unit).
 * @param {number} fps
 * @returns {UdpTiming}
 */
export function udpTiming(fps) {
  const periodMs = 1000 / fps;

  return {deadlineMs: Math.max(2 * periodMs, 12), spreadMs: periodMs / 3, paceBytesPerMs: UDP_VIDEO.paceBytesPerMs};
}

/**
 * @param {UdpTiming} timing
 * @param {number} length
 */
export function spreadMs(timing, length) {
  return Math.max(timing.spreadMs, length / timing.paceBytesPerMs);
}

/**
 * How long a unit may take from its first datagram to complete before the console drops it; a
 * keyframe gets twice the base. udp-receiver.js computes the same.
 * @param {UdpTiming} timing
 * @param {number} length
 * @param {boolean} keyframe
 */
export function frameDeadlineMs(timing, length, keyframe) {
  const base = keyframe ? 2 * timing.deadlineMs : timing.deadlineMs;

  return base + spreadMs(timing, length);
}

/**
 * The datagrams of one unit: the 40-byte header (magic, fragment index | count << 12 | flags
 * << 24, datagram seq, frame, unit length, unit seq, pts, PC send µs, reserved), then up to
 * fragmentBytes of the unit.
 * @param {{frame: number, firstSeq: number, unit: UdpUnit}} fields
 */
export function packetize({frame, firstSeq, unit}) {
  const {headerBytes, fragmentBytes} = UDP_VIDEO;
  const count = Math.ceil(unit.data.length / fragmentBytes);
  const countOk = count >= 1 && count <= UDP_VIDEO.maxFragments;
  if (!countOk) throw Error('Invalid UDP video unit length');

  const flags = unit.keyframe ? UDP_VIDEO.flags.keyframe : 0;
  /** @type {Buffer[]} */
  const datagrams = [];
  for (let index = 0; index < count; index++) {
    const payload = unit.data.subarray(index * fragmentBytes, (index + 1) * fragmentBytes);
    const datagram = Buffer.alloc(headerBytes + payload.length);
    datagram.writeUInt32LE(UDP_VIDEO.magic, 0);
    datagram.writeUInt32LE((index | count << 12 | flags << 24) >>> 0, 4);
    datagram.writeUInt32LE((firstSeq + index) >>> 0, 8);
    datagram.writeUInt32LE(frame >>> 0, 12);
    datagram.writeUInt32LE(unit.data.length, 16);
    datagram.writeUInt32LE(unit.seq >>> 0, 20);
    datagram.writeBigUInt64LE(BigInt(unit.pts), 24);
    payload.copy(datagram, headerBytes);
    datagrams.push(datagram);
  }
  return datagrams;
}

/**
 * The end marker: flags end, frame is the number of units sent.
 * @param {number} frames
 * @param {number} seq
 */
export function endDatagram(frames, seq) {
  const datagram = Buffer.alloc(UDP_VIDEO.headerBytes);
  datagram.writeUInt32LE(UDP_VIDEO.magic, 0);
  datagram.writeUInt32LE(UDP_VIDEO.flags.end << 24 >>> 0, 4);
  datagram.writeUInt32LE(seq >>> 0, 8);
  datagram.writeUInt32LE(frames >>> 0, 12);
  return datagram;
}

/**
 * @param {Buffer} message
 * @param {string} token
 */
export function isVideoHello(message, token) {
  const sizeOk = message.length === 68;
  return sizeOk && message.readUInt32LE(0) === UDP_VIDEO.helloMagic && message.subarray(4).toString() === token;
}

/**
 * The NACK's ranges, [first datagram seq, count] each, at most nackRanges of nackRangeLimit.
 * @param {Buffer} message
 * @returns {[number, number][] | null}
 */
export function readNack(message) {
  const headerOk = message.length >= 8 && message.readUInt32LE(0) === UDP_VIDEO.nackMagic;
  if (!headerOk) return null;

  const count = Math.min(message.readUInt32LE(4), UDP_VIDEO.nackRanges, Math.floor((message.length - 8) / 8));
  /** @type {[number, number][]} */
  const ranges = [];
  for (let index = 0; index < count; index++) {
    const first = message.readUInt32LE(8 + index * 8);
    const length = Math.min(message.readUInt32LE(12 + index * 8), UDP_VIDEO.nackRangeLimit);
    ranges.push([first, length]);
  }
  return ranges;
}

/**
 * The console's cumulative counters (UDP_VIDEO.stats order), or null.
 * @param {Buffer} message
 * @returns {Record<string, number> | null}
 */
export function readConsoleStats(message) {
  const headerOk = message.length >= 8 && message.readUInt32LE(0) === UDP_VIDEO.statsMagic;
  if (!headerOk) return null;

  const count = Math.min(message.readUInt32LE(4), UDP_VIDEO.stats.length, Math.floor((message.length - 8) / 4));
  /** @type {Record<string, number>} */
  const stats = {};
  for (let index = 0; index < count; index++) stats[UDP_VIDEO.stats[index]] = message.readUInt32LE(8 + index * 4);
  return stats;
}

/**
 * The sender without sockets or timers: `enqueue` schedules a unit's datagrams over its spread
 * in 1 ms ticks after the previous unit's, `flush` sends what is due, `nack` resends each listed
 * datagram once while its unit is inside the deadline, `probe` resends the newest unit's last
 * datagram once it is overdue, so a console that lost the tail whole learns it exists.
 * @param {{timing: UdpTiming, transmit: (datagram: Buffer) => void, maxUnitBytes: number,
 *   now?: () => number}} options
 */
export function createUdpSendState({timing, transmit, maxUnitBytes, now = pcNow}) {
  /** @type {{datagram: Buffer, dueAt: number}[]} */
  const queue = [];
  /** @type {Map<number, {datagram: Buffer, deadlineAt: number, resent: boolean}>} */
  const retained = new Map();
  const counters = {units: 0, datagrams: 0, resent: 0, nacks: 0, expired: 0, repeated: 0, probes: 0};
  /** @type {Buffer | null} */
  let newest = null;
  let probeAt = Infinity;
  let nextSeq = 0;
  let nextFrame = 0;
  let paceFree = -Infinity;

  /** @param {number} at */
  function prune(at) {
    for (const [seq, entry] of retained) {
      if (entry.deadlineAt >= at) break;
      retained.delete(seq);
    }
  }

  /** @param {Buffer} datagram */
  function resend(datagram) {
    const copy = Buffer.from(datagram);
    copy.writeUInt32LE((copy.readUInt32LE(4) | UDP_VIDEO.flags.resend << 24) >>> 0, 4);
    stamp(copy);
  }

  /** @param {Buffer} datagram */
  function stamp(datagram) {
    datagram.writeUInt32LE(Math.floor(now() * 1000) >>> 0, 32);
    transmit(datagram);
    counters.datagrams++;
  }

  /** Sends every datagram that is due; returns ms until the next one, or null when empty. */
  function flush() {
    const at = now();
    while (queue.length && queue[0].dueAt <= at) stamp(/** @type {{datagram: Buffer}} */ (queue.shift()).datagram);

    return queue.length ? Math.max(0, queue[0].dueAt - at) : null;
  }

  return {
    get pending() { return queue.length; },
    get frames() { return nextFrame; },
    counters,
    /**
     * Queues the unit and returns its frame index (contiguous, unlike the helper's sequence).
     * @param {UdpUnit} unit
     */
    enqueue(unit) {
      if (unit.data.length > maxUnitBytes) throw Error('Access unit exceeds the UDP unit slot');

      const frame = nextFrame;
      const datagrams = packetize({frame, firstSeq: nextSeq, unit});
      const at = now();
      const start = Math.max(at, paceFree);
      const ticks = Math.max(1, Math.ceil(spreadMs(timing, unit.data.length)));
      const perTick = Math.ceil(datagrams.length / ticks);
      const deadlineAt = start + frameDeadlineMs(timing, unit.data.length, Boolean(unit.keyframe));

      datagrams.forEach((datagram, index) => {
        queue.push({datagram, dueAt: start + Math.floor(index / perTick)});
        retained.set((nextSeq + index) >>> 0, {datagram, deadlineAt, resent: false});
      });
      newest = datagrams[datagrams.length - 1];
      probeAt = deadlineAt + timing.deadlineMs;
      nextSeq += datagrams.length;
      nextFrame++;
      counters.units++;
      paceFree = start + Math.ceil(datagrams.length / perTick);
      prune(at);
      flush();
      return frame;
    },
    flush,
    /**
     * @param {[number, number][]} ranges
     */
    nack(ranges) {
      const at = now();
      counters.nacks++;
      for (const [first, count] of ranges) {
        for (let offset = 0; offset < count; offset++) {
          const entry = retained.get((first + offset) >>> 0);
          if (!entry || entry.deadlineAt < at) {
            counters.expired++;
            continue;
          }
          if (entry.resent) {
            counters.repeated++;
            continue;
          }

          entry.resent = true;
          resend(entry.datagram);
          counters.resent++;
        }
      }
    },
    /**
     * Call while units are unacknowledged: resends the newest unit's last datagram once that
     * unit is a base deadline past its own, then every base deadline. Returns ms until the next
     * probe is due, or null before any unit.
     */
    probe() {
      if (!newest) return null;

      const at = now();
      if (probeAt > at) return probeAt - at;
      if (queue.length) return 1;

      resend(newest);
      counters.probes++;
      probeAt = at + timing.deadlineMs;
      return timing.deadlineMs;
    },
    end() { return endDatagram(nextFrame, nextSeq); }
  };
}

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The PC end of the transport: one UDP socket on an ephemeral port that waits for the console's
 * hello, then paces units to it and answers NACKs from that address only. `take` returns the
 * console's counters (sent once a second over UDP) and the sender's for the last second.
 * @param {{fps: number, maxUnitBytes: number, helloTimeoutMs?: number, now?: () => number}} options
 */
export async function createUdpVideoSender({fps, maxUnitBytes, helloTimeoutMs = 8000, now = pcNow}) {
  const timing = udpTiming(fps);
  const token = crypto.randomBytes(32).toString('hex');
  const socket = dgram.createSocket('udp4');
  /** @type {dgram.RemoteInfo | null} */
  let peer = null;
  /** @type {(peer: dgram.RemoteInfo) => void} */
  let onPeer = () => {};
  /** @type {Promise<dgram.RemoteInfo>} */
  const hello = new Promise(resolve => { onPeer = resolve; });
  /** @type {Promise<dgram.RemoteInfo> | null} */
  let waiting = null;
  /** @type {NodeJS.Timeout | undefined} */
  let helloTimer;
  /** @type {NodeJS.Timeout | undefined} */
  let paceTimer;
  /** @type {NodeJS.Timeout | undefined} */
  let probeTimer;
  let outstanding = () => false;
  /** @type {Record<string, number>} */
  let consoleStats = {};
  /** @type {Record<string, number>} */
  let takenConsole = {};
  /** @type {Record<string, number>} */
  let takenSender = {};
  let sendErrors = 0;
  let closed = false;

  /** @param {Buffer} datagram */
  function transmit(datagram) {
    if (!peer || closed) return;
    socket.send(datagram, peer.port, peer.address, error => { if (error) sendErrors++; });
  }

  const state = createUdpSendState({timing, transmit, maxUnitBytes, now});

  function schedule() {
    if (paceTimer || closed) return;

    const wait = state.flush();
    if (wait === null) return;
    paceTimer = setTimeout(() => {
      paceTimer = undefined;
      schedule();
    }, Math.max(1, Math.ceil(wait)));
  }

  /** Probes the tail while units are unacknowledged; idle once they settle. */
  function guardTail() {
    clearTimeout(probeTimer);
    probeTimer = undefined;
    if (closed || !outstanding()) return;

    const wait = state.probe();
    if (wait === null) return;
    probeTimer = setTimeout(guardTail, Math.max(1, Math.ceil(wait)));
  }

  socket.on('message', (message, from) => {
    if (!peer) {
      if (!isVideoHello(message, token)) return;
      peer = from;
      onPeer(from);
      return;
    }
    const samePeer = from.address === peer.address && from.port === peer.port;
    if (!samePeer) return;

    const ranges = readNack(message);
    if (ranges) {
      state.nack(ranges);
      return;
    }
    const stats = readConsoleStats(message);
    if (stats) consoleStats = stats;
  });
  socket.on('error', () => {});
  await new Promise(resolve => socket.bind(0, '0.0.0.0', () => resolve(undefined)));
  try { socket.setSendBufferSize(4 << 20); } catch {}

  /**
   * @param {Record<string, number>} current
   * @param {Record<string, number>} previous
   */
  const delta = (current, previous) => Object.fromEntries(Object.entries(current)
    .map(([key, value]) => [key, (value - (previous[key] ?? 0)) >>> 0]));

  return {
    port: socket.address().port,
    token,
    timing,
    /** Resolves on the console's hello; rejects `helloTimeoutMs` after the first call without one. */
    connected() {
      waiting ??= Promise.race([hello, new Promise((_, reject) => {
        helloTimer = setTimeout(() => reject(Error('Console sent no UDP video hello')), helloTimeoutMs);
      })]).finally(() => clearTimeout(helloTimer));
      return /** @type {Promise<dgram.RemoteInfo>} */ (waiting);
    },
    /**
     * The channel's view of unacknowledged units, which gates the tail probe.
     * @param {() => boolean} pending
     */
    watch(pending) {
      outstanding = pending;
    },
    /** @param {UdpUnit} unit */
    send(unit) {
      const frame = state.enqueue(unit);
      schedule();
      guardTail();
      return frame;
    },
    /**
     * Sends the end marker once every queued datagram went out: three times 5 ms apart, then
     * every 100 ms until `settled`, so a console that lost the last units whole still drops them.
     * @param {Promise<unknown>} [settled] the outstanding units' acks or drops
     */
    async end(settled = Promise.resolve()) {
      let done = false;
      settled.then(() => { done = true; }, () => { done = true; });

      while (state.pending && !closed) await sleep(1);
      for (let index = 0; !closed && (index < 3 || !done); index++) {
        transmit(state.end());
        await sleep(index < 3 ? 5 : 100);
      }
    },
    stats() {
      return {console: consoleStats, sender: {...state.counters, sendErrors}};
    },
    take() {
      const sender = {...state.counters, sendErrors};
      const taken = {...delta(consoleStats, takenConsole), sender: delta(sender, takenSender)};
      takenConsole = consoleStats;
      takenSender = sender;
      return taken;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(paceTimer);
      clearTimeout(probeTimer);
      clearTimeout(helloTimer);
      socket.close();
    }
  };
}

/** @typedef {Awaited<ReturnType<typeof createUdpVideoSender>>} UdpVideoSender */
