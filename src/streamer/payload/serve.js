import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {listenForPayload} from '../civ7/transport.js';
import {runApplication} from '../civ7/application.js';
import {prepareMoonlight} from './prepare.js';
import {createResourceLedger} from '../civ7/resources.js';
import {closeLeftAudioOut} from '../civ7/audio.js';
import {createRaster} from '../ui/raster.js';
import {createStartupTiming} from '../civ7/startup-timing.js';
import {migrateConfig} from '../ui/hosts.js';

/** @import {Civ7Rpc} from '../civ7/transport.js' */
/** @import {Host} from '../ui/model.js' */

/**
 * host.json, as build.js writes it.
 * @typedef {{host: string, port: number, token: string, transport?: 'tcp' | 'udp',
 *   hosts: Host[]}} HostConfiguration
 */

/** @param {unknown} error */
const errorText = error => String(/** @type {{message?: unknown}} */ (error).message || error);

/**
 * Ms since launch.js sent the payload, when it did within the last minute.
 * @param {string} bundle
 */
async function sinceLaunch(bundle) {
  try {
    const {sentAt} = JSON.parse(await fs.readFile(path.join(bundle, 'launched.json'), 'utf8'));
    const ms = Date.now() - sentAt;
    return ms >= 0 && ms < 60000 ? ms : null;
  } catch { return null; }
}

/**
 * Serves the bundle's Moonlight session to each payload that connects, until `signal` aborts.
 * @param {string} bundle
 * @param {AbortSignal} signal
 */
export async function serve(bundle, signal, log = (/** @type {object} */ event) => {}) {
  /** @type {HostConfiguration} */
  const configuration = JSON.parse(await fs.readFile(path.join(bundle, 'host.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'manifest.json'), 'utf8'));
  const runs = path.join(bundle, 'runs');
  await fs.mkdir(runs, {recursive: true, mode: 0o700});
  for (const file of manifest.files) {
    const bytes = await fs.readFile(path.join(bundle, file.path));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw Error('Moonlight bundle integrity check failed: ' + file.path);
  }
  migrateConfig();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, {once: true});
  /** @type {Awaited<ReturnType<typeof listenForPayload>> | undefined} */
  let listener;
  let state = 'starting';
  /** @type {string | null} */
  let activeRun = null;
  let connectionLost = false;
  const raster = createRaster();
  const health = http.createServer((request, response) => {
    if (request.url !== '/status' || request.method !== 'GET') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({id: manifest.id, pid: process.pid, state, run: activeRun, connectionLost}));
  });
  try {
    await new Promise((resolve, reject) => {
      health.once('error', reject);
      health.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    const endpoint = health.address();
    if (!endpoint || typeof endpoint === 'string') throw Error('Moonlight status listener failed');
    const stop = () => listener?.close();
    controller.signal.addEventListener('abort', stop);
    if (signal.aborted) abort();
    while (!controller.signal.aborted) {
      listener = await listenForPayload({port: configuration.port, token: configuration.token, timeoutMs: 60000});
      // An abort while the port was opening found no listener to close.
      if (controller.signal.aborted) break;

      state = 'waiting';
      await fs.writeFile(path.join(bundle, 'ready.json'), JSON.stringify({id: manifest.id, pid: process.pid, port: endpoint.port}));
      log({event: 'ready'});
      /** @type {Civ7Rpc | undefined} */
      let rpc;
      try {
        const session = rpc = await listener.connected;
        const timing = createStartupTiming({sentMs: await sinceLaunch(bundle), bridgeMs: session.bridgeMs});
        session.disconnected.then(error => {
          if (!session.connected && state === 'running') {
            connectionLost = true;
            state = 'connection-lost';
            log({event: 'connection-lost', message: error.message});
          }
        });
        const stamp = new Date().toISOString().replace(/[-:.]/g, '');
        const run = activeRun = path.join(runs, stamp);
        await fs.mkdir(run, {mode: 0o700});
        const record = (/** @type {object} */ event) => {
          const line = JSON.stringify({at: new Date().toISOString(), ...event});
          fs.appendFile(path.join(run, 'events.jsonl'), line + '\n').catch(() => {});
          log(event);
          const startup = timing.observe(/** @type {Record<string, unknown>} */ (event));
          if (startup) record(startup);
        };
        state = 'initializing';
        const resources = await createResourceLedger(session, path.join(bundle, 'resources.json'), record);
        await closeLeftAudioOut(session, record);
        await resources.reap();
        session.resources = resources;
        await session.initialize();
        timing.mark('initialized');
        session.resources = null;
        let prepared;
        try {
          prepared = await prepareMoonlight({rpc: session, directory: run,
            inspector: path.join(bundle, 'bin/nx2-modules'), log: record, mark: timing.mark,
            compatCache: path.join(bundle, 'compat-cache')});
        } finally {
          session.resources = resources;
        }
        const {menu, gpu} = prepared;
        timing.mark('prepared');
        state = 'running';
        await runApplication({rpc: session, directory: run, menu, gpu, hostAddress: configuration.host,
          helper: path.join(bundle, 'hbmoonlight'), hosts: configuration.hosts,
          signal: controller.signal, log: record, mark: timing.mark, raster, connectionLost,
          transport: configuration.transport === 'tcp' ? 'tcp' : 'udp'});
        connectionLost = false;
      } catch (error) {
        if (!controller.signal.aborted) log({event: 'session-failed', message: errorText(error)});
      } finally {
        state = 'cleanup';
        listener?.close();
        listener = undefined;
        if (rpc) {
          try { await rpc.close(); }
          catch (error) { log({event: 'cleanup-failed', message: errorText(error)}); }
        }
      }
    }
  } finally {
    listener?.close();
    health.closeAllConnections();
    health.close();
    signal.removeEventListener('abort', abort);
    await raster.close();
    await fs.rm(path.join(bundle, 'ready.json'), {force: true});
  }
}
