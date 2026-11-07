import definitions from '../console-api/nvdrv-service-functions.json' with {type: 'json'};
import {replyInteger} from './protocol.js';

/** @import {Civ7Rpc, NativeValue} from './transport.js' */

const PAGE = 0x1000;
const TIMEOUT = 0xea01;
const hex = (/** @type {number | bigint} */ value) => '0x' + BigInt(value).toString(16);

export function initializeSmRequest() {
  const packet = Buffer.alloc(PAGE);
  packet.writeBigUInt64LE(0x8000000000000010n);
  packet.writeUInt32LE(1, 8);
  return packet;
}

export function getDriverServiceRequest() {
  const packet = Buffer.alloc(PAGE);
  packet.writeBigUInt64LE(0x200000011n);
  packet.write('host1x', 8, 'ascii');
  return packet;
}

/** @param {Buffer} packet @param {number} command */
export function parseSmReply(packet, command) {
  if (packet.length < 64) throw Error('Truncated SM response');
  if (packet.readBigUInt64LE() === 0n) {
    const kernelResult = packet.readUInt32LE(8);
    if (!kernelResult) throw Error('Empty asynchronous response');
    return {kernelResult, result: null, handles: /** @type {number[]} */ ([])};
  }
  const header = packet.readUInt32LE();
  const flags = packet.readUInt32LE(4);
  if ((header & 0xffff) !== command) throw Error('Unexpected SM response command');
  if (header >>> 16 || (flags & 0x7ffffc00)) throw Error('Unexpected SM response descriptors');
  let offset = 8;
  const handles = [];
  if (flags & 0x80000000) {
    const special = packet.readUInt32LE(offset);
    if (special !== 0 && special !== 0x20) throw Error('Unexpected SM handle descriptors');
    offset += 4;
    if (special === 0x20) {
      const handle = packet.readUInt32LE(offset);
      if (handle && handle !== 0xffffffff) handles.push(handle);
      offset += 4;
    }
  }
  if ((flags & 0x3ff) !== 1) throw Error('Unexpected SM raw response size');
  return {kernelResult: 0, result: packet.readUInt32LE(offset), handles};
}

/**
 * Requests Host1x without driver initialization or decode work.
 * @param {Civ7Rpc} rpc
 * @param {{log?: (event: object) => Promise<void>, timeoutMs?: number, existingSession?: boolean}} [options]
 */
export async function probeDriverService(rpc, {log = async () => {}, timeoutMs = 2000, existingSession = false} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw Error('Invalid asynchronous IPC deadline');
  const report = {status: 'running', cleanup: 'clean', error: '', service: 'host1x',
    manager: existingSession ? 'borrowed' : 'private',
    state: /** @type {{references?: number, handle?: string}} */ ({}),
    phases: /** @type {{stage: string, late: boolean, kernelResult: number, result: number | null, handles: number[]}[]} */ ([])};
  const owned = {manager: 0, service: 0, event: 0};
  const closeAttempted = new Set();
  let ipc = 0;
  let metadata = 0;
  let pending = false;
  let unparsed = false;
  let uncertain = false;
  let invalidReply = false;
  let stage = '';
  let managerHandle = 0;
  const functions = Object.fromEntries(Object.entries(definitions.functions)
    .map(([name, entry]) => [name, rpc.a.sdk + entry.offset]));

  /** @param {string} name @param {NativeValue[]} args @param {(result: number) => Promise<void>} [adopt] */
  async function call(name, args, adopt = async () => {}) {
    await log({event: 'native-before', stage, name, function: hex(functions[name]), args: args.map(value => hex(BigInt(value)))});
    uncertain = true;
    const {result} = await rpc.callAddress(functions[name], args);
    const value = Number(result & 0xffffffffn);
    await adopt(value);
    uncertain = false;
    await log({event: 'native-after', stage, name, result: value});
    return value;
  }
  /** @param {number} offset */
  const read32 = async offset => (await rpc.read(metadata + offset, 4)).readUInt32LE();
  /** @param {'manager' | 'service' | 'event'} kind */
  async function close(kind) {
    if (!owned[kind]) return;
    closeAttempted.add(kind);
    const result = await call('close', [owned[kind]], async value => {
      if (!value) owned[kind] = 0;
    });
    if (result) throw Error('Failed to close owned ' + kind + ': ' + hex(result));
  }
  /** @param {number} duration */
  async function poll(duration) {
    const deadline = Date.now() + duration;
    for (let count = 0; count < 200; count++) {
      const result = await call('wait', [metadata + 8, metadata + 4, 1, 0], async value => {
        if (!value) {
          pending = false;
          if (await read32(8) !== 0) throw Error('Unexpected asynchronous event index');
        }
      });
      if (!result) return true;
      if ((result & 0x3fffff) !== TIMEOUT) throw Error('Asynchronous event poll failed: ' + hex(result));
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
  }
  /** @param {boolean} late */
  async function receive(late) {
    if (pending) throw Error('Cannot access a pending IPC page');
    const bytes = await rpc.read(ipc, 128);
    let reply;
    try {
      reply = parseSmReply(bytes, stage === 'initialize' ? 0x10 : 0x11);
      if (stage === 'initialize' && reply.handles.length) throw Error('SM initialize returned an unexpected handle');
    } catch (error) {
      invalidReply = true;
      throw error;
    }
    if (reply.handles.length) owned.service = reply.handles[0];
    unparsed = false;
    report.phases.push({stage, late, ...reply});
    await log({event: 'async-response', stage, late, hex: bytes.toString('hex'), ...reply});
    await close('event');
    return reply;
  }
  /** @param {string} name @param {Buffer} packet */
  async function exchange(name, packet) {
    stage = name;
    await rpc.write(ipc, packet);
    await rpc.write(metadata + 4, Buffer.alloc(8));
    const result = await call('sendAsync', [metadata + 4, ipc, PAGE, managerHandle], async value => {
      if (!value) {
        owned.event = await read32(4);
        if (!owned.event || owned.event === 0xffffffff) throw Error('Missing asynchronous completion event');
        closeAttempted.delete('event');
        pending = true;
        unparsed = true;
      }
    });
    if (result) {
      report.status = 'async-send-rejected';
      throw Error('SendAsyncRequest rejected: ' + hex(result));
    }
    if (!await poll(timeoutMs)) {
      report.status = 'response-deadline-exceeded';
      throw Error('Asynchronous ' + name + ' response did not complete before the deadline');
    }
    return receive(false);
  }

  try {
    const module = await rpc.request({command: 'module-probe', name: 'nnSdk'});
    if (Number(replyInteger(module, 'base')) !== rpc.a.sdk || module.hash !== definitions.moduleHash)
      throw Error('Unsupported SDK for asynchronous service probe');
    await rpc.request({command: 'verify-functions', base: hex(rpc.a.sdk),
      functions: Object.entries({...definitions.functions, ...definitions.evidence}).map(([name, entry]) => ({name, ...entry}))});
    await log({event: 'functions-verified', hash: module.hash});
    if (existingSession) {
      const state = await rpc.read(rpc.a.sdk + definitions.smState, 8);
      const references = state.readUInt32LE();
      managerHandle = state.readUInt32LE(4);
      report.state = {references, handle: hex(managerHandle)};
      await log({event: 'borrowed-sm-state', ...report.state});
      if (!references || !managerHandle || managerHandle === 0xffffffff) {
        report.status = 'no-cached-sm-session';
        return report;
      }
    }
    metadata = await rpc.allocate(PAGE, {align: PAGE});
    ipc = await rpc.allocate(PAGE, {align: PAGE});
    if (ipc % PAGE || metadata % PAGE || ipc === metadata) {
      uncertain = true;
      throw Error('IPC and metadata require separate aligned pages');
    }
    await rpc.write(metadata, Buffer.alloc(PAGE));
    let initialized = /** @type {{kernelResult: number, result: number | null}} */ ({kernelResult: 0, result: 0});
    if (!existingSession) {
      await rpc.write(metadata + 128, Buffer.from('sm:\0'));
      stage = 'connect-sm-port';
      const connected = await call('connect', [metadata, metadata + 128], async value => {
        if (!value) {
          owned.manager = await read32(0);
          managerHandle = owned.manager;
          if (!owned.manager || owned.manager === 0xffffffff) throw Error('Missing private SM session');
        }
      });
      if (connected) {
        report.status = 'sm-port-rejected';
        throw Error('ConnectToNamedPort rejected: ' + hex(connected));
      }
      initialized = await exchange('initialize', initializeSmRequest());
    }
    if (initialized.kernelResult || initialized.result !== 0) {
      report.status = 'sm-initialize-rejected';
    } else {
      const reply = await exchange('get-service', getDriverServiceRequest());
      report.status = reply.kernelResult ? 'async-kernel-error' : reply.result !== 0
        ? 'service-request-rejected' : owned.service ? 'driver-service-accessible' : 'missing-service-handle';
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    if (report.status === 'running') report.status = 'failed';
    await log({event: 'probe-error', message: report.error});
  } finally {
    if (rpc.connected && !uncertain) {
      try {
        if (pending) {
          await close('manager');
          if (await poll(1000)) await receive(true);
        }
        if (!pending && !invalidReply) {
          if (unparsed) await receive(true);
          for (const kind of /** @type {const} */ (['event', 'service', 'manager']))
            if (!closeAttempted.has(kind)) await close(kind);
        }
      } catch (error) { report.error ||= String(error); }
    }
    if (!rpc.connected || uncertain || pending || unparsed || invalidReply || Object.values(owned).some(Boolean)) {
      report.cleanup = 'restart-required';
    } else {
      try {
        if (ipc) await rpc.release(ipc);
        if (metadata) await rpc.release(metadata);
      } catch (error) { report.cleanup = 'restart-required'; report.error ||= String(error); }
    }
    await log({event: 'probe-cleanup', cleanup: report.cleanup, pending, owned, ipc: hex(ipc), metadata: hex(metadata)});
  }
  return report;
}

/**
 * Acquires a documented S2 driver service. A deferred SM reply can block the native thread.
 * @param {Civ7Rpc} rpc
 * @param {{log?: (event: object) => Promise<void>, service?: string}} [options]
 */
export async function probeRegisteredService(rpc, {log = async () => {}, service = 'host1x'} = {}) {
  if (!['host1x', 'nvdrv:s', 'nvdrv:t'].includes(service)) throw Error('Expected a documented driver service');
  const report = {status: 'running', cleanup: 'clean', error: '', service,
    result: -1, handle: 0, closed: false, manager: 'borrowed'};
  let scratch = 0;
  let uncertain = false;
  let owned = 0;
  let closeAttempted = false;
  try {
    const module = await rpc.request({command: 'module-probe', name: 'nnSdk'});
    if (Number(replyInteger(module, 'base')) !== rpc.a.sdk || module.hash !== definitions.moduleHash)
      throw Error('Unsupported SDK for driver access probe');
    await rpc.request({command: 'verify-functions', base: hex(rpc.a.sdk), functions: [
      {name: 'getService', ...definitions.evidence.getService},
      {name: 'close', ...definitions.functions.close}
    ]});
    const state = await rpc.read(rpc.a.sdk + definitions.smState, 8);
    if (!state.readUInt32LE() || !state.readUInt32LE(4) || state.readUInt32LE(4) === 0xffffffff)
      throw Error('No initialized SM session');
    await log({event: 'borrowed-sm-state', references: state.readUInt32LE(), handle: hex(state.readUInt32LE(4))});
    scratch = await rpc.allocate(PAGE, {align: PAGE});
    const bytes = Buffer.alloc(128);
    bytes.write(service + '\0', 64, 'ascii');
    await rpc.write(scratch, bytes);
    await log({event: 'service-acquire-before', name: service, synchronous: true});
    uncertain = true;
    const reply = await rpc.callAddress(rpc.a.sdk + definitions.evidence.getService.offset, [scratch, scratch + 64, Buffer.byteLength(service)]);
    report.result = Number(reply.result & 0xffffffffn);
    if (!report.result) {
      owned = (await rpc.read(scratch, 4)).readUInt32LE();
      if (!owned || owned === 0xffffffff) throw Error('SM success did not return a valid driver handle');
      report.handle = owned;
    }
    uncertain = false;
    report.status = report.result ? 'service-request-rejected' : 'driver-service-accessible';
    await log({event: 'service-acquire-after', result: report.result, handle: report.handle});
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.status = 'failed';
    await log({event: 'probe-error', message: report.error});
  } finally {
    if (rpc.connected && !uncertain && owned && !closeAttempted) {
      try {
        closeAttempted = true;
        await log({event: 'service-close-before', handle: owned});
        uncertain = true;
        const reply = await rpc.callAddress(rpc.a.sdk + definitions.functions.close.offset, [owned]);
        if (Number(reply.result & 0xffffffffn)) throw Error('Driver service handle close failed');
        owned = 0;
        report.closed = true;
        uncertain = false;
        await log({event: 'service-close-after'});
      } catch (error) { report.error ||= String(error); }
    }
    if (!rpc.connected || uncertain || owned) report.cleanup = 'restart-required';
    else if (scratch) {
      try { await rpc.release(scratch); }
      catch (error) { report.cleanup = 'restart-required'; report.error ||= String(error); }
    }
    await log({event: 'probe-cleanup', cleanup: report.cleanup, owned});
  }
  return report;
}
