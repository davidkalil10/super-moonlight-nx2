const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const cli = require('../cli.cjs');
const session = require('../host/session.cjs');
const {allocate} = require('../native/allocate.cjs');
const {accessUnits} = require('./probe-decoder-events.cjs');
const {parameterSets} = require('../../tools/moonlight/h264-stream.cjs');
const {create: createDecoder} = require('../../tools/moonlight/native-decoder.cjs');
const {create: createTransport} = require('../../tools/moonlight/native-tcp.cjs');

const STAGES = ['one', 'two', 'stop-input', 'stop-output', 'short-recv'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    close: () => fs.closeSync(descriptor)
  };
}

function loggedRpc(rpc, entries) {
  const wrapped = {...rpc, bridgeLost: false};
  for (const name of [
    'request',
    'call',
    'callAddress',
    'pair',
    'read',
    'write',
    'writeAndCall',
    'query'
  ]) {
    wrapped[name] = async (...args) => {
      const target = name === 'request' ? args[0]?.command : args[0];
      entries.write({phase: 'before', operation: name, target});
      try {
        const value = await rpc[name](...args);
        entries.write({phase: 'after', operation: name, target});
        return value;
      } catch (error) {
        if (
          /Console disconnected|timed out|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(
            error.message
          )
        )
          wrapped.bridgeLost = true;
        entries.write({phase: 'error', operation: name, target, message: error.message});
        throw error;
      }
    };
  }
  return wrapped;
}

async function main(
  directory,
  {
    clip,
    stage,
    output,
    sourceRevision,
    create = createDecoder,
    openTransport = createTransport,
    sessionRpc,
    allocateSurface = allocate
  } = {}
) {
  if (!STAGES.includes(stage)) throw Error('Use --stage ' + STAGES.join('|'));
  if (!clip) throw Error('Pass --clip with an H.264 probe clip');
  directory = path.resolve(directory);
  clip = path.resolve(clip);
  const revision =
    sourceRevision ||
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8'
    }).trim();
  const raw = sessionRpc || session.rpc(directory);
  if (!raw.host) throw Error('Split decoder needs a fresh normal START session');
  const stream = await fsp.readFile(clip);
  const units = accessUnits(stream);
  const keyframes = units.flatMap((unit, index) => (unit.keyframe ? [index] : []));
  if (keyframes.length < (stage === 'two' ? 3 : 2))
    throw Error('Probe clip needs independent keyframes for this stage');
  const {sps, pps} = parameterSets(stream);
  if (!sps || !pps) throw Error('Probe clip needs SPS and PPS');
  output ||= path.join(
    '/media/storage2/builds/HBLauncher/native-h264',
    new Date().toISOString().replace(/[:.]/g, '-') + '-' + revision.slice(0, 8) + '-split-' + stage
  );
  await fsp.mkdir(output, {recursive: true, mode: 0o700});
  const entries = journal(path.join(output, 'split-decoder.jsonl'));
  const rpc = loggedRpc(raw, entries);
  const record = {
    probe: 'split-decoder',
    stage,
    session: raw.a.session,
    sourceRevision: revision,
    builder: os.hostname(),
    targetArchitecture: 'aarch64',
    command: process.argv,
    clip,
    started: new Date().toISOString()
  };
  await fsp.writeFile(path.join(output, 'manifest.json'), JSON.stringify(record, null, 2) + '\n', {
    mode: 0o600
  });
  let decoder = null;
  let transport = null;
  let failure = null;
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
    const opened = await step('TCP transport create', () => openTransport({rpc, host: rpc.host}));
    transport = {
      ...opened,
      async send(bytes) {
        await step('TCP send ' + bytes.length, () => opened.send(bytes));
      },
      abort() {
        entries.write({phase: 'before', step: 'TCP abort'});
        opened.abort();
        entries.write({phase: 'after', step: 'TCP abort'});
      },
      close: () => step('TCP close', () => opened.close())
    };
    decoder = await step('decoder create', () =>
      create({
        rpc,
        directory,
        workerDirectory: path.join(output, 'decoder'),
        workerMode: 'split',
        transport
      })
    );
    const dimensions = await step('configure', () => decoder.configure(sps, pps, 30));
    record.dimensions = dimensions;
    const surfaceBytes = 0x400000;
    const destination = {
      address: await step('surface allocation', () =>
        allocateSurface(rpc, surfaceBytes, {
          failed: 'Split probe surface allocation failed',
          invalid: 'Invalid split probe surface allocation'
        })
      ),
      bytes: surfaceBytes
    };
    const firstIndex = keyframes[0];
    await step('host first submit', () =>
      decoder.submit({data: units[firstIndex].data, pts: firstIndex})
    );
    let first = null;
    const until = Date.now() + 1000;
    while (Date.now() < until && !first) {
      first = await step('host first receive', () => decoder.receive(destination));
      if (!first) await sleep(5);
    }
    if (!first) throw Error('Host-driven first frame did not arrive');
    await step('split workers start', () => decoder.startSplit());
    const unit = index => ({data: units[index].data, pts: index});
    const nextIndex = keyframes[1];
    if (stage === 'stop-input') {
      await step('input worker enter receive', () => decoder.stageSplitInput(unit(nextIndex)));
      record.result = {inputWorker: 'receive blocked before payload'};
    } else if (stage === 'short-recv') {
      const shortLength = Math.max(1, units[nextIndex].data.length >>> 1);
      await step('input worker enter bounded receive', () =>
        decoder.stageSplitInput({...unit(nextIndex), receiveLength: shortLength})
      );
      let expected = null;
      try {
        await step('short receive and host count check', () =>
          decoder.completeSplitInput(units[nextIndex].data.subarray(0, shortLength))
        );
      } catch (error) {
        if (!/Native TCP receive returned/.test(error.message)) throw error;
        expected = error.message;
      }
      if (!expected || decoder.splitDiagnostics.decodeGateSignals !== 0)
        throw Error('Short receive did not leave the decode gate closed');
      record.result = {expected, decodeGateSignals: 0};
    } else {
      const firstJob = await step('input job 1', () => decoder.submitSplit(unit(nextIndex)));
      await step('output job 1 queued', () => decoder.queueSplitOutput(firstJob));
      if (stage === 'stop-output') {
        const acquired = await step('output worker acquire before fetch gate', () =>
          decoder.waitSplitOutputAcquired(firstJob)
        );
        record.result = {
          outputWorker: 'fetch gate closed',
          acquired: {index: acquired.index, pts: acquired.pts.toString()}
        };
      } else {
        let secondJob = null;
        if (stage === 'two') {
          const secondIndex = keyframes[2];
          secondJob = await step('input job 2 while output job 1 in flight', () =>
            decoder.submitSplit(unit(secondIndex))
          );
        }
        const firstOutput = await step('output job 1 fetch', () =>
          decoder.finishSplitOutput(firstJob, destination)
        );
        if (firstOutput.pts !== String(nextIndex)) throw Error('Output job 1 PTS differs');
        const outputs = [firstOutput];
        if (secondJob) {
          await step('output job 2 queued', () => decoder.queueSplitOutput(secondJob));
          const secondOutput = await step('output job 2 fetch', () =>
            decoder.finishSplitOutput(secondJob, destination)
          );
          if (secondOutput.pts !== String(keyframes[2])) throw Error('Output job 2 PTS differs');
          outputs.push(secondOutput);
        }
        record.result = {outputs, decodeGateSignals: decoder.splitDiagnostics.decodeGateSignals};
      }
    }
  } catch (error) {
    failure = error;
    entries.write({phase: 'error', step: 'probe', message: error.message});
  }
  if (decoder && !rpc.bridgeLost) {
    try {
      await step('decoder close', () => decoder.close());
    } catch (error) {
      failure ||= error;
    }
  } else if (decoder) {
    record.retained = 'Bridge lost; restart SmileBASIC before another probe.';
    transport?.abort();
  }
  if (!decoder && transport && !rpc.bridgeLost) {
    try {
      await transport.close();
    } catch (error) {
      failure ||= error;
    }
  }
  record.finished = new Date().toISOString();
  record.verdict = failure ? 'FAIL' : 'PASS';
  if (failure) record.error = failure.message;
  await fsp.writeFile(path.join(output, 'result.json'), JSON.stringify(record, null, 2) + '\n', {
    mode: 0o600
  });
  entries.close();
  console.log('SPLIT DECODER ' + stage + ' ' + record.verdict + ' (record ' + output + ')');
  if (failure) throw failure;
  return record;
}

module.exports = {main, STAGES, loggedRpc};
if (require.main === module) {
  const args = process.argv.slice(2);
  main(session.resolve(args[0]), {
    clip: cli.option(args, '--clip'),
    stage: cli.option(args, '--stage'),
    output: cli.option(args, '--output') || undefined
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
