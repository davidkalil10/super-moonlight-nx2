// Live HBV1 sender: captures frames, encodes them on worker threads and writes
// the newest finished frame into the running Moonlight app's ring.
// Usage: node tools/moonlight/live.cjs runs/launcher-XXXX [--screen | --input FILE]
//        [--size 1280x720] [--fps 60] [--depth 2] [--workers 8]
const path = require('node:path');
const {spawn} = require('node:child_process');
const {Worker} = require('node:worker_threads');
const ring = require('../../apps/moonlight/ring.cjs');
const {findPrivateStorage} = require('./feed.cjs');
const hbv = require('./hbv.cjs');

function source(args, fps, width, height) {
  if (args.includes('--screen'))
    return spawn('python3', [path.join(__dirname, 'screencast.py'), width, height, fps], {
      stdio: ['ignore', 'pipe', 'inherit']
    });
  const file = args[args.indexOf('--input') + 1];
  if (!args.includes('--input') || !file) throw Error('Pass --screen or --input FILE');
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

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) =>
    args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback;
  const fps = option('--fps', 60),
    depth = option('--depth', 2),
    workerCount = option('--workers', 8);
  const size = args.includes('--size') ? args[args.indexOf('--size') + 1] : '1280x720';
  const [width, height] = size.split('x').map(Number);
  if (hbv.layout(width, height).slotBytes > ring.SLOT_BYTES)
    throw Error(`${size} frames do not fit a ${ring.SLOT_BYTES / 1024} KiB ring slot`);
  const frameBytes = width * height * 3;
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

  const capture = source(args, fps, width, height);
  const report = setInterval(() => {
    console.log(JSON.stringify(stats));
    for (const key of Object.keys(stats)) stats[key] = 0;
  }, 1000);
  process.on('SIGINT', () => capture.kill());

  let pending = Buffer.alloc(0);
  for await (const chunk of capture.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      stats.captured++;
      const worker = idle.pop();
      if (!worker) {
        stats.droppedBusy++;
        continue;
      }
      const rgb = new Uint8Array(frame).buffer;
      worker.postMessage({rgb, width, height, sequence: ++sequence}, [rgb]);
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
