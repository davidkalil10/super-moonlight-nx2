import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {configDirectory} from '../ui/hosts.js';

/** @typedef {{width: number, height: number, fps: number}} StreamMode */
/** @typedef {{action: string, session: string, host: string, options?: unknown} & Partial<StreamMode>} DisplayRequest */

/** @param {string[]} command @param {DisplayRequest} request @returns {Promise<void>} */
export function runDisplayHook(command, request) {
  return new Promise((resolve, reject) => {
    const child = execFile(command[0], command.slice(1), {timeout: 5000, maxBuffer: 64 * 1024}, error => {
      if (error) reject(Error('Host display hook failed: ' + error.message));
      else resolve();
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(request) + '\n');
  });
}

/**
 * An explicitly configured host adapter; no host OS or display server is assumed.
 * @param {string} host
 * @param {{file?: string, execute?: typeof runDisplayHook, log?: (event: object) => void}} [settings]
 */
export function createHostDisplay(host, {file = path.join(configDirectory(), 'host-display.json'),
  execute = runDisplayHook, log = () => {}} = {}) {
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw Error('Cannot read host display configuration: ' + String(error));
  }
  if (!config || config.version !== 1 || !config.hosts || typeof config.hosts !== 'object' || Array.isArray(config.hosts))
    throw Error('Invalid host display configuration');
  const adapter = config.hosts[host];
  if (!adapter) return null;
  const command = adapter.command;
  if (!Array.isArray(command) || !command.length ||
      !command.every(value => typeof value === 'string' && value.length > 0))
    throw Error('Invalid display hook for host ' + host);

  const session = randomUUID();
  let active = false;
  /** @type {StreamMode | null} */
  let applied = null;
  /** @param {string} action @param {Partial<StreamMode>} [mode] */
  const request = (action, mode = {}) => execute(command,
    {action, session, host, options: adapter.options, ...mode});
  return {
    /** @param {StreamMode} mode */
    async apply(mode) {
      if (![mode.width, mode.height, mode.fps].every(value => Number.isSafeInteger(value) && value > 0))
        throw Error('Invalid host display mode');
      if (applied?.width === mode.width && applied.height === mode.height && applied.fps === mode.fps) return;

      active = true;
      await request('apply', mode);
      applied = {...mode};
      log({event: 'host-display-applied', host, ...mode});
    },
    async restore() {
      if (!active) return;

      await request('restore');
      active = false;
      applied = null;
      log({event: 'host-display-restored', host});
    }
  };
}
