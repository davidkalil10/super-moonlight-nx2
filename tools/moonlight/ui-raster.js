/**
 * The host side of ui-text.py: one long-lived PIL child that paints the text strips and cover
 * tiles of the console UI pages. Requests are answered in order, each with an 8-byte size
 * header and the pixels, so the queue here pairs every reply with its request.
 */
import path from 'node:path';
import {spawn} from 'node:child_process';

const HEADER_BYTES = 8;

/**
 * @typedef {{width: number, height: number, bytes: Buffer}} Painted
 */

/**
 * @param {{spawnProcess?: typeof spawn}} [options]
 */
function createRaster({spawnProcess = spawn} = {}) {
  const child = spawnProcess('python3', [path.join(import.meta.dirname, 'ui-text.py')], {
    stdio: ['pipe', 'pipe', 'inherit']
  });
  /** @type {{resolve: (painted: Painted) => void, reject: (error: Error) => void}[]} */
  const queue = [];
  let pending = Buffer.alloc(0);
  let failure = null;
  child.stdout.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < HEADER_BYTES) return;
      const width = pending.readUInt32LE(0),
        height = pending.readUInt32LE(4),
        request = queue[0],
        bytes = width * height * (request?.channels ?? 1);
      if (pending.length < HEADER_BYTES + bytes) return;
      pending = pending.subarray(HEADER_BYTES);
      const painted = Buffer.from(pending.subarray(0, bytes));
      pending = pending.subarray(bytes);
      queue.shift()?.resolve({width, height, bytes: painted});
    }
  });
  child.on('exit', (code, signal) => {
    failure = Error('ui-text.py exited: ' + (signal || code));
    for (const request of queue.splice(0)) request.reject(failure);
  });
  child.on('error', error => {
    failure = error;
    for (const request of queue.splice(0)) request.reject(error);
  });

  /** @param {object} request @param {number} channels */
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
     */
    text: (text, size, width, align = 'left') => paint({kind: 'text', text, size, width, align}, 1),
    /** A cover PNG fitted inside a width x height RGBA8 tile. */
    tile: (png, width, height) => paint({kind: 'tile', png, width, height}, 4),
    /** An RGBA8 tile with the name's initials on a hue derived from the name. */
    letters: (text, width, height) => paint({kind: 'letters', text, width, height}, 4),
    close() {
      child.stdin.end();
    }
  };
}

export {createRaster};
