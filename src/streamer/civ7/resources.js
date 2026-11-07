/* Console resource ledger: allocations and native objects journalled before each call, reaped on
 * the next attach. Reconciliation with the console's own map
 * keeps a dead process's entries from ever reaching a native call. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {replyInteger} from './protocol.js';

/** @import {Civ7Rpc, NativeValue} from './transport.js' */

/** @typedef {{key: string, size: number, alignment: number, reapFailures?: number}} PendingAllocation */

/**
 * A cleanup call replayed on the next attach; `terminal` drops every call on the same object.
 * @typedef {{key: string, address: string, args: string[], hex: string, expectedResult: number | null,
 *   terminal?: boolean, object?: string}} CleanupCall
 */

/**
 * A constructor whose result decides whether its destructors (`cleanupKeys`) stay journalled.
 * @typedef {{key: string, address: string, args: string[], hex: string, expectedResult: number | null,
 *   cleanupKeys: string[], creation: true}} Creation
 */

/**
 * @typedef {{address: string, bytes: number, releaseKey: string, calls: CleanupCall[],
 *   creations: Creation[], reapFailures?: number}} AllocationEntry
 */

/**
 * @typedef {{version: 1, session: string, allocations: AllocationEntry[],
 *   pendingAllocations: PendingAllocation[]}} LedgerState
 */

/** @typedef {(event: {event: string, [field: string]: unknown}) => void} LedgerLog */

/** Attaches an entry may fail to reap before it is abandoned (left allocated, never retried). */
export const MAX_REAP_ATTEMPTS = 3;

/** @param {NativeValue} value */
const address = value => '0x' + BigInt(value).toString(16);
const NOT_OWNED = /not owned by this bridge/;

/** @param {unknown} error */
const asError = error => error instanceof Error ? error : Error(String(error));

/**
 * Splits saved allocations by whether the console process still holds them at the same size.
 * @param {AllocationEntry[]} allocations
 * @param {Map<string, number>} held
 */
function partitionHeld(allocations, held) {
  const kept = [];
  const dropped = [];
  for (const entry of allocations) {
    if (held.get(entry.address) === entry.bytes) kept.push(entry);
    else dropped.push(entry);
  }

  return {kept, dropped};
}

/**
 * @param {Civ7Rpc} rpc
 * @param {string} file
 * @param {LedgerLog} [log]
 */
export async function createResourceLedger(rpc, file, log = () => {}) {
  if (!rpc.processSession) throw Error('The console payload has no process session identity');
  /** @type {LedgerState} */
  let state = {version: 1, session: rpc.a.session, allocations: [], pendingAllocations: []};
  try {
    /** @type {{version?: unknown, session?: unknown, allocations?: unknown}} */
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.allocations)) throw Error('Invalid console resource ledger');
    if (saved.session === state.session) {
      state = /** @type {LedgerState} */ (saved);
      state.pendingAllocations ??= [];
      for (const entry of state.allocations) entry.creations ??= [];
    }
    else if (saved.allocations.length)
      log({event: 'resources-discarded', reason: 'other-process', allocations: saved.allocations.length});
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    if (!missing) throw error;
  }

  let writes = Promise.resolve();
  async function save() {
    const text = JSON.stringify(state, null, 2) + '\n';
    writes = writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
      const temporary = file + '.tmp';
      await fs.writeFile(temporary, text, {mode: 0o600});
      await fs.rename(temporary, file);
    });
    return writes;
  }

  const held = rpc.consoleAllocations;
  if (held) {
    const {kept, dropped} = partitionHeld(state.allocations, held);
    state.allocations = kept;
    if (dropped.length) {
      log({event: 'resources-discarded', reason: 'not-held', allocations: dropped.length});
      await save();
    }
  }

  /** @param {NativeValue} pointer */
  const allocation = pointer => state.allocations.find(entry => entry.address === address(pointer));
  /**
   * @param {CleanupCall | Creation} operation
   * @param {NativeValue} pointer
   * @param {NativeValue[]} args
   */
  const sameCall = (operation, pointer, args) => operation.address === address(pointer) &&
    JSON.stringify(operation.args) === JSON.stringify(args.map(value => BigInt(value).toString()));

  /** @typedef {(error: Error, entry?: AllocationEntry) => void} ReapFailure */

  /**
   * Frees every journalled allocation; one the console says it does not own is dropped.
   * @param {ReapFailure} failed
   */
  async function releaseAll(failed) {
    for (const entry of [...state.allocations].reverse()) {
      try {
        await rpc.request({command: 'release', address: entry.address, cleanupKey: entry.releaseKey});
        await ledger.released(entry.address);
      } catch (caught) {
        const error = asError(caught);
        if (!NOT_OWNED.test(error.message)) {
          failed(error, entry);
          continue;
        }

        log({event: 'resources-discarded', reason: 'not-owned', allocations: 1, address: entry.address});
        await ledger.released(entry.address);
      }
    }
  }

  /**
   * Counts a failed attempt on every leftover and abandons the ones out of attempts.
   * @param {Error[]} errors
   */
  async function finishReap(errors) {
    const retained = state.pendingAllocations.length + state.allocations.length;
    if (!retained) {
      log({event: 'resources-reaped'});
      return {retained: 0, errors};
    }

    const counted = rpc.connected !== false;
    /** @param {PendingAllocation | AllocationEntry} entry */
    const attempt = entry => {
      entry.reapFailures = (entry.reapFailures ?? 0) + (counted ? 1 : 0);
      return entry.reapFailures < MAX_REAP_ATTEMPTS;
    };
    const before = retained;
    state.pendingAllocations = state.pendingAllocations.filter(attempt);
    state.allocations = state.allocations.filter(attempt);
    await save();

    const kept = state.pendingAllocations.length + state.allocations.length;
    if (kept < before) log({event: 'resources-abandoned', allocations: before - kept});
    if (kept) log({event: 'resources-retained', allocations: kept, message: errors[0]?.message});

    return {retained: kept, errors};
  }

  const ledger = {
    /**
     * @param {number} size
     * @param {number} alignment
     */
    async prepareAllocation(size, alignment) {
      const pending = {key: crypto.randomUUID(), size, alignment};
      state.pendingAllocations.push(pending);
      await save();
      return pending.key;
    },
    /**
     * @param {string} key
     * @param {NativeValue} pointer
     * @param {number} bytes
     */
    async allocated(key, pointer, bytes) {
      state.pendingAllocations = state.pendingAllocations.filter(entry => entry.key !== key);
      state.allocations.push({address: address(pointer), bytes, releaseKey: crypto.randomUUID(), calls: [], creations: []});
      await save();
    },
    /**
     * @param {NativeValue} pointer
     * @param {number} bytes
     */
    async allocate(pointer, bytes) {
      state.allocations.push({address: address(pointer), bytes, releaseKey: crypto.randomUUID(), calls: [], creations: []});
      await save();
    },
    /**
     * @param {NativeValue} pointer
     * @param {NativeValue} fn
     * @param {NativeValue[]} args
     * @param {number | null} [expectedResult]
     */
    async register(pointer, fn, args, expectedResult = null) {
      const entry = allocation(pointer);
      if (!entry) return;
      const signature = rpc.verifiedFunctions.get(address(fn));
      if (!signature) throw Error('Cannot retain an unverified cleanup function');
      if (entry.calls.some(operation => sameCall(operation, fn, args))) return;
      entry.calls.unshift({key: crypto.randomUUID(), address: address(fn),
        args: args.map(value => BigInt(value).toString()), hex: signature, expectedResult});
      await save();
    },
    /**
     * @param {NativeValue} pointer
     * @param {NativeValue} fn
     * @param {NativeValue[]} args
     * @param {{fn: NativeValue, args: NativeValue[], expectedResult?: number, terminal?: boolean}[]} destructors
     * @param {number | null} [expectedResult]
     */
    async prepare(pointer, fn, args, destructors, expectedResult = null) {
      const entry = allocation(pointer);
      if (!entry) return;
      const hex = rpc.verifiedFunctions.get(address(fn));
      if (!hex) throw Error('Cannot retain an unverified constructor');
      /** @type {string[]} */
      const cleanupKeys = [];
      for (const destructor of destructors) {
        const signature = rpc.verifiedFunctions.get(address(destructor.fn));
        if (!signature) throw Error('Cannot retain an unverified destructor');
        const key = crypto.randomUUID();
        cleanupKeys.push(key);
        entry.calls.unshift({key, address: address(destructor.fn), hex: signature,
          args: destructor.args.map(value => BigInt(value).toString()),
          expectedResult: destructor.expectedResult ?? null,
          terminal: Boolean(destructor.terminal), object: address(destructor.args[0])});
      }
      entry.creations.push({key: crypto.randomUUID(), address: address(fn), hex,
        args: args.map(value => BigInt(value).toString()), expectedResult, cleanupKeys, creation: true});
      await save();
    },
    /**
     * @param {NativeValue} fn
     * @param {NativeValue[]} args
     * @returns {CleanupCall | Creation | null}
     */
    findCall(fn, args) {
      for (const entry of state.allocations) {
        const found = [...entry.creations, ...entry.calls].find(operation => sameCall(operation, fn, args));
        if (found) return found;
      }
      return null;
    },
    /**
     * @param {string} key
     * @param {bigint} [result]
     */
    async complete(key, result = 0n) {
      for (const entry of state.allocations) {
        const creation = entry.creations.find(operation => operation.key === key);
        if (creation) {
          if (creation.expectedResult !== null && Number(result & 0xffffffffn) !== creation.expectedResult)
            entry.calls = entry.calls.filter(operation => !creation.cleanupKeys.includes(operation.key));
          entry.creations = entry.creations.filter(operation => operation.key !== key);
        }
        const completed = entry.calls.find(operation => operation.key === key);
        if (completed?.terminal)
          entry.calls = entry.calls.filter(operation => operation.object !== completed.object);
        entry.calls = entry.calls.filter(operation => operation.key !== key);
      }
      await save();
    },
    /** @param {NativeValue} pointer */
    async clearCalls(pointer) {
      const entry = allocation(pointer);
      if (entry) entry.calls = [];
      await save();
    },
    /** @param {NativeValue} pointer */
    releaseKey(pointer) {
      const entry = allocation(pointer);
      if (entry?.calls.length || entry?.creations.length) throw Error('Console allocation still owns native resources');
      return entry?.releaseKey;
    },
    /** @param {NativeValue} pointer */
    async released(pointer) {
      state.allocations = state.allocations.filter(entry => entry.address !== address(pointer));
      await save();
    },
    /**
     * Replays what the last attach left. Never throws for leftovers: an entry that fails stays
     * retained (its memory may back live native objects) and is retried on later attaches, at
     * most MAX_REAP_ATTEMPTS times, so new allocations are never blocked.
     * @returns {Promise<{retained: number, errors: Error[]}>}
     */
    async reap() {
      /** @type {Error[]} */
      const errors = [];
      /** @type {ReapFailure} */
      const failed = (error, entry = undefined) => {
        errors.push(error);
        log({event: 'resource-reap-failed', ...(entry ? {address: entry.address} : {}), message: error.message});
      };

      for (const pending of [...state.pendingAllocations]) {
        try {
          const reply = await rpc.request({command: 'allocate', size: pending.size,
            alignment: pending.alignment, cleanupKey: pending.key});
          await ledger.allocated(pending.key, replyInteger(reply, 'address'), pending.size);
        } catch (error) {
          failed(asError(error));
        }
      }

      for (const entry of [...state.allocations].reverse()) {
        for (const creation of [...entry.creations]) {
          try {
            await rpc.request({command: 'verify-function', address: creation.address, hex: creation.hex});
            const reply = await rpc.request({command: 'call', address: creation.address,
              args: creation.args, cleanupKey: creation.key});
            await ledger.complete(creation.key, replyInteger(reply, 'result'));
          } catch (error) {
            failed(asError(error), entry);
            break;
          }
        }
        if (entry.creations.length) continue;

        for (const operation of [...entry.calls]) {
          try {
            await rpc.request({command: 'verify-function', address: operation.address, hex: operation.hex});
            const reply = await rpc.request({command: 'call', address: operation.address,
              args: operation.args, cleanupKey: operation.key});
            const result = replyInteger(reply, 'result');
            if (operation.expectedResult !== null && Number(result & 0xffffffffn) !== operation.expectedResult)
              throw Error('Console cleanup returned ' + reply.result);
            await ledger.complete(operation.key);
          } catch (error) {
            failed(asError(error), entry);
          }
        }
      }

      /** @param {AllocationEntry} entry */
      const ownsNative = entry => entry.creations.length || entry.calls.length;
      const unresolved = state.pendingAllocations.length || state.allocations.some(ownsNative);
      if (!unresolved) await releaseAll(failed);

      return finishReap(errors);
    },
    snapshot: () => structuredClone(state)
  };
  return ledger;
}
