/**
 * The nnCompat movie::Decoder ABI the civ7 stream configures: create, configure from SPS/PPS,
 * start and close. The console-side decode batches run the frames (civ7/decode-batch.js).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import definitions from '../console-api/movie-functions.json' with {type: 'json'};
import modeDefinitions from '../console-api/movie-mode-functions.json' with {type: 'json'};

/** The movie module's description, in the directory create() is given. */
const MODULE_FILE = 'compatibility-module.json';

/**
 * Offsets in the module memory. The decoder, media objects and buffers sit at the start;
 * the control slots from inputIndex to outputCount receive the out-parameters of one decode
 * frame; the rest stage SPS, PPS and media keys and values.
 */
export const MEMORY = {
  decoder: 0,
  configuration: 0x100,
  format: 0x180,
  input: 0x200,
  output: 0x300,
  inputIndex: 0x400,
  inputCount: 0x404,
  outputIndex: 0x410,
  timestamp: 0x418,
  flags: 0x420,
  outputCount: 0x424,
  outputSize: 0x440,
  alignment: 0x444,
  sps: 0x1000,
  pps: 0x2000,
  key: 0x3000,
  value: 0x4000
};
const WORD_BYTES = 4;

/** movie::DecoderType and movie::DecoderOutputFormat of the decoder this module builds. */
const DECODER_TYPE = 1;
const DECODER_OUTPUT_FORMAT = 4;
/** The largest movie::DecoderMode a probe may ask for; the values are not known. */
const MAX_DECODER_MODE = 2;
/** The decoder's implementation pointer, nonzero once the constructor succeeded. */
const DECODER_IMPLEMENTATION_OFFSET = 8;
const POINTER_BYTES = 8;

const NAL_TYPE_MASK = 0x1f;
const NAL_SPS = 7;
const NAL_PPS = 8;
const MIN_SPS_BYTES = 4;
const MAX_PARAMETER_SET_BYTES = 4096;

const MIN_FPS = 1;
const MAX_FPS = 120;
const DEFAULT_FPS = 60;

const MIN_DIMENSION = 2;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1088;
/** The H.264 configuration helper returns 1 on success. */
const CONFIGURATION_CREATED = 1;

/** The only pixel format the decoder is built for. */
const OUTPUT_FORMAT = 'nv12';

/** A movie Result is the low 32 bits of a call's return value. */
const RESULT_BITS = 32;

/** @param {bigint} value */
const result = value => Number(BigInt.asUintN(RESULT_BITS, value));

/**
 * An error carrying the raw 32-bit result of a failed movie call.
 * @param {string} what
 * @param {number} value
 */
const resultError = (what, value) =>
  Object.assign(Error(what + ' returned 0x' + value.toString(16)), {result: value});

/**
 * The movie::DecoderMode MNX2_DECODER_MODE asks for, or null when it is unset or empty, and
 * the decoder is built exactly as without it.
 * @param {Record<string, string | undefined>} env
 * @returns {number | null}
 */
function modeFromEnv(env) {
  const value = env.MNX2_DECODER_MODE;
  if (!value) return null;

  const mode = Number(value);
  if (!Number.isInteger(mode) || mode < 0 || mode > MAX_DECODER_MODE)
    throw Error('MNX2_DECODER_MODE must be a whole number from 0 to ' + MAX_DECODER_MODE);
  return mode;
}

/**
 * The functions a decoder of `mode` calls: the mode constructor joins only when a mode is
 * asked for, so an unset mode verifies and calls the same set as before.
 * @param {number | null} mode
 */
const definitionsFor = mode => (mode === null ? definitions : {...definitions, ...modeDefinitions});

/**
 * @typedef {{symbol: string, offset: number, size: number, hex: string}} MovieDefinition
 * @typedef {{name: unknown, section: unknown, offset: unknown, size: unknown}} MovieSymbol
 * @typedef {{base: number, symbols: MovieSymbol[]}} MovieModule
 */

/**
 * The movie module in console memory, as civ7/decoder.js opens it.
 * @typedef {object} MovieApi
 * @property {number} base The module memory's address.
 * @property {Record<string, number>} functions The verified movie functions.
 * @property {(name: string, args?: (number | bigint)[]) => Promise<bigint>} call
 * @property {(offset: number, length: number) => Promise<Buffer>} read
 * @property {(offset: number, data: Buffer) => Promise<unknown>} write
 * @property {() => Promise<unknown>} close
 */

/**
 * @typedef {object} DecoderOptions
 * @property {string} directory Holds the compatibility-module.json of the movie module.
 * @property {(settings: {base: number, definitions: Record<string, MovieDefinition>}) =>
 *   Promise<MovieApi>} openModule Verifies the functions and allocates the module memory.
 * @property {(event: object) => void} [log]
 * @property {number | null} [mode] A movie::DecoderMode to build with (MNX2_DECODER_MODE).
 */

/**
 * The fields of a compatibility-module.json this file reads.
 * @param {unknown} value
 * @returns {value is MovieModule}
 */
function isMovieModule(value) {
  if (!value || typeof value !== 'object') return false;

  const {base, symbols} = /** @type {Record<string, unknown>} */ (value);
  const symbolsOk = Array.isArray(symbols) && symbols.every(symbol => symbol && typeof symbol === 'object');
  return Number.isSafeInteger(base) && symbolsOk;
}

/**
 * @param {MovieModule} movieModule The compatibility-module.json of the loaded movie module.
 * @param {Record<string, MovieDefinition>} used The definitions the decoder will call.
 * @returns {boolean}
 */
function matchesInspectedBuild(movieModule, used) {
  return Object.values(used).every(definition =>
    movieModule.symbols.some(symbol => sameSymbol(symbol, definition))
  );
}

/**
 * @param {MovieSymbol} symbol A symbol of the loaded module.
 * @param {MovieDefinition} definition Its inspected definition.
 * @returns {boolean}
 */
function sameSymbol(symbol, definition) {
  if (symbol.name !== definition.symbol || !symbol.section) return false;
  return symbol.offset === definition.offset && symbol.size === definition.size;
}

/**
 * Reads the movie module's description and checks it against the inspected build.
 * @param {string} directory
 * @param {Record<string, MovieDefinition>} used The definitions the decoder will call.
 * @returns {Promise<MovieModule>}
 */
async function loadMovieModule(directory, used) {
  /** @type {unknown} */
  const movieModule = JSON.parse(await fs.readFile(path.join(directory, MODULE_FILE), 'utf8'));
  if (!isMovieModule(movieModule)) throw Error('Invalid movie module description');
  if (!matchesInspectedBuild(movieModule, used))
    throw Error('The loaded movie module differs from the inspected build');
  return movieModule;
}

/**
 * @param {Buffer} sps
 * @param {Buffer} pps
 * @returns {boolean}
 */
function invalidParameterSets(sps, pps) {
  if (!Buffer.isBuffer(sps) || !Buffer.isBuffer(pps)) return true;
  if (sps.length < MIN_SPS_BYTES || !pps.length) return true;
  if (sps.length > MAX_PARAMETER_SET_BYTES || pps.length > MAX_PARAMETER_SET_BYTES) return true;
  return (sps[0] & NAL_TYPE_MASK) !== NAL_SPS || (pps[0] & NAL_TYPE_MASK) !== NAL_PPS;
}

/**
 * @param {number} fps
 * @returns {boolean}
 */
function invalidFrameRate(fps) {
  return !Number.isInteger(fps) || fps < MIN_FPS || fps > MAX_FPS;
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {boolean}
 */
function outsideSurface(width, height) {
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) return true;
  return width > MAX_WIDTH || height > MAX_HEIGHT;
}

/**
 * Builds the decoder, then the media objects, then the buffers, recording each in `owned`
 * as it exists so close() destroys exactly those.
 * @param {MovieApi} api
 * @param {(field: keyof typeof MEMORY) => number} pointer
 * @param {[string, number][]} owned
 * @param {number | null} mode
 */
async function construct(api, pointer, owned, mode) {
  const decoder = [pointer('decoder'), DECODER_TYPE, DECODER_OUTPUT_FORMAT];
  if (mode === null) await api.call('decoderCreate', decoder);
  else await api.call('decoderCreateMode', [...decoder, mode]);
  owned.push(['decoderDestroy', pointer('decoder')]);
  const implementation = await api.read(
    MEMORY.decoder + DECODER_IMPLEMENTATION_OFFSET,
    POINTER_BYTES
  );
  if (!implementation.readBigUInt64LE()) throw Error('The movie decoder did not initialize');

  for (const field of /** @type {const} */ (['configuration', 'format'])) {
    await api.call('mediaCreate', [pointer(field)]);
    owned.push(['mediaDestroy', pointer(field)]);
    if (!(await api.read(MEMORY[field], POINTER_BYTES)).readBigUInt64LE())
      throw Error('Movie metadata allocation failed');
  }
  for (const field of /** @type {const} */ (['input', 'output'])) {
    await api.call('bufferCreate', [pointer(field)]);
    owned.push(['bufferDestroy', pointer(field)]);
  }
}

/**
 * The decoder object create() returns.
 * @param {MovieApi} api
 * @param {[string, number][]} owned What construct() built, in construction order.
 * @param {(event: object) => void} log
 */
function decoderObject(api, owned, log) {
  /** @param {keyof typeof MEMORY} field */
  const pointer = field => api.base + MEMORY[field];
  let running = false;
  let configured = false;
  let closed = false;

  /**
   * @param {string} name
   * @param {(number | bigint)[]} args
   */
  async function success(name, args) {
    const value = result(await api.call(name, args));
    if (value !== 0) throw resultError('movie::' + name, value);
  }

  /**
   * Looks up a required integer of a media object by key.
   * @param {number} object
   * @param {string} name
   */
  async function integer(object, name) {
    await api.write(MEMORY.key, Buffer.from(name + '\0'));
    await api.write(MEMORY.value, Buffer.alloc(WORD_BYTES));
    const found = result(await api.call('mediaFindInt', [object, pointer('key'), pointer('value')]));
    if (!found) throw Error('Decoder format is missing ' + name);

    return (await api.read(MEMORY.value, WORD_BYTES)).readInt32LE();
  }

  /** Stops the decoder and destroys what create() built, collecting every failure. */
  async function close() {
    if (closed) return;
    closed = true;

    const errors = [];
    if (running) {
      try {
        await success('stop', [pointer('decoder')]);
      } catch (error) {
        errors.push(error);
      }
      running = false;
    }
    for (const [destroy, address] of owned.reverse()) {
      try {
        await api.call(destroy, [address]);
      } catch (error) {
        errors.push(error);
      }
    }
    // Freed last, and only after a clean shutdown: the movie objects live in module memory.
    if (!errors.length) {
      try {
        await api.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Movie decoder cleanup failed');
  }

  return {
    pointer,

    /**
     * Configures the decoder from bare SPS and PPS NALs and starts decoding.
     * @param {Buffer} sps
     * @param {Buffer} pps
     * @param {number} [fps]
     * @returns {Promise<{width: number, height: number}>}
     */
    async configure(sps, pps, fps = DEFAULT_FPS) {
      if (configured || closed) throw Error('Decoder configuration is not available');
      if (invalidParameterSets(sps, pps)) throw Error('Expected bounded bare SPS and PPS NALs');
      if (invalidFrameRate(fps)) throw Error('Invalid decoder frame rate');

      await api.write(MEMORY.sps, sps);
      await api.write(MEMORY.pps, pps);
      const made = result(await api.call('createH264Configuration', [
        pointer('sps'),
        sps.length,
        pointer('pps'),
        pps.length,
        pointer('configuration')
      ]));
      if (made !== CONFIGURATION_CREATED)
        throw Error('The native H.264 configuration helper rejected SPS/PPS');

      const width = await integer(pointer('configuration'), 'width');
      const height = await integer(pointer('configuration'), 'height');
      if (outsideSurface(width, height) || width % 2 || height % 2)
        throw Error('Decoded dimensions exceed the Moonlight surface');

      await api.write(MEMORY.key, Buffer.from('frame-rate\0'));
      await api.call('mediaSetInt', [pointer('configuration'), pointer('key'), fps]);
      await success('configure', [pointer('decoder'), pointer('configuration')]);
      await success('start', [pointer('decoder')]);

      configured = true;
      running = true;
      log({event: 'native-decoder', width, height, format: OUTPUT_FORMAT});
      return {width, height};
    },

    close
  };
}

/**
 * Builds a movie decoder in module memory. configure() starts it.
 * @param {DecoderOptions} options
 */
async function create({directory, openModule, log = () => {}, mode = modeFromEnv(process.env)}) {
  const used = definitionsFor(mode);
  const movieModule = await loadMovieModule(directory, used);
  const api = await openModule({base: movieModule.base, definitions: used});

  /** @type {[string, number][]} */
  const owned = [];
  const decoder = decoderObject(api, owned, log);
  try {
    await construct(api, decoder.pointer, owned, mode);
  } catch (error) {
    try {
      await decoder.close();
    } catch (cleanup) {
      if (typeof error === 'object' && error !== null) Object.assign(error, {cleanup});
    }
    throw error;
  }
  return decoder;
}

export {create, modeFromEnv};
