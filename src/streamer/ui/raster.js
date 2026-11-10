/**
 * The PC side of the UI painter: glyph-raster.js over the packaged atlas fonts/glyphs.bin. Text
 * paints synchronously, as on the console; cover tiles read their PNG and stay on the PC.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {createGlyphRaster} from './glyph-raster.js';

const ATLAS_PATH = path.join(import.meta.dirname, 'fonts', 'glyphs.bin');

/**
 * @typedef {{width: number, height: number, bytes: Buffer}} Painted
 */

/** @type {Uint8Array | null} */
let atlas = null;

/** The atlas, inflated once per process. */
function loadAtlas() {
  atlas ??= zlib.inflateSync(fs.readFileSync(ATLAS_PATH));
  return atlas;
}

/** @param {Uint8Array} data @param {number} expected */
function inflate(data, expected) {
  return zlib.inflateSync(data, {maxOutputLength: expected});
}

/** @param {import('./glyph-raster.js').Bitmap} bitmap @returns {Painted} */
function toPainted({width, height, bytes}) {
  return {width, height, bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)};
}

function createRaster() {
  const painter = createGlyphRaster(loadAtlas(), {inflate});

  return {
    /**
     * An alpha-8 strip of the text at the font size, `width` wide and one line high; the text
     * is shortened with an ellipsis when it does not fit.
     * @param {string} text
     * @param {number} size
     * @param {number} width
     * @param {'left' | 'center' | 'right'} [align]
     * @param {{weight?: number, tracking?: number}} [style] the UI face weight (500 to 700) and px
     *   between letters
     */
    text: (text, size, width, align = 'left', style = {}) =>
      toPainted(painter.text(text, size, width, align, style)),
    /**
     * Button hints in one alpha-8 strip.
     * @param {[string, string][]} keys Button and label pairs
     * @param {number} size
     * @param {number} width
     */
    legend: (keys, size, width) => toPainted(painter.legend(keys, size, width)),
    /**
     * A cover PNG fitted inside a width x height RGBA8 tile; 0 x 0 when the file is not usable.
     * @param {string} png
     * @param {number} width
     * @param {number} height
     */
    async tile(png, width, height) {
      let bytes;
      try {
        bytes = await fs.promises.readFile(png);
      } catch {
        return {width: 0, height: 0, bytes: Buffer.alloc(0)};
      }
      return toPainted(painter.tile(bytes, width, height));
    },
    /**
     * An RGBA8 tile with the name's initials on a hue derived from the name.
     * @param {string} text
     * @param {number} width
     * @param {number} height
     */
    letters: (text, width, height) => toPainted(painter.letters(text, width, height)),
    /** Nothing to release; kept for the callers that close the painter with their session. */
    close() {}
  };
}

export {createRaster};
