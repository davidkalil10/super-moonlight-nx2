/* Console graphics ledger: bring-up objects in creation order with
 * the call that destroys each, kept in window.__moonlightState across payload sends so a matching
 * attach reuses them. Shipped with toString(); everything it uses arrives through `native`. */

/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */

/**
 * @typedef {object} GraphicsDestroy
 * @property {string} address Verified function address, hex.
 * @property {string} hex Its first bytes, checked again before the call.
 * @property {string[]} args Hex arguments, the object's handle already substituted.
 * @property {'zero' | null} expect `zero` when the call returns a result that must be 0.
 *
 * @typedef {object} GraphicsObject
 * @property {string} kind
 * @property {string} name
 * @property {StageName} stage
 * @property {string} handle Hex.
 * @property {GraphicsDestroy | null} destroy Null when its parent frees it.
 *
 * @typedef {'none' | 'building' | 'ready' | 'reaping'} StageState
 * @typedef {'display' | 'app'} StageName
 *
 * @typedef {object} GraphicsRecord
 * @property {number} version
 * @property {string} tableHash compat-functions.json module hash the handles were made with.
 * @property {string | null} blobHash Asset blob the app stage was built from.
 * @property {GraphicsObject[]} objects Creation order; display objects always come first.
 * @property {Record<StageName, {state: StageState, result: unknown}>} stages
 * @property {{kind: string, name: string, handle: string, message: string} | null} failure
 */

/**
 * `graphics-begin`, `graphics-record`, `graphics-commit`, `graphics-status` and `graphics-reap`.
 * The display stage (vi display and layer, instance, surface, device, swapchain) is retained by
 * a reap unless `destroyDisplay` is set: destroying and recreating it in one process is unproven
 * and HBLauncher's prototype disconnected in vkDestroySwapchainKHR.
 * @param {Pick<ConsoleNative, 'address' | 'argument' | 'checkMemory' | 'readMemory' | 'fromHex' |
 *   'verified' | 'call'> & {state: {graphics?: GraphicsRecord | null}}} native
 * @param {ConsoleRequest} request
 */
export function graphicsLedger(native, request) {
  const {address, argument, checkMemory, readMemory, fromHex, verified, call, state} = native;
  const VERSION = 1;
  /** @type {unknown[]} */
  const STAGES = ['display', 'app'];
  const MAX_OBJECTS = 256;
  const MAX_RECORD_BATCH = 64;
  const MAX_RESULT_CHARS = 64 * 1024;
  const MAX_SIGNATURE_BYTES = 256;
  const HANDLE = '$handle';
  /** @param {bigint} value */
  const text = value => '0x' + value.toString(16);

  /**
   * @param {unknown} value
   * @param {string} what
   */
  function hash(value, what) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8,64}$/.test(value)) throw Error('Invalid ' + what + ' hash');
    return value;
  }

  /**
   * @param {unknown} value
   * @param {string} what
   */
  function label(value, what) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(value))
      throw Error('Invalid graphics object ' + what);
    return value;
  }

  /**
   * @param {unknown} value
   * @returns {StageName}
   */
  function stageName(value) {
    if (!STAGES.includes(value)) throw Error('Invalid graphics stage');
    return /** @type {StageName} */ (value);
  }

  /**
   * @param {bigint} pointer
   * @param {unknown} hex
   */
  function signatureMatches(pointer, hex) {
    const expected = fromHex(hex);
    const sizeOk = expected.length >= 4 && expected.length <= MAX_SIGNATURE_BYTES;
    if (pointer % 4n || !sizeOk || expected.length % 4) throw Error('Invalid destroy signature');

    checkMemory(pointer, expected.length, 5);
    const actual = readMemory(pointer, expected.length);
    return actual.every((value, index) => value === expected[index]);
  }

  /**
   * @param {unknown} described
   * @param {bigint} handle
   * @returns {GraphicsDestroy | null}
   */
  function destroyCall(described, handle) {
    if (described === null || described === undefined) return null;
    if (typeof described !== 'object') throw Error('Invalid destroy call');

    const value = /** @type {ConsoleRequest} */ (described);
    const pointer = address(value.address);
    if (!verified.has(text(pointer))) throw Error('Destroy function was not verified');
    if (!signatureMatches(pointer, value.hex)) throw Error('Destroy signature mismatch at ' + text(pointer));
    if (!Array.isArray(value.args) || value.args.length > 6) throw Error('Invalid destroy arguments');
    const expect = value.expect;
    if (expect !== undefined && expect !== null && expect !== 'zero') throw Error('Invalid destroy expectation');

    const args = value.args.map(item => item === HANDLE ? text(handle) : text(argument(item)));
    return {address: text(pointer), hex: String(value.hex).toLowerCase(), args,
      expect: expect === 'zero' ? 'zero' : null};
  }

  /**
   * @param {unknown} described
   * @param {StageName} stage
   * @returns {GraphicsObject}
   */
  function graphicsObject(described, stage) {
    if (!described || typeof described !== 'object') throw Error('Invalid graphics object');
    const entry = /** @type {ConsoleRequest} */ (described);
    const handle = argument(entry.handle);
    if (handle === 0n) throw Error('Graphics object has no handle');

    return {kind: label(entry.kind, 'kind'), name: label(entry.name, 'name'), stage,
      handle: text(handle), destroy: destroyCall(entry.destroy, handle)};
  }

  /** @param {StageName} stage */
  function building(stage) {
    const record = state.graphics;
    if (!record || record.stages[stage].state !== 'building') throw Error('The ' + stage + ' stage is not being built');
    return record;
  }

  function summary() {
    const record = state.graphics;
    if (!record) return {exists: false};

    /** @param {StageName} stage */
    const count = stage => record.objects.filter(entry => entry.stage === stage).length;
    return {exists: true, tableHash: record.tableHash, blobHash: record.blobHash,
      stages: {display: record.stages.display.state, app: record.stages.app.state},
      objects: {display: count('display'), app: count('app')}, failure: record.failure};
  }

  function begin() {
    const stage = stageName(request.stage);
    const tableHash = hash(request.tableHash, 'table');
    const record = state.graphics;

    if (stage === 'display') {
      if (record) throw Error('A graphics record exists; reap it first');
      state.graphics = {version: VERSION, tableHash, blobHash: null, objects: [], failure: null,
        stages: {display: {state: 'building', result: null}, app: {state: 'none', result: null}}};
      return summary();
    }

    const blobHash = hash(request.blobHash, 'blob');
    if (record?.stages.display.state !== 'ready') throw Error('The display stage is not ready');
    if (record.tableHash !== tableHash) throw Error('The graphics record belongs to another function table');
    if (record.stages.app.state !== 'none') throw Error('The app stage exists; reap it first');

    record.blobHash = blobHash;
    record.stages.app = {state: 'building', result: null};
    return summary();
  }

  /** Validates the whole batch before appending any of it. */
  function recordObjects() {
    const stage = stageName(request.stage);
    const record = building(stage);
    const entries = request.objects;
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_RECORD_BATCH)
      throw Error('Invalid graphics objects');
    if (record.objects.length + entries.length > MAX_OBJECTS) throw Error('Graphics record is full');

    const objects = entries.map(entry => graphicsObject(entry, stage));
    const keys = new Set(record.objects.map(entry => entry.kind + '@' + entry.handle));
    for (const entry of objects) {
      const key = entry.kind + '@' + entry.handle;
      if (keys.has(key)) throw Error('Graphics object recorded twice: ' + entry.kind + ' ' + entry.handle);
      keys.add(key);
    }

    record.objects.push(...objects);
    return summary();
  }

  function commit() {
    const stage = stageName(request.stage);
    const record = building(stage);
    const result = request.result === undefined ? null : request.result;
    if (JSON.stringify(result).length > MAX_RESULT_CHARS) throw Error('Graphics result is too large');

    record.stages[stage] = {state: 'ready', result};
    return summary();
  }

  /**
   * `reuse` is `all` (display and app handles), `display` (rebuild the app stage on the retained
   * display after reaping it) or `none`. `reapDisplay` asks for the opt-in display teardown.
   */
  function status() {
    const tableHash = hash(request.tableHash, 'table');
    const blobHash = hash(request.blobHash, 'blob');
    const record = state.graphics;
    if (!record) return {...summary(), reuse: 'none', reapApp: false, reapDisplay: false};

    const tableOk = record.tableHash === tableHash;
    const displayOk = tableOk && record.stages.display.state === 'ready';
    const appOk = displayOk && record.stages.app.state === 'ready' && record.blobHash === blobHash;
    const appLeft = record.stages.app.state !== 'none';

    let reuse = 'none';
    if (displayOk) reuse = 'display';
    if (appOk) reuse = 'all';

    const objects = record.objects.map(entry => ({kind: entry.kind, name: entry.name, stage: entry.stage,
      handle: entry.handle}));
    return {...summary(), reuse, reapApp: appLeft && !appOk, reapDisplay: !displayOk,
      display: displayOk ? record.stages.display.result : null,
      app: appOk ? record.stages.app.result : null, list: objects};
  }

  /**
   * @param {GraphicsObject} entry
   * @returns {string | null} Why the destroy failed, or null.
   */
  function destroy(entry) {
    if (!entry.destroy) return null;

    try {
      const pointer = address(entry.destroy.address);
      if (!signatureMatches(pointer, entry.destroy.hex)) return 'Destroy signature mismatch at ' + text(pointer);
      const result = BigInt.asUintN(64, call(pointer, ...entry.destroy.args.map(argument)));
      if (entry.destroy.expect === 'zero' && result !== 0n) return entry.kind + ' destroy returned ' + text(result);
      return null;
    } catch (error) {
      return String(error && /** @type {{message?: unknown}} */ (error).message || error);
    }
  }

  /** Newest first; stops at the first failure, which stays recorded with everything older. */
  function reap() {
    const record = state.graphics;
    if (!record) return {...summary(), destroyed: [], retained: 0};
    const destroyDisplay = request.destroyDisplay === true;

    /** @type {{kind: string, name: string, handle: string}[]} */
    const destroyed = [];
    /** @type {GraphicsRecord['failure']} */
    let failure = null;
    while (record.objects.length) {
      const entry = record.objects[record.objects.length - 1];
      if (entry.stage === 'display' && !destroyDisplay) break;

      record.stages[entry.stage] = {state: 'reaping', result: null};
      const message = destroy(entry);
      if (message) {
        failure = {kind: entry.kind, name: entry.name, handle: entry.handle, message};
        break;
      }

      record.objects.pop();
      destroyed.push({kind: entry.kind, name: entry.name, handle: entry.handle});
    }

    record.failure = failure;
    if (!failure) {
      record.blobHash = null;
      record.stages.app = {state: 'none', result: null};
    }

    const displayReady = record.stages.display.state === 'ready';
    const emptied = !failure && !record.objects.length;
    if (emptied && (destroyDisplay || !displayReady)) state.graphics = null;

    return {...summary(), destroyed, retained: state.graphics ? state.graphics.objects.length : 0};
  }

  switch (request.command) {
    case 'graphics-begin':
      return begin();
    case 'graphics-record':
      return recordObjects();
    case 'graphics-commit':
      return commit();
    case 'graphics-status':
      return status();
    case 'graphics-reap':
      return reap();
    default:
      throw Error('Unknown graphics ledger command');
  }
}
