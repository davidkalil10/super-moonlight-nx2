// Live HBV1 sender: captures frames, encodes them on worker threads and writes
// the newest finished frame into the running Moonlight app's ring.
// Usage: node tools/moonlight/live.cjs runs/launcher-XXXX [--screen | --input FILE]
//        [--fps 60] [--depth 2] [--workers 6]
const path = require('node:path');
const {spawn} = require('node:child_process');
const {Worker} = require('node:worker_threads');
const ring = require('../../apps/moonlight/ring.cjs');
const {findPrivateStorage} = require('./feed.cjs');

const WIDTH = 640,
  HEIGHT = 352,
  FRAME_BYTES = WIDTH * HEIGHT * 3;

function source(args, fps) {
  if (args.includes('--screen'))
    return spawn('python3', [path.join(__dirname, 'screencast.py'), WIDTH, HEIGHT, fps], {
      stdio: ['ignore', 'pipe', 'inherit']
    });
  const file = args[args.indexOf('--input') + 1];
  if (!args.includes('--input') || !file) throw Error('Pass --screen or --input FILE');
  const scale = `scale=${WIDTH}:${HEIGHT}:flags=area,fps=${fps}`;
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

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) =>
    args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback;
  const fps = option('--fps', 60),
    depth = option('--depth', 2),
    workerCount = option('--workers', 6);
  const directory = path.resolve(args[0] ?? '');
  const rpc = require(path.join(directory, 'shared/rpc.cjs'));
  const storage = await findPrivateStorage(directory);

  const stats = {captured: 0, encoded: 0, written: 0, droppedBusy: 0, droppedStale: 0};
  const idle = Array.from(
    {length: workerCount},
    () => new Worker(path.join(__dirname, 'encode-worker.cjs'))
  );
  let sequence = 0,
    written = 0,
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

  const capture = source(args, fps);
  const report = setInterval(() => {
    console.log(JSON.stringify(stats));
    for (const key of Object.keys(stats)) stats[key] = 0;
  }, 1000);
  process.on('SIGINT', () => capture.kill());

  let pending = Buffer.alloc(0);
  for await (const chunk of capture.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= FRAME_BYTES) {
      const frame = pending.subarray(0, FRAME_BYTES);
      pending = pending.subarray(FRAME_BYTES);
      stats.captured++;
      const worker = idle.pop();
      if (!worker) {
        stats.droppedBusy++;
        continue;
      }
      const rgb = new Uint8Array(frame).buffer;
      worker.postMessage({rgb, width: WIDTH, height: HEIGHT, sequence: ++sequence}, [rgb]);
    }
  }
  clearInterval(report);
  await Promise.all(idle.map(worker => worker.terminate()));
  process.exit();
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
