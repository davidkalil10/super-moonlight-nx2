// Publishes decoder-written NV12 surfaces to the Moonlight compute/draw worker.
const ring = require('../../apps/moonlight/ring.cjs');

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
    async destination() {
      await wait();
      const target = index ^ 1;
      const address = storage.mapped + ring.frameOffset(target);
      const region = await rpc.query(address);
      if (
        (region.permissions & 3) !== 3 ||
        region.ipcReferences ||
        address + ring.FRAME_BYTES > region.address + region.size
      )
        throw Error('The native frame destination is not writable mapped memory');
      return {index: target, address, bytes: ring.FRAME_BYTES};
    },
    async publish(destination, frame) {
      if (pending || ![0, 1].includes(destination.index))
        throw Error('Native frame publication is out of order');
      if (frame.format !== 'nv12' || (frame.stride * frame.sliceHeight * 3) / 2 > ring.FRAME_BYTES)
        throw Error('The native frame exceeds the Moonlight surface');
      const metadata = Buffer.alloc(24);
      [
        destination.index,
        frame.width,
        frame.height,
        frame.stride,
        frame.sliceHeight,
        color
      ].forEach((value, word) => metadata.writeUInt32LE(value, word * 4));
      await rpc.write(storage.mapped + ring.CONTROL.nativeIndex, metadata);
      sequence = (sequence + 1) >>> 0 || 1;
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
