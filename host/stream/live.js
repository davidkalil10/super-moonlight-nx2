/**
 * Live sender: streams a Moonlight host into the running Moonlight app through the console's
 * native H.264 decoder (native-h264.js).
 *
 * Usage: node host/stream/live.js [runs/launcher-XXXX] --moonlight HOST APP
 *   [--bitrate KBPS|auto] [--codec h264] [--size 1920x1080] [--fps 60]
 *   [--duration S] [--warmup S] [--expect fps=30,dropped=0,idr=0] [--queue 8]
 *   [--input-hz 60] [--audio-frames 960]
 *   [--staggered] (no-op: the staggered workers are the only route)
 *   [--present-hz 60|120] [--skip-backlog 2|off] [--skip-rule backlog|vsync]
 *   [--trim-backlog-ms N] (backlog rule: skip one output once the unit in hand is N ms old
 *     at 3 gates in a row)
 *   [--gate-on-receive] (prime and gate each unit as it arrives instead of on the next one)
 *   [--gate-queue] (with --gate-on-receive: queue each gate instead of awaiting it in push)
 *   [--output-lag 0|1|2] (fetch each output 0, 1 or 2 gates after its decode opened; 2 by
 *     default, 0 only at 60 Hz without --gate-on-receive)
 *   [--decode-wait] (with --skip-rule vsync) [--receive-wait] [--avoid-window BEFORE-AFTER]
 *   [--socket-audio | --socket-audio-tone] (PCM or a 500 Hz test tone over native TCP to a
 *     console worker)
 *
 * --moonlight runs tools/moonlight/helper's hbmoonlight (path from $HBMOONLIGHT) and, unless
 * --no-input / --no-audio, also feeds controller+touch into its stdin (input-feeder.js) and
 * plays its audio on the console (audio-stream.js, or socket-audio-source.js with
 * --socket-audio).
 */
import path from 'node:path';
import * as ring from '../../tools/moonlight/ring.js';
import {findPrivateStorage} from '../../tools/moonlight/feed.js';
import {HELPER} from './helper.js';
import * as session from '../../../hbl-platform/sdk/host/session.js';
import * as cli from '../../../hbl-platform/sdk/cli.js';
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
