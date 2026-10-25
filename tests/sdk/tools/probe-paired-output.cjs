const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const cli = require('../cli.cjs');
const session = require('../host/session.cjs');
const {accessUnits} = require('./probe-decoder-events.cjs');
const {loggedRpc, verifyPublication} = require('./probe-split-decoder.cjs');
const {parameterSets} = require('../../tools/moonlight/h264-stream.cjs');
const {findPrivateStorage} = require('../../tools/moonlight/feed.cjs');
const {create: createDecoder} = require('../../tools/moonlight/native-decoder.cjs');
const {create: createTransport} = require('../../tools/moonlight/native-tcp.cjs');
const {create: createSink} = require('../../tools/moonlight/native-sink.cjs');
const {create: createSplit} = require('../../tools/moonlight/split-decoder-worker.cjs');
const {create: createPairedOutput} = require('../../tools/moonlight/paired-output-worker.cjs');
const acquireFrame = require('../../tools/moonlight/paired-acquire-frame.cjs');
const outputFrame = require('../../tools/moonlight/paired-output-frame.cjs');
const ring = require('../../tools/moonlight/ring.cjs');

const STAGES = ['two', 'stop-input', 'stop-output', 'short-recv'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function main(directory, {clip, stage, output, dryRun = false} = {}) {
  if (!STAGES.includes(stage)) throw Error('Use --stage ' + STAGES.join('|'));
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
    const result = {
      dryRun: true,
      stage,
      keyframes: keyframes.slice(0, 3),
      acquireCalls: acquire.program.proof.logicalCalls,
      acquireBytes: acquire.program.frame.length,
      fetchCalls: fetch.map(item => item.program.proof.logicalCalls),
      fetchBytes: fetch.map(item => item.program.frame.length)
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
      '-r3-paired-' +
      stage
  );
  await fsp.mkdir(output, {recursive: true, mode: 0o700});
  const entries = journal(path.join(output, 'paired-output.jsonl'));
  const rpc = loggedRpc(session.rpc(directory), entries);
  const record = {
    probe: 'paired-output',
    stage,
    session: rpc.a.session,
    sourceRevision: revision,
    builder: os.hostname(),
    targetArchitecture: 'aarch64',
    command: process.argv,
    clip,
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
    if (!rpc.host) throw Error('Paired output probe needs a normal START session');
    const storage = await step('Moonlight private storage', () => findPrivateStorage(directory));
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
          paired = await createPairedOutput({
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
    record.dimensions = await step('configure', () => decoder.configure(sps, pps, 30));
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
    if (stage === 'stop-input') {
      await step('input worker enter TCP receive', () =>
        decoder.stageSplitInput(unit(secondIndex))
      );
      record.result = {inputWorker: 'waiting for TCP receive'};
    } else if (stage === 'short-recv') {
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
      const plan = await step('paired output worker wait', () => paired.startAcquire());
      if (stage === 'stop-output') {
        await step('paired output worker stop', () => paired.stop());
        record.result = {outputWorker: 'joined before any decoder output'};
      } else {
        const firstJob = await step('first input receive and submit', () =>
          decoder.submitSplit(unit(secondIndex))
        );
        const thirdIndex = keyframes[2];
        const secondJob = await step('second input receive and submit', () =>
          decoder.submitSplit(unit(thirdIndex))
        );
        const acquired = await step('host checks two output acquisitions', () =>
          paired.finishAcquire(plan, [BigInt(secondIndex), BigInt(thirdIndex)])
        );
        const destinations = [
          await step('first reserved native surface', () => sink.workerDestination()),
          await step('second reserved native surface', () => sink.workerDestination())
        ];
        const outputs = [];
        const publications = [];
        for (let index = 0; index < 2; index++) {
          outputs.push(
            await step(`output ${index} fetch and presentation`, () =>
              paired.fetch(index, destinations, first)
            )
          );
          publications.push(
            await step(`output ${index} publication readback`, () =>
              verifyPublication(rpc, storage.mapped, destinations[index], first)
            )
          );
        }
        record.result = {
          inputSequences: [firstJob.sequence, secondJob.sequence],
          acquired: acquired.map(item => ({index: item.index, pts: String(item.pts)})),
          outputs: outputs.map(item => ({...item, pts: String(item.pts)})),
          publications,
          decodeGateSignals: decoder.splitDiagnostics.decodeGateSignals
        };
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

module.exports = {main, STAGES};
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
