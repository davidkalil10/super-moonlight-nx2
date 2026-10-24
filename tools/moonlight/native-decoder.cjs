// Host-controlled H.264 decoding through the inspected nnCompat movie::Decoder ABI.
const fs = require('node:fs/promises');
const path = require('node:path');
const definitions = require('../../sdk/native/movie-functions.json');
const {create: createModule} = require('../../sdk/native/module.cjs');

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
const result = value => Number(BigInt.asUintN(32, value));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function create({rpc, directory, workerDirectory, log = () => {}, cancelled = () => false}) {
  const module = JSON.parse(await fs.readFile(path.join(directory, 'compatibility-module.json')));
  for (const definition of Object.values(definitions)) {
    if (
      !module.symbols.some(
        symbol =>
          symbol.name === definition.symbol &&
          symbol.section &&
          symbol.offset === definition.offset &&
          symbol.size === definition.size
      )
    )
      throw Error('The loaded movie module differs from the inspected build');
  }
  workerDirectory ||= path.join(
    '/media/storage2/builds/HBLauncher/native-h264',
    new Date().toISOString().replace(/[:.]/g, '-')
  );
  const api = await createModule(rpc, {base: module.base, definitions, directory: workerDirectory});
  const pointer = field => api.base + MEMORY[field];
  const owned = [];
  let running = false;
  let configured = false;
  let closed = false;
  let outputIndex = -1;
  let dimensions;
  let layout = null;
  let sizing = null;
  const inputs = new Map();

  async function call(name, args) {
    const value = await api.call(name, args);
    return result(value);
  }

  async function success(name, args) {
    const value = await call(name, args);
    if (value !== 0) {
      const error = Error('movie::' + name + ' returned 0x' + value.toString(16));
      error.result = value;
      throw error;
    }
  }

  async function integer(object, name, required = false) {
    await api.write(MEMORY.key, Buffer.from(name + '\0'));
    await api.write(MEMORY.value, Buffer.alloc(4));
    const found = await call('mediaFindInt', [object, pointer('key'), pointer('value')]);
    if (!found) {
      if (required) throw Error('Decoder format is missing ' + name);
      return null;
    }
    return (await api.read(MEMORY.value, 4)).readInt32LE();
  }

  async function release() {
    if (outputIndex < 0) return;
    const index = outputIndex;
    outputIndex = -1;
    await success('releaseOutput', [pointer('decoder'), index]);
  }

  async function close() {
    if (closed) return;
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
    if (errors.length) throw new AggregateError(errors, 'Movie decoder cleanup failed');
  }

  try {
    await api.call('decoderCreate', [pointer('decoder'), 1, 4]);
    owned.push(['decoderDestroy', pointer('decoder')]);
    if (!(await api.read(MEMORY.decoder + 8, 8)).readBigUInt64LE())
      throw Error('The movie decoder did not initialize');
    for (const field of ['configuration', 'format']) {
      await api.call('mediaCreate', [pointer(field)]);
      owned.push(['mediaDestroy', pointer(field)]);
      if (!(await api.read(MEMORY[field], 8)).readBigUInt64LE())
        throw Error('Movie metadata allocation failed');
    }
    for (const field of ['input', 'output']) {
      await api.call('bufferCreate', [pointer(field)]);
      owned.push(['bufferDestroy', pointer(field)]);
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      error.cleanup = cleanup;
    }
    throw error;
  }

  return {
    async configure(sps, pps, fps = 60) {
      if (configured || closed) throw Error('Decoder configuration is not available');
      if (
        !Buffer.isBuffer(sps) ||
        !Buffer.isBuffer(pps) ||
        sps.length < 4 ||
        !pps.length ||
        sps.length > 4096 ||
        pps.length > 4096 ||
        (sps[0] & 31) !== 7 ||
        (pps[0] & 31) !== 8
      )
        throw Error('Expected bounded bare SPS and PPS NALs');
      if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw Error('Invalid decoder frame rate');
      await api.write(MEMORY.sps, sps);
      await api.write(MEMORY.pps, pps);
      const made = await call('createH264Configuration', [
        pointer('sps'),
        sps.length,
        pointer('pps'),
        pps.length,
        pointer('configuration')
      ]);
      if (made !== 1) throw Error('The native H.264 configuration helper rejected SPS/PPS');
      const width = await integer(pointer('configuration'), 'width', true);
      const height = await integer(pointer('configuration'), 'height', true);
      if (width < 2 || height < 2 || width > 1920 || height > 1088 || width % 2 || height % 2)
        throw Error('Decoded dimensions exceed the Moonlight surface');
      await api.write(MEMORY.key, Buffer.from('frame-rate\0'));
      await api.call('mediaSetInt', [pointer('configuration'), pointer('key'), fps]);
      await success('configure', [pointer('decoder'), pointer('configuration')]);
      await success('start', [pointer('decoder')]);
      configured = running = true;
      dimensions = {width, height};
      log({event: 'native-decoder', ...dimensions, format: 'nv12'});
      return dimensions;
    },

    async submit(unit) {
      if (!running || closed) throw Error('Decoder is not running');
      if (
        !Buffer.isBuffer(unit.data) ||
        !unit.data.length ||
        !Number.isSafeInteger(unit.pts) ||
        unit.pts < 0
      )
        throw Error('Invalid decoder access unit');
      const until = Date.now() + 5000;
      let index = -1;
      while (Date.now() < until && !cancelled()) {
        const reply = await api.callOut(
          'acquireInput',
          [pointer('decoder'), rpc.output, rpc.output + 4],
          8
        );
        const value = result(reply.result);
        index = reply.output.readInt32LE(0);
        if (value !== 0 && !(index < 0 && [0x100e, 0x1011].includes(value)))
          throw Object.assign(Error('Decoder input queue returned 0x' + value.toString(16)), {
            result: value
          });
        if (index >= 0) break;
        await sleep(5);
      }
      if (cancelled()) throw Error('Native decoding cancelled');
      if (index < 0) throw Error('Decoder input queue timed out');
      if (!inputs.has(index)) {
        await success('getInput', [pointer('decoder'), index, pointer('input')]);
        const address = Number(await api.call('bufferData', [pointer('input')]));
        const capacity = Number(await api.call('bufferCapacity', [pointer('input')]));
        inputs.set(index, {address, capacity});
      }
      const {address, capacity} = inputs.get(index);
      if (!Number.isSafeInteger(address) || address <= 0 || unit.data.length > capacity)
        throw Error('H.264 access unit exceeds the native input buffer');
      await rpc.write(address, unit.data);
      await success('sendInput', [
        pointer('decoder'),
        index,
        0,
        unit.data.length,
        BigInt(unit.pts),
        0
      ]);
    },

    async receive(destination) {
      if (!running || closed) throw Error('Decoder is not running');
      if (outputIndex >= 0) throw Error('A decoder output buffer is still owned');
      const value = await call('acquireOutput', [
        pointer('decoder'),
        pointer('outputIndex'),
        pointer('timestamp'),
        pointer('flags'),
        pointer('outputCount')
      ]);
      const metadata = await api.read(MEMORY.outputIndex, 24);
      outputIndex = metadata.readInt32LE();
      if (outputIndex < 0 && value === 0x100e) return null;
      if (value !== 0)
        throw Object.assign(Error('Decoder output queue returned 0x' + value.toString(16)), {
          result: value
        });
      if (outputIndex < 0) return null;
      try {
        if (!sizing) {
          await success('getOutputSize', [
            pointer('decoder'),
            pointer('outputSize'),
            pointer('alignment')
          ]);
          const value = await api.read(MEMORY.outputSize, 8);
          sizing = {bytes: value.readUInt32LE(), alignment: value.readUInt32LE(4)};
        }
        const {bytes, alignment} = sizing;
        if (
          !Number.isSafeInteger(destination.address) ||
          !Number.isSafeInteger(destination.bytes) ||
          destination.bytes < bytes ||
          !alignment ||
          destination.address % alignment
        )
          throw Error('Native output does not fit the aligned destination surface');
        await api.call('bufferSetData', [
          pointer('output'),
          destination.address,
          destination.bytes
        ]);
        await success('getOutput', [
          pointer('decoder'),
          outputIndex,
          pointer('output'),
          pointer('format')
        ]);
        if (!layout) {
          const width = (await integer(pointer('format'), 'width')) ?? dimensions.width;
          const height = (await integer(pointer('format'), 'height')) ?? dimensions.height;
          const stride = (await integer(pointer('format'), 'stride')) ?? width;
          const sliceHeight = (await integer(pointer('format'), 'slice-height')) ?? height;
          layout = {width, height, stride, sliceHeight};
        }
        const {width, height, stride, sliceHeight} = layout;
        if (
          width < 2 ||
          height < 2 ||
          width > 1920 ||
          height > 1088 ||
          stride < width ||
          sliceHeight < height ||
          stride % 2 ||
          sliceHeight % 2 ||
          (stride * sliceHeight * 3) / 2 > destination.bytes ||
          bytes < (stride * sliceHeight * 3) / 2
        )
          throw Error('Unsupported native NV12 output layout');
        const timestamp = metadata.readBigUInt64LE(8);
        return {
          width,
          height,
          stride,
          sliceHeight,
          bytes,
          pts: timestamp.toString(),
          format: 'nv12'
        };
      } finally {
        await release();
      }
    },

    close
  };
}

module.exports = {create};
