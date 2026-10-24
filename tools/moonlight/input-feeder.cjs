// Unified controller + touch feed for the stream helper. Attaches to the newest
// (or named) runs/launcher-* session, reads the mapped state once per frame and
// writes tagged JSON lines to stdout, meant to be piped into hbmoonlight's stdin:
//   {"type":"controller",...}  on change (controller.cjs fields)
//   {"type":"touch","events":[{id,action,x,y,pressure}...]}  when touch changes
//
// Pad bytes (0..40) and the touch block (128..784) are contiguous in the mapped
// buffer, so one rpc.read of 784 bytes covers both and halves the console
// exchanges competing with the video sender. --sources is intentionally not
// supported here; the extra pad sources live far outside that window.
//
// Usage: node tools/moonlight/input-feeder.cjs [runs/launcher-XXXX] [--hz 60] [--labels]
const fs = require('node:fs');
const path = require('node:path');
const {STATE} = require('../../homebrew-launcher/state-layout.cjs');
const {NEUTRAL, decode, toMoonlight, same, NPAD_BYTES} = require('./controller.cjs');
const {TOUCH_BYTES, parseTouch, createTracker, step, flush, touchLine} = require('./touch.cjs');

const READ_BYTES = STATE.touch + TOUCH_BYTES;

function newestRun() {
  const runs = path.join(__dirname, '../../runs');
  const newest = fs
    .readdirSync(runs)
    .filter(name => name.startsWith('launcher-'))
    .map(name => path.join(runs, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!newest) throw Error('No launcher session found in runs/');
  return newest;
}

function readSource(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'game-audio-source.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Pure per-frame mapping, shared with the tests: one state buffer in, the lines
// to emit plus the controller state to remember next frame out.
function frame(previous, bytes, tracker, layout) {
  const lines = [];
  const controller = toMoonlight(decode(bytes.subarray(0, NPAD_BYTES)), layout);
  if (!same(previous, controller)) lines.push(JSON.stringify({type: 'controller', ...controller}));
  const {events} = step(tracker, parseTouch(bytes.subarray(STATE.touch)));
  if (events.length) lines.push(touchLine(events));
  return {lines, controller};
}

async function main() {
  const args = process.argv.slice(2);
  const hz = args.includes('--hz') ? Number(args[args.indexOf('--hz') + 1]) : 60,
    layout = args.includes('--labels') ? 'labels' : 'position';
  const directory = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : newestRun();
  const rpc = require(path.join(directory, 'shared/rpc.cjs'));

  const tracker = createTracker();
  let stopping = false,
    previous = null,
    source = null,
    sourceChecked = -Infinity;
  const write = line => process.stdout.write(line + '\n');
  const release = () => {
    const ups = flush(tracker);
    if (ups.length) write(touchLine(ups));
    const neutral = toMoonlight(NEUTRAL, layout);
    if (previous && !same(previous, neutral))
      write(JSON.stringify({type: 'controller', ...neutral}));
    previous = null;
  };
  process.stdout.on('error', () => process.exit(0));
  process.on('SIGINT', () => (stopping = true));
  process.on('SIGTERM', () => (stopping = true));
  const interval = 1000 / hz;
  while (!stopping) {
    const started = performance.now();
    if (started - sourceChecked > 250) {
      source = readSource(directory);
      sourceChecked = started;
    }
    if (source?.package?.id === 'moonlight') {
      try {
        const bytes = await rpc.read(source.mapped, READ_BYTES);
        const result = frame(previous, bytes, tracker, layout);
        previous = result.controller;
        for (const line of result.lines) write(line);
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

module.exports = {frame, READ_BYTES};

if (require.main === module)
  main().catch(error => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
