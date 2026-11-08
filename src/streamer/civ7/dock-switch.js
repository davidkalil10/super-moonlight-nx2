/** @typedef {{docked: boolean, mode: string, reason?: string}} OperationMode */

/**
 * A debounced dock state: a poll that reads a new mode reads it again `confirmMs` later and
 * switches only when both agree. Unknown or failed reads keep the last known mode; polls never
 * overlap.
 * @param {{initial: boolean, read: () => Promise<OperationMode>,
 *   changed?: (docked: boolean) => void, log?: (event: object) => void, confirmMs?: number,
 *   wait?: (ms: number) => Promise<unknown>}} options
 */
export function createDockMonitor({initial, read, changed = () => {}, log = () => {}, confirmMs = 100,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  let docked = initial;
  let closed = false;
  /** @type {Promise<void> | null} */
  let pending = null;
  /** @type {Set<(docked: boolean) => void>} */
  const listeners = new Set();

  /** @returns {Promise<boolean | null>} the mode one read reports, or null when it is unknown */
  async function sample() {
    try {
      const mode = await read();
      return mode.mode === 'handheld' || mode.mode === 'console' ? mode.docked : null;
    } catch (error) {
      if (!closed) log({event: 'dock-mode-read-failed', message: error instanceof Error ? error.message : String(error)});
      return null;
    }
  }

  async function check() {
    const seen = await sample();
    if (closed || seen === null || seen === docked) return;

    await wait(confirmMs);
    if (closed) return;
    const confirmed = await sample();
    if (closed || confirmed !== seen) return;

    docked = seen;
    log({event: 'dock-mode', docked});
    changed(docked);
    for (const listener of listeners) listener(docked);
  }

  return {
    current: () => docked,
    poll() {
      if (closed) return Promise.resolve();
      return pending ??= check().finally(() => { pending = null; });
    },
    /** @param {(docked: boolean) => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async close() {
      closed = true;
      listeners.clear();
      await pending;
    }
  };
}

/**
 * One game across dock transitions. A change stops and cleans the current stream before the
 * newest mode starts; user cancellation always wins. Saved settings stay outside this loop.
 * @template Result
 * @param {{monitor: ReturnType<typeof createDockMonitor>, signal: AbortSignal,
 *   run: (docked: boolean, signal: AbortSignal) => Promise<Result>, log?: (event: object) => void}} options
 * @returns {Promise<Result>}
 */
export async function runDockSession({monitor, signal, run, log = () => {}}) {
  let generation = 0;
  /** @type {AbortController | null} */
  let active = null;
  const unsubscribe = monitor.subscribe(docked => {
    generation++;
    log({event: 'stream-dock-switch', docked});
    active?.abort(Error('Dock mode changed'));
  });
  const stop = () => active?.abort(signal.reason);
  signal.addEventListener('abort', stop);
  try {
    for (;;) {
      signal.throwIfAborted();
      const started = generation;
      active = new AbortController();
      try {
        const result = await run(monitor.current(), active.signal);
        signal.throwIfAborted();
        if (generation === started) return result;
      } catch (error) {
        signal.throwIfAborted();
        if (generation === started) throw error;
      }
    }
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', stop);
  }
}
