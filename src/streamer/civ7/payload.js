import {decodeBatch} from './decode-batch.js';
import {createAv1Backend} from './av1-decode.js';
import {runCallPlan} from './call-plan.js';
import {withNativeStack} from './native-stack.js';
import {boundLoaderLogging} from './logging.js';
import {createPresentation, presentBatch} from './present-batch.js';
import {createFramePublication} from './video-publication.js';
import * as ring from '../shared/ring.js';
import {videoStream} from './video-stream.js';
import {createInputReader} from './input.js';
import {createAudioPump} from './audio.js';
import {createJitterQueue, crossfadePcm} from './audio-queue.js';
import {controllerMapping, NPAD} from '../input/controller.js';
import {touchMapping} from '../input/touch.js';
import {createInputRecorder, INPUT_RECORD} from '../input/input-record.js';
import {createConsoleUi} from './console-ui.js';
import {MAGIC as UI_PAGE_MAGIC} from '../ui/page.js';
import {createSettingsStore} from './settings-store.js';
import {createMachine} from '../ui/model.js';
import {createSettingsCore, VALUES} from '../ui/settings.js';
import {moduleTables, probeModule, verifyFunctions} from './compat.js';
import {fillStorage} from './asset-fill.js';
import {graphicsLedger} from './graphics-ledger.js';
import {audioOutCommand} from './audio-out-record.js';
import {pipelineCacheStore} from './pipeline-cache-store.js';
import {refreshRateCommand} from './refresh-rate-record.js';
import {setReceiveBuffer} from './socket-options.js';
import {udpProbe} from './udp-probe.js';
import {createUdpReceiver} from './udp-receiver.js';
import {createOverlay} from './rate-badge.js';
import {runtimeCapabilities, mediaCapabilities} from './runtime-capabilities.js';
import {workspaceLimit} from './av1-decoder.js';
import sdkFunctions from './sdk-functions.json' with {type: 'json'};

/** @import {ConsoleRequest, LoaderRuntime} from './console-runtime.js' */
/** @import {GraphicsRecord} from './graphics-ledger.js' */
/** @import {RefreshRateRecord} from './refresh-rate-record.js' */
/** @import {AudioOutRecord} from './audio-out-record.js' */

/** @typedef {{host: string, port: number, token: string, nativeStackBytes?: number}} PayloadConfiguration */

/** Bridge allocations stay under 128 MiB; only the AV1 workspace may take the level table's largest. */
export const ALLOCATION_LIMITS = {default: 128 * 1024 * 1024, av1Workspace: workspaceLimit()};

/**
 * What survives in window.__moonlightState between payload sends in one app process.
 * @typedef {object} RetainedState
 * @property {string} [session]
 * @property {Map<string, {raw: bigint, size: number}>} allocations aligned address to raw allocation
 * @property {Map<string, {signature: string, reply: Record<string, unknown>}>} completedCleanup
 * @property {boolean} [connectionLost]
 * @property {GraphicsRecord | null} [graphics]
 * @property {RefreshRateRecord | null} [refreshRate] set while this process left the display raised
 * @property {AudioOutRecord | null} [audioOut] set while this process holds an AudioOut open
 * @property {Map<string, Record<string, unknown>>} [modules] module-probe replies by name: a loaded
 *   module never changes in one process, and hashing its tables took most of a reattach
 */

/**
 * The loader primitives plus every function and table buildPayload ships beside runBridge.
 * @typedef {LoaderRuntime & {
 *   state?: RetainedState, now?: () => number,
 *   createConsoleUi: typeof createConsoleUi, createSettingsCore: typeof createSettingsCore,
 *   createSettingsStore: typeof createSettingsStore, createMachine: typeof createMachine,
 *   settingValues: typeof VALUES, uiLayout: Parameters<typeof createConsoleUi>[0]['uiLayout'],
 *   decodeBatch: typeof decodeBatch, createAv1Backend: typeof createAv1Backend, runCallPlan: typeof runCallPlan,
 *   createPresentation: typeof createPresentation, presentBatch: typeof presentBatch,
 *   createFramePublication: typeof createFramePublication, videoStream: typeof videoStream,
 *   createInputReader: typeof createInputReader, createInputRecorder: typeof createInputRecorder,
 *   inputMapping: Parameters<typeof videoStream>[0]['inputMapping'], createAudioPump: typeof createAudioPump,
 *   createJitterQueue: typeof createJitterQueue, crossfadePcm: typeof crossfadePcm,
 *   nativeChecksum: typeof ring.nativeChecksum, moduleTables: typeof moduleTables,
 *   probeModule: typeof probeModule, verifyFunctions: typeof verifyFunctions,
 *   fillStorage: typeof fillStorage, graphicsLedger: typeof graphicsLedger, audioOutCommand: typeof audioOutCommand,
 *   pipelineCacheStore: typeof pipelineCacheStore, refreshRateCommand: typeof refreshRateCommand,
 *   setReceiveBuffer: typeof setReceiveBuffer, udpProbe: typeof udpProbe, createOverlay: typeof createOverlay,
 *   createUdpReceiver: typeof createUdpReceiver,
 *   runtimeCapabilities: typeof runtimeCapabilities,
 *   mediaCapabilities: typeof mediaCapabilities,
 *   publicationLayout: Parameters<typeof videoStream>[0]['publicationLayout'],
 *   allocationLimits: typeof ALLOCATION_LIMITS, operationMode: {offset: number, hex: string}
 * }} BridgeRuntime
 */

/** @typedef {Record<string, unknown>} BridgeReply */

/**
 * The console side of the control connection: serves host requests until `close` or a lost
 * connection. Shipped by toString() with every helper it calls passed in `runtime`.
 * @param {BridgeRuntime} runtime
 * @param {PayloadConfiguration} configuration
 */
export async function runBridge(runtime, configuration) {
  const {
    main, sdk, read64, read32, write64, write32, readBuffer, writeBuffer,
    allocate, release, call, socket, connect, receive, send, close, encode, decode
  } = runtime;
  const frameLimit = 256 * 1024;
  const memoryLimit = 64 * 1024;
  const queryMemory = sdk + 0x168b0cn;
  const copyMemory = sdk + 0x5224e0n;
  const copySignature = [0x9240098acb0103ecn, 0x54000469eb0a004bn,
    0xaa0003e8aa0103e9n, 0xaa0103e8b400016an];
  /** @type {RetainedState} */
  const retained = runtime.state || {allocations: new Map(), completedCleanup: new Map()};
  const allocations = retained.allocations;
  const completedCleanup = retained.completedCleanup;
  const verified = new Set();
  /** @param {bigint} address */
  const addressText = address => '0x' + address.toString(16);
  let channel = -1n;
  let workspace = 0n;
  let running = true;
  let copyVerified = false;
  /** @type {ReturnType<typeof createConsoleUi> | null} */
  let ui = null;
  const now = runtime.now || (() => Date.now());
  const started = now();
  /** @type {ReturnType<typeof createOverlay> | null} */
  let overlay = null;

  /**
   * @param {unknown} value
   * @param {number} minimum
   * @param {number} maximum
   */
  function integer(value, minimum, maximum) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw Error('Invalid integer');
    return value;
  }

  /** @param {unknown} value */
  function address(value) {
    if (typeof value !== 'string' || !/^0x[0-9a-f]{1,16}$/i.test(value))
      throw Error('Invalid address');
    const result = BigInt(value);
    if (result >= (1n << 39n)) throw Error('Address exceeds process address space');
    return result;
  }

  /** @param {unknown} value */
  function argument(value) {
    if (typeof value !== 'string' || !/^(?:0x[0-9a-f]{1,16}|-?[0-9]{1,20})$/i.test(value))
      throw Error('Invalid native argument');
    const result = BigInt(value);
    if (result < -(1n << 63n) || result >= (1n << 64n)) throw Error('Native argument overflow');
    return BigInt.asUintN(64, result);
  }

  /** @param {bigint} address */
  function query(address) {
    const result = call(queryMemory, workspace, workspace + 0x40n, address) & 0xffffffffn;
    if (result !== 0n) throw Error('QueryMemory returned ' + addressText(result));
    return {
      base: read64(workspace), size: read64(workspace + 8n),
      state: Number(read32(workspace + 16n)),
      attributes: Number(read32(workspace + 20n)),
      permissions: Number(read32(workspace + 24n))
    };
  }

  /**
   * @param {bigint} start
   * @param {number} length
   * @param {number} permissions
   */
  function checkMemory(start, length, permissions) {
    if (start < 0x1000n || length < 1 || start + BigInt(length) > (1n << 39n))
      throw Error('Invalid memory range');
    const end = start + BigInt(length);
    let cursor = start;
    for (let count = 0; cursor < end; count++) {
      if (count >= 256) throw Error('Memory range crosses too many mappings');
      const region = query(cursor);
      if (region.base > cursor || region.base + region.size <= cursor ||
          (region.permissions & permissions) !== permissions)
        throw Error('Memory permissions do not cover ' + addressText(cursor));
      cursor = region.base + region.size;
    }
  }

  /** @param {unknown} text */
  function fromHex(text) {
    if (typeof text !== 'string' || !/^(?:[0-9a-f]{2})*$/i.test(text) ||
        text.length > memoryLimit * 2) throw Error('Invalid memory bytes');
    return Uint8Array.from(text.match(/../g) || [], byte => parseInt(byte, 16));
  }

  /** @param {unknown} error */
  function errorText(error) {
    return String(/** @type {{message?: unknown}} */ (error).message || error);
  }

  /** @param {Uint8Array} bytes */
  function toHex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * @param {bigint} pointer
   * @param {number} length
   */
  function readMemory(pointer, length) {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const current = pointer + BigInt(offset);
      const shift = Number(current & 7n);
      let word = read64(current & -8n) >> BigInt(shift * 8);
      const count = Math.min(8 - shift, length - offset);
      for (let index = 0; index < count; index++) {
        bytes[offset++] = Number(word & 255n);
        word >>= 8n;
      }
    }
    return bytes;
  }

  /**
   * @param {bigint} pointer
   * @param {Uint8Array} bytes
   */
  function writeMemory(pointer, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const current = pointer + BigInt(offset);
      const aligned = current & -8n;
      const shift = Number(current & 7n);
      const count = Math.min(8 - shift, bytes.length - offset);
      let word = read64(aligned);
      for (let index = 0; index < count; index++) {
        const bits = BigInt((shift + index) * 8);
        word = (word & ~(255n << bits)) | (BigInt(bytes[offset++]) << bits);
      }
      write64(aligned, word);
    }
  }

  /**
   * @param {LoaderRuntime['receive'] | LoaderRuntime['send']} operation
   * @param {bigint} buffer
   * @param {number} length
   */
  function transfer(operation, buffer, length, allowEnd = false) {
    let transferred = 0;
    while (transferred < length) {
      const count = Number(operation(channel, buffer + BigInt(transferred), length - transferred, 0));
      if (count === 0 && allowEnd && transferred === 0) return false;
      if (count <= 0 || count > length - transferred) throw Error('Civ7 transfer failed: ' + count);
      transferred += count;
    }
    return true;
  }

  /** @param {Record<string, unknown>} value */
  function writeFrame(value) {
    const bytes = encode(JSON.stringify(value));
    if (!bytes.length || bytes.length > frameLimit) throw Error('Invalid reply length');
    write32(workspace + 0xfcn, bytes.length);
    writeBuffer(workspace + 0x100n, bytes);
    transfer(send, workspace + 0xfcn, bytes.length + 4);
  }

  /** @returns {ConsoleRequest | null} */
  function readFrame() {
    if (!transfer(receive, workspace + 0x80n, 4, true)) return null;
    const length = Number(read32(workspace + 0x80n));
    integer(length, 1, frameLimit);
    transfer(receive, workspace + 0x100n, length);
    return JSON.parse(decode(readBuffer(workspace + 0x100n, length)));
  }

  function serviceControl() {
    ui?.poll();
    for (let count = 0; count < 4; count++) {
      const available = Number(receive(channel, workspace + 0x80n, 4, 0x82));
      if (available === 0) throw Error('Control connection closed during playback');
      if (available < 4) return;
      const request = readFrame();
      if (request === null) throw Error('Control connection closed during playback');
      try {
        integer(request.id, 1, Number.MAX_SAFE_INTEGER);
        const command = String(request.command);
        const playback = ['read', 'write', 'write-raw', 'ui-poll', 'ui-event', 'ui-show', 'time', 'overlay-show',
          'overlay-hide', 'operation-mode'];
        if (!playback.includes(command))
          throw Error('Command unavailable during playback');
        writeFrame({id: request.id, ok: true, ...dispatch(request)});
      } catch (error) {
        writeFrame({id: request.id, ok: false, error: errorText(error)});
      }
    }
  }

  /** The stream's rate badge (rate-badge.js), made on first use. */
  function overlayState() {
    overlay ??= runtime.createOverlay({address, integer, checkMemory, write32, now});
    return overlay;
  }

  /** @param {ConsoleRequest} plan */
  function runPlan(plan) {
    return runtime.runCallPlan({address, integer, argument, checkMemory, verified, call, read32, read64,
      write32, write64, writeMemory, readMemory, fromHex, toHex}, plan);
  }

  /**
   * @param {ConsoleRequest} request
   * @returns {BridgeReply}
   */
  function dispatch(request, depth = 0) {
    if (request.cleanupKey !== undefined) {
      const cleanable = ['allocate', 'call', 'release'].includes(String(request.command));
      if (!cleanable || typeof request.cleanupKey !== 'string' ||
          !request.cleanupKey.length || request.cleanupKey.length > 256) throw Error('Invalid cleanup key');
      const {id, cleanupKey, ...operation} = request;
      const signature = JSON.stringify(operation);
      const previous = completedCleanup.get(cleanupKey);
      if (previous) {
        if (previous.signature !== signature) throw Error('Cleanup key was reused for another operation');
        return previous.reply;
      }
      const reply = dispatch(operation, depth);
      completedCleanup.set(cleanupKey, {signature, reply});
      return reply;
    }
    switch (request.command) {
      case 'runtime-capabilities':
        return runtime.runtimeCapabilities(globalThis, {read64, read32, write64, write32, readBuffer,
          writeBuffer, allocate, release, call, socket, connect, receive, send, close});
      case 'media-capabilities':
        return runtime.mediaCapabilities(globalThis);
      case 'time':
        return {now: now()};
      case 'operation-mode': {
        if (depth) throw Error('Operation mode cannot be read in a batch');
        const pointer = address(request.address);
        const definition = runtime.operationMode;
        if (pointer !== sdk + BigInt(definition.offset) || !verified.has(addressText(pointer)))
          throw Error('Operation mode function was not verified');
        const expected = fromHex(definition.hex);
        checkMemory(pointer, expected.length, 5);
        const actual = readMemory(pointer, expected.length);
        if (actual.some((value, index) => value !== expected[index])) throw Error('Operation mode function changed');
        return {raw: Number(call(pointer) & 0xffn)};
      }
      case 'ui-init':
        if (depth || ui) throw Error('Console UI is already initialized');
        ui = runtime.createConsoleUi({address, checkMemory, verified, call, read32, read64,
          write32, writeBuffer, readMemory, encode, decode, createSettingsCore: runtime.createSettingsCore,
          createMachine: runtime.createMachine, settingValues: runtime.settingValues,
          createSettingsStore: runtime.createSettingsStore, uiLayout: runtime.uiLayout, readBuffer, now}, request);
        if (retained.connectionLost) ui.dispatch({type: 'connectionLost'});
        return ui.snapshot();
      case 'settings-load': {
        if (depth) throw Error('Settings cannot be loaded in a batch');
        const rules = runtime.createSettingsCore(runtime.settingValues);
        const store = runtime.createSettingsStore({address, checkMemory, verified, call, read64, write32,
          writeBuffer, readMemory, encode, decode}, /** @type {{memory: unknown, functions: Record<string, unknown>}} */ (
          request.store), rules);
        return {settings: store.load()};
      }
      case 'ui-event':
        if (!ui) throw Error('Console UI is not initialized');
        ui.dispatch(/** @type {Parameters<typeof ui.dispatch>[0]} */ (request.event));
        return ui.snapshot();
      case 'ui-poll':
        if (!ui) throw Error('Console UI is not initialized');
        ui.poll();
        return ui.snapshot();
      case 'ui-show':
        if (!ui) throw Error('Console UI is not initialized');
        ui.show(request);
        return ui.snapshot();
      case 'overlay-show':
        return overlayState().show(request);
      case 'overlay-hide':
        return overlay ? overlay.hide() : {armed: false};
      case 'ui-close':
        ui?.close();
        ui = null;
        return {};
      case 'present-batch':
        if (depth) throw Error('Presentation batches cannot be nested');
        return runtime.presentBatch({address, integer, checkMemory, verified, call,
          read32, read64, write32, write64, writeBuffer, readMemory, createInputReader: runtime.createInputReader,
          createPresentation: runtime.createPresentation, ui}, request);
      case 'call-plan':
        if (depth) throw Error('Call plans cannot be nested');
        return runPlan(request);
      case 'refresh-rate':
        if (depth) throw Error('Refresh-rate requests cannot be batched');
        return runtime.refreshRateCommand({state: retained, runPlan}, request);
      case 'decode-batch':
      case 'video-stream': {
        if (depth) throw Error('Decode batches cannot be nested');
        const decodeNative = {
          address, integer, checkMemory, verified, call, socket, connect, receive, send, close, writeBuffer, encode,
          read32, read64, write32, write64, readMemory,
          createPresentation: runtime.createPresentation, createFramePublication: runtime.createFramePublication,
          publicationLayout: runtime.publicationLayout,
          decodeBatch: runtime.decodeBatch, createAv1Backend: runtime.createAv1Backend,
          createInputReader: runtime.createInputReader, createInputRecorder: runtime.createInputRecorder, inputMapping: runtime.inputMapping,
          createAudioPump: runtime.createAudioPump, createJitterQueue: runtime.createJitterQueue,
          crossfadePcm: runtime.crossfadePcm, setReceiveBuffer: runtime.setReceiveBuffer, serviceControl, ui, now,
          createUdpReceiver: runtime.createUdpReceiver,
          overlay: overlayState()};
        try {
          if (request.command === 'video-stream') return runtime.videoStream(decodeNative, request);
          return runtime.decodeBatch(decodeNative, request);
        } finally {
          overlayState().detach();
        }
      }
      case 'udp-probe':
        if (depth) throw Error('UDP probes cannot be batched');
        return runtime.udpProbe({address, integer, checkMemory, verified, call, socket, connect, receive, send,
          close, writeBuffer, readMemory, read32, encode, now, setReceiveBuffer: runtime.setReceiveBuffer}, request);
      case 'read': {
        const pointer = address(request.address);
        const length = integer(request.length, 1, memoryLimit);
        checkMemory(pointer, length, 1);
        return {hex: toHex(readMemory(pointer, length))};
      }
      case 'write': {
        const pointer = address(request.address);
        const bytes = fromHex(request.hex);
        if (bytes.length) {
          checkMemory(pointer, bytes.length, 3);
          writeMemory(pointer, bytes);
        }
        return {};
      }
      case 'write-raw': {
        if (depth) throw Error('Raw uploads cannot be batched');
        try {
          const pointer = address(request.address);
          const length = integer(request.length, 1, 1024 * 1024);
          checkMemory(pointer, length, 2);
          if (!copyVerified) {
            checkMemory(copyMemory, 32, 5);
            if (copySignature.some((value, index) => read64(copyMemory + BigInt(index * 8)) !== value))
              throw Error('Memory copy signature mismatch');
            copyVerified = true;
          }
          for (let offset = 0; offset < length; offset += frameLimit) {
            const count = Math.min(frameLimit, length - offset);
            transfer(receive, workspace + 0x100n, count);
            call(copyMemory, pointer + BigInt(offset), workspace + 0x100n, BigInt(count));
          }
          return {};
        } catch (error) {
          running = false;
          throw error;
        }
      }
      case 'allocate': {
        const workspace = request.purpose === 'av1-workspace';
        const limits = runtime.allocationLimits;
        const size = integer(request.size, 1, workspace ? limits.av1Workspace : limits.default);
        const alignment = integer(request.alignment, 8, 2 * 1024 * 1024);
        if ((alignment & (alignment - 1)) !== 0) throw Error('Alignment must be a power of two');
        const raw = allocate(size + alignment - 1);
        if (raw === 0n) throw Error('Native allocation failed');
        const aligned = (raw + BigInt(alignment - 1)) & -BigInt(alignment);
        allocations.set(addressText(aligned), {raw, size});
        return {address: addressText(aligned)};
      }
      case 'release': {
        const pointer = address(request.address);
        const key = addressText(pointer);
        const allocation = allocations.get(key);
        if (!allocation) throw Error('Allocation is not owned by this bridge');
        if (retained.audioOut?.memory === key) throw Error('Allocation still backs an open AudioOut');
        release(allocation.raw);
        allocations.delete(key);
        return {};
      }
      case 'verify-function': {
        const pointer = address(request.address);
        const expected = fromHex(request.hex);
        if (pointer % 4n || expected.length < 4 || expected.length > 256 || expected.length % 4)
          throw Error('Invalid function signature');
        checkMemory(pointer, expected.length, 5);
        const actual = readMemory(pointer, expected.length);
        if (actual.some((value, index) => value !== expected[index]))
          throw Error('Native function signature mismatch at ' + addressText(pointer));
        verified.add(addressText(pointer));
        return {};
      }
      case 'call': {
        const pointer = address(request.address);
        if (!verified.has(addressText(pointer))) throw Error('Native function was not verified');
        if (!Array.isArray(request.args) || request.args.length > 6)
          throw Error('Civ7 supports at most six register arguments');
        const result = call(pointer, ...request.args.map(argument));
        /** @type {{result: string, hex?: string}} */
        const reply = {result: addressText(BigInt.asUintN(64, result))};
        const target = /** @type {ConsoleRequest | undefined} */ (request.output);
        if (target) {
          const output = address(target.address);
          const length = integer(target.length, 1, memoryLimit);
          checkMemory(output, length, 1);
          reply.hex = toHex(readMemory(output, length));
        }
        return reply;
      }
      case 'native-plan': {
        if (!Array.isArray(request.calls) || request.calls.length > 64)
          throw Error('Invalid native call plan');
        for (const item of request.calls) {
          const pointer = address(item.address);
          if (!verified.has(addressText(pointer))) throw Error('Native function was not verified');
          if (!Array.isArray(item.args) || item.args.length > 6) throw Error('Invalid native call arguments');
          for (const value of item.args) {
            if (typeof value === 'string') argument(value);
            else {
              if (!value || Object.keys(value).length !== 1 ||
                  !['u32', 'u64'].includes(Object.keys(value)[0])) throw Error('Invalid indirect argument');
              const field = Object.keys(value)[0];
              checkMemory(address(value[field]), field === 'u32' ? 4 : 8, 1);
            }
          }
        }
        const results = [];
        for (const item of request.calls) {
          const args = item.args.map((/** @type {string | Record<string, unknown>} */ value) => {
            if (typeof value === 'string') return value;
            if (!value || Object.keys(value).length !== 1) throw Error('Invalid indirect argument');
            const field = Object.hasOwn(value, 'u32') ? 'u32' : 'u64';
            const pointer = address(value[field]);
            checkMemory(pointer, field === 'u32' ? 4 : 8, 1);
            return addressText(field === 'u32' ? read32(pointer) : read64(pointer));
          });
          results.push(dispatch({command: 'call', address: item.address, args}).result);
        }
        return {results};
      }
      case 'batch': {
        if (depth || !Array.isArray(request.commands) || request.commands.length > 64)
          throw Error('Invalid command batch');
        const commands = /** @type {ConsoleRequest[]} */ (request.commands);
        return {replies: commands.map(command => dispatch(command, depth + 1))};
      }
      case 'module-probe': {
        if (depth) throw Error('Module probes cannot be batched');
        const modules = retained.modules ??= new Map();
        const known = modules.get(String(request.name));
        if (known) return {...known, cached: true};

        const probed = runtime.probeModule({query, checkMemory, readMemory,
          moduleTables: runtime.moduleTables, nativeChecksum: runtime.nativeChecksum}, request);
        modules.set(String(request.name), probed);
        return probed;
      }
      case 'verify-functions':
        if (depth) throw Error('Function tables cannot be batched');
        return runtime.verifyFunctions({address, integer, checkMemory, readMemory, fromHex, verified}, request);
      case 'fill-storage':
        if (depth) throw Error('Storage fills cannot be batched');
        if (!copyVerified) throw Error('Memory copy is not verified; upload the asset blob first');
        return runtime.fillStorage({address, integer, checkMemory, readBuffer, writeBuffer,
          copy: (/** @type {bigint} */ target, /** @type {bigint} */ source, /** @type {number} */ count) => {
            call(copyMemory, target, source, BigInt(count));
          }}, request);
      case 'graphics-begin':
      case 'graphics-record':
      case 'graphics-commit':
      case 'graphics-status':
      case 'graphics-reap':
        if (depth) throw Error('Graphics ledger commands cannot be batched');
        return runtime.graphicsLedger({address, argument, checkMemory, readMemory, fromHex, verified, call,
          state: retained}, request);
      case 'audio-out':
        if (depth) throw Error('AudioOut requests cannot be batched');
        return runtime.audioOutCommand({address, checkMemory, readMemory, fromHex, verified, call,
          state: retained}, request);
      case 'pipeline-cache-load':
      case 'pipeline-cache-save':
        if (depth) throw Error('Pipeline cache commands cannot be batched');
        return runtime.pipelineCacheStore({address, integer, argument, checkMemory, verified, call, read32,
          read64, write32, write64, readBuffer, writeBuffer, encode, fromHex, toHex}, request);
      case 'memory-map': {
        const regions = [];
        let cursor = 0n;
        for (let count = 0; cursor < (1n << 39n); count++) {
          if (count >= 2048) throw Error('Memory map exceeds region limit');
          const region = query(cursor);
          if (region.size === 0n || region.base + region.size <= cursor) break;
          if (region.state) regions.push({...region, base: addressText(region.base), size: addressText(region.size)});
          cursor = region.base + region.size;
        }
        return {regions};
      }
      case 'close':
        if (depth) throw Error('Cannot close in a batch');
        running = false;
        return {retainedAllocations: allocations.size};
      default:
        throw Error('Unknown Civ7 command');
    }
  }

  try {
    if (read32(queryMemory) !== 0xf81f0fe1n || read32(queryMemory + 4n) !== 0xd40000c1n)
      throw Error('Unsupported Civ7 SDK QueryMemory wrapper');
    workspace = allocate(frameLimit + 0x200);
    if (!workspace) throw Error('Control workspace allocation failed');
    const endpoint = new Uint8Array(16);
    endpoint[0] = 16;
    endpoint[1] = 2;
    endpoint[2] = configuration.port >> 8;
    endpoint[3] = configuration.port & 255;
    endpoint.set(configuration.host.split('.').map(Number), 4);
    writeBuffer(workspace + 0x60n, endpoint);
    channel = socket(2, 1, 6);
    if (channel < 0n) throw Error('Control socket creation failed');
    if (connect(channel, workspace + 0x60n, 16) !== 0n) throw Error('Control connection failed');
    writeFrame({type: 'hello', version: 1, token: configuration.token,
      ...(retained.session ? {session: retained.session} : {}),
      allocations: Array.from(allocations, ([key, value]) => ({address: key, size: value.size})),
      main: addressText(main), sdk: addressText(sdk), nativeArguments: 6,
      bridgeMs: Math.round(now() - started)});
    while (running) {
      const request = readFrame();
      if (request === null) break;
      try {
        integer(request.id, 1, Number.MAX_SAFE_INTEGER);
        writeFrame({id: request.id, ok: true, ...dispatch(request)});
      } catch (error) {
        writeFrame({id: request.id, ok: false, error: errorText(error)});
      }
    }
  } finally {
    retained.connectionLost = running;
    if (channel >= 0n) close(channel);
    if (workspace) release(workspace);
  }
}

/**
 * The loader script: runBridge and everything it ships, optionally on its own native stack.
 * @param {PayloadConfiguration} configuration
 */
export function buildPayload(configuration) {
  const bridge = `(${runBridge.toString()})({
    main: main_base, sdk: sdk_base, read64, read32, write64, write32,
    readBuffer: read_buffer, writeBuffer: write_buffer,
    allocate: malloc, release: free, call: call_rop,
    socket, connect, receive: recv, send, close,
    state: (() => {
      if (!window.__moonlightState) {
        const hex = (value, digits) => BigInt(value).toString(16).padStart(digits, '0').slice(-digits);
        const session = hex(main_base, 12) + hex(sdk_base, 12) + hex(Date.now(), 8) +
          Array.from({length: 4}, () => hex(Math.floor(Math.random() * 0x100000000), 8)).join('');
        window.__moonlightState = {session, allocations: new Map(), completedCleanup: new Map()};
      }
      return window.__moonlightState;
    })(),
    encode: text_encode, decode: bytes_to_string,
    now: (() => {
      const clock = window.performance;
      return clock && typeof clock.now === 'function' ? () => clock.now() : () => Date.now();
    })(),
    createConsoleUi: ${createConsoleUi.toString()},
    runtimeCapabilities: ${runtimeCapabilities.toString()},
    mediaCapabilities: ${mediaCapabilities.toString()},
    createSettingsCore: ${createSettingsCore.toString()},
    createSettingsStore: ${createSettingsStore.toString()},
    createMachine: ${createMachine.toString()},
    settingValues: ${JSON.stringify(VALUES)},
    uiLayout: ${JSON.stringify({words: ring.UI, operations: ring.UI_OP, magic: ring.UI_MAGIC,
      page: {offset: ring.UI_OFFSET, bytes: ring.UI_PAGE_BYTES, magic: UI_PAGE_MAGIC}})},
    decodeBatch: ${decodeBatch.toString()},
    createAv1Backend: ${createAv1Backend.toString()},
    runCallPlan: ${runCallPlan.toString()},
    createPresentation: ${createPresentation.toString()},
    presentBatch: ${presentBatch.toString()},
    createFramePublication: ${createFramePublication.toString()},
    videoStream: ${videoStream.toString()},
    createInputReader: ${createInputReader.toString()},
    createInputRecorder: ${createInputRecorder.toString()},
    inputMapping: {
      controller: (${controllerMapping.toString()})(${JSON.stringify(NPAD)}),
      touch: (${touchMapping.toString()})(),
      record: ${JSON.stringify(INPUT_RECORD)}
    },
    createAudioPump: ${createAudioPump.toString()},
    createJitterQueue: ${createJitterQueue.toString()},
    crossfadePcm: ${crossfadePcm.toString()},
    nativeChecksum: ${ring.nativeChecksum.toString()},
    moduleTables: ${moduleTables.toString()},
    probeModule: ${probeModule.toString()},
    verifyFunctions: ${verifyFunctions.toString()},
    fillStorage: ${fillStorage.toString()},
    graphicsLedger: ${graphicsLedger.toString()},
    audioOutCommand: ${audioOutCommand.toString()},
    pipelineCacheStore: ${pipelineCacheStore.toString()},
    refreshRateCommand: ${refreshRateCommand.toString()},
    setReceiveBuffer: ${setReceiveBuffer.toString()},
    udpProbe: ${udpProbe.toString()},
    createUdpReceiver: ${createUdpReceiver.toString()},
    createOverlay: ${createOverlay.toString()},
    publicationLayout: ${JSON.stringify({control: ring.CONTROL, frameBytes: ring.FRAME_BYTES,
      framesOffset: ring.FRAMES_OFFSET, nativeABI: ring.NATIVE_ABI})},
    allocationLimits: ${JSON.stringify(ALLOCATION_LIMITS)},
    operationMode: ${JSON.stringify(sdkFunctions.operationMode)}
  }, ${JSON.stringify(configuration)})`;
  const execution = !configuration.nativeStackBytes ? bridge : `(${withNativeStack.toString()})({
    sdk: sdk_base, allocate: malloc, release: free, call: call_rop, read64, read32,
    createCall: rop_chain_addr => {
      const source = call_rop.toString();
      if (!source.includes('rop_chain_addr')) throw Error('Native call source changed');
      return eval('(' + source + ')');
    }
  }, ${JSON.stringify(configuration.nativeStackBytes)}, async invoke => {
    return await ${bridge.replace('call: call_rop,', 'call: invoke,')};
  })`;
  return `(async () => {
    (${boundLoaderLogging.toString()})(window, setTimeout, clearTimeout);
    return await ${execution};
  })()`;
}
