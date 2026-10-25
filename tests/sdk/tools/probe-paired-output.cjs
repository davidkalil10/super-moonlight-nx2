const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const cli = require('../cli.cjs');
const session = require('../host/session.cjs');
const {accessUnits, clipFrameRate} = require('./probe-decoder-events.cjs');
const {loggedRpc, verifyPublication} = require('./probe-split-decoder.cjs');
const {parameterSets} = require('../../tools/moonlight/h264-stream.cjs');
const {findPrivateStorage} = require('../../tools/moonlight/feed.cjs');
const {create: createDecoder} = require('../../tools/moonlight/native-decoder.cjs');
const {create: createTransport} = require('../../tools/moonlight/native-tcp.cjs');
const {create: createSink} = require('../../tools/moonlight/native-sink.cjs');
const {create: createSplit} = require('../../tools/moonlight/split-decoder-worker.cjs');
const {create: createPairedOutput} = require('../../tools/moonlight/paired-output-worker.cjs');
const {create: createPairedLoop} = require('../../tools/moonlight/paired-loop-worker.cjs');
const acquireFrame = require('../../tools/moonlight/paired-acquire-frame.cjs');
const outputFrame = require('../../tools/moonlight/paired-output-frame.cjs');
const loopFrame = require('../../tools/moonlight/paired-loop-plan.cjs');
const ring = require('../../tools/moonlight/ring.cjs');
const {SENTINEL} = require('../../smilebasic/engine/shared/frames.cjs');

const STAGES = [
  'two',
  'four',
  'stop-input',
  'stop-output',
  'short-recv',
  'loop-two',
  'loop-four',
  'loop-odd',
  'loop-keyframe',
  'loop-overlap',
  'loop-stop-input',
  'loop-stop-output',
  'loop-stop-present',
  'loop-short-recv'
];
const BUILD_ROOT = '/media/storage2/builds/HBLauncher/native-h264';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function pairIndices(scenario, keyframes) {
  const idr = keyframes[1];
  if (scenario === 'four' || scenario === 'overlap') return [[1, 2], [3, 4]];
  if (scenario === 'odd') return [[idr]];
  if (scenario === 'keyframe') {
    if (idr <= 2 || keyframes[2] <= idr + 2)
      throw Error('Keyframe recovery probe needs two P frames on each side of the IDR');
    return [[1, 2], [idr], [idr + 1, idr + 2]];
  }
  return [[idr, keyframes[2]]];
}

async function stageOverlappedInput(decoder, unit, step) {
  await step('next pair first input staged while current pair is held', () =>
    decoder.stageSplitInput(unit, {sendFirst: true})
  );
  await step('next pair first exact receive check', () => decoder.verifySplitReceive());
  const priorGates = decoder.splitDiagnostics.decodeGateSignals;
  let failed = null;
  const completion = decoder.completeSplitInput().then(
    value => ({value}),
    error => {
      failed = error;
      return {error};
    }
  );
  await step('next pair first decode gate opened', async () => {
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      if (failed) throw failed;
      if (decoder.splitDiagnostics.decodeGateSignals > priorGates) return;
      await pause(5);
    }
    throw Error('Overlapped input decode gate did not open');
  });
  return {completion};
}

async function retryableStartup(record, directory, file) {
  if (
    file !== 'paired-output.json' ||
    record.probe !== 'paired-output' ||
    record.verdict !== 'FAIL' ||
    record.retainedForSafety !== false
  )
    return false;
  let entries;
  try {
    const journal = await fsp.readFile(path.join(directory, 'paired-output.jsonl'), 'utf8');
    entries = journal.trim() ? journal.trim().split('\n').map(line => JSON.parse(line)) : [];
  } catch {
    return false;
  }
  if (record.error === 'Start a new normal START session before paired output')
    return entries.length === 0;
  if (
    record.error !== 'Relaunch Moonlight after rebuilding its native-video shaders' &&
    !/^Moonlight native video did not initialize/.test(record.error)
  )
    return false;
  const reads = entries.filter(entry => entry.operation === 'read');
  return (
    reads.length > 0 &&
    entries.every(entry => entry.operation === undefined || entry.operation === 'read') &&
    reads.every(entry => entry.phase === 'before' || entry.phase === 'after') &&
    reads.filter(entry => entry.phase === 'before').length ===
      reads.filter(entry => entry.phase === 'after').length
  );
}

async function requireNewPairedSession(id, root = BUILD_ROOT) {
  for (const name of await fsp.readdir(root)) {
    if (!/-audio-|-r3-|-split-/.test(name)) continue;
    const directory = path.join(root, name);
    for (const file of [
      'paired-output.json',
      'audio-socket-loop.json',
      'audio-event.json',
      'decoder-throughput.json',
      'ladder.json',
      'result.json'
    ]) {
      try {
        const record = JSON.parse(await fsp.readFile(path.join(directory, file), 'utf8'));
        if (record.session === id) {
          if (await retryableStartup(record, directory, file)) continue;
          throw Object.assign(Error('Start a new normal START session before paired output'), {
            prior: path.join(directory, file)
          });
        }
      } catch (error) {
        if (error.prior) throw error;
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
  }
}

async function waitForNativeReady(rpc, storage, {timeoutMs = 30000, pollMs = 100} = {}) {
  const until = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < until) {
    last = (await rpc.read(storage.mapped + ring.CONTROL.nativeReady, 4)).readUInt32LE();
    if (last === ring.NATIVE_ABI) return;
    await pause(pollMs);
  }
  throw Error(`Moonlight native video did not initialize (ABI 0x${last.toString(16)})`);
}

async function createLoopAdapter(options) {
  const worker = await createPairedLoop(options);
  let started = false;
  let nextSequence = 0;
  return {
    async startAcquire(count = 2) {
      if (!started) {
        await worker.start();
        started = true;
      }
      const sequence = ++nextSequence;
      await worker.beginPair(sequence, count);
      return {sequence};
    },
    async finishAcquire(_plan, expectedPts) {
      return (await worker.acquire(expectedPts)).map(item => ({...item, status: 0}));
    },
    async waitFirstAcquire(expectedPts) {
      const until = Date.now() + 2000;
      while (Date.now() < until) {
        const snapshot = await worker.snapshot();
        const results = Buffer.from(snapshot.results, 'hex');
        const slots = Buffer.from(snapshot.acquiredSlots, 'hex');
        const value = results.readBigUInt64LE();
        if (value !== SENTINEL) {
          const index = slots.readInt32LE();
          const pts = slots.readBigUInt64LE(8);
          if (Number(BigInt.asUintN(32, value)) !== 0 || index < 0 || pts !== expectedPts)
            throw Error('Overlapped first output acquire failed or PTS differs');
          return {index, pts};
        }
        await pause(5);
      }
      throw Error('Overlapped first output acquisition timed out');
    },
    async fetch(index, destinations, frame) {
      if (index === 0) await worker.openFetch(destinations, frame);
      const result = index === 0 ? await worker.finishFirst() : await worker.finishSecond();
      return {index, ...result};
    },
    async stopDuringPresentation(destinations, frame) {
      await worker.openFetch(destinations, frame);
      const until = Date.now() + 2000;
      let published = false;
      while (Date.now() < until) {
        const snapshot = await worker.snapshot();
        const results = Buffer.from(snapshot.results, 'hex');
        const firstSequenceOffset =
          loopFrame.CONTROL.firstResults - loopFrame.CONTROL.acquireResults + 24;
        if (results.readUInt32LE(firstSequenceOffset) === nextSequence) {
          published = true;
          break;
        }
        await pause(5);
      }
      if (!published) throw Error('First output was not published before stop-present');
      const actualSequence = destinations[0].sequence;
      destinations[0].sequence += 10000;
      const waiting = worker.finishFirst().then(
        () => null,
        error => error.message
      );
      await pause(25);
      await worker.stop();
      const message = await waiting;
      if (!/stopped while waiting for presentation/.test(message ?? ''))
        throw Error('Stopping the presentation wait did not cancel it promptly');
      return {actualSequence, cancelledWait: message, joined: worker.diagnostics.joined};
    },
    stop: () => worker.stop(),
    snapshot: () => worker.snapshot(),
    get diagnostics() {
      return worker.diagnostics;
    }
  };
}

function journal(file) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  let sequence = 0;
  return {
    write(value) {
      fs.writeSync(
        descriptor,
        JSON.stringify({sequence: ++sequence, at: new Date().toISOString(), ...value}) + '\n'
      );
      fs.fsyncSync(descriptor);
    },
    close() {
      fs.closeSync(descriptor);
    }
  };
}

async function main(
  directory,
  {clip, stage, output, dryRun = false, allowSameSession = false} = {}
) {
  if (!STAGES.includes(stage)) throw Error('Use --stage ' + STAGES.join('|'));
  const scenario = stage.replace(/^loop-/, '');
  const looping = scenario !== stage;
  if (!clip) throw Error('Pass --clip with the ordered 1080p IP clip');
  directory = path.resolve(directory);
  clip = path.resolve(clip);
  const stream = await fsp.readFile(clip);
  const units = accessUnits(stream);
  const sidecar = JSON.parse(await fsp.readFile(clip.replace(/\.h264$/, '.json')));
  if (
    sidecar.width !== 1920 ||
    sidecar.height !== 1080 ||
    sidecar.display.length !== units.length ||
    sidecar.display.some((shown, index) => shown !== index)
  )
    throw Error('Paired output probe needs an ordered 1080p clip');
  const fps = clipFrameRate(sidecar);
  const keyframes = units.flatMap((unit, index) => (unit.keyframe ? [index] : []));
  if (keyframes.length < 3) throw Error('Paired output probe needs three independent keyframes');
  const {sps, pps} = parameterSets(stream);
  if (!sps || !pps) throw Error('Paired output clip has no H.264 parameter sets');
  if (dryRun) {
    const sdk = 0x40000000;
    const decoder = 0x50000000;
    const mapped = 0x60000000;
    const functions = {
      acquireOutput: 0x70000000,
      bufferSetData: 0x70000004,
      getOutput: 0x70000008,
      releaseOutput: 0x7000000c
    };
    const acquired = [1n, 2n].map((pts, index) => ({status: 0, index, pts}));
    const destinations = [1, 2].map((index, offset) => ({
      index,
      address: mapped + ring.frameOffset(index),
      bytes: ring.FRAME_BYTES,
      color: 1,
      sequence: offset + 1
    }));
    const options = {
      sdk,
      functions,
      decoder,
      output: decoder + 0x300,
      format: decoder + 0x180,
      publication: {mapped, color: 1},
      acquired,
      acquiredSlots: [0x51000100, 0x51000140],
      metadataSlots: [0x51000200, 0x51000240],
      destinations,
      frame: {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088},
      base: 0x52010000
    };
    const acquire = acquireFrame.plan({
      sdk,
      acquireOutput: functions.acquireOutput,
      decoder,
      event: 0x51000300,
      slots: options.acquiredSlots,
      base: options.base
    });
    const fetch = [0, 1].map(index => outputFrame.plan({...options, index}));
    const loopPlan = looping
      ? loopFrame.plan({
          sdk,
          base: 0x52000000,
          control: 0x53000000,
          event: 0x51000300,
          functions,
          decoder,
          output: options.output,
          format: options.format,
          publication: options.publication
        })
      : null;
    const result = {
      dryRun: true,
      stage,
      fps,
      keyframes: keyframes.slice(0, 3),
      pairs: pairIndices(scenario, keyframes),
      looping,
      acquireCalls: acquire.program.proof.logicalCalls,
      acquireBytes: acquire.program.frame.length,
      fetchCalls: fetch.map(item => item.program.proof.logicalCalls),
      fetchBytes: fetch.map(item => item.program.frame.length),
      ...(loopPlan
        ? {
            loopCalls: Object.fromEntries(
              ['gate', 'acquire', 'singleAcquire', 'first', 'second', 'singleFirst'].map(name => [
                name,
                loopPlan[name].proof.logicalCalls
              ])
            ),
            loopBytes: Object.fromEntries(
              ['gate', 'acquire', 'singleAcquire', 'first', 'second', 'singleFirst'].map(name => [
                name,
                loopPlan[name].frame.length
              ])
            )
          }
        : {})
    };
    console.log(JSON.stringify(result));
    return result;
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8'
  }).trim();
  output ||= path.join(
    BUILD_ROOT,
    new Date().toISOString().replace(/[:.]/g, '-') +
      '-' +
      revision.slice(0, 8) +
      '-r3-paired-' +
      stage
  );
  const rawRpc = session.rpc(directory);
  if (!rawRpc.host) throw Error('Paired output probe needs a normal START session');
  if (!allowSameSession) await requireNewPairedSession(rawRpc.a.session);
  await fsp.mkdir(output, {recursive: true, mode: 0o700});
  const entries = journal(path.join(output, 'paired-output.jsonl'));
  const rpc = loggedRpc(rawRpc, entries);
  const record = {
    probe: 'paired-output',
    stage,
    session: rpc.a.session,
    sourceRevision: revision,
    builder: os.hostname(),
    targetArchitecture: 'aarch64',
    command: process.argv,
    clip,
    fps,
    started: new Date().toISOString()
  };
  const report = path.join(output, 'paired-output.json');
  const save = () => fsp.writeFile(report, JSON.stringify(record, null, 2) + '\n', {mode: 0o600});
  await save();
  let transport = null;
  let decoder = null;
  let sink = null;
  let paired = null;
  let failure = null;
  let retained = false;
  const step = async (name, run) => {
    entries.write({phase: 'before', step: name});
    try {
      const value = await run();
      entries.write({phase: 'after', step: name});
      return value;
    } catch (error) {
      entries.write({phase: 'error', step: name, message: error.message});
      throw error;
    }
  };
  try {
    const storage = await step('Moonlight private storage', () => findPrivateStorage(directory));
    await step('Moonlight native video ready', () => waitForNativeReady(rpc, storage));
    sink = await step('native sink create', () => createSink(rpc, storage));
    transport = await step('native TCP create', () => createTransport({rpc, host: rpc.host}));
    decoder = await step('decoder create', () =>
      createDecoder({
        rpc,
        directory,
        workerDirectory: path.join(output, 'decoder'),
        workerMode: 'split',
        transport,
        publication: sink.workerPublication,
        splitWorkerFactory: async options => {
          const input = await createSplit({...options, inputOnly: true});
          paired = await (looping ? createLoopAdapter : createPairedOutput)({
            rpc,
            functions: options.functions,
            decoder: options.decoder,
            output: options.output,
            format: options.format,
            event: input.outputEvent,
            publication: sink.workerPublication
          });
          return input;
        }
      })
    );
    record.dimensions = await step('configure', () => decoder.configure(sps, pps, fps));
    const firstIndex = keyframes[0];
    const firstDestination = await step('first native destination', () => sink.destination());
    await step('host first submit', () =>
      decoder.submit({data: units[firstIndex].data, pts: firstIndex})
    );
    let first = null;
    const until = Date.now() + 1000;
    while (Date.now() < until && !first) {
      first = await step('host first receive', () => decoder.receive(firstDestination));
      if (!first) await pause(5);
    }
    if (!first) throw Error('Paired output host first frame did not arrive');
    await step('host first publish', () => sink.publish(firstDestination, first));
    await step('host first presentation', () => sink.wait());
    await step('input-only split start', () => decoder.startSplit());
    const unit = index => ({data: units[index].data, pts: index});
    const secondIndex = keyframes[1];
    if (scenario === 'stop-input') {
      await step('input worker enter TCP receive', () =>
        decoder.stageSplitInput(unit(secondIndex))
      );
      record.result = {inputWorker: 'waiting for TCP receive'};
    } else if (scenario === 'short-recv') {
      const shortLength = Math.max(1, units[secondIndex].data.length >>> 1);
      await step('short input staged', () =>
        decoder.stageSplitInput({...unit(secondIndex), receiveLength: shortLength})
      );
      let expected = null;
      try {
        await step('short receive check', () =>
          decoder.completeSplitInput(units[secondIndex].data.subarray(0, shortLength))
        );
      } catch (error) {
        if (!/Native TCP receive returned/.test(error.message)) throw error;
        expected = error.message;
      }
      if (!expected || decoder.splitDiagnostics.decodeGateSignals !== 0)
        throw Error('Paired output short receive opened the decode gate');
      record.result = {expected, decodeGateSignals: 0};
    } else {
      if (scenario === 'stop-output') {
        await step('paired output worker wait', () => paired.startAcquire());
        await step('paired output worker stop', () => paired.stop());
        record.result = {outputWorker: 'joined before any decoder output'};
      } else {
        const indices = pairIndices(scenario, keyframes);
        const pairs = [];
        let successorJob = null;
        let successorCompletion = null;
        for (const [pairIndex, frameIndices] of indices.entries()) {
          const [left, right] = frameIndices;
          const plan = await step(`pair ${pairIndex} output worker wait`, () =>
            paired.startAcquire(frameIndices.length)
          );
          const firstJob = successorJob ||
            await step(`pair ${pairIndex} first input receive and submit`, () =>
              decoder.submitSplit(unit(left))
            );
          successorJob = null;
          if (scenario === 'overlap' && pairIndex === 1)
            await step('overlapped first output acquired before second submit', () =>
              paired.waitFirstAcquire(BigInt(left))
            );
          const secondJob = right === undefined
            ? null
            : await step(`pair ${pairIndex} second input receive and submit`, () =>
                decoder.submitSplit(unit(right))
              );
          const acquired = await step(`pair ${pairIndex} host checks acquisitions`, () =>
            paired.finishAcquire(plan, frameIndices.map(index => BigInt(index)))
          );
          const destinations = [];
          for (let index = 0; index < frameIndices.length; index++)
            destinations.push(
              await step(`pair ${pairIndex} reserved surface ${index}`, () =>
                sink.workerDestination()
              )
            );
          if (scenario === 'overlap' && pairIndex === 0) {
            const staged = await stageOverlappedInput(
              decoder,
              unit(indices[1][0]),
              step
            );
            successorCompletion = staged.completion;
            record.overlap = {
              firstPts: indices[1][0],
              submittedBeforeCurrentPairFetch: true
            };
          }
          if (scenario === 'stop-present') {
            record.result = await step('stop output during presentation wait', () =>
              paired.stopDuringPresentation(destinations, first)
            );
            break;
          }
          const outputs = [];
          const publications = [];
          for (let index = 0; index < frameIndices.length; index++) {
            outputs.push(
              await step(`pair ${pairIndex} output ${index} fetch and presentation`, () =>
                paired.fetch(index, destinations, first)
              )
            );
            publications.push(
              await step(`pair ${pairIndex} output ${index} publication readback`, () =>
                verifyPublication(rpc, storage.mapped, destinations[index], first)
              )
            );
          }
          pairs.push({
            inputSequences: secondJob
              ? [firstJob.sequence, secondJob.sequence]
              : [firstJob.sequence],
            acquired: acquired.map(item => ({index: item.index, pts: String(item.pts)})),
            outputs: outputs.map(item => ({...item, pts: String(item.pts)})),
            publications
          });
          if (scenario === 'overlap' && pairIndex === 0) {
            const completed = await step('overlapped successor input completion', () =>
              successorCompletion
            );
            if (completed.error) throw completed.error;
            successorJob = completed.value;
            record.overlap.inputSequence = successorJob.sequence;
          }
        }
        if (scenario !== 'stop-present')
          record.result = ['four', 'keyframe', 'overlap'].includes(scenario)
            ? {pairs, decodeGateSignals: decoder.splitDiagnostics.decodeGateSignals}
            : {...pairs[0], decodeGateSignals: decoder.splitDiagnostics.decodeGateSignals};
      }
    }
  } catch (error) {
    failure = error;
    if (paired && !rpc.bridgeLost)
      record.workerSnapshot = await paired.snapshot().catch(snapshotError => ({
        error: snapshotError.message
      }));
  }
  if (paired && !rpc.bridgeLost) {
    try {
      await step('paired output stop', () => paired.stop());
    } catch (error) {
      failure ||= error;
      retained = true;
      record.workerSnapshot ||= await paired.snapshot().catch(snapshotError => ({
        error: snapshotError.message
      }));
    }
    retained ||= paired.diagnostics.retained;
  }
  if (decoder && !rpc.bridgeLost && !retained) {
    try {
      await step('decoder close', () => decoder.close());
    } catch (error) {
      failure ||= error;
      retained = true;
    }
  } else if (transport) transport.abort();
  if (!decoder && transport && !rpc.bridgeLost && !retained) {
    try {
      await step('TCP close', () => transport.close());
    } catch (error) {
      failure ||= error;
    }
  }
  if (sink && !rpc.bridgeLost && !retained) {
    try {
      await step('native sink close', () => sink.close());
    } catch (error) {
      failure ||= error;
    }
  }
  record.retainedForSafety = retained || rpc.bridgeLost;
  record.finished = new Date().toISOString();
  record.verdict = failure ? 'FAIL' : 'PASS';
  if (failure) record.error = failure.message;
  await save();
  entries.close();
  console.log(`PAIRED OUTPUT ${stage} ${record.verdict} (${report})`);
  if (failure) throw failure;
  return record;
}

module.exports = {
  main,
  STAGES,
  clipFrameRate,
  pairIndices,
  stageOverlappedInput,
  requireNewPairedSession,
  waitForNativeReady
};
if (require.main === module) {
  const args = process.argv.slice(2);
  main(session.resolve(args[0]), {
    clip: cli.option(args, '--clip'),
    stage: cli.option(args, '--stage'),
    output: cli.option(args, '--output') || undefined,
    dryRun: args.includes('--dry-run')
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
