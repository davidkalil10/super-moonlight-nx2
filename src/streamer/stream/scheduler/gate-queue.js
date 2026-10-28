/**
 * Runs the staggered gates of gate-on-receive off the producer's path. The producer primes and
 * sends a unit, then queues its gate; one task runs the queued gates in order, so a gate that
 * rereads a late receive no longer holds up the next unit (z37-queued-gate.md).
 *
 * The console bounds how far the producer may run ahead. It has two descriptor slots and an
 * auto-clear length gate, so a prime for N+1 that lands before the console took N's wake
 * would merge both wakes into one and park the console on N+1 for good. admit(N) therefore
 * waits until the gates' status reads saw unit N-1 received, and until fewer than `depth`
 * gates are queued or running. There is one producer: it awaits admit() before each push().
 *
 * The first gate error stops the queue: later gates never run, admit() and drain() reject with
 * it and push() throws it. push() also throws when the queue is already full, since a gate
 * pushed without admit() could merge the console's wakes. clear(), for a stop, rejects any
 * admit() still waiting and makes push() throw, so nothing is primed or queued after it.
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

  /** @param {number} sequence */
  const ready = sequence => seen >= sequence - 1 && queue.length + (active ? 1 : 0) < depth;

  const wake = () => {
    waiters = waiters.filter(waiter => {
      if (failure || stopped) waiter.reject(failure || stopped);
      else if (ready(waiter.sequence)) waiter.resolve();
      else return true;
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
     * Resolves once unit `sequence` may be primed.
     * @param {number} sequence
     * @returns {Promise<void>}
     */
    admit(sequence) {
      if (failure || stopped) return Promise.reject(failure || stopped);
      if (ready(sequence)) return Promise.resolve();
      return new Promise((resolve, reject) => waiters.push({sequence, resolve, reject}));
    },
    /**
     * Queues the gate of an admitted unit; `run` resolves once the gate is checked.
     * @param {number} sequence
     * @param {() => Promise<unknown>} run
     */
    push(sequence, run) {
      if (failure || stopped) throw failure || stopped;
      if (queue.length + (active ? 1 : 0) >= depth) throw Error('Gate queue is full');
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
      return queue.length + (active ? 1 : 0);
    }
  };
}

export {create};
