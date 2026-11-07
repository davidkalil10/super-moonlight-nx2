/** @typedef {{docked: boolean, mode: string, reason?: string}} OperationMode */

/**
 * A debounced dock state. Unknown reads keep the last known mode; polls never overlap.
 * @param {{initial: boolean, read: () => Promise<OperationMode>,
 *   changed?: (docked: boolean) => void, log?: (event: object) => void}} options
 */
export function createDockMonitor({initial, read, changed = () => {}, log = () => {}}) {
  let docked = initial;
  let candidate = initial;
  let samples = 0;
  let closed = false;
  /** @type {Promise<void> | null} */
  let pending = null;
  /** @type {Set<(docked: boolean) => void>} */
  const listeners = new Set();

  async function check() {
    try {
      const mode = await read();
      if (closed) return;
      if (mode.mode !== 'handheld' && mode.mode !== 'console') {
        samples = 0;
        return;
      }
      if (mode.docked === docked) {
        samples = 0;
        return;
      }
      samples = mode.docked === candidate ? samples + 1 : 1;
      candidate = mode.docked;
      if (samples < 2) return;

      docked = candidate;
      samples = 0;
      log({event: 'dock-mode', docked});
      changed(docked);
      for (const listener of listeners) listener(docked);
    } catch (error) {
      samples = 0;
      if (!closed) log({event: 'dock-mode-read-failed', message: error instanceof Error ? error.message : String(error)});
    }
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
