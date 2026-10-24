// Joins the helper's Annex-B pipe with its access-unit metadata without blocking either pipe.
function nals(bytes) {
  const starts = [];
  for (let at = 0; at + 2 < bytes.length; at++) {
    if (bytes[at] || bytes[at + 1]) continue;
    const prefix = bytes[at + 2] === 1 ? 3 : bytes[at + 2] === 0 && bytes[at + 3] === 1 ? 4 : 0;
    if (!prefix) continue;
    starts.push({start: at, data: at + prefix});
    at += prefix - 1;
  }
  return starts.map((start, index) => {
    const end = starts[index + 1]?.start ?? bytes.length;
    const data = bytes.subarray(start.data, end);
    if (!data.length || data[0] & 128) throw Error('Invalid H.264 NAL header');
    return {type: data[0] & 31, data};
  });
}

function parameterSets(bytes) {
  const result = {};
  for (const nal of nals(bytes)) {
    if (nal.type === 7) result.sps = Buffer.from(nal.data);
    if (nal.type === 8) result.pps = Buffer.from(nal.data);
  }
  return result;
}

class AccessUnits {
  constructor(stream, {maxUnitBytes = 16 * 1024 * 1024, maxQueuedUnits = 4, onBacklog} = {}) {
    if (!Number.isSafeInteger(maxUnitBytes) || maxUnitBytes < 1 || maxUnitBytes > 64 * 1024 * 1024)
      throw Error('Invalid access-unit bound');
    if (!Number.isInteger(maxQueuedUnits) || maxQueuedUnits < 1 || maxQueuedUnits > 64)
      throw Error('Invalid access-unit queue bound');
    this.stream = stream;
    this.maxUnitBytes = maxUnitBytes;
    this.maxQueuedUnits = maxQueuedUnits;
    this.onBacklog = onBacklog;
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
      if (this.bytes + chunk.length > this.maxUnitBytes * 2)
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

  announce(record) {
    if (record?.type !== 'au') return false;
    try {
      if (
        !Number.isSafeInteger(record.seq) ||
        record.seq < 0 ||
        !Number.isSafeInteger(record.frame) ||
        record.frame < 0 ||
        !Number.isSafeInteger(record.bytes) ||
        record.bytes < 1 ||
        record.bytes > this.maxUnitBytes ||
        typeof record.keyframe !== 'boolean' ||
        !Number.isSafeInteger(record.pts) ||
        record.pts < 0
      )
        throw Error('Invalid H.264 access-unit metadata');
      if (this.sequence !== null && record.seq !== this.sequence + 1)
        throw Error('H.264 access-unit sequence discontinuity');
      if (this.metadataEnded) throw Error('H.264 metadata arrived after EOF');
      if (this.metadata.length >= 128) throw Error('H.264 metadata queue exceeded its bound');
      this.sequence = record.seq;
      this.metadata.push({...record});
      this.pump();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  endMetadata() {
    this.metadataEnded = true;
    this.pump();
  }

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

  pump() {
    if (this.closed || this.error) return;
    while (
      (this.onBacklog || this.ready.length < this.maxQueuedUnits) &&
      this.metadata.length &&
      this.bytes >= this.metadata[0].bytes
    ) {
      const record = this.metadata.shift();
      const unit = {...record, data: this.take(record.bytes)};
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

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stream.pause();
    this.stream.removeListener('data', this.onData);
    this.stream.removeListener('end', this.onEnd);
    this.stream.removeListener('error', this.onError);
    this.stream.removeListener('close', this.onClose);
    this.stream.destroy();
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

module.exports = {AccessUnits, nals, parameterSets};
