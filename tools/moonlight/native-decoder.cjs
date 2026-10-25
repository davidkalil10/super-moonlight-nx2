// Host-controlled H.264 decoding through the inspected nnCompat movie::Decoder ABI.
const fs = require('node:fs/promises');
const path = require('node:path');
const definitions = require('../../sdk/native/movie-functions.json');
const {create: createModule} = require('../../sdk/native/module.cjs');
const {create: createFinite} = require('../../sdk/native/finite.cjs');

const int32 = value => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(value);
  return b;
};

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

async function create({
  rpc,
  directory,
  workerDirectory,
  workerMode = 'host',
  persistentWorkerFactory = require('./persistent-decoder-worker.cjs').create,
  log = () => {},
  cancelled = () => false
}) {
  if (!['host', 'persistent'].includes(workerMode)) throw Error('Unknown decoder worker mode');
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
  const fn = api.functions;
  // One finite worker runs the per-frame SendInput/AcquireOutput/AcquireInput
  // chain; movie functions sit outside the SDK range, so they are the frame's
  // verified targets and the chain carries five- and six-argument calls.
  const worker = await createFinite(rpc, {
    verified: new Set(Object.values(fn)),
    wide: true
  });
  const owned = [];
  let running = false;
  let configured = false;
  let closed = false;
  let outputIndex = -1;
  let dimensions;
  let layout = null;
  let sizing = null;
  const inputs = new Map();
  // The pipelined input index acquired by the previous frame's tail, and the
  // output acquired by the current frame, both waiting for the host to use them.
  let pendingInput = null;
  let pendingOutput = null;
  // The decoder step in flight, reported by the live stats when a frame stalls.
  let step = 'idle';
  // The last pump's tail AcquireInput, for probes that watch input readiness.
  let lastInput = null;
  // The raw result of a caller's SDK call run just before SendInput, such as a tick.
  let lastStamp = null;
  let persistent = null;
  let persistentStarted = false;
  let persistentJob = null;

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

  // Poll a free input slot (nonblocking on the console) and prime the control
  // slot the worker's SendInput reads. Used once to fill the pipeline and again
  // whenever the previous frame's tail acquire came back empty.
  async function acquireInput() {
    const until = Date.now() + 5000;
    while (Date.now() < until && !cancelled()) {
      const reply = await api.callOut(
        'acquireInput',
        [pointer('decoder'), rpc.output, rpc.output + 4],
        8
      );
      const value = result(reply.result);
      const index = reply.output.readInt32LE(0);
      if (value !== 0 && !(index < 0 && [0x100e, 0x1011].includes(value)))
        throw Object.assign(Error('Decoder input queue returned 0x' + value.toString(16)), {
          result: value
        });
      if (index >= 0) {
        await api.write(MEMORY.inputIndex, int32(index));
        return index;
      }
      await sleep(5);
    }
    if (cancelled()) throw Error('Native decoding cancelled');
    throw Error('Decoder input queue timed out');
  }

  async function cacheInput(index) {
    if (inputs.has(index)) return;
    await success('getInput', [pointer('decoder'), index, pointer('input')]);
    const address = Number(await api.call('bufferData', [pointer('input')]));
    const capacity = Number(await api.call('bufferCapacity', [pointer('input')]));
    inputs.set(index, {address, capacity});
  }

  // One finite worker frame: SendInput (reads the primed index slot), then
  // AcquireOutput, then AcquireInput for the next frame. Out-parameters land in
  // adjacent control slots so the host reads them all at once. Without the
  // output step, the next receive() acquires the output itself.
  async function pump(length, pts, withOutput, stamp) {
    const send = {
      function: fn.sendInput,
      args: [pointer('decoder'), {u32: pointer('inputIndex')}, 0, length, BigInt(pts), 0]
    };
    const output = {
      function: fn.acquireOutput,
      args: [
        pointer('decoder'),
        pointer('outputIndex'),
        pointer('timestamp'),
        pointer('flags'),
        pointer('outputCount')
      ]
    };
    const input = {
      function: fn.acquireInput,
      args: [pointer('decoder'), pointer('inputIndex'), pointer('inputCount')]
    };
    const calls = withOutput ? [send, output, input] : [send, input];
    const results = await worker.run(stamp ? [{function: stamp, args: []}, ...calls] : calls);
    lastStamp = stamp ? results.shift() : null;
    const control = await api.read(MEMORY.inputIndex, 0x28);
    return {statuses: results.map(result), control};
  }

  async function acquireOutput() {
    const [status] = (
      await worker.run([
        {
          function: fn.acquireOutput,
          args: [
            pointer('decoder'),
            pointer('outputIndex'),
            pointer('timestamp'),
            pointer('flags'),
            pointer('outputCount')
          ]
        }
      ])
    ).map(result);
    const control = await api.read(MEMORY.outputIndex, 24);
    return {
      status,
      index: control.readInt32LE(0),
      pts: control.readBigUInt64LE(8),
      flags: control.readUInt32LE(16)
    };
  }

  async function close() {
    if (closed) return;
    if (persistent) await persistent.stop();
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
    if (!errors.length && persistent) {
      try {
        await persistent.finalize();
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
    get step() {
      return step;
    },

    // beforeStart runs between Configure and Start, where RegisterClientEvents belongs.
    async configure(sps, pps, fps = 60, {beforeStart} = {}) {
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
      if (workerMode === 'persistent') {
        persistent = await persistentWorkerFactory({
          rpc,
          module,
          functions: fn,
          decoder: pointer('decoder'),
          output: pointer('output'),
          format: pointer('format'),
          cancelled
        });
        await persistent.register();
      }
      await beforeStart?.(pointer('decoder'));
      await success('start', [pointer('decoder')]);
      configured = running = true;
      dimensions = {width, height};
      log({event: 'native-decoder', ...dimensions, format: 'nv12'});
      return dimensions;
    },

    get lastInput() {
      return lastInput;
    },

    get lastStamp() {
      return lastStamp;
    },

    async startPersistent({stage = null} = {}) {
      if (workerMode !== 'persistent' || !running || closed || !sizing || !layout)
        throw Error('Persistent decoder needs a completed host-driven first frame');
      if (outputIndex >= 0 || pendingOutput) throw Error('Decoder output is still owned');
      await persistent.start({stage});
      persistentStarted = true;
    },

    async beginPersistent(unit) {
      if (!persistentStarted || closed || !running)
        throw Error('Persistent decoder is not running');
      if (persistentJob) throw Error('Persistent decoder job is already in flight');
      if (
        !Buffer.isBuffer(unit.data) ||
        !unit.data.length ||
        !Number.isSafeInteger(unit.pts) ||
        unit.pts < 0
      )
        throw Error('Invalid decoder access unit');
      step = 'acquireInput';
      if (pendingInput === null) pendingInput = await acquireInput();
      const index = pendingInput;
      step = 'cacheInput';
      await cacheInput(index);
      const {address, capacity} = inputs.get(index);
      if (!Number.isSafeInteger(address) || address <= 0 || unit.data.length > capacity)
        throw Error('H.264 access unit exceeds the native input buffer');
      step = 'writeUnit';
      await rpc.write(address, unit.data);
      step = 'persistent-start';
      persistentJob = await persistent.begin({
        index,
        length: unit.data.length,
        pts: unit.pts
      });
      step = 'persistent-output';
    },

    async finishPersistent(destination) {
      if (!persistentJob || closed || !running)
        throw Error('Persistent decoder has no submitted access unit');
      const {bytes, alignment} = sizing;
      if (
        !Number.isSafeInteger(destination.address) ||
        !Number.isSafeInteger(destination.bytes) ||
        destination.bytes < bytes ||
        !alignment ||
        destination.address % alignment
      )
        throw Error('Native output does not fit the aligned destination surface');
      step = 'persistent-fetch';
      const completed = await persistent.finish(persistentJob, destination);
      persistentJob = null;
      pendingInput = completed.input.index >= 0 ? completed.input.index : null;
      lastInput = completed.input;
      step = 'idle';
      return {
        ...layout,
        bytes,
        pts: completed.pts.toString(),
        format: 'nv12',
        ...(completed.probe ? {probe: completed.probe} : {})
      };
    },

    async processPersistent(unit, destination) {
      await this.beginPersistent(unit);
      return this.finishPersistent(destination);
    },

    async submit(unit, {acquireOutput: withOutput = true, stamp = null} = {}) {
      if (!running || closed) throw Error('Decoder is not running');
      if (
        !Buffer.isBuffer(unit.data) ||
        !unit.data.length ||
        !Number.isSafeInteger(unit.pts) ||
        unit.pts < 0
      )
        throw Error('Invalid decoder access unit');
      step = 'acquireInput';
      if (pendingInput === null) pendingInput = await acquireInput();
      const index = pendingInput;
      step = 'cacheInput';
      await cacheInput(index);
      const {address, capacity} = inputs.get(index);
      if (!Number.isSafeInteger(address) || address <= 0 || unit.data.length > capacity)
        throw Error('H.264 access unit exceeds the native input buffer');
      step = 'writeUnit';
      await rpc.write(address, unit.data);
      step = 'pump';
      const {statuses, control} = await pump(unit.data.length, unit.pts, withOutput, stamp);
      step = 'idle';
      if (statuses[0] !== 0)
        throw Object.assign(Error('movie::sendInput returned 0x' + statuses[0].toString(16)), {
          result: statuses[0]
        });
      const nextIndex = control.readInt32LE(0),
        inputStatus = statuses.at(-1);
      lastInput = {status: inputStatus, index: nextIndex};
      if (inputStatus !== 0 && !(nextIndex < 0 && [0x100e, 0x1011].includes(inputStatus)))
        throw Object.assign(Error('Decoder input queue returned 0x' + inputStatus.toString(16)), {
          result: inputStatus
        });
      pendingInput = nextIndex >= 0 ? nextIndex : null;
      if (!withOutput) return;
      pendingOutput = {
        status: statuses[1],
        index: control.readInt32LE(0x10),
        pts: control.readBigUInt64LE(0x18),
        flags: control.readUInt32LE(0x20)
      };
    },

    async receive(destination) {
      if (!running || closed) throw Error('Decoder is not running');
      if (outputIndex >= 0) throw Error('A decoder output buffer is still owned');
      // submit() already acquired this frame's output; a drain pull acquires one.
      step = 'acquireOutput';
      const out = pendingOutput ?? (await acquireOutput());
      pendingOutput = null;
      step = 'idle';
      outputIndex = out.index;
      if (outputIndex < 0 && out.status === 0x100e) return null;
      if (out.status !== 0)
        throw Object.assign(Error('Decoder output queue returned 0x' + out.status.toString(16)), {
          result: out.status
        });
      if (outputIndex < 0) return null;
      const timestamp = out.pts;
      try {
        step = 'getOutputSize';
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
        // Point the surface and fetch the frame in one two-call exchange.
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
        if (got !== 0)
          throw Object.assign(Error('movie::getOutput returned 0x' + got.toString(16)), {
            result: got
          });
        step = 'outputFormat';
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
        step = 'releaseOutput';
        await release();
        step = 'idle';
      }
    },

    close
  };
}

module.exports = {create};
