/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */
/** @import {DecodeNative, DecodeUnit, DecodeStage} from './decode-batch.js' */
/** @import {AudioConfiguration} from './audio.js' */
/** @import {InputMapping} from '../input/input-record.js' */
/** @import {ReceiveBufferRequest, ReceiveBufferReport} from './socket-options.js' */

/**
 * @typedef {DecodeNative & Pick<ConsoleNative, 'writeBuffer' | 'encode' | 'socket' | 'connect' | 'receive' |
 *   'send' | 'close'> & {
 *   decodeBatch: typeof import('./decode-batch.js').decodeBatch,
 *   createInputReader: typeof import('./input.js').createInputReader,
 *   createInputRecorder: typeof import('../input/input-record.js').createInputRecorder,
 *   inputMapping: InputMapping,
 *   createAudioPump: typeof import('./audio.js').createAudioPump,
 *   createJitterQueue: typeof import('./audio-queue.js').createJitterQueue,
 *   crossfadePcm: typeof import('./audio-queue.js').crossfadePcm,
 *   serviceControl?: () => void, ui?: {poll(): void, allowInput(): boolean, interactive?: () => boolean} | null,
 *   setReceiveBuffer?: typeof import('./socket-options.js').setReceiveBuffer,
 *   createUdpReceiver: typeof import('./udp-receiver.js').createUdpReceiver,
 *   now?: () => number}} VideoStreamNative
 */

/** @typedef {ReturnType<typeof import('./udp-receiver.js').createUdpReceiver>} UdpReceiver */

/**
 * @typedef {DecodeUnit & {echo: Uint8Array, sequence: number, header: number, arrived: number,
 *   decoded: number, presented: number, input: number}} StreamUnit  marks in console ms, -1 unset
 */

/**
 * Console side, shipped by payload.js with toString(). Units arrive over UDP (udp-receiver.js);
 * the TCP socket carries the token, acknowledgements and drop blocks. Each acknowledgement is
 * followed by a timing block (latency.js TIMING) stamped on `native.now`, the clock of the `time`
 * command, and once a second by the loop block (latency.js LOOP).
 * @param {VideoStreamNative} native
 * @param {ConsoleRequest} request
 */
export function videoStream(native, request) {
  const {address, integer, checkMemory, read32, write64, writeBuffer, encode,
    socket, connect, send, close} = native;
  const stream = /** @type {ConsoleRequest} */ (request.stream);
  if (typeof stream.host !== 'string') throw Error('Invalid video host');
  const host = stream.host.split('.').map(Number);
  if (host.length !== 4 || host.some(value => !Number.isInteger(value) || value < 0 || value > 255))
    throw Error('Invalid video host');
  const port = integer(stream.port, 1, 65535);
  const token = typeof stream.token === 'string' ? stream.token : '';
  if (!/^[0-9a-f]{64}$/.test(token)) throw Error('Invalid video token');
  if (typeof stream.udp !== 'object' || stream.udp === null) throw Error('Missing UDP video settings');
  const header = address(stream.header);
  const capacity = integer(stream.capacity, 1, 8 * 1024 * 1024);
  const frames = integer(stream.frames, 1, 0x7fffffff);
  const fps = stream.fps === undefined ? 60 : integer(stream.fps, 1, 240);
  checkMemory(header, 0x1000, 3);
  const input = request.input ? native.createInputReader(native, /** @type {ConsoleRequest} */ (request.input)) : null;
  const buttons = stream.buttons === 'labels' ? 'labels' : 'position';
  const recorder = input ? native.createInputRecorder(native.inputMapping, buttons) : null;
  const audio = request.audio
    ? native.createAudioPump(native, /** @type {AudioConfiguration} */ (request.audio)) : null;
  let channel = -1n;
  /** @type {ReceiveBufferReport | null} */
  let receiveBuffer = null;
  let lastAudio = 0;
  let lastControl = 0;
  let lastVideo = 0;
  let pumpingVideo = false;
  const now = native.now || (() => Date.now());
  const timingMagic = 0x314d4954;
  const timingNone = 0xffffffff;
  const loopMagic = 0x32504f4c;
  const loopStages = ['idle', 'receive', 'submit', 'decodeWait', 'output', 'present', 'ack', 'acquire', 'gpuWait'];
  /** Acks are laid out here and stored to `header` a word at a time: a byte store costs as much. */
  const ack = new Uint8Array(0x1000);
  const ackView = new DataView(ack.buffer);
  let ackLength = 0;
  let lastAllowed = true;
  /** @type {Record<string, number>} */
  const loop = {started: now(), units: 0, presented: 0, pipelined: 0, latencySum: 0, latencyMax: 0,
    overlapped: 0, hidden: 0};
  for (const stage of loopStages) loop[stage] = 0;
  /** @type {import('./present-batch.js').Present | null} */
  let presentation = null;
  let presentTimings = {acquire: 0, wait: 0};
  /** @type {{depth: number, whole: boolean} | null} */
  let peeked = null;
  /** @type {UdpReceiver | null} */
  let datagrams = null;

  function pump() {
    const now = Date.now();
    if (audio && now - lastAudio >= 2) { audio.pump(); lastAudio = now; }
    if (now - lastControl >= 8) { native.serviceControl?.(); lastControl = now; }
    if (stream.overlapOutput === true && datagrams && !pumpingVideo && now - lastVideo >= 2) {
      lastVideo = now;
      pumpingVideo = true;
      try { datagrams.pump(); }
      finally { lastVideo = Date.now(); pumpingVideo = false; }
    }
    if (audio && Date.now() - lastAudio >= 2) { audio.pump(); lastAudio = Date.now(); }
  }

  /**
   * Sends all `length` bytes on the TCP socket, pumping audio while a send would block.
   * @param {bigint} pointer
   * @param {number} length
   */
  function transfer(pointer, length) {
    let offset = 0;
    while (offset < length) {
      if (audio) pump();
      const count = Number(send(channel, pointer + BigInt(offset), length - offset, audio ? 0x80 : 0));
      if (count < 0 && audio) { audio.retry(); continue; }
      if (count <= 0 || count > length - offset) throw Error('Video transfer failed: ' + count);
      offset += count;
    }
  }

  /**
   * @param {number} baseUs
   * @param {number} mark ms, or -1 when not reached
   */
  function since(baseUs, mark) {
    if (mark < 0) return timingNone;

    const offset = Math.round(mark * 1000) - baseUs;
    return Math.min(Math.max(offset, 0), timingNone - 1);
  }

  /** @param {number} value */
  function stageWord(value) {
    ackView.setUint32(ackLength, value, true);
    ackLength += 4;
  }

  /** @param {Uint8Array} bytes */
  function stageBytes(bytes) {
    ack.set(bytes, ackLength);
    ackLength += bytes.length;
  }

  /** @param {StreamUnit} unit */
  function stampTiming(unit) {
    const baseUs = Math.floor(unit.header * 1000);
    const high = Math.floor(baseUs / 0x100000000);

    stageWord(timingMagic);
    stageWord(unit.sequence);
    stageWord(baseUs - high * 0x100000000);
    stageWord(high);
    stageWord(since(baseUs, unit.arrived));
    stageWord(since(baseUs, unit.decoded));
    stageWord(since(baseUs, unit.presented));
    stageWord(since(baseUs, unit.input));
  }

  /** The last second's loop totals in µs after the timing block, then a fresh second. */
  function stampLoop() {
    const at = now();
    if (at - loop.started < 1000) return;

    const timings = presentation?.timings;
    if (timings) {
      loop.acquire = timings.acquire - presentTimings.acquire;
      loop.gpuWait = timings.wait - presentTimings.wait;
      presentTimings = {acquire: timings.acquire, wait: timings.wait};
    }
    const micro = (/** @type {number} */ ms) => Math.min(Math.max(Math.round(ms * 1000), 0), timingNone - 1);
    stageWord(loopMagic);
    stageWord(loop.units);
    stageWord(loop.presented);
    stageWord(loop.pipelined);
    stageWord(micro(at - loop.started));
    for (const stage of loopStages) stageWord(micro(loop[stage]));
    stageWord(micro(loop.latencySum));
    stageWord(micro(loop.latencyMax));
    stageWord(loop.overlapped);
    stageWord(micro(loop.hidden));

    loop.started = at;
    for (const key of ['units', 'presented', 'pipelined', 'latencySum', 'latencyMax', 'overlapped', 'hidden',
      ...loopStages]) loop[key] = 0;
  }

  /** Sends the staged ack, with the loop block when a second has passed. */
  function flushAcks() {
    if (!ackLength) return;

    const started = now();
    stampLoop();
    for (let offset = 0; offset < ackLength; offset += 8)
      write64(header + BigInt(offset), ackView.getBigUint64(offset, true));
    transfer(header, ackLength);
    ackLength = 0;
    loop.ack += now() - started;
  }

  /**
   * The unit's input record: none when the reader is steady and input was allowed as before,
   * where the recorder would find no change.
   * @param {StreamUnit} unit
   */
  function sampleInput(unit) {
    const reads = /** @type {NonNullable<typeof input>} */ (input)();
    unit.input = now();
    native.ui?.poll();
    const allowed = native.ui?.allowInput() ?? true;
    const unchanged = reads.steady && allowed === lastAllowed;
    lastAllowed = allowed;
    if (unchanged) return null;

    const record = /** @type {NonNullable<typeof recorder>} */ (recorder)(reads.pad, reads.touch, allowed);
    return record ? encode(JSON.stringify(record)) : null;
  }

  /**
   * Stages the unit's echo, its input record and timing block and sends them. `header` may hold
   * the next unit's header.
   * @param {StreamUnit} unit
   */
  function acknowledge(unit) {
    const started = now();

    stageBytes(unit.echo);
    if (input && recorder) {
      const bytes = sampleInput(unit);
      const length = bytes?.length ?? 0;
      if (length > native.inputMapping.record.limit) throw Error('Input record too large');

      stageWord(length);
      if (bytes) stageBytes(bytes);
    }
    stampTiming(unit);
    loop.ack += now() - started;

    flushAcks();
  }

  /** Units the receiver already holds: udp-receiver.js `peek`, depth 0 before it exists. */
  function peek() {
    return datagrams ? datagrams.peek() : {depth: 0, whole: false};
  }

  /** The depth before a receive: the pipeline's peek when nothing ran since, else a new one. */
  function queueDepth() {
    const seen = peeked?.whole ? peeked.depth : peek().depth;
    peeked = null;
    return seen;
  }

  /** @type {import('./decode-batch.js').DecodePipeline} */
  const pipeline = {
    overlap: fps > 60,
    overlapOutput: stream.overlapOutput === true,
    periodMs: 1000 / fps,
    buffered: () => datagrams?.buffered() ?? false,
    ready() {
      peeked = peek();
      if (peeked.whole) loop.pipelined++;
      return peeked.whole;
    },
    decoded(unit) { /** @type {StreamUnit} */ (unit).decoded = now(); },
    presented(unit) {
      const shown = /** @type {StreamUnit} */ (unit);
      shown.presented = now();
      const latency = shown.presented - shown.arrived;
      loop.presented++;
      loop.latencySum += latency;
      loop.latencyMax = Math.max(loop.latencyMax, latency);
    },
    done(unit) { acknowledge(/** @type {StreamUnit} */ (unit)); },
    spent(stage, ms) { loop[stage] += ms; },
    overlapped(ms) {
      loop.overlapped++;
      loop.hidden += ms;
    }
  };

  /** @type {DecodeNative['createPresentation']} */
  function keptPresentation(runtime, configuration) {
    presentation = native.createPresentation(runtime, configuration);
    return presentation;
  }

  /**
   * @param {number} length
   * @param {number} sequence
   * @param {bigint} pts
   */
  function echoOf(length, sequence, pts) {
    const echo = new Uint8Array(16);
    const view = new DataView(echo.buffer);
    view.setUint32(0, length, true);
    view.setUint32(4, sequence, true);
    view.setBigUint64(8, pts, true);
    return echo;
  }

  const pace = {pts: -Infinity, floor: 0, at: 0};
  const floorCreep = 0.25 / 1000;

  /**
   * How much later than the best seen this unit's header came, against its pts (µs): the
   * floor follows the lowest arrival minus pts and creeps up 0.25 ms/s for clock drift. A
   * pts that does not advance, or jumps a second, restarts it.
   * @param {bigint} pts
   * @param {number} at console ms
   */
  function lateness(pts, at) {
    const ptsUs = Number(pts);
    const step = ptsUs - pace.pts;
    const offset = at - ptsUs / 1000;
    pace.pts = ptsUs;

    if (step <= 0 || step > 1000000) {
      pace.floor = offset;
      pace.at = at;
      return 0;
    }

    pace.floor = Math.min(pace.floor + (at - pace.at) * floorCreep, offset);
    pace.at = at;
    return offset - pace.floor;
  }

  /**
   * The units, reassembled by the UDP receiver in `buffer`'s slots, with the first datagram as
   * the header mark. A unit is behind when another waits after it, or when it was waiting and
   * came more than a frame later than the floor; the overlapped output takes each unit once it is
   * whole, so there only a unit already arriving behind it counts. After a run of
   * max(2, round(fps / 30)) behind units one skips its present and the count restarts;
   * README.md, "UDP transport" and "Catching up".
   */
  function* units() {
    const endpoint = new Uint8Array(16);
    endpoint[0] = 16;
    endpoint[1] = 2;
    endpoint[2] = port >> 8;
    endpoint[3] = port & 255;
    endpoint.set(host, 4);
    writeBuffer(header + 0x100n, endpoint);
    channel = socket(2, 1, 6);
    if (channel < 0n) throw Error('Video connection failed');

    const bufferRequest = /** @type {ReceiveBufferRequest | undefined} */ (stream.receiveBuffer);
    if (bufferRequest && native.setReceiveBuffer)
      receiveBuffer = native.setReceiveBuffer(native, channel, bufferRequest);
    if (connect(channel, header + 0x100n, 16) !== 0n) throw Error('Video connection failed');
    writeBuffer(header + 0x200n, encode(token));
    transfer(header + 0x200n, 64);

    const receiver = datagrams = native.createUdpReceiver(native, {.../** @type {ConsoleRequest} */ (stream.udp),
      host: stream.host, units: stream.buffer, capacity, control: channel},
      {pump, control: transfer});
    const catchUpUnits = Math.max(2, Math.round(fps / 30));
    const periodMs = 1000 / fps;
    const takenWhole = stream.overlapOutput === true;
    let behindUnits = 0;
    let drainedMs = 0;
    for (let index = 0; index < frames; index++) {
      const depth = index > 0 ? queueDepth() : 0;

      const waited = now();
      const before = receiver.drainMs;
      const unit = receiver.next();
      if (!unit) break;
      const drained = receiver.drainMs;
      loop.idle += now() - waited - (drained - before);
      loop.receive += drained - drainedMs;
      drainedMs = drained;

      const overdue = lateness(unit.pts, unit.completedAt) > periodMs;
      const queued = depth > 1;
      const waitedLate = depth > 0 && overdue && !takenWhole;
      const behind = queued || waitedLate;
      behindUnits = behind ? behindUnits + 1 : 0;
      const late = behindUnits >= catchUpUnits;
      if (late) behindUnits = 0;
      loop.units++;
      pump();
      yield {source: unit.source, length: unit.length, pts: unit.pts, present: !late, waiting: depth > 0,
        echo: echoOf(unit.length, unit.sequence, unit.pts), sequence: unit.sequence, header: unit.firstAt,
        arrived: unit.completedAt, decoded: -1, presented: -1, input: -1};
    }
  }

  const controlsAt = input ? /** @type {ConsoleRequest} */ (request.input).controls : undefined;
  const controls = controlsAt === undefined ? null : address(controlsAt);
  let heldBefore = false;
  /**
   * The overlay chord counts on the compute pass, so L or R held keeps it running, and one frame
   * after the release resets the shader's chord count and previous buttons.
   */
  const interactive = () => {
    const held = controls !== null && (read32(controls + 8n) & 0xc0n) !== 0n;
    const releasing = heldBefore;
    heldBefore = held;
    return held || releasing || (native.ui?.interactive?.() ?? true);
  };

  try {
    const result = native.decodeBatch({...native, streamUnits: units(), pump, pipeline, interactive,
      createPresentation: keptPresentation}, request);
    const udp = /** @type {UdpReceiver | null} */ (datagrams);
    return {...result, ...(audio ? {audio: audio.stats} : {}), ...(receiveBuffer ? {receiveBuffer} : {}),
      ...(udp ? {udp: {...udp.stats(), receiveBuffer: udp.receiveBuffer}} : {})};
  } finally {
    /** @type {UdpReceiver | null} */ (datagrams)?.close();
    if (channel >= 0n) close(channel);
    audio?.close();
  }
}
