import definitions from '../console-api/capability-check-functions.json' with {type: 'json'};
import {replyInteger} from './protocol.js';

/** @import {Civ7Rpc} from './transport.js' */

const hex = (/** @type {number | bigint} */ value) => '0x' + BigInt(value).toString(16);

/**
 * Reads current-process limits and initialized client state without service acquisition.
 * @param {Civ7Rpc} rpc
 * @param {{log?: (event: object) => Promise<void>}} [options]
 */
export async function checkCapabilities(rpc, {log = async () => {}} = {}) {
  const report = {status: 'running', cleanup: 'clean', error: '', session: rpc.a.session,
    runtime: /** @type {object | null} */ (null),
    media: /** @type {object | null} */ (null),
    modules: /** @type {Record<string, object>} */ ({}),
    process: /** @type {{id: number, name: string, result: number, value: string | null, decimal: string | null}[]} */ ([]),
    state: /** @type {Record<string, {type: string, value: string, meaning: string}>} */ ({}),
    proxies: /** @type {Record<string, object>} */ ({}),
    memory: /** @type {object | null} */ (null),
    graphics: /** @type {object | null} */ (null),
    unavailable: definitions.unavailable};
  let scratch = 0;
  let uncertain = false;
  const bases = {sdk: rpc.a.sdk, compat: 0};
  try {
    for (const [name, expected, key] of [['nnSdk', definitions.sdkHash, 'sdk'], ['nnCompat', definitions.compatHash, 'compat']]) {
      const module = await rpc.request({command: 'module-probe', name});
      report.modules[name] = module;
      if (module.hash !== expected) throw Error('Unsupported module for capability check: ' + name);
      bases[/** @type {'sdk' | 'compat'} */ (key)] = Number(replyInteger(module, 'base'));
    }
    if (bases.sdk !== rpc.a.sdk) throw Error('SDK base disagrees with bridge hello');
    await rpc.request({command: 'verify-functions', base: hex(bases.sdk), functions: [{name: 'getInfo', ...definitions.getInfo}]});
    await log({event: 'modules-verified', modules: report.modules});
    report.runtime = await rpc.request({command: 'runtime-capabilities'});
    await log({event: 'runtime-capabilities', ...report.runtime});
    report.media = await rpc.request({command: 'media-capabilities'});
    await log({event: 'media-capabilities', ...report.media});
    report.memory = await rpc.request({command: 'memory-map'});
    await log({event: 'memory-map', ...report.memory});
    report.graphics = await rpc.request({command: 'graphics-status', tableHash: definitions.compatHash, blobHash: '00000000'});
    await log({event: 'graphics-status', ...report.graphics});
    for (const field of definitions.state) {
      const base = bases[/** @type {'sdk' | 'compat'} */ (field.module)];
      const size = field.type.startsWith('u8') ? 1 : field.type.startsWith('u64') ? 8 : 4;
      const bytes = await rpc.read(base + Number(BigInt(field.offset)), size);
      const value = size === 8 ? bytes.readBigUInt64LE() : BigInt(size === 1 ? bytes[0] : bytes.readUInt32LE());
      report.state[field.name] = {type: field.type, value: hex(value), meaning: field.meaning};
    }
    await log({event: 'initialized-state', fields: report.state});
    for (const name of ['nvDrvPrimaryProxy', 'nvDrvDuplicateProxy']) {
      const pointer = BigInt(report.state[name].value);
      if (!pointer) continue;
      if (pointer < 0x1000n || pointer >= (1n << 39n) || pointer % 8n) throw Error('Invalid driver proxy');
      const bytes = await rpc.read(Number(pointer), 16);
      const vtable = bytes.readBigUInt64LE();
      report.proxies[name] = {address: hex(pointer), vtable: hex(vtable),
        expectedVtable: vtable === BigInt(bases.compat + 0x3ca1b60),
        pointerBufferCached: Boolean(bytes[9] & 1), pointerBufferBytes: bytes.readUInt16LE(10),
        borrowedSession: hex(bytes.readUInt32LE(12))};
    }
    await log({event: 'driver-proxies', ...report.proxies});
    scratch = await rpc.allocate(16, {align: 16});
    for (const query of definitions.queries) {
      await rpc.write(scratch, Buffer.alloc(8));
      await log({event: 'getinfo-before', ...query});
      uncertain = true;
      const {result} = await rpc.callAddress(bases.sdk + definitions.getInfo.offset,
        [scratch, query.id, query.handle, query.subtype]);
      const status = Number(result & 0xffffffffn);
      const value = status === 0 ? (await rpc.read(scratch, 8)).readBigUInt64LE() : null;
      uncertain = false;
      const entry = {id: query.id, name: query.name, result: status,
        value: value === null ? null : hex(value), decimal: value === null ? null : value.toString()};
      report.process.push(entry);
      await log({event: 'getinfo-after', ...entry});
    }
    report.status = 'capabilities-read';
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.status = 'failed';
    await log({event: 'check-error', message: report.error});
  } finally {
    if (!rpc.connected || uncertain) report.cleanup = 'restart-required';
    else if (scratch) {
      try { await rpc.release(scratch); }
      catch (error) { report.cleanup = 'restart-required'; report.error ||= String(error); }
    }
    await log({event: 'check-cleanup', cleanup: report.cleanup});
  }
  return report;
}
