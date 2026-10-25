const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const cli = require('../cli.cjs');
const session = require('../host/session.cjs');
const {accessUnits} = require('./probe-decoder-events.cjs');
const {loggedRpc, verifyPublication} = require('./probe-split-decoder.cjs');
const {requireNewPairedSession, waitForNativeReady} = require('./probe-paired-output.cjs');
const {parameterSets} = require('../../tools/moonlight/h264-stream.cjs');
const {findPrivateStorage} = require('../../tools/moonlight/feed.cjs');
const {create: createDecoder} = require('../../tools/moonlight/native-decoder.cjs');
const {create: createTransport} = require('../../tools/moonlight/native-tcp.cjs');
const {create: createSink} = require('../../tools/moonlight/native-sink.cjs');
const {create: createStaggered} = require('../../tools/moonlight/staggered-worker.cjs');
const {waitChecked, waitOutput} = require('../../tools/moonlight/staggered-live.cjs');
const inputPlan = require('../../tools/moonlight/staggered-input-plan.cjs');
const outputPlan = require('../../tools/moonlight/staggered-output-plan.cjs');
const checked = require('../../tools/moonlight/staggered-status.cjs');

const BUILD_ROOT = '/media/storage2/builds/HBLauncher/native-h264';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function clipIndices(units) {
  const keyframes = units.flatMap((unit, index) => (unit.keyframe ? [index] : []));
  const nextIdr = keyframes[1];
  if (
    keyframes.length < 3 ||
    nextIdr <= 2 ||
    nextIdr + 2 >= units.length ||
    units[1].keyframe ||
    units[2].keyframe ||
    units[nextIdr + 1].keyframe ||
    units[nextIdr + 2].keyframe
  )
    throw Error('Staggered ladder needs ordered P/P, IDR, P/P access units');
  return [1, 2, nextIdr, nextIdr + 1, nextIdr + 2];
}

function expectedFor(sequence, selected, destinations) {
  const value = {receive: {sequence, bytes: selected[sequence - 1].data.length}};
  if (sequence >= 2) value.input = {sequence: sequence - 1};
  if (sequence >= 3)
    value.acquire = {
      sequence: sequence - 2,
      pts: BigInt(selected[sequence - 3].pts)
    };
  if (sequence >= 4) {
    value.fetch = {sequence: sequence - 3};
    const destination = destinations.get(sequence - 3);
    if (!destination) throw Error('Missing prior staggered output destination');
    value.ack = {sequence: destination.sequence, index: destination.index};
  }
  return value;
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

async function requireFresh(sessionId, root = BUILD_ROOT) {
  await requireNewPairedSession(sessionId, root);
  for (const name of await fsp.readdir(root)) {
    if (!name.includes('-r3-staggered-ladder')) continue;
    try {
      const prior = path.join(root, name, 'staggered-ladder.json');
      const record = JSON.parse(await fsp.readFile(prior, 'utf8'));
      if (record.session === sessionId)
        throw Object.assign(Error('Start a new normal START session before staggered ladder'), {
          prior
        });
    } catch (error) {
      if (error.prior) throw error;
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function runScenario({rpc, directory, storage, units, sps, pps, indices, mode, step}) {
  let transport = null;
  let decoder = null;
  let sink = null;
  let worker = null;
  let retained = false;
  let failure = null;
  const result = {mode, steps: []};
  try {
    sink = await step(`${mode} native sink`, () => createSink(rpc, storage));
    transport = await step(`${mode} native TCP`, () => createTransport({rpc, host: rpc.host}));
    decoder = await step(`${mode} decoder`, () =>
      createDecoder({
        rpc,
        directory,
        workerMode: 'split',
        transport,
        publication: sink.workerPublication,
        splitWorkerFactory: async options => {
          worker = await createStaggered(options);
          return worker;
        }
      })
    );
    await step(`${mode} configure`, () => decoder.configure(sps, pps, 30));
    const firstDestination = await step(`${mode} first destination`, () => sink.destination());
    await step(`${mode} host IDR submit`, () => decoder.submit({data: units[0].data, pts: 0}));
    let first = null;
    const until = Date.now() + 1000;
    while (Date.now() < until && !first) {
      first = await decoder.receive(firstDestination);
      if (!first) await pause(5);
    }
    if (!first) throw Error('Staggered host IDR did not arrive');
    await step(`${mode} host IDR publish`, () => sink.publish(firstDestination, first));
    await step(`${mode} host IDR presentation`, () => sink.wait());
    const firstIndex = decoder.lastInput?.index;
    if (decoder.lastInput?.status !== 0 || !Number.isInteger(firstIndex) || firstIndex < 0)
      throw Error('Staggered host IDR did not prime an input slot');

    const selected = indices.map(index => ({data: units[index].data, pts: index}));
    const receiveLength = mode === 'short-recv'
      ? Math.max(1, selected[0].data.length >>> 1)
      : selected[0].data.length;
    await step(`${mode} worker start`, () => worker.start({
      sequence: 1,
      length: receiveLength,
      pts: BigInt(selected[0].pts)
    }));
    await step(`${mode} first TCP payload`, () =>
      transport.send(selected[0].data.subarray(0, receiveLength))
    );

    if (mode === 'short-recv') {
      const until = Date.now() + 5000;
      let snapshot;
      while (Date.now() < until) {
        snapshot = await worker.readStatus();
        if (snapshot.receive.sequence === 1) break;
        await pause(5);
      }
      if (snapshot?.receive.sequence !== 1) throw Error('Short TCP receive did not finish');
      let checkedError = null;
      try {
        checked.check(snapshot, {
          receive: {sequence: 1, bytes: selected[0].data.length}
        });
      } catch (error) {
        checkedError = error;
      }
      if (!checkedError || !/Short receive/.test(checkedError.message) ||
          worker.diagnostics.decodeGateSignals !== 0)
        throw Error('Short receive opened a staggered decode gate');
      result.shortReceive = {
        count: String(snapshot.receive.count),
        expected: selected[0].data.length,
        decodeGateSignals: worker.diagnostics.decodeGateSignals
      };
    } else {
      const destinations = new Map();
      const outputs = [];
      for (let sequence = 1; sequence <= selected.length; sequence++) {
        const expected = expectedFor(sequence, selected, destinations);
        const snapshot = await step(`AU ${sequence} checked snapshot`, () =>
          waitChecked(worker, expected)
        );
        if (sequence >= 4)
          await step(`AU ${sequence - 3} publication`, () =>
            verifyPublication(rpc, storage.mapped, destinations.get(sequence - 3), first)
          );
        const inputIndex = sequence === 1 ? firstIndex : snapshot.input.nextIndex;
        const inputSlot = await step(`AU ${sequence} checked input buffer`, () =>
          worker.inputSlot(inputIndex)
        );
        const destination = sequence >= 3
          ? await step(`AU ${sequence - 2} surface`, () =>
              sink.workerDestination({
                current: snapshot.current,
                applied: snapshot.nativeApplied
              })
            )
          : null;
        if (destination) destinations.set(sequence - 2, destination);
        const current = selected[sequence - 1];
        const next = selected[sequence] || {
          data: Buffer.alloc(1),
          pts: current.pts + 1
        };
        await step(`AU ${sequence} guarded decode/fetch`, () =>
          worker.openGates({
            snapshot,
            expected,
            inputSlot,
            current: {
              sequence,
              length: current.data.length,
              pts: BigInt(current.pts)
            },
            next: {
              sequence: sequence + 1,
              length: next.data.length,
              pts: BigInt(next.pts)
            },
            destination,
            frame: first
          })
        );
        if (sequence < selected.length)
          await step(`AU ${sequence + 1} TCP payload`, () => transport.send(next.data));
        if (sequence >= 3) outputs.push(sequence - 2);
        result.steps.push({sequence, pts: current.pts, fetched: sequence >= 3 ? sequence - 2 : null});
      }
      const lastSequence = selected.length;
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const snapshot = await worker.readStatus();
        if (snapshot.input.sequence === lastSequence) {
          if (snapshot.input.sendStatus !== 0n)
            throw Error('Final staggered decoder submit failed');
          break;
        }
        await pause(5);
      }
      if ((await worker.readStatus()).input.sequence !== lastSequence)
        throw Error('Final staggered input submit timed out');
      await step('stop input in next TCP receive', () => worker.stopInput());
      for (let sequence = lastSequence - 1; sequence <= lastSequence; sequence++) {
        const prior = destinations.get(sequence - 1);
        const expected = {
          acquire: {sequence, pts: BigInt(selected[sequence - 1].pts)},
          fetch: {sequence: sequence - 1},
          ack: {sequence: prior.sequence, index: prior.index}
        };
        const snapshot = await step(`tail ${sequence} checked output`, () =>
          waitOutput(worker, expected)
        );
        await step(`tail ${sequence - 1} publication`, () =>
          verifyPublication(rpc, storage.mapped, prior, first)
        );
        const destination = await step(`tail ${sequence} surface`, () =>
          sink.workerDestination({current: snapshot.current, applied: snapshot.nativeApplied})
        );
        await step(`tail ${sequence} checked fetch`, () =>
          worker.drainOutput({snapshot, expected, destination, frame: first})
        );
        destinations.set(sequence, destination);
        outputs.push(sequence);
      }
      const finalDestination = destinations.get(lastSequence);
      await step('last publication acknowledged', () => waitOutput(worker, {
        acquire: {sequence: lastSequence, pts: BigInt(selected.at(-1).pts)},
        fetch: {sequence: lastSequence},
        ack: {sequence: finalDestination.sequence, index: finalDestination.index}
      }));
      await step('last publication readback', () =>
        verifyPublication(rpc, storage.mapped, finalDestination, first)
      );
      await step('stop output in decoder event wait', () => worker.stopOutput());
      result.outputs = outputs;
      result.pts = selected.map(item => item.pts);
      result.decodeGateSignals = worker.diagnostics.decodeGateSignals;
    }
  } catch (error) {
    failure = error;
  }
  if (worker && !rpc.bridgeLost) {
    try {
      await step(`${mode} workers stop`, () => worker.stop());
    } catch (error) {
      failure ||= error;
      retained = true;
    }
    retained ||= worker.diagnostics.retained;
  }
  if (decoder && !rpc.bridgeLost && !retained) {
    try {
      await step(`${mode} decoder close`, () => decoder.close());
    } catch (error) {
      failure ||= error;
      retained = true;
    }
  }
  if (transport && !decoder && !rpc.bridgeLost && !retained) {
    try {
      await step(`${mode} TCP close`, () => transport.close());
    } catch (error) {
      failure ||= error;
    }
  }
  if (sink && !rpc.bridgeLost && !retained) {
    try {
      await step(`${mode} sink close`, () => sink.close());
    } catch (error) {
      failure ||= error;
    }
  }
  result.retainedForSafety = retained || rpc.bridgeLost;
  if (failure) throw Object.assign(failure, {scenario: result});
  return result;
}

async function main(directory, {clip, dryRun = false, output} = {}) {
  if (!clip) throw Error('Pass --clip with the ordered 1080p IP clip');
  directory = directory ? path.resolve(directory) : null;
  clip = path.resolve(clip);
  const stream = await fsp.readFile(clip);
  const units = accessUnits(stream);
  const sidecar = JSON.parse(await fsp.readFile(clip.replace(/\.h264$/, '.json')));
  if (
    sidecar.width !== 1920 ||
    sidecar.height !== 1080 ||
    sidecar.display.length !== units.length ||
    sidecar.display.some((display, index) => display !== index)
  )
    throw Error('Staggered ladder needs an ordered 1080p clip');
  const indices = clipIndices(units);
  const {sps, pps} = parameterSets(stream);
  if (!sps || !pps) throw Error('Staggered ladder clip lacks SPS/PPS');
  if (dryRun) {
    const addresses = {
      sdk: 0x40000000,
      base: 0x52000000,
      control: 0x53000000,
      mapped: 0x60000000,
      scratch: 0x54000000,
      fd: 12,
      recvFunction: 0x70000000,
      functions: {
        sendInput: 0x70001000,
        acquireInput: 0x70002000,
        acquireOutput: 0x70003000,
        bufferSetData: 0x70004000,
        getOutput: 0x70005000,
        releaseOutput: 0x70006000
      },
      decoder: 0x71000000,
      output: 0x71000300,
      format: 0x71000180,
      event: 0x53000400
    };
    const input = inputPlan.plan(addresses);
    const video = outputPlan.plan({...addresses, base: 0x55000000});
    const result = {
      dryRun: true,
      indices,
      pts: indices,
      stages: ['overlap', 'keyframe', 'odd-tail', 'stop-input', 'stop-output', 'short-recv'],
      steadyRequestsPerFrame: 2,
      inputFrameBytes: input.receive.concat(input.send).map(item => item.frame.length),
      outputFrameBytes: video.acquire.concat(video.fetch).map(item => item.frame.length)
    };
    console.log(JSON.stringify(result));
    return result;
  }
  const raw = session.rpc(directory || session.resolve());
  if (!raw.host) throw Error('Staggered ladder needs a normal START session');
  await requireFresh(raw.a.session);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8'
  }).trim();
  output ||= path.join(
    BUILD_ROOT,
    new Date().toISOString().replace(/[:.]/g, '-') +
      '-' + revision.slice(0, 8) + '-r3-staggered-ladder'
  );
  await fsp.mkdir(output, {recursive: true, mode: 0o700});
  const entries = journal(path.join(output, 'staggered-ladder.jsonl'));
  const rpc = loggedRpc(raw, entries);
  const record = {
    probe: 'staggered-ladder',
    session: rpc.a.session,
    sourceRevision: revision,
    builder: os.hostname(),
    targetArchitecture: 'aarch64',
    command: process.argv,
    clip,
    indices,
    started: new Date().toISOString(),
    scenarios: []
  };
  const report = path.join(output, 'staggered-ladder.json');
  const save = () => fsp.writeFile(report, JSON.stringify(record, null, 2) + '\n', {mode: 0o600});
  await save();
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
  let failure = null;
  try {
    const storage = await step('Moonlight private storage', () =>
      findPrivateStorage(directory || session.resolve())
    );
    await step('Moonlight native video ready', () => waitForNativeReady(rpc, storage));
    for (const mode of ['normal', 'short-recv']) {
      const scenario = await runScenario({
        rpc,
        directory: directory || session.resolve(),
        storage,
        units,
        sps,
        pps,
        indices,
        mode,
        step
      });
      record.scenarios.push(scenario);
      await save();
    }
  } catch (error) {
    failure = error;
    if (error.scenario) record.scenarios.push(error.scenario);
  }
  record.verdict = failure ? 'FAIL' : 'PASS';
  record.retainedForSafety = record.scenarios.some(item => item.retainedForSafety) || rpc.bridgeLost;
  if (failure) record.error = failure.message;
  record.finished = new Date().toISOString();
  await save();
  entries.close();
  console.log(`STAGGERED LADDER ${record.verdict} (${report})`);
  if (failure) throw failure;
  return record;
}

module.exports = {main, clipIndices, expectedFor, waitChecked, waitOutput};
if (require.main === module) {
  const args = process.argv.slice(2);
  main(args[0]?.startsWith('--') ? null : args[0], {
    clip: cli.option(args, '--clip'),
    dryRun: args.includes('--dry-run'),
    output: cli.option(args, '--output') || undefined
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
