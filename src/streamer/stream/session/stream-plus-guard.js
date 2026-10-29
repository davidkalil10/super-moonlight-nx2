/**
 * Arms the + guard for one stream and disarms it at the end. A guard failure never fails the
 * stream: it runs unguarded and the summary's `plusGuard` says why.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as plusGuard from '../../../../../hbl-platform/sdk/host/plus-guard.js';

const STATE = 'plus-guard.json';

/**
 * @typedef {{armed: boolean | 'inherited' | 'adopted', restored: boolean | null,
 *   reason?: string, outcome?: string}} PlusGuardReport
 */
/** @typedef {{report: PlusGuardReport, disarm(): Promise<void>}} StreamGuard */

/** @param {string} file */
function readState(file) {
  try {
    const {program, saved} = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {program, saved: BigInt(saved)};
  } catch {
    return null;
  }
}

/**
 * The run directory keeps the saved pointer, so a stream that died armed is restored by the
 * next one, which finds the context at 0 under the same program.
 * @param {any} rpc The watched session rpc; a lost bridge skips the disarm.
 * @param {string} directory
 * @param {(event: object) => void} log
 * @param {{guard?: Pick<typeof plusGuard, 'arm' | 'disarm'>, lost?: () => boolean}} [options]
 *   `lost` reports a bridge loss the stream saw on its own rpc.
 * @returns {Promise<StreamGuard>}
 */
async function armPlusGuard(rpc, directory, log, {guard = plusGuard, lost = () => false} = {}) {
  /** @type {PlusGuardReport} */
  const report = {armed: false, restored: null};
  const state = path.join(directory, STATE);
  const note = line => log({event: 'plus-guard', line});
  let saved = false;
  const save = held => {
    if (held.saved === null) return;
    saved = true;
    const record = {program: held.program, saved: '0x' + held.saved.toString(16)};
    fs.writeFileSync(state, JSON.stringify(record) + '\n', {mode: 0o600});
  };
  let held = null;

  try {
    held = await guard.arm(rpc, {log: note, save});
    report.armed = held.saved === null ? 'inherited' : true;
  } catch (error) {
    report.reason = error.reason ?? 'error';
    // Dropped only when the guard says the zero was undone; a raw error (the bridge went
    // mid-arm) may have left it landed, so the next stream adopts the pointer.
    if (saved && error.undone === true) fs.rmSync(state, {force: true});
    log({event: 'plus-guard', armed: false, reason: report.reason, error: error.message});
    return {report, disarm: async () => {}};
  }

  const left = held.saved === null && readState(state);
  if (left && left.program === held.program) {
    held = left;
    report.armed = 'adopted';
  }
  log({event: 'plus-guard', armed: report.armed});

  async function disarm() {
    if (held.saved === null) return;
    if (rpc.bridgeLost || lost()) {
      report.restored = false;
      report.reason = 'bridge-lost';
      log({event: 'plus-guard', restored: false, reason: report.reason});
      return;
    }

    try {
      // An ended program or a fresh exec context needs no restore, so it is not a warning.
      report.outcome = await guard.disarm(rpc, held, {log: note});
      report.restored = report.outcome.startsWith('restored') ? true : null;
      fs.rmSync(state, {force: true});
    } catch (error) {
      report.restored = false;
      report.reason = 'restore-failed';
      log({event: 'plus-guard', restored: false, reason: report.reason, error: error.message});
    }
  }

  return {report, disarm};
}

export {armPlusGuard, STATE};
