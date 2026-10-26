/**
 * Raw RGB24 frame sources for desktop tools: decodes any video ffmpeg can open, scaled to the
 * requested size, and cuts the byte stream into whole frames.
 */
import {spawn} from 'node:child_process';

const RGB_BYTES = 3;

function ffmpegArgs(file, width, height, limit) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    file,
    ...(Number.isFinite(limit) ? ['-frames:v', String(limit)] : []),
    '-vf',
    `scale=${width}:${height}:flags=area`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-'
  ];
}

/**
 * Yields up to `limit` RGB24 frames of width x height; rejects if ffmpeg fails.
 * @param {string} file
 * @param {number} width
 * @param {number} height
 * @param {number} [limit]
 * @returns {AsyncGenerator<Buffer>}
 */
async function* readFrames(file, width, height, limit = Infinity) {
  const frameBytes = width * height * RGB_BYTES;
  const ffmpeg = spawn('ffmpeg', ffmpegArgs(file, width, height, limit), {
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const exited = new Promise((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', code =>
      code === 0 ? resolve() : reject(Error('ffmpeg exited with ' + code))
    );
  });
  yield* split(ffmpeg.stdout, frameBytes, limit);
  await exited;
}

/**
 * Cuts a raw byte stream into frameBytes-sized frames, as views into the read buffers. A partial
 * trailing frame is dropped.
 * @param {AsyncIterable<Buffer>} stream
 * @param {number} frameBytes
 * @param {number} [limit]
 * @returns {AsyncGenerator<Buffer>}
 */
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
