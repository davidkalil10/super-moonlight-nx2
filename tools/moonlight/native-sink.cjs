// Publishes decoder-written NV12 surfaces to the Moonlight compute/draw worker.
const ring = require('./ring.cjs');

async function create(rpc, storage, {cancelled = () => false, color = 1} = {}) {
  if (storage.bytes < ring.MEMORY_BYTES || !(storage.memoryFlags & 4))
    throw Error('Native video requires the current coherent Moonlight allocation');
  if (![1, 2].includes(color)) throw Error('Unsupported native video color space');
  const ready = await rpc.read(storage.mapped + ring.CONTROL.nativeReady, 12);
  if (ready.readUInt32LE() !== ring.NATIVE_ABI)
    throw Error('Relaunch Moonlight after rebuilding its native-video shaders');
  let sequence = ready.readUInt32LE(8);
  let pending = 0;
  let index = (await rpc.read(storage.mapped + ring.CONTROL.current, 4)).readUInt32LE();
  const verified = new Map();
  const reserved = new Map();
  let workerStarted = false;

  const reached = (applied, submitted) => ((applied - submitted) >>> 0) < 0x80000000;
  const currentState = async () => {
    const state = await rpc.read(storage.mapped + ring.CONTROL.current, 24);
    return {current: state.readUInt32LE(0), applied: state.readUInt32LE(20)};
  };

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

  async function writable(target, cacheMs) {
    const address = storage.mapped + ring.frameOffset(target);
    if (!(verified.get(target) > Date.now())) {
      const region = await rpc.query(address);
      if (
        (region.permissions & 3) !== 3 ||
        region.ipcReferences ||
        address + ring.FRAME_BYTES > region.address + region.size
      )
        throw Error('The native frame destination is not writable mapped memory');
      verified.set(target, cacheMs === Infinity ? Infinity : Date.now() + cacheMs);
    }
    return {index: target, address, bytes: ring.FRAME_BYTES};
  }

  async function wait() {
    if (!pending) return;
    const until = Date.now() + 5000;
    while (Date.now() < until && !cancelled()) {
      const applied = (
        await rpc.read(storage.mapped + ring.CONTROL.nativeApplied, 4)
      ).readUInt32LE();
      if (applied === pending) {
        pending = 0;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const control = await rpc.read(storage.mapped, 320);
    const state = Object.fromEntries(
      Object.entries(ring.CONTROL)
        .filter(([, offset]) => offset < control.length)
        .map(([name, offset]) => [name, control.readUInt32LE(offset)])
    );
    const error = Error(
      cancelled() ? 'Native presentation cancelled' : 'Moonlight native presentation timed out'
    );
    error.pending = pending;
    error.control = state;
    throw error;
  }

  return {
    workerPublication: {mapped: storage.mapped, color},
    async destination() {
      await wait();
      return writable(index === 0 ? 1 : 0, 1000);
    },
    async workerDestination(presentation) {
      if (!workerStarted) {
        await wait();
        presentation = await currentState();
        workerStarted = true;
      }
      if (!presentation) presentation = await currentState();
      const until = Date.now() + 5000;
      let target;
      while (!cancelled() && Date.now() < until) {
        target = availableSurface(presentation);
        if (target !== null) break;
        await new Promise(resolve => setTimeout(resolve, 5));
        presentation = await currentState();
      }
      if (target === null || cancelled())
        throw Error('No free native presentation surface');
      const destination = await writable(target, Infinity);
      sequence = (sequence + 1) >>> 0 || 1;
      reserved.set(sequence, target);
      index = target;
      return {...destination, sequence, color};
    },
    async discardDestination(presentation) {
      if (!workerStarted) throw Error('No worker publication to skip behind');
      const target = availableSurface(presentation);
      if (target === null) return null;
      return {...(await writable(target, Infinity)), color, skip: true};
    },
    async publish(destination, frame) {
      if (pending || ![0, 1].includes(destination.index))
        throw Error('Native frame publication is out of order');
      if (frame.format !== 'nv12' || (frame.stride * frame.sliceHeight * 3) / 2 > ring.FRAME_BYTES)
        throw Error('The native frame exceeds the Moonlight surface');
      const metadata = Buffer.alloc(28);
      [
        destination.index,
        frame.width,
        frame.height,
        frame.stride,
        frame.sliceHeight,
        color
      ].forEach((value, word) => metadata.writeUInt32LE(value, word * 4));
      sequence = (sequence + 1) >>> 0 || 1;
      metadata.writeUInt32LE(
        ring.nativeChecksum(sequence, [
          destination.index,
          frame.width,
          frame.height,
          frame.stride,
          frame.sliceHeight,
          color
        ]),
        24
      );
      await rpc.write(storage.mapped + ring.CONTROL.nativeIndex, metadata);
      const commit = Buffer.alloc(4);
      commit.writeUInt32LE(sequence);
      await rpc.write(storage.mapped + ring.CONTROL.nativeSequence, commit);
      index = destination.index;
      pending = sequence;
    },
    wait,
    async close() {
      await rpc.write(storage.mapped + ring.CONTROL.nativeSequence, Buffer.alloc(4));
    }
  };
}

module.exports = {create};
