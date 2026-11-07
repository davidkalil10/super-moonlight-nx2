/** @import {LoaderRuntime} from './console-runtime.js' */

/**
 * Runs `operation` with a call_rop bound to a fresh native stack. Shipped by toString().
 * @template T
 * @param {Pick<LoaderRuntime, 'sdk' | 'allocate' | 'release' | 'call' | 'read64' | 'read32'> &
 *   {createCall: (stackTop: bigint) => LoaderRuntime['call']}} runtime
 * @param {number} bytes
 * @param {(call: LoaderRuntime['call']) => Promise<T>} operation
 */
export async function withNativeStack(runtime, bytes, operation) {
  if (!Number.isInteger(bytes) || bytes < 0x10000 || bytes > 0x800000 || bytes % 16)
    throw Error('Invalid native stack size');

  const limit = 1n << 39n;
  const size = bytes + 0x4010;
  const allocation = runtime.allocate(size);
  if (typeof allocation !== 'bigint' || allocation < 0x1000n || allocation + BigInt(size) > limit)
    throw Error('Invalid native stack allocation');

  let workspace = 0n;
  try {
    workspace = runtime.allocate(0x100);
    if (typeof workspace !== 'bigint' || workspace < 0x1000n || workspace + 0x100n > limit) {
      workspace = 0n;
      throw Error('Invalid stack query allocation');
    }
    const query = runtime.sdk + 0x168b0cn;
    if (runtime.read32(query) !== 0xf81f0fe1n || runtime.read32(query + 4n) !== 0xd40000c1n)
      throw Error('QueryMemory signature mismatch');

    const end = allocation + BigInt(size);
    let cursor = allocation;
    for (let count = 0; cursor < end; count++) {
      if (count >= 16) throw Error('Native stack crosses too many mappings');
      const result = runtime.call(query, workspace, workspace + 0x40n, cursor) & 0xffffffffn;
      if (result !== 0n) throw Error('Native stack memory query failed');
      const base = runtime.read64(workspace);
      const next = base + runtime.read64(workspace + 8n);
      const permissions = Number(runtime.read32(workspace + 24n));
      if (base > cursor || next <= cursor || (permissions & 3) !== 3)
        throw Error('Native stack is not readable and writable');
      cursor = next;
    }

    const address = (allocation + BigInt(bytes) + 15n) & -16n;
    const call = runtime.createCall(address);
    return await operation(call);
  } finally {
    if (workspace) runtime.release(workspace);
    runtime.release(allocation);
  }
}
