/**
 * The child processes of a native H.264 run: the hbmoonlight helper, the input feeder and the
 * audio stream, plus the socket audio report written at shutdown.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {AccessUnits} from './h264-stream.js';
import {helperArgs, H264_FD, AUDIO_FD} from './stream-options.js';

/**
 * @typedef {object} ChildrenContext
 * @property {any} options parseOptions() of the run.
 * @property {typeof import('node:child_process').spawn} spawnProcess
 * @property {string} helperPath
 * @property {string} directory The launcher run directory.
 * @property {any} rpc
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {number} feederExitMs
 * @property {() => number} now
 * @property {(value: any) => void} log
 * @property {() => void} requestIdr
 * @property {(counts: any) => void} addFeederCounts One counts line of the input feeder.
 * @property {() => boolean} isStopping
 */

/**
 * @typedef {object} Children
 * @property {any} helper
 * @property {any} reader The helper's AccessUnits.
 * @property {readline.Interface | null} statusLines
 * @property {any[]} children What stop() sends SIGINT to.
 * @property {{child: any, done: Promise<unknown>} | null} inputFeeder
 * @property {{stopped: boolean, retained: boolean, error: string | null} | null} inputPushStop
 * @property {any} socketAudioReport
 * @property {() => void} spawnHelper
 * @property {() => void} spawnInputFeeder
 * @property {(errors: any[]) => Promise<void>} awaitInputFeeder
 * @property {() => void} spawnAudioStream
 * @property {(soundSource: any, errors: any[]) => Promise<void>} closeSocketAudio
 */

/**
 * Builds the spawn, watch and shutdown steps of the children; their handles and reports live on
 * the returned object, which run() reads.
 * @param {ChildrenContext} ctx
 */
function createChildren(ctx) {
  const {options, spawnProcess, helperPath, directory, rpc, width, height, fps} = ctx;
  const {host, app, audio, queue, inputHz, inputPush, inputPushPad, audioFrames, bitrate} = options;
  const {feederExitMs, now, log, requestIdr, addFeederCounts, isStopping} = ctx;

  /** @type {Children} */
  const state = {
    helper: null,
    reader: null,
    statusLines: null,
    children: [],
    inputFeeder: null,
    inputPushStop: null,
    socketAudioReport: null,
    spawnHelper,
    spawnInputFeeder,
    awaitInputFeeder,
    spawnAudioStream,
    closeSocketAudio
  };

  /** The helper's JSON stderr: unit metadata goes to the reader, other events to the log. */
  function relayStatus(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      console.error('hbmoonlight ' + line);
      return;
    }
    if (record.type === 'au') state.reader.announce(record);
    else if (record.event !== 'stats') log(record);
  }

  function spawnHelper() {
    state.helper = spawnProcess(
      helperPath,
      helperArgs(host, app, {width, height, fps, bitrate, audio}),
      {
        stdio: ['pipe', 'ignore', 'pipe', audio ? 'pipe' : 'ignore', 'pipe']
      }
    );
    state.reader = new AccessUnits(
      /** @type {import('node:stream').Readable} */ (state.helper.stdio[H264_FD]),
      {
        maxQueuedUnits: queue,
        onBacklog: requestIdr,
        now
      }
    );
    state.helper.stdin.on('error', error => {
      if (!isStopping()) state.reader.fail(error);
    });
    state.helper.on('error', error => state.reader.fail(error));
    state.helper.on('exit', (code, signal) => {
      log({event: 'helper-exit', code, signal, stopping: isStopping()});
      if (!isStopping() && code !== 0)
        state.reader.fail(Error('hbmoonlight exited: ' + (signal || code)));
    });
    state.statusLines = readline.createInterface({input: state.helper.stderr});
    state.statusLines.on('line', relayStatus);
    state.statusLines.on('close', () => state.reader.endMetadata());
  }

  /** Fails the stream when a child cannot start or exits uninvited with a non-zero code. */
  function watchChild(child, name) {
    child.on('error', error => state.reader.fail(error));
    child.on('exit', (code, signal) => {
      if (!isStopping() && code !== 0)
        state.reader.fail(Error(name + ' exited: ' + (signal || code)));
    });
    state.children.push(child);
  }

  /**
   * The input feeder writes to the helper's stdin and its bridge counts to fd 3, plus its
   * record counts and, last, its stop report with --input-push.
   */
  function spawnInputFeeder() {
    const child = spawnProcess(
      process.execPath,
      [
        path.join(import.meta.dirname, '../../input/input-feeder.js'),
        directory,
        '--hz',
        String(inputHz),
        '--counts-fd',
        '3',
        ...(inputPush ? ['--push'] : []),
        ...(inputPushPad ? ['--push-pad'] : [])
      ],
      {
        stdio: ['ignore', state.helper.stdin, 'inherit', 'pipe']
      }
    );
    const done = [new Promise(resolve => child.once('exit', resolve))];
    if (child.stdio?.[3]) {
      const lines = readline.createInterface({
        input: /** @type {import('node:stream').Readable} */ (child.stdio[3])
      });
      if (inputPush) done.push(new Promise(resolve => lines.once('close', resolve)));
      lines
        .on('line', line => {
          try {
            addFeederCounts(JSON.parse(line));
          } catch {}
        })
        .on('error', error => log({event: 'input-counts-error', message: error.message}));
    }
    state.inputFeeder = {child, done: Promise.all(done)};
    watchChild(child, 'Moonlight input feed');
  }

  /**
   * Waits for the input feeder to stop its console worker and report, and kills it past
   * feederExitMs. A push feeder that was killed or did not report may have left its worker
   * running, so that counts as retained.
   */
  async function awaitInputFeeder(errors) {
    if (!state.inputFeeder) return;
    let timer;
    const late = new Promise(resolve => {
      timer = setTimeout(resolve, feederExitMs, false);
    });
    const exited = await Promise.race([state.inputFeeder.done.then(() => true), late]);
    clearTimeout(timer);
    if (!exited) {
      state.inputFeeder.child.kill('SIGKILL');
      log({event: 'input-feeder-killed', afterMs: feederExitMs});
    }

    if (!inputPush) return;
    if (!exited || !state.inputPushStop) {
      state.inputPushStop = {
        stopped: false,
        retained: true,
        error: exited ? 'input feeder sent no stop report' : 'input feeder did not exit'
      };
    }
    log({event: 'input-push-stop', ...state.inputPushStop});
    if (state.inputPushStop.retained)
      errors.push(Error('Input push worker retained for safety; restart SmileBASIC'));
  }

  /** The audio stream reads the helper's PCM pipe as its stdin. */
  function spawnAudioStream() {
    const child = spawnProcess(
      process.execPath,
      [
        path.join(import.meta.dirname, '../../audio/audio-stream.js'),
        directory,
        '--buffer-frames',
        String(audioFrames),
        '--queue',
        '2',
        '--prime',
        '2',
        '--stats'
      ],
      {
        stdio: [state.helper.stdio[AUDIO_FD], 'inherit', 'inherit']
      }
    );
    watchChild(child, 'Moonlight audio stream');
  }

  /** Socket audio report, written next to the run directory's other Moonlight records. */
  async function closeSocketAudio(soundSource, errors) {
    state.socketAudioReport = await soundSource.close();
    log({event: 'socket-audio', ...state.socketAudioReport});
    await fs
      .writeFile(
        path.join(directory, `moonlight-audio-${Date.now()}.json`),
        JSON.stringify(
          {
            session: rpc.a.session,
            mode: 'socket',
            completed: new Date().toISOString(),
            ...state.socketAudioReport
          },
          null,
          2
        )
      )
      .catch(error => errors.push(error));
    if (state.socketAudioReport.retainedForSafety)
      errors.push(Error(state.socketAudioReport.error));
  }

  return state;
}

export {createChildren};
