// Live sender: captures frames from a source and writes them into the running
// Moonlight app's ring.
//   hbv1  intra-only frames encoded on worker threads; the newest one wins.
//   hbv2  the native encoder (tools/moonlight/build-hbv2enc.sh); P frames go
//         out in order, each in one write, and the console's last applied
//         sequence is polled to resync with a keyframe when the chain breaks.
// Usage: node tools/moonlight/live.cjs [runs/launcher-XXXX]
//        [--moonlight HOST APP [--bitrate KBPS] | --screen | --input FILE]
//        [--codec hbv1|hbv2] [--size 1920x1080] [--fps 60] [--depth 2]
//        hbv1: [--workers 12]
//        hbv2: [--budget 96] [--cap 256] (KiB) [--qp-min 4] [--qp-max 40]
//              [--refresh 2] [--threads N] [--resync 1000] (ms)
// --moonlight runs tools/moonlight/helper's hbmoonlight (path from $HBMOONLIGHT)
//   and, unless --no-input / --no-audio, also feeds controller+touch into its
//   stdin (input-feeder.cjs) and plays its audio on the console (audio-stream.cjs).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const {spawn} = require('node:child_process');
const {Worker} = require('node:worker_threads');
const ring = require('../../apps/moonlight/ring.cjs');
const {findPrivateStorage, nextSequence} = require('./feed.cjs');
const hbv = require('./hbv.cjs');

const HELPER =
  process.env.HBMOONLIGHT ||
  path.join(os.homedir(), 'claude-builds/HBLauncher/moonlight-helper/build/hbmoonlight');

function moonlight(args, fps, width, height, directory) {
  const at = args.indexOf('--moonlight');
  const [host, app] = [args[at + 1], args[at + 2]];
  if (!host || !app) throw Error('Pass --moonlight HOST APP');
  const bitrate = args.includes('--bitrate') ? args[args.indexOf('--bitrate') + 1] : '20000';
  const audio = !args.includes('--no-audio');
  const helper = spawn(
    HELPER,
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
      ...(audio ? ['--audio-fd', '3'] : [])
    ],
    {stdio: ['pipe', 'pipe', 'pipe', ...(audio ? ['pipe'] : [])]}
  );
  readline.createInterface({input: helper.stderr}).on('line', line => {
    if (!line.includes('"event":"stats"')) console.error('hbmoonlight ' + line);
  });

  const children = [];
  if (!args.includes('--no-input'))
    children.push(
      spawn(process.execPath, [path.join(__dirname, 'input-feeder.cjs'), directory], {
        stdio: ['ignore', helper.stdin, 'inherit']
      })
    );
  if (audio)
    children.push(
      spawn(process.execPath, [path.join(__dirname, 'audio-stream.cjs'), directory], {
        stdio: [helper.stdio[3], 'inherit', 'inherit']
      })
    );
  helper.stop = () => {
    for (const child of children) child.kill('SIGINT');
    helper.stdin.end();
  };
  return helper;
}
const POLL_MS = 500;

function source(args, fps, width, height, directory) {
  if (args.includes('--moonlight')) return moonlight(args, fps, width, height, directory);
  if (args.includes('--screen'))
    return spawn('python3', [path.join(__dirname, 'screencast.py'), width, height, fps], {
      stdio: ['ignore', 'pipe', 'inherit']
    });
  const file = args[args.indexOf('--input') + 1];
  if (!args.includes('--input') || !file)
    throw Error('Pass --moonlight HOST APP, --screen or --input FILE');
  const scale = `scale=${width}:${height}:flags=area,fps=${fps}`;
  return spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-re',
      '-stream_loop',
      '-1',
      '-i',
      file,
      '-vf',
      scale
    ].concat(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']),
    {stdio: ['ignore', 'pipe', 'inherit']}
  );
}

function newestRun() {
  const runs = path.join(__dirname, '../../runs');
  const newest = fs
    .readdirSync(runs)
    .filter(name => name.startsWith('launcher-'))
    .map(name => path.join(runs, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!newest) throw Error('No launcher session found in runs/');
  console.log('Using ' + path.relative(process.cwd(), newest));
  return newest;
}

async function* frames(capture, frameBytes, stats) {
  let pending = Buffer.alloc(0);
  for await (const chunk of capture.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      stats.captured++;
      yield Buffer.from(pending.subarray(0, frameBytes));
      pending = pending.subarray(frameBytes);
    }
  }
}

async function sendHbv1(context) {
  const {rpc, storage, capture, width, height, frameBytes, stats, option} = context;
  if (hbv.layout(width, Math.ceil(height / 16) * 16).slotBytes > ring.SLOT_BYTES)
    throw Error(`${width}x${height} frames do not fit a ${ring.SLOT_BYTES / 1024} KiB ring slot`);
  const depth = option('--depth', 2),
    idle = Array.from(
      {length: option('--workers', 12)},
      () => new Worker(path.join(__dirname, 'encode-worker.cjs'))
    );
  let sequence = (await nextSequence(rpc, storage.mapped)) - 1,
    written = sequence,
    newest = null,
    inFlight = 0;

  function pump() {
    while (newest && inFlight < depth) {
      const {sequence: next, slot} = newest;
      newest = null;
      if (next <= written) {
        stats.droppedStale++;
        continue;
      }
      written = next;
      inFlight++;
      rpc
        .write(storage.mapped + ring.slotOffset(next), Buffer.from(slot))
        .then(() => stats.written++)
        .catch(error => {
          console.error('Write failed: ' + error.message);
          process.exitCode = 1;
          capture.kill();
        })
        .finally(() => {
          inFlight--;
          pump();
        });
    }
  }

  for (const worker of idle)
    worker.on('message', result => {
      stats.encoded++;
      idle.push(worker);
      if (!newest || result.sequence > newest.sequence) {
        if (newest) stats.droppedStale++;
        newest = result;
      } else stats.droppedStale++;
      pump();
    });

  for await (const frame of frames(capture, frameBytes, stats)) {
    const worker = idle.pop();
    if (!worker) {
      stats.droppedBusy++;
      continue;
    }
    const rgb = new Uint8Array(frame).buffer;
    worker.postMessage({rgb, width, height, sequence: ++sequence}, [rgb]);
  }
  await Promise.all(idle.map(worker => worker.terminate()));
}

async function sendHbv2(context) {
  const {rpc, storage, capture, width, height, frameBytes, stats, option} = context;
  const {Encoder} = require('./hbv2-encoder.cjs');
  const encoder = new Encoder({threads: option('--threads', 0)}),
    depth = option('--depth', 2),
    resyncMs = option('--resync', 1000),
    settings = {
      budget: option('--budget', 96) * 1024,
      cap: option('--cap', 256) * 1024,
      qpMin: option('--qp-min', 4),
      qpMax: option('--qp-max', 40),
      refresh: option('--refresh', 2)
    },
    writes = new Set();
  let sequence = (await nextSequence(rpc, storage.mapped)) - 1,
    keyframe = true,
    latest = null,
    wake = null,
    done = false,
    applied = 0,
    progressAt = performance.now();

  // Capture runs freely; the encoder always takes the newest frame.
  const captured = (async () => {
    for await (const frame of frames(capture, frameBytes, stats)) {
      if (latest) stats.droppedBusy++;
      latest = frame;
      wake?.();
    }
    done = true;
    wake?.();
  })();

  // A P frame only applies on the frame it references, so a lost or
  // overwritten slot stalls the console until the next keyframe.
  const poll = setInterval(async () => {
    try {
      const now = (await rpc.read(storage.mapped + ring.CONTROL.applied, 4)).readUInt32LE();
      if (now !== applied) progressAt = performance.now();
      else if (sequence > applied && performance.now() - progressAt > resyncMs) {
        keyframe = true;
        progressAt = performance.now();
        stats.resyncs++;
      }
      applied = stats.applied = now;
    } catch (error) {
      console.error('Poll failed: ' + error.message);
    }
  }, POLL_MS);

  while (!done || latest) {
    if (!latest) {
      await new Promise(resolve => (wake = resolve));
      wake = null;
      continue;
    }
    while (writes.size >= depth) await Promise.race(writes);
    const frame = latest;
    latest = null;
    const result = await encoder.encode(frame, width, height, {
      ...settings,
      sequence: sequence + 1,
      keyframe
    });
    stats.encoded++;
    stats.encodeMs += result.encodeMicros / 1000;
    stats.qp += result.qp;
    if (!result.slotBytes) {
      stats.unchanged++;
      continue;
    }
    if (result.keyframe) keyframe = false;
    sequence = result.sequence;
    stats.bytes += result.slotBytes;
    stats.keyframes += result.keyframe;
    const write = rpc
      .write(storage.mapped + ring.slotOffset(sequence), result.slot)
      .then(() => stats.written++)
      .catch(error => {
        console.error('Write failed: ' + error.message);
        process.exitCode = 1;
        capture.kill();
      })
      .finally(() => writes.delete(write));
    writes.add(write);
  }
  clearInterval(poll);
  await Promise.all([...writes, captured]);
  await encoder.close();
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) =>
    args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback;
  const codec = args.includes('--codec') ? args[args.indexOf('--codec') + 1] : 'hbv1';
  if (!['hbv1', 'hbv2'].includes(codec)) throw Error('--codec is hbv1 or hbv2');
  const fps = option('--fps', 60);
  const size = args.includes('--size') ? args[args.indexOf('--size') + 1] : '1920x1080';
  const [width, height] = size.split('x').map(Number);
  const directory = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : newestRun();
  const rpc = require(path.join(directory, 'shared/rpc.cjs'));
  const storage = await findPrivateStorage(directory);
  if (storage.bytes < ring.MEMORY_BYTES)
    throw Error('The running Moonlight app predates HBV2; rebuild and reinstall it');

  const fresh = () =>
    codec === 'hbv1'
      ? {captured: 0, encoded: 0, written: 0, droppedBusy: 0, droppedStale: 0}
      : {
          captured: 0,
          encoded: 0,
          written: 0,
          droppedBusy: 0,
          unchanged: 0,
          keyframes: 0,
          resyncs: 0,
          bytes: 0,
          qp: 0,
          encodeMs: 0,
          applied: 0
        };
  const stats = fresh();
  const report = setInterval(() => {
    const line = {...stats};
    if (codec === 'hbv2') {
      line.qp = +(stats.qp / Math.max(1, stats.encoded)).toFixed(1);
      line.encodeMs = +(stats.encodeMs / Math.max(1, stats.encoded)).toFixed(1);
      line.kib = Math.round(stats.bytes / 1024);
      delete line.bytes;
    }
    console.log(JSON.stringify(line));
    Object.assign(stats, fresh(), codec === 'hbv2' ? {applied: stats.applied} : {});
  }, 1000);

  const capture = source(args, fps, width, height, directory);
  process.on('SIGINT', () => (capture.stop ? capture.stop() : capture.kill()));
  const context = {
    rpc,
    storage,
    capture,
    width,
    height,
    frameBytes: width * height * 3,
    stats,
    option
  };
  await (codec === 'hbv1' ? sendHbv1(context) : sendHbv2(context));
  clearInterval(report);
  process.exit();
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
