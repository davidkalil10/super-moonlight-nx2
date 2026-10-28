/**
 * Pushed input on the console: owns the native TCP connection and the repeating worker that
 * input-push-plan.js plans. Stop and retain rules are in CLAUDE.md.
 */
import {allocate} from '../../../../hbl-platform/sdk/native/allocate.js';
import {verify} from '../../../../hbl-platform/sdk/native/symbols.js';
import {prepareRepeating} from '../../../../hbl-platform/sdk/native/jobs.js';
import {
  CODE,
  verifyCode,
  verifyCopy,
  spawn,
  wait,
  join
} from '../../../../hbl-platform/sdk/native/thread.js';
import SYNC from '../../../../hbl-platform/sdk/native/os-sync-functions.json' with {type: 'json'};
import {create as createNativeTransport} from '../stream/native/native-tcp.js';
import * as pushPlan from './input-push-plan.js';

/** Room for the repeating frame, snapshot and results; spawn stores the thread at 0. */
const WORKER_BYTES = 0x400000;
/** Where pthread_join stores the worker's exit value. */
const EXIT_SLOT_OFFSET = 8;
/** The record counter's allocation; the u32 sits at its start, the record buffer after it. */
const COUNTER_BYTES = 0x1000;
const COUNT_BYTES = 4;
const BUFFER_OFFSET = 0x100;
const DEFAULT_HZ = 120;

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;
const STOP_POLL_MS = 10;

/** Reply output bytes for native calls: too few to carry an output slot, only the result. */
const SHORT = 2;
const RESULT_BYTES = 8;
/** The sync functions the frame calls besides send, which native-tcp.js verifies. */
const SYNC_NAMES = ['sleepThread', 'atomicAddU32'];

/** @typedef {import('../../../../hbl-platform/sdk/native/allocate.js').Rpc} Rpc */

/**
 * @typedef {object} PushOptions
 * @property {Rpc & {host?: string}} rpc
 * @property {number} state Address of the launcher's mapped state buffer.
 * @property {number | null} [ui] Address of the app's UI block, or null to push the state
 *   block alone.
 * @property {number} [hz] Records per second.
 * @property {(bytes: Buffer) => void} onData Gets every chunk the console sends.
 * @property {() => void} [onClose] Called once if the connection ends before stop() closes it.
 * @property {string} [host] Host address the console connects back to; defaults to rpc.host.
 * @property {number} [timeoutMs] Bounds the wait for the worker to stop.
 * @property {(options: {rpc: any, host: string}) => Promise<any>} [createTransport]
 */

/**
 * @typedef {object} InputPush
 * @property {number} recordBytes Bytes of one record: the state block, then the UI words.
 * @property {() => Promise<void>} start Spawns the worker.
 * @property {() => Promise<{pushed: number}>} stop Stops the worker and closes the socket;
 *   pushed is the console's record count. A short last send rejects after the close, with
 *   pushed on the error.
 * @property {boolean} running
 * @property {boolean} retained True when the socket and worker were kept for safety.
 */

/**
 * @param {any} rpc
 * @param {unknown} onData
 * @param {number} timeoutMs
 * @returns {boolean}
 */
function isBoundedSetup(rpc, onData, timeoutMs) {
  const sessionOk = Boolean(rpc?.a?.sdk);
  const callbackOk = typeof onData === 'function';
  const timeoutOk =
    Number.isInteger(timeoutMs) && timeoutMs >= MIN_TIMEOUT_MS && timeoutMs <= MAX_TIMEOUT_MS;

  return sessionOk && callbackOk && timeoutOk;
}

/**
 * Verifies the worker code, the copy the frame restores itself with and the sync functions
 * it calls.
 * @param {Rpc} rpc
 */
async function verifySetup(rpc) {
  await verifyCode(rpc);
  await verifyCopy(rpc);
  for (const name of SYNC_NAMES) await verify(rpc, rpc.a.sdk + SYNC[name].offset, SYNC[name].hex);
}

/**
 * Allocates and zeroes the record counter beside the record buffer, allocates the worker and
 * plans its frame.
 * @param {Rpc} rpc
 * @param {{fd: number, sendFunction: number}} transport
 * @param {{state: number, ui: number | null, hz: number}} options
 */
async function planWorker(rpc, transport, {state, ui, hz}) {
  const counter = await allocate(rpc, COUNTER_BYTES, {
    failed: 'Input push counter allocation failed',
    invalid: 'Invalid input push counter allocation'
  });
  await rpc.write(counter, Buffer.alloc(COUNT_BYTES));

  const base = await allocate(rpc, WORKER_BYTES, {
    failed: 'Input push worker allocation failed',
    invalid: 'Invalid input push worker allocation'
  });

  const plan = pushPlan.cycle({
    sdk: rpc.a.sdk,
    base,
    fd: transport.fd,
    send: transport.sendFunction,
    state,
    ui,
    buffer: ui === null ? null : counter + BUFFER_OFFSET,
    counter,
    hz
  });

  return {counter, base, plan};
}

/**
 * Opens the push connection and plans the worker; start() spawns it.
 * @param {PushOptions} options
 * @returns {Promise<InputPush>}
 */
async function create({
  rpc,
  state,
  ui = null,
  hz = DEFAULT_HZ,
  onData,
  onClose = () => {},
  host = rpc?.host,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createTransport = createNativeTransport
}) {
  if (!isBoundedSetup(rpc, onData, timeoutMs))
    throw Error('Input push needs a session rpc, a data callback and a bounded timeout');

  await verifySetup(rpc);
  const transport = await createTransport({rpc, host});
  let planned;
  try {
    transport.receive(onData, onClose);
    planned = await planWorker(rpc, transport, {state, ui, hz});
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }

  const {counter, base, plan} = planned;
  let started = false;
  let running = false;
  let stopped = false;
  let retained = false;
  let thread = null;
  let program = null;
  /** @type {{pushed: number} | null} */
  let report = null;

  /** Keeps the console socket and worker; only the host end goes, so nothing more is read. */
  function retain() {
    retained = true;
    transport.abort();
  }

  async function start() {
    if (started || stopped || retained) throw Error('Input push start is not available');

    started = true;
    program = await prepareRepeating(rpc, {
      base,
      code: CODE,
      calls: plan.calls,
      verified: plan.verified
    });

    try {
      thread = await spawn(rpc, base, program.live, {
        failed: 'Input push worker creation failed',
        outputBytes: SHORT
      });
    } catch (error) {
      retain();
      throw error;
    }
    running = true;
  }

  /**
   * Points the worker at its exit, waits for it and joins it; the socket keeps being read
   * meanwhile. Retains when any of that fails, since the worker may still be sending.
   * @returns {Promise<{pushed: number, error: Error | null}>} The console's record count and
   *   what is wrong with the last pass, if anything.
   */
  async function stopWorker() {
    try {
      await program.stop();
      const done = await wait(rpc, thread, {
        timeoutMs,
        pollMs: STOP_POLL_MS,
        invalid: 'Input push worker state invalid',
        outputBytes: SHORT
      });
      if (!done) throw Error('Input push worker did not stop; restart SmileBASIC');
      await join(rpc, thread, base + EXIT_SLOT_OFFSET, {
        failed: 'Input push worker join failed',
        outputBytes: SHORT
      });
    } catch (error) {
      retain();
      throw error;
    }

    running = false;
    const bytes = await rpc.read(program.results, plan.calls.length * RESULT_BYTES);
    const results = plan.calls.map((_, index) => bytes.readBigUInt64LE(index * RESULT_BYTES));
    const countWord = await rpc.read(counter, COUNT_BYTES);
    const pushed = countWord.readUInt32LE();

    try {
      pushPlan.checkedPush(results, plan.row);
      return {pushed, error: null};
    } catch (error) {
      return {pushed, error};
    }
  }

  /** Stops the worker, then closes the socket; a bad last pass is thrown once it is closed. */
  async function stop() {
    if (stopped) {
      if (retained) throw Error('Input push objects retained for safety');
      return report;
    }

    stopped = true;
    const checked = running ? await stopWorker() : {pushed: 0, error: null};
    if (retained) throw Error('Input push objects retained for safety');

    await transport.close();
    report = {pushed: checked.pushed};
    if (checked.error) throw Object.assign(checked.error, report);
    return report;
  }

  return {
    recordBytes: plan.recordBytes,
    start,
    stop,
    get running() {
      return running;
    },
    get retained() {
      return retained;
    }
  };
}

export {create};
