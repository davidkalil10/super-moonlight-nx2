/**
 * The host side of the console Moonlight UI: publishes the pages of ui-pages.js into the
 * private storage of the running Moonlight app, reads the commands the console writes back and
 * drives the helper and the stream child from the state machine in ui-model.js.
 *
 *   node tools/moonlight/ui-service.js [RUN_DIR]
 *
 * The console owns the cursor, the overlay and the command words; this service owns the pages,
 * the epoch and sequence, hostAck and hostBusy. It exits when the Moonlight app leaves the
 * console (app-runtime.json) or on SIGINT/SIGTERM, writing magic 0 so the console shows the
 * static splash again.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {spawn, execFileSync} from 'node:child_process';
import {UI, UI_MAGIC, UI_OP, MEMORY_BYTES} from './ring.js';
import {COMMAND_READ, serialize, pageAddress, hostWords, readCommand} from './ui-page.js';
import {makeModel, reduce} from './ui-model.js';
import {createPages} from './ui-pages.js';
import {createRaster} from './ui-raster.js';
import * as uiSettings from './ui-settings.js';
import {hostsFile, loadHosts, seedHosts, saveHosts, parseList} from './menu.js';
import {HELPER} from './helper.js';
import {findPrivateStorage} from './feed.js';
import * as session from '../../../hbl-platform/sdk/host/session.js';
import * as cli from '../../../hbl-platform/sdk/cli.js';

const OP_NAME = Object.fromEntries(Object.entries(UI_OP).map(([name, op]) => [op, name]));
const RUNS = '/media/storage2/builds/HBLauncher/ui-service';
const POLL_MS = {idle: 50, streaming: 250};
const APPLY_TIMEOUT_MS = 5000;
const HELPER_TIMEOUT_MS = 20000;
const STOP_GRACE_MS = 10000;
const RUNTIME_CHECK_MS = 500;

const u32 = value => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Children the service starts: the helper for list, pair and quit, live.js for the stream.
 * Each returns {exited, cancel, lines} so the service never waits on a process object.
 * @param {{spawnProcess?: typeof spawn, helperPath?: string, liveScript?: string}} options
 */
function createChildren({
  spawnProcess = spawn,
  helperPath = HELPER,
  liveScript = path.join(import.meta.dirname, 'live.js')
} = {}) {
  function wrap(child, {onLine, collect}) {
    let out = '';
    let err = '';
    if (collect) {
      child.stdout.on('data', chunk => (out += chunk));
      child.stderr.on('data', chunk => (err += chunk));
    } else {
      readline.createInterface({input: child.stdout}).on('line', line => onLine('stdout', line));
      readline.createInterface({input: child.stderr}).on('line', line => onLine('stderr', line));
    }
    const exited = new Promise(resolve => {
      child.on('close', (code, signal) => resolve({code, signal, out, err}));
      child.on('error', error => resolve({code: -1, signal: null, out, err: error.message}));
    });
    return {exited, cancel: (signal = 'SIGINT') => child.kill(signal)};
  }
  return {
    helper: args =>
      wrap(spawnProcess(helperPath, args, {stdio: ['ignore', 'pipe', 'pipe']}), {collect: true}),
    pair: (address, onLine) =>
      wrap(spawnProcess(helperPath, ['pair', address], {stdio: ['ignore', 'pipe', 'pipe']}), {
        onLine
      }),
    stream: (directory, host, app, args, onLine) =>
      wrap(
        spawnProcess(
          process.execPath,
          [liveScript, directory, '--moonlight', host.address, String(app.id), ...args],
          {stdio: ['ignore', 'pipe', 'pipe']}
        ),
        {onLine}
      )
  };
}

/**
 * @param {object} options
 * @param {{read: (address: number, length: number) => Promise<Buffer>,
 *   write: (address: number, bytes: Buffer) => Promise<void>}} options.memory
 * @param {number} options.mapped Private storage base of the Moonlight app.
 * @param {ReturnType<typeof createPages>} options.pages
 * @param {ReturnType<typeof createChildren>} options.children
 * @param {string} options.directory The launcher run directory, for live.js and the exit watch.
 * @param {() => import('./ui-model.js').Host[]} options.readHosts
 * @param {(settings: object) => void} options.saveSettings
 * @param {object} options.settings
 * @param {(event: object) => void} [options.log]
 * @param {number} [options.epoch]
 * @param {() => string | null} [options.activeApp] The app the console runs, null when unknown.
 * @param {{apply?: number, helper?: number, stop?: number}} [options.timeouts]
 */
function createService({
  memory,
  mapped,
  pages,
  children,
  directory,
  readHosts,
  saveSettings,
  settings,
  log = () => {},
  epoch = Math.floor(Date.now() / 1000) >>> 0,
  activeApp = () => readActiveApp(directory),
  timeouts = {}
}) {
  const apply = timeouts.apply ?? APPLY_TIMEOUT_MS,
    helperLimit = timeouts.helper ?? HELPER_TIMEOUT_MS,
    stopGrace = timeouts.stop ?? STOP_GRACE_MS;
  let model = makeModel(readHosts(), settings);
  let sequence = 0;
  let published = null;
  let seen = 0;
  let stopped = false;
  let generation = 0;
  let current = null;
  let stream = null;
  let quitResult = null;
  let covers = new Map();
  let chain = Promise.resolve();
  let queue = Promise.resolve();

  const word = address => memory.read(mapped + address, 4).then(bytes => bytes.readUInt32LE(0));
  const transfer = work => (chain = chain.then(work, work));
  const writeWord = (address, value) => transfer(() => memory.write(mapped + address, u32(value)));

  async function publish() {
    const page = await pages.page(model, covers);
    if (!page) return;
    const same = published && serialize({...page, epoch, sequence}).equals(published);
    if (same) return;
    const next = sequence + 1 || 1;
    const bytes = serialize({...page, epoch, sequence: next});
    await transfer(() => memory.write(pageAddress(mapped, next & 1), bytes));
    await transfer(() =>
      memory.write(
        mapped + UI.uiMagic,
        hostWords({magic: UI_MAGIC, epoch, sequence: next, page: next & 1})
      )
    );
    sequence = next;
    published = bytes;
    log({event: 'published', screen: model.screen, sequence, bytes: bytes.length});
    const deadline = Date.now() + apply;
    while ((await transfer(() => word(UI.uiApplied))) !== sequence) {
      if (Date.now() > deadline) {
        const header = await transfer(() => memory.read(mapped + UI.uiMagic, 72));
        log({
          event: 'apply-timeout',
          sequence,
          header: [...new Uint32Array(header.buffer, header.byteOffset, 18)]
        });
        return;
      }
      await sleep(5);
    }
  }

  /** Model events run one at a time; intents start their work and come back through dispatch. */
  function dispatch(event) {
    queue = queue.then(async () => {
      if (stopped) return;
      const result = reduce(model, event);
      const changed = result.model !== model;
      model = result.model;
      log({event: 'model', type: event.type, screen: model.screen});
      for (const intent of result.intents)
        run(intent).catch(error =>
          log({event: 'intent-failed', type: intent.type, message: error.message})
        );
      if (changed) await publish();
    });
    return queue;
  }

  async function busy(work) {
    await writeWord(UI.hostBusy, 1);
    try {
      return await work();
    } finally {
      await writeWord(UI.hostBusy, 0);
    }
  }

  /** A helper call bounded in time; a hung helper is killed and reported as such. */
  async function helper(args) {
    const child = children.helper(args);
    current = child;
    const timer = setTimeout(() => child.cancel('SIGKILL'), helperLimit);
    const result = await child.exited;
    clearTimeout(timer);
    if (current === child) current = null;
    if (result.signal === 'SIGKILL') result.err += '\nhelper timed out';
    log({event: 'helper', args: args.slice(0, 2), code: result.code, signal: result.signal});
    return result;
  }

  function helperMessage(result, fallback) {
    const line = result.err.split('\n').find(text => text.includes('"event":"error"'));
    try {
      return JSON.parse(line).message || fallback;
    } catch {
      return /timed out/.test(result.err) ? 'The helper timed out' : fallback;
    }
  }

  async function list(host, token) {
    const result = await busy(() => helper(['list', host.address]));
    if (token !== generation) return;
    if (result.code === 0) {
      const listed = parseList(result.out);
      let message = null;
      if (quitResult === 'cancelled')
        message =
          listed.currentGame === 0
            ? 'Quit confirmed'
            : 'Quit failed: the host game is still running';
      else if (quitResult) message = quitResult;
      quitResult = null;
      await dispatch({type: 'listed', ...listed, message});
    } else if (/not paired/.test(result.err)) await dispatch({type: 'notPaired'});
    else if (result.signal === 'SIGINT') return;
    else {
      quitResult = null;
      await dispatch({
        type: 'failed',
        message: helperMessage(result, 'Cannot reach ' + host.name),
        back: 'hosts'
      });
    }
  }

  async function pair(host, token) {
    const child = children.pair(host.address, (channel, line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.event === 'pin') dispatch({type: 'pin', pin: event.pin, url: event.url});
      if (event.event === 'error')
        log({event: 'pair-error', message: event.message, detail: event.detail});
    });
    current = child;
    const result = await busy(() => child.exited);
    if (current === child) current = null;
    if (token !== generation || result.signal === 'SIGINT') return;
    if (result.code === 0) await dispatch({type: 'paired'});
    else await dispatch({type: 'failed', message: 'Pairing did not complete', back: 'hosts'});
  }

  function launch(host, app, streamSettings, token) {
    const child = children.stream(
      directory,
      host,
      app,
      uiSettings.streamArgs(streamSettings),
      (channel, line) => {
        if (channel === 'stdout') return log({event: 'stream-stats', line});
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return log({event: 'stream-line', line});
        }
        if (event.event === 'connected') dispatch({type: 'streamStarted'});
        else if (event.event === 'log' && event.message)
          dispatch({type: 'stage', message: event.message});
        else if (event.event === 'error') log({event: 'stream-error', ...event});
      }
    );
    stream = child;
    child.exited.then(async result => {
      if (stream === child) stream = null;
      log({event: 'stream-exit', code: result.code, signal: result.signal});
      if (token !== generation) return;
      if (model.screen === 'launching' && result.code !== 0 && !result.signal)
        await dispatch({
          type: 'failed',
          message: 'The stream did not start (exit ' + result.code + ')',
          back: 'apps'
        });
      else await dispatch({type: 'streamEnded'});
    });
  }

  async function stopStream() {
    const child = stream;
    if (!child) return;
    if (!child.stopping) {
      child.cancel('SIGINT');
      const timer = setTimeout(() => child.cancel('SIGKILL'), stopGrace);
      child.stopping = child.exited.then(() => clearTimeout(timer));
    }
    await child.stopping;
  }

  async function quit(host, token) {
    await stopStream();
    const result = await busy(() => helper(['quit', host.address]));
    if (token !== generation) return;
    quitResult =
      result.code === 0 ? 'cancelled' : 'Quit failed: ' + helperMessage(result, 'the host refused');
    await dispatch({type: 'quitDone'});
  }

  async function run(intent) {
    const token = generation;
    switch (intent.type) {
      case 'list':
        return list(intent.host, token);
      case 'pair':
        return pair(intent.host, token);
      case 'cancelList':
      case 'cancelPair':
        generation++;
        quitResult = null;
        return current?.cancel('SIGINT');
      case 'covers':
        covers = await coverTiles(intent.host, intent.apps);
        return publish();
      case 'launch':
        return launch(intent.host, intent.app, intent.settings, token);
      case 'stopStream':
        return stopStream();
      case 'quitHost':
        return quit(intent.host, token);
      case 'saveSettings':
        return saveSettings(model.settings);
      case 'refreshHosts':
        return dispatch({type: 'hosts', hosts: readHosts()});
      case 'pauseInput':
      case 'resumeInput':
        return log({event: intent.type});
      case 'exit':
        stopped = true;
        return;
      default:
        return log({event: 'unknown-intent', type: intent.type});
    }
  }

  /** Covers arrive with the helper's `list --covers`; until then every app gets a letter tile. */
  async function coverTiles(host, apps) {
    const tiles = new Map();
    for (const app of apps)
      if (app.cover) tiles.set(app.id, pages.cover(host.address + ':' + app.id, app.cover));
    return tiles;
  }

  async function attach() {
    const block = await transfer(() => memory.read(mapped + UI.uiMagic, 72));
    const stale = block.readUInt32LE(UI.uiApplied - UI.uiMagic);
    seen = block.readUInt32LE(UI.cmdSequence - UI.uiMagic);
    await transfer(() =>
      memory.write(mapped + UI.uiMagic, hostWords({magic: 0, epoch: 0, sequence: 0, page: 0}))
    );
    await writeWord(UI.hostBusy, 0);
    sequence = stale;
    log({event: 'attach', epoch, staleApplied: stale, seen});
    await dispatch({type: 'attached'});
  }

  async function poll() {
    const bytes = await transfer(() =>
      memory.read(mapped + COMMAND_READ.offset, COMMAND_READ.bytes)
    );
    const {command} = readCommand(bytes);
    if (command.sequence === seen) return;
    seen = command.sequence;
    await writeWord(UI.hostAck, command.sequence);
    const op = OP_NAME[command.op];
    if (!op || command.epoch !== epoch || command.page !== sequence) {
      log({event: 'command-dropped', ...command, expected: {epoch, page: sequence}});
      return;
    }
    log({event: 'command', op, item: command.item, value: command.value});
    await dispatch({type: 'command', op, item: command.item, value: command.value});
  }

  async function detach() {
    stopped = true;
    generation++;
    current?.cancel('SIGINT');
    await stopStream();
    await transfer(() =>
      memory.write(mapped + UI.uiMagic, hostWords({magic: 0, epoch: 0, sequence: 0, page: 0}))
    ).catch(() => {});
    log({event: 'detach'});
  }

  async function start() {
    await attach();
    let runtimeChecked = 0;
    while (!stopped) {
      const now = Date.now();
      if (now - runtimeChecked > RUNTIME_CHECK_MS) {
        runtimeChecked = now;
        const active = activeApp();
        if (active !== null && active !== 'moonlight') {
          log({event: 'app-gone', active});
          await dispatch({type: 'appGone'});
          break;
        }
      }
      await poll();
      await sleep(model.screen === 'streaming' ? POLL_MS.streaming : POLL_MS.idle);
    }
    await detach();
  }

  return {
    start,
    stop: detach,
    attach,
    poll,
    dispatch: event => dispatch(event),
    model: () => model,
    state: () => ({epoch, sequence, seen})
  };
}

function readActiveApp(directory) {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(directory, 'app-runtime.json'), 'utf8')).active?.id ??
      null
    );
  } catch {
    return null;
  }
}

function openRun(directory, rpc) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const output = path.join(RUNS, stamp + '-' + (rpc.a?.session ?? path.basename(directory)));
  fs.mkdirSync(output, {recursive: true});
  let revision = null;
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      encoding: 'utf8'
    }).trim();
  } catch {}
  fs.writeFileSync(
    path.join(output, 'manifest.json'),
    JSON.stringify(
      {
        session: rpc.a?.session ?? null,
        runDirectory: directory,
        sourceRevision: revision,
        builder: os.hostname(),
        command: process.argv,
        started: new Date().toISOString()
      },
      null,
      2
    ) + '\n'
  );
  const events = path.join(output, 'events.jsonl');
  return {
    output,
    log(event) {
      const line = JSON.stringify({at: new Date().toISOString(), ...event});
      fs.appendFileSync(events, line + '\n', {mode: 0o600});
      if (event.event !== 'stream-stats') console.error(line);
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const directory = session.resolve(args[0] && !args[0].startsWith('--') ? args[0] : undefined);
  const rpc = session.rpc(directory);
  const storage = await findPrivateStorage(directory);
  if (storage.bytes < MEMORY_BYTES)
    throw Error('The running Moonlight app predates the console UI; rebuild and reinstall it');
  const hosts = hostsFile();
  const hostList = seedHosts(
    loadHosts(hosts),
    args.filter(arg => /^\d+\.\d+\.\d+\.\d+$/.test(arg))
  );
  saveHosts(hosts, hostList);
  const settingsFile = uiSettings.settingsFile();
  const run = openRun(directory, rpc);
  const raster = createRaster();
  const service = createService({
    memory: rpc,
    mapped: storage.mapped,
    pages: createPages(raster),
    children: createChildren(),
    directory,
    readHosts: () => seedHosts(loadHosts(hosts)),
    saveSettings: settings => uiSettings.save(settingsFile, settings),
    settings: uiSettings.load(settingsFile),
    log: run.log
  });
  const stop = () => service.stop();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.error('ui-service: run ' + run.output);
  try {
    await service.start();
  } finally {
    raster.close();
  }
}

export {createService, createChildren, readActiveApp};

if (cli.isMain(import.meta))
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
