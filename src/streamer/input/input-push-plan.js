/**
 * Native call plan for pushed input: a repeating console worker sends the launcher's mapped
 * pad and touch block and the app's UI overlay words on a native TCP socket once per period,
 * so the input feeder no longer reads them over the bridge (team note `z38-input-push.md`).
 *
 * Each pass copies the state block and the UI block side by side into a worker buffer and
 * sends them as one record, so the console's socket, which has no TCP_NODELAY, never holds a
 * small second send behind the first. It then counts the record in a console word the host
 * reads back at stop and sleeps one period. The sleep comes last because a repeating
 * frame only reads its selector after its calls: a stop written while the worker sleeps ends
 * the thread at the loop tail, so a stop wake never reaches send. Without a UI address the
 * record is the state block alone, sent straight from the state buffer.
 *
 * The frame is a straight chain and cannot branch on a result, so a short send cannot end it
 * from the console side. checkedPush validates the last pass's send counts the way the audio
 * recycle check does: a short or failed send makes the host take the exit and report it.
 */
import {repeatingFrame} from '../../../../hbl-platform/sdk/native/jobs.js';
import {CODE, IPC_COPY} from '../../../../hbl-platform/sdk/native/thread.js';
import SYNC from '../../../../hbl-platform/sdk/native/os-sync-functions.json' with {type: 'json'};
import {STATE} from '../../../../hbl-platform/sdk/host/layout.js';
import {UI} from '../shared/ring.js';
import {TOUCH_BYTES} from './touch.js';

/** The pad, clock, frame index and touch block, contiguous from the state buffer start. */
const STATE_BYTES = STATE.touch + TOUCH_BYTES;
/** The UI block words the overlay gate reads: uiMagic through uiOverlay. */
const UI_BYTES = UI.uiOverlay + 4 - UI.uiMagic;
const NS_PER_SECOND = 1e9;
const MIN_HZ = 10;
const MAX_HZ = 240;

/**
 * @typedef {object} PushOptions
 * @property {number} fd Console socket descriptor connected to the host.
 * @property {number} send Address of the socket send function.
 * @property {number} state Address of the launcher's mapped state buffer.
 * @property {number | null} ui Address of the app's UI block (uiMagic), or null for none.
 * @property {number | null} buffer Address of a worker-owned record buffer, needed with `ui`.
 * @property {number} counter Address of the u32 the worker counts its records in.
 * @property {number} hz Records per second.
 */

/**
 * @typedef {object} PlanAddresses
 * @property {number} sdk SDK image address.
 * @property {number} base Page-aligned address of the worker allocation.
 */

/**
 * @typedef {object} PushRow Call indices of one pass.
 * @property {number[]} copies The copies into the record buffer, none without a UI block.
 * @property {number} send The record send.
 * @property {number} bytes Bytes the send must report.
 * @property {number} count The record count add.
 * @property {number} sleep The period sleep.
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isAddress(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0;
}

/** @param {PushOptions} options */
function validate({fd, send, state, ui, buffer, counter, hz}) {
  const valid =
    Number.isInteger(fd) &&
    fd >= 0 &&
    isAddress(send) &&
    isAddress(state) &&
    (ui === null || (isAddress(ui) && isAddress(buffer))) &&
    isAddress(counter) &&
    !(counter % 4) &&
    Number.isInteger(hz) &&
    hz >= MIN_HZ &&
    hz <= MAX_HZ;
  if (!valid) throw Error('Input push needs a socket, the state block and a bounded rate');
}

/**
 * @param {number | null} ui
 * @returns {number} Bytes of one record: the state block, then the UI block if there is one.
 */
function recordBytes(ui) {
  return STATE_BYTES + (ui === null ? 0 : UI_BYTES);
}

/**
 * The repeating push frame: copy the record together, send it, count it, sleep.
 * @param {PlanAddresses & PushOptions} options
 * @returns {{program: ReturnType<typeof repeatingFrame>, row: PushRow, calls: object[],
 *   verified: Set<number>, recordBytes: number}}
 */
function cycle({sdk, base, ...options}) {
  validate(options);
  const {fd, send, state, ui, buffer, counter, hz} = options;
  const calls = [];
  const add = call => calls.push(call) - 1;
  const copy = (to, from, bytes) =>
    add({function: sdk + IPC_COPY.offset, args: [to, from, bytes, 0]});
  const bytes = recordBytes(ui);
  const copies =
    ui === null ? [] : [copy(buffer, state, STATE_BYTES), copy(buffer + STATE_BYTES, ui, UI_BYTES)];
  /** @type {PushRow} */
  const row = {
    copies,
    send: add({function: send, args: [fd, ui === null ? state : buffer, bytes, 0]}),
    bytes,
    count: add({function: sdk + SYNC.atomicAddU32.offset, args: [1, counter, 0, 0]}),
    sleep: add({
      function: sdk + SYNC.sleepThread.offset,
      args: [Math.round(NS_PER_SECOND / hz), 0, 0, 0]
    })
  };
  const verified = new Set([send]);
  const program = repeatingFrame({base, sdk, calls, code: CODE, verified});
  return {program, row, calls, verified, recordBytes: bytes};
}

/**
 * Checks a stopped push worker's last results: the pass's record went out whole.
 * @param {bigint[]} results The cycle's result words, in call order.
 * @param {PushRow} row
 */
function checkedPush(results, row) {
  if (!Array.isArray(results) || !row || results.length <= row.sleep)
    throw Error('Invalid input push results');
  const sent = results[row.send];
  if (typeof sent !== 'bigint' || Number(BigInt.asIntN(64, sent)) !== row.bytes)
    throw Error('Input push send was short or failed');
}

export {STATE_BYTES, UI_BYTES, recordBytes, cycle, checkedPush};
