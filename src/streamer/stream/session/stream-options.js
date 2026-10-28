/**
 * Stream flags: parsing and range checks, and the helper command line they build.
 */
import * as cli from '../../../../../hbl-platform/sdk/cli.js';
import * as scoring from './run-summary.js';
import {bitrate as streamBitrate} from './bitrate.js';
import * as exchangeTiming from '../scheduler/exchange-timing.js';
import {MAX_HZ as MAX_PUSH_HZ} from '../../input/input-push-plan.js';

/** The host runs at present pace, so it needs room for a source burst (batch C2). */
const QUEUE = 8;
/** The helper's pipes: raw H.264 on fd 4, PCM on fd 3. */
const H264_FD = 4;
const AUDIO_FD = 3;
/** Audio buffers come in steps of 240 frames. */
const FRAME_STEP = 240;
/** The most frames the socket audio source buffers. */
const SOCKET_AUDIO_FRAMES = 3840;

/** The range checks of the stream flags, in the order they are reported. */
function checkFlags(args, flags) {
  checkInputFlags(flags);
  const {presentHz} = flags;
  if (presentHz !== 60 && presentHz !== 120) throw Error('--present-hz takes 60 or 120');

  checkSkipFlags(flags);
  checkDrainFlag(flags);
  checkGateFlags(flags);
  checkRunFlags(args, flags);
  if (flags.stageTicks && !args.includes('--staggered'))
    throw Error('HBL_STAGE_TICKS=1 needs --staggered');
}

/** --input-hz and --input-push-pad, whose pad read per pass may run at the push plan's cap. */
function checkInputFlags({inputHz, inputPush, inputPushPad}) {
  if (inputPushPad && !inputPush) throw Error('--input-push-pad needs --input-push');

  const hzUpTo = max => Number.isInteger(inputHz) && inputHz >= 10 && inputHz <= max;
  if (inputPushPad && !hzUpTo(MAX_PUSH_HZ))
    throw Error(`--input-hz takes 10 to ${MAX_PUSH_HZ} with --input-push-pad`);
  if (!inputPushPad && !hzUpTo(120)) throw Error('--input-hz takes 10 to 120');
}

/** --skip-backlog, --skip-rule, --decode-wait and --trim-backlog-ms. */
function checkSkipFlags({skipBacklog, skipRule, decodeWait, trimBacklogMs}) {
  const skipCount = Number.isInteger(skipBacklog) && skipBacklog >= 0;
  if (skipBacklog !== Infinity && !skipCount)
    throw Error('--skip-backlog takes a unit count or off');
  if (!['backlog', 'vsync'].includes(skipRule)) throw Error('--skip-rule takes backlog or vsync');
  if (skipRule === 'vsync' && skipBacklog === Infinity)
    throw Error('--skip-rule vsync needs a --skip-backlog unit count');
  if (decodeWait && skipRule !== 'vsync') throw Error('--decode-wait needs --skip-rule vsync');

  if (trimBacklogMs === null) return;
  if (!(trimBacklogMs > 0)) throw Error('--trim-backlog-ms takes a unit age in milliseconds');
  if (skipRule === 'vsync') throw Error('--trim-backlog-ms needs --skip-rule backlog');
  if (skipBacklog < 1) throw Error('--trim-backlog-ms needs --skip-backlog 1 or more');
}

/** --drain-gates: a gate count, on the backlog rule, without the gate queue. */
function checkDrainFlag({drainGates, skipRule, gateQueue}) {
  if (drainGates === null) return;
  if (!Number.isInteger(drainGates) || drainGates < 1 || drainGates > 8)
    throw Error('--drain-gates takes 1 to 8 gates');
  if (skipRule === 'vsync') throw Error('--drain-gates needs --skip-rule backlog');
  if (gateQueue) throw Error('--drain-gates is untested with --gate-queue');
}

/** --avoid-window, --gate-on-receive, --gate-queue and --output-lag; refusals as in CLAUDE.md. */
function checkGateFlags(flags) {
  const {decodeWait, receiveWait, avoidWindow, gateOnReceive, gateQueue, outputLag} = flags;
  if (avoidWindow && !(decodeWait || receiveWait))
    throw Error('--avoid-window needs --decode-wait or --receive-wait to predict the events');
  if (gateOnReceive && flags.presentHz === 120)
    throw Error('--gate-on-receive is untested at --present-hz 120');
  if (gateQueue && !gateOnReceive) throw Error('--gate-queue needs --gate-on-receive');

  const knownLag = outputLag === 1 || outputLag === 2;
  if (outputLag !== null && !knownLag) throw Error('--output-lag takes 1 or 2');
}

/** --audio-frames, --queue, --duration, --warmup and --expect. */
function checkRunFlags(args, {audioFrames, socketAudio, queue, duration, warmup}) {
  const audioStep = Number.isInteger(audioFrames) && audioFrames >= FRAME_STEP;
  if (!audioStep || audioFrames % FRAME_STEP) throw Error('--audio-frames takes a multiple of 240');
  if (socketAudio && audioFrames > SOCKET_AUDIO_FRAMES)
    throw Error('--audio-frames takes up to 3840 with --socket-audio');

  if (!Number.isInteger(queue) || queue < 1 || queue > 16)
    throw Error('--queue takes 1 to 16 units');
  if (duration !== null && !(duration > 0)) throw Error('--duration takes seconds');
  if (!Number.isInteger(warmup) || warmup < 0) throw Error('--warmup takes whole seconds');

  if (!args.includes('--expect')) return;
  if (!/^[a-z]/i.test(cli.option(args, '--expect') ?? ''))
    throw Error('--expect needs a value such as fps=30,dropped=0,idr=0');
}

/** Audio buffer frames without --audio-frames: 960 from launcher protocol 3 on. */
function defaultAudioFrames(socketAudio, rpc) {
  if (socketAudio) return 1920;
  return rpc.a.protocol >= 3 ? 960 : 1920;
}

/**
 * Reads the stream flags, and HBL_STAGE_TICKS from `env`; throws on the first one that is
 * missing or out of range.
 */
function parseOptions(args, rpc, width, height, fps, env = process.env) {
  const at = args.indexOf('--moonlight');
  const host = args[at + 1];
  const app = args[at + 2];
  if (at < 0 || !host || !app) throw Error('Native H.264 requires --moonlight HOST APP');
  const audio = !args.includes('--no-audio');
  const socketTone = args.includes('--socket-audio-tone');
  const socketAudio = socketTone || args.includes('--socket-audio');
  if (socketAudio && !audio) throw Error('--socket-audio cannot be combined with --no-audio');
  const inputPush = args.includes('--input-push');
  if (inputPush && args.includes('--no-input'))
    throw Error('--input-push cannot be combined with --no-input');
  const skipRule = cli.option(args, '--skip-rule') ?? 'backlog';
  const presentHz = cli.number(args, '--present-hz', 60);
  // D (lag 1, skip 1) won at 60 Hz; 120 Hz keeps lag 2.
  const at60 = presentHz === 60;
  const skipDefault = at60 || skipRule === 'vsync' ? 1 : 2;
  const flags = {
    host,
    app,
    audio,
    socketTone,
    socketAudio,
    duration: cli.number(args, '--duration', null),
    warmup: cli.number(args, '--warmup', 3),
    queue: cli.number(args, '--queue', QUEUE),
    inputHz: cli.number(args, '--input-hz', inputPush ? 120 : 60),
    inputPush,
    inputPushPad: args.includes('--input-push-pad'),
    presentHz,
    skipRule,
    trimBacklogMs: cli.number(args, '--trim-backlog-ms', null),
    drainGates: cli.number(args, '--drain-gates', null),
    gateOnReceive: args.includes('--gate-on-receive'),
    gateQueue: args.includes('--gate-queue'),
    outputLag: cli.number(args, '--output-lag', at60 ? 1 : null),
    decodeWait: args.includes('--decode-wait'),
    receiveWait: args.includes('--receive-wait'),
    stageTicks: env.HBL_STAGE_TICKS === '1',
    avoidWindow: exchangeTiming.parseAvoid(cli.option(args, '--avoid-window') ?? undefined),
    skipBacklog:
      cli.option(args, '--skip-backlog') === 'off'
        ? Infinity
        : cli.number(args, '--skip-backlog', skipDefault),
    audioFrames: cli.number(args, '--audio-frames', defaultAudioFrames(socketAudio, rpc)),
    input: !args.includes('--no-input')
  };
  checkFlags(args, flags);
  return {
    ...flags,
    expect: scoring.parseExpect(cli.option(args, '--expect') ?? undefined),
    bitrate: streamBitrate(args, width, height, fps)
  };
}

/** The helper's stream command: raw H.264 on H264_FD and, with audio, PCM on AUDIO_FD. */
function helperArgs(host, app, {width, height, fps, bitrate, audio}) {
  return [
    'stream',
    host,
    app,
    '--size',
    `${width}x${height}`,
    '--fps',
    String(fps),
    '--bitrate',
    bitrate,
    '--raw-h264-fd',
    String(H264_FD),
    ...(audio ? ['--audio-fd', String(AUDIO_FD)] : [])
  ];
}

export {parseOptions, helperArgs, H264_FD, AUDIO_FD};
