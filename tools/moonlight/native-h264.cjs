// Native H.264 route: ordered helper access units become console-written NV12 surfaces.
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const {spawn} = require('node:child_process');
const {execFileSync} = require('node:child_process');
const os = require('node:os');
const {AccessUnits, parameterSets} = require('./h264-stream.cjs');

async function run({
  args,
  directory,
  rpc,
  storage,
  helperPath,
  width,
  height,
  fps,
  createDecoder = require('./native-decoder.cjs').create,
  createSink = require('./native-sink.cjs').create,
  spawnProcess = spawn
}) {
  const at = args.indexOf('--moonlight');
  const host = args[at + 1],
    app = args[at + 2];
  if (at < 0 || !host || !app) throw Error('Native H.264 requires --moonlight HOST APP');
  const audio = !args.includes('--no-audio');
  const bitrate = args.includes('--bitrate') ? args[args.indexOf('--bitrate') + 1] : '20000';
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
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
  let idrTimer;
  let lastIdr = 0;
  // Minimum spacing between IDR requests. Each IDR is an order of magnitude
  // larger than a P frame, so spacing them keeps a transient backlog from
  // spiralling into a flood of keyframes that saturates the link.
  const IDR_COOLDOWN_MS = 1000;
  const children = [];
  const stats = {
    received: 0,
    submitted: 0,
    decoded: 0,
    presented: 0,
    bytes: 0,
    keyframes: 0,
    resyncs: 0
  };
  const log = value => console.error(JSON.stringify(value));
  const cancelled = () => stopping;

  function stop() {
    if (stopped) return;
    stopped = stopping = true;
    clearTimeout(idrTimer);
    for (const child of children) child.kill('SIGINT');
    reader?.close();
    helper?.stdin.end();
    helper?.kill('SIGINT');
  }

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  function requestIdr() {
    if (stopping || idrTimer) return;
    idrTimer = setTimeout(
      () => {
        idrTimer = null;
        if (stopping) return;
        lastIdr = Date.now();
        helper.stdin.write(JSON.stringify({type: 'request-idr'}) + '\n');
      },
      Math.max(0, lastIdr + IDR_COOLDOWN_MS - Date.now())
    );
  }
  try {
    sink = await createSink(rpc, storage, {cancelled});
    let resets = [];
    let generation = 0;
    const makeDecoder = () =>
      createDecoder({
        rpc,
        directory,
        workerDirectory: path.join(output, 'decoder-' + generation),
        log,
        cancelled
      });
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
      outstanding = 0;
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
      outstanding = 0;
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
    printing = setInterval(() => {
      console.log(JSON.stringify({codec: 'h264', ...stats, dropped: reader.dropped - dropped}));
      dropped = reader.dropped;
      Object.keys(stats).forEach(key => {
        stats[key] = 0;
      });
    }, 1000);
    for await (const unit of reader) {
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
        await decoder.submit(unit);
        stats.submitted++;
        outstanding++;
        // One pull per submit in the steady 1:1 case, so no known-empty
        // acquireOutput; extra pulls happen only while the decoder owes frames.
        // The next destination() waits for the GPU to apply the last frame, so
        // no explicit wait is needed here and submit of N+1 is not blocked on it.
        while (outstanding > 0) {
          const destination = await sink.destination();
          const frame = await decoder.receive(destination);
          if (!frame) break;
          outstanding--;
          stats.decoded++;
          await sink.publish(destination, frame);
          stats.presented++;
        }
      } catch (error) {
        if (stopping || error.result === undefined) throw error;
        await resync(error);
      }
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

module.exports = {run};
