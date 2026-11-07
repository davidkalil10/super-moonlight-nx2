import definitions from '../console-api/nvdec-probe-functions.json' with {type: 'json'};
import {replyInteger} from './protocol.js';

/** @import {Civ7Rpc, NativeValue} from './transport.js' */

const SENTINEL = 0xffffffff;
const hex = (/** @type {number | bigint} */ value) => '0x' + BigInt(value).toString(16);

/** @param {bigint} value */
function pointer(value) {
  if (value < 0x1000n || value >= (1n << 39n) || value % 8n)
    throw Error('Invalid initialized nvdrv pointer');
  return Number(value);
}

/**
 * Opens separate host-control/NVDEC descriptors through the initialized compatibility proxy.
 * @param {Civ7Rpc} rpc
 * @param {{log?: (event: object) => Promise<void>, control?: boolean, hostControl?: boolean, engineInfo?: boolean}} [options]
 */
export async function probeNvdec(rpc, {log = async () => {}, control = true, hostControl = false, engineInfo = false} = {}) {
  const report = {status: 'running', cleanup: 'clean', error: '',
    engineInfo: /** @type {{nvError: number, reportedBytes: number, capacity: number, items: {engineId: number, instance: number, runlistId: number, reserved: number}[]} | null} */ (null),
    state: /** @type {Record<string, string | boolean>} */ ({}),
    devices: /** @type {{path: string, open: {result: number, nvError: number, fd: number},
      query?: {result: number, nvError: number, syncpoint: number},
      close?: {result: number, nvError: number}}[]} */ ([])};
  let scratch = 0;
  let engineBuffer = 0;
  let base = 0;
  let proxy = 0;
  let owned = /** @type {number | null} */ (null);
  let uncertain = false;
  let closeAttempted = false;
  let current = /** @type {(typeof report.devices)[number] | undefined} */ (undefined);
  const functions = /** @type {Record<string, number>} */ ({});

  /** @param {number} offset */
  const read64 = async offset => (await rpc.read(base + offset, 8)).readBigUInt64LE();
  /** @param {string} name @param {NativeValue[]} args */
  async function call(name, args) {
    await log({event: 'native-before', stage: name, path: current?.path, function: hex(functions[name]), args: args.map(value => hex(BigInt(value)))});
    uncertain = true;
    const {result} = await rpc.callAddress(functions[name], args);
    const outputs = await rpc.read(scratch + 48, 8);
    const nvError = outputs.readUInt32LE(4);
    const result32 = Number(result & 0xffffffffn);
    if (nvError === SENTINEL && result32 === 0) throw Error('nvdrv did not write its error output');
    if (name === 'open') {
      const fd = outputs.readUInt32LE();
      if (current) current.open = {result: result32, nvError, fd};
      if (result32 === 0 && nvError === 0) {
        if (fd === SENTINEL) throw Error('nvdrv returned an invalid descriptor on success');
        owned = fd;
        closeAttempted = false;
      }
    }
    if (name === 'close') {
      if (current) current.close = {result: result32, nvError};
      if (result32 === 0 && nvError === 0) owned = null;
    }
    uncertain = false;
    await log({event: 'native-after', stage: name, result: result32, nvError});
    return {result: result32, nvError};
  }
  async function resetError() {
    const bytes = Buffer.alloc(4, 0xff);
    await rpc.write(scratch + 52, bytes);
  }
  async function closeOwned() {
    if (owned === null) return;
    closeAttempted = true;
    await resetError();
    const closed = await call('close', [proxy, owned, scratch + 52]);
    if (closed.result !== 0 || closed.nvError !== 0)
      throw Error('nvdrv close failed; restart the console app');
  }
  async function queryEngines() {
    if (owned === null) throw Error('GPU engine query requires an owned descriptor');
    const fd = owned;
    const primary = scratch + 256;
    let capacity = 0x400;
    for (let attempt = 0; attempt < 2; attempt++) {
      engineBuffer = await rpc.allocate(capacity, {align: 16});
      const initial = Buffer.alloc(capacity);
      for (let offset = 0; offset < capacity; offset += 16) initial.writeInt32LE(-1, offset + 8);
      await rpc.write(engineBuffer, initial);
      const header = Buffer.alloc(16);
      header.writeUInt32LE(capacity);
      await rpc.write(primary, header);
      await log({event: 'engine-query-before', function: hex(functions.ioctl3), fd, capacity,
        primary: hex(primary), output: hex(engineBuffer), returnLayer: 'NvError', transportErrorAborts: true});
      uncertain = true;
      const {result} = await rpc.callAddress(functions.ioctl3, [fd, 0xc010471f, primary, 16, engineBuffer, capacity]);
      const nvError = Number(result & 0xffffffffn);
      const reportedBytes = (await rpc.read(primary, 16)).readUInt32LE();
      uncertain = false;
      report.engineInfo = {nvError, reportedBytes, capacity, items: []};
      await log({event: 'engine-query-after', nvError, reportedBytes, capacity});
      if (nvError) { report.status = 'engine-query-rejected'; return; }
      if (reportedBytes % 16 || reportedBytes > 0x4000) throw Error('Unexpected GPU engine information size');
      if (reportedBytes > capacity) {
        if (attempt) throw Error('GPU engine information grew twice');
        await rpc.release(engineBuffer);
        engineBuffer = 0;
        capacity = reportedBytes;
        continue;
      }
      const bytes = await rpc.read(engineBuffer, reportedBytes);
      for (let offset = 0; offset < bytes.length; offset += 16) report.engineInfo.items.push({
        engineId: bytes.readUInt32LE(offset), instance: bytes.readUInt32LE(offset + 4),
        runlistId: bytes.readInt32LE(offset + 8), reserved: bytes.readUInt32LE(offset + 12)
      });
      await log({event: 'engine-items', ...report.engineInfo});
      report.status = 'engine-info-read';
      return;
    }
  }

  try {
    const module = await rpc.request({command: 'module-probe', name: definitions.moduleName});
    base = pointer(replyInteger(module, 'base'));
    if (module.hash !== definitions.moduleHash)
      throw Error('Unsupported module for NVDEC probe');
    for (const [name, entry] of Object.entries(definitions.functions)) functions[name] = base + entry.offset;
    await log({event: 'module-verified', name: definitions.moduleName, base: hex(base), hash: module.hash});
    await rpc.request({command: 'verify-functions', base: hex(base),
      functions: Object.entries({...definitions.functions, ...definitions.evidence})
        .map(([name, entry]) => ({name, ...entry}))});
    await log({event: 'functions-verified'});
    const proxyAddress = await read64(definitions.globals.proxy);
    const hipcHandler = await read64(definitions.globals.hipcErrorHandler);
    report.state = {proxy: hex(proxyAddress), hipcErrorHandler: hex(hipcHandler)};
    for (const [name, offset] of Object.entries(definitions.state)) {
      report.state[name] = hex((await rpc.read(base + offset, 4)).readUInt32LE());
    }
    await log({event: 'initialized-state', ...report.state});
    if (!proxyAddress) {
      report.status = 'driver-not-initialized';
      return report;
    }
    proxy = pointer(proxyAddress);
    const object = await rpc.read(proxy, 16);
    const vtable = object.readBigUInt64LE();
    if (vtable !== BigInt(base + definitions.vtable)) throw Error('Unexpected nvdrv proxy vtable');
    const slots = await rpc.read(Number(vtable) + 0x20, 24);
    for (const [index, name] of ['open', 'ioctl', 'close'].entries())
      if (slots.readBigUInt64LE(index * 8) !== BigInt(functions[name]))
        throw Error('Unexpected nvdrv proxy function');
    const queryReady = Boolean(object[9] & 1);
    report.state.pointerBufferCached = queryReady;
    if (hipcHandler) {
      report.status = 'client-error-handler-unreviewed';
      return report;
    }
    scratch = await rpc.allocate(0x1000);

    const paths = engineInfo ? ['/dev/nvhost-ctrl-gpu'] : hostControl ? ['/dev/nvhost-ctrl']
      : control ? ['/dev/nvhost-ctrl', '/dev/nvhost-nvdec'] : ['/dev/nvhost-nvdec'];
    for (const path of paths) {
      const buffer = Buffer.alloc(256);
      const name = Buffer.from(path + '\0');
      buffer.writeBigUInt64LE(BigInt(scratch + 128));
      buffer.writeBigUInt64LE(BigInt(name.length - 1), 8);
      buffer.writeBigUInt64LE(BigInt(scratch + 64), 16);
      buffer.writeBigUInt64LE(8n, 24);
      buffer.writeBigUInt64LE(BigInt(scratch + 64), 32);
      buffer.writeBigUInt64LE(8n, 40);
      buffer.writeUInt32LE(SENTINEL, 48);
      buffer.writeUInt32LE(SENTINEL, 52);
      name.copy(buffer, 128);
      await rpc.write(scratch, buffer);
      current = {path, open: {result: SENTINEL, nvError: SENTINEL, fd: SENTINEL}};
      report.devices.push(current);
      const opened = await call('open', [proxy, scratch, scratch + 48, scratch + 52]);
      await log({event: 'device-open', path, ...current.open});
      if (opened.result !== 0 || opened.nvError !== 0) {
        report.status = path === '/dev/nvhost-nvdec' ? 'nvdec-open-rejected' : 'control-open-rejected';
        break;
      }
      const fd = current.open.fd;
      if (engineInfo) {
        if (!queryReady) { report.status = 'engine-query-cache-not-ready'; }
        else await queryEngines();
      }
      if (path === '/dev/nvhost-nvdec' && queryReady) {
        await resetError();
        const queried = await call('ioctl', [proxy, fd, 0xc0080002, scratch + 16, scratch + 32, scratch + 52]);
        const syncpoint = (await rpc.read(scratch + 64, 8)).readUInt32LE(4);
        current.query = {...queried, syncpoint};
        await log({event: 'syncpoint-query', ...current.query});
      }
      await closeOwned();
    }
    if (report.status === 'running') report.status = hostControl ? 'control-open-accepted' : 'nvdec-channel-accessible';
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.status = 'failed';
    await log({event: 'probe-error', message: report.error});
  } finally {
    if (owned !== null && rpc.connected && !uncertain && !closeAttempted) {
      try { await closeOwned(); }
      catch (error) { report.error ||= String(error); }
    }
    if (!rpc.connected || owned !== null || uncertain) {
      report.cleanup = 'restart-required';
    } else if (scratch) {
      try {
        if (engineBuffer) await rpc.release(engineBuffer);
        await rpc.release(scratch);
      }
      catch (error) {
        report.cleanup = 'restart-required';
        report.error ||= String(error);
      }
    }
    await log({event: 'probe-cleanup', cleanup: report.cleanup, descriptor: owned});
  }
  return report;
}
