/**
 * Live sender: streams a Moonlight host into the running Moonlight app through native-h264.js.
 * Usage: node src/streamer/stream/session/live.js [runs/launcher-XXXX] --moonlight HOST APP [flags]
 */
import path from 'node:path';
import * as ring from '../../shared/ring.js';
import {findPrivateStorage} from '../../shared/feed.js';
import {HELPER} from './protocol-binary.js';
import * as session from '../../../../../hbl-platform/sdk/host/session.js';
import * as cli from '../../../../../hbl-platform/sdk/cli.js';
import * as nativeH264 from './native-h264.js';

/** The newest launcher run directory, for when none is given. */
function newestRun() {
  const newest = session.newest();
  console.log('Using ' + path.relative(process.cwd(), newest));
  return newest;
}

/** Checks the codec and the installed app, then streams through native-h264.js. */
async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => cli.number(args, name, fallback);
  if (cli.option(args, '--codec', 'h264') !== 'h264') throw Error('--codec is h264');
  const fps = option('--fps', 60);
  const size = cli.option(args, '--size', '1920x1080');
  const [width, height] = size.split('x').map(Number);
  const directory = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : newestRun();
  const rpc = session.rpc(directory);
  const storage = await findPrivateStorage(directory);
  if (storage.bytes < ring.MEMORY_BYTES)
    throw Error('The running Moonlight app predates HBV2; rebuild and reinstall it');
  const summary = await nativeH264.run({
    args,
    directory,
    rpc,
    storage,
    helperPath: HELPER,
    width,
    height,
    fps
  });
  if (!summary.pass) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
