// Reads RGB24 frames from any video ffmpeg can open, scaled to width x height.
import {spawn} from 'node:child_process';

async function* readFrames(file, width, height, limit = Infinity) {
  const frameBytes = width * height * 3;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    file,
    '-vf',
    `scale=${width}:${height}:flags=area`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-'
  ];
  if (Number.isFinite(limit)) args.splice(5, 0, '-frames:v', String(limit));
  const ffmpeg = spawn('ffmpeg', args, {stdio: ['ignore', 'pipe', 'inherit']});
  const exited = new Promise((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', code =>
      code === 0 ? resolve() : reject(Error('ffmpeg exited with ' + code))
    );
  });
  yield* split(ffmpeg.stdout, frameBytes, limit);
  await exited;
}

// Cuts a raw byte stream into frameBytes-sized frames, views into the read buffers.
async function* split(stream, frameBytes, limit = Infinity) {
  let pending = Buffer.alloc(0),
    count = 0;
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes && count < limit) {
      yield pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      count++;
    }
  }
}

export {readFrames, split};
