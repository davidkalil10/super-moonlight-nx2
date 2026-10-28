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
 * Usage: node host/input/input-feeder.js [runs/launcher-XXXX] [--hz 60] [--labels]
 *        [--counts-fd N]
 */
import fs from 'node:fs';
import path from 'node:path';
import * as session from '../../../hbl-platform/sdk/host/session.js';
import * as cli from '../../../hbl-platform/sdk/cli.js';
import {STATE} from '../../../hbl-platform/sdk/host/layout.js';
import {NPAD, NEUTRAL, decode, toMoonlight, same, NPAD_BYTES} from './controller.js';
import {TOUCH_BYTES, parseTouch, createTracker, step, flush, touchLine} from './touch.js';
import {UI, UI_MAGIC} from '../../tools/moonlight/ring.js';
import {instrument} from '../stream/bridge-counter.js';
import * as padAge from './pad-age.js';

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
 * @returns {{lines: string[], controller: ReturnType<typeof toMoonlight>}}
 */
function frame(previous, bytes, tracker, layout) {
  const lines = [];
  const controller = toMoonlight(decode(bytes.subarray(0, NPAD_BYTES)), layout);
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

async function main() {
  const args = process.argv.slice(2);
  const hz = cli.number(args, '--hz', DEFAULT_HZ);
  const layout = args.includes('--labels') ? 'labels' : 'position';
  const directory = session.resolve(args[0]);
  const countsFd = cli.number(args, '--counts-fd', null);
  const bridge = instrument(session.rpc(directory), () => 'input');
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
          const result = frame(previous, bytes, tracker, layout);
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

export {frame, keysWatch, gate, readStorage, OVERLAY_READ, READ_BYTES};

if (cli.isMain(import.meta))
  main().catch(error => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
