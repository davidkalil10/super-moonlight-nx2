/**
 * The host side of the console Moonlight UI: publishes the pages of pages.js into the
 * private storage of the running Moonlight app, reads the commands the console writes back and
 * drives the helper and the stream child from the state machine in model.js.
 *
 *   node host/ui/service.js [RUN_DIR]
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
import {UI, UI_MAGIC, UI_OP, MEMORY_BYTES} from '../../tools/moonlight/ring.js';
import {MAGIC, COMMAND_READ, serialize, pageAddress, hostWords, readCommand} from './page.js';
import {makeModel, reduce} from './model.js';
import {createPages} from './pages.js';
import {createRaster} from './raster.js';
import * as uiSettings from './settings.js';
import {hostsFile, loadHosts, seedHosts, saveHosts, parseList} from './hosts.js';
import {discover, merge} from './discover.js';
import {HELPER} from '../stream/helper.js';
import {findPrivateStorage} from '../../tools/moonlight/feed.js';
import * as session from '../../../hbl-platform/sdk/host/session.js';
import * as cli from '../../../hbl-platform/sdk/cli.js';

/** UI_OP backwards: the op name of each command word. */
const OP_NAME = Object.fromEntries(Object.entries(UI_OP).map(([name, op]) => [op, name]));
/** Where each service run keeps its manifest and events.jsonl. */
const RUNS = process.env.HBL_UI_RUNS || '/media/storage2/builds/HBLauncher/ui-service';
/** live.js prefixes the helper lines it does not parse; the JSON events come through bare. */
const RELAYED = /^hbmoonlight /;
/** Command poll interval; a stream needs the bus more than the menu does. */
const POLL_MS = {idle: 50, streaming: 250};
/** How long the console has to apply a published page before it counts as stalled. */
const APPLY_TIMEOUT_MS = 5000;
/** Rewrites of a reverted header before publish moves on. */
const HEADER_TRIES = 3;
/** The host header and uiApplied, read together while waiting for the apply. */
const HEADER_READ = UI.uiApplied - UI.uiMagic + 4;
/** The whole UI block, uiMagic through hostBusy. */
const UI_BLOCK_BYTES = UI.hostBusy - UI.uiMagic + 4;
/** A helper call slower than this is killed; quit gets three times as long. */
const HELPER_TIMEOUT_MS = 20000;
/** Time live.js gets to stop on SIGINT before it is killed. */
const STOP_GRACE_MS = 10000;
/** How often the poll loop checks app-runtime.json for the active app. */
const RUNTIME_CHECK_MS = 500;
/** Every child gets its stdout and stderr piped, nothing on stdin. */
const PIPED = ['ignore', 'pipe', 'pipe'];

/** One little-endian 32-bit word. */
function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Host words with magic 0: the console drops the pages and shows the static splash. */
function splashHeader() {
  return hostWords({magic: 0, epoch: 0, sequence: 0, page: 0});
}

/**
 * Children the service starts: the helper for list, pair and quit, live.js for the stream.
 * Each returns {exited, cancel, lines} so the service never waits on a process object.
 * @param {{spawnProcess?: typeof spawn, helperPath?: string, liveScript?: string}} options
 */
function createChildren({
  spawnProcess = spawn,
  helperPath = HELPER,
  liveScript = path.join(import.meta.dirname, '../stream/live.js')
} = {}) {
  /** Collects the output for exited, or hands each line to onLine as it arrives. */
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

  const start = (file, args) => spawnProcess(file, args, {stdio: [...PIPED]});

  return {
    helper: args => wrap(start(helperPath, args), {collect: true}),
    pair: (address, onLine) => wrap(start(helperPath, ['pair', address]), {onLine}),
    stream: (directory, host, app, args, onLine) => {
      const liveArgs = [liveScript, directory, '--moonlight', host.address, String(app.id)];
      return wrap(start(process.execPath, [...liveArgs, ...args]), {onLine});
    }
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
 * @param {() => import('./model.js').Host[]} options.readHosts
 * @param {(hosts: import('./model.js').Host[]) => void} [options.writeHosts] Saves a merged list.
 * @param {() => Promise<{name: string, address: string}[]>} [options.discoverHosts] mDNS, bounded.
 * @param {(settings: object) => void} options.saveSettings
 * @param {object} options.settings
 * @param {string | null} [options.coversDir] Where the helper caches box art; null for letter
 *   tiles only.
 * @param {(event: object) => void} [options.log]
 * @param {number} [options.epoch] Start time in seconds, at least one above the epoch of the page
 *   the console still shows, so a restart inside one second still resets cursor and overlay.
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
  writeHosts = () => {},
  discoverHosts = () => discover(),
  saveSettings,
  settings,
  coversDir = null,
  log = () => {},
  epoch = Math.floor(Date.now() / 1000) >>> 0,
  activeApp = () => readActiveApp(directory),
  timeouts = {}
}) {
  const applyLimit = timeouts.apply ?? APPLY_TIMEOUT_MS;
  const helperLimit = timeouts.helper ?? HELPER_TIMEOUT_MS;
  const stopGrace = timeouts.stop ?? STOP_GRACE_MS;

  let model = makeModel(readHosts(), settings);
  let sequence = 0;
  let published = null;
  let seen = 0;
  let applied = 0;
  let stalled = false;
  let stopped = false;
  /** @type {Promise<void> | undefined} */
  let detaching;
  /** Bumped on cancel and detach; a result from an older generation is dropped. */
  let generation = 0;
  let current = null;
  let stream = null;
  let quitResult = null;
  let covers = new Map();
  /** Every memory transfer, in order. */
  let chain = Promise.resolve();
  /** Every model event and publish, in order. */
  let queue = Promise.resolve();

  const transfer = work => (chain = chain.then(work, work));
  const writeWord = (address, value) => transfer(() => memory.write(mapped + address, u32(value)));

  /**
   * Reads the header back and writes it again while it differs. The console can write back the
   * sector the header shares with its own words from an older copy, restoring the previous
   * sequence before the shader applies the new one.
   * @param {Buffer} header @param {number} since
   */
  async function keepHeader(header, since) {
    for (let tries = 0; tries < HEADER_TRIES; tries++) {
      const back = await transfer(() => memory.read(mapped + UI.uiMagic, header.length));
      if (back.equals(header)) return;

      log({
        event: 'header-rewrite',
        sequence: header.readUInt32LE(8),
        reverted: [0, 4, 8, 12].map(offset => back.readUInt32LE(offset)),
        ms: Date.now() - since
      });
      await transfer(() => memory.write(mapped + UI.uiMagic, header));
    }
  }

  /** The sequence after this one: never 0, and never on the page the console last applied. */
  function nextSequence() {
    let next = (sequence + 1) >>> 0 || 1;
    if ((next & 1) === (applied & 1) && applied !== 0) next = (next + 1) >>> 0 || 1;
    return next;
  }

  /** Publishes the page of the model; `again` republishes one the console never applied. */
  async function publish(again = false) {
    const page = await pages.page(model, covers);
    if (!page) return;
    const same = published && serialize({...page, epoch, sequence}).equals(published);
    if ((same && !again) || stopped) return;

    const next = nextSequence();
    const bytes = serialize({...page, epoch, sequence: next});
    const header = hostWords({magic: UI_MAGIC, epoch, sequence: next, page: next & 1});
    await transfer(() => memory.write(pageAddress(mapped, next & 1), bytes));
    await transfer(() => memory.write(mapped + UI.uiMagic, header));
    const since = Date.now();
    await keepHeader(header, since);

    sequence = next;
    published = bytes;
    stalled = false;
    log({event: 'published', screen: model.screen, sequence, bytes: bytes.length});

    const deadline = since + applyLimit;
    for (;;) {
      const block = await transfer(() => memory.read(mapped + UI.uiMagic, HEADER_READ));
      applied = block.readUInt32LE(UI.uiApplied - UI.uiMagic);
      if (applied === sequence) break;
      if (!block.subarray(0, header.length).equals(header)) await keepHeader(header, since);

      if (Date.now() > deadline) {
        const dump = await transfer(() => memory.read(mapped + UI.uiMagic, UI_BLOCK_BYTES));
        log({
          event: 'apply-timeout',
          sequence,
          header: [...new Uint32Array(dump.buffer, dump.byteOffset, UI_BLOCK_BYTES / 4)]
        });
        stalled = true;
        return;
      }
      await sleep(5);
    }
  }

  /** Everything that publishes runs through one queue, in order. */
  function enqueue(work) {
    queue = queue.then(work, work);
    return queue;
  }

  /** Model events run one at a time; intents start their work and come back through dispatch. */
  function dispatch(event) {
    return enqueue(async () => {
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
  }

  /** Runs `work` with hostBusy raised, so the console shows the host is working. */
  async function busy(work) {
    await writeWord(UI.hostBusy, 1);
    try {
      return await work();
    } finally {
      await writeWord(UI.hostBusy, 0);
    }
  }

  /** A helper call bounded in time; a hung helper is killed and reported as such. */
  async function helper(args, limit = helperLimit) {
    const child = children.helper(args);
    current = child;
    const timer = setTimeout(() => child.cancel('SIGKILL'), limit);
    const result = await child.exited;
    clearTimeout(timer);
    if (current === child) current = null;

    if (result.signal === 'SIGKILL') result.err += '\nhelper timed out';
    const error = result.code ? helperError(result) : null;
    log({
      event: 'helper',
      args: args.slice(0, 2),
      code: result.code,
      signal: result.signal,
      ...(error && {error})
    });
    return result;
  }

  /** The helper's own error line ({message, stage, detail}), or null when it wrote none. */
  function helperError(result) {
    const line = result.err.split('\n').find(text => text.includes('"event":"error"'));
    try {
      const {event, ...error} = JSON.parse(line);
      return error;
    } catch {
      return null;
    }
  }

  /** The message to show for a failed helper call. */
  function helperMessage(result, fallback) {
    const error = helperError(result);
    if (error) return error.message || fallback;
    return /timed out/.test(result.err) ? 'The helper timed out' : fallback;
  }

  /** What the app list says about the last quit, if there was one. */
  function quitMessage(currentGame) {
    if (quitResult === 'cancelled')
      return currentGame === 0 ? 'Quit confirmed' : 'Quit failed: the host game is still running';
    if (quitResult && currentGame === 0)
      return 'Host closed the game on its own; the quit request failed';
    if (quitResult) return quitResult;
    return null;
  }

  async function list(host, token) {
    const covers = coversDir ? ['--covers', coversDir] : [];
    const result = await busy(() => helper(['list', host.address, ...covers]));
    if (token !== generation) return;

    if (result.code === 0) {
      const listed = parseList(result.out);
      const message = quitMessage(listed.currentGame);
      quitResult = null;
      await dispatch({type: 'listed', ...listed, message});
    } else if (/not paired/.test(result.err)) {
      await dispatch({type: 'notPaired'});
    } else if (result.signal !== 'SIGINT') {
      quitResult = null;
      await dispatch({
        type: 'failed',
        message: helperMessage(result, 'Cannot reach ' + host.name),
        back: 'hosts'
      });
    }
  }

  async function pair(host, token) {
    let pairError = null;

    const onLine = (channel, line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.event === 'pin') dispatch({type: 'pin', pin: event.pin, url: event.url});
      if (event.event === 'error') {
        pairError = event.message;
        log({event: 'pair-error', message: event.message, detail: event.detail});
      }
    };

    const child = children.pair(host.address, onLine);
    current = child;
    const result = await busy(() => child.exited);
    if (current === child) current = null;
    if (token !== generation || result.signal === 'SIGINT') return;

    if (result.code === 0) await dispatch({type: 'paired'});
    else
      await dispatch({
        type: 'failed',
        message: 'Pairing failed: ' + (pairError ?? 'the helper exited ' + result.code),
        back: 'hosts'
      });
  }

  /** Logs each live.js line and turns its events into model events. */
  function onStreamLine(channel, line) {
    if (channel === 'stdout') return log({event: 'stream-stats', line});

    let event;
    try {
      event = JSON.parse(line.replace(RELAYED, ''));
    } catch {
      return log({event: 'stream-line', line});
    }
    log({...event, event: 'stream-event', name: event.event});

    if (event.event === 'connected') dispatch({type: 'streamStarted'});
    else if (event.event === 'console-stalled')
      dispatch({
        type: 'failed',
        message: 'The console stopped answering, so the stream was stopped',
        back: 'apps'
      });
    else if (event.event === 'log' && event.message)
      dispatch({type: 'stage', message: event.message});
  }

  function launch(host, app, streamSettings, token) {
    const args = uiSettings.streamArgs(streamSettings);
    const child = children.stream(directory, host, app, args, onStreamLine);
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

  /** Stops live.js once, however many callers ask: SIGINT, then SIGKILL after the grace. */
  async function stopStream() {
    const child = stream;
    if (!child) return;

    if (!child.stopping) {
      child.cancel('SIGINT');
      const timer = setTimeout(() => child.cancel('SIGKILL'), stopGrace);
      child.stopping = busy(() => child.exited).then(() => clearTimeout(timer));
    }
    await child.stopping;
  }

  async function quit(host, token) {
    await stopStream();
    const result = await busy(() => helper(['quit', host.address], helperLimit * 3));
    if (token !== generation) return;

    const cancelled = result.code === 0;
    log({event: 'quit', host: host.address, cancelled, code: result.code, signal: result.signal});
    quitResult = cancelled
      ? 'cancelled'
      : 'Quit failed: ' + helperMessage(result, 'the host refused');
    await dispatch({type: 'quitDone'});
  }

  /** Carries out one intent of the model. */
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
        return enqueue(publish);
      case 'launch':
        return launch(intent.host, intent.app, intent.settings, token);
      case 'stopStream':
        return stopStream();
      case 'quitHost':
        return quit(intent.host, token);
      case 'saveSettings':
        return saveSettings(model.settings);
      case 'refreshHosts':
        return refreshHosts();
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

  /**
   * The manual list first, then what mDNS found: new hosts are appended and saved, nothing
   * manual is touched, and the hosts page follows when the list changed.
   */
  async function refreshHosts() {
    let found = [];
    try {
      found = await discoverHosts();
    } catch (error) {
      log({event: 'discover-failed', message: error.message});
    }

    const manual = readHosts();
    const hosts = merge(manual, found);
    log({event: 'discovered', found: found.length, added: hosts.length - manual.length});

    if (hosts.length !== manual.length) writeHosts(hosts);
    if (JSON.stringify(hosts) !== JSON.stringify(model.hosts))
      await dispatch({type: 'hosts', hosts});
  }

  /** Covers arrive with the helper's `list --covers`; until then every app gets a letter tile. */
  async function coverTiles(host, apps) {
    const tiles = new Map();
    for (const app of apps)
      if (app.cover) tiles.set(app.id, pages.cover(host.address + ':' + app.id, app.cover));
    return tiles;
  }

  /**
   * Takes over from whatever the console still shows: picks an epoch above the shown page's,
   * acknowledges the pending command and clears the header until the first publish.
   */
  async function attach() {
    const block = await transfer(() => memory.read(mapped + UI.uiMagic, UI_BLOCK_BYTES));
    const stale = block.readUInt32LE(UI.uiApplied - UI.uiMagic);
    const shown = block.readUInt32LE(UI.uiShown - UI.uiMagic) & 1;
    const header = await transfer(() => memory.read(pageAddress(mapped, shown), 8));
    if (header.readUInt32LE(0) === MAGIC)
      epoch = Math.max(epoch, (header.readUInt32LE(4) + 1) >>> 0) || 1;

    seen = block.readUInt32LE(UI.cmdSequence - UI.uiMagic);
    applied = stale;
    await transfer(() => memory.write(mapped + UI.uiMagic, splashHeader()));
    await writeWord(UI.hostBusy, 0);
    await writeWord(UI.hostAck, seen);
    sequence = stale;

    log({event: 'attach', epoch, staleApplied: stale, seen});
    await dispatch({type: 'attached'});
    refreshHosts().catch(error => log({event: 'discover-failed', message: error.message}));
  }

  /** One command read: acknowledges a new command and dispatches it if it is for this page. */
  async function poll() {
    if (stalled) await enqueue(() => publish(true));

    const bytes = await transfer(() =>
      memory.read(mapped + COMMAND_READ.offset, COMMAND_READ.bytes)
    );
    const read = readCommand(bytes);
    const {command} = read;
    applied = read.applied;
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

  /** Runs once: the poll loop and stop() both end in it. */
  function detach() {
    detaching ??= release();
    return detaching;
  }

  /** Cancels the children, drains the queue and hands the console back to the splash. */
  async function release() {
    stopped = true;
    generation++;
    current?.cancel('SIGINT');
    await queue.catch(() => {});
    await stopStream();
    await transfer(() => memory.write(mapped + UI.uiMagic, splashHeader())).catch(() => {});
    log({event: 'detach'});
  }

  /** Attaches, polls until stopped or the Moonlight app is gone, then detaches. */
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

/** The id of the app the launcher runs, from app-runtime.json, or null when unknown. */
function readActiveApp(directory) {
  try {
    const runtime = JSON.parse(fs.readFileSync(path.join(directory, 'app-runtime.json'), 'utf8'));
    return runtime.active?.id ?? null;
  } catch {
    return null;
  }
}

/** The source revision of this checkout, or null outside git. */
function sourceRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      encoding: 'utf8'
    }).trim();
  } catch {
    return null;
  }
}

/**
 * A new directory under RUNS with the manifest of this run, and the log that appends to its
 * events.jsonl and echoes all but the stream stats to stderr.
 */
function openRun(directory, rpc) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const output = path.join(RUNS, stamp + '-' + (rpc.a?.session ?? path.basename(directory)));
  fs.mkdirSync(output, {recursive: true});

  const manifest = {
    session: rpc.a?.session ?? null,
    runDirectory: directory,
    sourceRevision: sourceRevision(),
    builder: os.hostname(),
    command: process.argv,
    started: new Date().toISOString()
  };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

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
  const extraAddresses = args.filter(arg => /^\d+\.\d+\.\d+\.\d+$/.test(arg));
  saveHosts(hosts, seedHosts(loadHosts(hosts), extraAddresses));

  const settingsFile = uiSettings.settingsFile();
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const coversDir = path.join(cacheHome, 'hblauncher/moonlight/covers');
  fs.mkdirSync(coversDir, {recursive: true});

  const run = openRun(directory, rpc);
  const raster = createRaster();
  const service = createService({
    memory: rpc,
    mapped: storage.mapped,
    pages: createPages(raster),
    children: createChildren(),
    directory,
    readHosts: () => seedHosts(loadHosts(hosts)),
    writeHosts: list => saveHosts(hosts, list),
    saveSettings: settings => uiSettings.save(settingsFile, settings),
    settings: uiSettings.load(settingsFile),
    coversDir,
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
