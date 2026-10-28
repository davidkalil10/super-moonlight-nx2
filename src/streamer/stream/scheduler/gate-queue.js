/**
 * Runs the gates of gate-on-receive off the producer's path, one at a time in order, and admits
 * each prime per invariant 2. The first gate error stops the queue (z37-queued-gate.md).
 */

/**
 * @param {object} [options]
 * @param {number} [options.depth] most gates queued or running at once
 * @param {number} [options.received] the last unit already known received, so the unit after
 *   it is admitted at once
 */
function create({depth = 2, received = 0} = {}) {
  /** @type {{sequence: number, run: () => Promise<unknown>}[]} */
  const queue = [];
  /** @type {{sequence: number, resolve: () => void, reject: (error: unknown) => void}[]} */
  let waiters = [];
  /** @type {Promise<void> | null} */
  let running = null;
  let active = false;
  let seen = received;
  let failure = null;
  let stopped = null;

  /** Gates queued or running. */
  const inFlight = () => queue.length + (active ? 1 : 0);

  /** @param {number} sequence */
  const ready = sequence => seen >= sequence - 1 && inFlight() < depth;

  const wake = () => {
    waiters = waiters.filter(waiter => {
      const error = failure || stopped;
      if (error) {
        waiter.reject(error);
        return false;
      }

      if (!ready(waiter.sequence)) return true;
      waiter.resolve();
      return false;
    });
  };

  async function loop() {
    while (queue.length && !failure) {
      const gate = /** @type {(typeof queue)[number]} */ (queue.shift());
      active = true;
      try {
        await gate.run();
      } catch (error) {
        failure = error;
      }
      active = false;
      wake();
    }
    running = null;
  }

  return {
    /**
     * Resolves once unit `sequence` may be primed; rejects with the first gate error or a stop.
     * @param {number} sequence
     * @returns {Promise<void>}
     */
    admit(sequence) {
      if (failure || stopped) return Promise.reject(failure || stopped);
      if (ready(sequence)) return Promise.resolve();
      return new Promise((resolve, reject) => waiters.push({sequence, resolve, reject}));
    },
    /**
     * Queues the gate of an admitted unit; `run` resolves once the gate is checked. Throws when
     * full, since a gate pushed without admit() could merge the console's wakes.
     * @param {number} sequence
     * @param {() => Promise<unknown>} run
     */
    push(sequence, run) {
      if (failure || stopped) throw failure || stopped;
      if (inFlight() >= depth) throw Error('Gate queue is full');
      queue.push({sequence, run});
      running ??= loop();
    },
    /**
     * What a gate's status read saw of the console's receive.
     * @param {number} sequence
     */
    observeReceive(sequence) {
      if (sequence <= seen) return;
      seen = sequence;
      wake();
    },
    /** Resolves once every queued gate ran, or rejects with the first gate error. */
    async drain() {
      await running;
      if (failure) throw failure;
    },
    /**
     * Drops the gates not started yet and rejects a waiting admit(), for a stop; returns the
     * dropped units. The gate already running finishes, and drain() still waits for it.
     * @returns {number[]}
     */
    clear() {
      const dropped = queue.splice(0).map(gate => gate.sequence);
      stopped = Error('Gate queue stopped');
      wake();
      return dropped;
    },
    /** Gates queued or running. */
    get depth() {
      return inFlight();
    }
  };
}

export {create};
