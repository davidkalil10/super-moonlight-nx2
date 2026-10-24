// Decoder event probe for the persistent decode worker. A plain EventType registered through
// RegisterClientEvents is watched by a repeating worker (WaitEvent, then an atomic add), so
// the host can count output-ready (and input-available) notifications per access unit while
// it feeds an offline clip, acquires every output itself and checks the frames.
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const cli = require('../cli.cjs');
const {allocate} = require('../native/allocate.cjs');
const {verify} = require('../native/symbols.cjs');
const {prepare} = require('../native/repeating.cjs');
const {CODE: code, verifyCode, verifyCopy, spawn, wait, join} = require('../native/thread.cjs');
const {nals, parameterSets} = require('../../tools/moonlight/h264-stream.cjs');
const SYNC = require('../native/os-sync-functions.json');
const MOVIE_EVENTS = require('../native/movie-event-functions.json');

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
      .length
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
    output = process.env.HB_NATIVE_LOG_DIR,
    createDecoder = require('../../tools/moonlight/native-decoder.cjs').create
  } = {}
) {
  if (!clip) throw Error('Expected --clip <file.h264>');
  directory = path.resolve(directory);
  const rpc = require(path.join(directory, 'shared/rpc.cjs')),
    sdk = rpc.a.sdk;
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
  const units = accessUnits(bytes);
  const sidecar = clip.replace(/\.h264$/, '.json');
  const timing = await fs.readFile(sidecar, 'utf8').then(JSON.parse, () => null);
  const display = timing?.display ?? units.map((_, i) => i);
  if (display.length !== units.length) throw Error('Clip timing does not match its AUs');
  reference ??= await fs.access(clip.replace(/\.h264$/, '-reference.nv12')).then(
    () => clip.replace(/\.h264$/, '-reference.nv12'),
    () => null
  );
  const references = reference ? await fs.readFile(reference) : null;
  const {sps, pps} = parameterSets(bytes);
  if (!sps || !pps) throw Error('Clip has no SPS/PPS');

  const record = {
    probe: 'decoder-events',
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
      stopTimeoutMs
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
  let started = null;
  // Kept for a run that fails part way, so the AUs that did run still answer.
  function conclude() {
    const fed = new Set(rows.map(row => row.display));
    const held = [...expected].filter(shown => fed.has(shown)).sort((a, b) => a - b);
    record.loop = {
      totalMs: round(performance.now() - started),
      ...summarize(rows, frames, held)
    };
    const compared = frames.filter(f => f.match !== undefined);
    record.correctness = {
      compared: compared.length,
      matched: compared.filter(f => f.match).length,
      minPsnr: compared.length ? Math.min(...compared.map(f => f.psnr)) : null,
      lumaMaxError: compared.length ? Math.max(...compared.map(f => f.lumaMaxError)) : null,
      first: frames.length ? {display: frames[0].display, sha256: frames[0].sha256} : null,
      last: frames.length ? {display: frames.at(-1).display, sha256: frames.at(-1).sha256} : null
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
    for (const name of USED) {
      await verify(rpc, sdk + SYNC[name].offset, SYNC[name].hex);
      fn[name] = sdk + SYNC[name].offset;
    }
    const module = JSON.parse(
      await fs.readFile(path.join(directory, 'compatibility-module.json'), 'utf8')
    );
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
          {function: fn.atomicAddU32, args: [1, w.counter]}
        ]
      });
      const watcher = {...w, base, program, thread: null, joined: false};
      watchers.push(watcher);
      watcher.thread = await spawn(rpc, base, program.live, {
        failed: 'Event watcher creation failed'
      });
    }
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
    const frameBytes = (dimensions.width * dimensions.height * 3) / 2;
    const surfaceBytes = Math.ceil((frameBytes * 2) / 0x1000) * 0x1000;
    const destination = {
      address: await allocate(rpc, surfaceBytes, {
        failed: 'Output surface allocation failed',
        invalid: 'Invalid output surface allocation'
      }),
      bytes: surfaceBytes
    };
    await sleep(settleMs);
    record.afterStart = await counters();

    const exchanges = {submit: 0, counterRead: 0, receive: 0, frameRead: 0};
    record.units = rows;
    record.frames = frames;
    record.exchangeCalls = exchanges;
    async function take(afterAu) {
      exchanges.receive++;
      const frame = await decoder.receive(destination);
      if (!frame) return null;
      const shown = Number(frame.pts);
      const row = {display: shown, afterAu};
      if (!expected.delete(shown)) throw Error('Unexpected or repeated output pts ' + frame.pts);
      exchanges.frameRead++;
      const surface = await rpc.read(
        destination.address,
        (frame.stride * frame.sliceHeight * 3) / 2
      );
      const packed = packNv12(surface, frame);
      row.sha256 = sha256(packed);
      if (references) {
        const want = references.subarray(shown * frameBytes, (shown + 1) * frameBytes);
        if (want.length === frameBytes)
          Object.assign(row, compareFrame(packed, want, frame.width, frame.height));
      }
      frames.push(row);
      return row;
    }

    started = performance.now();
    for (let au = 0; au < units.length; au++) {
      const before = await counters();
      exchanges.counterRead++;
      const at = performance.now();
      await decoder.submit({data: units[au].data, pts: display[au]}, {acquireOutput: false});
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
        firstTry: outputs.length > 0,
        outputs,
        outputEvents: after.output - before.output,
        inputEvents: after.input - before.input
      });
    }
    // Whatever is still inside the decoder after the last AU, given time but no more input.
    const drainStarted = performance.now();
    while (expected.size && performance.now() - drainStarted < drainMs) {
      if (!(await take(null))) await sleep(pollMs * 4);
    }
    record.drain = {...(await counters()), ms: round(performance.now() - drainStarted)};
    const compared = conclude();
    if (compared.length !== compared.filter(f => f.match).length)
      throw Error('Decoded frames differ from the reference');
    if (references && !compared.length && frames.length) throw Error('No frame was compared');
  } catch (error) {
    failure = error;
    if (rows.length && !record.loop) conclude();
  }

  // A watcher blocked in WaitEvent only sees the stop selector after a wake, and the decoder's
  // own thread may signal the same events, so extra bodies are expected and not judged.
  if (watchers.length) {
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
  if (decoder && settled) {
    try {
      await decoder.close();
      closed = true;
      record.decoderClosed = true;
    } catch (error) {
      failure ||= error;
    }
  }
  if (events.length && settled && closed) {
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
      counters: control ? await counters().catch(e => 'unread: ' + e.message) : null,
      note: 'A watcher or the decoder may still use these; nothing was finalized or destroyed'
    };
    console.error('Decoder event probe retained resources', record.retained);
  }

  record.finished = new Date().toISOString();
  record.verdict = failure ? 'FAIL' : 'PASS';
  if (failure) record.error = failure.message;
  await save();
  const loop = record.loop;
  if (loop) {
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
  accessUnits,
  compareFrame,
  packNv12,
  summarize,
  CONTROL_BYTES,
  OUTPUT_EVENT,
  INPUT_EVENT,
  DECODER_EVENTS,
  OUTPUT_COUNT,
  INPUT_COUNT
};
if (require.main === module) {
  const args = process.argv.slice(2);
  main(require('../host/session.cjs').resolve(args[0]), {
    clip: cli.option(args, '--clip') || undefined,
    reference: cli.option(args, '--reference') || undefined,
    watchInput: !args.includes('--no-input-watch'),
    settleMs: cli.number(args, '--settle-ms', 250),
    drainMs: cli.number(args, '--drain-ms', 1000),
    output: cli.option(args, '--output') || undefined
  }).catch(e => {
    console.error(e);
    process.exitCode = 1;
  });
}
