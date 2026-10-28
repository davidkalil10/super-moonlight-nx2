/**
 * Host-controlled H.264 decoding through the inspected nnCompat movie::Decoder ABI, driven
 * per frame from the host (`workerMode` 'host') or by the staggered console workers ('split').
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import definitions from '../../console-api/movie-functions.json' with {type: 'json'};
import modeDefinitions from '../../console-api/movie-mode-functions.json' with {type: 'json'};
import {create as createModule} from '../../../../../hbl-platform/sdk/native/module.js';
import {createFinite} from '../../../../../hbl-platform/sdk/native/jobs.js';
import {builds} from '../../../../../hbl-platform/sdk/build.js';

/** The movie module's description, in the directory create() is given. */
const MODULE_FILE = 'compatibility-module.json';

/**
 * Offsets in the module memory. The decoder, media objects and buffers sit at the start;
 * the control slots from inputIndex to outputCount receive the out-parameters of one worker
 * frame and are read back together; the rest stage SPS, PPS and media keys and values.
 */
const MEMORY = {
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

/** inputIndex through outputCount, the out-parameters of a pump frame. */
const PUMP_CONTROL_BYTES = MEMORY.outputCount + WORD_BYTES - MEMORY.inputIndex;
/** outputIndex through outputCount, the out-parameters of AcquireOutput. */
const OUTPUT_CONTROL_BYTES = MEMORY.outputCount + WORD_BYTES - MEMORY.outputIndex;
/** The output size and its alignment, as GetOutputSize writes them. */
const SIZING_BYTES = MEMORY.alignment + WORD_BYTES - MEMORY.outputSize;

/** movie::DecoderType and movie::DecoderOutputFormat of the decoder this module builds. */
const DECODER_TYPE = 1;
const DECODER_OUTPUT_FORMAT = 4;
/** The largest movie::DecoderMode a probe may ask for; the values are not known. */
const MAX_DECODER_MODE = 2;
/** The decoder's implementation pointer, nonzero once the constructor succeeded. */
const DECODER_IMPLEMENTATION_OFFSET = 8;
const POINTER_BYTES = 8;
/** AcquireInput's index and count land at rpc.output and come back in the reply. */
const ACQUIRE_INPUT_REPLY_BYTES = 8;

/** Queue results that only mean no buffer is ready yet, when the index is negative. */
const EMPTY_QUEUE_RESULTS = [0x100e, 0x1011];
/** The output queue result for a frame not decoded yet. */
const OUTPUT_NOT_READY = 0x100e;

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

/** The values of DecoderOptions.workerMode. */
const WORKER_MODES = ['host', 'split'];
/** The only pixel format the decoder is built for. */
const OUTPUT_FORMAT = 'nv12';

/** How long, and how often, the host polls the input queue for a free slot. */
const QUEUE_TIMEOUT_MS = 5000;
const QUEUE_POLL_MS = 5;
/** Native workers get a directory per decoder here, named after its creation time. */
const DEFAULT_WORKER_ROOT = builds('native-h264');
const TIMESTAMP_SEPARATORS = /[:.]/g;

/** A movie Result is the low 32 bits of a call's return value. */
const RESULT_BITS = 32;

/** @param {bigint} value */
const result = value => Number(BigInt.asUintN(RESULT_BITS, value));
/** @param {number} milliseconds */
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** @param {number} value */
const int32 = value => {
  const b = Buffer.alloc(WORD_BYTES);
  b.writeInt32LE(value);
  return b;
};

/**
 * An error carrying the raw 32-bit result of a failed movie call.
 * @param {string} what
 * @param {number} value
 */
const resultError = (what, value) =>
  Object.assign(Error(what + ' returned 0x' + value.toString(16)), {result: value});

/**
 * Whether an acquire status is a real failure rather than an empty queue.
 * @param {number} status
 * @param {number} index
 */
const queueFailed = (status, index) =>
  status !== 0 && !(index < 0 && EMPTY_QUEUE_RESULTS.includes(status));

/**
 * Bytes of an NV12 frame: a full-size luma plane and a half-size chroma plane.
 * @param {number} stride
 * @param {number} sliceHeight
 */
const nv12Bytes = (stride, sliceHeight) => (stride * sliceHeight * 3) / 2;

/**
 * The movie::DecoderMode HBL_DECODER_MODE asks for, or null when it is unset or empty, and
 * the decoder is built exactly as without it.
 * @param {Record<string, string | undefined>} env
 * @returns {number | null}
 */
function modeFromEnv(env) {
  const value = env.HBL_DECODER_MODE;
  if (!value) return null;

  const mode = Number(value);
  if (!Number.isInteger(mode) || mode < 0 || mode > MAX_DECODER_MODE)
    throw Error('HBL_DECODER_MODE must be a whole number from 0 to ' + MAX_DECODER_MODE);
  return mode;
}

/**
 * The functions a decoder of `mode` calls: the mode constructor joins only when a mode is
 * asked for, so an unset mode verifies and calls the same set as before.
 * @param {number | null} mode
 */
const definitionsFor = mode => (mode === null ? definitions : {...definitions, ...modeDefinitions});

/**
 * @param {any} movieModule The compatibility-module.json of the loaded movie module.
 * @param {Record<string, any>} used The definitions the decoder will call.
 * @returns {boolean}
 */
function matchesInspectedBuild(movieModule, used) {
  return Object.values(used).every(definition =>
    movieModule.symbols.some(symbol => sameSymbol(symbol, definition))
  );
}

/**
 * @param {any} symbol A symbol of the loaded module.
 * @param {any} definition Its inspected definition.
 * @returns {boolean}
 */
function sameSymbol(symbol, definition) {
  if (symbol.name !== definition.symbol || !symbol.section) return false;
  return symbol.offset === definition.offset && symbol.size === definition.size;
}

/**
 * Reads the movie module's description and checks it against the inspected build.
 * @param {string} directory
 * @param {Record<string, any>} used The definitions the decoder will call.
 */
async function loadMovieModule(directory, used) {
  const movieModule = JSON.parse(
    /** @type {any} */ (await fs.readFile(path.join(directory, MODULE_FILE)))
  );
  if (!matchesInspectedBuild(movieModule, used))
    throw Error('The loaded movie module differs from the inspected build');
  return movieModule;
}

/** A fresh worker directory under DEFAULT_WORKER_ROOT. */
function defaultWorkerDirectory() {
  const stamp = new Date().toISOString().replace(TIMESTAMP_SEPARATORS, '-');
  return path.join(DEFAULT_WORKER_ROOT, stamp);
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
 * @param {AccessUnit} unit
 * @returns {boolean}
 */
function invalidUnit(unit) {
  if (!Buffer.isBuffer(unit.data) || !unit.data.length) return true;
  return !Number.isSafeInteger(unit.pts) || unit.pts < 0;
}

/**
 * Whether `destination` cannot hold a decoder output of `sizing`.
 * @param {OutputDestination} destination
 * @param {{bytes: number, alignment: number}} sizing
 * @returns {boolean | number} Truthy when it does not fit.
 */
function unfitDestination(destination, {bytes, alignment}) {
  if (!Number.isSafeInteger(destination.address) || !Number.isSafeInteger(destination.bytes))
    return true;
  if (destination.bytes < bytes || !alignment) return true;
  return destination.address % alignment;
}

/**
 * @param {Layout} layout
 * @param {number} bytes The decoder's output size.
 * @param {number} destinationBytes
 * @returns {boolean} True when the layout is unsupported.
 */
function unsupportedLayout({width, height, stride, sliceHeight}, bytes, destinationBytes) {
  if (outsideSurface(width, height)) return true;
  if (stride < width || sliceHeight < height) return true;
  if (stride % 2 || sliceHeight % 2) return true;

  const frameBytes = nv12Bytes(stride, sliceHeight);
  return frameBytes > destinationBytes || bytes < frameBytes;
}

/**
 * Decodes AcquireOutput's out-parameters from control slots read from `start` on.
 * @param {Buffer} control
 * @param {number} start The MEMORY offset `control` was read from.
 * @param {number} status AcquireOutput's result.
 */
function outputAt(control, start, status) {
  return {
    status,
    index: control.readInt32LE(MEMORY.outputIndex - start),
    pts: control.readBigUInt64LE(MEMORY.timestamp - start),
    flags: control.readUInt32LE(MEMORY.flags - start)
  };
}

/**
 * @typedef {object} AccessUnit
 * @property {Buffer} data One H.264 access unit.
 * @property {number} pts
 */

/** @typedef {{address: number, bytes: number}} OutputDestination */
/** @typedef {{width: number, height: number, stride: number, sliceHeight: number}} Layout */

/**
 * @typedef {object} DecoderOptions
 * @property {any} rpc
 * @property {string} directory Holds the compatibility-module.json of the movie module.
 * @property {string} [workerDirectory] Where native workers keep their files.
 * @property {'host' | 'split'} [workerMode]
 * @property {any} [transport] The native TCP transport; split mode needs one.
 * @property {any} [publication] Split mode: the sink's worker publication.
 * @property {((options: object) => Promise<any>) | null} [splitWorkerFactory]
 * @property {(event: object) => void} [log]
 * @property {() => boolean} [cancelled]
 * @property {number | null} [mode] A movie::DecoderMode to build with (HBL_DECODER_MODE).
 */

/**
 * The movie calls of one decoder: result-checked wrappers around the module api, media
 * lookups, the host's queue steps and the pump frame.
 * @param {any} api
 * @param {Record<string, number>} fn The movie functions' addresses.
 * @param {any} worker The finite worker that runs pump frames.
 * @param {any} rpc
 * @param {() => boolean} cancelled
 */
function movieCalls(api, fn, worker, rpc, cancelled) {
  /** @param {keyof typeof MEMORY} field */
  const pointer = field => api.base + MEMORY[field];
  /** @type {Map<number, {address: number, capacity: number}>} */
  const inputs = new Map();
  /** The raw result of a caller's SDK call run just before SendInput, such as a tick. */
  let lastStamp = null;

  /**
   * @param {string} name
   * @param {any[]} args
   */
  async function call(name, args) {
    const value = await api.call(name, args);
    return result(value);
  }

  /**
   * @param {string} name
   * @param {any[]} args
   */
  async function success(name, args) {
    const value = await call(name, args);
    if (value !== 0) throw resultError('movie::' + name, value);
  }

  /**
   * Looks up an integer of a media object by key.
   * @param {number} object
   * @param {string} name
   * @param {boolean} [required]
   * @returns {Promise<number | null>}
   */
  async function integer(object, name, required = false) {
    await api.write(MEMORY.key, Buffer.from(name + '\0'));
    await api.write(MEMORY.value, Buffer.alloc(WORD_BYTES));
    const found = await call('mediaFindInt', [object, pointer('key'), pointer('value')]);
    if (!found) {
      if (required) throw Error('Decoder format is missing ' + name);
      return null;
    }
    return (await api.read(MEMORY.value, WORD_BYTES)).readInt32LE();
  }

  /**
   * Polls a free input slot (nonblocking on the console) and primes the control slot the
   * worker's SendInput reads. Used once to fill the pipeline and again whenever the previous
   * frame's tail acquire came back empty.
   */
  async function acquireInput() {
    const until = Date.now() + QUEUE_TIMEOUT_MS;
    while (Date.now() < until && !cancelled()) {
      const reply = await api.callOut(
        'acquireInput',
        [pointer('decoder'), rpc.output, rpc.output + WORD_BYTES],
        ACQUIRE_INPUT_REPLY_BYTES
      );
      const value = result(reply.result);
      const index = reply.output.readInt32LE(0);
      if (queueFailed(value, index)) throw resultError('Decoder input queue', value);
      if (index >= 0) {
        await api.write(MEMORY.inputIndex, int32(index));
        return index;
      }
      await sleep(QUEUE_POLL_MS);
    }
    if (cancelled()) throw Error('Native decoding cancelled');
    throw Error('Decoder input queue timed out');
  }

  /**
   * Looks up the data address and capacity of input buffer `index` once.
   * @param {number} index
   */
  async function cacheInput(index) {
    if (inputs.has(index)) return;
    await success('getInput', [pointer('decoder'), index, pointer('input')]);
    const address = Number(await api.call('bufferData', [pointer('input')]));
    const capacity = Number(await api.call('bufferCapacity', [pointer('input')]));
    inputs.set(index, {address, capacity});
  }

  /** The AcquireOutput call, with its out-parameters in the control slots. */
  const acquireOutputCall = () => ({
    function: fn.acquireOutput,
    args: [
      pointer('decoder'),
      pointer('outputIndex'),
      pointer('timestamp'),
      pointer('flags'),
      pointer('outputCount')
    ]
  });

  /**
   * One finite worker frame: SendInput (reading the primed index slot), then AcquireOutput,
   * then AcquireInput for the next frame. Without the output step, the next receive()
   * acquires the output itself. A `stamp` function runs first and its result is kept in
   * lastStamp.
   * @param {number} length
   * @param {number} pts
   * @param {boolean} withOutput
   * @param {number | null} stamp
   */
  async function pump(length, pts, withOutput, stamp) {
    const send = {
      function: fn.sendInput,
      args: [pointer('decoder'), {u32: pointer('inputIndex')}, 0, length, BigInt(pts), 0]
    };
    const output = acquireOutputCall();
    const input = {
      function: fn.acquireInput,
      args: [pointer('decoder'), pointer('inputIndex'), pointer('inputCount')]
    };
    const calls = withOutput ? [send, output, input] : [send, input];
    const frame = stamp ? [{function: stamp, args: []}, ...calls] : calls;

    const results = await worker.run(frame);
    lastStamp = stamp ? results.shift() : null;
    const control = await api.read(MEMORY.inputIndex, PUMP_CONTROL_BYTES);
    return {statuses: results.map(result), control};
  }

  /** Acquires one output on its own, for receive() calls without a submitted output. */
  async function acquireOutput() {
    const [status] = (await worker.run([acquireOutputCall()])).map(result);
    const control = await api.read(MEMORY.outputIndex, OUTPUT_CONTROL_BYTES);
    return outputAt(control, MEMORY.outputIndex, status);
  }

  /** GetOutputSize: the output size and the alignment a destination must meet. */
  async function measureOutput() {
    await success('getOutputSize', [
      pointer('decoder'),
      pointer('outputSize'),
      pointer('alignment')
    ]);
    const value = await api.read(MEMORY.outputSize, SIZING_BYTES);
    return {
      bytes: value.readUInt32LE(),
      alignment: value.readUInt32LE(MEMORY.alignment - MEMORY.outputSize)
    };
  }

  /**
   * The output layout of the format, falling back on the configured dimensions.
   * @param {{width: number, height: number}} dimensions
   * @returns {Promise<Layout>}
   */
  async function readLayout(dimensions) {
    const width = (await integer(pointer('format'), 'width')) ?? dimensions.width;
    const height = (await integer(pointer('format'), 'height')) ?? dimensions.height;
    const stride = (await integer(pointer('format'), 'stride')) ?? width;
    const sliceHeight = (await integer(pointer('format'), 'slice-height')) ?? height;
    return {width, height, stride, sliceHeight};
  }

  return {
    pointer,
    call,
    success,
    integer,
    acquireInput,
    cacheInput,
    /** @param {number} index */
    input: index => inputs.get(index),
    pump,
    acquireOutput,
    measureOutput,
    readLayout,
    get lastStamp() {
      return lastStamp;
    }
  };
}

/**
 * Builds the decoder, then the media objects, then the buffers, recording each in `owned`
 * as it exists so close() destroys exactly those.
 * @param {any} api
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
 * The decoder object create() returns, with its run state.
 * @param {object} context
 * @param {any} context.api
 * @param {Record<string, number>} context.fn
 * @param {Awaited<ReturnType<typeof createFinite>>} context.worker The pump frames' worker.
 * @param {ReturnType<typeof movieCalls>} context.movie
 * @param {[string, number][]} context.owned What construct() built, in construction order.
 * @param {any} context.movieModule
 * @param {any} context.rpc
 * @param {'host' | 'split'} context.workerMode
 * @param {any} context.transport
 * @param {any} context.publication
 * @param {((options: object) => Promise<any>) | null} context.splitWorkerFactory
 * @param {(event: object) => void} context.log
 * @param {() => boolean} context.cancelled
 */
function decoderObject({
  api,
  fn,
  worker,
  movie,
  owned,
  movieModule,
  rpc,
  workerMode,
  transport,
  publication,
  splitWorkerFactory,
  log,
  cancelled
}) {
  const {pointer, call, success, integer} = movie;
  let running = false;
  let configured = false;
  let closed = false;
  /** The output buffer the host holds until it is released, or -1. */
  let outputIndex = -1;
  let dimensions;
  /** @type {Layout | null} */
  let layout = null;
  /** @type {{bytes: number, alignment: number} | null} */
  let sizing = null;
  /** The input index acquired by the previous frame's tail, waiting for the next unit. */
  let pendingInput = null;
  /** The output that submit() acquired, waiting for receive(). */
  let pendingOutput = null;
  /** The decoder step in flight, reported by the live stats when a frame stalls. */
  let step = 'idle';
  /** The last tail AcquireInput, for probes that watch input readiness. */
  let lastInput = null;
  let split = null;

  async function release() {
    if (outputIndex < 0) return;
    const index = outputIndex;
    outputIndex = -1;
    await success('releaseOutput', [pointer('decoder'), index]);
  }

  /** Split mode: creates the console workers and registers them, before Start. */
  async function registerSplit() {
    split = await splitWorkerFactory({
      rpc,
      module: movieModule,
      functions: fn,
      decoder: pointer('decoder'),
      output: pointer('output'),
      format: pointer('format'),
      transport,
      publication,
      cancelled
    });
    await split.register();
  }

  /**
   * Stops the workers and the decoder and destroys what create() built, collecting every
   * failure. Workers are finalized only after a clean shutdown (Invariant 7).
   */
  async function close() {
    if (closed) return;
    if (split) await split.stop();
    closed = true;

    const errors = [];
    try {
      await release();
    } catch (error) {
      errors.push(error);
    }
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
    if (transport) {
      try {
        await transport.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (!errors.length && split) {
      try {
        await split.finalize();
      } catch (error) {
        errors.push(error);
      }
    }
    // Freed last, and only after a clean shutdown: the movie objects live in module memory.
    if (!errors.length) {
      try {
        if (await worker.close()) await api.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Movie decoder cleanup failed');
  }

  return {
    get step() {
      return step;
    },

    /**
     * Configures the decoder from bare SPS and PPS NALs, creates the split mode's console
     * workers, and starts decoding.
     * @param {Buffer} sps
     * @param {Buffer} pps
     * @param {number} [fps]
     * @param {{beforeStart?: (decoder: number) => Promise<void> | void}} [options]
     *   `beforeStart` runs between Configure and Start, where RegisterClientEvents belongs.
     * @returns {Promise<{width: number, height: number}>}
     */
    async configure(sps, pps, fps = DEFAULT_FPS, {beforeStart} = {}) {
      if (configured || closed) throw Error('Decoder configuration is not available');
      if (invalidParameterSets(sps, pps)) throw Error('Expected bounded bare SPS and PPS NALs');
      if (invalidFrameRate(fps)) throw Error('Invalid decoder frame rate');

      await api.write(MEMORY.sps, sps);
      await api.write(MEMORY.pps, pps);
      const made = await call('createH264Configuration', [
        pointer('sps'),
        sps.length,
        pointer('pps'),
        pps.length,
        pointer('configuration')
      ]);
      if (made !== CONFIGURATION_CREATED)
        throw Error('The native H.264 configuration helper rejected SPS/PPS');

      const width = await integer(pointer('configuration'), 'width', true);
      const height = await integer(pointer('configuration'), 'height', true);
      if (outsideSurface(width, height) || width % 2 || height % 2)
        throw Error('Decoded dimensions exceed the Moonlight surface');

      await api.write(MEMORY.key, Buffer.from('frame-rate\0'));
      await api.call('mediaSetInt', [pointer('configuration'), pointer('key'), fps]);
      await success('configure', [pointer('decoder'), pointer('configuration')]);
      if (workerMode === 'split') await registerSplit();
      await beforeStart?.(pointer('decoder'));
      await success('start', [pointer('decoder')]);

      configured = true;
      running = true;
      dimensions = {width, height};
      log({event: 'native-decoder', ...dimensions, format: OUTPUT_FORMAT});
      return dimensions;
    },

    get lastInput() {
      return lastInput;
    },

    get lastStamp() {
      return movie.lastStamp;
    },

    /**
     * Host mode: writes `unit` into its input buffer and runs one pump frame.
     * @param {AccessUnit} unit
     * @param {{acquireOutput?: boolean, stamp?: number | null}} [options] `stamp` is an SDK
     *   function run just before SendInput.
     */
    async submit(unit, {acquireOutput: withOutput = true, stamp = null} = {}) {
      if (!running || closed) throw Error('Decoder is not running');
      if (invalidUnit(unit)) throw Error('Invalid decoder access unit');

      step = 'acquireInput';
      if (pendingInput === null) pendingInput = await movie.acquireInput();
      const index = pendingInput;
      step = 'cacheInput';
      await movie.cacheInput(index);
      const {address, capacity} = movie.input(index);
      const validAddress = Number.isSafeInteger(address) && address > 0;
      if (!validAddress || unit.data.length > capacity)
        throw Error('H.264 access unit exceeds the native input buffer');

      step = 'writeUnit';
      await rpc.write(address, unit.data);

      step = 'pump';
      const {statuses, control} = await movie.pump(unit.data.length, unit.pts, withOutput, stamp);
      step = 'idle';
      if (statuses[0] !== 0) throw resultError('movie::sendInput', statuses[0]);

      const nextIndex = control.readInt32LE(0);
      const inputStatus = statuses.at(-1);
      lastInput = {status: inputStatus, index: nextIndex};
      if (queueFailed(inputStatus, nextIndex))
        throw resultError('Decoder input queue', inputStatus);

      pendingInput = nextIndex >= 0 ? nextIndex : null;
      if (withOutput) pendingOutput = outputAt(control, MEMORY.inputIndex, statuses[1]);
    },

    /**
     * Host mode: fetches the next decoded frame into `destination` and releases the output
     * buffer again. Null when no frame is ready.
     * @param {OutputDestination} destination
     */
    async receive(destination) {
      if (!running || closed) throw Error('Decoder is not running');
      if (outputIndex >= 0) throw Error('A decoder output buffer is still owned');

      step = 'acquireOutput';
      const out = pendingOutput ?? (await movie.acquireOutput());
      pendingOutput = null;
      step = 'idle';
      outputIndex = out.index;
      if (outputIndex < 0 && out.status === OUTPUT_NOT_READY) return null;
      if (out.status !== 0) throw resultError('Decoder output queue', out.status);
      if (outputIndex < 0) return null;

      const timestamp = out.pts;
      try {
        step = 'getOutputSize';
        if (!sizing) sizing = await movie.measureOutput();
        const {bytes} = sizing;
        if (unfitDestination(destination, sizing))
          throw Error('Native output does not fit the aligned destination surface');

        step = 'getOutput';
        const paired = await rpc.pair([
          {
            address: fn.bufferSetData,
            args: [pointer('output'), destination.address, destination.bytes, 0]
          },
          {
            address: fn.getOutput,
            args: [pointer('decoder'), outputIndex, pointer('output'), pointer('format')]
          }
        ]);
        const got = result(paired.results[1]);
        if (got !== 0) throw resultError('movie::getOutput', got);

        step = 'outputFormat';
        if (!layout) layout = await movie.readLayout(dimensions);
        if (unsupportedLayout(layout, bytes, destination.bytes))
          throw Error('Unsupported native NV12 output layout');

        const {width, height, stride, sliceHeight} = layout;
        return {
          width,
          height,
          stride,
          sliceHeight,
          bytes,
          pts: timestamp.toString(),
          format: OUTPUT_FORMAT
        };
      } finally {
        step = 'releaseOutput';
        await release();
        step = 'idle';
      }
    },

    close
  };
}

/**
 * Builds a movie decoder in module memory. configure() starts it.
 * @param {DecoderOptions} options
 */
async function create({
  rpc,
  directory,
  workerDirectory,
  workerMode = 'host',
  transport = null,
  publication = null,
  splitWorkerFactory = null,
  log = () => {},
  cancelled = () => false,
  mode = modeFromEnv(process.env)
}) {
  if (!WORKER_MODES.includes(workerMode)) throw Error('Unknown decoder worker mode');
  if (workerMode === 'split' && (!transport || !splitWorkerFactory))
    throw Error('Split decoder needs a TCP transport and a worker factory');

  const used = definitionsFor(mode);
  const movieModule = await loadMovieModule(directory, used);
  workerDirectory ||= defaultWorkerDirectory();
  const api = await createModule(rpc, {
    base: movieModule.base,
    definitions: used,
    directory: workerDirectory
  });
  const fn = api.functions;
  // Movie functions sit outside the SDK range, so they are the frame's verified targets,
  // and the frame carries five- and six-argument calls.
  const worker = await createFinite(rpc, {
    verified: new Set(Object.values(fn)),
    wide: true
  });

  const movie = movieCalls(api, fn, worker, rpc, cancelled);
  /** @type {[string, number][]} */
  const owned = [];
  const decoder = decoderObject({
    api,
    fn,
    worker,
    movie,
    owned,
    movieModule,
    rpc,
    workerMode,
    transport,
    publication,
    splitWorkerFactory,
    log,
    cancelled
  });
  try {
    await construct(api, movie.pointer, owned, mode);
  } catch (error) {
    try {
      await decoder.close();
    } catch (cleanup) {
      error.cleanup = cleanup;
    }
    throw error;
  }
  return decoder;
}

export {create, modeFromEnv};
