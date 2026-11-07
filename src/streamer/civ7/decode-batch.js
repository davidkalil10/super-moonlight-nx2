// Feeds access units through movie::Decoder, or the AV1 backend (av1-decode.js), into the
// destination, publishing and presenting each frame when asked. Shipped by toString(); videoStream
// reuses it with streamed units (README.md, "Pipelined decode" above 60 fps, "Latest wins" at 60,
// "Overlapped output" above 1080p, "Deferred GPU wait").

/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */

/**
 * @typedef {{source: bigint, length: number, pts: bigint, present?: boolean, waiting?: boolean}} DecodeUnit
 *   present false: decode only; waiting: it was already in the socket when the loop came for it
 */
/** @typedef {Parameters<typeof import('./video-publication.js').createFramePublication>[0]} PublicationNative */
/** @typedef {'submit' | 'decodeWait' | 'output' | 'present'} DecodeStage */

/**
 * A streaming caller's view of each unit. `ready` says the next unit already waits whole. With
 * `overlap` the previous unit then presents while the decoder works on the next; without it a
 * present that would wait on the swapchain (under `periodMs` since the last) gives way to the
 * newer unit. `overlapOutput` (AV1) submits the next unit as soon as a frame is ready, so the
 * frame's output runs under the next decode too. `overlapped` gets the ms a unit's work ran while
 * the next one decoded; README.md, "Pipelined decode", "Latest wins" and "Overlapped output".
 * @typedef {{ready(): boolean, overlap?: boolean, overlapOutput?: boolean, periodMs?: number,
 *   decoded(unit: DecodeUnit): void, presented(unit: DecodeUnit): void, done(unit: DecodeUnit): void,
 *   spent(stage: DecodeStage, ms: number): void, overlapped?(ms: number): void}} DecodePipeline
 */

/**
 * `interactive` says whether the next present needs the compute pass (UI pages, overlay, the
 * overlay chord); without it every present is interactive.
 * @typedef {Pick<ConsoleNative, 'address' | 'integer' | 'checkMemory' | 'verified' | 'call' | 'read32' |
 *   'read64' | 'write32' | 'write64' | 'readMemory'> & {
 *   createFramePublication: typeof import('./video-publication.js').createFramePublication,
 *   createPresentation: typeof import('./present-batch.js').createPresentation,
 *   publicationLayout: PublicationNative['publicationLayout'],
 *   createAv1Backend?: typeof import('./av1-decode.js').createAv1Backend,
 *   streamUnits?: Iterable<DecodeUnit>, pump?: () => void, pipeline?: DecodePipeline,
 *   interactive?: () => boolean, now?: () => number}} DecodeNative
 */

/**
 * @param {DecodeNative} native
 * @param {ConsoleRequest} request
 */
export function decodeBatch(native, request) {
  const {address, integer, checkMemory, verified, call, read32, read64, write32, readMemory} = native;
  const memory = address(request.memory);
  checkMemory(memory, 0x10000, 3);
  const named = /** @type {Record<string, unknown>} */ (request.functions);
  const layout = /** @type {Record<string, unknown>} */ (request.layout);
  const target = /** @type {ConsoleRequest} */ (request.destination);
  const av1Request = /** @type {ConsoleRequest | undefined} */ (request.av1);
  /** @type {Record<string, bigint>} */
  const functions = {};
  const required = av1Request ? [] : ['acquireInput', 'getInput', 'bufferData', 'bufferCapacity', 'sendInput',
    'acquireOutput', 'getOutputSize', 'bufferSetData', 'getOutput', 'releaseOutput', 'copy'];
  if (Boolean(request.presentation) !== Boolean(request.publication))
    throw Error('Presentation requires frame publication');
  if (request.publication && !av1Request) required.push('mediaFindInt');
  for (const name of required) {
    const pointer = address(named[name]);
    if (!verified.has('0x' + pointer.toString(16))) throw Error('Unverified decode function: ' + name);
    functions[name] = pointer;
  }
  /** @param {string} name */
  const pointer = name => memory + BigInt(integer(layout[name], 0, 0xffff));
  /** @type {Record<string, bigint>} */
  const slots = {};
  const movieSlots = av1Request ? [] : ['decoder', 'input', 'output', 'format', 'inputIndex', 'inputCount',
    'outputIndex', 'timestamp', 'flags', 'outputCount', 'outputSize', 'alignment'];
  for (const name of movieSlots) slots[name] = pointer(name);
  if (request.publication && !av1Request) {
    slots.key = pointer('key');
    slots.value = pointer('value');
    checkMemory(slots.key, 32, 3);
    checkMemory(slots.value, 4, 3);
  }
  const destination = address(target.address);
  const destinationBytes = integer(target.bytes, 1, 16 * 1024 * 1024);
  checkMemory(destination, destinationBytes, 3);
  const alternate = target.alternate === undefined ? null : address(target.alternate);
  if (alternate !== null) checkMemory(alternate, destinationBytes, 3);
  const deferring = /** @type {ConsoleRequest | undefined} */ (request.presentation)?.deferWait === true;
  if (deferring && alternate === null) throw Error('A deferred GPU wait needs an alternate destination');
  if (av1Request && !native.createAv1Backend) throw Error('AV1 decoding is not available');
  const av1 = av1Request && native.createAv1Backend
    ? native.createAv1Backend(native, av1Request, {memory, destination, destinationBytes}) : null;
  const listed = Array.isArray(request.units) ? request.units : null;
  if (!native.streamUnits && (!listed || listed.length < 1 || listed.length > 240))
    throw Error('Invalid decode batch');
  /** @type {Iterable<DecodeUnit>} */
  const units = native.streamUnits || (listed ?? []).map((/** @type {ConsoleRequest} */ unit) => {
    const source = address(unit.address);
    const length = integer(unit.length, 1, 8 * 1024 * 1024);
    const pts = BigInt(integer(unit.pts, 0, Number.MAX_SAFE_INTEGER));
    checkMemory(source, length, 1);
    return {source, length, pts};
  });
  const publishing = /** @type {ConsoleRequest | undefined} */ (request.publication);
  const presenting = /** @type {ConsoleRequest | undefined} */ (request.presentation);
  const publication = publishing ? native.createFramePublication(native, publishing,
    {functions, slots, destination, destinationBytes, alternate, format: av1?.format}) : null;
  const present = presenting ? native.createPresentation(native, presenting) : null;
  /**
   * @param {string} name
   * @param {bigint[]} args
   */
  const result = (name, ...args) => Number(call(functions[name], ...args) & 0xffffffffn);
  /**
   * @param {string} name
   * @param {bigint[]} args
   */
  function success(name, ...args) {
    const code = result(name, ...args);
    if (code) throw Error(name + ' returned 0x' + code.toString(16));
  }
  /**
   * @param {string} name
   * @param {bigint} index the slot the function writes the index to
   * @param {bigint[]} args
   */
  function acquire(name, index, args) {
    const deadline = Date.now() + 5000;
    do {
      native.pump?.();
      write32(index, 0xffffffffn);
      const code = result(name, ...args);
      const slot = Number(BigInt.asIntN(32, read32(index)));
      if (code === 0 && slot >= 0) return slot;
      if (code !== 0 && !([0x100e, 0x1011].includes(code) && slot < 0))
        throw Error(name + ' returned 0x' + code.toString(16));
    } while (Date.now() < deadline);
    throw Error(name + ' timed out');
  }
  /** @type {Map<number, {buffer: bigint, capacity: number}>} */
  const inputs = new Map();
  /** @type {string[]} */
  const timestamps = [];
  let frameCount = 0;
  let presentedFrames = 0;
  let caughtUp = 0;
  /** @type {string | undefined} */
  let lastTimestamp;
  let outputBytes = 0;
  /** @type {number[] | undefined} */
  let sample;
  const started = Date.now();
  const pipeline = native.pipeline;
  const clock = native.now || (() => Date.now());
  /**
   * @param {DecodeStage} stage
   * @param {number} since
   */
  const spent = (stage, since) => pipeline?.spent(stage, clock() - since);
  const overlapping = Boolean(pipeline?.overlap);
  const overlappingOutput = Boolean(pipeline?.overlapOutput);
  if (overlappingOutput && !av1) throw Error('Overlapping the output needs the AV1 decoder');
  const periodMs = pipeline?.periodMs ?? 0;
  let shownAt = -Infinity;
  let draining = false;
  /** The frame the last present showed; output goes to the other one when there is one. */
  let shownFrame = destination;

  const fillFrame = () => alternate !== null && shownFrame === destination ? alternate : destination;
  const slotOf = (/** @type {bigint} */ frame) => frame === destination ? 0 : 1;

  /** @param {DecodeUnit} unit */
  function submit(unit) {
    const since = clock();
    if (av1) {
      av1.submit(unit);
      spent('submit', since);
      return;
    }

    const input = acquire('acquireInput', slots.inputIndex,
      [slots.decoder, slots.inputIndex, slots.inputCount]);
    let cached = inputs.get(input);
    if (!cached) {
      success('getInput', slots.decoder, BigInt(input), slots.input);
      const buffer = call(functions.bufferData, slots.input);
      const capacity = Number(call(functions.bufferCapacity, slots.input));
      integer(capacity, 1, 64 * 1024 * 1024);
      checkMemory(buffer, capacity, 2);
      cached = {buffer, capacity};
      inputs.set(input, cached);
    }
    const {buffer, capacity} = cached;
    if (unit.length > capacity) throw Error('Access unit exceeds decoder input capacity');
    call(functions.copy, buffer, unit.source, BigInt(unit.length));
    success('sendInput', slots.decoder, BigInt(input), 0n, BigInt(unit.length), unit.pts, 0n);
    spent('submit', since);
  }

  /**
   * @param {string} timestamp the input timestamp of the frame now in `frame`
   * @param {bigint} frame
   */
  function record(timestamp, frame) {
    lastTimestamp = timestamp;
    if (!native.streamUnits || timestamps.length < 240) timestamps.push(lastTimestamp);
    frameCount++;
    if (!sample && request.sampleOffset !== undefined) {
      const offset = integer(request.sampleOffset, 0, outputBytes - 64);
      sample = Array.from(readMemory(frame + BigInt(offset), 64));
    }
  }

  /** Waits until the AV1 decoder has filled the submitted unit's surface. */
  function awaitAv1() {
    const since = clock();
    /** @type {NonNullable<typeof av1>} */ (av1).wait();
    spent('decodeWait', since);
  }

  /**
   * Untiles the ready AV1 surface into `frame` and hands the surface back.
   * @param {bigint} frame
   */
  function outputAv1(frame) {
    const backend = /** @type {NonNullable<typeof av1>} */ (av1);
    const since = clock();
    outputBytes = backend.frameBytes;
    record(backend.output(frame), frame);
    spent('output', since);
    return frame;
  }

  /**
   * The AV1 form of collect(), with the same stages.
   * @param {bigint} frame
   */
  function collectAv1(frame) {
    awaitAv1();
    return outputAv1(frame);
  }

  /** Waits for the submitted unit and copies it into a frame no present is reading; returns it. */
  function collect() {
    const frame = fillFrame();
    present?.release?.(slotOf(frame));
    if (av1) return collectAv1(frame);

    let since = clock();
    const output = acquire('acquireOutput', slots.outputIndex,
      [slots.decoder, slots.outputIndex, slots.timestamp, slots.flags, slots.outputCount]);
    spent('decodeWait', since);

    since = clock();
    try {
      if (!outputBytes) {
        success('getOutputSize', slots.decoder, slots.outputSize, slots.alignment);
        outputBytes = Number(read32(slots.outputSize));
        const alignment = Number(read32(slots.alignment));
        const misaligned = destination % BigInt(alignment) || (alternate ?? 0n) % BigInt(alignment);
        if (!outputBytes || outputBytes > destinationBytes || !alignment || misaligned)
          throw Error('Decoder output does not fit destination');
      }
      call(functions.bufferSetData, slots.output, frame, BigInt(destinationBytes), 0n);
      success('getOutput', slots.decoder, BigInt(output), slots.output, slots.format);
      record(read64(slots.timestamp).toString(), frame);
    } finally {
      success('releaseOutput', slots.decoder, BigInt(output));
    }
    spent('output', since);
    return frame;
  }

  /**
   * Publishes and presents the unit `frame` holds. It returns before the next unit's output is
   * copied over it, or, deferring, while the GPU still reads it.
   * @param {DecodeUnit} unit
   * @param {bigint} frame
   */
  function show(unit, frame) {
    if (!present || !publication) return;

    const since = clock();
    native.pump?.();
    publication.publish(frame !== destination);
    present(slotOf(frame), native.interactive?.() ?? true);
    shownAt = clock();
    shownFrame = frame;
    pipeline?.presented(unit);
    native.pump?.();
    presentedFrames++;
    spent('present', since);
    pipeline?.done(unit);
  }

  /**
   * Latest wins: a present that would wait on the swapchain (under one period since the last)
   * gives way when a newer unit already waits whole and, from then on, for every unit that was
   * already waiting, until the loop waits for one again; README.md, "Latest wins".
   * @param {DecodeUnit} unit
   * @param {boolean} newer
   */
  function supersede(unit, newer) {
    if (!unit.waiting) draining = false;
    const blocking = clock() - shownAt < periodMs;
    const behind = newer || (draining && Boolean(unit.waiting));
    if (!blocking || !behind) return false;

    draining = true;
    return true;
  }

  const showing = Boolean(present && publication);

  /**
   * Takes the ready AV1 frame into a frame no present reads and presents it, or acknowledges it
   * unshown when it was caught up. No latest-wins skip: the overlapped loop fits the period, so
   * one unit behind is not a backlog; README.md, "Overlapped output".
   * @param {DecodeUnit} unit
   */
  function finish(unit) {
    const frame = fillFrame();
    present?.release?.(slotOf(frame));
    outputAv1(frame);
    pipeline?.decoded(unit);
    if (showing && unit.present !== false) {
      show(unit, frame);
      return;
    }

    if (showing) caughtUp++;
    pipeline?.done(unit);
  }

  /**
   * Above 1080p: once a unit's frame is ready and the next unit waits whole, the next one is
   * submitted first, so this one's output, present and ack run while it decodes; README.md,
   * "Overlapped output".
   */
  function overlapOutputs() {
    /** @type {DecodeUnit | null} */
    let held = null;
    for (const unit of units) {
      submit(unit);
      if (held) {
        const since = clock();
        finish(held);
        pipeline?.overlapped?.(clock() - since);
        held = null;
      }

      awaitAv1();
      if (pipeline?.ready()) held = unit;
      else finish(unit);
    }
    if (held) finish(held);
  }

  /**
   * Up to 1080p a unit's output comes before the next submit; above 60 fps its present and ack
   * wait for the next unit when one waits whole; README.md, "Pipelined decode".
   */
  function presentUnits() {
    /** @type {DecodeUnit | null} */
    let decoded = null;
    let decodedFrame = destination;
    for (const unit of units) {
      submit(unit);
      if (decoded) {
        const since = clock();
        show(decoded, decodedFrame);
        pipeline?.overlapped?.(clock() - since);
        decoded = null;
      }

      const frame = collect();
      pipeline?.decoded(unit);
      if (!showing) {
        pipeline?.done(unit);
        continue;
      }
      if (unit.present === false) {
        caughtUp++;
        pipeline?.done(unit);
        continue;
      }

      const newer = Boolean(pipeline?.ready());
      if (newer && overlapping) {
        decoded = unit;
        decodedFrame = frame;
      } else if (!overlapping && supersede(unit, newer)) {
        caughtUp++;
        pipeline?.done(unit);
      } else {
        show(unit, frame);
      }
    }
    if (decoded) show(decoded, decodedFrame);
  }

  try {
    if (overlappingOutput) overlapOutputs();
    else presentUnits();
  } finally {
    present?.finish?.();
  }
  return {frames: frameCount, elapsedMs: Date.now() - started, outputBytes, timestamps, lastTimestamp, sample,
    presentedFrames, caughtUp, frameLayout: publication?.layout(), presentationTimings: present?.timings,
    ...(av1 ? {av1: av1.report()} : {})};
}
