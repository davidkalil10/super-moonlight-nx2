import {sdkResolver} from './sdk.js';

/** The UI protocol between createRemoteUi and createConsoleUi; README.md, "Console UI". */
export const UI_PROTOCOL = 3;

/** @import {Civ7Rpc} from './transport.js' */
/** @import {Civ7Reply} from './protocol.js' */
/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */
/** @import {Event, Host, Intent, Model} from '../ui/model.js' */
/** @import {MachineStep} from '../ui/service.js' */

/**
 * The control-page layout payload.js inlines from shared/ring.js and ui/page.js.
 * @typedef {{words: Record<string, number>, operations: Record<string, number>, magic: number,
 *   page: {offset: number, bytes: number, magic: number}}} UiLayout
 */

/**
 * @typedef {Pick<ConsoleNative, 'address' | 'checkMemory' | 'verified' | 'call' | 'read32' | 'read64' |
 *   'write32' | 'writeBuffer' | 'readBuffer' | 'readMemory' | 'encode' | 'decode'> & {
 *   now?: () => number, uiLayout: UiLayout,
 *   createSettingsCore: typeof import('../ui/settings.js').createSettingsCore,
 *   settingValues: Parameters<typeof import('../ui/settings.js').createSettingsCore>[0],
 *   createMachine: typeof import('../ui/model.js').createMachine,
 *   createSettingsStore: typeof import('./settings-store.js').createSettingsStore}} ConsoleUiNative
 */

/**
 * What snapshot() records about the shown page: a header rewrite or an apply timeout.
 * @typedef {{event: 'header-rewrite' | 'apply-timeout', sequence: number}} Published
 */

/**
 * The page buffers as the console sees them: the PC writes page `next` into its slot and asks
 * for it with ui-show; `stale` once the shown page went unapplied too long.
 * @typedef {{epoch: number, sequence: number, applied: number, next: number, stale: boolean}} PageState
 */

/** @param {number | bigint} value */
const hex = value => '0x' + BigInt(value).toString(16);

/**
 * The console's snapshot() reply. Trusted as the console's own model code built it.
 * @param {Civ7Reply} reply
 */
const asStep = reply => /** @type {MachineStep} */ (/** @type {unknown} */ (reply));

/**
 * The verified filesystem functions the console's settings store calls, by store name.
 * @param {Civ7Rpc} rpc
 */
export async function settingsFunctions(rpc) {
  const resolve = sdkResolver(rpc);
  /** @type {Record<string, string>} */
  const functions = {};
  for (const name of ['commit', 'open', 'read', 'write', 'size', 'create', 'close', 'resize', 'flush'])
    functions[name] = '0x' + (await resolve('fs' + name[0].toUpperCase() + name.slice(1))).toString(16);
  return functions;
}

/**
 * The host half of the console UI: forwards events, asks the console to show the pages the PC
 * wrote, and returns the console's snapshots.
 * @param {Civ7Rpc} rpc
 * @param {number} mapped the app's private storage
 * @param {Host[]} hosts
 * @param {unknown} migration settings saved on the PC, for a console without its own
 * @param {{epoch?: number}} [options]
 */
export async function createRemoteUi(rpc, mapped, hosts, migration, options = {}) {
  const functions = await settingsFunctions(rpc);
  const memory = await rpc.allocate(0x2000);
  try {
    const epoch = options.epoch ?? Math.floor(Date.now() / 1000) >>> 0;
    const initial = asStep(await rpc.request({command: 'ui-init', version: UI_PROTOCOL, mapped: hex(mapped), hosts,
      settings: migration, epoch, store: {memory: hex(memory), functions}}));
    // The host logs stepped results only, so a startup storage failure rides on the first one.
    let unreported = initial.storageError;
    /** @param {{command: string, [field: string]: unknown}} request */
    async function step(request) {
      const result = asStep(await rpc.request(request));
      if (unreported && !result.storageError) result.storageError = unreported;
      unreported = null;
      return result;
    }

    return {
      initial,
      dispatch: (/** @type {Event} */ event) => step({command: 'ui-event', event}),
      poll: () => step({command: 'ui-poll'}),
      show: (/** @type {{sequence: number, screen: string}} */ page) =>
        step({command: 'ui-show', sequence: page.sequence, screen: page.screen}),
      async close() {
        await rpc.request({command: 'ui-close'});
        await rpc.release(memory);
      }
    };
  } catch (error) {
    await rpc.release(memory).catch(() => {});
    throw error;
  }
}

/**
 * `ui-init`: the console UI, which owns the model, settings, input gating and the page header.
 * The PC composes and writes the page bytes. Shipped by toString().
 * @param {ConsoleUiNative} native
 * @param {ConsoleRequest} configuration createRemoteUi's ui-init request
 */
export function createConsoleUi(native, configuration) {
  const {address, checkMemory, read32, write32, writeBuffer} = native;
  const PROTOCOL = 3;
  const APPLY_TIMEOUT_MS = 5000;
  const now = native.now || (() => Date.now());
  /** @param {unknown} error */
  const failureText = error => {
    const message = error && typeof error === 'object' && 'message' in error ? error.message : undefined;
    return String(message || error);
  };
  if (configuration.version !== PROTOCOL)
    throw Error('Console UI protocol ' + configuration.version + ' is not ' + PROTOCOL);
  const mapped = address(configuration.mapped);
  const layout = native.uiLayout.words;
  const operations = native.uiLayout.operations;
  const pageLayout = native.uiLayout.page;
  checkMemory(mapped, layout.hostBusy + 4, 3);
  checkMemory(mapped + BigInt(pageLayout.offset), 2 * pageLayout.bytes, 3);

  const rules = native.createSettingsCore(native.settingValues);
  const machine = native.createMachine({...rules, rows: native.settingValues});
  const storeConfiguration = /** @type {{memory: unknown, functions: Record<string, unknown>}} */ (
    configuration.store);
  const store = native.createSettingsStore(native, storeConfiguration, rules);
  /** @type {string | null} */
  let storageError = null;
  /** @type {string | null} */
  let reported = null;
  /** @type {ReturnType<typeof store.load>} */
  let saved = null;
  try { saved = store.load(); }
  catch (error) { storageError = failureText(error); }
  const hosts = /** @type {Host[]} */ (configuration.hosts);
  /** @type {Model} */
  let model = machine.makeModel(hosts, saved ?? rules.sanitize(configuration.settings));
  if (saved === null && !storageError) {
    try { store.save(model.settings); }
    catch (error) { storageError = failureText(error); }
  }
  model = {...model, settingsError: storageError};
  let revision = 0;
  /** @type {Intent[]} */
  let intents = [];
  const word = (/** @type {string} */ name) => Number(read32(mapped + BigInt(layout[name])));
  let seen = word('cmdSequence');

  const pageBase = (/** @type {number} */ slot) => mapped + BigInt(pageLayout.offset + slot * pageLayout.bytes);
  const shownSlot = word('uiShown') & 1;
  const shownMagic = Number(read32(pageBase(shownSlot)));
  const shownEpoch = shownMagic === pageLayout.magic ? Number(read32(pageBase(shownSlot) + 4n)) : 0;
  const epoch = Math.max(Number(configuration.epoch) >>> 0, (shownEpoch + 1) >>> 0) >>> 0 || 1;
  let sequence = word('uiApplied');
  let applied = sequence;
  /** @type {number[] | null} */
  let header = null;
  /**
   * The screen of the page the header announces; commands for another screen are dropped.
   * @type {string | null}
   */
  let shownScreen = null;
  let publishedAt = 0;
  let stale = false;
  /** @type {Published[]} */
  let published = [];

  /**
   * The four host words in one write, as the PC wrote them.
   * @param {number[]} words
   */
  function writeHeader(words) {
    writeBuffer(mapped + BigInt(layout.uiMagic), new Uint8Array(Uint32Array.from(words).buffer));
  }

  /** @param {number[]} words */
  function headerHolds(words) {
    return words.every((value, k) => word(['uiMagic', 'uiEpoch', 'uiSequence', 'uiPage'][k]) === value);
  }

  /** The sequence after this one: never 0, and never on the page the console last applied. */
  function nextSequence() {
    const following = (/** @type {number} */ value) => ((value + 1) >>> 0) || 1;
    const next = following(sequence);
    const onAppliedPage = (next & 1) === (applied & 1) && applied !== 0;
    return onAppliedPage ? following(next) : next;
  }

  /**
   * `ui-show`: announces the page the PC wrote into the next slot, once its header words name
   * this epoch and sequence.
   * @param {ConsoleRequest} request
   */
  function show(request) {
    const next = nextSequence();
    if (request.sequence !== next) throw Error('UI page ' + request.sequence + ' is not the next page ' + next);
    const base = pageBase(next & 1);
    const magicOk = Number(read32(base)) === pageLayout.magic;
    const pageOk = magicOk && Number(read32(base + 4n)) === epoch && Number(read32(base + 8n)) === next;
    if (!pageOk) throw Error('UI page ' + next + ' is not in its buffer');

    const words = [native.uiLayout.magic, epoch, next, next & 1];
    header = words;
    writeHeader(words);
    sequence = next;
    shownScreen = String(request.screen);
    publishedAt = now();
    stale = false;
  }

  /** Rewrites a header the console reverted and flags a page left unapplied too long. */
  function watch() {
    if (!header || applied === sequence) return;
    applied = word('uiApplied');
    if (applied === sequence) return;
    if (!headerHolds(header)) {
      writeHeader(header);
      published.push({event: 'header-rewrite', sequence});
    }
    if (!stale && now() - publishedAt > APPLY_TIMEOUT_MS) {
      published.push({event: 'apply-timeout', sequence});
      stale = true;
    }
  }

  /** @param {Event} event */
  function dispatch(event) {
    const step = machine.reduce(model, event);
    if (step.model !== model) revision++;
    model = step.model;
    for (const intent of step.intents) {
      if (intent.type === 'saveSettings') {
        try {
          store.save(model.settings);
          storageError = null;
        } catch (error) {
          storageError = failureText(error);
        }
      } else if (!['pauseInput', 'resumeInput'].includes(intent.type)) intents.push(intent);
    }
    if (model.settingsError !== storageError) {
      model = {...model, settingsError: storageError};
      revision++;
    }
  }

  function consumeCommand() {
    const sequenceWord = word('cmdSequence');
    if (sequenceWord === seen) return;
    seen = sequenceWord;
    write32(mapped + BigInt(layout.hostAck), BigInt(sequenceWord));
    const op = Object.keys(operations).find(key => operations[key] === word('cmdOp'));
    if (!op || word('cmdEpoch') !== word('uiEpoch') || word('cmdPage') !== word('uiSequence')) return;
    if (model.screen !== shownScreen) return;
    dispatch({type: 'command', op, item: word('cmdItem'), value: word('cmdValue') | 0});
  }

  /**
   * The shader raises the overlay itself, so an overlay whose chord command was overwritten
   * before this poll still pauses input. Hiding stays with the B command (README.md, "Console UI").
   */
  function followOverlay() {
    const streaming = model.screen === 'streaming' && shownScreen === 'streaming';
    const pageApplied = header !== null && word('uiApplied') === sequence;
    if (!streaming || !pageApplied || model.overlay) return;
    if (word('uiOverlay') === 0) return;

    dispatch({type: 'command', op: 'chord', item: 0, value: 0});
  }

  function poll() {
    watch();
    consumeCommand();
    followOverlay();
  }

  writeHeader([0, 0, 0, 0]);

  return {
    dispatch,
    poll,
    show,
    snapshot() {
      // A failure is reported once per change; settingsError keeps it on screen.
      const fresh = storageError === reported ? null : storageError;
      reported = storageError;
      if (header) applied = word('uiApplied');
      /** @type {PageState} */
      const page = {epoch, sequence, applied, next: nextSequence(), stale};
      /** @type {MachineStep} */
      const result = {model, intents, revision, storageError: fresh, published, page};
      intents = [];
      published = [];
      return result;
    },
    close() {
      writeHeader([0, 0, 0, 0]);
      header = null;
    },
    allowInput: () => model.screen === 'streaming' && !model.overlay,
    /** Whether the frame needs the compute pass: off the plain stream, or a page still unapplied. */
    interactive() {
      const quiet = model.screen === 'streaming' && !model.overlay;
      return !quiet || (header !== null && word('uiApplied') !== sequence);
    }
  };
}
