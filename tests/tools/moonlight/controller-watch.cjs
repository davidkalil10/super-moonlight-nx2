// Prints the console controller as Moonlight gamepad state whenever it changes,
// polled at frame rate while the moonlight app is open.
// Each poll is one bridge read (two with --sources) and competes with the video
// sender for console exchanges; DESIGN.md plans to fold it into the frame write.
// Usage: node tools/moonlight/controller-watch.cjs [runs/launcher-XXXX] [--hz 60]
//        [--labels] [--sources]
const fs = require('node:fs');
const path = require('node:path');
const {NEUTRAL, toMoonlight, same, readController} = require('./controller.cjs');

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

async function main() {
  const args = process.argv.slice(2);
  const hz = args.includes('--hz') ? Number(args[args.indexOf('--hz') + 1]) : 60,
    layout = args.includes('--labels') ? 'labels' : 'position',
    sources = args.includes('--sources');
  const directory = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : newestRun();
  console.log(`Using ${path.relative(process.cwd(), directory)} (${layout} layout, ${hz} Hz)`);
  const rpc = require(path.join(directory, 'shared/rpc.cjs'));

  let stopping = false,
    previous = null,
    source = null,
    sourceChecked = -Infinity;
  process.on('SIGINT', () => (stopping = true));
  const interval = 1000 / hz;
  while (!stopping) {
    const started = performance.now();
    if (started - sourceChecked > 250) {
      source = readSource(directory);
      sourceChecked = started;
    }
    let pad = NEUTRAL;
    if (source?.package?.id === 'moonlight')
      try {
        pad = await readController(rpc, source.mapped, {sources});
      } catch (error) {
        console.error('Controller read failed: ' + error.message);
      }
    const state = toMoonlight(pad, layout);
    if (!same(previous, state)) console.log(JSON.stringify(state));
    previous = state;
    const wait = interval - (performance.now() - started);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, wait)));
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
