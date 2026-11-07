import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareConsoleGraphics} from './console-startup.js';

/** @import {Civ7Rpc} from '../civ7/transport.js' */
/** @import {CompatTable} from '../civ7/modules.js' */
/** @import {PipelineMenu, PipelineGpu} from '../civ7/renderer-pipelines.js' */

/** @typedef {{menu: PipelineMenu, gpu: PipelineGpu}} PreparedGraphics */

/**
 * Brings up the console's graphics, reusing what its graphics ledger still holds.
 * @param {{rpc: Civ7Rpc, directory: string, compatCache: string, inspector?: string,
 *   table?: CompatTable, destroyDisplay?: boolean, log?: (event: object) => void,
 *   mark?: (name: string) => void}} options `mark` takes startup-timing.js marks
 * @returns {Promise<PreparedGraphics>}
 */
export async function prepareMoonlight({rpc, directory, compatCache, inspector, table, destroyDisplay,
  log = event => {}, mark = name => {}}) {
  log({event: 'startup', stage: 'graphics'});
  const {menu, gpu} = await prepareConsoleGraphics({rpc, directory, compatCache, inspector, table,
    destroyDisplay, log, mark});

  await fs.writeFile(path.join(directory, 'prepare.json'), JSON.stringify({app: gpu, ready: true}, null, 2));
  return {menu, gpu};
}
