/**
 * Drives the helper and the stream from the Civ7 console UI, which runs the model; the PC
 * composes each page and writes it with write-raw. Word ownership: CLAUDE.md.
 */
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {UI} from '../shared/ring.js';
import {changedRanges, serializeOver, pageAddress} from './page.js';
import {createPages} from './pages.js';
import * as uiSettings from './settings.js';
import {parseList, rememberIn, sameHost} from './hosts.js';
import {discover, merge} from './discover.js';
import {HELPER} from '../session/protocol-binary.js';
import {createBitrateAdaptation} from '../civ7/bitrate-adaptation.js';

/** Console poll interval; a stream needs the bus more than the menu does. */
const POLL_MS = {idle: 50, streaming: 250};
/** Launch progress repaints the launching page at most this often (civ7/README.md). */
const LAUNCH_PROGRESS_MS = 500;
/**
 * A helper call slower than this is killed: the helper's own worst case for the command plus
 * 5 s (README.md, hbmoonlight timeouts). list: connect 15 + app list 15 + covers 10 + one
 * cover 5; unpair: connect 15 + unpair 15; quit: connect 15 + cancel 30 + reconnect 15;
 * pair: connect 15 + the 120 s PIN wait.
 */
const HELPER_TIMEOUT_MS = {list: 50000, unpair: 35000, quit: 65000, pair: 140000};
/** Time a stream gets to stop on SIGINT before it is killed. */
const STOP_GRACE_MS = 10000;
/** Socket error codes that mean the bridge is closed, as when the launcher stops first. */
const BRIDGE_GONE = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'];
/** What the operator has to do once the bridge went away under a stream. */
const RESET_HINT = 'the console connection closed; relaunch the payload';
/** Every child gets its stdout and stderr piped, nothing on stdin. */
const PIPED = /** @type {const} */ (['ignore', 'pipe', 'pipe']);

/**
 * @import {Host, App, Intent, Event, Model, Step} from './model.js'
 * @import {RemovedHost} from './hosts.js'
 * @import {Painted} from './raster.js'
 * @typedef {{code: number | null, signal: NodeJS.Signals | null, out: string, err: string,
 *   notice?: string}} Exited `notice` is what a failed stream start shows instead of its exit code
 * @typedef {{exited: Promise<Exited>, cancel: (signal?: NodeJS.Signals) => boolean,
 *   stopping?: Promise<void>}} Child
 * @typedef {(stream: string, line: string) => void} OnLine
 * @import {PageState} from '../civ7/console-ui.js'
 * @import {Page} from './page.js'
 * @typedef {Step & {revision?: number, storageError?: string | null,
 *   published?: {event: string, sequence: number}[], page?: PageState}} MachineStep
 * @typedef {{initial: MachineStep, dispatch: (event: Event) => Promise<MachineStep>,
 *   poll: () => Promise<MachineStep>,
 *   show: (page: {sequence: number, screen: string}) => Promise<MachineStep>}} ConsoleMachine
 * @typedef {{message?: string, stage?: string, detail?: string}} HelperError
 * @typedef {{host: Host, app: App, settings: Model['settings'], token: number,
 *   adaptation: ReturnType<typeof createBitrateAdaptation> | null}} Launch
 */

/** @param {unknown} error @returns {boolean} */
const isBridgeGone = error =>
  typeof error === 'object' && error !== null && 'code' in error && BRIDGE_GONE.includes(String(error.code));

/** @param {unknown} error */
const messageOf = error =>
  typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);

/** One little-endian 32-bit word. @param {number} value */
function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Children the service starts: the helper for list, pair, unpair and quit. The caller sets `stream`.
 * Each returns {exited, cancel} so the service never waits on a process object.
 * @param {{spawnProcess?: typeof spawn, helperPath?: string}} options
 */
function createChildren({spawnProcess = spawn, helperPath = HELPER} = {}) {
  /**
   * Collects the output for exited, or hands each line to onLine as it arrives.
   * @param {import('node:child_process').ChildProcess} child
   * @param {{onLine?: OnLine, collect?: boolean}} options
   * @returns {Child}
   */
  function wrap(child, {onLine, collect}) {
    let out = '';
    let err = '';
    const {stdout, stderr} = child;
    if (!stdout || !stderr) throw Error('Child output is not piped');

    if (collect) {
      stdout.on('data', chunk => {
        out += chunk;
      });
      stderr.on('data', chunk => {
        err += chunk;
      });
    } else if (onLine) {
      readline.createInterface({input: stdout}).on('line', line => onLine('stdout', line));
      readline.createInterface({input: stderr}).on('line', line => onLine('stderr', line));
    }

    /** @type {Promise<Exited>} */
    const exited = new Promise(resolve => {
      child.on('close', (code, signal) => resolve({code, signal, out, err}));
      child.on('error', error => resolve({code: -1, signal: null, out, err: error.message}));
    });

    return {
      exited,
      cancel: (/** @type {NodeJS.Signals} */ signal = 'SIGINT') => child.kill(signal)
    };
  }

  /** @param {string} file @param {string[]} args */
  const start = (file, args) => spawnProcess(file, args, {stdio: [...PIPED]});

  return {
    /** @param {string[]} args */
    helper: args => wrap(start(helperPath, args), {collect: true}),
    /** @param {string} address @param {OnLine} onLine */
    pair: (address, onLine) => wrap(start(helperPath, ['pair', address]), {onLine}),
    /**
     * @param {string} directory @param {Host} host @param {App} app @param {string[]} args
     * @param {OnLine} onLine
     * @returns {Child}
     */
    stream: (directory, host, app, args, onLine) => {
      throw Error('no stream runner');
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
 * @param {string} options.directory The launcher run directory, passed to the stream runner.
 * @param {() => import('./model.js').Host[]} options.readHosts
 * @param {(hosts: import('./model.js').Host[]) => void} [options.writeHosts] Saves a merged list.
 * @param {() => RemovedHost[]} [options.readRemoved] Hosts the user removed; discovery skips them.
 * @param {(removed: RemovedHost[]) => void} [options.writeRemoved]
 * @param {() => Promise<{name: string, address: string}[]>} [options.discoverHosts] mDNS, bounded.
 * @param {(settings: Model['settings']) => void} options.saveSettings
 * @param {ConsoleMachine} options.machine The Civ7 console UI: it runs the model, the PC
 *   writes its pages with write-raw and the console shows them.
 * @param {string | null} [options.coversDir] Where the helper caches box art; null for letter
 *   tiles only.
 * @param {(event: Record<string, unknown>) => void} [options.log]
 * @param {{helper?: number, pair?: number, stop?: number}} [options.timeouts] `helper` replaces
 *   every helper limit but pair's.
 */
function createService({
  memory,
  mapped,
  pages,
  children,
  directory,
  readHosts,
  writeHosts = () => {},
  readRemoved = () => [],
  writeRemoved = () => {},
  discoverHosts = () => discover(),
  saveSettings,
  machine,
  coversDir = null,
  log = () => {},
  timeouts = {}
}) {
  /** @param {'list' | 'unpair' | 'quit'} command */
  const helperLimit = command => timeouts.helper ?? HELPER_TIMEOUT_MS[command];
  const pairLimit = timeouts.pair ?? HELPER_TIMEOUT_MS.pair;
  const stopGrace = timeouts.stop ?? STOP_GRACE_MS;

  /** @type {Model} */
  let model = machine.initial.model;
  /** @type {number | undefined} */
  let revision;
  let stopped = false;
  /** Set once a transfer found the bridge closed; nothing is written after that. */
  let lost = false;
  /** @type {Promise<void> | undefined} */
  let detaching;
  /** Bumped on cancel and detach; a result from an older generation is dropped. */
  let generation = 0;
  /** @type {Child | null} */
  let current = null;
  /** @type {Child | null} */
  let stream = null;
  /**
   * The running launch; its adaptation is null for a manual bitrate.
   * @type {Launch | null}
   */
  let lastLaunch = null;
  /**
   * Streams stopped for a reconnect: their exit is not the end of the stream.
   * @type {WeakSet<Child>}
   */
  const replaced = new WeakSet();
  /** @type {string | null} */
  let quitResult = null;
  /**
   * A stream fallback's one-time notice (AV1 refused until the console app restarts), shown on
   * the apps page the stream returns to.
   * @type {string | null}
   */
  let streamNotice = null;
  /** @type {Map<number, Promise<Painted>>} */
  let covers = new Map();
  /** @type {Promise<unknown>} Every memory transfer, in order. */
  let chain = Promise.resolve();
  /** Every model event and publish, in order. */
  let queue = Promise.resolve();
  /** The console's page buffers, as its last snapshot reported them. */
  let consolePage = machine.initial.page ?? null;
  /**
   * What each page buffer holds as this service last wrote it, under the console epoch: its
   * bytes and where each bitmap sits. A republish keeps those bitmaps in place and writes only
   * the changed ranges. Forgotten while a write is in flight, so a failed one is not trusted.
   * @type {{epoch: number, page: {bytes: Buffer, placed: Map<Uint8Array, number>} | null}[]}
   */
  const buffers = [{epoch: 0, page: null}, {epoch: 0, page: null}];
  /** @type {string | null} */
  let shownSignature = null;
  /** @type {string | null} */
  let shownScreen = null;
  let shownAt = 0;
  /** A page held back (unapplied predecessor, launch throttle, video start) goes out later. */
  let pageDirty = false;
  /** From the helper's connection until the video channel connects: no page goes out. */
  let videoStarting = false;
  /** Work running under busy(); hostBusy is 1 while any runs. */
  let busyCount = 0;

  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  const transfer = work => {
    const done = chain.then(work, work);
    chain = done;
    return done;
  };
  /**
   * Skipped once the bridge is gone, so stopping a stream after that cannot reject.
   * @param {number} address @param {number} value
   */
  const writeWord = (address, value) =>
    transfer(async () => {
      if (!lost) await memory.write(mapped + address, u32(value));
    });

  /**
   * The page encoded over what its buffer holds, and the ranges that differ from it.
   * @param {Omit<Page, 'epoch' | 'sequence'>} page @param {number} epoch @param {number} sequence
   */
  function encodePage(page, epoch, sequence) {
    const buffer = buffers[sequence & 1];
    const resident = buffer.epoch === epoch ? buffer.page : null;
    const encoded = serializeOver({...page, epoch, sequence}, resident);
    return {...encoded, ranges: changedRanges(resident?.bytes ?? null, encoded.bytes)};
  }

  /**
   * Writes the changed ranges into the page's buffer and remembers what it now holds.
   * @param {number} epoch @param {number} sequence @param {ReturnType<typeof encodePage>} encoded
   */
  async function writePage(epoch, sequence, encoded) {
    const buffer = buffers[sequence & 1];
    buffer.page = null;

    const base = pageAddress(mapped, sequence & 1);
    for (const {start, end} of encoded.ranges)
      await transfer(() => memory.write(base + start, encoded.bytes.subarray(start, end)));

    buffer.epoch = epoch;
    buffer.page = {bytes: encoded.bytes, placed: encoded.placed};
    return encoded.ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  }

  /**
   * Composes the model's page here, writes it into the console's next page buffer with
   * write-raw and has the console flip the header. Held while the video starts, while the
   * previous page is unapplied, and to LAUNCH_PROGRESS_MS between launch progress pages.
   * @param {boolean} [again] republishes a page the console never applied
   */
  async function publishToConsole(again = false) {
    const target = consolePage;
    if (!target || stopped || lost) return;

    pageDirty = true;
    if (videoStarting) return;
    const pending = target.applied !== target.sequence;
    if (pending && !again) return;
    const progress = model.screen === 'launching' && shownScreen === 'launching';
    if (progress && !again && Date.now() - shownAt < LAUNCH_PROGRESS_MS) return;

    try {
      const started = Date.now();
      const page = await pages.page(model, covers);
      const signature = page && pages.signature(page);
      const unchanged = signature === shownSignature && !again;
      if (!page || unchanged) {
        pageDirty = false;
        return;
      }

      const screen = model.screen;
      const composed = Date.now();
      const encodedPage = encodePage(page, target.epoch, target.next);
      const encoded = Date.now();
      const writtenBytes = await writePage(target.epoch, target.next, encodedPage);
      const written = Date.now();
      const result = await machine.show({sequence: target.next, screen});

      pageDirty = false;
      shownSignature = signature;
      shownScreen = screen;
      shownAt = Date.now();
      log({event: 'published', screen, sequence: target.next, bytes: encodedPage.bytes.length, written: writtenBytes,
        writes: encodedPage.ranges.length,
        composeMs: composed - started, encodeMs: encoded - composed, writeMs: written - encoded,
        showMs: shownAt - written});
      await accept(result, 'show');
    } catch (error) {
      failed('page-failed', error);
    }
  }

  /**
   * Logs a failure of work nothing waits for. A closed bridge means the launcher is gone, so
   * the service stops publishing and detaches.
   * @param {string} name @param {unknown} error @param {object} [fields]
   */
  function failed(name, error, fields = {}) {
    log({event: name, ...fields, message: messageOf(error)});
    if (lost || !isBridgeGone(error)) return;
    lost = true;
    log({event: 'bridge-gone', message: messageOf(error), hint: RESET_HINT});
    detach().catch(error => log({event: 'detach-failed', message: messageOf(error)}));
  }

  /** Dispatches from a callback that cannot wait for it. @param {Event} event */
  const background = event => dispatch(event).catch(error => failed('dispatch-failed', error));

  /**
   * Everything that publishes runs through one queue, in order.
   * @param {() => Promise<void>} work
   */
  function enqueue(work) {
    queue = queue.then(work, work);
    return queue;
  }

  /**
   * Model events run one at a time; intents start their work and come back through dispatch.
   * @param {import('./model.js').Event} event
   */
  function dispatch(event) {
    return enqueue(async () => {
      if (stopped) return;

      await accept(await machine.dispatch(event), event.type);
    });
  }

  /** @param {MachineStep} result @param {string} type */
  async function accept(result, type) {
    const changed = result.revision !== revision;
    revision = result.revision;
    model = result.model;
    if (changed || result.intents.length)
      log({event: 'model', type, screen: model.screen, overlay: model.overlay});
    if (result.storageError) log({event: 'settings-storage-failed', message: result.storageError});
    for (const entry of result.published ?? []) log({...entry});
    for (const intent of result.intents)
      run(intent).catch(error => failed('intent-failed', error, {type: intent.type}));

    consolePage = result.page ?? consolePage;
    const stale = Boolean(consolePage?.stale);
    if (changed || pageDirty || stale) await publishToConsole(stale);
  }

  /**
   * Runs `work` with hostBusy raised, so the console shows the host is working. Overlapping
   * calls share it: the first raises it, the last one out lowers it.
   * @template T
   * @param {() => Promise<T>} work
   */
  async function busy(work) {
    busyCount++;
    if (busyCount === 1) await writeWord(UI.hostBusy, 1);

    try {
      return await work();
    } finally {
      busyCount--;
      if (busyCount === 0) await writeWord(UI.hostBusy, 0);
    }
  }

  /**
   * A helper call bounded in time; a hung helper is killed and reported as such.
   * @param {string[]} args @param {number} limit
   * @returns {Promise<Exited>}
   */
  async function helper(args, limit) {
    if (stopped) return {code: null, signal: 'SIGINT', out: '', err: ''};
    const child = children.helper(args);
    current = child;
    const timer = setTimeout(() => child.cancel('SIGKILL'), limit);
    const result = await child.exited;
    clearTimeout(timer);
    if (current === child) current = null;

    if (result.signal === 'SIGKILL') result.err += '\nhelper timed out';
    const error = result.code ? helperError(result) : null;

    /** @type {Record<string, unknown>} */
    const entry = {
      event: 'helper',
      args: args.slice(0, 2),
      code: result.code,
      signal: result.signal
    };
    if (error) entry.error = error;
    log(entry);

    return result;
  }

  /**
   * The helper's own error line ({message, stage, detail}), or null when it wrote none.
   * @param {Exited} result
   * @returns {HelperError | null}
   */
  function helperError(result) {
    const line = result.err.split('\n').find(text => text.includes('"event":"error"'));
    if (line === undefined) return null;

    try {
      const {event, ...error} = JSON.parse(line);
      return error;
    } catch {
      return null;
    }
  }

  /**
   * The helper's message with its detail, when it gave one.
   * @param {HelperError} error @param {string} fallback
   */
  function errorText(error, fallback) {
    const message = error.message || fallback;
    if (!error.detail) return message;
    return message + ': ' + error.detail;
  }

  /**
   * Why an operation failed, for a page that already names it: the libgamestream detail when
   * the helper's message is just `generic` ("pairing failed"), else the message and detail.
   * @param {HelperError} error @param {string} generic
   */
  function reasonOf(error, generic) {
    const bare = error.message === generic && Boolean(error.detail);
    if (bare) return String(error.detail);
    return errorText(error, generic);
  }

  /** The message to show for a failed helper call. @param {Exited} result @param {string} fallback */
  function helperMessage(result, fallback) {
    const error = helperError(result);
    if (error) return errorText(error, fallback);
    return /timed out/.test(result.err) ? 'The helper timed out' : fallback;
  }

  /** What the app list says about the last quit, if there was one. @param {number} currentGame */
  function quitMessage(currentGame) {
    if (!quitResult) return null;

    const gameClosed = currentGame === 0;
    if (quitResult === 'cancelled') {
      if (gameClosed) return 'Quit confirmed';
      return 'Quit failed: the host game is still running';
    }

    if (gameClosed) return 'Host closed the game on its own; the quit request failed';
    return quitResult;
  }

  /** @param {Host} host @param {number} token */
  async function list(host, token) {
    const covers = coversDir ? ['--covers', coversDir] : [];
    const result = await busy(() => helper(['list', host.address, ...covers], helperLimit('list')));
    if (token !== generation) return;

    if (result.code === 0) {
      const {uniqueid, ...listed} = parseList(result.out);
      const message = quitMessage(listed.currentGame) ?? streamNotice;
      quitResult = null;
      streamNotice = null;
      await rememberHost({...host, uniqueid}, token);
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

  /**
   * Saves a host once it answered a list, paired by then, so a cancelled or failed pairing
   * leaves hosts.json alone. A known uniqueid at a new address moves that host (hosts.js
   * rememberIn), and a host the user removed and opened again leaves the removed list.
   * @param {Host} host
   * @param {number} token
   */
  async function rememberHost(host, token) {
    if (token !== generation) return;

    const removed = readRemoved();
    const kept = removed.filter(entry => !sameHost(entry, host));
    if (kept.length !== removed.length) writeRemoved(kept);

    const saved = readHosts();
    const hosts = rememberIn(saved, host);
    if (hosts === saved) return;

    writeHosts(hosts);
    log({event: 'host-added', address: host.address});
    await dispatch({type: 'hosts', hosts});
  }

  /**
   * Drops a host from hosts.json and keeps it on the removed list, so discovery does not add it
   * back; its pairing stays on the PC until it is unpaired.
   * @param {Host} host
   */
  function removeHost(host) {
    const saved = readHosts();
    const entry = saved.find(other => other.address === host.address) ?? host;
    writeHosts(saved.filter(other => other.address !== host.address));

    /** @type {RemovedHost} */
    const gone = {address: entry.address};
    if (entry.uniqueid) gone.uniqueid = entry.uniqueid;
    const removed = readRemoved().filter(other => !sameHost(other, gone));
    writeRemoved([...removed, gone]);
    log({event: 'host-removed', address: host.address});
  }

  /** @param {Host} host @param {number} token */
  async function unpair(host, token) {
    const result = await busy(() => helper(['unpair', host.address], helperLimit('unpair')));
    if (token !== generation || result.signal === 'SIGINT') return;

    if (result.code === 0) {
      await dispatch({type: 'unpaired'});
      return;
    }

    const error = helperError(result);
    const fallback = helperMessage(result, 'the helper exited ' + result.code);
    const reason = error ? reasonOf(error, 'unpair failed') : fallback;
    await dispatch({type: 'failed', message: 'Unpairing failed: ' + reason, back: 'hosts'});
  }

  /** @param {Host} host @param {number} token */
  async function pair(host, token) {
    /** @type {string | null} */
    let pairError = null;

    /** @param {string} channel @param {string} line */
    const onLine = (channel, line) => {
      if (token !== generation) return;

      /** @type {{event?: string, pin?: string, url?: string, message?: string, detail?: string}} */
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.event === 'pin') background({type: 'pin', pin: event.pin ?? null, url: event.url ?? null});
      if (event.event === 'error') {
        pairError = reasonOf(event, 'pairing failed');
        log({event: 'pair-error', message: event.message, detail: event.detail});
      }
    };

    const child = children.pair(host.address, onLine);
    current = child;
    const timer = setTimeout(() => child.cancel('SIGKILL'), pairLimit);
    const result = await busy(() => child.exited);
    clearTimeout(timer);
    if (current === child) current = null;
    if (token !== generation || result.signal === 'SIGINT') return;

    if (result.code === 0) {
      await dispatch({type: 'paired'});
      return;
    }

    const killed = result.signal === 'SIGKILL';
    const exitText = killed ? 'the helper timed out' : 'the helper exited ' + result.code;
    const reason = pairError ?? exitText;
    await dispatch({type: 'failed', message: 'Pairing failed: ' + reason, back: 'hosts'});
  }

  /**
   * Turns the stream's events into model events. Lines on the `logged` channel were already
   * written to the run log by their sender.
   * @param {string} channel @param {string} line
   */
  function onStreamLine(channel, line) {
    /** @type {Record<string, unknown>} */
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return log({event: 'stream-line', line});
    }
    if (channel !== 'logged') log({...event, event: 'stream-event', name: event.event});

    if (event.event === 'video-starting') {
      videoStarting = true;
    } else if (event.event === 'connected') {
      videoStarting = false;
      background({type: 'streamStarted'});
    } else if (event.event === 'console-stalled') {
      background({
        type: 'failed',
        message: 'The console stopped answering, so the stream was stopped',
        back: 'apps'
      });
    } else if (event.event === 'log' && typeof event.message === 'string' && event.message) {
      background({type: 'stage', message: event.message});
    } else if (event.type === 'stream-fallback' && typeof event.notice === 'string') {
      streamNotice = event.notice;
    }

    adapt(event);
  }

  /**
   * Feeds the Auto bitrate adaptation; a decision reconnects at the new bitrate.
   * @param {Record<string, unknown>} event
   */
  function adapt(event) {
    const launched = lastLaunch;
    const decision = launched?.adaptation?.observe(event);
    if (!launched || !decision) return;

    log({...decision, event: 'bitrate-adaptation'});
    reconnect(launched).catch(error => failed('bitrate-reconnect-failed', error));
  }

  /**
   * Stops the stream and launches it again at the adapted scale, unless the user left.
   * @param {Launch} launched
   */
  async function reconnect(launched) {
    const child = stream;
    if (!child) return;

    replaced.add(child);
    await stopStream();

    const current = lastLaunch === launched && launched.token === generation;
    if (!current || stopped) return;

    if (model.screen === 'streaming') startStream(launched);
    else await dispatch({type: 'streamEnded'});
  }

  /**
   * The stream arguments, with the session-only factor when Auto has been lowered: it scales
   * the Auto default of whatever rate each session runs at (a 120 fallback to 60 included).
   * @param {Launch} launched
   */
  function launchArgs(launched) {
    const args = uiSettings.streamArgs(launched.settings);
    const scale = launched.adaptation?.scale();
    if (scale) args.push('--bitrate-scale', String(scale));

    return args;
  }

  /**
   * Starts a stream once any earlier one has stopped (it may still be in its stop grace after
   * B on launching), unless the user left meanwhile.
   * @param {Host} host @param {App} app @param {Model['settings']} streamSettings
   * @param {number} token
   */
  async function launch(host, app, streamSettings, token) {
    if (stream) await stopStream();
    if (token !== generation || stopped) return;

    const args = uiSettings.streamArgs(streamSettings);
    const auto = args[args.indexOf('--bitrate') + 1] === 'auto';
    const adaptation = auto ? createBitrateAdaptation() : null;
    lastLaunch = {host, app, settings: streamSettings, token, adaptation};

    startStream(lastLaunch);
  }

  /** @param {Launch} launched */
  function startStream(launched) {
    const {host, app, token} = launched;
    const child = children.stream(directory, host, app, launchArgs(launched), onStreamLine);
    stream = child;

    child.exited
      .then(async result => {
        if (stream === child) {
          stream = null;
          videoStarting = false;
        }
        log({event: 'stream-exit', code: result.code, signal: result.signal});
        if (token !== generation || replaced.has(child)) return;

        const startFailed = model.screen === 'launching' && result.code !== 0 && !result.signal;
        if (startFailed) {
          await dispatch({
            type: 'failed',
            message: result.notice ?? 'The stream did not start (exit ' + result.code + ')',
            back: 'apps'
          });
          return;
        }

        await dispatch({type: 'streamEnded'});
      })
      .catch(error => failed('stream-exit-failed', error));
  }

  /** Stops the stream once, however many callers ask: SIGINT, then SIGKILL after the grace. */
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

  /** @param {Host} host @param {number} token */
  async function quit(host, token) {
    await stopStream();
    const result = await busy(() => helper(['quit', host.address], helperLimit('quit')));
    if (token !== generation) return;

    const cancelled = result.code === 0;
    log({event: 'quit', host: host.address, cancelled, code: result.code, signal: result.signal});
    quitResult = cancelled
      ? 'cancelled'
      : 'Quit failed: ' + helperMessage(result, 'the host refused');
    await dispatch({type: 'quitDone'});
  }

  /** Carries out one intent of the model. @param {Intent} intent */
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
        return enqueue(() => publishToConsole());
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
      case 'removeHost':
        return removeHost(intent.host);
      case 'unpairHost':
        return unpair(intent.host, token);
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
   * manual is touched, removed hosts stay removed, and the hosts page follows when the list
   * changed.
   */
  async function refreshHosts() {
    /** @type {{name: string, address: string}[]} */
    let found = [];
    try {
      found = await discoverHosts();
    } catch (error) {
      log({event: 'discover-failed', message: messageOf(error)});
    }

    const manual = readHosts();
    const hosts = merge(manual, found, readRemoved());
    log({event: 'discovered', found: found.length, added: hosts.length - manual.length});

    if (hosts.length !== manual.length) writeHosts(hosts);
    if (JSON.stringify(hosts) !== JSON.stringify(model.hosts)) {
      await dispatch({type: 'hosts', hosts});
    }
  }

  /**
   * Covers arrive with the helper's `list --covers`; until then every app gets a letter tile.
   * @param {Host} host @param {(App & {cover?: string})[]} apps
   */
  async function coverTiles(host, apps) {
    const tiles = new Map();
    for (const app of apps) {
      if (app.cover) tiles.set(app.id, pages.cover(host.address + ':' + app.id, app.cover));
    }

    return tiles;
  }

  /** Clears hostBusy, shows the first page and starts discovery. */
  async function attach() {
    await writeWord(UI.hostBusy, 0);
    log({event: 'attach'});
    await dispatch({type: 'attached'});
    refreshHosts().catch(error => log({event: 'discover-failed', message: messageOf(error)}));
  }

  /** One console poll: the console UI reads its commands and runs the model. */
  function poll() {
    return enqueue(async () => {
      if (!stopped) await accept(await machine.poll(), 'console');
    });
  }

  /** Runs once: the poll loop and stop() both end in it. */
  function detach() {
    detaching ??= release();
    return detaching;
  }

  /** Cancels the children and drains the queue; the console restores its splash on ui-close. */
  async function release() {
    stopped = true;
    generation++;
    const child = current;
    const childDone = (async () => {
      if (!child) return;
      const timer = setTimeout(() => child.cancel('SIGKILL'), stopGrace);
      try {
        child.cancel('SIGINT');
        await child.exited;
      } finally { clearTimeout(timer); }
    })();
    childDone.catch(error => failed('helper-stop-failed', error));
    await queue.catch(() => {});
    const results = await Promise.allSettled([stopStream(), childDone]);
    for (const result of results)
      if (result.status === 'rejected') failed('child-stop-failed', result.reason);

    log({event: 'detach'});
  }

  /** Attaches, polls until stopped or the bridge closes, then detaches. */
  async function start() {
    await attach();

    while (!stopped) {
      try {
        await poll();
      } catch (error) {
        if (!isBridgeGone(error)) throw error;
        failed('poll-failed', error);
        break;
      }
      await sleep(model.screen === 'streaming' ? POLL_MS.streaming : POLL_MS.idle);
    }

    await detach();
  }

  return {
    start,
    stop: detach,
    attach,
    poll,
    dispatch: (/** @type {Event} */ event) => dispatch(event),
    model: () => model,
    lost: () => lost
  };
}

export {HELPER_TIMEOUT_MS, createService, createChildren};
