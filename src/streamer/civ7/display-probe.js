// Probe only: reads the retained Moonlight surface's capabilities and the device's image limits
// through functions compat-functions.json already qualifies. No graphics object is created.
// FEASIBILITY.md in the large-frame run directory has the reasons and commands.
import compat from './compat-functions.json' with {type: 'json'};
import {replyInteger} from './protocol.js';

/** @import {Civ7Rpc} from './transport.js' */

const CAPABILITIES_BYTES = 52;
const PROPERTIES_BYTES = 824;
const LIMITS_OFFSET = 296;
const NAMES = {
  capabilities: 'vkGetPhysicalDeviceSurfaceCapabilitiesKHR',
  properties: 'vkGetPhysicalDeviceProperties'
};

/** @type {Record<string, {offset: number, size: number, hex: string}>} */
const FUNCTIONS = compat.functions;

const hex = (/** @type {number | bigint} */ value) => '0x' + BigInt(value).toString(16);

/** @param {bigint | string | undefined} value */
function pointer(value) {
  const address = BigInt(value ?? 0);
  if (address < 0x1000n || address >= (1n << 39n)) throw Error('Invalid retained Vulkan handle');
  return Number(address);
}

/** VkSurfaceCapabilitiesKHR. @param {Buffer} bytes */
export function surfaceCapabilities(bytes) {
  const extent = (/** @type {number} */ at) => ({width: bytes.readUInt32LE(at), height: bytes.readUInt32LE(at + 4)});
  return {minImageCount: bytes.readUInt32LE(0), maxImageCount: bytes.readUInt32LE(4),
    currentExtent: extent(8), minImageExtent: extent(16), maxImageExtent: extent(24),
    maxImageArrayLayers: bytes.readUInt32LE(32), supportedTransforms: bytes.readUInt32LE(36),
    currentTransform: bytes.readUInt32LE(40), supportedCompositeAlpha: bytes.readUInt32LE(44),
    supportedUsageFlags: hex(bytes.readUInt32LE(48))};
}

/** The VkPhysicalDeviceProperties fields that bound a larger frame or swapchain. @param {Buffer} bytes */
export function deviceLimits(bytes) {
  const nameEnd = bytes.indexOf(0, 20);
  return {apiVersion: hex(bytes.readUInt32LE(0)), deviceName: bytes.toString('utf8', 20, nameEnd < 0 ? 276 : nameEnd),
    maxImageDimension2D: bytes.readUInt32LE(LIMITS_OFFSET + 4),
    maxTexelBufferElements: bytes.readUInt32LE(LIMITS_OFFSET + 20),
    maxStorageBufferRange: bytes.readUInt32LE(LIMITS_OFFSET + 28),
    maxFramebufferWidth: bytes.readUInt32LE(LIMITS_OFFSET + 364),
    maxFramebufferHeight: bytes.readUInt32LE(LIMITS_OFFSET + 368)};
}

/**
 * Queries the display stage's surface and physical device the graphics ledger retains.
 * @param {Civ7Rpc} rpc
 * @param {{log?: (event: object) => Promise<void>}} [options]
 */
export async function probeDisplay(rpc, {log = async () => {}} = {}) {
  const report = {status: 'running', cleanup: 'clean', error: '',
    swapchain: /** @type {Record<string, unknown>} */ ({}),
    surface: /** @type {ReturnType<typeof surfaceCapabilities> | null} */ (null),
    device: /** @type {ReturnType<typeof deviceLimits> | null} */ (null)};
  /** @type {number[]} */
  const allocations = [];
  let uncertain = false;

  try {
    const module = await rpc.request({command: 'module-probe', name: compat.module.name});
    if (module.hash !== compat.module.hash) throw Error('Unsupported module for the display probe');
    const base = Number(replyInteger(module, 'base'));
    const entries = Object.values(NAMES).map(name => ({name, ...FUNCTIONS[name]}));
    await rpc.request({command: 'verify-functions', base: hex(base), functions: entries});

    const status = await rpc.request({command: 'graphics-status', tableHash: compat.module.hash, blobHash: '00000000'});
    await log({event: 'graphics-status', ...status});
    if (!status.exists || !['all', 'display'].includes(String(status.reuse))) {
      report.status = 'no-retained-display';
      return report;
    }
    const display = /** @type {Record<string, string | number | undefined>} */ (status.display);
    const physical = pointer(String(display.physical));
    const surface = pointer(String(display.surface));
    report.swapchain = {imageCount: display.imageCount, presentMode: display.presentMode,
      surface: hex(surface), physical: hex(physical)};

    const output = await rpc.allocate(PROPERTIES_BYTES, {align: 16});
    allocations.push(output);
    await rpc.write(output, Buffer.alloc(PROPERTIES_BYTES));
    uncertain = true;
    const {result} = await rpc.callAddress(base + FUNCTIONS[NAMES.capabilities].offset, [physical, surface, output]);
    uncertain = false;
    if (result & 0xffffffffn) throw Error('Surface capabilities returned ' + Number(BigInt.asIntN(32, result)));
    report.surface = surfaceCapabilities(await rpc.read(output, CAPABILITIES_BYTES));
    await log({event: 'surface-capabilities', ...report.surface});

    await rpc.write(output, Buffer.alloc(PROPERTIES_BYTES));
    uncertain = true;
    await rpc.callAddress(base + FUNCTIONS[NAMES.properties].offset, [physical, output]);
    uncertain = false;
    report.device = deviceLimits(await rpc.read(output, PROPERTIES_BYTES));
    await log({event: 'device-limits', ...report.device});
    report.status = 'display-read';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    await log({event: 'probe-error', message: report.error});
  } finally {
    if (!rpc.connected || uncertain) report.cleanup = 'restart-required';
    else {
      try { for (const address of allocations.reverse()) await rpc.release(address); }
      catch (error) { report.cleanup = 'restart-required'; report.error ||= String(error); }
    }
  }
  return report;
}
