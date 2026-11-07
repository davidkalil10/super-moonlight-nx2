/** @import {ChildProcess} from 'node:child_process' */

/**
 * Runs every cleanup step even when an earlier one fails; returns the failures.
 * @param {[string, () => unknown][]} steps
 * @param {(event: {event: string, resource: string, message: string}) => void} [log]
 */
export async function cleanup(steps, log = event => {}) {
  /** @type {unknown[]} */
  const errors = [];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (error) {
      errors.push(error);
      log({event: 'cleanup-failed', resource: name, message: error instanceof Error ? error.message : String(error)});
    }
  }
  return errors;
}

/** @param {ChildProcess} child */
export async function stopChild(child, graceMs = 2000) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('close', () => { clearTimeout(timer); resolve(undefined); });
    child.kill('SIGINT');
  });
}
