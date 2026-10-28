/**
 * Joins the helper's Annex-B pipe with its access-unit metadata without blocking either pipe.
 *
 * The helper writes raw H.264 to one pipe and announces each access unit (sequence, size,
 * keyframe flag, timestamps) on a separate metadata channel. AccessUnits cuts the byte stream
 * into units by those sizes, with bounded buffering: by default it pauses the pipe when the
 * queue is full; with onBacklog it instead drops queued units and skips ahead to the next
 * keyframe.
 */

import {isBSlice, sliceType} from './h264-sps.js';

const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_TYPE_MASK = 31;
const NAL_FORBIDDEN_BIT = 128;
const MIB = 1024 * 1024;
const DEFAULT_MAX_UNIT_BYTES = 16 * MIB;
const MAX_UNIT_BYTES_LIMIT = 64 * MIB;
const DEFAULT_MAX_QUEUED_UNITS = 4;
const MAX_QUEUED_UNITS_LIMIT = 64;
const MAX_PENDING_METADATA = 128;
/** Raw bytes may run ahead of their metadata by this many maximum-size units. */
const BUFFERED_UNITS = 2;

/**
 * Length of the Annex-B start code at `at` (3 or 4), or 0 if there is none.
 * @param {Uint8Array} bytes
 * @param {number} at
 */
function startCodeLength(bytes, at) {
  if (bytes[at] || bytes[at + 1]) return 0;
  return bytes[at + 2] === 1 ? 3 : bytes[at + 2] === 0 && bytes[at + 3] === 1 ? 4 : 0;
}

/**
 * Splits an Annex-B byte stream into NAL units.
 * @param {Uint8Array} bytes
 * @returns {{type: number, data: Uint8Array}[]}
 */
function nals(bytes) {
  const starts = [];
  for (let at = 0; at + 2 < bytes.length; at++) {
    const prefix = startCodeLength(bytes, at);
    if (!prefix) continue;
    starts.push({start: at, data: at + prefix});
    at += prefix - 1;
  }
  return starts.map((start, index) => {
    const end = starts[index + 1]?.start ?? bytes.length;
    const data = bytes.subarray(start.data, end);
    if (!data.length || data[0] & NAL_FORBIDDEN_BIT) throw Error('Invalid H.264 NAL header');
    return {type: data[0] & NAL_TYPE_MASK, data};
  });
}

/**
 * The last SPS and PPS in a byte stream, copied out, and whether it carries a B slice, from
 * one pass over its NAL units.
 * @param {Uint8Array} bytes
 * @returns {{sps?: Buffer, pps?: Buffer, bSlice: boolean}}
 */
function scanUnit(bytes) {
  const result = {bSlice: false};
  for (const nal of nals(bytes)) {
    if (nal.type === NAL_SPS) result.sps = Buffer.from(nal.data);
    if (nal.type === NAL_PPS) result.pps = Buffer.from(nal.data);
    result.bSlice ||= isBSlice(sliceType(nal.data));
  }
  return result;
}

/**
 * The last SPS and PPS in a byte stream, copied out.
 * @param {Uint8Array} bytes
 * @returns {{sps?: Buffer, pps?: Buffer}}
 */
function parameterSets(bytes) {
  const {bSlice, ...sets} = scanUnit(bytes);
  return sets;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Whether an 'au' metadata record is well formed for units of at most maxUnitBytes. */
function isValidRecord(record, maxUnitBytes) {
  return (
    isNonNegativeSafeInteger(record.seq) &&
    isNonNegativeSafeInteger(record.frame) &&
    Number.isSafeInteger(record.bytes) &&
    record.bytes >= 1 &&
    record.bytes <= maxUnitBytes &&
    typeof record.keyframe === 'boolean' &&
    isNonNegativeSafeInteger(record.pts)
  );
}

/**
 * @typedef {object} AccessUnitOptions
 * @property {number} [maxUnitBytes] largest accepted access unit
 * @property {number} [maxQueuedUnits] ready units held before pausing or dropping
 * @property {() => void} [onBacklog] switches to drop-to-keyframe mode; called per dropped unit
 * @property {() => number} [now] stamps each unit's arrivedAt with this clock when it is cut
 */

/** Async iterator of {...metadata, data} access units joined from a pipe and its metadata. */
class AccessUnits {
  /**
   * @param {import('node:stream').Readable} stream
   * @param {AccessUnitOptions} [options]
   */
  constructor(
    stream,
    {
      maxUnitBytes = DEFAULT_MAX_UNIT_BYTES,
      maxQueuedUnits = DEFAULT_MAX_QUEUED_UNITS,
      onBacklog,
      now
    } = {}
  ) {
    if (
      !Number.isSafeInteger(maxUnitBytes) ||
      maxUnitBytes < 1 ||
      maxUnitBytes > MAX_UNIT_BYTES_LIMIT
    )
      throw Error('Invalid access-unit bound');
    if (
      !Number.isInteger(maxQueuedUnits) ||
      maxQueuedUnits < 1 ||
      maxQueuedUnits > MAX_QUEUED_UNITS_LIMIT
    )
      throw Error('Invalid access-unit queue bound');
    this.stream = stream;
    this.maxUnitBytes = maxUnitBytes;
    this.maxQueuedUnits = maxQueuedUnits;
    this.onBacklog = onBacklog;
    this.now = now;
    this.dropping = false;
    this.dropped = 0;
    this.chunks = [];
    this.head = 0;
    this.bytes = 0;
    this.metadata = [];
    this.ready = [];
    this.sequence = null;
    this.ended = false;
    this.metadataEnded = false;
    this.error = null;
    this.waiter = null;
    this.closed = false;
    this.onData = chunk => {
      if (this.error || this.closed) return;
      if (!Buffer.isBuffer(chunk)) return this.fail(Error('H.264 output must be a binary pipe'));
      if (this.bytes + chunk.length > this.maxUnitBytes * BUFFERED_UNITS)
        return this.fail(Error('H.264 data exceeded the bounded access-unit buffer'));
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      this.pump();
    };
    this.onEnd = () => {
      this.ended = true;
      this.pump();
    };
    this.onError = error => this.fail(error);
    this.onClose = () => {
      if (!this.ended && !this.closed) this.fail(Error('H.264 output closed before EOF'));
    };
    stream.on('data', this.onData);
    stream.on('end', this.onEnd);
    stream.on('error', this.onError);
    stream.on('close', this.onClose);
  }

  /**
   * Queues one metadata record. Returns false for non-'au' records and for invalid ones, which
   * also fail the reader.
   * @param {any} record
   * @returns {boolean}
   */
  announce(record) {
    if (record?.type !== 'au') return false;
    try {
      if (!isValidRecord(record, this.maxUnitBytes))
        throw Error('Invalid H.264 access-unit metadata');
      if (this.sequence !== null && record.seq !== this.sequence + 1)
        throw Error('H.264 access-unit sequence discontinuity');
      if (this.metadataEnded) throw Error('H.264 metadata arrived after EOF');
      if (this.metadata.length >= MAX_PENDING_METADATA)
        throw Error('H.264 metadata queue exceeded its bound');
      this.sequence = record.seq;
      this.metadata.push({...record});
      this.pump();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /** Marks the metadata channel as finished. */
  endMetadata() {
    this.metadataEnded = true;
    this.pump();
  }

  /** Removes size bytes from the front of the chunk queue into one buffer. */
  take(size) {
    const result = Buffer.allocUnsafe(size);
    let at = 0;
    while (at < size) {
      const chunk = this.chunks[0];
      const count = Math.min(size - at, chunk.length - this.head);
      chunk.copy(result, at, this.head, this.head + count);
      this.head += count;
      at += count;
      if (this.head === chunk.length) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    this.bytes -= size;
    return result;
  }

  /**
   * Cuts every unit whose metadata and bytes are both present, applies backpressure or
   * backlog dropping, detects truncation at EOF and wakes a waiting next().
   */
  pump() {
    if (this.closed || this.error) return;
    while (
      (this.onBacklog || this.ready.length < this.maxQueuedUnits) &&
      this.metadata.length &&
      this.bytes >= this.metadata[0].bytes
    ) {
      const record = this.metadata.shift();
      const unit = {...record, data: this.take(record.bytes)};
      if (this.now) unit.arrivedAt = this.now();
      if (this.onBacklog && this.ready.length >= this.maxQueuedUnits) {
        this.dropped += this.ready.length;
        this.ready = [];
        this.dropping = true;
      }
      if (this.dropping) {
        if (!record.keyframe) {
          this.dropped++;
          this.onBacklog();
          continue;
        }
        this.dropping = false;
      }
      this.ready.push(unit);
    }
    if (!this.onBacklog && this.ready.length >= this.maxQueuedUnits) this.stream.pause();
    else this.stream.resume();
    if (this.ended && this.metadataEnded && this.ready.length < this.maxQueuedUnits) {
      if (this.metadata.length || this.bytes)
        return this.fail(Error('Truncated H.264 access unit or missing metadata'));
    }
    this.wake();
  }

  wake() {
    this.waiter?.();
    this.waiter = null;
  }

  fail(error) {
    if (this.error || this.closed) return;
    this.error = error;
    this.stream.pause();
    this.wake();
  }

  async next() {
    for (;;) {
      if (this.error) throw this.error;
      if (this.ready.length) {
        const value = this.ready.shift();
        this.pump();
        return {value, done: false};
      }
      if (this.closed || (this.ended && this.metadataEnded)) return {done: true};
      await new Promise(resolve => {
        this.waiter = resolve;
      });
    }
  }

  /** Stops cutting units and drains the pipe to EOF, so the writer is never cut off. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stream.removeListener('data', this.onData);
    this.stream.removeListener('end', this.onEnd);
    this.stream.removeListener('close', this.onClose);
    this.stream.resume();
    this.chunks = [];
    this.ready = [];
    this.metadata = [];
    this.bytes = 0;
    this.wake();
  }

  async return() {
    this.close();
    return {done: true};
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

export {AccessUnits, nals, parameterSets, scanUnit};
