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

const STAGES = ['gate', 'dispatch', 'send', 'wait', 'acquire', 'fetch'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function journal(file) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  let sequence = 0;
  function write(value) {
    fs.writeSync(
      descriptor,
      JSON.stringify({sequence: ++sequence, at: new Date().toISOString(), ...value}) + '\n'
    );
    fs.fsyncSync(descriptor);
  }
  return {write, close: () => fs.closeSync(descriptor)};
}

function loggedRpc(rpc, record) {
  const wrapped = {...rpc};
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
      const bytes = name === 'write' || name === 'writeAndCall' ? args[1]?.length : undefined;
      record.write({phase: 'before', operation: name, target, ...(bytes ? {bytes} : {})});
      try {
        const result = await rpc[name](...args);
        record.write({phase: 'after', operation: name, target});
        return result;
      } catch (error) {
        record.write({phase: 'error', operation: name, target, message: error.message});
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
  output ||= path.join(
    '/media/storage2/builds/HBLauncher/native-h264',
    new Date().toISOString().replace(/[:.]/g, '-') +
      '-' +
      revision.slice(0, 8) +
      '-first-job-' +
      stage
  );
  await fsp.mkdir(output, {recursive: true, mode: 0o700});
  const entries = journal(path.join(output, 'first-job.jsonl'));
  const raw = sessionRpc || session.rpc(directory);
  const rpc = loggedRpc(raw, entries);
  const bytes = await fsp.readFile(clip);
  const units = accessUnits(bytes);
  const firstIndex = units.findIndex(unit => unit.keyframe);
  const nextIndex = units.findIndex((unit, index) => index > firstIndex && unit.keyframe);
  if (firstIndex < 0 || nextIndex < 0) throw Error('Probe clip needs two independent keyframes');
  const {sps, pps} = parameterSets(bytes);
  if (!sps || !pps) throw Error('Probe clip needs SPS and PPS');
  const record = {
    probe: 'persistent-first-job',
    stage,
    session: raw.a.session,
    sourceRevision: revision,
    builder: os.hostname(),
    targetArchitecture: 'aarch64',
    command: process.argv,
    clip,
    firstIndex,
    nextIndex,
    started: new Date().toISOString()
  };
  await fsp.writeFile(path.join(output, 'manifest.json'), JSON.stringify(record, null, 2) + '\n', {
    mode: 0o600
  });
  let decoder = null;
  let failure = null;
  try {
    entries.write({phase: 'before', step: 'decoder create'});
    decoder = await create({
      rpc,
      directory,
      workerDirectory: path.join(output, 'decoder'),
      workerMode: 'persistent'
    });
    entries.write({phase: 'after', step: 'decoder create'});
    entries.write({phase: 'before', step: 'configure'});
    const dimensions = await decoder.configure(sps, pps, 30);
    entries.write({phase: 'after', step: 'configure', dimensions});
    const surfaceBytes = Math.ceil((dimensions.width * dimensions.height * 3) / 2 / 4096) * 4096;
    const destination = {
      address: await allocateSurface(rpc, surfaceBytes, {
        failed: 'Persistent probe surface allocation failed',
        invalid: 'Invalid persistent probe surface allocation'
      }),
      bytes: surfaceBytes
    };
    entries.write({phase: 'before', step: 'host first submit', unit: firstIndex});
    await decoder.submit({data: units[firstIndex].data, pts: firstIndex});
    entries.write({phase: 'after', step: 'host first submit'});
    const until = Date.now() + 1000;
    let first = null;
    while (Date.now() < until && !first) {
      entries.write({phase: 'before', step: 'host first receive'});
      first = await decoder.receive(destination);
      entries.write({phase: 'after', step: 'host first receive', ready: !!first});
      if (!first) await sleep(5);
    }
    if (!first) throw Error('Host-driven first frame did not arrive');
    entries.write({phase: 'before', step: 'worker start', stage});
    await decoder.startPersistent({stage: stage === 'fetch' ? null : stage});
    entries.write({phase: 'after', step: 'worker start', stage});
    entries.write({phase: 'before', step: 'worker first job', stage, unit: nextIndex});
    const result = await decoder.processPersistent(
      {data: units[nextIndex].data, pts: nextIndex},
      destination
    );
    entries.write({
      phase: 'after',
      step: 'worker first job',
      stage,
      result: result.probe || result
    });
    if (result.probe) {
      if (['send', 'wait', 'acquire'].includes(stage) && result.probe.sendStatus !== 0)
        throw Error('Probe SendInput returned 0x' + result.probe.sendStatus.toString(16));
      if (stage === 'acquire' && (result.probe.acquireStatus !== 0 || result.probe.outputIndex < 0))
        throw Error('Probe AcquireOutput did not return a frame');
    } else if (result.pts !== String(nextIndex)) {
      throw Error('Probe fetch returned the wrong presentation timestamp');
    }
    record.result = result.probe || result;
  } catch (error) {
    failure = error;
    entries.write({phase: 'error', step: 'probe', message: error.message});
  }
  if (decoder) {
    try {
      entries.write({phase: 'before', step: 'decoder close'});
      await decoder.close();
      entries.write({phase: 'after', step: 'decoder close'});
    } catch (error) {
      failure ||= error;
      entries.write({phase: 'error', step: 'decoder close', message: error.message});
    }
  }
  record.finished = new Date().toISOString();
  record.verdict = failure ? 'FAIL' : 'PASS';
  if (failure) record.error = failure.message;
  await fsp.writeFile(path.join(output, 'result.json'), JSON.stringify(record, null, 2) + '\n', {
    mode: 0o600
  });
  entries.close();
  console.log('PERSISTENT FIRST JOB ' + stage + ' ' + record.verdict + ' (record ' + output + ')');
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
