/**
 * The host side of text.py: one long-lived PIL child that paints the text strips and cover
 * tiles of the console UI pages. Requests are answered in order, each with an 8-byte size
 * header and the pixels, so the queue here pairs every reply with its request.
 */
import path from 'node:path';
import {spawn} from 'node:child_process';

/** Each reply starts with its width and height as little-endian u32s. */
const HEADER_BYTES = 8;

/**
 * @typedef {{width: number, height: number, bytes: Buffer}} Painted
 */

/**
 * @param {{spawnProcess?: typeof spawn}} [options]
 */
function createRaster({spawnProcess = spawn} = {}) {
  const child = spawnProcess('python3', [path.join(import.meta.dirname, 'text.py')], {
    stdio: ['pipe', 'pipe', 'inherit']
  });

  /**
   * Requests awaiting their reply, oldest first; channels is the bytes per pixel it carries.
   * @type {{resolve: (painted: Painted) => void, reject: (error: Error) => void,
   *   channels: number}[]}
   */
  const queue = [];
  /** Reply bytes read but not yet handed out. */
  let pending = Buffer.alloc(0);
  /** Set once the child is gone; every later request fails with it. */
  let failure = null;

  /** Hands out every complete reply in `pending`, in order. */
  function drain() {
    while (pending.length >= HEADER_BYTES) {
      const width = pending.readUInt32LE(0);
      const height = pending.readUInt32LE(4);
      const channels = queue[0]?.channels ?? 1;
      const size = width * height * channels;
      if (pending.length < HEADER_BYTES + size) return;

      const bytes = Buffer.from(pending.subarray(HEADER_BYTES, HEADER_BYTES + size));
      pending = pending.subarray(HEADER_BYTES + size);
      queue.shift()?.resolve({width, height, bytes});
    }
  }

  /** Fails every queued request and every later one with `error`. */
  function failAll(error) {
    failure = error;
    for (const request of queue.splice(0)) request.reject(error);
  }

  child.stdout.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    drain();
  });
  child.on('exit', (code, signal) => failAll(Error('text.py exited: ' + (signal || code))));
  child.on('error', failAll);

  /** Sends one JSON request line; resolves with its reply of `channels` bytes per pixel. */
  function paint(request, channels) {
    if (failure) return Promise.reject(failure);

    return new Promise((resolve, reject) => {
      queue.push({resolve, reject, channels});
      child.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  return {
    /**
     * An alpha-8 strip of the text at the font size, `width` wide and one line high; the text
     * is shortened with an ellipsis when it does not fit.
     * @param {string} text
     * @param {number} size
     * @param {number} width
     * @param {'left' | 'center' | 'right'} [align]
     * @param {{weight?: number, tracking?: number}} [style] Sora weight (500 to 700) and px
     *   between letters
     */
    text: (text, size, width, align = 'left', {weight = 600, tracking = 0} = {}) =>
      paint({kind: 'text', text, size, width, align, weight, tracking}, 1),
    /**
     * Button hints in one alpha-8 strip.
     * @param {[string, string][]} keys Button and label pairs
     * @param {number} size
     * @param {number} width
     */
    legend: (keys, size, width) => paint({kind: 'legend', keys, size, width}, 1),
    /** A cover PNG fitted inside a width x height RGBA8 tile; 0 x 0 when the file is not usable. */
    tile: (png, width, height) => paint({kind: 'tile', png, width, height}, 4),
    /** An RGBA8 tile with the name's initials on a hue derived from the name. */
    letters: (text, width, height) => paint({kind: 'letters', text, width, height}, 4),
    close() {
      child.stdin.end();
    }
  };
}

export {createRaster};
