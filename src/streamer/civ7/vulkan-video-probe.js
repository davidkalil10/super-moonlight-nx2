import definitions from '../console-api/vulkan-video-probe-functions.json' with {type: 'json'};
import {replyInteger} from './protocol.js';

/** @import {Civ7Rpc, NativeValue} from './transport.js' */

const hex = (/** @type {number | bigint} */ value) => '0x' + BigInt(value).toString(16);
const VIDEO_EXTENSIONS = ['VK_KHR_video_queue', 'VK_KHR_video_decode_queue',
  'VK_KHR_video_decode_h264', 'VK_KHR_video_decode_h265', 'VK_KHR_video_decode_av1'];

/** @param {bigint | string} value */
function pointer(value) {
  const address = BigInt(value);
  if (address < 0x1000n || address >= (1n << 39n) || address % 8n)
    throw Error('Invalid Vulkan pointer');
  return Number(address);
}

/**
 * Queries a retained Moonlight physical device without creating or destroying graphics objects.
 * @param {Civ7Rpc} rpc
 * @param {{log?: (event: object) => Promise<void>}} [options]
 */
export async function probeVulkanVideo(rpc, {log = async () => {}} = {}) {
  const report = {status: 'running', cleanup: 'clean', error: '', instance: '', physical: '',
    state: /** @type {Record<string, string | number>} */ ({}),
    extensionsComplete: false,
    extensions: /** @type {{name: string, specVersion: number}[]} */ ([]),
    queues: /** @type {{index: number, flags: number, count: number, timestampBits: number,
      granularity: number[], videoDecode: boolean, videoEncode: boolean}[]} */ ([]),
    videoExtensions: /** @type {Record<string, boolean>} */ ({}),
    hevcAdvertised: false, av1Advertised: false};
  const allocations = /** @type {number[]} */ ([]);
  const functions = /** @type {Record<string, number>} */ ({});
  let uncertain = false;
  let scratch = 0;
  let physical = 0;

  /** @param {number} size */
  async function allocate(size) {
    const address = await rpc.allocate(size, {align: 16});
    allocations.push(address);
    await rpc.write(address, Buffer.alloc(size));
    return address;
  }
  /** @param {number} count */
  async function setCount(count) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(count);
    await rpc.write(scratch, bytes);
  }
  const getCount = async () => (await rpc.read(scratch, 4)).readUInt32LE();
  /** @param {string} name @param {NativeValue[]} args */
  async function call(name, args) {
    await log({event: 'native-before', stage: name, function: hex(functions[name]), args: args.map(value => hex(BigInt(value)))});
    uncertain = true;
    const {result} = await rpc.callAddress(functions[name], args);
    uncertain = false;
    const result32 = Number(BigInt.asIntN(32, result));
    await log({event: 'native-after', stage: name, result: name === 'extensions' ? result32 : null});
    return result32;
  }
  /** @param {number} count @param {number} max @param {string} label */
  function checkCount(count, max, label) {
    if (!count || count > max) throw Error('Unexpected Vulkan ' + label + ' count: ' + count);
  }
  async function queryExtensions() {
    for (let attempt = 0; attempt < 2; attempt++) {
      await setCount(0);
      let result = await call('extensions', [physical, 0, scratch, 0]);
      if (result !== 0) throw Error('Vulkan extension count failed: ' + result);
      const capacity = await getCount();
      if (capacity > 1024) throw Error('Unexpected Vulkan extension count: ' + capacity);
      if (!capacity) { report.extensionsComplete = true; return; }
      const output = await allocate(capacity * 260);
      await setCount(capacity);
      result = await call('extensions', [physical, 0, scratch, output]);
      const count = await getCount();
      if (count > capacity) throw Error('Vulkan extension output exceeds capacity');
      if (result !== 0 && result !== 5) throw Error('Vulkan extension enumeration failed: ' + result);
      const bytes = await rpc.read(output, count * 260);
      report.extensions = [];
      for (let index = 0; index < count; index++) {
        const entry = bytes.subarray(index * 260, (index + 1) * 260);
        const end = entry.subarray(0, 256).indexOf(0);
        if (end < 1) throw Error('Invalid Vulkan extension name');
        report.extensions.push({name: entry.toString('utf8', 0, end), specVersion: entry.readUInt32LE(256)});
      }
      await log({event: 'extensions-read', result, capacity, count, extensions: report.extensions});
      if (result === 0) { report.extensionsComplete = true; return; }
    }
  }
  async function queryQueues() {
    await setCount(0);
    await call('queues', [physical, scratch, 0]);
    const capacity = await getCount();
    checkCount(capacity, 32, 'queue family');
    const output = await allocate(capacity * 24);
    await setCount(capacity);
    await call('queues', [physical, scratch, output]);
    const count = await getCount();
    checkCount(count, capacity, 'written queue family');
    const bytes = await rpc.read(output, count * 24);
    for (let index = 0; index < count; index++) {
      const at = index * 24;
      const flags = bytes.readUInt32LE(at);
      report.queues.push({index, flags, count: bytes.readUInt32LE(at + 4), timestampBits: bytes.readUInt32LE(at + 8),
        granularity: [12, 16, 20].map(offset => bytes.readUInt32LE(at + offset)),
        videoDecode: Boolean(flags & 0x20), videoEncode: Boolean(flags & 0x40)});
    }
    await log({event: 'queues-read', queues: report.queues});
  }

  try {
    const module = await rpc.request({command: 'module-probe', name: definitions.moduleName});
    if (module.hash !== definitions.moduleHash) throw Error('Unsupported module for Vulkan probe');
    const base = pointer(replyInteger(module, 'base'));
    await rpc.request({command: 'verify-functions', base: hex(base),
      functions: Object.entries(definitions.functions).map(([name, entry]) => ({name, ...entry}))});
    for (const [name, entry] of Object.entries(definitions.functions)) functions[name] = base + entry.offset;
    await log({event: 'module-verified', base: hex(base), hash: module.hash});
    for (const [name, offset] of Object.entries(definitions.globals)) {
      const bytes = await rpc.read(base + offset, name === 'initialized' ? 1 : 8);
      report.state[name] = name === 'initialized' ? bytes[0] : hex(bytes.readBigUInt64LE());
    }
    await log({event: 'vulkan-state', ...report.state});
    const status = await rpc.request({command: 'graphics-status', tableHash: definitions.moduleHash, blobHash: '00000000'});
    await log({event: 'graphics-status', ...status});
    if (!status.exists || !['all', 'display'].includes(String(status.reuse))) {
      report.status = 'no-retained-display';
      return report;
    }
    if (report.state.initialized !== 1) throw Error('Vulkan ICD is not initialized');
    for (const [name, value] of Object.entries(report.state))
      if (name !== 'initialized') pointer(String(value));
    const display = /** @type {{instance?: string, physical?: string}} */ (status.display);
    const instance = pointer(display?.instance ?? '0');
    physical = pointer(display?.physical ?? '0');
    if (!Array.isArray(status.list) || !status.list.some(entry => entry?.kind === 'instance' &&
      entry.stage === 'display' && BigInt(entry.handle) === BigInt(instance)))
      throw Error('Retained Vulkan instance has no ownership record');
    const object = await rpc.read(physical, 32);
    if (object.readBigUInt64LE(16) !== 0x10aded020210adedn)
      throw Error('Retained Vulkan physical-device magic mismatch');
    const table = pointer(object.readBigUInt64LE());
    pointer(object.readBigUInt64LE(24));
    for (const offset of [64, 104]) pointer((await rpc.read(table + offset, 8)).readBigUInt64LE());
    report.instance = hex(instance);
    report.physical = hex(physical);
    await log({event: 'borrowed-physical-verified', instance: report.instance, physical: report.physical, table: hex(table)});
    scratch = await allocate(16);
    await queryExtensions();
    await queryQueues();
    const names = new Set(report.extensions.map(entry => entry.name));
    for (const name of VIDEO_EXTENSIONS) report.videoExtensions[name] = names.has(name);
    const decodeQueue = report.queues.some(queue => queue.count > 0 && queue.videoDecode);
    const videoExtensions = names.has('VK_KHR_video_queue') && names.has('VK_KHR_video_decode_queue');
    const video = report.extensionsComplete && videoExtensions && decodeQueue;
    report.hevcAdvertised = video && names.has('VK_KHR_video_decode_h265');
    report.av1Advertised = video && names.has('VK_KHR_video_decode_av1');
    report.status = report.extensionsComplete ? 'capabilities-read' : 'extensions-incomplete';
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.status = 'failed';
    await log({event: 'probe-error', message: report.error});
  } finally {
    if (!rpc.connected || uncertain) report.cleanup = 'restart-required';
    else {
      try { for (const address of allocations.reverse()) await rpc.release(address); }
      catch (error) { report.cleanup = 'restart-required'; report.error ||= String(error); }
    }
    await log({event: 'probe-cleanup', cleanup: report.cleanup, borrowedInstance: report.instance});
  }
  return report;
}
