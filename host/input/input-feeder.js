/**
 * Unified controller and touch feed for the stream helper. Attaches to the newest (or named)
 * runs/launcher-* session, reads the mapped state once per frame and writes tagged JSON lines to
 * stdout, meant to be piped into hbmoonlight's stdin:
 *
 *   {"type":"controller",...}                                  on change (controller.js fields)
 *   {"type":"touch","events":[{id,action,x,y,pressure}...]}    when touch changes
 *
 * Pad bytes (0..40) and the touch block (128..784) are contiguous in the mapped buffer, so one
 * rpc.read of 784 bytes covers both and halves the console exchanges competing with the video
 * sender. --sources is intentionally not supported here; the extra pad sources live far outside
 * that window.
 *
 * Each change of the console + or - goes to stderr with the wall time, so a console hang can be
 * matched against a + press (SB4 may act on + itself).
 *
 * With --counts-fd N, the reads' bridge exchanges and time go out on that descriptor once a
 * second as {exchanges, bridgeMs, pad} lines, for the stream's stats rows (stage "input"); pad
 * is how fresh the pad state was at each read (pad-age.js).
 *
 * With --push, a console worker sends each record (the 784 bytes, then the UI overlay words)
 * on a native TCP socket at --hz instead (input-push-worker.js), so no input crosses the
 * bridge once it runs; the lines out are the same. The counts lines add pushed, dropped and
 * gapMaxMs: records received, records dropped as backlog and the longest arrival gap.
 *
 * --start-chord names the NPAD buttons that press PC Start while all are held ('none' for no
 * chord, default stickL+stickR), since + alone stops SmileBASIC 4.
 *
 * Usage: node host/input/input-feeder.js [runs/launcher-XXXX] [--hz 60] [--labels]
 *        [--counts-fd N] [--push] [--start-chord stickL+stickR]
 */
import fs from 'node:fs';
import path from 'node:path';
import * as session from '../../../hbl-platform/sdk/host/session.js';
import * as cli from '../../../hbl-platform/sdk/cli.js';
import {STATE} from '../../../hbl-platform/sdk/host/layout.js';
import {
  NPAD,
  NEUTRAL,
  START_CHORD,
  decode,
  toMoonlight,
  parseStartChord,
  same,
  NPAD_BYTES
} from './controller.js';
import {TOUCH_BYTES, parseTouch, createTracker, step, flush, touchLine} from './touch.js';
import {UI, UI_MAGIC} from '../../tools/moonlight/ring.js';
import {instrument} from '../stream/bridge-counter.js';
import * as padAge from './pad-age.js';
import {STATE_BYTES} from './input-push-plan.js';
import {create as createPushWorker} from './input-push-worker.js';

/** One read from the start of the state buffer to the end of the touch block. */
const READ_BYTES = STATE.touch + TOUCH_BYTES;
const DEFAULT_HZ = 60;
/** How often the session's source file is re-read to see which app is running. */
const SOURCE_CHECK_MS = 250;
/** How often the console UI overlay word is read; input is dropped while it is raised. */
const OVERLAY_CHECK_MS = 100;
/** How often the bridge counts go out on --counts-fd. */
const COUNTS_MS = 1000;
/** Console + and -, read off the pad itself: a chord may press Start with + up. */
const KEYS = NPAD.plus | NPAD.minus;
/** The push rate unless --hz says otherwise: twice the launcher's pad copy. */
const PUSH_HZ = 120;
/** More complete records than this waiting at once means the host stalled: keep the newest. */
const MAX_BACKLOG = 4;
/** No record for this long releases everything held on the PC. */
const STALL_MS = 250;
/** No record for this long, counted from the attach, fails the push. */
const SILENT_MS = 2000;
/** How often push mode checks for a stall and, every SOURCE_CHECK_MS, the source. */
const PUSH_CHECK_MS = 50;

/**
 * @param {object} controller toMoonlight fields
 * @returns {string}
 */
function controllerLine(controller) {
  return JSON.stringify({type: 'controller', ...controller});
}

/**
 * Watches the console + and -: each call takes a state buffer and returns their state when
 * either changed since the last call.
 * @returns {(bytes: Buffer) => string | null}
 */
function keysWatch() {
  let last = 0;
  return bytes => {
    const keys = decode(bytes.subarray(0, NPAD_BYTES)).buttons & KEYS;
    if (keys === last) return null;
    last = keys;
    const state = bit => (keys & bit ? 'down' : 'up');
    return `Input keys: + ${state(NPAD.plus)}, - ${state(NPAD.minus)}`;
  };
}

/**
 * Pure per-frame mapping, shared with the tests: one state buffer in, the lines to emit plus
 * the controller state to remember next frame out.
 * @param {object | null} previous the controller state of the last frame
 * @param {Buffer} bytes READ_BYTES of state
 * @param {import('./touch.js').Tracker} tracker
 * @param {'position' | 'labels'} layout
 * @param {string[]} [startChord]
 * @returns {{lines: string[], controller: ReturnType<typeof toMoonlight>}}
 */
function frame(previous, bytes, tracker, layout, startChord = START_CHORD) {
  const lines = [];
  const controller = toMoonlight(decode(bytes.subarray(0, NPAD_BYTES)), layout, startChord);
  if (!same(previous, controller)) lines.push(controllerLine(controller));
  const {events} = step(tracker, parseTouch(bytes.subarray(STATE.touch)));
  if (events.length) lines.push(touchLine(events));
  return {lines, controller};
}

/** The UI block words the gate reads in one go: uiMagic through uiOverlay. */
const OVERLAY_READ = {offset: UI.uiMagic, bytes: UI.uiOverlay + 4 - UI.uiMagic};

/**
 * Whether this frame's input reaches the host: the console UI raises uiOverlay while its
 * overlay page covers the stream, and the game must not see the presses that drive it. Only
 * an attached service counts (uiMagic set); the frame the overlay goes up releases what is
 * held.
 * @param {boolean} paused
 * @param {Buffer} block OVERLAY_READ bytes of the app's private storage
 * @returns {{paused: boolean, release: boolean}}
 */
function gate(paused, block) {
  const raised =
    block.readUInt32LE(0) === UI_MAGIC && block.readUInt32LE(UI.uiOverlay - UI.uiMagic) !== 0;
  return {paused: raised, release: raised && !paused};
}

/**
 * Whether a record starts where the reader thinks: its UI words, when it has them, open with
 * uiMagic, which is the magic once a service attached and 0 before. A short send shifts every
 * later record, and the word there is then pad or touch bytes.
 * @param {Buffer} record
 * @returns {boolean}
 */
function framed(record) {
  if (record.length === STATE_BYTES) return true;
  const magic = record.readUInt32LE(STATE_BYTES);
  return magic === UI_MAGIC || magic === 0;
}

/**
 * The private storage of the newest Moonlight app report, where the UI block lives (the
 * source file maps the launcher's controls buffer, not the app's storage).
 * @param {string} directory
 * @returns {{mapped: number, bytes: number} | null}
 */
function readStorage(directory) {
  try {
    const reports = fs
      .readdirSync(directory)
      .filter(name => /^app-moonlight-.*\.json$/.test(name))
      .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
      .filter(report => report.privateStorage)
      .sort((a, b) => b.started.localeCompare(a.started));
    return reports[0]?.privateStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The push mode reader: records arrive whole or split and are applied in order. A repeated
 * frameIndex is a launcher frame already seen (the push outruns the pad copy) and only feeds
 * the overlay gate; a frameIndex going back means a new launcher session. More than
 * MAX_BACKLOG records waiting at once keeps only the newest, after lifting open touches. With
 * no record for STALL_MS, check() lifts every touch and sends the pad back to neutral; with
 * none for SILENT_MS since the attach or the last record, it throws once. A record that is
 * not framed throws, and the reader takes nothing more.
 * @param {object} options
 * @param {'position' | 'labels'} options.layout
 * @param {(line: string) => void} options.write
 * @param {(message: string) => void} options.log
 * @param {string[]} [options.startChord]
 * @param {() => number} [options.now]
 */
function createPushReader({
  layout,
  write,
  log,
  startChord = START_CHORD,
  now = () => performance.now()
}) {
  const tracker = createTracker();
  const keys = keysWatch();
  let previous = null;
  let paused = false;
  let lastFrame = null;
  let lastAt = null;
  let heardAt = null;
  let stalled = false;
  let broken = false;
  let recordBytes = 0;
  let pending = Buffer.alloc(0);
  let counts = {pushed: 0, dropped: 0, gapMaxMs: 0};

  const liftTouches = () => {
    const ups = flush(tracker);
    if (ups.length) write(touchLine(ups));
  };
  const release = () => {
    liftTouches();
    const neutral = toMoonlight(NEUTRAL, layout);
    if (previous && !same(previous, neutral)) write(controllerLine(neutral));
    previous = null;
  };

  /** @param {Buffer} record */
  function apply(record) {
    if (record.length > STATE_BYTES) {
      const next = gate(paused, record.subarray(STATE_BYTES));
      paused = next.paused;
      if (next.release) release();
    }
    const frameIndex = record.readUInt32LE(STATE.frameIndex);
    if (frameIndex === lastFrame) return;
    if (lastFrame !== null && frameIndex < lastFrame) {
      log(`Input push frameIndex went back from ${lastFrame} to ${frameIndex}; new session`);
      release();
    }
    lastFrame = frameIndex;
    if (paused) return;
    const state = record.subarray(0, STATE_BYTES);
    const result = frame(previous, state, tracker, layout, startChord);
    previous = result.controller;
    for (const line of result.lines) write(line);
    const note = keys(state);
    if (note) log(`${note} at ${new Date().toISOString()}`);
  }

  return {
    /** @param {number} bytes Record size of the worker the next data comes from. */
    attach(bytes) {
      recordBytes = bytes;
      pending = Buffer.alloc(0);
      lastFrame = null;
      heardAt = now();
    },
    /** @param {Buffer} chunk */
    data(chunk) {
      if (broken) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const count = Math.floor(pending.length / recordBytes);
      if (!count) return;
      const record = index => pending.subarray(index * recordBytes, (index + 1) * recordBytes);
      for (let index = 0; index < count; index++) {
        if (framed(record(index))) continue;
        broken = true;
        pending = Buffer.alloc(0);
        throw Error('Input push lost the record framing; a console send was short');
      }
      const at = now();
      if (lastAt !== null) counts.gapMaxMs = Math.max(counts.gapMaxMs, at - lastAt);
      lastAt = heardAt = at;
      stalled = false;
      counts.pushed += count;
      let first = 0;
      if (count > MAX_BACKLOG) {
        liftTouches();
        counts.dropped += count - 1;
        first = count - 1;
      }
      for (let index = first; index < count; index++) apply(record(index));
      pending = pending.subarray(count * recordBytes);
    },
    check() {
      const at = now();
      if (lastAt !== null && !stalled && at - lastAt >= STALL_MS) {
        stalled = true;
        release();
        log(`Input push stalled at frameIndex ${lastFrame}`);
      }
      if (heardAt === null || at - heardAt < SILENT_MS) return;
      heardAt = null;
      throw Error(`Input push heard nothing from the console for ${SILENT_MS} ms`);
    },
    /** Releases what is held and forgets the last arrival, so a stopped worker is no stall. */
    detach() {
      release();
      lastAt = heardAt = null;
      stalled = false;
    },
    /** @returns {{pushed: number, dropped: number, gapMaxMs: number}} Since the last take. */
    take() {
      const open = lastAt === null ? 0 : now() - lastAt;
      const result = {...counts, gapMaxMs: Math.round(Math.max(counts.gapMaxMs, open))};
      counts = {pushed: 0, dropped: 0, gapMaxMs: 0};
      return result;
    }
  };
}

/**
 * Push mode: a console worker sends the records instead of the feeder reading them. It runs
 * only while the Moonlight app does, since the UI words it sends live in the app's private
 * storage, and is restarted when the state or storage address changes.
 * @param {object} options
 * @param {any} options.rpc The session rpc.
 * @param {string} options.directory The session directory.
 * @param {number} options.hz
 * @param {'position' | 'labels'} options.layout
 * @param {string[]} [options.startChord]
 * @param {(line: string) => void} options.write
 * @param {(message: string) => void} options.log
 * @param {(error: Error) => void} [options.onFailure] Called once when the worker fails.
 * @param {typeof createPushWorker} [options.createWorker]
 * @param {typeof session.readSource} [options.readSource]
 * @param {typeof readStorage} [options.readAppStorage]
 * @param {() => number} [options.now]
 * @returns {{take: () => {pushed: number, dropped: number, gapMaxMs: number},
 *   stop: () => Promise<void>}}
 */
function runPush({
  rpc,
  directory,
  hz,
  layout,
  startChord,
  write,
  log,
  onFailure = () => {},
  createWorker = createPushWorker,
  readSource = session.readSource,
  readAppStorage = readStorage,
  now = () => performance.now()
}) {
  const reader = createPushReader({layout, write, log, startChord, now});
  /** @type {Awaited<ReturnType<typeof createPushWorker>> | null} */
  let worker = null;
  let running = null;
  let busy = null;
  let failed = false;
  let sourceChecked = -Infinity;

  /** @param {Error} error */
  function fail(error) {
    if (failed) return;
    failed = true;
    log('Input push failed: ' + error.message);
    onFailure(error);
  }

  /** @param {Buffer} bytes */
  function onData(bytes) {
    try {
      reader.data(bytes);
    } catch (error) {
      fail(error);
    }
  }

  async function startWorker(state, ui) {
    worker = await createWorker({
      rpc,
      state,
      ui,
      hz,
      onData,
      onClose: () => worker && fail(Error('Input push socket closed by the console'))
    });
    reader.attach(worker.recordBytes);
    await worker.start();
    running = `${state}/${ui}`;
  }

  async function stopWorker() {
    const stopping = worker;
    worker = null;
    running = null;
    try {
      const {pushed} = await stopping.stop();
      log(`Input push stopped; the console counted ${pushed} records`);
    } finally {
      reader.detach();
    }
  }

  async function check() {
    const source = readSource(directory);
    const storage = readAppStorage(directory);
    const moonlight = source?.package?.id === 'moonlight' && storage;
    const ui = moonlight ? storage.mapped + OVERLAY_READ.offset : null;
    const wanted = moonlight ? `${source.mapped}/${ui}` : null;
    if (worker && wanted !== running) await stopWorker();
    if (!worker && moonlight) await startWorker(source.mapped, ui);
  }

  const timer = setInterval(() => {
    try {
      reader.check();
    } catch (error) {
      if (worker) fail(error);
    }
    const at = now();
    if (busy || failed || at - sourceChecked < SOURCE_CHECK_MS) return;
    sourceChecked = at;
    busy = check()
      .catch(fail)
      .finally(() => (busy = null));
  }, PUSH_CHECK_MS);

  return {
    take: () => reader.take(),
    async stop() {
      clearInterval(timer);
      await busy;
      if (worker) await stopWorker();
      else reader.detach();
    }
  };
}

/**
 * Runs push mode until SIGINT or SIGTERM, or until the worker fails.
 * @param {ReturnType<typeof instrument>} bridge
 * @param {{directory: string, hz: number, layout: 'position' | 'labels', startChord: string[],
 *   countsFd: number | null}} options
 */
async function mainPush(bridge, {directory, hz, layout, startChord, countsFd}) {
  let finish;
  const finished = new Promise(resolve => (finish = resolve));
  let closed = false;
  // A gone helper must not skip the worker stop, so its pipe error only ends the run.
  process.stdout.on('error', () => {
    closed = true;
    finish();
  });
  process.on('SIGINT', () => finish());
  process.on('SIGTERM', () => finish());
  const push = runPush({
    rpc: bridge.rpc,
    directory,
    hz,
    layout,
    startChord,
    write: line => closed || process.stdout.write(line + '\n'),
    log: message => process.stderr.write(message + '\n'),
    onFailure: () => {
      process.exitCode = 1;
      finish();
    }
  });
  if (countsFd !== null)
    setInterval(() => {
      const {exchanges, bridgeMs} = bridge.take();
      const line = JSON.stringify({exchanges, bridgeMs, ...push.take()});
      fs.write(countsFd, line + '\n', () => {});
    }, COUNTS_MS).unref();
  await finished;
  await push.stop();
}

async function main() {
  const args = process.argv.slice(2);
  const push = args.includes('--push');
  const hz = cli.number(args, '--hz', push ? PUSH_HZ : DEFAULT_HZ);
  const layout = args.includes('--labels') ? 'labels' : 'position';
  const startChord = parseStartChord(cli.option(args, '--start-chord', START_CHORD.join('+')));
  const directory = session.resolve(args[0]);
  const countsFd = cli.number(args, '--counts-fd', null);
  const bridge = instrument(session.rpc(directory), () => 'input');
  if (push) return mainPush(bridge, {directory, hz, layout, startChord, countsFd});
  const rpc = bridge.rpc;
  const pad = countsFd === null ? null : padAge.create();
  if (countsFd !== null)
    setInterval(() => {
      const {exchanges, bridgeMs} = bridge.take();
      fs.write(countsFd, JSON.stringify({exchanges, bridgeMs, pad: pad?.take()}) + '\n', () => {});
    }, COUNTS_MS).unref();

  const tracker = createTracker();
  const keys = keysWatch();
  let stopping = false;
  let previous = null;
  let source = null;
  let storage = null;
  let sourceChecked = -Infinity;
  let overlayChecked = -Infinity;
  let paused = false;
  const write = line => process.stdout.write(line + '\n');
  const release = () => {
    const ups = flush(tracker);
    if (ups.length) write(touchLine(ups));
    const neutral = toMoonlight(NEUTRAL, layout);
    if (previous && !same(previous, neutral)) write(controllerLine(neutral));
    previous = null;
  };
  process.stdout.on('error', () => process.exit(0));
  process.on('SIGINT', () => (stopping = true));
  process.on('SIGTERM', () => (stopping = true));
  const interval = 1000 / hz;
  while (!stopping) {
    const started = performance.now();
    if (started - sourceChecked > SOURCE_CHECK_MS) {
      source = session.readSource(directory);
      storage = readStorage(directory);
      sourceChecked = started;
    }
    if (source?.package?.id === 'moonlight') {
      try {
        if (storage && started - overlayChecked > OVERLAY_CHECK_MS) {
          overlayChecked = started;
          const block = await rpc.read(storage.mapped + OVERLAY_READ.offset, OVERLAY_READ.bytes);
          const next = gate(paused, block);
          paused = next.paused;
          if (next.release) release();
        }
        if (!paused) {
          const readAt = performance.now();
          const bytes = await rpc.read(source.mapped, READ_BYTES);
          pad?.sample(bytes, readAt, performance.now());
          const result = frame(previous, bytes, tracker, layout, startChord);
          previous = result.controller;
          for (const line of result.lines) write(line);
          const note = keys(bytes);
          if (note) process.stderr.write(`${note} at ${new Date().toISOString()}\n`);
        }
      } catch (error) {
        process.stderr.write('Input read failed: ' + error.message + '\n');
      }
    } else if (previous || tracker.active.size) {
      release();
    }
    const wait = interval - (performance.now() - started);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, wait)));
  }
  release();
}

export {frame, keysWatch, gate, readStorage, OVERLAY_READ, READ_BYTES, createPushReader, runPush};

if (cli.isMain(import.meta))
  main().catch(error => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
