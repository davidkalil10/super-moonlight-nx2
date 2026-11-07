// The layer's size for one console app process, picked before the display first opens from the
// saved AV1 stream size, reserving the docked target while handheld too. An open layer is
// never resized, so a different size above 1080p needs a restart (README.md, "Layer size").
import {readOperationMode} from './operation-mode.js';
import {settingsFunctions} from './console-ui.js';
import {DEFAULT_SIZE} from './display.js';

/** @import {Civ7Rpc} from './transport.js' */

const NATIVE_SIZES = ['2560x1440', '3840x2160'];

/** @typedef {{width: number, height: number}} Size */

/** @param {Size} size */
const sizeText = size => size.width + 'x' + size.height;

/**
 * The layer saved settings ask for.
 * @param {{size?: unknown, codec?: unknown} | null | undefined} settings
 * @returns {Size}
 */
export function layerSizeFor(settings) {
  const saved = String(settings?.size ?? '');
  if (settings?.codec !== 'av1' || !NATIVE_SIZES.includes(saved)) return {...DEFAULT_SIZE};

  const [width, height] = saved.split('x').map(Number);
  return {width, height};
}

/** @param {Size} size */
export const layerRestartNotice = size => 'Restart Moonlight on the console to stream at ' + size.height + 'p';

/**
 * Above 1080p the session needs its exact native layer; a mismatch runs at 1080p with a restart
 * notice. Smaller streams scale into any layer.
 * @param {Size} size what the session would run at
 * @param {Size} layer
 * @returns {{size: Size, fallback?: {type: 'stream-fallback', kind: 'size', from: string, to: string,
 *   reason: string, notice: string}}}
 */
export function fitLayer(size, layer) {
  const native = size.width === layer.width && size.height === layer.height;
  if (size.height <= DEFAULT_SIZE.height || native) return {size};

  return {size: {...DEFAULT_SIZE}, fallback: {type: 'stream-fallback', kind: 'size', from: sizeText(size),
    to: sizeText(DEFAULT_SIZE), reason: 'the display opened at ' + sizeText(layer), notice: layerRestartNotice(size)}};
}

/**
 * The console's saved settings, read before the UI exists; null when it has none or the read fails.
 * @param {Civ7Rpc} rpc
 */
async function consoleSettings(rpc) {
  const functions = await settingsFunctions(rpc);
  const memory = await rpc.allocate(0x2000);
  try {
    const reply = await rpc.request({command: 'settings-load', store: {memory: '0x' + memory.toString(16), functions}});
    return /** @type {{size?: unknown, codec?: unknown} | null} */ (reply.settings ?? null);
  } finally {
    await rpc.release(memory);
  }
}

/**
 * The layer to open in this process: the console's saved settings, else the PC's migration copy.
 * Any failure opens 1080p.
 * @param {Civ7Rpc} rpc
 * @param {{migration?: () => {size?: unknown, codec?: unknown}, log?: (event: object) => void}} [options]
 * @returns {Promise<Size>}
 */
export async function pickLayerSize(rpc, {migration = () => ({}), log = () => {}} = {}) {
  try {
    const {docked} = await readOperationMode(rpc, {log});
    const settings = await consoleSettings(rpc) ?? migration();
    const size = layerSizeFor(settings);
    log({event: 'layer-size', size, docked, saved: settings?.size ?? null, codec: settings?.codec ?? null});
    return size;
  } catch (error) {
    log({event: 'layer-size', size: {...DEFAULT_SIZE}, failed: error instanceof Error ? error.message : String(error)});
    return {...DEFAULT_SIZE};
  }
}
