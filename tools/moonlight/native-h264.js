// Native H.264 route: ordered helper access units become console-written NV12 surfaces.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import {AccessUnits, parameterSets} from './h264-stream.js';
import {instrument} from './bridge-counter.js';
import * as cli from '../../../hbl-platform/sdk/cli.js';
import {builds} from '../../../hbl-platform/scripts/toolchain.js';
import * as scoring from './run-summary.js';
import {bitrate as streamBitrate} from './bitrate.js';
import {create as createNativeDecoder} from './native-decoder.js';
import {create as createNativeTransport} from './native-tcp.js';
import {create as createNativeSink} from './native-sink.js';
import {create as createSocketAudioSource} from './socket-audio-source.js';
import * as pairedLive from './paired-live.js';
import {create as createStaggeredLive} from './staggered-live.js';
import * as exchangeTiming from './exchange-timing.js';

const IDR_COOLDOWN_MS = 100;
// A backlog while the console is not answering is the console's, so asking Sunshine for a
// keyframe cannot help; past CONSOLE_STALL_MS the stream reports the console and stops.
const IDR_QUIET_MS = 1000;
const CONSOLE_STALL_MS = 5000;
// A staggered host runs at present pace, so it needs room for a source burst (batch C2).
const STAGGERED_QUEUE = 8;

function createIdrRequester(
  send,
  {now = Date.now, schedule = setTimeout, cancel = clearTimeout} = {}
) {
  let lastSent = -Infinity;
  let timer = null;
  let closed = false;
  return {
    request() {
      if (closed || timer !== null) return;
      timer = schedule(
        () => {
          timer = null;
          if (closed) return;
          lastSent = now();
          send();
        },
        Math.max(0, lastSent + IDR_COOLDOWN_MS - now())
      );
    },
    close() {
      closed = true;
      if (timer !== null) cancel(timer);
      timer = null;
    }
  };
}

function countsSince(now, before) {
  return Object.fromEntries(
    Object.entries(now)
      .map(([key, count]) => [key, count - (before[key] || 0)])
      .filter(([, count]) => count)
  );
}

const tenths = value => Math.round(value * 10) / 10;

/**
 * One stats row's access-unit timing: the mean and longest wait from host arrival to send, and
 * over the units that went through a gate, the mean age at gate and how many were in hand.
 * @param {{arrivedAt: number, gatedAt: number | null, sentAt: number, inHand: number | null}[]} samples
 */
function auTiming(samples) {
  const gated = samples.filter(sample => sample.gatedAt !== null);
  const mean = values =>
    values.length ? tenths(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  const waits = samples.map(sample => sample.sentAt - sample.arrivedAt);
  return {
    units: samples.length,
    gated: gated.length,
    waitMs: mean(waits),
    maxWaitMs: waits.length ? tenths(Math.max(...waits)) : null,
    gateAgeMs: mean(gated.map(sample => sample.gatedAt - sample.arrivedAt)),
    inHand: mean(gated.map(sample => sample.inHand)),
    maxInHand: gated.length ? Math.max(...gated.map(sample => sample.inHand)) : null
  };
}

/**
 * Adds the input feeder's bridge counts to a row's bridgeByStage, leaving the row's own
 * exchange totals to the video process.
 * @param {{bridgeByStage: Record<string, {exchanges: number, bridgeMs: number}>}} counts
 * @param {{exchanges: number, bridgeMs: number}} input
 */
function withInputStage(counts, input) {
  if (input.exchanges)
    counts.bridgeByStage.input = {exchanges: input.exchanges, bridgeMs: Math.round(input.bridgeMs)};
  return counts;
}

async function run({
  args,
  directory,
  rpc,
  storage,
  helperPath,
  width,
  height,
  fps,
  sourceRevision,
  createDecoder = createNativeDecoder,
  createTransport = createNativeTransport,
  createSink = createNativeSink,
  createSocketAudio = createSocketAudioSource,
  createPaired = pairedLive.create,
  createStaggered = createStaggeredLive,
  spawnProcess = spawn,
  consoleStallMs = CONSOLE_STALL_MS,
  statsMs = 1000,
  now = () => performance.now()
}) {
  const at = args.indexOf('--moonlight');
  const host = args[at + 1],
    app = args[at + 2];
  if (at < 0 || !host || !app) throw Error('Native H.264 requires --moonlight HOST APP');
  const audio = !args.includes('--no-audio');
  const socketTone = args.includes('--socket-audio-tone');
  const socketAudio = socketTone || args.includes('--socket-audio');
  if (socketAudio && !audio) throw Error('--socket-audio cannot be combined with --no-audio');
  const pairedLoop = args.includes('--paired-loop');
  const staggered = args.includes('--staggered');
  const workerMode =
    pairedLoop || staggered || args.includes('--split-decoder') ? 'split' : 'persistent';
  const nativePublish = args.includes('--native-publish');
  const autoOutputQueue = args.includes('--auto-output-queue');
  const linkedGates = args.includes('--linked-gates');
  if (staggered && (pairedLoop || nativePublish || autoOutputQueue || linkedGates))
    throw Error(
      '--staggered drives its own input and output workers; drop the paired and split worker flags'
    );
  if (pairedLoop && (nativePublish || autoOutputQueue || linkedGates))
    throw Error('--paired-loop publishes from its own worker; drop the split worker flags');
  if (nativePublish && workerMode !== 'split')
    throw Error('--native-publish requires --split-decoder');
  if (autoOutputQueue && !nativePublish)
    throw Error('--auto-output-queue requires --native-publish');
  if (linkedGates && !autoOutputQueue) throw Error('--linked-gates requires --auto-output-queue');
  const duration = cli.number(args, '--duration', null);
  const warmup = cli.number(args, '--warmup', 3);
  const queue = cli.number(args, '--queue', staggered ? STAGGERED_QUEUE : 3);
  const inputHz = cli.number(args, '--input-hz', 60);
  const presentHz = cli.number(args, '--present-hz', 60);
  const skipRule = cli.option(args, '--skip-rule') ?? 'backlog';
  const trimBacklogMs = cli.number(args, '--trim-backlog-ms', null);
  const gateOnReceive = args.includes('--gate-on-receive');
  const outputLag = cli.number(args, '--output-lag', null);
  const decodeWait = args.includes('--decode-wait');
  const receiveWait = args.includes('--receive-wait');
  const avoidWindow = exchangeTiming.parseAvoid(cli.option(args, '--avoid-window') ?? undefined);
  const skipBacklog =
    cli.option(args, '--skip-backlog') === 'off'
      ? Infinity
      : cli.number(args, '--skip-backlog', skipRule === 'vsync' ? 1 : 2);
  const audioFrames = cli.number(
    args,
    '--audio-frames',
    socketAudio ? 1920 : rpc.a.protocol >= 3 ? 960 : 1920
  );
  if (!Number.isInteger(inputHz) || inputHz < 10 || inputHz > 120)
    throw Error('--input-hz takes 10 to 120');
  if (presentHz !== 60 && presentHz !== 120) throw Error('--present-hz takes 60 or 120');
  if (skipBacklog !== Infinity && !(Number.isInteger(skipBacklog) && skipBacklog >= 0))
    throw Error('--skip-backlog takes a unit count or off');
  if (!['backlog', 'vsync'].includes(skipRule)) throw Error('--skip-rule takes backlog or vsync');
  if (skipRule === 'vsync' && skipBacklog === Infinity)
    throw Error('--skip-rule vsync needs a --skip-backlog unit count');
  if (decodeWait && skipRule !== 'vsync') throw Error('--decode-wait needs --skip-rule vsync');
  if (trimBacklogMs !== null && !(trimBacklogMs > 0))
    throw Error('--trim-backlog-ms takes a unit age in milliseconds');
  if (trimBacklogMs !== null && skipRule === 'vsync')
    throw Error('--trim-backlog-ms needs --skip-rule backlog');
  if (avoidWindow && !(decodeWait || receiveWait))
    throw Error('--avoid-window needs --decode-wait or --receive-wait to predict the events');
  if (
    !staggered &&
    ['--present-hz', '--skip-backlog', '--skip-rule'].some(name => args.includes(name))
  )
    throw Error('--present-hz, --skip-backlog and --skip-rule apply to --staggered');
  if (!staggered && trimBacklogMs !== null) throw Error('--trim-backlog-ms applies to --staggered');
  if (!staggered && gateOnReceive) throw Error('--gate-on-receive applies to --staggered');
  if (gateOnReceive && presentHz === 120)
    throw Error('--gate-on-receive is untested at --present-hz 120');
  if (outputLag !== null && outputLag !== 1 && outputLag !== 2)
    throw Error('--output-lag takes 1 or 2');
  if (!staggered && outputLag !== null) throw Error('--output-lag applies to --staggered');
  if (!Number.isInteger(audioFrames) || audioFrames < 240 || audioFrames % 240)
    throw Error('--audio-frames takes a multiple of 240');
  if (socketAudio && audioFrames > 3840)
    throw Error('--audio-frames takes up to 3840 with --socket-audio');
  if (!Number.isInteger(queue) || queue < 1 || queue > 16)
    throw Error('--queue takes 1 to 16 units');
  if (duration !== null && !(duration > 0)) throw Error('--duration takes seconds');
  if (!Number.isInteger(warmup) || warmup < 0) throw Error('--warmup takes whole seconds');
  if (args.includes('--expect') && !/^[a-z]/i.test(cli.option(args, '--expect') ?? ''))
    throw Error('--expect needs a value such as fps=30,dropped=0,idr=0');
  const expect = scoring.parseExpect(cli.option(args, '--expect') ?? undefined);
  const bitrate = streamBitrate(args, width, height, fps);
  if (!rpc.host) throw Error('Native TCP requires a fresh launcher session from this branch');
  const revision =
    sourceRevision ||
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      encoding: 'utf8'
    }).trim();
  const output =
    process.env.HB_NATIVE_LOG_DIR ||
    path.join(
      builds('native-h264'),
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + revision.slice(0, 8)
    );
  await fs.mkdir(output, {recursive: true, mode: 0o700});
  await fs.writeFile(
    path.join(output, 'manifest.json'),
    JSON.stringify(
      {
        session: rpc.a.session,
        sourceRevision: revision,
        builder: os.hostname(),
        targetArchitecture: 'aarch64',
        command: process.argv,
        started: new Date().toISOString()
      },
      null,
      2
    ) + '\n',
    {mode: 0o600}
  );
  let stage = 'setup';
  const bridge = instrument(rpc, () => stage);
  rpc = pairedLoop || staggered ? pairedLive.watchBridge(bridge.rpc) : bridge.rpc;
  let stopping = false;
  let pairing = false;
  let decoder = null;
  let transport = null;
  let paired = null;
  let staggeredLive = null;
  let tail = null;
  let unpaired = 0;
  let sink = null;
  let soundSource = null;
  let socketAudioReport = null;
  let helper = null;
  let reader = null;
  let statusLines = null;
  let monitor = null;
  let printing = null;
  let ending = null;
  let stopped = false;
  let stopReason = null;
  const rows = [];
  const children = [];
  let inputBridge = {exchanges: 0, bridgeMs: 0};
  let trimmed = 0;
  let auSamples = [];
  const stats = {
    received: 0,
    submitted: 0,
    decoded: 0,
    presented: 0,
    skipped: 0,
    bytes: 0,
    keyframes: 0,
    resyncs: 0,
    idr: 0
  };
  const log = value => {
    const line = JSON.stringify(value);
    fsSync.appendFileSync(
      path.join(output, 'events.jsonl'),
      JSON.stringify({at: new Date().toISOString(), ...value}) + '\n',
      {mode: 0o600}
    );
    console.error(line);
  };
  const cancelled = () => stopping && !pairing;
  const idrRequester = createIdrRequester(() => {
    if (stopping) return;
    stats.idr++;
    helper.stdin.write(JSON.stringify({type: 'request-idr'}) + '\n');
  });

  function stop(reason = 'cleanup') {
    if (stopped) return;
    stopped = stopping = true;
    stopReason = reason;
    log({event: 'native-stop', reason});
    idrRequester.close();
    for (const child of children) child.kill('SIGINT');
    helper?.stdin.end();
    helper?.kill('SIGINT');
    reader?.close();
    soundSource?.halt();
  }

  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  function requestIdr() {
    if (!stopping && bridge.silentMs() < IDR_QUIET_MS) idrRequester.request();
  }
  try {
    sink = await createSink(rpc, storage, {cancelled});
    let resets = [];
    let generation = 0;
    const makeDecoder = async () => {
      transport = await createTransport({rpc, host: rpc.host});
      if (pairedLoop) paired = createPaired({rpc, publication: sink.workerPublication});
      if (staggered)
        staggeredLive = createStaggered({
          presentHz,
          skipBacklog,
          skipRule,
          ...(trimBacklogMs !== null && {trimBacklogMs}),
          ...(gateOnReceive && {gateOnReceive}),
          ...(outputLag !== null && {lag: outputLag}),
          decodeWait,
          receiveWait,
          avoid: avoidWindow,
          now
        });
      try {
        return await createDecoder({
          rpc,
          directory,
          workerDirectory: path.join(output, 'decoder-' + generation),
          workerMode,
          transport,
          publication: nativePublish || pairedLoop || staggered ? sink.workerPublication : null,
          autoQueue: autoOutputQueue,
          linkedGates,
          ...(pairedLoop ? {splitWorkerFactory: paired.factory} : {}),
          ...(staggered ? {splitWorkerFactory: staggeredLive.factory} : {}),
          log,
          cancelled
        });
      } catch (error) {
        await transport?.close().catch(() => {});
        throw error;
      }
    };
    decoder = await makeDecoder();
    helper = spawnProcess(
      helperPath,
      [
        'stream',
        host,
        app,
        '--size',
        `${width}x${height}`,
        '--fps',
        String(fps),
        '--bitrate',
        bitrate,
        '--raw-h264-fd',
        '4',
        ...(audio ? ['--audio-fd', '3'] : [])
      ],
      {stdio: ['pipe', 'ignore', 'pipe', audio ? 'pipe' : 'ignore', 'pipe']}
    );
    reader = new AccessUnits(helper.stdio[4], {
      maxQueuedUnits: queue,
      onBacklog: requestIdr,
      now
    });
    helper.stdin.on('error', error => {
      if (!stopping) reader.fail(error);
    });
    helper.on('error', error => reader.fail(error));
    helper.on('exit', (code, signal) => {
      log({event: 'helper-exit', code, signal, stopping});
      if (!stopping && code !== 0) reader.fail(Error('hbmoonlight exited: ' + (signal || code)));
    });
    statusLines = readline.createInterface({input: helper.stderr});
    statusLines.on('line', line => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        console.error('hbmoonlight ' + line);
        return;
      }
      if (record.type === 'au') reader.announce(record);
      else if (record.event !== 'stats') log(record);
    });
    statusLines.on('close', () => reader.endMetadata());
    if (!args.includes('--no-input')) {
      const child = spawnProcess(
        process.execPath,
        [
          path.join(import.meta.dirname, 'input-feeder.js'),
          directory,
          '--hz',
          String(inputHz),
          '--counts-fd',
          '3'
        ],
        {
          stdio: ['ignore', helper.stdin, 'inherit', 'pipe']
        }
      );
      if (child.stdio?.[3])
        readline
          .createInterface({input: child.stdio[3]})
          .on('line', line => {
            try {
              const counts = JSON.parse(line);
              inputBridge.exchanges += counts.exchanges;
              inputBridge.bridgeMs += counts.bridgeMs;
            } catch {}
          })
          .on('error', error => log({event: 'input-counts-error', message: error.message}));
      child.on('error', error => reader.fail(error));
      child.on('exit', (code, signal) => {
        if (!stopping && code !== 0)
          reader.fail(Error('Moonlight input feed exited: ' + (signal || code)));
      });
      children.push(child);
    }
    if (socketAudio) {
      soundSource = await createSocketAudio({
        rpc,
        host: rpc.host,
        bufferBytes: audioFrames * 4,
        tone: socketTone,
        onError: error => reader.fail(error)
      });
      soundSource.attach(helper.stdio[3]);
      log({event: 'socket-audio', started: true, bufferBytes: audioFrames * 4});
    } else if (audio) {
      const child = spawnProcess(
        process.execPath,
        [
          path.join(import.meta.dirname, 'audio-stream.js'),
          directory,
          '--buffer-frames',
          String(audioFrames),
          '--queue',
          '2',
          '--prime',
          '2',
          '--stats'
        ],
        {
          stdio: [helper.stdio[3], 'inherit', 'inherit']
        }
      );
      child.on('error', error => reader.fail(error));
      child.on('exit', (code, signal) => {
        if (!stopping && code !== 0)
          reader.fail(Error('Moonlight audio stream exited: ' + (signal || code)));
      });
      children.push(child);
    }
    let sps,
      pps,
      configured = false,
      workerStarted = false,
      pendingSplitOutput = null,
      firstFrame = null,
      heldUnit = null,
      outstanding = 0;
    async function resync(error) {
      if ((nativePublish && workerStarted) || paired?.exists || staggeredLive?.exists) throw error;
      resets = resets.filter(time => Date.now() - time < 30000);
      if (resets.length >= 3) throw error;
      resets.push(Date.now());
      stats.resyncs++;
      log({event: 'native-resync', message: error.message, result: error.result});
      await decoder.close();
      generation++;
      decoder = await makeDecoder();
      configured = false;
      workerStarted = false;
      pendingSplitOutput = null;
      outstanding = 0;
      requestIdr();
    }
    monitor = setInterval(async () => {
      try {
        const runtime = JSON.parse(await fs.readFile(path.join(directory, 'app-runtime.json')));
        if (runtime.active?.id !== 'moonlight') stop('app-exit');
      } catch (error) {
        reader.fail(error);
      }
    }, 500);
    let dropped = 0;
    let queued = 0;
    let waited = {};
    stage = 'read';
    let stageAt = performance.now(),
      stageMs = {};
    const enter = name => {
      const now = performance.now();
      stageMs[stage] = (stageMs[stage] || 0) + now - stageAt;
      stageAt = now;
      stage = name;
    };
    const statsFile = path.join(output, 'stats.jsonl');
    printing = setInterval(() => {
      const silent = bridge.silentMs();
      if (silent >= consoleStallMs && !stopping) {
        log({
          event: 'console-stalled',
          silentMs: Math.round(silent),
          message: 'The console stopped answering'
        });
        stop('console-stalled');
      }
      const row = {
        codec: 'h264',
        ...stats,
        dropped: reader.dropped - dropped,
        queued,
        ...(staggeredLive ? {waiting: countsSince(staggeredLive.counts.waiting, waited)} : {}),
        ...(staggered ? {au: auTiming(auSamples)} : {}),
        ...(trimBacklogMs !== null ? {trimmed} : {}),
        ...withInputStage(bridge.take(), inputBridge),
        at: stage + '/' + (decoder?.step ?? '-'),
        ms: Object.fromEntries(Object.entries(stageMs).map(([k, v]) => [k, Math.round(v)]))
      };
      rows.push(row);
      const line = JSON.stringify(row);
      console.log(line);
      fs.appendFile(statsFile, line + '\n', {mode: 0o600}).catch(() => {});
      stageMs = {};
      inputBridge = {exchanges: 0, bridgeMs: 0};
      auSamples = [];
      trimmed = 0;
      dropped = reader.dropped;
      queued = 0;
      waited = staggeredLive?.counts.waiting ?? {};
      Object.keys(stats).forEach(key => {
        stats[key] = 0;
      });
    }, statsMs);
    if (duration !== null) ending = setTimeout(() => stop('duration'), duration * 1000);
    for await (const unit of reader) {
      enter('unit');
      queued = Math.max(queued, reader.ready.length);
      if (stopping) break;
      stats.received++;
      stats.bytes += unit.data.length;
      if (unit.keyframe) stats.keyframes++;
      const sets = parameterSets(unit.data);
      if (
        configured &&
        ((sets.sps && !sets.sps.equals(sps)) || (sets.pps && !sets.pps.equals(pps)))
      )
        await resync(Error('H.264 parameter sets changed'));
      sps = sets.sps || sps;
      pps = sets.pps || pps;
      if (!configured) {
        if (!unit.keyframe || !sps || !pps) continue;
        await decoder.configure(sps, pps, fps);
        configured = true;
      }
      try {
        if (workerStarted && staggered) {
          pairing = true;
          const sample = {arrivedAt: unit.arrivedAt, gatedAt: null, sentAt: null, inHand: null};
          try {
            await staggeredLive.push(unit, {
              sink,
              enter,
              backlog: reader.ready.length,
              onGate: at => {
                sample.gatedAt = at;
                sample.inHand = 1 + reader.ready.length;
              },
              onSent: at => {
                sample.sentAt = at;
              },
              onTrimmed: ageMs => {
                trimmed++;
                log({event: 'backlog-trim', ageMs: tenths(ageMs), trimBacklogMs});
              },
              onSkipped: count => {
                stats.skipped += count;
              },
              onDecoded: count => {
                stats.decoded += count;
              },
              onPresented: count => {
                stats.presented += count;
              }
            });
          } finally {
            pairing = false;
          }
          auSamples.push(sample);
          stats.submitted++;
          enter('read');
          continue;
        }
        if (workerStarted && pairedLoop) {
          if (!heldUnit) {
            heldUnit = unit;
            enter('read');
            continue;
          }
          const units = [heldUnit, unit];
          heldUnit = null;
          pairing = true;
          try {
            await paired.pair({
              decoder,
              sink,
              units,
              layout: firstFrame,
              enter,
              onDecoded: count => {
                stats.decoded += count;
              },
              onPresented: count => {
                stats.presented += count;
              }
            });
          } finally {
            pairing = false;
          }
          stats.submitted += 2;
          enter('read');
          continue;
        }
        if (workerStarted && workerMode === 'split') {
          enter('split-input');
          if (linkedGates && pendingSplitOutput) {
            const staged = await decoder.stageSplitInput(unit, {sendFirst: true});
            stats.submitted++;
            const [, acquired] = await Promise.all([
              decoder.verifySplitReceive(undefined, pendingSplitOutput),
              decoder.waitSplitOutputAcquired(pendingSplitOutput)
            ]);
            enter('destination');
            const destination = await sink.workerDestination(acquired.presentation);
            enter('split-output');
            await decoder.openSplitOutputFetch(pendingSplitOutput, destination, staged);
            const [current] = await Promise.all([
              decoder.finishSplitInputAfterLinkedGate(),
              decoder.completeSplitOutputFetch(pendingSplitOutput)
            ]);
            stats.decoded++;
            stats.presented++;
            pendingSplitOutput = current;
            enter('read');
            continue;
          }
          const current = await decoder.submitSplit(unit);
          stats.submitted++;
          if (pendingSplitOutput) {
            enter('destination');
            const destination = nativePublish
              ? await sink.workerDestination(current.presentation)
              : await sink.destination();
            enter('split-output');
            const frame = await decoder.finishSplitOutput(
              pendingSplitOutput,
              destination,
              autoOutputQueue ? current : null
            );
            stats.decoded++;
            if (!nativePublish) {
              enter('publish');
              await sink.publish(destination, frame);
            }
            stats.presented++;
          }
          enter('split-queue');
          if (!autoOutputQueue || !pendingSplitOutput) await decoder.queueSplitOutput(current);
          pendingSplitOutput = current;
          enter('read');
          continue;
        }
        if (workerStarted) {
          enter('persistent');
          await decoder.beginPersistent(unit);
          enter('destination');
          const destination = await sink.destination();
          enter('persistent');
          const frame = await decoder.finishPersistent(destination);
          stats.submitted++;
          stats.decoded++;
          enter('publish');
          await sink.publish(destination, frame);
          stats.presented++;
          enter('read');
          continue;
        }
        enter('submit');
        await decoder.submit(unit);
        stats.submitted++;
        outstanding++;
        // Frames before the persistent worker take the host-driven path, which is
        // drained fully so the worker starts with no output owed.
        const drainUntil = Date.now() + 200;
        for (let pull = true; pull || outstanding > 0; pull = false) {
          enter('destination');
          const destination = await sink.destination();
          enter('receive');
          const frame = await decoder.receive(destination);
          if (!frame) {
            if (Date.now() > drainUntil) break;
            await new Promise(resolve => setTimeout(resolve, 5));
            continue;
          }
          outstanding--;
          stats.decoded++;
          enter('publish');
          await sink.publish(destination, frame);
          stats.presented++;
          firstFrame ||= frame;
          if (outstanding === 0 && !workerStarted) {
            if (staggered) {
              await sink.wait();
              staggeredLive.start({input: decoder.lastInput, frame: firstFrame});
            } else if (pairedLoop) {
              await sink.wait();
              await decoder.startSplit();
              await paired.start();
            } else if (workerMode === 'split') await decoder.startSplit();
            else await decoder.startPersistent();
            workerStarted = true;
            log({
              event: (staggered ? 'staggered' : pairedLoop ? 'paired' : workerMode) + '-worker',
              started: true,
              ...(trimBacklogMs !== null && {trimBacklogMs}),
              ...(gateOnReceive && {gateOnReceive}),
              ...(outputLag !== null && {outputLag})
            });
          }
        }
      } catch (error) {
        if (stopping || error.result === undefined) throw error;
        await resync(error);
      }
      enter('read');
    }
    if (heldUnit) {
      unpaired++;
      heldUnit = null;
      log({event: 'paired-unpaired', count: unpaired});
    }
    if (staggeredLive?.pending) {
      if (!stopping || stopReason === 'duration') {
        pairing = true;
        try {
          tail = await staggeredLive.finish({
            sink,
            enter,
            onDecoded: count => {
              stats.decoded += count;
            },
            onPresented: count => {
              stats.presented += count;
            },
            onSkipped: count => {
              stats.skipped += count;
            }
          });
        } finally {
          pairing = false;
        }
      } else tail = {drained: 0, skipped: stopReason};
      log({event: 'staggered-tail', ...tail});
    }
    if (workerMode === 'split' && pendingSplitOutput && !stopping) {
      enter('destination');
      const destination = nativePublish
        ? await sink.workerDestination(null)
        : await sink.destination();
      enter('split-output');
      const frame = await decoder.finishSplitOutput(pendingSplitOutput, destination);
      stats.decoded++;
      if (!nativePublish) {
        enter('publish');
        await sink.publish(destination, frame);
      }
      stats.presented++;
      pendingSplitOutput = null;
    }
  } catch (error) {
    if (paired?.exists && !rpc.bridgeLost)
      log({
        event: 'paired-snapshot',
        snapshot: await paired.snapshot().catch(snapshotError => ({error: snapshotError.message}))
      });
    if (staggeredLive?.exists && !rpc.bridgeLost)
      log({
        event: 'staggered-snapshot',
        snapshot: await staggeredLive
          .snapshot()
          .catch(snapshotError => ({error: snapshotError.message}))
      });
    if (!stopping || pairedLoop || staggered)
      log({
        event: 'native-error',
        message: error.message,
        pending: error.pending,
        control: error.control,
        ...(stopping ? {stopping} : {})
      });
    if (!stopping) throw error;
  } finally {
    clearInterval(monitor);
    clearInterval(printing);
    clearTimeout(ending);
    stop('cleanup');
    statusLines?.close();
    const errors = [];
    if (soundSource) {
      socketAudioReport = await soundSource.close();
      log({event: 'socket-audio', ...socketAudioReport});
      await fs
        .writeFile(
          path.join(directory, `moonlight-audio-${Date.now()}.json`),
          JSON.stringify(
            {
              session: rpc.a.session,
              mode: 'socket',
              completed: new Date().toISOString(),
              ...socketAudioReport
            },
            null,
            2
          )
        )
        .catch(error => errors.push(error));
      if (socketAudioReport.retainedForSafety) errors.push(Error(socketAudioReport.error));
    }
    let retained = Boolean(rpc.bridgeLost);
    if (paired && !retained) {
      try {
        await paired.stop();
      } catch (error) {
        errors.push(error);
        retained = true;
      }
    }
    if (staggeredLive && !retained) {
      try {
        await staggeredLive.stop();
      } catch (error) {
        errors.push(error);
        retained = true;
      }
    }
    if (retained) {
      transport?.abort?.();
      errors.push(Error('Native objects retained for safety; restart SmileBASIC'));
      log({
        event: 'native-retained',
        reason: (staggered ? 'staggered worker' : 'paired loop') + ' or bridge state is uncertain'
      });
    } else {
      try {
        await decoder?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await sink?.close();
      } catch (error) {
        errors.push(error);
      }
    }
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    if (errors.length) throw new AggregateError(errors, 'Native H.264 shutdown failed');
  }
  const steadyRows = rows.slice(warmup);
  const summary = {
    workerMode: pairedLoop ? 'paired' : staggered ? 'staggered' : workerMode,
    ...(staggered
      ? {
          decoded: steadyRows.reduce((sum, row) => sum + row.decoded, 0),
          presentHz,
          skipBacklog: skipBacklog === Infinity ? 'off' : skipBacklog,
          skipRule,
          ...(trimBacklogMs !== null && {trimBacklogMs}),
          ...(gateOnReceive && {gateOnReceive}),
          ...(outputLag !== null && {outputLag}),
          decodeWait,
          receiveWait,
          avoidWindow,
          staggered: {...(staggeredLive?.counts ?? {}), tail}
        }
      : {}),
    ...(pairedLoop
      ? {
          decoded: steadyRows.reduce((sum, row) => sum + row.decoded, 0),
          unpaired
        }
      : {}),
    queue,
    inputHz,
    audioFrames,
    audio,
    ...(socketAudio ? {socketAudio: socketAudioReport} : {}),
    input: !args.includes('--no-input'),
    ...scoring.summarize(rows, {warmup}),
    expect,
    stopReason
  };
  const result = scoring.verdict(summary, expect);
  if (socketAudioReport?.error) result.failures.push('socket audio: ' + socketAudioReport.error);
  if (stopReason === 'console-stalled') result.failures.push('console stopped answering');
  if (duration !== null && stopReason !== 'duration')
    result.failures.push('ended before duration: ' + stopReason);
  result.pass = result.failures.length === 0;
  Object.assign(summary, result);
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', {
    mode: 0o600
  });
  log({
    event: 'summary',
    verdict: result.pass ? 'PASS' : 'FAIL',
    failures: result.failures,
    mode: workerMode,
    fps: summary.fps,
    minFps: summary.minFps,
    dropped: summary.dropped,
    ...(summary.trimmed !== undefined && {trimmed: summary.trimmed}),
    idr: summary.idr,
    requestsPerFrame: summary.requestsPerFrame,
    bridgeMsPerFrame: summary.bridgeMsPerFrame,
    stopReason,
    record: output
  });
  return summary;
}

export {run, createIdrRequester, countsSince, auTiming, withInputStage};
