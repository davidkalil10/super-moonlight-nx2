/**
 * Publishes decoder-written NV12 surfaces to the Moonlight compute/draw worker.
 *
 * The decoder writes each frame straight into one of the ring's native surfaces, and the
 * sink tells the shader which surface to show by writing the publication metadata and then
 * its sequence into the control page. Two modes share that control page:
 *
 * - host publication: destination() alternates surfaces 0 and 1, publish() writes the
 *   metadata and wait() polls until the shader applied it;
 * - worker publication: a console worker publishes on its own. workerDestination() reserves
 *   a free surface for each sequence and keeps reserving until the shader has applied it,
 *   so the decoder never writes the surface on screen or one still queued for display.
 *
 * Destinations are checked to be writable mapped memory before the decoder may write them.
 */
import * as ring from '../../tools/moonlight/ring.js';

/** The storage memory flag of a coherent allocation. */
const COHERENT_MEMORY = 4;
const COLORS = [1, 2];
/** Host publication only alternates between the first two surfaces. */
const HOST_SURFACES = [0, 1];
const WORD_BYTES = 4;
const READ_WRITE = 3;

/** nativeReady through nativeApplied, read once to check the shader ABI and seed the sequence. */
const READY_BYTES = ring.CONTROL.nativeApplied + WORD_BYTES - ring.CONTROL.nativeReady;
const READY_SEQUENCE_OFFSET = ring.CONTROL.nativeApplied - ring.CONTROL.nativeReady;
/** current through nativeApplied, the presentation state of worker publication. */
const STATE_BYTES = ring.CONTROL.nativeApplied + WORD_BYTES - ring.CONTROL.current;
const STATE_APPLIED_OFFSET = ring.CONTROL.nativeApplied - ring.CONTROL.current;
/** How much of the control page a timeout reports. */
const CONTROL_DUMP_BYTES = 320;

/** Six metadata words from nativeIndex, then their checksum. */
const METADATA_BYTES = 28;
const METADATA_CHECKSUM_OFFSET = 24;

const TIMEOUT_MS = 5000;
const POLL_MS = 5;
/** How long a host destination stays verified before it is queried again. */
const HOST_VERIFY_MS = 1000;
/** Serial distance below which a sequence counts as already applied. */
const HALF_SEQUENCE_RANGE = 0x80000000;

/**
 * The next nonzero 32-bit publication sequence.
 * @param {number} sequence
 */
const nextSequence = sequence => (sequence + 1) >>> 0 || 1;

/**
 * Whether the shader's applied sequence has reached `submitted`, in serial arithmetic.
 * @param {number} applied
 * @param {number} submitted
 */
const reached = (applied, submitted) => (applied - submitted) >>> 0 < HALF_SEQUENCE_RANGE;

const sleep = () => new Promise(resolve => setTimeout(resolve, POLL_MS));

/**
 * @typedef {object} Storage
 * @property {number} mapped Host-visible address of the Moonlight storage.
 * @property {number} bytes
 * @property {number} memoryFlags
 */

/**
 * @typedef {object} Presentation The worker publication state the shader reports.
 * @property {number} current The surface on screen.
 * @property {number} applied The last applied sequence.
 */

/**
 * @typedef {object} Destination
 * @property {number} index The surface.
 * @property {number} address
 * @property {number} bytes
 */

/**
 * @param {any} rpc
 * @param {Storage} storage
 * @param {{cancelled?: () => boolean, color?: number}} [options] `color` is the native video
 *   color space, 1 or 2.
 */
async function create(rpc, storage, {cancelled = () => false, color = 1} = {}) {
  if (storage.bytes < ring.MEMORY_BYTES || !(storage.memoryFlags & COHERENT_MEMORY))
    throw Error('Native video requires the current coherent Moonlight allocation');
  if (!COLORS.includes(color)) throw Error('Unsupported native video color space');
  const ready = await rpc.read(storage.mapped + ring.CONTROL.nativeReady, READY_BYTES);
  if (ready.readUInt32LE() !== ring.NATIVE_ABI)
    throw Error('Relaunch Moonlight after rebuilding its native-video shaders');
  let sequence = ready.readUInt32LE(READY_SEQUENCE_OFFSET);
  let pending = 0;
  let index = (await rpc.read(storage.mapped + ring.CONTROL.current, WORD_BYTES)).readUInt32LE();
  /** @type {Map<number, number>} Surface to the time its writability check expires. */
  const verified = new Map();
  /** @type {Map<number, number>} Sequence to the surface reserved for it. */
  const reserved = new Map();
  let workerStarted = false;

  /** @returns {Promise<Presentation>} */
  const currentState = async () => {
    const state = await rpc.read(storage.mapped + ring.CONTROL.current, STATE_BYTES);
    return {current: state.readUInt32LE(0), applied: state.readUInt32LE(STATE_APPLIED_OFFSET)};
  };

  /**
   * The next surface after `index` that is neither on screen nor reserved for a sequence the
   * shader has not applied yet; null while the shader is still switching surfaces.
   * @param {Presentation} state
   * @returns {number | null}
   */
  function availableSurface(state) {
    if (
      !state ||
      !Number.isInteger(state.current) ||
      !Number.isInteger(state.applied) ||
      state.current >= ring.NATIVE_FRAMES ||
      state.current < 0
    )
      throw Error('Invalid native presentation state');
    const appliedIndex = reserved.get(state.applied);
    if (appliedIndex !== undefined && appliedIndex !== state.current) return null;
    for (const submitted of reserved.keys())
      if (reached(state.applied, submitted)) reserved.delete(submitted);
    const blocked = new Set([state.current, ...reserved.values()]);
    for (let offset = 1; offset <= ring.NATIVE_FRAMES; offset++) {
      const target = (index + offset) % ring.NATIVE_FRAMES;
      if (!blocked.has(target)) return target;
    }
    return null;
  }

  /**
   * Checks that surface `target` is writable mapped memory, at most once per `cacheMs`.
   * @param {number} target
   * @param {number} cacheMs
   * @returns {Promise<Destination>}
   */
  async function writable(target, cacheMs) {
    const address = storage.mapped + ring.frameOffset(target);
    if (!(verified.get(target) > Date.now())) {
      const region = await rpc.query(address);
      if (
        (region.permissions & READ_WRITE) !== READ_WRITE ||
        region.ipcReferences ||
        address + ring.FRAME_BYTES > region.address + region.size
      )
        throw Error('The native frame destination is not writable mapped memory');
      verified.set(target, cacheMs === Infinity ? Infinity : Date.now() + cacheMs);
    }
    return {index: target, address, bytes: ring.FRAME_BYTES};
  }

  /** The control words named by ring.CONTROL, for timeout reports. */
  async function controlSnapshot() {
    const control = await rpc.read(storage.mapped, CONTROL_DUMP_BYTES);
    return Object.fromEntries(
      Object.entries(ring.CONTROL)
        .filter(([, offset]) => offset < control.length)
        .map(([name, offset]) => [name, control.readUInt32LE(offset)])
    );
  }

  /** Waits until the shader applied the pending host publication. */
  async function wait() {
    if (!pending) return;
    const until = Date.now() + TIMEOUT_MS;
    while (Date.now() < until && !cancelled()) {
      const applied = (
        await rpc.read(storage.mapped + ring.CONTROL.nativeApplied, WORD_BYTES)
      ).readUInt32LE();
      if (applied === pending) {
        pending = 0;
        return;
      }
      await sleep();
    }
    const control = await controlSnapshot();
    throw Object.assign(
      Error(
        cancelled() ? 'Native presentation cancelled' : 'Moonlight native presentation timed out'
      ),
      {pending, control}
    );
  }

  return {
    workerPublication: {mapped: storage.mapped, color},

    /** The host surface that is not on screen, once the last publication was applied. */
    async destination() {
      await wait();
      return writable(index === 0 ? 1 : 0, HOST_VERIFY_MS);
    },

    /**
     * Reserves a free surface for the worker's next sequence.
     * @param {Presentation} [presentation] The state the worker last saw, if any.
     */
    async workerDestination(presentation) {
      if (!workerStarted) {
        await wait();
        presentation = await currentState();
        workerStarted = true;
      }
      if (!presentation) presentation = await currentState();
      const until = Date.now() + TIMEOUT_MS;
      let target;
      while (!cancelled() && Date.now() < until) {
        target = availableSurface(presentation);
        if (target !== null) break;
        await sleep();
        presentation = await currentState();
      }
      if (target === null || cancelled()) throw Error('No free native presentation surface');
      const destination = await writable(target, Infinity);
      sequence = nextSequence(sequence);
      reserved.set(sequence, target);
      index = target;
      return {...destination, sequence, color};
    },

    /**
     * A free surface to decode a skipped frame into, without reserving a sequence.
     * @param {Presentation} presentation
     */
    async discardDestination(presentation) {
      if (!workerStarted) throw Error('No worker publication to skip behind');
      const target = availableSurface(presentation);
      if (target === null) return null;
      return {...(await writable(target, Infinity)), color, skip: true};
    },

    /**
     * Shows `frame` from host surface `destination`: the metadata first, then the sequence
     * that commits it.
     * @param {Destination} destination
     * @param {{format: string, width: number, height: number, stride: number,
     *   sliceHeight: number}} frame
     */
    async publish(destination, frame) {
      if (pending || !HOST_SURFACES.includes(destination.index))
        throw Error('Native frame publication is out of order');
      if (frame.format !== 'nv12' || (frame.stride * frame.sliceHeight * 3) / 2 > ring.FRAME_BYTES)
        throw Error('The native frame exceeds the Moonlight surface');
      const fields = [
        destination.index,
        frame.width,
        frame.height,
        frame.stride,
        frame.sliceHeight,
        color
      ];
      const metadata = Buffer.alloc(METADATA_BYTES);
      fields.forEach((value, word) => metadata.writeUInt32LE(value, word * WORD_BYTES));
      sequence = nextSequence(sequence);
      metadata.writeUInt32LE(ring.nativeChecksum(sequence, fields), METADATA_CHECKSUM_OFFSET);
      await rpc.write(storage.mapped + ring.CONTROL.nativeIndex, metadata);
      const commit = Buffer.alloc(WORD_BYTES);
      commit.writeUInt32LE(sequence);
      await rpc.write(storage.mapped + ring.CONTROL.nativeSequence, commit);
      index = destination.index;
      pending = sequence;
    },

    wait,

    /**
     * Reads `bytes` of native surface `index` from `offset`, for --surface-check.
     * @param {number} index
     * @param {number} offset
     * @param {number} bytes
     */
    sample(index, offset, bytes) {
      if (
        !(index >= 0 && index < ring.NATIVE_FRAMES) ||
        offset < 0 ||
        offset + bytes > ring.FRAME_BYTES
      )
        throw Error('Native surface sample out of range');
      return rpc.read(storage.mapped + ring.frameOffset(index) + offset, bytes);
    },

    /** Clears the published sequence so the shader stops showing native frames. */
    async close() {
      await rpc.write(storage.mapped + ring.CONTROL.nativeSequence, Buffer.alloc(WORD_BYTES));
    }
  };
}

export {create};
