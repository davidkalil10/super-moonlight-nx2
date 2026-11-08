import net from 'node:net';
import crypto from 'node:crypto';
import {INPUT_RECORD, readInputRecord} from '../input/input-record.js';
import {pcNow} from './clock.js';
import {LOOP, TIMING, readLoop, readTiming, createLatencyMonitor} from './latency.js';
import {createSendWindow} from './video-window.js';
import {UDP_VIDEO} from './udp-video.js';

/** @import {InputRecord} from '../input/input-record.js' */
/** @import {ConsoleLoop, TimedFrame} from './latency.js' */
/** @import {Civ7Rpc} from './transport.js' */
/** @import {WindowReport} from './video-window.js' */
/** @import {UdpVideoSender} from './udp-video.js' */

/**
 * @typedef {object} PendingFrame
 * @property {Buffer} header
 * @property {number} started
 * @property {() => void} resolve
 * @property {(error: Error) => void} reject
 * @property {Promise<void>} done
 * @property {number} [frame] the UDP transport's frame index
 * @property {boolean} [keyframe]
 */

/** @typedef {{seq: number, pts: number, data: Buffer}} AccessUnit */

const HEADER_BYTES = 16;
/** With input, each acknowledgement adds a u32 record length and the record (0 for none). */
const RECORD_OFFSET = HEADER_BYTES + 4;

/**
 * A console may follow each acknowledgement with a timing block (latency.js TIMING); its magic
 * cannot start a header, whose first word is a unit length of at most 8 MiB. Once a second a loop
 * block (latency.js LOOP) follows, passed to `onLoop`.
 * `latency: {rpc, log}` syncs the console clock and logs per-second `civ7-latency` events.
 * A fixed `window` bounds the units in flight; with `fps` instead, adaptWindow() sizes it from
 * the ack round trip (video-window.js).
 * Video passes `datagrams` (udp-video.js): the units go over UDP and only acks, drop blocks and
 * timing come back on this socket; a drop block (16 bytes: magic, frame, reason) ends a unit the
 * console gave up on, in any order against the acks. README.md, "UDP transport". Without it the
 * units go on this socket, as audio.js sends its PCM.
 * @param {{port?: number, timeoutMs?: number, window?: number, fps?: number, input?: boolean,
 *   onInput?: (record: InputRecord | null) => void,
 *   onAcknowledged?: (event: {sequence: number, elapsedMs: number}) => void,
 *   datagrams?: UdpVideoSender,
 *   onDropped?: (event: {sequence: number, frame: number, reason: string, keyframe: boolean}) => void,
 *   onTiming?: (frame: TimedFrame) => void, onLoop?: (loop: ConsoleLoop) => void, now?: () => number,
 *   latency?: {rpc: Pick<Civ7Rpc, 'request'>, log: (event: object) => void}}} [options]
 */
export async function videoChannel({port = 0, timeoutMs = 15000, window = undefined, fps = undefined,
  input = false, onInput = record => {}, onAcknowledged = event => {}, onTiming = frame => {},
  onLoop = loop => {}, now = pcNow, latency = undefined, datagrams = undefined, onDropped = event => {}} = {}) {
  const monitor = latency ? createLatencyMonitor({log: latency.log, now,
    request: () => latency.rpc.request({command: 'time'})}) : null;
  const token = crypto.randomBytes(32).toString('hex');
  const sendWindow = window === undefined && fps !== undefined
    ? createSendWindow({fps}) : null;
  const fixedWindow = window ?? 2;
  const limit = () => sendWindow?.size ?? fixedWindow;
  /** @type {Set<net.Socket>} */
  const candidates = new Set();
  /** @type {PendingFrame[]} */
  const pending = [];
  /** @type {net.Socket | undefined} */
  let socket;
  /** @type {Error | undefined} */
  let failure;
  /** @type {() => void} */
  let resolveConnection = () => {};
  /** @type {(error: Error) => void} */
  let rejectConnection = () => {};
  let acknowledged = 0;
  let dropped = 0;
  /** @type {{sequence: number, sentMs: number, acknowledgedMs: number, forwardedMs: number | null} | null} */
  let last = null;
  /** @type {Promise<void>} */
  const connected = new Promise((resolve, reject) => {
    resolveConnection = resolve;
    rejectConnection = reject;
  });
  connected.catch(() => {});
  /** @param {Error} error */
  function fail(error) {
    monitor?.stop();
    const reason = failure ||= error;
    rejectConnection(reason);
    for (const frame of pending.splice(0)) frame.reject(reason);
  }

  function connection() {
    if (!socket) throw Error('Video receiver is not connected');
    return socket;
  }

  /**
   * @param {net.Socket} candidate
   * @param {PendingFrame | undefined} frame
   * @param {Error} error
   */
  function refuse(candidate, frame, error) {
    frame?.reject(error);
    candidate.destroy(error);
  }

  const server = net.createServer(candidate => {
    candidates.add(candidate);
    candidate.setNoDelay(true);
    candidate.setTimeout(timeoutMs, () => candidate.destroy(Error('Video connection timed out')));
    let bytes = Buffer.alloc(0);
    let authenticated = false;
    candidate.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (!authenticated) {
        if (bytes.length < 64) return;
        if (socket || bytes.subarray(0, 64).toString() !== token) return candidate.destroy();
        bytes = bytes.subarray(64);
        authenticated = true;
        socket = candidate;
        resolveConnection();
      }
      while (bytes.length >= 4) {
        if (bytes.readUInt32LE(0) === UDP_VIDEO.dropMagic) {
          if (bytes.length < UDP_VIDEO.dropBytes) return;

          const frameIndex = bytes.readUInt32LE(4);
          const reason = bytes.readUInt32LE(8);
          bytes = bytes.subarray(UDP_VIDEO.dropBytes);
          const index = pending.findIndex(item => item.frame === frameIndex);
          if (!datagrams || index < 0) return refuse(candidate, pending[0], Error('Unexpected video drop'));

          const [frame] = pending.splice(index, 1);
          dropped++;
          onDropped({sequence: frame.header.readUInt32LE(4), frame: frameIndex,
            reason: reason === 1 ? 'late' : 'skipped', keyframe: Boolean(frame.keyframe)});
          frame.resolve();
          continue;
        }

        if (bytes.readUInt32LE(0) === LOOP.magic) {
          if (bytes.length < LOOP.bytes) return;

          const loop = readLoop(bytes.subarray(0, LOOP.bytes));
          bytes = bytes.subarray(LOOP.bytes);
          onLoop(loop);
          continue;
        }

        if (bytes.readUInt32LE(0) === TIMING.magic) {
          if (bytes.length < TIMING.bytes) return;
          let timing;
          try {
            timing = readTiming(bytes.subarray(0, TIMING.bytes));
          } catch (error) {
            return refuse(candidate, pending[0], /** @type {Error} */ (error));
          }
          if (!last || timing.sequence !== last.sequence)
            return refuse(candidate, pending[0], Error('Unexpected video timing'));

          bytes = bytes.subarray(TIMING.bytes);
          const timed = {...last, timing};
          last = null;
          monitor?.frame(timed);
          onTiming(timed);
          continue;
        }

        if (bytes.length < HEADER_BYTES) return;
        const frame = pending[0];
        if (!frame || !bytes.subarray(0, HEADER_BYTES).equals(frame.header))
          return refuse(candidate, frame, Error('Unexpected video acknowledgement'));

        let size = HEADER_BYTES;
        let record = null;
        if (input) {
          if (bytes.length < RECORD_OFFSET) return;
          const length = bytes.readUInt32LE(HEADER_BYTES);
          if (length > INPUT_RECORD.limit) return refuse(candidate, frame, Error('Invalid input record length'));
          size = RECORD_OFFSET + length;
          if (bytes.length < size) return;
          try {
            if (length) record = readInputRecord(bytes.subarray(RECORD_OFFSET, size));
          } catch (error) {
            return refuse(candidate, frame, /** @type {Error} */ (error));
          }
        }

        pending.shift();
        bytes = bytes.subarray(size);
        const acknowledgedMs = now();
        const sequence = frame.header.readUInt32LE(4);
        let forwardedMs = null;
        if (input) {
          onInput(record);
          forwardedMs = now();
        }
        acknowledged++;
        last = {sequence, sentMs: frame.started, acknowledgedMs, forwardedMs};
        sendWindow?.sample(acknowledgedMs - frame.started);
        onAcknowledged({sequence, elapsedMs: acknowledgedMs - frame.started});
        frame.resolve();
      }
    });
    candidate.on('error', error => { if (candidate === socket) fail(error); });
    candidate.on('close', () => {
      candidates.delete(candidate);
      if (candidate === socket && pending.length) fail(Error('Video closed with frames outstanding'));
    });
  });
  server.on('error', fail);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(undefined));
  });
  const endpoint = server.address();
  if (!endpoint || typeof endpoint === 'string') throw Error('Invalid video listener');
  datagrams?.watch(() => pending.length > 0);
  const timer = setTimeout(() => fail(Error('Video receiver did not connect')), timeoutMs);
  connected.finally(() => clearTimeout(timer)).catch(() => {});
  connected.then(() => monitor?.start(), () => {});
  return {
    port: endpoint.port, token, connected,
    get acknowledged() { return acknowledged; },
    /** Units the console dropped over UDP (late or skipped to a keyframe); 0 without datagrams. */
    get dropped() { return dropped; },
    get window() { return limit(); },
    /**
     * Resizes an adaptive window from the last second's acks; call once per second.
     * @returns {WindowReport | {size: number, reason: 'fixed'}}
     */
    adaptWindow() {
      if (!sendWindow) return {size: fixedWindow, reason: 'fixed'};
      return sendWindow.adapt();
    },
    /** The console clock estimate (clock.js), or null without `latency` or before a sync. */
    get clock() { return monitor?.clock.estimate() ?? null; },
    /** @param {AccessUnit} unit */
    async send(unit) {
      await connected;
      if (failure) throw failure;
      while (pending.length >= limit()) await pending[0].done;
      if (failure) throw failure;
      if (!Number.isSafeInteger(unit.seq) || unit.seq < 0 || !Number.isSafeInteger(unit.pts) || unit.pts < 0 ||
          !Buffer.isBuffer(unit.data) || !unit.data.length || unit.data.length > 8 * 1024 * 1024)
        throw Error('Invalid video access unit');
      const header = Buffer.alloc(16);
      header.writeUInt32LE(unit.data.length);
      header.writeUInt32LE(unit.seq >>> 0, 4);
      header.writeBigUInt64LE(BigInt(unit.pts), 8);
      /** @type {PendingFrame} */
      const frame = {header, started: now(), resolve: () => {}, reject: () => {}, done: Promise.resolve()};
      frame.done = new Promise((resolve, reject) => { frame.resolve = resolve; frame.reject = reject; });
      frame.done.catch(() => {});
      if (datagrams) {
        await datagrams.connected();
        if (failure) throw failure;
        frame.started = now();
        frame.keyframe = Boolean(/** @type {{keyframe?: boolean}} */ (unit).keyframe);
        frame.frame = datagrams.send(unit);
        pending.push(frame);
        return;
      }
      pending.push(frame);
      await new Promise((resolve, reject) => {
        connection().write(Buffer.concat([header, unit.data]), error => error ? reject(error) : resolve(undefined));
      });
    },
    async finish() {
      await connected;
      const settled = Promise.all(pending.map(frame => frame.done));
      const ending = datagrams?.end(settled);
      await settled;
      if (failure) throw failure;
      await ending;
      monitor?.stop();
      connection().end();
    },
    close() {
      clearTimeout(timer);
      fail(Error('Video channel closed'));
      datagrams?.close();
      for (const candidate of candidates) candidate.destroy();
      server.close();
    }
  };
}
