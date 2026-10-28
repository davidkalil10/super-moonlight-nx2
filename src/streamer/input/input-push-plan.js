/**
 * Native call plan for pushed input: a repeating console worker sends the pad, touch and UI
 * words on native TCP once per period (team note `z38-input-push.md`; frame rules in CLAUDE.md).
 */
import {repeatingFrame} from '../../../../hbl-platform/sdk/native/jobs.js';
import {CODE, IPC_COPY} from '../../../../hbl-platform/sdk/native/thread.js';
import SYNC from '../../../../hbl-platform/sdk/native/os-sync-functions.json' with {type: 'json'};
import HID from '../../../../hbl-platform/sdk/native/hid-functions.json' with {type: 'json'};
import {STATE} from '../../../../hbl-platform/sdk/host/layout.js';
import {UI} from '../shared/ring.js';
import {TOUCH_BYTES} from './touch.js';

/** The pad, clock, frame index and touch block, contiguous from the state buffer start. */
const STATE_BYTES = STATE.touch + TOUCH_BYTES;
/** The UI block words the overlay gate reads: uiMagic through uiOverlay. */
const UI_BYTES = UI.uiOverlay + 4 - UI.uiMagic;
/** The record count a pad-reading record ends with: the u32 counter word before this pass. */
const SEQUENCE_BYTES = 4;
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
 * @property {number | null} [padId] Address of the u32 npad id with which each pass reads the
 *   handheld pad itself (`--input-push-pad`), or null to send the launcher's copy.
 */

/**
 * @typedef {object} PlanAddresses
 * @property {number} sdk SDK image address.
 * @property {number} base Page-aligned address of the worker allocation.
 */

/**
 * @typedef {object} PushRow Call indices of one pass.
 * @property {number[]} copies The copies into the record buffer, none without a UI block.
 * @property {number} [pad] The handheld pad read over the record's pad bytes.
 * @property {number} [sequence] The copy of the record count to the record's end.
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
function validate({fd, send, state, ui, buffer, counter, hz, padId = null}) {
  const fdOk = Number.isInteger(fd) && fd >= 0;
  const addressesOk = isAddress(send) && isAddress(state);
  const uiOk = ui === null || (isAddress(ui) && isAddress(buffer));
  const counterOk = isAddress(counter) && !(counter % 4);
  const hzOk = Number.isInteger(hz) && hz >= MIN_HZ && hz <= MAX_HZ;
  const padOk = padId === null || (isAddress(padId) && !(padId % 4) && isAddress(buffer));

  const valid = fdOk && addressesOk && uiOk && counterOk && hzOk && padOk;
  if (!valid) throw Error('Input push needs a socket, the state block and a bounded rate');
}

/**
 * @param {number | null} ui
 * @param {boolean} [pad] Whether each pass reads the pad and appends the record count.
 * @returns {number} Bytes of one record: the state block, the UI block if there is one, then
 *   the record count with `pad`.
 */
function recordBytes(ui, pad = false) {
  return STATE_BYTES + (ui === null ? 0 : UI_BYTES) + (pad ? SEQUENCE_BYTES : 0);
}

/**
 * The repeating push frame: copy the record together, send it, count it, sleep. With `padId`
 * the pass also reads the handheld pad over the copied one and appends the record count.
 * @param {PlanAddresses & PushOptions} options
 * @returns {{program: ReturnType<typeof repeatingFrame>, row: PushRow, calls: object[],
 *   verified: Set<number>, recordBytes: number}}
 */
function cycle({sdk, base, ...options}) {
  validate(options);
  const {fd, send, state, ui, buffer, counter, hz, padId = null} = options;
  const pad = padId !== null;

  const calls = [];
  const add = call => {
    calls.push(call);
    return calls.length - 1;
  };
  const copy = (to, from, bytes) =>
    add({function: sdk + IPC_COPY.offset, args: [to, from, bytes, 0]});
  const bytes = recordBytes(ui, pad);

  // Call order is the frame order: copies, pad read, record count, send, count, sleep.
  const copies = [];
  if (ui !== null) {
    copies.push(copy(buffer, state, STATE_BYTES), copy(buffer + STATE_BYTES, ui, UI_BYTES));
  } else if (pad) {
    copies.push(copy(buffer, state, STATE_BYTES));
  }

  const padRow = pad
    ? {
        pad: add({function: sdk + HID.padHandheld.offset, args: [buffer, padId, 0, 0]}),
        sequence: copy(buffer + bytes - SEQUENCE_BYTES, counter, SEQUENCE_BYTES)
      }
    : {};
  const record = ui === null && !pad ? state : buffer;

  /** @type {PushRow} */
  const row = {
    copies,
    ...padRow,
    send: add({function: send, args: [fd, record, bytes, 0]}),
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

export {STATE_BYTES, UI_BYTES, SEQUENCE_BYTES, MAX_HZ, recordBytes, cycle, checkedPush};
