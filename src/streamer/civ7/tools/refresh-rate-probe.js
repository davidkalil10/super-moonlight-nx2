#!/usr/bin/env node
/**
 * Supervised panel rate probe on an existing payload bundle, with no Moonlight helper running:
 *     node src/streamer/civ7/tools/refresh-rate-probe.js --bundle BUNDLE --console IP --directory NEW_DIR
 */
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify, parseArgs} from 'node:util';
import {listenForPayload} from '../transport.js';
import {createResourceLedger} from '../resources.js';
import {createPresenter} from '../presentation.js';
import {createRefreshRate, PROBE_RATES} from '../refresh-rate.js';
import {runRefreshRateProbe} from '../refresh-rate-probe.js';
import {prepareMoonlight} from '../../payload/prepare.js';

const {values} = parseArgs({options: {
  bundle: {type: 'string'}, console: {type: 'string'}, directory: {type: 'string'},
  rates: {type: 'string', default: '60,120,90,75'}, seconds: {type: 'string', default: '1'},
  help: {type: 'boolean', short: 'h'}
}});

const USAGE = 'node src/streamer/civ7/tools/refresh-rate-probe.js --bundle BUNDLE --console IP ' +
  '--directory /media/storage2/builds/moonlight/NEW_RUN [--rates 60,120,90,75] [--seconds 1]';
const BUILDS = '/media/storage2/builds/moonlight';

/** @param {string} bundle */
async function helperRunning(bundle) {
  try {
    const ready = JSON.parse(await fs.readFile(path.join(bundle, 'ready.json'), 'utf8'));
    process.kill(ready.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sends the bundle's payload to the console loader, as launch.mjs does.
 * @param {string} bundle
 * @param {string} consoleHost
 */
async function sendPayload(bundle, consoleHost) {
  const payload = await fs.readFile(path.join(bundle, 'moonlight.js'));
  const socket = net.connect(9026, consoleHost);
  socket.setTimeout(10000);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.once('timeout', () => { socket.destroy(); reject(Error('Console connection timed out')); });
  });

  socket.setTimeout(0);
  socket.on('error', () => {});
  socket.end(payload);
  socket.unref();
}

if (values.help || !values.bundle || !values.console || !values.directory) {
  console.log(USAGE);
  if (!values.help) process.exitCode = 2;
} else {
  const rates = values.rates.split(',').map(Number);
  const seconds = Number(values.seconds);
  if (!rates.every(rate => rate === 60 || PROBE_RATES.includes(rate))) throw Error('Rates are 60, 75, 90 or 120');
  if (!(seconds >= 0.5 && seconds <= 2)) throw Error('Expected --seconds 0.5-2');
  if (!net.isIPv4(values.console)) throw Error('Expected a console IPv4 address');

  const bundle = path.resolve(values.bundle);
  const directory = path.resolve(values.directory);
  const relative = path.relative(BUILDS, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw Error('Choose a new directory under ' + BUILDS);
  if (await helperRunning(bundle)) throw Error('The bundle helper is running; stop it before probing');

  const configuration = JSON.parse(await fs.readFile(path.join(bundle, 'host.json'), 'utf8'));
  await fs.mkdir(directory, {mode: 0o700});
  const journal = await fs.open(path.join(directory, 'events.jsonl'), 'wx', 0o600);
  const git = (/** @type {string[]} */ args) => promisify(execFile)('git', args, {cwd: import.meta.dirname});
  const report = {sourceRevision: (await git(['rev-parse', 'HEAD'])).stdout.trim(),
    dirty: Boolean((await git(['status', '--porcelain'])).stdout), command: process.argv.slice(1),
    bundle, builder: os.hostname(), started: new Date().toISOString(), completed: '', status: 'running',
    error: '', results: /** @type {object[]} */ ([])};
  const save = () => fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n',
    {mode: 0o600});
  let writes = Promise.resolve();
  /** @param {object} event */
  const log = event => {
    const line = JSON.stringify({at: new Date().toISOString(), ...event}) + '\n';
    writes = writes.then(() => journal.write(line)).then(() => {}, () => {});
  };

  /** @type {Awaited<ReturnType<typeof listenForPayload>> | undefined} */
  let listener;
  /** @type {import('../transport.js').Civ7Rpc | undefined} */
  let rpc;
  /** @type {Awaited<ReturnType<typeof createPresenter>> | undefined} */
  let presenter;
  /** @type {ReturnType<typeof createRefreshRate> | undefined} */
  let controller;
  try {
    await save();
    listener = await listenForPayload({port: configuration.port, token: configuration.token, timeoutMs: 60000});
    await sendPayload(bundle, values.console);
    const session = rpc = await listener.connected;
    const resources = await createResourceLedger(session, path.join(bundle, 'resources.json'), log);
    await resources.reap();
    session.resources = resources;
    await session.initialize();
    session.resources = null;
    let prepared;
    try {
      prepared = await prepareMoonlight({rpc: session, directory, inspector: path.join(bundle, 'bin/nx2-modules'),
        log, compatCache: path.join(bundle, 'compat-cache')});
    } finally {
      session.resources = resources;
    }

    const shown = presenter = await createPresenter(session, directory, prepared.menu, prepared.gpu);
    controller = createRefreshRate(session, {directory, log, rates: PROBE_RATES,
      present: async () => (await shown.run(3)).frames});
    await controller.cleanup();
    const results = await runRefreshRateProbe({controller, rates, seconds, log,
      present: (frames, options) => shown.run(frames, undefined, options)});
    report.results = results;
    const failed = results.find(result => result.verdict === 'error');
    report.status = failed ? 'stopped' : 'complete';
    if (failed) {
      report.error = failed.rate + ': ' + failed.error;
      process.exitCode = 1;
    }
    for (const result of results) console.log(JSON.stringify(result));
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await controller?.close().catch(error => log({event: 'restore-failed', message: String(error)}));
    await presenter?.close().catch(() => {});
    if (rpc?.connected) await rpc.close().catch(() => {});
    listener?.close();
    report.completed = new Date().toISOString();
    await save();
    await writes;
    await journal.close();
    console.log(JSON.stringify({directory, status: report.status, error: report.error}));
  }
}
