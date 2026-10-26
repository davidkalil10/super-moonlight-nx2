const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const cli = require('../../../hbl-platform/sdk/cli.js');
const session = require('../../../hbl-platform/sdk/host/session.js');
const {allocate} = require('../../../hbl-platform/sdk/native/allocate.js');
const {accessUnits, clipFrameRate} = require('./probe-decoder-events.cjs');
const {parameterSets} = require('../../../hbl-moonlight/tools/moonlight/h264-stream.js');
const {
  create: createDecoder
} = require('../../../hbl-moonlight/tools/moonlight/native-decoder.js');
const {create: createTransport} = require('../../../hbl-moonlight/tools/moonlight/native-tcp.js');
const {create: createSink} = require('../../../hbl-moonlight/tools/moonlight/native-sink.js');
const ring = require('../../../hbl-moonlight/tools/moonlight/ring.js');

const STAGES = ['one', 'two', 'stop-input', 'stop-output', 'short-recv'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function verifyPublication(rpc, mapped, destination, frame) {
  const data = await rpc.read(mapped + ring.CONTROL.nativeSequence, 32);
  const publication = {
    sequence: data.readUInt32LE(0),
    index: data.readUInt32LE(4),
    width: data.readUInt32LE(8),
    height: data.readUInt32LE(12),
    stride: data.readUInt32LE(16),
    sliceHeight: data.readUInt32LE(20),
    color: data.readUInt32LE(24),
    commit: data.readUInt32LE(28)
  };
  if (
    publication.sequence !== destination.sequence ||
    publication.index !== destination.index ||
    publication.width !== frame.width ||
    publication.height !== frame.height ||
    publication.stride !== frame.stride ||
    publication.sliceHeight !== frame.sliceHeight ||
    publication.color !== destination.color ||
    publication.commit !==
      ring.nativeChecksum(publication.sequence, [
        publication.index,
        publication.width,
        publication.height,
        publication.stride,
        publication.sliceHeight,
        publication.color
      ])
  )
    throw Error('Split worker publication differs from the fetched frame');
  return publication;
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

// The split probe never required a sidecar; clips without one keep the old 30 fps configure.
async function clipSidecar(clip) {
  try {
    return JSON.parse(await fsp.readFile(clip.replace(/\.h264$/, '.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function main(
  directory,
  {
    clip,
    stage,
    output,
    sourceRevision,
    nativePublish = false,
    autoOutputQueue = false,
    linkedGates = false,
    create = createDecoder,
    createNativeSink = createSink,
    openTransport = createTransport,
    sessionRpc,
    allocateSurface = allocate
  } = {}
) {
  if (!STAGES.includes(stage)) throw Error('Use --stage ' + STAGES.join('|'));
  if (!clip) throw Error('Pass --clip with an H.264 probe clip');
  if (autoOutputQueue && !nativePublish)
    throw Error('--auto-output-queue requires --native-publish');
  if (linkedGates && !autoOutputQueue)
    throw Error('--linked-gates requires --auto-output-queue');
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
  const fps = clipFrameRate(await clipSidecar(clip));
  const mode = linkedGates
    ? 'split-linked'
    : autoOutputQueue
      ? 'split-auto'
      : nativePublish
        ? 'split-publish'
        : 'split';
  output ||= path.join(
    '/media/storage2/builds/HBLauncher/native-h264',
    new Date().toISOString().replace(/[:.]/g, '-') +
      '-' +
      revision.slice(0, 8) +
      '-' + mode + '-' + stage
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
    fps,
    nativePublish,
    autoOutputQueue,
    linkedGates,
    started: new Date().toISOString()
  };
  await fsp.writeFile(path.join(output, 'manifest.json'), JSON.stringify(record, null, 2) + '\n', {
    mode: 0o600
  });
  let decoder = null;
  let decoderClosed = false;
  let transport = null;
  let sink = null;
  let nativeRing = null;
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
    if (nativePublish) {
      nativeRing = await step('native ring allocation', () =>
        allocateSurface(rpc, ring.MEMORY_BYTES, {
          failed: 'Split publication ring allocation failed',
          invalid: 'Invalid split publication ring allocation'
        })
      );
      const ready = Buffer.alloc(12);
      ready.writeUInt32LE(ring.NATIVE_ABI);
      await step('native ring initialize', () =>
        rpc.write(nativeRing + ring.CONTROL.nativeReady, ready)
      );
      sink = await step('native ring sink create', () =>
        createNativeSink(rpc, {
          mapped: nativeRing,
          bytes: ring.MEMORY_BYTES,
          memoryFlags: 4
        })
      );
    }
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
        transport,
        publication: sink?.workerPublication,
        autoQueue: autoOutputQueue,
        linkedGates
      })
    );
    const dimensions = await step('configure', () => decoder.configure(sps, pps, fps));
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
          secondJob = linkedGates
            ? await step('input job 2 staged while output job 1 in flight', () =>
                decoder.stageSplitInput(unit(secondIndex), {sendFirst: true})
              )
            : await step('input job 2 while output job 1 in flight', () =>
                decoder.submitSplit(unit(secondIndex))
              );
        }
        const acquired = linkedGates && secondJob
          ? await step('host receive count and output acquire checks', async () => {
              const [, output] = await Promise.all([
                decoder.verifySplitReceive(undefined, firstJob),
                decoder.waitSplitOutputAcquired(firstJob)
              ]);
              return output;
            })
          : null;
        const firstDestination = nativePublish
          ? await step('native destination 1', () =>
              sink.workerDestination(acquired?.presentation || (secondJob || firstJob).presentation)
            )
          : destination;
        const firstOutput = linkedGates && secondJob
          ? await step('linked output fetch and input submit', async () => {
              await decoder.openSplitOutputFetch(firstJob, firstDestination, secondJob);
              const [, output] = await Promise.all([
                decoder.finishSplitInputAfterLinkedGate(),
                decoder.completeSplitOutputFetch(firstJob)
              ]);
              return output;
            })
          : await step('output job 1 fetch', () =>
              decoder.finishSplitOutput(firstJob, firstDestination, autoOutputQueue ? secondJob : null)
            );
        if (firstOutput.pts !== String(nextIndex)) throw Error('Output job 1 PTS differs');
        const outputs = [firstOutput];
        const publications = [];
        if (nativePublish)
          publications.push(
            await step('native publication 1 readback', () =>
              verifyPublication(rpc, nativeRing, firstDestination, firstOutput)
            )
          );
        if (secondJob) {
          if (!autoOutputQueue)
            await step('output job 2 queued', () => decoder.queueSplitOutput(secondJob));
          const secondDestination = nativePublish
            ? await step('native destination 2', () =>
                sink.workerDestination(secondJob.presentation)
              )
            : destination;
          const secondOutput = await step('output job 2 fetch', () =>
            decoder.finishSplitOutput(secondJob, secondDestination)
          );
          if (secondOutput.pts !== String(keyframes[2])) throw Error('Output job 2 PTS differs');
          outputs.push(secondOutput);
          if (nativePublish)
            publications.push(
              await step('native publication 2 readback', () =>
                verifyPublication(rpc, nativeRing, secondDestination, secondOutput)
              )
            );
        }
        record.result = {
          outputs,
          ...(nativePublish ? {publications} : {}),
          decodeGateSignals: decoder.splitDiagnostics.decodeGateSignals
        };
      }
    }
  } catch (error) {
    failure = error;
    entries.write({phase: 'error', step: 'probe', message: error.message});
  }
  if (decoder && !rpc.bridgeLost) {
    try {
      await step('decoder close', () => decoder.close());
      decoderClosed = true;
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
  if (sink && !rpc.bridgeLost && (!decoder || decoderClosed)) {
    try {
      await step('native ring close', () => sink.close());
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

module.exports = {main, STAGES, loggedRpc, verifyPublication, clipSidecar};
if (require.main === module) {
  const args = process.argv.slice(2);
  main(session.resolve(args[0]), {
    clip: cli.option(args, '--clip'),
    stage: cli.option(args, '--stage'),
    output: cli.option(args, '--output') || undefined,
    nativePublish: args.includes('--native-publish'),
    autoOutputQueue: args.includes('--auto-output-queue'),
    linkedGates: args.includes('--linked-gates')
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
