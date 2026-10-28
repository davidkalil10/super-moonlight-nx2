/**
 * Native call plan for pushed input: a repeating console worker sends the pad, touch and UI
 * words on native TCP once per period (team note `z38-input-push.md`; frame rules in CLAUDE.md).
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
  const fdOk = Number.isInteger(fd) && fd >= 0;
  const addressesOk = isAddress(send) && isAddress(state);
  const uiOk = ui === null || (isAddress(ui) && isAddress(buffer));
  const counterOk = isAddress(counter) && !(counter % 4);
  const hzOk = Number.isInteger(hz) && hz >= MIN_HZ && hz <= MAX_HZ;

  const valid = fdOk && addressesOk && uiOk && counterOk && hzOk;
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
  const add = call => {
    calls.push(call);
    return calls.length - 1;
  };
  const copy = (to, from, bytes) =>
    add({function: sdk + IPC_COPY.offset, args: [to, from, bytes, 0]});
  const bytes = recordBytes(ui);

  // Call order is the frame order: copies, send, count, sleep.
  const copies = [];
  if (ui !== null) {
    copies.push(copy(buffer, state, STATE_BYTES), copy(buffer + STATE_BYTES, ui, UI_BYTES));
  }

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
  const whole = typeof sent === 'bigint' && Number(BigInt.asIntN(64, sent)) === row.bytes;
  if (!whole) throw Error('Input push send was short or failed');
}

export {STATE_BYTES, UI_BYTES, recordBytes, cycle, checkedPush};
