/**
 * Controller and touch feed for the stream helper: JSON lines for hbmoonlight's stdin, read
 * over the bridge or pushed by a console worker. Flags and line formats are in CLAUDE.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as session from '../../../../hbl-platform/sdk/host/session.js';
import * as cli from '../../../../hbl-platform/sdk/cli.js';
import {STATE} from '../../../../hbl-platform/sdk/host/layout.js';
import {
  FLAG,
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
import {UI, UI_MAGIC} from '../shared/ring.js';
import {instrument} from '../stream/native/bridge-counter.js';
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
/** How long a loopback probe press is held. */
const PROBE_HOLD_MS = 100;
/** Spread of the probe period, so presses land at every phase of the PC's refresh. */
const PROBE_JITTER_MS = 16;

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

/**
 * Timed D-pad Up presses for the loopback probe: one every periodMs plus up to
 * PROBE_JITTER_MS, held PROBE_HOLD_MS.
 * @param {number} periodMs
 * @param {() => number} [random]
 */
function createProbe(periodMs, random = Math.random) {
  if (!(periodMs >= 2 * PROBE_HOLD_MS))
    throw Error('HBL_PROBE_PRESS_MS must be a number of ms, at least ' + 2 * PROBE_HOLD_MS);

  let edge = 0;
  let pressed = false;
  let next = null;
  return {
    periodMs,
    /**
     * The controller change due at `now`, if any.
     * @param {number} now
     */
    due(now) {
      if (next === null) next = now + periodMs;
      if (now < next) return null;

      pressed = !pressed;
      if (pressed) edge++;
      next = pressed
        ? now + PROBE_HOLD_MS
        : now + periodMs - PROBE_HOLD_MS + random() * PROBE_JITTER_MS;

      const controller = {
        ...toMoonlight(NEUTRAL),
        connected: true,
        buttonFlags: pressed ? FLAG.up : 0
      };
      return {controller, line: controllerLine(controller), edge, pressed};
    }
  };
}

/**
 * The probe HBL_PROBE_PRESS_MS asks for, or null when it is unset or empty, and the feeder
 * reads the pad as it does without the probe.
 * @param {Record<string, string | undefined>} env
 */
function probeFromEnv(env) {
  const value = env.HBL_PROBE_PRESS_MS;
  return value ? createProbe(Number(value)) : null;
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
 * uiMagic, which is the magic once a service attached and 0 before. Once the magic was seen, 0
 * no longer counts until the reader attaches again. A short send shifts every later record, and
 * the word there is then pad or touch bytes.
 * @param {Buffer} record
 * @param {boolean} sawMagic
 * @returns {boolean}
 */
function framed(record, sawMagic) {
  if (record.length === STATE_BYTES) return true;

  const magic = record.readUInt32LE(STATE_BYTES);
  if (magic === UI_MAGIC) return true;

  return magic === 0 && !sawMagic;
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
 * Push counts since the last take.
 * @typedef {object} PushCounts
 * @property {number} pushed records that arrived
 * @property {number} dropped records a backlog burst dropped
 * @property {number} gapMaxMs the longest gap between arrivals
 * @property {number} applied records that stepped the app frame count outside the overlay
 * @property {number} changes the controller and touch lines those sent
 */

/**
 * The push mode reader: records arrive whole or split and are applied in order. A repeated
 * STATE.frames is a launcher frame already seen (the push outruns the pad copy) and only feeds
 * the overlay gate; a count going back means a new launcher session. Not frameIndex: it stays
 * 0 under time service version 1 (pad-age.js). More than
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
  let sawMagic = false;
  let recordBytes = 0;
  let pending = Buffer.alloc(0);
  let counts = {pushed: 0, dropped: 0, gapMaxMs: 0, applied: 0, changes: 0};

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

    const frames = record.readUInt32LE(STATE.frames);
    if (frames === lastFrame) return;

    if (lastFrame !== null && frames < lastFrame) {
      log(`Input push frame count went back from ${lastFrame} to ${frames}; new session`);
      release();
    }
    lastFrame = frames;
    if (paused) return;

    counts.applied++;
    const state = record.subarray(0, STATE_BYTES);
    const result = frame(previous, state, tracker, layout, startChord);
    previous = result.controller;
    counts.changes += result.lines.length;
    for (const line of result.lines) write(line);

    const note = keys(state);
    if (note) log(`${note} at ${new Date().toISOString()}`);
  }

  return {
    /** @param {number} bytes Record size of the worker the next data comes from. */
    attach(bytes) {
      recordBytes = bytes;
      pending = Buffer.alloc(0);
      sawMagic = false;
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
        if (!framed(record(index), sawMagic)) {
          broken = true;
          pending = Buffer.alloc(0);
          throw Error('Input push lost the record framing; a console send was short');
        }

        // Latched per record, since the next record in this chunk is framed against it.
        if (!sawMagic && recordBytes > STATE_BYTES) {
          sawMagic = record(index).readUInt32LE(STATE_BYTES) !== 0;
        }
      }

      const at = now();
      if (lastAt !== null) counts.gapMaxMs = Math.max(counts.gapMaxMs, at - lastAt);
      lastAt = at;
      heardAt = at;
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
        log(`Input push stalled at frame ${lastFrame}`);
      }

      if (heardAt === null || at - heardAt < SILENT_MS) return;

      heardAt = null;
      throw Error(`Input push heard nothing from the console for ${SILENT_MS} ms`);
    },
    /** Releases what is held and forgets the last arrival, so a stopped worker is no stall. */
    detach() {
      release();
      lastAt = null;
      heardAt = null;
      stalled = false;
    },
    /**
     * Since the last take.
     * @returns {PushCounts}
     */
    take() {
      const open = lastAt === null ? 0 : now() - lastAt;
      const result = {...counts, gapMaxMs: Math.round(Math.max(counts.gapMaxMs, open))};
      counts = {pushed: 0, dropped: 0, gapMaxMs: 0, applied: 0, changes: 0};

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
 * @returns {{take: () => PushCounts,
 *   stop: () => Promise<void>, retained: boolean}}
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
  let retained = false;
  let sourceChecked = -Infinity;

  /** @param {Error} error */
  function fail(error) {
    if (failed) return;

    failed = true;
    log('Input push failed: ' + error.message);
    onFailure(error);
  }

  /** @param {Buffer} bytes */
  function feed(bytes) {
    try {
      reader.data(bytes);
    } catch (error) {
      fail(error);
    }
  }

  /** Only the current worker reaches the reader; a stopping or retained one is cut off. */
  async function startWorker(state, ui) {
    let created = null;
    const current = () => created !== null && worker === created;

    created = await createWorker({
      rpc,
      state,
      ui,
      hz,
      onData: bytes => {
        if (current()) feed(bytes);
      },
      onClose: () => {
        if (current()) fail(Error('Input push socket closed by the console'));
      }
    });

    worker = created;
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
    } catch (error) {
      retained ||= stopping.retained;
      throw error;
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
      .finally(() => {
        busy = null;
      });
  }, PUSH_CHECK_MS);

  return {
    take: () => reader.take(),
    async stop() {
      clearInterval(timer);
      await busy;
      if (worker) await stopWorker();
      else reader.detach();
    },
    /** True once a worker that would not stop was kept for safety. */
    get retained() {
      return retained;
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
  const finished = new Promise(resolve => {
    finish = resolve;
  });

  let closed = false;
  // A gone helper must not skip the worker stop, so its pipe error only ends the run.
  process.stdout.on('error', () => {
    closed = true;
    finish();
  });
  process.on('SIGINT', () => finish());
  process.on('SIGTERM', () => finish());

  let failure = null;
  const push = runPush({
    rpc: bridge.rpc,
    directory,
    hz,
    layout,
    startChord,
    write: line => {
      if (!closed) process.stdout.write(line + '\n');
    },
    log: message => process.stderr.write(message + '\n'),
    onFailure: error => {
      failure = error;
      process.exitCode = 1;
      finish();
    }
  });

  if (countsFd !== null) {
    setInterval(() => {
      const {exchanges, bridgeMs} = bridge.take();
      const line = JSON.stringify({exchanges, bridgeMs, ...push.take()});
      fs.write(countsFd, line + '\n', () => {});
    }, COUNTS_MS).unref();
  }

  await finished;

  let stopError = null;
  try {
    await push.stop();
  } catch (error) {
    stopError = error;
  }

  const errors = [failure, stopError].filter(Boolean).map(error => error.message);
  const report = {stopped: !stopError, retained: push.retained, error: errors.join('; ') || null};
  if (countsFd !== null) {
    try {
      fs.writeSync(countsFd, JSON.stringify(report) + '\n');
    } catch {}
  }

  if (!stopError) return;
  if (!push.retained) throw stopError;

  // The retained worker's console socket stays open, so the process is ended here.
  process.stderr.write(stopError.message + '\n');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const push = args.includes('--push');
  const hz = cli.number(args, '--hz', push ? PUSH_HZ : DEFAULT_HZ);
  const layout = args.includes('--labels') ? 'labels' : 'position';
  const startChord = parseStartChord(cli.option(args, '--start-chord', START_CHORD.join('+')));
  const directory = session.resolve(args[0]);
  const countsFd = cli.number(args, '--counts-fd', null);
  const probe = probeFromEnv(process.env);
  if (probe && push) throw Error('HBL_PROBE_PRESS_MS needs pull mode, not --push');
  if (probe) {
    const announce = {event: 'probe-press', periodMs: probe.periodMs, pad: 'ignored'};
    process.stderr.write(JSON.stringify(announce) + '\n');
  }

  const bridge = instrument(session.rpc(directory), () => 'input');
  if (push) return mainPush(bridge, {directory, hz, layout, startChord, countsFd});

  const rpc = bridge.rpc;
  const pad = countsFd === null ? null : padAge.create();
  if (countsFd !== null) {
    setInterval(() => {
      const {exchanges, bridgeMs} = bridge.take();
      const line = JSON.stringify({exchanges, bridgeMs, pad: pad?.take()});
      fs.write(countsFd, line + '\n', () => {});
    }, COUNTS_MS).unref();
  }

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
  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });

  const interval = 1000 / hz;
  while (!stopping) {
    const started = performance.now();
    if (started - sourceChecked > SOURCE_CHECK_MS) {
      source = session.readSource(directory);
      storage = readStorage(directory);
      sourceChecked = started;
    }

    if (source?.package?.id === 'moonlight' && probe) {
      const press = probe.due(started);
      if (press) {
        write(press.line);
        previous = press.controller;
        const {edge, pressed} = press;
        const wallUs = Math.round((performance.timeOrigin + performance.now()) * 1000);
        process.stderr.write(JSON.stringify({event: 'probe-press', edge, pressed, wallUs}) + '\n');
      }
    } else if (source?.package?.id === 'moonlight') {
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

export {
  frame,
  keysWatch,
  gate,
  readStorage,
  createProbe,
  probeFromEnv,
  OVERLAY_READ,
  READ_BYTES,
  createPushReader,
  runPush
};

if (cli.isMain(import.meta)) {
  main().catch(error => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}
