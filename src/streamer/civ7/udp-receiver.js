// Console side of the UDP video transport, shipped by payload.js with toString(): drains datagrams
// with RecvMMsg straight into the predicted unit offsets, NACKs gaps and drops late units in order;
// civ7/README.md, "UDP transport". The PC side and the wire constants are in udp-video.js.

/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */
/** @import {ReceiveBufferRequest, ReceiveBufferReport} from './socket-options.js' */

/**
 * @typedef {Pick<ConsoleNative, 'address' | 'integer' | 'checkMemory' | 'verified' | 'call' | 'read32' |
 *   'read64' | 'write64' | 'writeBuffer' | 'encode' | 'socket' | 'connect' | 'receive' | 'send' | 'close'> & {
 *   now?: () => number, setReceiveBuffer?: typeof import('./socket-options.js').setReceiveBuffer}} UdpReceiverNative
 */

/**
 * A whole unit in its slot of `units`, valid until the decoder copied it (the PC sends a slot's
 * next unit only after this one is acknowledged or dropped).
 * @typedef {{source: bigint, length: number, sequence: number, pts: bigint, keyframe: boolean,
 *   firstAt: number, completedAt: number}} UdpUnit
 */

/**
 * @param {UdpReceiverNative} native
 * @param {ConsoleRequest} config the request's `stream.udp` plus `host`, `units`, `capacity` and `control`
 * @param {{pump?: () => void, control: (pointer: bigint, length: number) => void}} hooks `control`
 *   sends bytes on the TCP video socket (drop blocks)
 */
export function createUdpReceiver(native, config, hooks) {
  const {address, integer, checkMemory, verified, call, read32, read64, write64, writeBuffer, encode,
    socket, connect, receive, send, close} = native;
  const now = native.now || (() => Date.now());
  const magic = 0x31564455;
  const helloMagic = 0x48564455;
  const nackMagic = 0x314e4455;
  const statsMagic = 0x31534455;
  const dropMagic = 0x31505244;
  const headerBytes = 40;
  const fragmentBytes = 1360;
  const keyFlag = 1;
  const endFlag = 2;
  const resendFlag = 4;
  const dropLate = 1;
  const dropSkipped = 2;
  const unitSlots = 8;
  const slotCount = 64;
  const slotBytes = headerBytes + fragmentBytes;
  const nonBlocking = 0x80;
  const nackRanges = 16;
  const nackRangeLimit = 256;
  const at = {poll: 0x20n, report: 0x40n, hello: 0x100n, nack: 0x200n, stats: 0x300n, drop: 0x380n,
    peek: 0x3c0n, vectors: 0x1000, iov: 0x2000, slots: 0x3000};
  const statNames = ['received', 'lost', 'repaired', 'nacks', 'lateDrops', 'reorders', 'drainCalls',
    'drainUs', 'duplicates', 'skipped', 'stale', 'copies'];

  if (typeof config.host !== 'string' || typeof config.token !== 'string' || !/^[0-9a-f]{64}$/.test(config.token))
    throw Error('Invalid UDP video endpoint');
  const host = config.host.split('.').map(value => integer(Number(value), 0, 255));
  if (host.length !== 4) throw Error('Invalid UDP video endpoint');
  const port = integer(config.port, 1, 65535);
  const area = address(config.buffer);
  checkMemory(area, at.slots + slotCount * slotBytes, 3);
  const units = address(config.units);
  const capacity = integer(config.capacity, unitSlots * fragmentBytes, 8 * 1024 * 1024);
  checkMemory(units, capacity, 3);
  const unitBytes = Math.floor(capacity / unitSlots);
  const maxFragments = Math.ceil(unitBytes / fragmentBytes);
  const deadlineMs = integer(config.deadlineUs, 1000, 1000000) / 1000;
  const spreadMs = integer(config.spreadUs, 0, 1000000) / 1000;
  const paceBytesPerMs = integer(config.paceBytesPerMs, 100, 1000000);
  const helloMs = config.helloMs === undefined ? 10000 : integer(config.helloMs, 100, 60000);
  const control = /** @type {bigint} */ (config.control);
  if (typeof control !== 'bigint' || control < 0n) throw Error('Invalid UDP video control socket');

  const functions = /** @type {Record<string, unknown>} */ (config.functions || {});
  /** @param {string} name */
  const required = name => {
    const pointer = address(functions[name]);
    if (!verified.has('0x' + pointer.toString(16))) throw Error('Unverified UDP video function: ' + name);
    return pointer;
  };
  const copy = required('copy');
  const errno = required('errno');
  const poll = required('poll');
  const recvMMsg = required('recvMMsg');

  const frameOf = new Float64Array(unitSlots).fill(-1);
  const knownFrame = new Float64Array(unitSlots).fill(-1);
  const knownAt = new Float64Array(unitSlots);
  const firstAt = new Float64Array(unitSlots);
  const completedAt = new Float64Array(unitSlots);
  const counts = new Uint16Array(unitSlots);
  const got = new Uint16Array(unitSlots);
  const lengths = new Uint32Array(unitSlots);
  const sequences = new Uint32Array(unitSlots);
  const keys = new Uint8Array(unitSlots);
  /** @type {bigint[]} */
  const pts = new Array(unitSlots).fill(0n);
  const bitmap = new Uint8Array(unitSlots * maxFragments);
  /** @type {bigint[]} */
  const slots = [];
  for (let index = 0; index < slotCount; index++) slots.push(area + BigInt(at.slots + index * slotBytes));
  /** @type {bigint[]} each entry's payload iov base as last written */
  const landing = slots.map(slot => slot + BigInt(headerBytes));
  const expectFrame = new Float64Array(slotCount).fill(-1);
  const expectIndex = new Float64Array(slotCount);
  const seqs = new Float64Array(slotCount);
  const frames = new Float64Array(slotCount);
  const hits = new Uint8Array(slotCount);
  const firstSeqs = new Float64Array(unitSlots);
  /** @type {Record<string, number>} */
  const counters = {};
  for (const name of [...statNames, 'foreign', 'invalid', 'hellos']) counters[name] = 0;
  /** @type {number[]} */
  const gaps = [];
  const block = new Uint8Array(16);
  const blockView = new DataView(block.buffer);
  let nextFrame = 0;
  let highestFrame = -1;
  let expectedSeq = 0;
  let endFrame = -1;
  let awaitingKey = false;
  let cursorFrame = 0;
  let cursorIndex = 0;
  let ring = 0;
  let batchLimit = slotCount;
  let lastDrain = now();
  let perMs = 0;
  let rateAt = now();
  let rateReceived = 0;
  let scatter = true;
  let heard = false;
  let lastHello = -Infinity;
  let lastStats = now();
  let lastControl = now();
  const started = now();

  /** @param {bigint} value */
  const signed = value => Number(BigInt.asIntN(32, value));
  /** @param {number} slot */
  const unitAddress = slot => units + BigInt(slot * unitBytes);

  /**
   * The unit's repair deadline from when it became known; one never seen gets the base alone.
   * Mirrors udp-video.js frameDeadlineMs.
   * @param {number} slot
   * @param {boolean} seen
   */
  function deadline(slot, seen) {
    if (!seen) return deadlineMs;

    const base = keys[slot] ? 2 * deadlineMs : deadlineMs;
    return base + Math.max(spreadMs, lengths[slot] / paceBytesPerMs);
  }

  /**
   * @param {number} frame
   * @param {number} time
   */
  function markKnown(frame, time) {
    const slot = frame % unitSlots;
    if (knownFrame[slot] === frame) return;

    knownFrame[slot] = frame;
    knownAt[slot] = time;
  }

  /**
   * @param {number} first
   * @param {number} count
   */
  function gap(first, count) {
    counters.lost += count;
    if (gaps.length < nackRanges * 2) gaps.push(first, Math.min(count, nackRangeLimit));
  }

  /**
   * Moves the seq and the predicted position past the newest datagram.
   * @param {number} seq
   * @param {number} flags
   * @param {number} frame
   * @param {number} index
   * @param {number} count
   */
  function track(seq, flags, frame, index, count) {
    if (seq < expectedSeq) {
      if (!(flags & resendFlag)) counters.reorders++;
      return;
    }

    if (seq > expectedSeq) gap(expectedSeq, seq - expectedSeq);
    expectedSeq = seq + 1;
    const last = index + 1 >= count;
    cursorFrame = last ? frame + 1 : frame;
    cursorIndex = last ? 0 : index + 1;
  }

  /**
   * @param {number} reason
   */
  function dropFrame(reason) {
    const slot = nextFrame % unitSlots;
    if (reason === dropLate) {
      counters.lateDrops++;
      awaitingKey = true;
    } else {
      counters.skipped++;
    }

    blockView.setUint32(0, dropMagic, true);
    blockView.setUint32(4, nextFrame >>> 0, true);
    blockView.setUint32(8, reason, true);
    blockView.setUint32(12, 0, true);
    writeBuffer(area + at.drop, block);
    hooks.control(area + at.drop, block.length);
    frameOf[slot] = -1;
    knownFrame[slot] = -1;
    nextFrame++;
  }

  /**
   * Starts a unit's slot from its first datagram; false for an inconsistent header.
   * @param {bigint} pointer
   * @param {number} slot
   * @param {number} frame
   * @param {number} count
   * @param {number} flags
   * @param {number} time
   */
  function open(pointer, slot, frame, count, flags, time) {
    const sizes = read64(pointer + 16n);
    const length = Number(sizes & 0xffffffffn);
    const lengthOk = length >= 1 && length <= unitBytes;
    const countOk = count >= 1 && count === Math.ceil(length / fragmentBytes);
    if (!lengthOk || !countOk) {
      counters.invalid++;
      return false;
    }

    frameOf[slot] = frame;
    counts[slot] = count;
    got[slot] = 0;
    lengths[slot] = length;
    sequences[slot] = Number(sizes >> 32n);
    pts[slot] = read64(pointer + 24n);
    keys[slot] = flags & keyFlag ? 1 : 0;
    firstAt[slot] = time;
    completedAt[slot] = -1;
    bitmap.fill(0, slot * maxFragments, slot * maxFragments + count);
    markKnown(frame, time);
    return true;
  }

  /**
   * Books one fragment into its unit slot; a payload that did not land in place takes one
   * native copy from `payload`, never a byte loop.
   * @param {bigint} pointer the datagram's header
   * @param {bigint | null} payload null when RecvMMsg wrote it in place
   * @param {number} seq
   * @param {number} frame
   * @param {number} packed
   * @param {number} time
   */
  function place(pointer, payload, seq, frame, packed, time) {
    const index = packed & 0xfff;
    const count = (packed >>> 12) & 0xfff;
    const flags = packed >>> 24;
    if (frame < nextFrame) {
      counters.stale++;
      return;
    }
    while (frame >= nextFrame + unitSlots) dropFrame(awaitingKey ? dropSkipped : dropLate);

    const slot = frame % unitSlots;
    if (frameOf[slot] !== frame && !open(pointer, slot, frame, count, flags, time)) return;
    if (index >= counts[slot] || count !== counts[slot]) {
      counters.invalid++;
      return;
    }
    const bit = slot * maxFragments + index;
    if (bitmap[bit]) {
      counters.duplicates++;
      return;
    }

    bitmap[bit] = 1;
    got[slot]++;
    counters.received++;
    if (flags & resendFlag) counters.repaired++;
    if (index === 0) firstSeqs[slot] = seq;
    if (payload !== null) {
      const offset = index * fragmentBytes;
      const bytes = Math.min(fragmentBytes, lengths[slot] - offset);
      call(copy, unitAddress(slot) + BigInt(offset), payload, BigInt(bytes));
      counters.copies++;
    }
    if (got[slot] === counts[slot]) completedAt[slot] = time;

    if (frame <= highestFrame) return;
    for (let earlier = Math.max(highestFrame + 1, nextFrame); earlier < frame; earlier++) markKnown(earlier, time);
    highestFrame = frame;
  }

  /**
   * A datagram that landed where predicted in an open unit needs no further header read.
   * @param {number} entry
   * @param {number} seq
   * @param {number} frame
   * @param {bigint | null} payload where its payload sits when not in place
   * @param {number} time
   */
  function accept(entry, seq, frame, payload, time) {
    const pointer = slots[entry];
    const slot = frame % unitSlots;
    heard = true;
    if (payload === null && frameOf[slot] === frame) {
      const index = expectIndex[entry];
      const count = counts[slot];
      track(seq, 0, frame, index, count);
      place(pointer, null, seq, frame, index | count << 12, time);
      return;
    }

    const first = read64(pointer);
    if (Number(first & 0xffffffffn) !== magic) {
      counters.foreign++;
      return;
    }
    const packed = Number(first >> 32n);
    const flags = packed >>> 24;
    if (flags & endFlag) {
      endFrame = frame;
      return;
    }
    const index = packed & 0xfff;
    const inPlace = payload === null && index === expectIndex[entry];
    const source = inPlace ? null : landing[entry];
    track(seq, flags, frame, index, (packed >>> 12) & 0xfff);
    place(pointer, payload ?? source, seq, frame, packed, time);
  }

  /**
   * Whether the fragment may be written in place before it arrives: an unfilled position of a
   * unit inside the window whose slot holds no other unit.
   * @param {number} frame
   * @param {number} index
   */
  function usable(frame, index) {
    const ahead = frame >= nextFrame && frame < nextFrame + unitSlots;
    if (!ahead || (index + 1) * fragmentBytes > unitBytes) return false;

    const slot = frame % unitSlots;
    if (frameOf[slot] === frame) return !bitmap[slot * maxFragments + index];
    return frameOf[slot] === -1;
  }

  /**
   * Points the entry's payload iov at the fragment's place, or back at its own slot; writes
   * only when that changes.
   * @param {number} entry
   * @param {number} frame
   * @param {number} index
   */
  function aim(entry, frame, index) {
    const safe = usable(frame, index);
    const same = safe ? expectFrame[entry] === frame && expectIndex[entry] === index : expectFrame[entry] < 0;
    if (same) return;

    const offset = BigInt(index * fragmentBytes);
    const target = safe ? unitAddress(frame % unitSlots) + offset : slots[entry] + BigInt(headerBytes);
    expectFrame[entry] = safe ? frame : -1;
    expectIndex[entry] = index;
    write64(area + BigInt(at.iov + entry * 32 + 16), target);
    landing[entry] = target;
  }

  /**
   * Aims the batch's entries at the next in-order datagrams. Batches start where the last one
   * ended, so an entry keeps its seq and its iov from one drain to the next.
   * @param {number} first
   * @param {number} batch
   */
  function predict(first, batch) {
    let frame = cursorFrame;
    let index = cursorIndex;
    for (let entry = first; entry < first + batch; entry++) {
      const slot = frame % unitSlots;
      if (frameOf[slot] === frame && index >= counts[slot]) {
        frame++;
        index = 0;
      }
      aim(entry, frame, index);
      index++;
    }
  }

  /**
   * Books a batch: payloads that landed in a unit but belong elsewhere move to their own slot
   * first, so no fix-up copy overwrites another entry's bytes.
   * @param {number} first
   * @param {number} count
   * @param {number} base
   * @param {number} time
   */
  function settle(first, count, base, time) {
    for (let entry = first; entry < first + count; entry++) {
      const word = read64(slots[entry] + 8n);
      seqs[entry] = Number(word & 0xffffffffn);
      frames[entry] = Number(word >> 32n);
      const guessed = expectFrame[entry] >= 0;
      const hit = guessed && seqs[entry] === base + entry - first && frames[entry] === expectFrame[entry];
      hits[entry] = hit ? 1 : 0;
      if (!guessed || hit) continue;

      call(copy, slots[entry] + BigInt(headerBytes), landing[entry], BigInt(fragmentBytes));
      counters.copies++;
    }

    for (let entry = first; entry < first + count; entry++) {
      const payload = hits[entry] ? null : slots[entry] + BigInt(headerBytes);
      accept(entry, seqs[entry], frames[entry], payload, time);
    }
  }

  function sendNack() {
    const ranges = gaps.length / 2;
    const message = new Uint8Array(8 + gaps.length * 4);
    const view = new DataView(message.buffer);
    view.setUint32(0, nackMagic, true);
    view.setUint32(4, ranges, true);
    gaps.forEach((value, index) => view.setUint32(8 + index * 4, value >>> 0, true));
    gaps.length = 0;

    writeBuffer(area + at.nack, message);
    send(channel, area + at.nack, message.length, 0);
    counters.nacks++;
  }

  /**
   * Entries worth predicting: the datagrams due since the last drain at the recent rate, with
   * margin, since a wrong guess costs a word write and a missing one a native copy.
   * @param {number} time
   */
  function expected(time) {
    if (time - rateAt >= 100) {
      perMs = (counters.received - rateReceived) / (time - rateAt);
      rateAt = time;
      rateReceived = counters.received;
    }

    const due = Math.ceil(1.5 * perMs * (time - lastDrain)) + 8;
    lastDrain = time;
    return Math.min(slotCount, Math.max(16, due));
  }

  /** Back to one 1400-byte iov per entry, for a RecvMMsg that refuses two. */
  function unscatter() {
    scatter = false;
    for (let entry = 0; entry < slotCount; entry++) {
      aim(entry, -1, 0);
      write64(area + BigInt(at.vectors + entry * 56 + 0x18), 1n);
      write64(area + BigInt(at.iov + entry * 32 + 8), BigInt(slotBytes));
    }
  }

  /**
   * Datagrams waiting now, by RecvMMsg over the entry ring; a short batch ends the drain. Only
   * a drain the Poll asked for (`confirmed`) reads the errno of an empty one.
   * @param {boolean} confirmed
   * @param {number} [batches] bounds background work while the decoder runs
   */
  function drain(confirmed, batches = Infinity) {
    let total = 0;
    for (let batchIndex = 0; batchIndex < batches; batchIndex++) {
      const startedAt = now();
      const first = ring;
      const batch = Math.min(slotCount - first, batchLimit, expected(startedAt));
      if (scatter) predict(first, batch);
      const base = expectedSeq;
      const count = signed(call(recvMMsg, channel, area + BigInt(at.vectors + first * 56), BigInt(batch),
        BigInt(nonBlocking), 0n));
      counters.drainCalls++;
      if (count < 0) {
        const error = confirmed ? Number(call(errno) & 0xffffffffn) : 11;
        counters.drainUs += (now() - startedAt) * 1000;
        if (error === 11 || error === 4) break;
        if (error === 22 && batch > 1) {
          batchLimit = Math.max(1, batch >> 1);
          continue;
        }
        if (!scatter) throw Error('UDP video receive failed: ' + error);
        unscatter();
        batchLimit = slotCount;
        continue;
      }

      const taken = Math.min(count, batch);
      settle(first, taken, base, now());
      ring = (first + taken) % slotCount;
      counters.drainUs += (now() - startedAt) * 1000;
      total += taken;
      if (taken < batch) break;
    }

    if (gaps.length) sendNack();
    return total;
  }

  /**
   * The next unit's slot once whole, -1 while it may still complete, -2 after the end marker.
   * Drops it (and, awaiting a keyframe, every dependent unit) past its deadline. The end marker
   * makes every unit before it known, so one lost whole at the tail still gets its drop.
   * @param {number} time
   */
  function head(time) {
    for (;;) {
      if (endFrame >= 0 && nextFrame >= endFrame) return -2;
      if (endFrame >= 0) markKnown(nextFrame, time);

      const slot = nextFrame % unitSlots;
      const seen = frameOf[slot] === nextFrame;
      const known = knownFrame[slot] === nextFrame;
      const dependent = seen && !keys[slot];
      if (awaitingKey && dependent) {
        dropFrame(dropSkipped);
        continue;
      }
      if (seen && got[slot] === counts[slot]) return slot;
      if (!known || time - knownAt[slot] <= deadline(slot, seen)) return -1;

      dropFrame(awaitingKey ? dropSkipped : dropLate);
    }
  }

  /**
   * @param {number} slot
   * @returns {UdpUnit}
   */
  function deliver(slot) {
    const unit = {source: unitAddress(slot), length: lengths[slot], sequence: sequences[slot], pts: pts[slot],
      keyframe: Boolean(keys[slot]), firstAt: knownAt[slot], completedAt: completedAt[slot]};
    if (keys[slot]) awaitingKey = false;
    frameOf[slot] = -1;
    knownFrame[slot] = -1;
    nextFrame++;
    return unit;
  }

  /** @param {number} time */
  function report(time) {
    if (time - lastStats < 1000) return;

    lastStats = time;
    const message = new Uint8Array(8 + statNames.length * 4);
    const view = new DataView(message.buffer);
    view.setUint32(0, statsMagic, true);
    view.setUint32(4, statNames.length, true);
    statNames.forEach((name, index) => view.setUint32(8 + index * 4, Math.round(counters[name]) >>> 0, true));
    writeBuffer(area + at.stats, message);
    send(channel, area + at.stats, message.length, 0);
  }

  /** @param {number} time */
  function controlClosed(time) {
    if (time - lastControl < 50) return false;

    lastControl = time;
    const count = signed(receive(control, area + at.peek, 1, 0x82));
    if (count > 0) throw Error('Unexpected data on the UDP video control socket');
    return count === 0;
  }

  /** @param {number} time */
  function sayHello(time) {
    if (heard || time - lastHello < 200) return;
    if (time - started > helloMs) throw Error('No UDP video arrived');

    if (signed(send(channel, area + at.hello, 68, 0)) !== 68) throw Error('UDP video hello failed');
    counters.hellos++;
    lastHello = time;
  }

  function prepare() {
    const endpoint = new Uint8Array(16);
    endpoint.set([16, 2, port >> 8, port & 255, ...host]);
    writeBuffer(area, endpoint);

    const hello = new Uint8Array(68);
    new DataView(hello.buffer).setUint32(0, helloMagic, true);
    hello.set(encode(/** @type {string} */ (config.token)), 4);
    writeBuffer(area + at.hello, hello);

    for (let index = 0; index < slotCount; index++) {
      const iov = area + BigInt(at.iov + index * 32);
      const vector = area + BigInt(at.vectors + index * 56);
      write64(iov, slots[index]);
      write64(iov + 8n, BigInt(headerBytes));
      write64(iov + 16n, landing[index]);
      write64(iov + 24n, BigInt(fragmentBytes));
      for (let word = 0n; word < 56n; word += 8n) write64(vector + word, 0n);
      write64(vector + 0x10n, iov);
      write64(vector + 0x18n, 2n);
    }
  }

  prepare();
  const channel = socket(2, 2, 17);
  if (channel < 0n) throw Error('UDP video socket failed');
  /** @type {ReceiveBufferReport | null} */
  let receiveBuffer = null;
  try {
    const bufferRequest = /** @type {ReceiveBufferRequest | undefined} */ (config.receiveBuffer);
    if (bufferRequest && native.setReceiveBuffer)
      receiveBuffer = native.setReceiveBuffer(native, channel, bufferRequest);
    if (connect(channel, area, 16) !== 0n) throw Error('UDP video connect failed');

    const descriptor = new Uint8Array(8);
    const view = new DataView(descriptor.buffer);
    view.setInt32(0, Number(channel), true);
    view.setInt16(4, 1, true);
    writeBuffer(area + at.poll, descriptor);
    sayHello(now());
  } catch (error) {
    close(channel);
    throw error;
  }

  const buffered = () => {
    const slot = nextFrame % unitSlots;
    return frameOf[slot] === nextFrame && got[slot] === counts[slot];
  };

  return {
    buffered,
    pump() {
      if (buffered()) return 0;
      return drain(false, 1);
    },
    /** The next whole unit in order, or null once the stream ended; never waits past a deadline. */
    next() {
      let readable = true;
      let confirmed = false;
      for (;;) {
        const time = now();
        report(time);
        const slot = head(time);
        if (slot >= 0) return deliver(slot);
        if (slot === -2) return null;
        if (readable) {
          readable = false;
          if (drain(confirmed) > 0) continue;
        }
        if (controlClosed(time)) return null;

        hooks.pump?.();
        sayHello(now());
        readable = signed(call(poll, area + at.poll, 1n, 1n)) !== 0;
        confirmed = readable;
      }
    },
    /** Like videoStream's socket peek: depth 2 when a later unit started behind a whole one. */
    peek() {
      drain(false);
      const slot = head(now());
      if (slot < 0) return {depth: 0, whole: false};

      const following = (nextFrame + 1) % unitSlots;
      const started = frameOf[following] === nextFrame + 1;
      return {depth: started ? 2 : 1, whole: true};
    },
    get receiveBuffer() { return receiveBuffer; },
    /** Time spent draining so far, for the loop block's `receive`. */
    get drainMs() { return counters.drainUs / 1000; },
    stats() {
      /** @type {Record<string, number>} */
      const stats = {};
      for (const name of Object.keys(counters)) stats[name] = Math.round(counters[name]);
      return {...stats, frames: nextFrame, awaitingKey, scatter, batchLimit};
    },
    close() { close(channel); }
  };
}
