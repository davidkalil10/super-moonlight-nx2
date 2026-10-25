// Decoder event probe for the persistent decode worker. A plain EventType registered through
// RegisterClientEvents is watched by a repeating worker (WaitEvent, then an atomic add), so
// the host can count output-ready (and input-available) notifications per access unit while
// it feeds an offline clip, acquires every output itself and checks the frames. The output
// watcher also reads the console tick on each wake and SendInput is stamped the same way, so
// decoder latency is measured on the console clock, apart from the host's round trips.
// --burst keeps the input side full instead of waiting for each AU's output.
const fsSync = require('node:fs');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const cli = require('../../../hbl-platform/sdk/cli.cjs');
const {allocate} = require('../../../hbl-platform/sdk/native/allocate.cjs');
const {verify} = require('../../../hbl-platform/sdk/native/symbols.cjs');
const {prepare} = require('../../../hbl-platform/sdk/native/repeating.cjs');
const {
  CODE: code,
  verifyCode,
  verifyCopy,
  spawn,
  wait,
  join
} = require('../../../hbl-platform/sdk/native/thread.cjs');
const {nals, parameterSets} = require('../../../hbl-moonlight/tools/moonlight/h264-stream.cjs');
const SYNC = require('../../../hbl-platform/sdk/native/os-sync-functions.json');
const MOVIE_EVENTS = require('../../../hbl-moonlight/sdk/native/movie-event-functions.json');
const TIMING =
  require('../../../hbl-platform/smilebasic/engine/switch2/app/timing-code.json').functions;
const {
  read: consoleTickFrequency
} = require('../../../hbl-platform-dev/sdk/tools/console-tick-frequency.cjs');

const USED = ['initializeEvent', 'waitEvent', 'signalEvent', 'finalizeEvent', 'atomicAddU32'];
// Its own allocation, so no repeating region restores over the events or counters.
const CONTROL_BYTES = 0x1000;
const OUTPUT_EVENT = 0x00,
  INPUT_EVENT = 0x40,
  DECODER_EVENTS = 0x80,
  OUTPUT_COUNT = 0xc0,
  INPUT_COUNT = 0xc4;
const SHORT = 2;
const AUTO_CLEAR = 1;
const MIN_PSNR = 35;

const round = value => Math.round(value * 1000) / 1000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const histogram = values =>
  values.reduce((counts, value) => ((counts[value] = (counts[value] || 0) + 1), counts), {});

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    at = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1)),
    mean: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length)
  };
}

const differences = values => values.slice(1).map((value, i) => value - values[i]);

// Annex-B access units: a new one starts at each VCL NAL whose first_mb_in_slice is 0, and
// carries the SPS/PPS/SEI that precede it.
function accessUnits(bytes) {
  const units = [];
  let pending = [],
    current = null;
  for (const nal of nals(bytes)) {
    const vcl = nal.type === 1 || nal.type === 5;
    if (vcl && nal.data[1] & 0x80) {
      if (current) units.push(current);
      current = {nals: [...pending, nal], keyframe: nal.type === 5};
      pending = [];
    } else if (vcl && current) current.nals.push(nal);
    else pending.push(nal);
  }
  if (current) units.push(current);
  const start = Buffer.from([0, 0, 0, 1]);
  return units.map(unit => ({
    keyframe: unit.keyframe,
    data: Buffer.concat(unit.nals.flatMap(nal => [start, nal.data]))
  }));
}

// Device luma must match the reference exactly; chroma differs slightly on console.
// Clips without a recorded rate predate make-decoder-clips.sh writing one; they ran at 30.
function clipFrameRate(sidecar) {
  const fps = sidecar.fps ?? 30;
  if (!Number.isInteger(fps) || fps < 1 || fps > 120)
    throw Error('Clip frame rate must be 1 to 120');
  return fps;
}

function compareFrame(actual, expected, width, height) {
  const luma = width * height;
  let lumaMax = 0,
    squared = 0;
  for (let i = 0; i < expected.length; i++) {
    const error = Math.abs(actual[i] - expected[i]);
    if (i < luma) lumaMax = Math.max(lumaMax, error);
    squared += error * error;
  }
  const mse = squared / expected.length;
  const psnr = mse ? round(10 * Math.log10((255 * 255) / mse)) : Infinity;
  return {lumaMaxError: lumaMax, psnr, match: lumaMax === 0 && psnr >= MIN_PSNR};
}

// Packs a strided NV12 surface into width x height planes.
function packNv12(surface, {width, height, stride, sliceHeight}) {
  const packed = Buffer.alloc((width * height * 3) / 2);
  for (let y = 0; y < height; y++) surface.copy(packed, y * width, y * stride, y * stride + width);
  const chroma = stride * sliceHeight;
  for (let y = 0; y < height / 2; y++)
    surface.copy(
      packed,
      width * height + y * width,
      chroma + y * stride,
      chroma + y * stride + width
    );
  return packed;
}

// Turns the per-AU rows into the answers the persistent worker design needs.
function summarize(units, frames, held) {
  const seen = units.filter(u => u.eventSeen);
  const decodeIndex = new Map(units.map(u => [u.display, u.au]));
  const lags = frames
    .filter(f => f.afterAu !== null)
    .map(f => f.afterAu - decodeIndex.get(f.display));
  const first = frames.find(f => f.afterAu !== null);
  const displays = frames.map(f => f.display);
  return {
    submitted: units.length,
    received: frames.length,
    held: held.length,
    heldDisplays: held,
    firstOutputAfterAu: first ? first.afterAu : null,
    outputsPerAu: histogram(units.map(u => u.outputs.length)),
    lagAus: histogram(lags),
    maxLagAus: lags.length ? Math.max(...lags) : null,
    displayOrder: displays.every((d, i) => !i || d > displays[i - 1]),
    outputEventsPerAu: histogram(units.map(u => u.outputEvents)),
    eventSeenAus: seen.length,
    acquiredAfterEvent: seen.filter(u => u.firstTry).length,
    emptyAfterEvent: seen.filter(u => !u.firstTry).length,
    outputWithoutEvent: units.filter(u => !u.eventSeen && u.outputs.length).length,
    eventMs: seen.length
      ? {
          max: round(Math.max(...seen.map(u => u.eventMs))),
          mean: round(seen.reduce((sum, u) => sum + u.eventMs, 0) / seen.length)
        }
      : null,
    inputEventsPerAu: histogram(units.map(u => u.inputEvents)),
    inputReadyAfterSend: units.filter(u => u.input && u.input.index >= 0).length,
    inputEventWithoutSlot: units.filter(u => u.inputEvents > 0 && u.input && u.input.index < 0)
      .length,
    consoleLatencyMs: stats(
      seen.filter(u => u.consoleLatencyMs !== null).map(u => u.consoleLatencyMs)
    ),
    submitMs: stats(units.map(u => u.submitMs))
  };
}

// Burst answers. Console times come from ticks: SendInput's stamp, and the tick the output
// watcher took on the wake that brought its counter to k, read back with k by host samples.
// Events can coalesce, so per-frame latency only holds when every output got its own event.
// base is the output count before the first AU, so wake k is the (k - base)th output.
function summarizeBurst({sends, samples, frames, held, eventCount, base = 0, ms}) {
  const tickOf = new Map();
  for (const sample of samples)
    if (sample.count > base) tickOf.set(sample.count - base, BigInt(sample.tick));
  const known = [...tickOf.keys()].sort((a, b) => a - b);
  const consecutive = known.filter(k => tickOf.has(k + 1));
  const decodeIndex = new Map(sends.map(send => [send.display, send.au]));
  const oneToOne = eventCount - base === frames.length;
  const latency = oneToOne
    ? known
        .filter(k => k <= frames.length)
        .map(k =>
          ms(tickOf.get(k) - BigInt(sends[decodeIndex.get(frames[k - 1].display)].sendTick))
        )
    : [];
  const sendTicks = sends.map(send => BigInt(send.sendTick));
  const firstKnown = known[0],
    lastKnown = known.at(-1);
  const span = frames.length ? frames.at(-1).hostAt - sends[0].hostAt : null;
  const displays = frames.map(f => f.display);
  return {
    submitted: sends.length,
    received: frames.length,
    held: held.length,
    heldDisplays: held,
    displayOrder: displays.every((d, i) => !i || d > displays[i - 1]),
    inputBlocked: sends.filter(send => send.blocked).length,
    host: {
      spanMs: span === null ? null : round(span),
      fps: span ? round((frames.length * 1000) / span) : null,
      submitMs: stats(sends.map(send => send.hostMs)),
      outputIntervalMs: stats(differences(frames.map(f => f.hostAt))),
      maxInFlight: Math.max(0, ...frames.map((f, i) => f.afterAu + 1 - i)),
      maxUnreceived: Math.max(0, ...samples.map(s => s.sent - s.received))
    },
    console: {
      inputFps:
        sends.length > 1
          ? round(((sends.length - 1) * 1000) / ms(sendTicks.at(-1) - sendTicks[0]))
          : null,
      sendIntervalMs: stats(differences(sendTicks).map(ms)),
      outputFps:
        lastKnown > firstKnown
          ? round(
              ((lastKnown - firstKnown) * 1000) / ms(tickOf.get(lastKnown) - tickOf.get(firstKnown))
            )
          : null,
      outputIntervalMs: stats(consecutive.map(k => ms(tickOf.get(k + 1) - tickOf.get(k)))),
      eventsTimed: known.length,
      oneEventPerOutput: oneToOne,
      latencyMs: stats(latency),
      maxInFlight: Math.max(0, ...samples.map(s => s.sent - s.count))
    }
  };
}

function journal(file) {
  const descriptor = fsSync.openSync(file, 'wx', 0o600);
  let sequence = 0;
  return {
    write(value) {
      fsSync.writeSync(
        descriptor,
        JSON.stringify({sequence: ++sequence, at: new Date().toISOString(), ...value}) + '\n'
      );
      fsSync.fsyncSync(descriptor);
    },
    close() {
      fsSync.closeSync(descriptor);
    }
  };
}

function parseOptions(args) {
  const optionalNumber = name => (args.includes(name) ? Number(cli.option(args, name)) : null);
  return {
    clip: cli.option(args, '--clip') || undefined,
    reference: cli.option(args, '--reference') || undefined,
    watchInput: !args.includes('--no-input-watch'),
    burst: args.includes('--burst'),
    window: optionalNumber('--window'),
    settleMs: cli.number(args, '--settle-ms', 250),
    drainMs: cli.number(args, '--drain-ms', 1000),
    maxAus: optionalNumber('--max-aus'),
    output: cli.option(args, '--output') || undefined
  };
}

async function main(
  directory,
  {
    clip,
    reference,
    watchInput = true,
    settleMs = 250,
    pollMs = 5,
    drainMs = 1000,
    stopTimeoutMs = 5000,
    burst = false,
    window = null,
    maxAus = null,
    output = process.env.HB_NATIVE_LOG_DIR,
    createDecoder = require('../../../hbl-moonlight/tools/moonlight/native-decoder.cjs').create
  } = {}
) {
  if (!clip) throw Error('Expected --clip <file.h264>');
  if (window !== null && (![2, 3].includes(window) || burst))
    throw Error('--window must be 2 or 3 and cannot be combined with --burst');
  if (maxAus !== null && (!Number.isInteger(maxAus) || maxAus < 1))
    throw Error('--max-aus must be a positive integer');
  directory = path.resolve(directory);
  const raw = require(path.join(directory, 'shared/rpc.cjs'));
  const pipelined = burst || window !== null;
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8'
  }).trim();
  output ||= path.join(
    '/media/storage2/builds/HBLauncher/native-h264',
    new Date().toISOString().replace(/[:.]/g, '-') + '-' + revision.slice(0, 8)
  );
  await fs.mkdir(output, {recursive: true, mode: 0o700});

  const bytes = await fs.readFile(clip);
  const allUnits = accessUnits(bytes);
  if (maxAus !== null && maxAus > allUnits.length)
    throw Error('--max-aus exceeds the number of clip access units');
  if (window !== null && maxAus !== null && maxAus < window)
    throw Error('--max-aus must cover a full concurrency window');
  const units = maxAus === null ? allUnits : allUnits.slice(0, maxAus);
  const sidecar = clip.replace(/\.h264$/, '.json');
  const timing = await fs.readFile(sidecar, 'utf8').then(JSON.parse, () => null);
  const allDisplay = timing?.display ?? allUnits.map((_, i) => i);
  if (allDisplay.length !== allUnits.length) throw Error('Clip timing does not match its AUs');
  const display = allDisplay.slice(0, units.length);
  if (window !== null && display.some((shown, index) => shown !== index))
    throw Error('--window requires an IP-only clip in display order');
  reference ??= await fs.access(clip.replace(/\.h264$/, '-reference.nv12')).then(
    () => clip.replace(/\.h264$/, '-reference.nv12'),
    () => null
  );
  const references = reference ? await fs.readFile(reference) : null;
  // A large clip's reference holds only some frames, listed by display index in the sidecar.
  const listed = timing?.references ?? allDisplay.map((_, i) => i);
  const referenceAt = new Map(listed.map((shown, i) => [shown, i]));
  if (window !== null && (!references || !display.some(shown => referenceAt.has(shown))))
    throw Error('--window requires a reference for at least one submitted frame');
  const {sps, pps} = parameterSets(bytes);
  if (!sps || !pps) throw Error('Clip has no SPS/PPS');
  const entries = window === null ? null : journal(path.join(output, 'decoder-concurrency.jsonl'));
  const rpc = entries ? require('./probe-persistent-first-job.cjs').loggedRpc(raw, entries) : raw;
  const sdk = rpc.a.sdk;

  const record = {
    probe: window === null ? 'decoder-events' : 'decoder-concurrency',
    session: rpc.a.session,
    protocol: rpc.a.protocol,
    sourceRevision: revision,
    builder: os.hostname(),
    targetArchitecture: 'aarch64',
    command: process.argv,
    started: new Date().toISOString(),
    inputs: {
      clip: path.resolve(clip),
      clipSha256: sha256(bytes),
      units: units.length,
      timing: timing ? sidecar : null,
      reference,
      watchInput,
      settleMs,
      pollMs,
      drainMs,
      stopTimeoutMs,
      burst,
      window,
      maxAus,
      referenceFrames: reference ? referenceAt.size : 0
    }
  };
  const file = path.join(output, 'decoder-event-probe.json');
  const save = () => fs.writeFile(file, JSON.stringify(record, null, 2) + '\n', {mode: 0o600});
  await save();

  const fn = {},
    watchers = [],
    rows = [],
    frames = [],
    expected = new Set(display);
  const sends = [],
    samples = [];
  let started = null,
    frequency = null,
    eventCount = 0;
  const ms = ticks => (Number(ticks) * 1000) / frequency;
  // Kept for a run that fails part way, so the AUs that did run still answer.
  function conclude() {
    const fed = new Set((pipelined ? sends : rows).map(row => row.display));
    const held = [...expected].filter(shown => fed.has(shown)).sort((a, b) => a - b);
    record.loop = {
      totalMs: round(performance.now() - started),
      ...(pipelined
        ? summarizeBurst({
            sends,
            samples,
            frames,
            held,
            eventCount,
            base: record.afterStart?.output ?? 0,
            ms
          })
        : summarize(rows, frames, held))
    };
    const compared = frames.filter(f => f.match !== undefined),
      read = frames.filter(f => f.sha256);
    record.correctness = {
      compared: compared.length,
      matched: compared.filter(f => f.match).length,
      minPsnr: compared.length ? Math.min(...compared.map(f => f.psnr)) : null,
      lumaMaxError: compared.length ? Math.max(...compared.map(f => f.lumaMaxError)) : null,
      read: read.length,
      first: read.length ? {display: read[0].display, sha256: read[0].sha256} : null,
      last: read.length ? {display: read.at(-1).display, sha256: read.at(-1).sha256} : null
    };
    return compared;
  }
  let control = null,
    decoder = null,
    events = [],
    failure = null;
  const counters = async () => {
    const b = await rpc.read(control + OUTPUT_COUNT, 8);
    return {output: b.readUInt32LE(0), input: b.readUInt32LE(4)};
  };
  try {
    await verifyCode(rpc);
    await verifyCopy(rpc);
    await verifyCode(rpc, [TIMING.tick]);
    fn.tick = sdk + TIMING.tick.offset;
    const module = JSON.parse(
      await fs.readFile(path.join(directory, 'compatibility-module.json'), 'utf8')
    );
    frequency = await consoleTickFrequency(rpc, module.base);
    record.tickFrequency = frequency;
    for (const name of USED) {
      await verify(rpc, sdk + SYNC[name].offset, SYNC[name].hex);
      fn[name] = sdk + SYNC[name].offset;
    }
    const register = MOVIE_EVENTS.registerClientEvents;
    if (
      !module.symbols.some(
        s => s.name === register.symbol && s.offset === register.offset && s.size === register.size
      )
    )
      throw Error('The loaded movie module has no matching RegisterClientEvents');
    await verify(rpc, module.base + register.offset, register.hex);
    fn.registerClientEvents = module.base + register.offset;

    control = await allocate(rpc, CONTROL_BYTES, {
      failed: 'Decoder event control allocation failed',
      invalid: 'Invalid decoder event control allocation'
    });
    const watched = [
      {name: 'output', event: control + OUTPUT_EVENT, counter: control + OUTPUT_COUNT}
    ];
    if (watchInput)
      watched.push({name: 'input', event: control + INPUT_EVENT, counter: control + INPUT_COUNT});
    const block = Buffer.alloc(0x100);
    for (const w of watched)
      block.writeBigUInt64LE(BigInt(w.event), DECODER_EVENTS + (w.name === 'output' ? 8 : 0));
    record.control = {
      base: control,
      decoderEvents: control + DECODER_EVENTS,
      ...Object.fromEntries(watched.map(w => [w.name, {event: w.event, counter: w.counter}]))
    };
    await rpc.write(control, block);
    for (const w of watched) {
      events.push(w.event);
      await rpc.callAddress(fn.initializeEvent, [w.event, 0, AUTO_CLEAR, 0], SHORT);
    }

    decoder = await createDecoder({rpc, directory, workerDirectory: path.join(output, 'decoder')});
    // Watchers wait before Start, so no early notification is missed.
    for (const w of watched) {
      const base = await allocate(rpc, 0x400000, {
        failed: 'Event watcher allocation failed',
        invalid: 'Invalid event watcher allocation'
      });
      const program = await prepare(rpc, {
        base,
        code,
        calls: [
          {function: fn.waitEvent, args: [w.event]},
          ...(w.name === 'output' ? [{function: fn.tick, args: []}] : []),
          {function: fn.atomicAddU32, args: [1, w.counter]}
        ]
      });
      const watcher = {...w, base, program, thread: null, joined: false};
      watchers.push(watcher);
      watcher.thread = await spawn(rpc, base, program.live, {
        failed: 'Event watcher creation failed'
      });
    }
    const timed = watchers[0].program.addresses[0];
    record.watchers = watchers.map(w => ({
      name: w.name,
      base: w.base,
      thread: String(w.thread),
      results: w.program.addresses
    }));

    let registered = null;
    const dimensions = await decoder.configure(sps, pps, 60, {
      async beforeStart(decoderAddress) {
        const {result} = await rpc.callAddress(
          fn.registerClientEvents,
          [decoderAddress, control + DECODER_EVENTS],
          SHORT
        );
        registered = Number(BigInt.asUintN(32, result));
        if (registered !== 0)
          throw Error('RegisterClientEvents returned 0x' + registered.toString(16));
      }
    });
    record.registerStatus = registered;
    record.dimensions = dimensions;
    // The decoder may report the coded size (1088 for 1080p); the sidecar has the picture.
    const picture = timing?.width ? {width: timing.width, height: timing.height} : dimensions;
    if (picture.width > dimensions.width || picture.height > dimensions.height)
      throw Error(`Clip is ${picture.width}x${picture.height}, larger than the decoder's size`);
    const frameBytes = (picture.width * picture.height * 3) / 2;
    const surfaceBytes = Math.ceil((dimensions.width * dimensions.height * 3) / 0x1000) * 0x1000;
    if (references && references.length !== listed.length * frameBytes)
      throw Error(
        `Reference is ${references.length} bytes, expected ${listed.length} frames of ${frameBytes}`
      );
    const destination = {
      address: await allocate(rpc, surfaceBytes, {
        failed: 'Output surface allocation failed',
        invalid: 'Invalid output surface allocation'
      }),
      bytes: surfaceBytes
    };
    await sleep(settleMs);
    record.afterStart = await counters();

    const exchanges = {submit: 0, counterRead: 0, sampleRead: 0, receive: 0, frameRead: 0};
    record.units = rows;
    record.frames = frames;
    record.exchangeCalls = exchanges;
    // The output watcher's results: WaitEvent status, its wake tick, the counter before its add.
    async function sample() {
      exchanges.sampleRead++;
      const b = await rpc.read(timed, 24);
      const tick = b.readBigUInt64LE(8);
      const count = tick ? Number(b.readBigUInt64LE(16) & 0xffffffffn) + 1 : 0;
      return {hostAt: round(performance.now() - started), count, tick};
    }
    // Small frames are always read; large ones only where the reference has them.
    const readAll = frameBytes <= 0x10000;
    async function take(afterAu) {
      exchanges.receive++;
      const frame = await decoder.receive(destination);
      if (!frame) return null;
      const shown = Number(frame.pts);
      const row = {display: shown, afterAu, hostAt: round(performance.now() - started)};
      if (!expected.delete(shown)) throw Error('Unexpected or repeated output pts ' + frame.pts);
      const want = references && referenceAt.has(shown);
      if (readAll || want) {
        exchanges.frameRead++;
        const surface = await rpc.read(
          destination.address,
          (frame.stride * frame.sliceHeight * 3) / 2
        );
        if (!record.outputLayout) {
          const {width, height, stride, sliceHeight} = frame;
          record.outputLayout = {width, height, stride, sliceHeight};
        }
        if (frame.width < picture.width || frame.height < picture.height)
          throw Error(`Output ${frame.width}x${frame.height} is smaller than the clip`);
        const packed = packNv12(surface, {...frame, ...picture});
        row.sha256 = sha256(packed);
        const at = referenceAt.get(shown) * frameBytes;
        if (want)
          Object.assign(
            row,
            compareFrame(
              packed,
              references.subarray(at, at + frameBytes),
              picture.width,
              picture.height
            )
          );
      }
      frames.push(row);
      return row;
    }
    const stamp = {acquireOutput: false, stamp: fn.tick};

    started = performance.now();
    for (let au = 0; au < units.length && !pipelined; au++) {
      const before = await counters();
      exchanges.counterRead++;
      const at = performance.now();
      await decoder.submit({data: units[au].data, pts: display[au]}, stamp);
      const submitMs = performance.now() - at,
        sendTick = decoder.lastStamp;
      exchanges.submit++;
      let now = before,
        polls = 0;
      while (now.output === before.output && performance.now() - at < settleMs) {
        await sleep(pollMs);
        now = await counters();
        exchanges.counterRead++;
        polls++;
      }
      const eventSeen = now.output > before.output;
      const eventMs = performance.now() - at;
      const woke = eventSeen ? await sample() : null;
      const outputs = [];
      for (let frame; (frame = await take(au));) outputs.push(frame.display);
      const after = await counters();
      exchanges.counterRead++;
      rows.push({
        au,
        display: display[au],
        keyframe: units[au].keyframe,
        bytes: units[au].data.length,
        input: decoder.lastInput,
        eventSeen,
        eventMs: eventSeen ? round(eventMs) : null,
        polls,
        submitMs: round(submitMs),
        sendTick: String(sendTick),
        eventTick: woke && woke.tick ? String(woke.tick) : null,
        consoleLatencyMs: woke && woke.tick ? round(ms(woke.tick - sendTick)) : null,
        firstTry: outputs.length > 0,
        outputs,
        outputEvents: after.output - before.output,
        inputEvents: after.input - before.input
      });
    }
    // Burst: submit whenever an input slot is ready, take one output per submit while the
    // watcher reports more outputs than were taken, and drain fully only when input blocks.
    if (burst) {
      record.sends = sends;
      record.samples = samples;
      const note = async () => {
        const s = await sample();
        samples.push({...s, tick: String(s.tick), sent: sends.length, received: frames.length});
        return s;
      };
      for (let au = 0; au < units.length; au++) {
        const blocked = au > 0 && decoder.lastInput.index < 0;
        if (blocked) while (await take(au - 1));
        const at = performance.now();
        await decoder.submit({data: units[au].data, pts: display[au]}, stamp);
        exchanges.submit++;
        sends.push({
          au,
          display: display[au],
          hostAt: round(at - started),
          hostMs: round(performance.now() - at),
          sendTick: String(decoder.lastStamp),
          input: decoder.lastInput,
          blocked
        });
        if ((await note()).count > frames.length) await take(au);
      }
      while ((await note()).count > frames.length && (await take(units.length - 1)));
    }
    if (window !== null) {
      record.sends = sends;
      record.samples = samples;
      record.windows = [];
      for (let au = 0; au < units.length; au++) {
        const queued = sends.length - frames.length;
        if (queued && decoder.lastInput.index < 0)
          throw Error(`Input slot unavailable with ${queued} output(s) still unacquired`);
        const at = performance.now();
        entries.write({phase: 'before', step: 'submit', au, display: display[au]});
        await decoder.submit({data: units[au].data, pts: display[au]}, stamp);
        entries.write({phase: 'after', step: 'submit', au, input: decoder.lastInput});
        exchanges.submit++;
        sends.push({
          au,
          display: display[au],
          hostAt: round(at - started),
          hostMs: round(performance.now() - at),
          sendTick: String(decoder.lastStamp),
          input: decoder.lastInput
        });
        const sampled = await sample();
        samples.push({
          ...sampled,
          tick: String(sampled.tick),
          sent: sends.length,
          received: frames.length
        });
        if (sends.length - frames.length < window && au + 1 < units.length) continue;
        const firstAu = frames.length;
        const submittedBeforeAcquire = sends.length - frames.length;
        let until = performance.now() + settleMs;
        while (frames.length < sends.length && performance.now() < until) {
          entries.write({phase: 'before', step: 'acquire', afterAu: au});
          const frame = await take(au);
          entries.write({phase: 'after', step: 'acquire', afterAu: au, display: frame?.display});
          if (frame) until = performance.now() + settleMs;
          else await sleep(pollMs);
        }
        record.windows.push({
          firstAu,
          lastAu: au,
          submittedBeforeAcquire,
          received: frames.length - firstAu
        });
        if (frames.length !== sends.length)
          throw Error(`Window ${firstAu}-${au} did not drain before another input`);
      }
      const sampled = await sample();
      samples.push({
        ...sampled,
        tick: String(sampled.tick),
        sent: sends.length,
        received: frames.length
      });
    }
    // Whatever is still inside the decoder after the last AU, given time but no more input.
    const drainStarted = performance.now();
    while (expected.size && performance.now() - drainStarted < drainMs) {
      if (!(await take(pipelined ? units.length - 1 : null))) await sleep(pollMs * 4);
    }
    const drained = await counters();
    eventCount = drained.output;
    if (pipelined && window === null) {
      const last = await sample();
      samples.push({...last, tick: String(last.tick), sent: sends.length, received: frames.length});
    }
    record.drain = {...drained, ms: round(performance.now() - drainStarted)};
    const compared = conclude();
    if (window !== null) {
      record.loop.window = {
        requested: window,
        full: record.windows.filter(w => w.submittedBeforeAcquire === window).length,
        maxSubmittedBeforeAcquire: Math.max(
          0,
          ...record.windows.map(w => w.submittedBeforeAcquire)
        ),
        completeInOrder: record.loop.received === units.length && record.loop.displayOrder,
        throughputConclusive:
          record.loop.console.oneEventPerOutput &&
          record.loop.console.eventsTimed >= 30 &&
          record.loop.console.inputFps >= 120 &&
          record.loop.console.outputFps !== null
      };
      if (!record.loop.window.full || !record.loop.window.completeInOrder)
        throw Error('Decoder concurrency window did not complete in order');
    }
    if (compared.length !== compared.filter(f => f.match).length)
      throw Error('Decoded frames differ from the reference');
    if (references && !compared.length && frames.length) throw Error('No frame was compared');
  } catch (error) {
    failure = error;
    if ((pipelined ? sends : rows).length && !record.loop) conclude();
  }

  // A watcher blocked in WaitEvent only sees the stop selector after a wake, and the decoder's
  // own thread may signal the same events, so extra bodies are expected and not judged.
  if (watchers.length && !rpc.bridgeLost) {
    try {
      for (const w of watchers) {
        if (w.thread === null) continue;
        await w.program.stop();
        await rpc.callAddress(fn.signalEvent, [w.event], SHORT);
      }
      for (const w of watchers) {
        if (w.thread === null) continue;
        if (
          !(await wait(rpc, w.thread, {
            timeoutMs: stopTimeoutMs,
            pollMs: 5,
            invalid: 'Event watcher state invalid',
            outputBytes: SHORT
          }))
        )
          throw Error('Event watcher ' + w.name + ' did not stop; resources retained');
        await join(rpc, w.thread, w.base + 8, {failed: 'Event watcher join failed'});
        w.joined = true;
      }
      record.stopped = await counters();
    } catch (error) {
      failure ||= error;
    }
  }

  const settled = watchers.every(w => w.thread === null || w.joined);
  // The decoder keeps a pointer to DecoderEvents and there is no unregister, so it is closed
  // before the events are finalized.
  let closed = decoder === null;
  if (decoder && settled && !rpc.bridgeLost) {
    try {
      await decoder.close();
      closed = true;
      record.decoderClosed = true;
    } catch (error) {
      failure ||= error;
    }
  }
  if (events.length && settled && closed && !rpc.bridgeLost) {
    try {
      for (const event of events) await rpc.callAddress(fn.finalizeEvent, [event], SHORT);
      record.finalized = true;
    } catch (error) {
      failure ||= error;
    }
  } else if (events.length || decoder) {
    record.retained = {
      control,
      decoder: decoder !== null && !closed,
      events,
      watchers: watchers.map(w => ({
        name: w.name,
        base: w.base,
        thread: String(w.thread),
        joined: w.joined,
        selector: w.program.selector
      })),
      counters:
        control && !rpc.bridgeLost ? await counters().catch(e => 'unread: ' + e.message) : null,
      note: rpc.bridgeLost
        ? 'Bridge lost; no cleanup RPC sent. Restart SmileBASIC before another probe.'
        : 'A watcher or the decoder may still use these; nothing was finalized or destroyed'
    };
    console.error('Decoder event probe retained resources', record.retained);
  }

  record.finished = new Date().toISOString();
  record.verdict = failure ? 'FAIL' : 'PASS';
  if (failure) record.error = failure.message;
  await save();
  entries?.close();
  const loop = record.loop;
  if (loop && pipelined) {
    const {host, console: device} = loop;
    console.log(
      window === null ? 'burst:' : 'concurrency:',
      loop.submitted,
      'AUs,',
      loop.received,
      'frames,',
      loop.held,
      'held; host',
      host.fps,
      'fps over',
      host.spanMs,
      'ms, submit ms',
      JSON.stringify(host.submitMs),
      ', output interval ms',
      JSON.stringify(host.outputIntervalMs),
      ', input blocked',
      loop.inputBlocked
    );
    console.log(
      'console: input',
      device.inputFps,
      'fps, output',
      device.outputFps,
      'fps, output interval ms',
      JSON.stringify(device.outputIntervalMs),
      ', latency ms',
      JSON.stringify(device.latencyMs),
      ', one event per output',
      device.oneEventPerOutput,
      ', max in flight',
      device.maxInFlight
    );
    if (window !== null)
      console.log(
        'window:',
        JSON.stringify(loop.window),
        ', groups',
        JSON.stringify(record.windows)
      );
  } else if (loop) {
    console.log(
      'decoder events:',
      loop.submitted,
      'AUs,',
      loop.received,
      'frames,',
      loop.held,
      'held after drain; first output after AU',
      loop.firstOutputAfterAu,
      '; lag',
      JSON.stringify(loop.lagAus),
      '; display order',
      loop.displayOrder
    );
    console.log(
      'output event: seen on',
      loop.eventSeenAus + '/' + loop.submitted,
      'AUs, events/AU',
      JSON.stringify(loop.outputEventsPerAu),
      ', acquire after event',
      loop.acquiredAfterEvent + '/' + loop.eventSeenAus,
      ', output without event',
      loop.outputWithoutEvent,
      ', event ms',
      JSON.stringify(loop.eventMs)
    );
    console.log(
      'console latency ms (SendInput to output wake)',
      JSON.stringify(loop.consoleLatencyMs),
      ', host submit ms',
      JSON.stringify(loop.submitMs)
    );
    console.log(
      'input event: events/AU',
      JSON.stringify(loop.inputEventsPerAu),
      ', slot ready after send',
      loop.inputReadyAfterSend + '/' + loop.submitted,
      ', event without slot',
      loop.inputEventWithoutSlot
    );
  }
  if (record.correctness)
    console.log(
      'frames: matched',
      record.correctness.matched + '/' + record.correctness.compared,
      ', min psnr',
      record.correctness.minPsnr,
      ', luma max error',
      record.correctness.lumaMaxError
    );
  console.log(
    'DECODER EVENT PROBE ' + record.verdict + (failure ? ': ' + failure.message : ''),
    '(record ' + file + ')'
  );
  if (failure) throw failure;
  return record;
}

module.exports = {
  main,
  parseOptions,
  accessUnits,
  clipFrameRate,
  compareFrame,
  packNv12,
  summarize,
  summarizeBurst,
  CONTROL_BYTES,
  OUTPUT_EVENT,
  INPUT_EVENT,
  DECODER_EVENTS,
  OUTPUT_COUNT,
  INPUT_COUNT
};
if (require.main === module) {
  const args = process.argv.slice(2);
  main(
    require('../../../hbl-platform/sdk/host/session.cjs').resolve(args[0]),
    parseOptions(args)
  ).catch(e => {
    console.error(e);
    process.exitCode = 1;
  });
}
