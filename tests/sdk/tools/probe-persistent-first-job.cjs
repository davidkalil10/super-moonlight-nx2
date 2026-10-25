const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const cli = require('../../../hbl-platform/sdk/cli.cjs');
const session = require('../../../hbl-platform/sdk/host/session.cjs');
const {allocate} = require('../../../hbl-platform/sdk/native/allocate.cjs');
const {accessUnits} = require('./probe-decoder-events.cjs');
const {parameterSets} = require('../../../hbl-moonlight/tools/moonlight/h264-stream.cjs');
const {
  create: createDecoder
} = require('../../../hbl-moonlight/tools/moonlight/native-decoder.cjs');
const {create: createTransport} = require('../../../hbl-moonlight/tools/moonlight/native-tcp.cjs');

const STAGES = [
  'gate',
  'dispatch',
  'send',
  'wait',
  'acquire',
  'setData',
  'getOutput',
  'release',
  'input',
  'done',
  'restore',
  'fetch'
];
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
  wrapped.bridgeLost = false;
  let hostSurface = null;
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
      const payload = bytes === 16 ? {dataHex: args[1].toString('hex')} : {};
      if (name === 'pair' && args[0]?.length === 2 && args[0][0]?.address && args[0][1]?.address)
        hostSurface = {address: args[0][0].args[1], bytes: args[0][0].args[2]};
      const fetchJob =
        name === 'writeAndCall' && bytes === 16
          ? {address: Number(args[1].readBigUInt64LE(0)), bytes: Number(args[1].readBigUInt64LE(8))}
          : null;
      const surfaceMatch =
        fetchJob && hostSurface
          ? fetchJob.address === hostSurface.address && fetchJob.bytes === hostSurface.bytes
          : undefined;
      record.write({
        phase: 'before',
        operation: name,
        target,
        ...(bytes ? {bytes} : {}),
        ...payload,
        ...(hostSurface && (name === 'pair' || fetchJob) ? {hostSurface} : {}),
        ...(fetchJob ? {fetchJob, surfaceMatch} : {})
      });
      try {
        if (surfaceMatch === false)
          throw Error('Persistent decoder fetch job differs from the host-driven output surface');
        const result = await rpc[name](...args);
        record.write({
          phase: 'after',
          operation: name,
          target,
          ...(name === 'read' && args[1] === 16 ? {dataHex: result.toString('hex')} : {})
        });
        return result;
      } catch (error) {
        if (
          /Console disconnected|timed out|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(
            error.message
          )
        )
          wrapped.bridgeLost = true;
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
    jobs = 1,
    decoderData = 'rpc',
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
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 3 || (jobs > 1 && stage !== 'fetch'))
    throw Error('--jobs must be 1 to 3 and requires --stage fetch above 1');
  if (!['rpc', 'tcp'].includes(decoderData) || (decoderData === 'tcp' && stage !== 'fetch'))
    throw Error('--decoder-data tcp requires --stage fetch');
  directory = path.resolve(directory);
  clip = path.resolve(clip);
  const revision =
    sourceRevision ||
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8'
    }).trim();
  const raw = sessionRpc || session.rpc(directory);
  if (decoderData === 'tcp' && !raw.host)
    throw Error('Native TCP requires a fresh launcher session from this branch');
  const bytes = await fsp.readFile(clip);
  const units = accessUnits(bytes);
  const keyframes = units.flatMap((unit, index) => (unit.keyframe ? [index] : []));
  if (keyframes.length < jobs + 1)
    throw Error('Probe clip needs ' + (jobs + 1) + ' independent keyframes');
  const [firstIndex, nextIndex] = keyframes;
  const {sps, pps} = parameterSets(bytes);
  if (!sps || !pps) throw Error('Probe clip needs SPS and PPS');
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
  const rpc = loggedRpc(raw, entries);
  const record = {
    probe: 'persistent-first-job',
    stage,
    jobs,
    decoderData,
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
  let transport = null;
  let failure = null;
  try {
    if (decoderData === 'tcp') {
      entries.write({phase: 'before', step: 'TCP transport create'});
      const opened = await openTransport({rpc, host: rpc.host});
      transport = {
        ...opened,
        async send(bytes) {
          entries.write({phase: 'before', step: 'TCP send', bytes: bytes.length});
          try {
            await opened.send(bytes);
            entries.write({phase: 'after', step: 'TCP send', bytes: bytes.length});
          } catch (error) {
            entries.write({phase: 'error', step: 'TCP send', message: error.message});
            throw error;
          }
        },
        abort() {
          entries.write({phase: 'before', step: 'TCP abort'});
          opened.abort();
          entries.write({phase: 'after', step: 'TCP abort'});
        },
        async close() {
          entries.write({phase: 'before', step: 'TCP close'});
          await opened.close();
          entries.write({phase: 'after', step: 'TCP close'});
        }
      };
      entries.write({phase: 'after', step: 'TCP transport create', port: transport.port});
    }
    entries.write({phase: 'before', step: 'decoder create'});
    decoder = await create({
      rpc,
      directory,
      workerDirectory: path.join(output, 'decoder'),
      workerMode: 'persistent',
      transport
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
      entries.write({phase: 'before', step: 'host first receive', destination});
      first = await decoder.receive(destination);
      entries.write({phase: 'after', step: 'host first receive', ready: !!first});
      if (!first) await sleep(5);
    }
    if (!first) throw Error('Host-driven first frame did not arrive');
    entries.write({phase: 'before', step: 'worker start', stage});
    await decoder.startPersistent({stage: stage === 'fetch' ? null : stage});
    entries.write({phase: 'after', step: 'worker start', stage});
    const results = [];
    for (const unitIndex of keyframes.slice(1, jobs + 1)) {
      entries.write({phase: 'before', step: 'worker job', stage, unit: unitIndex, destination});
      const result = await decoder.processPersistent(
        {data: units[unitIndex].data, pts: unitIndex},
        destination
      );
      entries.write({
        phase: 'after',
        step: 'worker job',
        stage,
        unit: unitIndex,
        result: result.probe || result
      });
      if (result.probe) {
        if (['send', 'wait', 'acquire'].includes(stage) && result.probe.sendStatus !== 0)
          throw Error('Probe SendInput returned 0x' + result.probe.sendStatus.toString(16));
        if (
          stage === 'acquire' &&
          (result.probe.acquireStatus !== 0 || result.probe.outputIndex < 0)
        )
          throw Error('Probe AcquireOutput did not return a frame');
        if (
          ['getOutput', 'release', 'input', 'done', 'restore'].includes(stage) &&
          result.probe.getStatus !== 0
        )
          throw Error('Probe GetOutput returned 0x' + result.probe.getStatus.toString(16));
        if (
          ['release', 'input', 'done', 'restore'].includes(stage) &&
          result.probe.releaseStatus !== 0
        )
          throw Error('Probe ReleaseOutput returned 0x' + result.probe.releaseStatus.toString(16));
        if (
          ['input', 'done', 'restore'].includes(stage) &&
          result.probe.inputStatus !== 0 &&
          !(result.probe.nextIndex < 0 && [0x100e, 0x1011].includes(result.probe.inputStatus))
        )
          throw Error('Probe AcquireInput returned 0x' + result.probe.inputStatus.toString(16));
        if (['done', 'restore'].includes(stage) && result.probe.completedSequence !== 1)
          throw Error('Probe completed the wrong access unit');
      } else if (result.pts !== String(unitIndex)) {
        throw Error('Probe fetch returned the wrong presentation timestamp');
      }
      results.push(result.probe || result);
    }
    record.result = jobs === 1 ? results[0] : results;
  } catch (error) {
    failure = error;
    entries.write({phase: 'error', step: 'probe', message: error.message});
  }
  if (decoder && !rpc.bridgeLost) {
    try {
      entries.write({phase: 'before', step: 'decoder close'});
      await decoder.close();
      entries.write({phase: 'after', step: 'decoder close'});
    } catch (error) {
      failure ||= error;
      entries.write({phase: 'error', step: 'decoder close', message: error.message});
    }
  } else if (decoder) {
    record.retained = 'Bridge lost; no cleanup RPC sent. Restart SmileBASIC before another probe.';
    entries.write({phase: 'retained', step: 'decoder close', reason: 'bridge lost'});
    transport?.abort();
  }
  if (!decoder && transport && !rpc.bridgeLost) {
    try {
      await transport.close();
    } catch (error) {
      failure ||= error;
      entries.write({phase: 'error', step: 'TCP transport close', message: error.message});
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
    jobs: Number(cli.option(args, '--jobs') || 1),
    decoderData: cli.option(args, '--decoder-data') || 'rpc',
    output: cli.option(args, '--output') || undefined
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
