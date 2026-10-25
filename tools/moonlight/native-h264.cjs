// Native H.264 route: ordered helper access units become console-written NV12 surfaces.
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const {spawn} = require('node:child_process');
const {execFileSync} = require('node:child_process');
const os = require('node:os');
const {AccessUnits, parameterSets} = require('./h264-stream.cjs');

// A lone backlog recovers within 100 ms; repeated backlogs double the wait up to a second,
// so sustained overload does not turn every frame into a keyframe.
const IDR_COOLDOWN_MS = 100;
const IDR_MAX_COOLDOWN_MS = 1000;
const IDR_QUIET_MS = 2000;

function createIdrRequester(
  send,
  {now = Date.now, schedule = setTimeout, cancel = clearTimeout} = {}
) {
  let lastSent = -Infinity;
  let cooldown = IDR_COOLDOWN_MS;
  let timer = null;
  let closed = false;
  return {
    request() {
      if (closed || timer !== null) return;
      const at = now();
      if (at - lastSent > IDR_QUIET_MS) cooldown = IDR_COOLDOWN_MS;
      timer = schedule(
        () => {
          timer = null;
          if (closed) return;
          lastSent = now();
          send();
          cooldown = Math.min(cooldown * 2, IDR_MAX_COOLDOWN_MS);
        },
        Math.max(0, lastSent + cooldown - at)
      );
    },
    close() {
      closed = true;
      if (timer !== null) cancel(timer);
      timer = null;
    }
  };
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
  createDecoder = require('./native-decoder.cjs').create,
  createTransport = require('./native-tcp.cjs').create,
  createSink = require('./native-sink.cjs').create,
  spawnProcess = spawn
}) {
  const at = args.indexOf('--moonlight');
  const host = args[at + 1],
    app = args[at + 2];
  if (at < 0 || !host || !app) throw Error('Native H.264 requires --moonlight HOST APP');
  const audio = !args.includes('--no-audio');
  const bitrate = require('./bitrate.cjs').bitrate(args, width, height, fps);
  if (!rpc.host)
    throw Error('Native TCP requires a fresh launcher session from this branch');
  const revision =
    sourceRevision ||
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8'
    }).trim();
  const output =
    process.env.HB_NATIVE_LOG_DIR ||
    path.join(
      '/media/storage2/builds/HBLauncher/native-h264',
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
  let stopping = false;
  let decoder = null;
  let sink = null;
  let helper = null;
  let reader = null;
  let statusLines = null;
  let monitor = null;
  let printing = null;
  let stopped = false;
  const children = [];
  const stats = {
    received: 0,
    submitted: 0,
    decoded: 0,
    presented: 0,
    bytes: 0,
    keyframes: 0,
    resyncs: 0,
    idr: 0
  };
  const log = value => console.error(JSON.stringify(value));
  const cancelled = () => stopping;
  const idrRequester = createIdrRequester(() => {
    if (stopping) return;
    stats.idr++;
    helper.stdin.write(JSON.stringify({type: 'request-idr'}) + '\n');
  });

  function stop() {
    if (stopped) return;
    stopped = stopping = true;
    idrRequester.close();
    for (const child of children) child.kill('SIGINT');
    reader?.close();
    helper?.stdin.end();
    helper?.kill('SIGINT');
  }

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  function requestIdr() {
    if (!stopping) idrRequester.request();
  }
  try {
    sink = await createSink(rpc, storage, {cancelled});
    let resets = [];
    let generation = 0;
    const makeDecoder = async () => {
      const transport = await createTransport({rpc, host: rpc.host});
      try {
        return await createDecoder({
          rpc,
          directory,
          workerDirectory: path.join(output, 'decoder-' + generation),
          workerMode: 'persistent',
          transport,
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
      maxQueuedUnits: 3,
      onBacklog: requestIdr
    });
    helper.stdin.on('error', error => {
      if (!stopping) reader.fail(error);
    });
    helper.on('error', error => reader.fail(error));
    helper.on('exit', (code, signal) => {
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
        [path.join(__dirname, 'input-feeder.cjs'), directory],
        {
          stdio: ['ignore', helper.stdin, 'inherit']
        }
      );
      child.on('error', error => reader.fail(error));
      child.on('exit', (code, signal) => {
        if (!stopping && code !== 0)
          reader.fail(Error('Moonlight input feed exited: ' + (signal || code)));
      });
      children.push(child);
    }
    if (audio) {
      const child = spawnProcess(
        process.execPath,
        [
          path.join(__dirname, 'audio-stream.cjs'),
          directory,
          '--buffer-frames',
          rpc.a.protocol >= 3 ? '960' : '1920',
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
      persistentStarted = false,
      outstanding = 0,
      unshown = null;
    async function resync(error) {
      resets = resets.filter(time => Date.now() - time < 30000);
      if (resets.length >= 3) throw error;
      resets.push(Date.now());
      stats.resyncs++;
      log({event: 'native-resync', message: error.message, result: error.result});
      await decoder.close();
      generation++;
      decoder = await makeDecoder();
      configured = false;
      persistentStarted = false;
      outstanding = 0;
      unshown = null;
      requestIdr();
    }
    monitor = setInterval(async () => {
      try {
        const runtime = JSON.parse(await fs.readFile(path.join(directory, 'app-runtime.json')));
        if (runtime.active?.id !== 'moonlight') stop();
      } catch (error) {
        reader.fail(error);
      }
    }, 500);
    let dropped = 0;
    let stage = 'read',
      stageAt = performance.now(),
      stageMs = {};
    const enter = name => {
      const now = performance.now();
      stageMs[stage] = (stageMs[stage] || 0) + now - stageAt;
      stageAt = now;
      stage = name;
    };
    printing = setInterval(() => {
      console.log(
        JSON.stringify({
          codec: 'h264',
          ...stats,
          dropped: reader.dropped - dropped,
          at: stage + '/' + (decoder?.step ?? '-'),
          ms: Object.fromEntries(Object.entries(stageMs).map(([k, v]) => [k, Math.round(v)]))
        })
      );
      stageMs = {};
      dropped = reader.dropped;
      Object.keys(stats).forEach(key => {
        stats[key] = 0;
      });
    }, 1000);
    for await (const unit of reader) {
      enter('unit');
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
        if (persistentStarted) {
          // With the next unit already queued, the previous frame is published while
          // the console decodes this one; an idle stream publishes at once.
          const publish = async () => {
            enter('publish');
            await sink.publish(unshown.destination, unshown.frame);
            unshown = null;
            stats.presented++;
          };
          enter('persistent');
          await decoder.beginPersistent(unit);
          if (unshown) await publish();
          enter('destination');
          const destination = await sink.destination();
          enter('persistent');
          const frame = await decoder.finishPersistent(destination);
          stats.submitted++;
          stats.decoded++;
          unshown = {destination, frame};
          if (!reader.ready.length) await publish();
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
          if (outstanding === 0 && !persistentStarted) {
            await decoder.startPersistent();
            persistentStarted = true;
            log({event: 'persistent-worker', started: true});
          }
        }
      } catch (error) {
        if (stopping || error.result === undefined) throw error;
        await resync(error);
      }
      enter('read');
    }
  } catch (error) {
    if (!stopping) {
      log({
        event: 'native-error',
        message: error.message,
        pending: error.pending,
        control: error.control
      });
      throw error;
    }
  } finally {
    clearInterval(monitor);
    clearInterval(printing);
    stop();
    statusLines?.close();
    const errors = [];
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
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (errors.length) throw new AggregateError(errors, 'Native H.264 shutdown failed');
  }
}

module.exports = {run, createIdrRequester};
