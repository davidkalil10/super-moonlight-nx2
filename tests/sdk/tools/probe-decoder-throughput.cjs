// Console-paced H.264 throughput: preload the clip, then feed and drain it on two
// bounded console workers. A semaphore limits submitted but unacquired frames.
// Usage: probe-decoder-throughput.cjs [RUN_DIR] --clip ip1080.h264 --window 2|3
//        [--max-aus 2..120] [--dry-run]
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const cli = require('../cli.cjs');
const session = require('../host/session.cjs');
const {allocate} = require('../native/allocate.cjs');
const {create: createModule} = require('../native/module.cjs');
const {verify} = require('../native/symbols.cjs');
const {build, SENTINEL} = require('../../smilebasic/engine/shared/frames.cjs');
const {
  CODE,
  IPC_COPY,
  verifyCode,
  verifyCopy,
  verifyPreamble,
  spawn,
  wait,
  join
} = require('../native/thread.cjs');
const MOVIE = require('../native/movie-functions.json');
const EVENTS = require('../native/movie-event-functions.json');
const SYNC = require('../native/os-sync-functions.json');
const TIMING = require('../../smilebasic/engine/switch2/app/timing-code.json').functions;
const {accessUnits} = require('./probe-decoder-events.cjs');
const {parameterSets} = require('../../tools/moonlight/h264-stream.cjs');

const CONTROL_BYTES = 0x4000;
const OUTPUT_EVENT = 0x100;
const CREDITS = 0x140;
const DECODER_EVENTS = 0x180;
const INPUT_SLOTS = 0x400;
const OUTPUT_SLOTS = 0x1000;
const FRAME_OFFSET = 0x10000;
const WORKER_BYTES = 0x400000;
const AUTO_CLEAR = 1;
const SHORT = 2;
const align = (value, boundary) => Math.ceil(value / boundary) * boundary;
const codeResult = value => Number(BigInt.asUintN(32, value));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function loggedRpc(raw, entries) {
  const rpc = {...raw, bridgeLost: false};
  for (const operation of [
    'request',
    'call',
    'callAddress',
    'pair',
    'read',
    'write',
    'writeAndCall',
    'query'
  ]) {
    rpc[operation] = async (...args) => {
      const target = operation === 'request' ? args[0]?.command : args[0];
      entries.write({phase: 'before', operation, target});
      try {
        const value = await raw[operation](...args);
        entries.write({phase: 'after', operation, target});
        return value;
      } catch (error) {
        if (/disconnected|timed out|ECONN|EPIPE|socket hang up/i.test(error.message))
          rpc.bridgeLost = true;
        entries.write({phase: 'error', operation, target, message: error.message});
        throw error;
      }
    };
  }
  return rpc;
}

function plan({sdk, fn, sync, tick, copy, decoder, inputBuffer, control, payloads, window, bases}) {
  if (![2, 3].includes(window) || !payloads.length || payloads.length > 120)
    throw Error('Throughput plan needs 1..120 AUs and window 2 or 3');
  const verified = new Set(Object.values(fn));
  const padded = calls =>
    calls.map(call => ({
      ...call,
      args: [...call.args, ...Array(Math.max(0, 4 - call.args.length)).fill(0)]
    }));
  const inputCalls = [];
  const inputRows = [];
  for (const [index, payload] of payloads.entries()) {
    const slot = control + INPUT_SLOTS + index * 8;
    const row = {index, slot};
    row.credit = inputCalls.push({function: sync.acquireSemaphore, args: [control + CREDITS]}) - 1;
    if (index)
      row.acquire =
        inputCalls.push({
          function: fn.acquireInput,
          args: [decoder, slot, slot + 4]
        }) - 1;
    row.get =
      inputCalls.push({
        function: fn.getInput,
        args: [decoder, {u32: slot}, inputBuffer]
      }) - 1;
    row.data = inputCalls.push({function: fn.bufferData, args: [inputBuffer]}) - 1;
    row.copy =
      inputCalls.push({
        function: copy,
        args: [{u64: control}, payload.address, payload.length, 0]
      }) - 1;
    row.send =
      inputCalls.push({
        function: fn.sendInput,
        args: [decoder, {u32: slot}, 0, payload.length, BigInt(index + 1), 0]
      }) - 1;
    row.tick = inputCalls.push({function: tick, args: []}) - 1;
    inputRows.push(row);
  }
  const inputBase = bases.input + FRAME_OFFSET;
  const readyInput = padded(inputCalls);
  const initial = build(inputBase, sdk, readyInput, CODE, false, verified);
  for (const row of inputRows) {
    const nativeIndex = initial.proof.logicalResultIndices[row.data];
    readyInput[row.copy].args[0] = {
      u64: inputBase + initial.proof.resultOffsets[nativeIndex]
    };
  }
  const input = build(inputBase, sdk, readyInput, CODE, false, verified);
  if (input.frame.length > WORKER_BYTES - FRAME_OFFSET)
    throw Error('Input throughput frame exceeds its worker allocation');

  const outputCalls = [];
  const outputRows = [];
  for (let index = 0; index < payloads.length; index++) {
    const slot = control + OUTPUT_SLOTS + index * 32;
    const row = {index, slot};
    row.wait = outputCalls.push({function: sync.waitEvent, args: [control + OUTPUT_EVENT]}) - 1;
    row.acquire =
      outputCalls.push({
        function: fn.acquireOutput,
        args: [decoder, slot, slot + 8, slot + 16, slot + 20]
      }) - 1;
    row.tick = outputCalls.push({function: tick, args: []}) - 1;
    row.release =
      outputCalls.push({
        function: fn.releaseOutput,
        args: [decoder, {u32: slot}]
      }) - 1;
    row.credit = outputCalls.push({function: sync.releaseSemaphore, args: [control + CREDITS]}) - 1;
    outputRows.push(row);
  }
  const output = build(
    bases.output + FRAME_OFFSET,
    sdk,
    padded(outputCalls),
    CODE,
    false,
    verified
  );
  if (output.frame.length > WORKER_BYTES - FRAME_OFFSET)
    throw Error('Output throughput frame exceeds its worker allocation');
  return {input, output, inputRows, outputRows};
}

function logicalResult(program, bytes, index) {
  return bytes.readBigUInt64LE(
    program.proof.resultOffsets[program.proof.logicalResultIndices[index]] -
      program.proof.resultOffsets[0]
  );
}

function summarize(plan, inputResults, outputResults, outputSlots, frequency, window) {
  const sends = [];
  const outputs = [];
  for (const row of plan.inputRows) {
    const status = name => codeResult(logicalResult(plan.input, inputResults, row[name]));
    if (row.acquire !== undefined && status('acquire') !== 0)
      throw Error(`AcquireInput failed at AU ${row.index}: 0x${status('acquire').toString(16)}`);
    if (status('get') !== 0 || status('send') !== 0)
      throw Error(`Input call failed at AU ${row.index}`);
    const destination = logicalResult(plan.input, inputResults, row.data);
    if (!destination || logicalResult(plan.input, inputResults, row.copy) !== destination)
      throw Error(`Input copy failed at AU ${row.index}`);
    sends.push({au: row.index, tick: logicalResult(plan.input, inputResults, row.tick)});
  }
  for (const row of plan.outputRows) {
    const status = name => codeResult(logicalResult(plan.output, outputResults, row[name]));
    const index = outputSlots.readInt32LE(row.index * 32);
    const pts = outputSlots.readBigUInt64LE(row.index * 32 + 8);
    if (status('acquire') !== 0 || index < 0 || status('release') !== 0)
      throw Error(`Output call failed at AU ${row.index}`);
    if (pts !== BigInt(row.index + 1))
      throw Error(`Output PTS ${pts} at AU ${row.index}, expected ${row.index + 1}`);
    outputs.push({
      au: row.index,
      index,
      pts: String(pts),
      tick: logicalResult(plan.output, outputResults, row.tick)
    });
  }
  const timeline = [
    ...sends.map(row => ({tick: row.tick, delta: 1})),
    ...outputs.map(row => ({tick: row.tick, delta: -1}))
  ].sort((a, b) => (a.tick < b.tick ? -1 : a.tick > b.tick ? 1 : a.delta - b.delta));
  let inFlight = 0;
  let maxInFlight = 0;
  for (const event of timeline) {
    inFlight += event.delta;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (inFlight < 0 || inFlight > window)
      throw Error('Decoder in-flight count violated the window');
  }
  if (inFlight !== 0) throw Error('Decoder output count differs from input count');
  const intervals = outputs
    .slice(1)
    .map((row, index) => (Number(row.tick - outputs[index].tick) * 1000) / frequency);
  const elapsedMs = (Number(outputs.at(-1).tick - outputs[0].tick) * 1000) / frequency;
  const inputElapsedMs = (Number(sends.at(-1).tick - sends[0].tick) * 1000) / frequency;
  const sorted = [...intervals].sort((a, b) => a - b);
  const outputFps = elapsedMs > 0 ? ((outputs.length - 1) * 1000) / elapsedMs : null;
  const consoleOutputFps = outputFps === null ? null : Math.round(outputFps * 100) / 100;
  return {
    window,
    submitted: sends.length,
    acquired: outputs.length,
    maxInFlight,
    consoleInputFps:
      inputElapsedMs > 0 ? Math.round(((sends.length - 1) * 100000) / inputElapsedMs) / 100 : null,
    consoleOutputFps,
    target120Met: outputs.length >= 60 ? outputFps >= 120 : null,
    firstToLastOutputMs: Math.round(elapsedMs * 1000) / 1000,
    outputIntervalMs: intervals.length
      ? {
          p50: Math.round(sorted[Math.floor(sorted.length * 0.5)] * 1000) / 1000,
          p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 1000) / 1000,
          max: Math.round(sorted.at(-1) * 1000) / 1000
        }
      : null,
    outputPtsInOrder: true,
    conclusive: outputs.length >= 60 && maxInFlight === window,
    sample: {
      first: {...outputs[0], tick: String(outputs[0].tick)},
      last: {...outputs.at(-1), tick: String(outputs.at(-1).tick)}
    }
  };
}

async function main(directory, {clip, window, maxAus = 120, output, dryRun = false} = {}) {
  if (!clip) throw Error('Pass --clip with ip1080.h264');
  if (![2, 3].includes(window)) throw Error('--window must be 2 or 3');
  if (!Number.isInteger(maxAus) || maxAus < window || maxAus > 120)
    throw Error('--max-aus must be between the window and 120');
  directory = path.resolve(directory);
  clip = path.resolve(clip);
  const bytes = await fs.readFile(clip);
  const allUnits = accessUnits(bytes);
  const sidecar = JSON.parse(await fs.readFile(clip.replace(/\.h264$/, '.json')));
  if (
    sidecar.width !== 1920 ||
    sidecar.height !== 1080 ||
    sidecar.display.length !== allUnits.length ||
    sidecar.display.some((shown, index) => shown !== index) ||
    allUnits.length < maxAus ||
    !allUnits[0].keyframe
  )
    throw Error('R3 needs an ordered 1080p IP clip with enough access units');
  const units = allUnits.slice(0, maxAus);
  const {sps, pps} = parameterSets(bytes);
  if (!sps || !pps) throw Error('Clip lacks H.264 parameter sets');
  if (dryRun) {
    const sdk = 0x10000000;
    const payloads = [];
    let total = 0;
    for (const unit of units) {
      total = align(total, 16);
      payloads.push({address: 0x53000000 + total, length: unit.data.length});
      total += unit.data.length;
    }
    const fn = Object.fromEntries(
      Object.entries(MOVIE).map(([name, definition]) => [name, 0x20000000 + definition.offset])
    );
    const sync = Object.fromEntries(
      ['acquireSemaphore', 'releaseSemaphore', 'waitEvent'].map(name => [
        name,
        sdk + SYNC[name].offset
      ])
    );
    const programs = plan({
      sdk,
      fn,
      sync,
      tick: sdk + TIMING.tick.offset,
      copy: sdk + IPC_COPY.offset,
      decoder: 0x54000000,
      inputBuffer: 0x54000200,
      control: 0x52000000,
      payloads,
      window,
      bases: {input: 0x50000000, output: 0x51000000}
    });
    const result = {
      dryRun: true,
      window,
      accessUnits: units.length,
      maxUnitBytes: Math.max(...units.map(unit => unit.data.length)),
      payloadBytes: align(total, 4096),
      inputCalls: programs.input.proof.logicalCalls,
      outputCalls: programs.output.proof.logicalCalls,
      inputFrameBytes: programs.input.frame.length,
      outputFrameBytes: programs.output.frame.length
    };
    console.log(JSON.stringify(result));
    return result;
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8'
  }).trim();
  output ||= path.join(
    '/media/storage2/builds/HBLauncher/native-h264',
    new Date().toISOString().replace(/[:.]/g, '-') +
      '-' +
      revision.slice(0, 8) +
      '-r3-throughput-w' +
      window
  );
  await fs.mkdir(output, {recursive: true, mode: 0o700});
  const entries = journal(path.join(output, 'decoder-throughput.jsonl'));
  const rpc = loggedRpc(session.rpc(directory), entries);
  const record = {
    probe: 'decoder-throughput',
    session: rpc.a.session,
    protocol: rpc.a.protocol,
    sourceRevision: revision,
    builder: os.hostname(),
    targetArchitecture: 'aarch64',
    command: process.argv,
    started: new Date().toISOString(),
    clip,
    clipSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    window,
    accessUnits: units.length
  };
  const report = path.join(output, 'decoder-throughput.json');
  const save = () => fs.writeFile(report, JSON.stringify(record, null, 2) + '\n', {mode: 0o600});
  await save();
  let api,
    started = false,
    eventReady = false,
    semaphoreReady = false;
  let decoderReady = false,
    configReady = false,
    inputReady = false;
  let inputThread = null,
    outputThread = null,
    joined = false;
  let failure = null;
  try {
    if (!rpc.host) throw Error('R3 needs a fresh normal START session');
    await verifyCode(rpc);
    await verifyCopy(rpc);
    await verifyPreamble(rpc);
    await verifyCode(rpc, [TIMING.tick, TIMING.frequency]);
    for (const name of [
      'initializeEvent',
      'waitEvent',
      'finalizeEvent',
      'initializeSemaphore',
      'acquireSemaphore',
      'releaseSemaphore',
      'finalizeSemaphore'
    ])
      await verify(rpc, rpc.a.sdk + SYNC[name].offset, SYNC[name].hex);
    const module = JSON.parse(await fs.readFile(path.join(directory, 'compatibility-module.json')));
    for (const definition of Object.values(MOVIE))
      if (
        !module.symbols.some(
          symbol =>
            symbol.name === definition.symbol &&
            symbol.section &&
            symbol.offset === definition.offset &&
            symbol.size === definition.size
        )
      )
        throw Error('Loaded movie module differs from the R3 decoder catalog');
    const register = EVENTS.registerClientEvents;
    if (
      !module.symbols.some(
        symbol =>
          symbol.name === register.symbol &&
          symbol.offset === register.offset &&
          symbol.size === register.size
      )
    )
      throw Error('Loaded movie module differs from the R3 event catalog');
    await verify(rpc, module.base + register.offset, register.hex);
    api = await createModule(rpc, {base: module.base, definitions: MOVIE, directory: output});
    const fn = api.functions;
    const decoder = api.base;
    const config = api.base + 0x100;
    const inputBuffer = api.base + 0x200;
    const spsAt = api.base + 0x1000;
    const ppsAt = api.base + 0x2000;
    const keyAt = api.base + 0x3000;
    const valueAt = api.base + 0x4000;
    const control = await allocate(rpc, CONTROL_BYTES, {
      failed: 'R3 control allocation failed',
      invalid: 'Invalid R3 control allocation'
    });
    record.control = control;
    await rpc.write(control, Buffer.alloc(CONTROL_BYTES));
    const eventPointers = Buffer.alloc(16);
    eventPointers.writeBigUInt64LE(BigInt(control + OUTPUT_EVENT), 8);
    await rpc.write(control + DECODER_EVENTS, eventPointers);
    await rpc.callAddress(
      rpc.a.sdk + SYNC.initializeEvent.offset,
      [control + OUTPUT_EVENT, 0, AUTO_CLEAR, 0],
      SHORT
    );
    eventReady = true;
    await rpc.callAddress(
      rpc.a.sdk + SYNC.initializeSemaphore.offset,
      [control + CREDITS, window, window],
      SHORT
    );
    semaphoreReady = true;
    await api.call('decoderCreate', [decoder, 1, 4]);
    decoderReady = true;
    if (!(await api.read(8, 8)).readBigUInt64LE())
      throw Error('R3 movie decoder did not initialize');
    await api.call('mediaCreate', [config]);
    configReady = true;
    if (!(await api.read(0x100, 8)).readBigUInt64LE())
      throw Error('R3 configuration metadata did not initialize');
    await api.call('bufferCreate', [inputBuffer]);
    inputReady = true;
    await api.write(0x1000, sps);
    await api.write(0x2000, pps);
    if (
      codeResult(
        await api.call('createH264Configuration', [spsAt, sps.length, ppsAt, pps.length, config])
      ) !== 1
    )
      throw Error('Native H.264 configuration rejected R3 clip');
    await api.write(0x3000, Buffer.from('frame-rate\0'));
    await api.call('mediaSetInt', [config, keyAt, 120]);
    if (codeResult(await api.call('configure', [decoder, config])) !== 0)
      throw Error('R3 decoder configuration failed');
    if (
      codeResult(
        (
          await rpc.callAddress(
            module.base + register.offset,
            [decoder, control + DECODER_EVENTS],
            SHORT
          )
        ).result
      ) !== 0
    )
      throw Error('R3 output event registration failed');
    if (codeResult(await api.call('start', [decoder])) !== 0)
      throw Error('R3 decoder start failed');
    started = true;

    const first = await rpc.callAddress(
      fn.acquireInput,
      [decoder, control + INPUT_SLOTS, control + INPUT_SLOTS + 4],
      SHORT
    );
    const firstIndex = (await rpc.read(control + INPUT_SLOTS, 4)).readInt32LE();
    if (codeResult(first.result) !== 0 || firstIndex < 0)
      throw Error('R3 could not acquire its first input slot');
    if (codeResult(await api.call('getInput', [decoder, firstIndex, inputBuffer])) !== 0)
      throw Error('R3 could not inspect its first input buffer');
    const capacity = Number(await api.call('bufferCapacity', [inputBuffer]));
    const maxUnitBytes = Math.max(...units.map(unit => unit.data.length));
    const firstAddress = Number(await api.call('bufferData', [inputBuffer]));
    const region = await rpc.query(firstAddress);
    if (
      capacity < maxUnitBytes ||
      !firstAddress ||
      firstAddress + maxUnitBytes > region.address + region.size ||
      (region.permissions & 3) !== 3
    )
      throw Error('R3 access units do not fit the native input buffer');
    record.input = {firstIndex, capacity, maxUnitBytes};
    const frequency = Number(
      (await rpc.callAddress(rpc.a.sdk + TIMING.frequency.offset, [], SHORT)).result
    );
    if (!frequency) throw Error('R3 console tick frequency is zero');
    record.tickFrequency = frequency;

    const payloads = [];
    let total = 0;
    for (const unit of units) {
      total = align(total, 16);
      payloads.push({offset: total, length: unit.data.length});
      total += unit.data.length;
    }
    const payloadBase = await allocate(rpc, align(total, 4096), {
      failed: 'R3 clip allocation failed',
      invalid: 'Invalid R3 clip allocation'
    });
    for (const [index, unit] of units.entries()) {
      payloads[index].address = payloadBase + payloads[index].offset;
      await rpc.write(payloads[index].address, unit.data);
    }
    const inputBase = await allocate(rpc, WORKER_BYTES, {
      failed: 'R3 input worker allocation failed',
      invalid: 'Invalid R3 input worker allocation'
    });
    const outputBase = await allocate(rpc, WORKER_BYTES, {
      failed: 'R3 output worker allocation failed',
      invalid: 'Invalid R3 output worker allocation'
    });
    const sync = Object.fromEntries(
      ['acquireSemaphore', 'releaseSemaphore', 'waitEvent'].map(name => [
        name,
        rpc.a.sdk + SYNC[name].offset
      ])
    );
    const programs = plan({
      sdk: rpc.a.sdk,
      fn,
      sync,
      tick: rpc.a.sdk + TIMING.tick.offset,
      copy: rpc.a.sdk + IPC_COPY.offset,
      decoder,
      inputBuffer,
      control,
      payloads,
      window,
      bases: {input: inputBase, output: outputBase}
    });
    record.programs = {
      inputCalls: programs.input.proof.logicalCalls,
      outputCalls: programs.output.proof.logicalCalls,
      inputBytes: programs.input.frame.length,
      outputBytes: programs.output.frame.length,
      inputSha256: crypto.createHash('sha256').update(programs.input.frame).digest('hex'),
      outputSha256: crypto.createHash('sha256').update(programs.output.frame).digest('hex')
    };
    await save();
    await rpc.write(inputBase + FRAME_OFFSET, programs.input.frame);
    await rpc.write(outputBase + FRAME_OFFSET, programs.output.frame);
    outputThread = await spawn(rpc, outputBase, outputBase + FRAME_OFFSET, {
      failed: 'R3 output worker creation failed',
      outputBytes: SHORT
    });
    record.threads = {output: String(outputThread)};
    await save();
    inputThread = await spawn(rpc, inputBase, inputBase + FRAME_OFFSET, {
      failed: 'R3 input worker creation failed',
      outputBytes: SHORT
    });
    record.threads.input = String(inputThread);
    await save();
    await pause(2000);
    const inputStopped = await wait(rpc, inputThread, {
      timeoutMs: 30000,
      pollMs: 250,
      invalid: 'R3 input worker state invalid',
      outputBytes: SHORT
    });
    const outputStopped = await wait(rpc, outputThread, {
      timeoutMs: 30000,
      pollMs: 250,
      invalid: 'R3 output worker state invalid',
      outputBytes: SHORT
    });
    if (!inputStopped || !outputStopped) {
      const pending = async (base, program) => {
        const results = await rpc.read(
          base + FRAME_OFFSET + program.proof.resultOffsets[0],
          program.proof.resultOffsets.length * 8
        );
        for (let index = 0; index < results.length / 8; index++)
          if (results.readBigUInt64LE(index * 8) === SENTINEL) return index;
        return null;
      };
      record.pendingCalls = {
        input: await pending(inputBase, programs.input).catch(() => null),
        output: await pending(outputBase, programs.output).catch(() => null)
      };
      throw Error('R3 worker timed out; decoder and events retained, restart SmileBASIC');
    }
    await join(rpc, inputThread, inputBase + 8, {
      failed: 'R3 input worker join failed',
      outputBytes: SHORT
    });
    await join(rpc, outputThread, outputBase + 8, {
      failed: 'R3 output worker join failed',
      outputBytes: SHORT
    });
    joined = true;
    const readResults = async (base, program) =>
      rpc.read(
        base + FRAME_OFFSET + program.proof.resultOffsets[0],
        program.proof.resultOffsets.length * 8
      );
    const [inputResults, outputResults, outputSlots] = await Promise.all([
      readResults(inputBase, programs.input),
      readResults(outputBase, programs.output),
      rpc.read(control + OUTPUT_SLOTS, units.length * 32)
    ]);
    for (const results of [inputResults, outputResults])
      for (let offset = 0; offset < results.length; offset += 8)
        if (results.readBigUInt64LE(offset) === SENTINEL)
          throw Error('R3 worker skipped a native call');
    record.measurement = summarize(
      programs,
      inputResults,
      outputResults,
      outputSlots,
      frequency,
      window
    );
    if (record.measurement.maxInFlight !== window)
      throw Error('R3 worker did not sustain the requested concurrency window');
    record.verdict = 'PASS';
  } catch (error) {
    failure = error;
    record.verdict = 'FAIL';
    record.error = error.message;
  } finally {
    const cleanup = [];
    if ((!inputThread && !outputThread) || joined) {
      if (api && !rpc.bridgeLost) {
        const close = async (label, action) => {
          try {
            await action();
          } catch (error) {
            cleanup.push(label + ': ' + error.message);
          }
        };
        if (started)
          await close('decoder stop', async () => {
            if (codeResult(await api.call('stop', [api.base])) !== 0)
              throw Error('movie::Stop failed');
          });
        if (inputReady)
          await close('input buffer destroy', () => api.call('bufferDestroy', [api.base + 0x200]));
        if (configReady)
          await close('configuration destroy', () => api.call('mediaDestroy', [api.base + 0x100]));
        if (decoderReady)
          await close('decoder destroy', () => api.call('decoderDestroy', [api.base]));
        if (semaphoreReady)
          await close('semaphore finalize', () =>
            rpc.callAddress(
              rpc.a.sdk + SYNC.finalizeSemaphore.offset,
              [record.control + CREDITS],
              SHORT
            )
          );
        if (eventReady)
          await close('event finalize', () =>
            rpc.callAddress(
              rpc.a.sdk + SYNC.finalizeEvent.offset,
              [record.control + OUTPUT_EVENT],
              SHORT
            )
          );
      }
    } else record.retainedForSafety = true;
    if (rpc.bridgeLost) record.retainedForSafety = true;
    if (cleanup.length) {
      record.cleanupErrors = cleanup;
      record.verdict = 'FAIL';
    }
    record.finished = new Date().toISOString();
    await save();
    entries.close();
  }
  console.log(`R3 DECODER THROUGHPUT ${record.verdict} (${report})`);
  if (record.measurement) console.log(JSON.stringify(record.measurement));
  if (failure) throw failure;
  if (record.verdict !== 'PASS') throw Error(record.cleanupErrors?.join('; ') || 'R3 probe failed');
  return record;
}

module.exports = {main, plan, summarize};
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = name => cli.option(args, name);
  main(session.resolve(args[0]), {
    clip: get('--clip'),
    window: Number(get('--window')),
    maxAus: args.includes('--max-aus') ? Number(get('--max-aus')) : 120,
    output: get('--output'),
    dryRun: args.includes('--dry-run')
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
