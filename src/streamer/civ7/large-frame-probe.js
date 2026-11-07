// Probe only, not used by streams: AV1 frames above 1080p through the decoder-service path of
// av1-decoder.js, timed by console call plans and checked by an on-console SHA-256.
// FEASIBILITY.md in the run directory has the reasons and commands.
import crypto from 'node:crypto';
import probeTable from '../console-api/codec-probe-functions.json' with {type: 'json'};
import surfaceTable from '../console-api/codec-sample-functions.json' with {type: 'json'};
import streamTable from '../console-api/av1-stream-functions.json' with {type: 'json'};
import sdkTable from '../console-api/large-frame-probe-functions.json' with {type: 'json'};
import {emptyRequest, exchange, memoryRequest, openRequest, serviceReply} from './codec-probe.js';
import {inputRequest} from './codec-sample.js';
import {planReply} from './call-plan.js';
import {replyInteger} from './protocol.js';
import {sdkResolver} from './sdk.js';
import {create as createMovieDecoder} from './decoder.js';

/** @import {Civ7Rpc, NativeValue} from './transport.js' */
/** @import {ProbeFunctions} from './codec-probe.js' */
/** @import {PlanReply} from './call-plan.js' */

const MIB = 1024 * 1024;
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;
const BRIDGE_LIMIT = 128 * MIB;
const INPUT_BYTES = MIB;
const SURFACES = 2;
const REGISTRATION = 3;
const FRAME_PERIOD_US = 16667n;
const POLLS_PER_PLAN = 400;
const POLL_PLANS = 25;
const CONTROL = {request: 0, tls: 0x80, reply: 0x100, transferHandle: 0x190, block: 0x198, mime: 0x200,
  sizing: 0x300, descriptor: 0x380, surfaces: 0x400, hash: 0x800};
const CONTROL_BYTES = 0x1000;

/** @param {NativeValue} value */
const hex = value => '0x' + BigInt(value).toString(16);

/** @param {unknown} error */
const message = error => error instanceof Error ? error.message : String(error);

/**
 * Even sizes up to 3840x2160, the largest level of the AV1 workspace table.
 * @param {number} width @param {number} height
 */
export function largeDimensions(width, height) {
  const integers = Number.isInteger(width) && Number.isInteger(height);
  const bounded = width >= 2 && width <= MAX_WIDTH && height >= 2 && height <= MAX_HEIGHT;
  const even = width % 2 === 0 && height % 2 === 0;
  if (!integers || !bounded || !even) throw Error('Expected an even size up to 3840x2160');
  return {width, height};
}

/**
 * The mode-1 workspace the native backend sizes for a frame, as av1-decoder.js workspaceBytes
 * without its 1080p bound: the first table level whose limits hold the frame.
 * @param {number} width @param {number} height
 */
export function workspaceLevel(width, height) {
  largeDimensions(width, height);
  const table = Buffer.from(streamTable.workspace.table.hex, 'hex');
  const limits = Buffer.from(streamTable.workspace.limits.hex, 'hex');
  const count = streamTable.workspace.levels;

  for (let index = 0; index < count; index++) {
    const level = table.readUInt32LE(index * 4) - 1;
    const limitWidth = limits.readUInt32LE(level * 4);
    const limitHeight = limits.readUInt32LE(36 + level * 4);
    if (width > limitWidth || height > limitHeight) continue;

    const bytes = Number(table.readBigUInt64LE(0x28 + index * 8)) * MIB;
    return {index, limit: {width: limitWidth, height: limitHeight}, bytes};
  }
  throw Error('No AV1 workspace level holds ' + width + 'x' + height);
}

/** @param {number} bytes */
export function memoryBlockBytes(bytes) {
  const unit = sdkTable.memoryBlockUnit;
  return Math.ceil(bytes / unit) * unit;
}

/**
 * The 117 open request at a size codec-probe.js refuses: its layout, with the u16 size fields.
 * @param {number} mimeAddress @param {number} width @param {number} height
 */
export function largeOpenRequest(mimeAddress, width, height) {
  largeDimensions(width, height);
  const bytes = openRequest('av1', mimeAddress, {width: 128, height: 96});
  bytes.writeUInt16LE(width, 20);
  bytes.writeUInt16LE(height, 24);
  return bytes;
}

/** codec-sample.js surfaceDescriptor without its 1080p bound. @param {number} width @param {number} height */
export function largeSurfaceDescriptor(width, height) {
  largeDimensions(width, height);
  const descriptor = Buffer.alloc(64);
  descriptor.writeBigUInt64LE(0x100000000n);
  descriptor.writeBigUInt64LE(BigInt((height - 1) * 65536 + width - 1), 8);
  return descriptor;
}

/** A 125 input request for one temporal unit with its own pts in µs. @param {number} pointer @param {number} length @param {bigint} pts */
export function unitRequest(pointer, length, pts) {
  const bytes = inputRequest(pointer, length);
  bytes.writeBigUInt64LE(pts, 20);
  return bytes;
}

/**
 * Verifies the nnSdk memory-block and hash functions, and that each memory-block wrapper's import
 * slot leads to the heap manager routine whose failure path returns a Result (FEASIBILITY.md).
 * @param {Pick<Civ7Rpc, 'request' | 'read'>} rpc
 * @returns {Promise<Record<string, number>>}
 */
export async function verifySdkFunctions(rpc) {
  const sdk = await rpc.request({command: 'module-probe', name: sdkTable.moduleName});
  if (sdk.hash !== sdkTable.moduleHash) throw Error('Unrecognized nnSdk build');
  const base = Number(replyInteger(sdk, 'base'));

  /** @type {Record<string, number>} */
  const functions = {};
  for (const [name, entry] of Object.entries(sdkTable.functions)) {
    functions[name] = base + entry.offset;
    await rpc.request({command: 'verify-function', address: functions[name], hex: entry.hex});
  }

  for (const [name, entry] of Object.entries(sdkTable.imports)) {
    const target = (await rpc.read(base + entry.slot, 8)).readBigUInt64LE();
    if (target !== BigInt(functions[entry.target])) throw Error('The ' + name + ' import leads elsewhere');
  }
  return functions;
}

/** @param {bigint} header @param {number} [id] */
function packet(header, id) {
  const bytes = Buffer.alloc(64);
  bytes.writeBigUInt64LE(header);
  if (id !== undefined) bytes.writeUInt32LE(id, 8);
  return bytes;
}

/** @typedef {{ready: boolean, polls: number, decodeMs?: number, sendMs?: number}} DecodeTiming */

/**
 * The console time from the end of the submit's send to the first poll that saw the fence ready.
 * @param {PlanReply['calls']} calls the plan's calls: tls, copy, send, copy, then polls
 * @returns {DecodeTiming}
 */
export function decodeTiming(calls) {
  const send = calls[2];
  const sent = send.at + send.ms;
  const polls = calls.slice(4);
  const readyAt = polls.findIndex(call => (BigInt(call.result) & 0xffffffffn) === 1n);
  if (readyAt < 0) return {ready: false, polls: polls.length, sendMs: send.ms};

  return {ready: true, polls: readyAt + 1, decodeMs: polls[readyAt].at - sent, sendMs: send.ms};
}

/**
 * @typedef {{index: number, bytes: number, sendMs?: number, decodeMs?: number,
 *   decodeBoundMs?: number, polls: number, outputMs?: number, untileMs: number, releaseMs?: number,
 *   hashMs: number, metadata: {id: number, width: number, height: number, timestampNs: string},
 *   match: boolean, hash: string}} FrameResult
 */

/**
 * @typedef {{status: string, cleanup: string, error: string, width: number, height: number,
 *   workspace: {level: number, limit: {width: number, height: number}, tableBytes: number,
 *   bytes: number, source: string, heapBefore?: string, heapAfter?: string, result?: string},
 *   surfaceBytes: number, surfaceAlignment: number, open: {stage: string, service?: string},
 *   frames: FrameResult[]}} LargeFrameReport
 */

/**
 * Opens an AV1 session at `width` x `height`, decodes `units` one at a time and checks each
 * untiled frame against `references` (NV12 frames at that size). `workspaceBytes` overrides the
 * table size; `memory` picks the bridge allocator (128 MiB cap) or nn::os memory blocks.
 * @param {Civ7Rpc} rpc
 * @param {{width: number, height: number, units: Buffer[], references: Buffer[], directory: string,
 *   workspaceBytes?: number, memory?: 'auto' | 'bridge' | 'block', openOnly?: boolean,
 *   log?: (event: object) => Promise<void>,
 *   createMovie?: (options: {rpc: Civ7Rpc, directory: string, log: (event: object) => void}) =>
 *     Promise<{close(): Promise<unknown>}>}} options
 * @returns {Promise<LargeFrameReport>}
 */
export async function probeLargeAv1(rpc, {width, height, units, references, directory, workspaceBytes,
  memory = 'auto', openOnly = false, log = async () => {}, createMovie = createMovieDecoder}) {
  largeDimensions(width, height);
  const frameBytes = width * height * 3 / 2;
  const level = workspaceLevel(width, height);
  const workspace = workspaceBytes ?? level.bytes;
  if (!Number.isSafeInteger(workspace) || workspace < MIB || workspace % 0x1000)
    throw Error('Invalid workspace size');
  if (memory === 'bridge' && workspace > BRIDGE_LIMIT) throw Error('The bridge allocates at most 128 MiB');
  if (!units.length || units.some(unit => !unit.length || unit.length > INPUT_BYTES))
    throw Error('Expected temporal units of at most 1 MiB');
  if (!openOnly && (references.length !== units.length || references.some(frame => frame.length !== frameBytes)))
    throw Error('Expected one ' + width + 'x' + height + ' NV12 reference per unit');

  const source = memory === 'block' || (memory === 'auto' && workspace > BRIDGE_LIMIT) ? 'memory-block' : 'bridge';
  const blockBytes = source === 'memory-block' ? memoryBlockBytes(workspace) : workspace;
  /** @type {LargeFrameReport} */
  const report = {status: 'running', cleanup: 'clean', error: '', width, height,
    workspace: {level: level.index, limit: level.limit, tableBytes: level.bytes, bytes: blockBytes, source},
    surfaceBytes: 0, surfaceAlignment: 0, open: {stage: 'none'}, frames: []};

  /** @type {Record<string, number>} */
  const functions = {};
  /** @type {number[]} */
  const owned = [];
  /** @type {{record: number, id: number, fence: number}[]} */
  const surfaces = [];
  /** @type {number[]} */
  const inputs = [];
  const state = {control: 0, destination: 0, workspace: 0, block: false, session: 0, transfer: 0,
    registered: false, started: false, uncertain: false};
  /** @type {{close(): Promise<unknown>} | undefined} */
  let movie;
  let manager = 0;

  /** @template T @param {string} stage @param {() => Promise<T>} operation */
  async function step(stage, operation) {
    await log({event: 'large-frame-before', stage});
    state.uncertain = true;
    const result = await operation();
    state.uncertain = false;
    await log({event: 'large-frame-after', stage});
    return result;
  }

  /** @param {number} bytes @param {number} [alignment] */
  async function allocate(bytes, alignment = 0x1000) {
    const pointer = await rpc.allocate(bytes, {align: alignment});
    owned.push(pointer);
    return pointer;
  }

  /** @param {string} name @param {NativeValue[]} args */
  async function native(name, args) {
    const {result} = await step(name, () => rpc.callAddress(functions[name], args));
    return result;
  }

  /** @param {string} stage @param {Buffer} request @param {bigint} expected @param {{handle?: number, resultOffset?: number}} [options] */
  async function service(stage, request, expected, {handle = state.session, resultOffset = 8} = {}) {
    const probeFunctions = /** @type {ProbeFunctions} */ (/** @type {unknown} */ (functions));
    const reply = await step(stage, () => exchange(rpc, probeFunctions, state.control, handle, request, 128));
    if (reply.kernel) throw Error('AV1 ' + stage + ' kernel result ' + hex(reply.kernel));
    const result = serviceReply(reply.bytes.subarray(0, 64), expected, resultOffset);
    if (result) throw Error('AV1 ' + stage + ' was refused: service ' + hex(result));
    return reply.bytes;
  }

  /** One timed console call through a call plan. @param {string} name @param {NativeValue[]} args */
  async function timed(name, args) {
    const reply = await step(name, async () => planReply(await rpc.callPlan({
      steps: [{call: hex(functions[name]), args: args.map(hex)}]})));
    if (reply.error || reply.calls.length !== 1) throw Error(name + ' plan failed: ' + (reply.error?.message ?? ''));
    return {result: BigInt(reply.calls[0].result), ms: reply.calls[0].ms};
  }

  async function verify() {
    const compat = await rpc.request({command: 'module-probe', name: 'nnCompat'});
    const known = [probeTable, surfaceTable, streamTable].every(table => table.moduleHash === compat.hash);
    if (!known) throw Error('Unrecognized nnCompat build');
    const base = Number(replyInteger(compat, 'base'));
    for (const [name, entry] of Object.entries({...probeTable.functions, ...surfaceTable.functions})) {
      functions[name] = base + entry.offset;
      await rpc.request({command: 'verify-function', address: functions[name], hex: entry.hex});
    }
    for (const entry of [...Object.values(probeTable.evidence), ...Object.values(streamTable.evidence)])
      await rpc.request({command: 'verify-function', address: base + entry.offset, hex: entry.hex});
    for (const entry of [streamTable.workspace.table, streamTable.workspace.limits]) {
      const bytes = await rpc.read(base + entry.offset, entry.hex.length / 2);
      if (bytes.toString('hex') !== entry.hex) throw Error('AV1 workspace table differs from the verified build');
    }
    functions.copy = await sdkResolver(rpc)('copy');
    Object.assign(functions, await verifySdkFunctions(rpc));
    return base;
  }

  async function allocateWorkspace() {
    if (source === 'bridge') {
      state.workspace = await allocate(blockBytes);
      return true;
    }

    report.workspace.heapBefore = hex((await rpc.callAddress(functions.heapSize, [])).result);
    const result = Number(await native('allocateBlock', [state.control + CONTROL.block, blockBytes]) & 0xffffffffn);
    report.workspace.result = hex(result);
    if (result) return false;

    state.workspace = Number((await rpc.read(state.control + CONTROL.block, 8)).readBigUInt64LE());
    state.block = true;
    report.workspace.heapAfter = hex((await rpc.callAddress(functions.heapSize, [])).result);
    return true;
  }

  /** @param {number} index */
  async function createSurface(index) {
    const record = state.control + CONTROL.surfaces + index * 64;
    const backing = await allocate(report.surfaceBytes, report.surfaceAlignment);
    await rpc.write(record, Buffer.alloc(64));
    const created = Number(await native('create', [record, backing, report.surfaceBytes,
      state.control + CONTROL.descriptor, 1]) & 0xffffffffn);
    if (created) throw Error('Cannot create an AV1 output surface: ' + hex(created));

    const id = (await rpc.read(record + 4, 4)).readUInt32LE();
    const fields = Buffer.alloc(12);
    fields.writeUInt16LE(width);
    fields.writeUInt16LE(height, 2);
    fields.writeUInt32LE(1, 4);
    fields.writeUInt32LE(3, 8);
    await rpc.write(record + 32, fields);
    surfaces.push({record, id, fence: record + 48});
  }

  async function open() {
    const base = await verify();
    movie = await createMovie({rpc, directory, log: event => { void log(event); }});
    const slot = (await rpc.read(base + probeTable.managerOffset, 8)).readBigUInt64LE();
    if (slot < 0x1000n || slot >= (1n << 39n) || slot % 4n) throw Error('The movie service is not initialized');
    manager = (await rpc.read(Number(slot), 4)).readUInt32LE();
    if (!manager) throw Error('The movie service has no session handle');

    state.control = await allocate(CONTROL_BYTES);
    await rpc.write(state.control, Buffer.alloc(CONTROL_BYTES));
    for (let index = 0; index < 2; index++) inputs.push(await allocate(INPUT_BYTES));
    if (!openOnly) state.destination = await allocate(frameBytes);

    await rpc.write(state.control + CONTROL.descriptor, largeSurfaceDescriptor(width, height));
    const sized = Number(await native('sizing', [state.control + CONTROL.sizing, state.control + CONTROL.sizing + 8,
      state.control + CONTROL.descriptor, 1]) & 0xffffffffn);
    if (sized) throw Error('Cannot size the AV1 output surfaces: ' + hex(sized));
    const sizing = await rpc.read(state.control + CONTROL.sizing, 16);
    report.surfaceBytes = Number(sizing.readBigUInt64LE());
    report.surfaceAlignment = Number(sizing.readBigUInt64LE(8));
    const sizeOk = Number.isSafeInteger(report.surfaceBytes) && report.surfaceBytes >= frameBytes &&
      report.surfaceBytes <= 64 * MIB;
    if (!sizeOk) throw Error('Unexpected AV1 surface size ' + report.surfaceBytes);
    for (let index = 0; index < SURFACES; index++) await createSurface(index);

    const acquired = await service('acquire', emptyRequest(0x11), 0x8000000100000011n, {handle: manager, resultOffset: 16});
    state.session = acquired.readUInt32LE(12);
    if (!state.session || state.session === manager) throw Error('Invalid AV1 decoder session');

    report.open.stage = 'workspace';
    if (!await allocateWorkspace()) return false;
    const transfer = Number(await native('transfer', [state.control + CONTROL.transferHandle, state.workspace,
      blockBytes]) & 0xffffffffn);
    if (transfer) throw Error('Cannot create the AV1 transfer memory: ' + hex(transfer));
    state.transfer = (await rpc.read(state.control + CONTROL.transferHandle, 4)).readUInt32LE();
    if (!state.transfer) throw Error('Missing AV1 transfer-memory handle');

    report.open.stage = 'register-memory';
    state.registered = true;
    await service('register-memory', memoryRequest(state.transfer, 'av1', REGISTRATION, blockBytes), 0x1000000d9n);
    report.open.stage = 'open';
    await rpc.write(state.control + CONTROL.mime, Buffer.from('video/av1\0'));
    await service('open', largeOpenRequest(state.control + CONTROL.mime, width, height), 0x300000075n);
    report.open.stage = 'register-surface';
    for (const surface of surfaces) {
      const reply = await service('register-surface', packet(0x400000147n, surface.id), 0x900000147n);
      await rpc.write(surface.fence, reply.subarray(12, 28));
    }
    report.open.stage = 'start';
    state.started = true;
    await service('start', packet(0x16n), 0x100000016n);
    report.open.stage = 'started';
    return true;
  }

  /** Submits a unit and polls the oldest surface's fence inside one call plan, then more polls. @param {number} index */
  async function submitAndWait(index) {
    const unit = units[index];
    const input = inputs[index % inputs.length];
    const pts = BigInt(index + 1) * FRAME_PERIOD_US;
    const surface = surfaces[0];
    const tls = hex(state.control + CONTROL.tls);
    await rpc.write(input, unit);

    const submitted = Date.now();
    const polls = Array.from({length: POLLS_PER_PLAN}, () => ({call: hex(functions.ready), args: [hex(surface.fence)]}));
    const reply = await step('submit-' + index, async () => planReply(await rpc.callPlan({steps: [
      {write: hex(state.control), hex: unitRequest(input, unit.length, pts).toString('hex')},
      {call: hex(functions.tls), args: [], store: tls},
      {check: {u64: tls}, min: 0x1000, below: hex(1n << 39n), message: 'Invalid thread-local buffer'},
      {call: hex(functions.copy), args: [{u64: tls}, hex(state.control), 64]},
      {call: hex(functions.send), args: [hex(state.session)]},
      {call: hex(functions.copy), args: [hex(state.control + CONTROL.reply), {u64: tls}, 64]},
      ...polls
    ], read: [{address: hex(state.control + CONTROL.reply), length: 64}]})));
    if (reply.error) throw Error('Submit plan failed: ' + reply.error.message);
    const kernel = Number(BigInt(reply.calls[2].result) & 0xffffffffn);
    if (kernel) throw Error('AV1 input kernel result ' + hex(kernel));
    const result = serviceReply(Buffer.from(reply.memory[0], 'hex'), 0x30000007dn);
    if (result) throw Error('AV1 input was refused: service ' + hex(result));

    const timing = decodeTiming(reply.calls);
    if (timing.ready) return {pts, surface, timing, decodeBoundMs: undefined};

    for (let plan = 0; plan < POLL_PLANS; plan++) {
      const more = await step('poll-' + index, async () => planReply(await rpc.callPlan({steps: polls})));
      const ready = more.calls.findIndex(call => (BigInt(call.result) & 0xffffffffn) === 1n);
      timing.polls += ready < 0 ? more.calls.length : ready + 1;
      if (ready >= 0) return {pts, surface, timing: {...timing, ready: true}, decodeBoundMs: Date.now() - submitted};
    }
    throw Error('AV1 frame ' + index + ' never signalled its fence');
  }

  /** @param {number} index */
  async function decodeFrame(index) {
    const {pts, surface, timing, decodeBoundMs} = await submitAndWait(index);

    const output = await service('output', packet(0xe5n), 0x11000000e5n);
    const metadata = {id: output.readUInt32LE(12), width: output.readUInt32LE(16), height: output.readUInt32LE(20),
      timestampNs: output.readBigUInt64LE(36).toString()};
    const metadataOk = metadata.id === surface.id && metadata.width === width && metadata.height === height &&
      metadata.timestampNs === (pts * 1000n).toString();
    if (!metadataOk) throw Error('Unexpected AV1 frame metadata: ' + JSON.stringify(metadata));

    const untiled = await timed('readback', [surface.record, state.destination]);
    if (untiled.result & 0xffffffffn) throw Error('AV1 untile returned ' + hex(untiled.result));
    const released = await service('release', packet(0x80000014an, surface.id), 0x90000014an);
    await rpc.write(surface.fence, released.subarray(12, 28));

    const hashed = await timed('sha256', [state.control + CONTROL.hash, 32, state.destination, frameBytes]);
    const hash = (await rpc.read(state.control + CONTROL.hash, 32)).toString('hex');
    const expected = crypto.createHash('sha256').update(references[index]).digest('hex');
    return {index, bytes: units[index].length, sendMs: timing.sendMs,
      decodeMs: timing.decodeMs, decodeBoundMs, polls: timing.polls, untileMs: untiled.ms, hashMs: hashed.ms,
      metadata, match: hash === expected, hash};
  }

  async function teardown() {
    if (state.started) {
      await service('stop', packet(0xdfn), 0x1000000dfn);
      state.started = false;
    }
    if (state.registered) {
      const probeFunctions = /** @type {ProbeFunctions} */ (/** @type {unknown} */ (functions));
      await step('unregister-memory', () => exchange(rpc, probeFunctions, state.control, state.session,
        emptyRequest(0x83), 64));
      state.registered = false;
    }
    for (const surface of [...surfaces].reverse()) await native('destroy', [surface.record]);
    surfaces.length = 0;
    for (const handle of [state.session, state.transfer]) {
      if (!handle) continue;
      const closed = Number(await native('close', [handle]) & 0xffffffffn);
      if (closed) throw Error('CloseHandle failed: ' + hex(closed));
    }
    state.session = 0;
    state.transfer = 0;
    if (state.block) {
      await native('freeBlock', [state.workspace, blockBytes]);
      state.block = false;
    }
    for (const pointer of [...owned].reverse()) await rpc.release(pointer);
    owned.length = 0;
    await movie?.close();
  }

  try {
    const opened = await open();
    if (!opened) report.status = 'workspace-unavailable';
    else if (openOnly) report.status = 'opened';
    else {
      for (let index = 0; index < units.length; index++) {
        const frame = await decodeFrame(index);
        report.frames.push(frame);
        await log({event: 'large-frame', ...frame});
      }
      report.status = report.frames.every(frame => frame.match) ? 'pixels-verified' : 'pixel-mismatch';
    }
  } catch (error) {
    report.status = 'failed';
    report.error = message(error);
    report.open.service = report.open.stage === 'started' ? undefined : report.error;
    await log({event: 'large-frame-error', stage: report.open.stage, message: report.error});
  } finally {
    try {
      if (!rpc.connected || state.uncertain) throw Error('the console lost track of a call');
      await teardown();
    } catch (error) {
      report.cleanup = 'restart-required';
      report.error ||= message(error);
      await log({event: 'large-frame-cleanup-failed', message: message(error)});
    }
  }
  return report;
}

/**
 * Allocates and frees nn::os memory blocks of each size, largest first, with no decoder: the
 * heap headroom a 272 MiB workspace needs. Stops at the first size that fits.
 * @param {Civ7Rpc} rpc
 * @param {{sizes: number[], log?: (event: object) => Promise<void>}} options
 */
export async function probeMemoryHeadroom(rpc, {sizes, log = async () => {}}) {
  const functions = await verifySdkFunctions(rpc);
  const out = await rpc.allocate(0x1000);
  const heapSize = hex((await rpc.callAddress(functions.heapSize, [])).result);
  /** @type {{bytes: number, result: string, address?: string}[]} */
  const attempts = [];
  try {
    for (const size of [...sizes].sort((a, b) => b - a)) {
      const bytes = memoryBlockBytes(size);
      await rpc.write(out, Buffer.alloc(8));
      const result = Number((await rpc.callAddress(functions.allocateBlock, [out, bytes])).result & 0xffffffffn);
      const attempt = {bytes, result: hex(result)};
      if (result) {
        attempts.push(attempt);
        await log({event: 'memory-block', ...attempt});
        continue;
      }

      const address = (await rpc.read(out, 8)).readBigUInt64LE();
      await rpc.callAddress(functions.freeBlock, [address, bytes]);
      attempts.push({...attempt, address: hex(address)});
      await log({event: 'memory-block', ...attempt, address: hex(address), freed: true});
      break;
    }
  } finally {
    await rpc.release(out);
  }
  return {heapSize, attempts};
}
