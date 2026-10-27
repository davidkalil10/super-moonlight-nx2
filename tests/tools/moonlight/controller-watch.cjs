// Prints the console controller as Moonlight gamepad state whenever it changes,
// polled at frame rate while the moonlight app is open.
// Each poll is one bridge read (two with --sources) and competes with the video
// sender for console exchanges.
// Usage: node tools/moonlight/controller-watch.cjs [runs/launcher-XXXX] [--hz 60]
//        [--labels] [--sources]
const path = require('node:path');
const session = require('../../../hbl-platform/sdk/host/session.js');
const cli = require('../../../hbl-platform/sdk/cli.js');
const {
  NEUTRAL,
  toMoonlight,
  same,
  readController
} = require('../../../hbl-moonlight/host/input/controller.js');

async function main() {
  const args = process.argv.slice(2);
  const hz = cli.number(args, '--hz', 60),
    layout = args.includes('--labels') ? 'labels' : 'position',
    sources = args.includes('--sources');
  const directory = session.resolve(args[0]);
  console.log(`Using ${path.relative(process.cwd(), directory)} (${layout} layout, ${hz} Hz)`);
  const rpc = session.rpc(directory);

  let stopping = false,
    previous = null,
    source = null,
    sourceChecked = -Infinity;
  process.on('SIGINT', () => (stopping = true));
  const interval = 1000 / hz;
  while (!stopping) {
    const started = performance.now();
    if (started - sourceChecked > 250) {
      source = session.readSource(directory);
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
