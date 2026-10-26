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
 * Usage: node tools/moonlight/input-feeder.js [runs/launcher-XXXX] [--hz 60] [--labels]
 */
import * as session from '../../../hbl-platform/sdk/host/session.js';
import * as cli from '../../../hbl-platform/sdk/cli.js';
import {STATE} from '../../../hbl-platform/sdk/host/state-layout.js';
import {NEUTRAL, decode, toMoonlight, same, NPAD_BYTES} from './controller.js';
import {TOUCH_BYTES, parseTouch, createTracker, step, flush, touchLine} from './touch.js';
import {UI} from './ring.js';

/** One read from the start of the state buffer to the end of the touch block. */
const READ_BYTES = STATE.touch + TOUCH_BYTES;
const DEFAULT_HZ = 60;
/** How often the session's source file is re-read to see which app is running. */
const SOURCE_CHECK_MS = 250;
/** How often the console UI overlay word is read; input is dropped while it is raised. */
const OVERLAY_CHECK_MS = 100;

/**
 * @param {object} controller toMoonlight fields
 * @returns {string}
 */
function controllerLine(controller) {
  return JSON.stringify({type: 'controller', ...controller});
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

/**
 * Whether this frame's input reaches the host: the console UI raises uiOverlay while its
 * overlay page covers the stream, and the game must not see the presses that drive it. The
 * frame the overlay goes up releases what is held.
 * @param {boolean} paused
 * @param {number} overlay the uiOverlay word
 * @returns {{paused: boolean, release: boolean}}
 */
function gate(paused, overlay) {
  const raised = overlay !== 0;
  return {paused: raised, release: raised && !paused};
}

async function main() {
  const args = process.argv.slice(2);
  const hz = cli.number(args, '--hz', DEFAULT_HZ);
  const layout = args.includes('--labels') ? 'labels' : 'position';
  const directory = session.resolve(args[0]);
  const rpc = session.rpc(directory);

  const tracker = createTracker();
  let stopping = false;
  let previous = null;
  let source = null;
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
      sourceChecked = started;
    }
    if (source?.package?.id === 'moonlight') {
      try {
        if (started - overlayChecked > OVERLAY_CHECK_MS) {
          overlayChecked = started;
          const overlay = (await rpc.read(source.mapped + UI.uiOverlay, 4)).readUInt32LE(0);
          const next = gate(paused, overlay);
          paused = next.paused;
          if (next.release) release();
        }
        if (!paused) {
          const bytes = await rpc.read(source.mapped, READ_BYTES);
          const result = frame(previous, bytes, tracker, layout);
          previous = result.controller;
          for (const line of result.lines) write(line);
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

export {frame, gate, READ_BYTES};

if (cli.isMain(import.meta))
  main().catch(error => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
