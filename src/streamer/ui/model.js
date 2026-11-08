/**
 * The console UI state machine, pure so the tests drive it without a console: console commands
 * and service results in, the next model and the intents to run out. Screens and transitions:
 * team note `moonlight-ui-design.md`; the item id scheme and shipping rules are in CLAUDE.md.
 */
import * as settingsRules from './settings.js';

/**
 * @typedef {{name: string, address: string, uniqueid?: string}} Host
 * @typedef {{id: number, name: string}} App
 * @typedef {{type: string, [key: string]: any}} Intent
 * @typedef {{
 *   screen: string, hosts: Host[], host: Host | null, apps: App[], currentGame: number,
 *   app: App | null, appPage: number, appIndex: number, hostPage: number, hostIndex: number,
 *   pin: string | null, url: string | null, entry: string,
 *   message: string | null, back: string, from: string, overlay: boolean,
 *   settings: Record<string, any>, settingsError?: string | null, docked: boolean,
 *   editing: string | null
 * }} Model
 * @typedef {{op: string, item: number, value: number}} Command
 * @typedef {{apps: App[], currentGame: number, message?: string | null}} Listed
 * @typedef {{model: Model, intents: Intent[]}} Step
 * @typedef {({type: 'command'} & Command)
 *   | {type: 'attached' | 'notPaired' | 'paired' | 'streamStarted' | 'streamEnded' | 'quitDone'
 *       | 'appGone' | 'unpaired'}
 *   | {type: 'connectionLost', host?: Host | null}
 *   | {type: 'hosts', hosts: Host[]}
 *   | ({type: 'listed'} & Listed)
 *   | {type: 'pin', pin: string | null, url: string | null}
 *   | {type: 'stage', message: string | null}
 *   | {type: 'operationMode', docked: boolean}
 *   | {type: 'failed', message: string, back?: string}} Event
 * @typedef {Record<string, any>} Settings
 * @typedef {{rows: {id: string, locked: boolean, unbacked: boolean, lockedSizes?: string[]}[], defaults: () => Settings,
 *   adjust: (settings: Settings, id: string, direction: number, docked?: boolean) => Settings}} Rules
 */

/**
 * Builds the reducer over the settings rules. Self-contained (names resolve inside it or come in
 * through `rules`) because payload.js ships it to the console with toString().
 * @param {Rules} rules
 */
function createMachine(rules) {
  /** First item id of each group; a row's id is its group base plus its index, 10000 rows apart. */
  const ITEM = {
    back: 1,
    retry: 2,
    previous: 3,
    next: 4,
    returnToApps: 5,
    quitHost: 6,
    confirmQuit: 7,
    cancel: 8,
    addHost: 9,
    findHosts: 10,
    unpair: 11,
    removeHost: 12,
    erase: 13,
    connect: 14,
    host: 10000,
    app: 20000,
    setting: 30000,
    key: 40000
  };
  /** The address keypad, in item order: ITEM.key + index types KEYS[index]. */
  const KEYS = '123456789.0';
  /** The longest address the keypad takes: four octets of three digits. */
  const MAX_ENTRY = 15;
  /** Covers per apps page: two rows of five, within the page's 24 images and 4 MiB body. */
  const APPS_PER_PAGE = 10;
  /** Host cards per hosts page: two columns of three. */
  const HOSTS_PER_PAGE = 6;
  /** Screens with no operation in flight, where a late failure has nothing to report on. */
  const IDLE_SCREENS = ['hosts', 'addHost', 'hostMenu', 'settings'];

  /**
   * @param {Host[]} hosts
   * @param {Record<string, any>} [settings]
   * @returns {Model}
   */
  function makeModel(hosts, settings = rules.defaults()) {
    return {
      screen: 'splash',
      hosts,
      host: null,
      apps: [],
      currentGame: 0,
      app: null,
      appPage: 0,
      appIndex: 0,
      hostPage: 0,
      hostIndex: 0,
      pin: null,
      url: null,
      entry: '',
      message: null,
      back: 'hosts',
      from: 'hosts',
      overlay: false,
      settings,
      docked: false,
      editing: null
    };
  }

  /**
   * The model with `patch` applied, and the intents to run.
   * @param {Model} model @param {Partial<Model>} patch @param {Intent[]} [intents]
   * @returns {Step}
   */
  const next = (model, patch, intents = []) => ({model: {...model, ...patch}, intents});

  /**
   * The model unchanged, nothing to run.
   * @param {Model} model
   * @returns {Step}
   */
  const same = model => ({model, intents: []});

  /** Back to the hosts page, forgetting the host's apps. */
  const LEAVE_HOST = {screen: 'hosts', host: null, apps: [], app: null, appPage: 0, appIndex: 0};

  /** The last page of a list paged by `size`. @param {number} length @param {number} size */
  const lastPage = (length, size) => Math.max(0, Math.ceil(length / size) - 1);

  /**
   * Starts listing the host's apps.
   * @param {Model} model @param {Host} host @param {number} [index] The host's place in the
   *   list; a host not saved yet keeps the current place, so a failed add returns to it.
   */
  function openHost(model, host, index = model.hostIndex) {
    return next(
      model,
      {
        screen: 'connecting',
        host,
        hostIndex: index,
        hostPage: Math.floor(index / HOSTS_PER_PAGE),
        pin: null,
        url: null,
        message: null
      },
      [{type: 'list', host}]
    );
  }

  /** @param {Model} model @param {string} message @param {string} back */
  function fail(model, message, back) {
    return next(model, {screen: 'error', message, back, pin: null, url: null, overlay: false});
  }

  /**
   * Whether `entry` is a dotted IPv4 unicast address, each octet 0 to 255 without a leading
   * zero: not 0.0.0.0/8 (this host), multicast, reserved or broadcast.
   * @param {string} entry
   */
  function isAddress(entry) {
    const octets = entry.split('.');
    if (octets.length !== 4) return false;

    const dotted = octets.every(octet => /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255);
    if (!dotted) return false;

    const first = Number(octets[0]);
    return first !== 0 && first < 224;
  }

  /**
   * A on a host card opens it and Y on one opens its options; A on the pager turns the page;
   * Add PC opens the keypad; Find PCs, or Y anywhere else, looks for hosts again.
   * @param {Model} model @param {Command} command @returns {Step}
   */
  function onHostsCommand(model, {op, item}) {
    const index = item - ITEM.host;
    const host = model.hosts[index];
    if (op === 'a' && host) return openHost(model, host, index);
    if (op === 'y' && host)
      return next(model, {screen: 'hostMenu', host, hostIndex: index, message: null});

    const last = lastPage(model.hosts.length, HOSTS_PER_PAGE);
    if (op === 'a' && item === ITEM.previous)
      return next(model, {hostPage: Math.max(0, model.hostPage - 1)});
    if (op === 'a' && item === ITEM.next)
      return next(model, {hostPage: Math.min(last, model.hostPage + 1)});
    if (op === 'a' && item === ITEM.addHost)
      return next(model, {screen: 'addHost', entry: '', message: null});

    const find = op === 'y' || (op === 'a' && item === ITEM.findHosts);
    if (find) return next(model, {message: null}, [{type: 'refreshHosts'}]);
    return same(model);
  }

  /**
   * The keypad: A on a key types it, A on erase or Y removes the last character, A on Connect
   * opens the typed address (a saved host keeps its name), B or Cancel goes back.
   * @param {Model} model @param {Command} command @returns {Step}
   */
  function onAddHostCommand(model, {op, item}) {
    const cancelled = op === 'b' || (op === 'a' && item === ITEM.cancel);
    if (cancelled) return next(model, {screen: 'hosts', entry: ''});

    const erase = op === 'y' || (op === 'a' && item === ITEM.erase);
    if (erase) return next(model, {entry: model.entry.slice(0, -1)});
    if (op !== 'a') return same(model);

    const key = KEYS[item - ITEM.key];
    if (key !== undefined && item >= ITEM.key) {
      if (model.entry.length >= MAX_ENTRY) return same(model);
      return next(model, {entry: model.entry + key});
    }

    if (item !== ITEM.connect || !isAddress(model.entry)) return same(model);

    const address = model.entry;
    const saved = model.hosts.findIndex(entry => entry.address === address);
    const patch = {entry: ''};
    if (saved >= 0) return openHost({...model, ...patch}, model.hosts[saved], saved);
    return openHost({...model, ...patch}, {name: address, address});
  }

  /**
   * One host's options: Unpair asks the host to forget this console, Remove drops it from the
   * list; B or Cancel goes back.
   * @param {Model} model @param {Command} command @returns {Step}
   */
  function onHostMenuCommand(model, {op, item}) {
    const host = model.host;
    const cancelled = op === 'b' || (op === 'a' && item === ITEM.cancel);
    if (cancelled || !host) return next(model, {screen: 'hosts', host: null});
    if (op !== 'a') return same(model);

    if (item === ITEM.unpair)
      return next(model, {screen: 'unpairing'}, [{type: 'unpairHost', host}]);
    if (item !== ITEM.removeHost) return same(model);

    const hosts = model.hosts.filter(entry => entry.address !== host.address);
    const hostIndex = Math.min(model.hostIndex, Math.max(0, hosts.length - 1));
    return next(model, {
      screen: 'hosts',
      host: null,
      hosts,
      hostIndex,
      hostPage: Math.floor(hostIndex / HOSTS_PER_PAGE),
      message: 'Removed ' + host.name
    }, [{type: 'removeHost', host}]);
  }

  /**
   * A on a cover launches it unless another app is running on the PC; B leaves the host and Y
   * on the running app's cover asks to quit it.
   * @param {Model} model @param {Command} command @returns {Step}
   */
  function onAppsCommand(model, {op, item}) {
    if (op === 'b') return next(model, LEAVE_HOST);
    if (op === 'y') return onQuitAsked(model, item);
    if (op !== 'a') return same(model);

    if (item === ITEM.back) return next(model, LEAVE_HOST);
    if (item === ITEM.previous) return next(model, {appPage: Math.max(0, model.appPage - 1)});
    if (item === ITEM.next) {
      const last = lastPage(model.apps.length, APPS_PER_PAGE);
      return next(model, {appPage: Math.min(last, model.appPage + 1)});
    }

    const appIndex = item - ITEM.app;
    const app = model.apps[appIndex];
    if (!app) return same(model);

    if (model.currentGame && app.id !== model.currentGame) {
      const running = model.apps.find(entry => entry.id === model.currentGame)?.name;
      const message =
        (running ?? 'Another app') + ' is still running on the PC; press Y on it to quit it first';
      return next(model, {message});
    }

    return next(model, {screen: 'launching', app, appIndex, message: null, overlay: false}, [
      {type: 'launch', host: model.host, app, settings: model.settings}
    ]);
  }

  /**
   * Y quits only from the cover of the app running on the PC; the page hints it only there.
   * @param {Model} model @param {number} item @returns {Step}
   */
  function onQuitAsked(model, item) {
    const hovered = model.apps[item - ITEM.app];
    const running = model.currentGame !== 0 && hovered?.id === model.currentGame;
    if (!running) return same(model);

    return next(model, {screen: 'quitConfirm'});
  }

  /**
   * A on Quit quits the host app; B or A on Cancel goes back to the apps.
   * @param {Model} model @param {Command} command @returns {Step}
   */
  function onQuitConfirmCommand(model, {op, item}) {
    if (op === 'a' && item === ITEM.confirmQuit)
      return next(model, {screen: 'quitting'}, [{type: 'quitHost', host: model.host}]);

    const cancelled = op === 'b' || (op === 'a' && item === ITEM.cancel);
    if (cancelled) return next(model, {screen: 'apps'});
    return same(model);
  }

  /**
   * EDIT names the setting the console is editing, or none; Y resets all of them; B goes back.
   * @param {Model} model @param {Command} command @returns {Step}
   */
  function onSettingsCommand(model, command) {
    if (command.op === 'edit') return onEdit(model, command.item);
    if (model.editing) return onEditCommand(model, command);

    const {op} = command;
    if (op === 'b') return next(model, {screen: model.from});
    if (op === 'y') return next(model, {settings: rules.defaults()}, [{type: 'saveSettings'}]);
    return same(model);
  }

  /**
   * The console's edit word, sent as a command and read back every poll, so repeating it
   * changes nothing. Locked and unbacked rows never edit.
   * @param {Model} model @param {number} item
   * @returns {Step}
   */
  function onEdit(model, item) {
    const setting = rules.rows[item - ITEM.setting];
    const editable = setting && !setting.locked && !setting.unbacked &&
      !setting.lockedSizes?.includes(model.settings.size);
    const editing = editable ? setting.id : null;

    if (editing === model.editing) return same(model);
    return next(model, {editing});
  }

  /**
   * While a setting is edited, ADJUST on it steps, changes and saves it; the rest waits for the
   * edit to end. The edit outlives a dock change: adjust() steps by the new mode.
   * @param {Model} model @param {Command} command @returns {Step}
   */
  function onEditCommand(model, {op, item, value}) {
    const setting = rules.rows[item - ITEM.setting];
    if (op !== 'adjust' || setting?.id !== model.editing) return same(model);

    const settings = rules.adjust(model.settings, setting.id, value, model.docked);
    if (settings === model.settings) return same(model);
    return next(model, {settings}, [{type: 'saveSettings'}]);
  }

  /**
   * The chord shows the overlay; with it shown, B hides it and A picks one of its buttons.
   * Return to apps also quits the host app when the Quit on return setting is on.
   * @param {Model} model @param {Command} command @returns {Step}
   */
  function onStreamingCommand(model, {op, item}) {
    if (op === 'chord') return next(model, {overlay: true}, [{type: 'pauseInput'}]);
    if (!model.overlay) return same(model);

    if (op === 'b') return next(model, {overlay: false}, [{type: 'resumeInput'}]);
    const quitOnReturn = op === 'a' && item === ITEM.returnToApps && model.settings.quitOnReturn;
    if (op === 'a' && item === ITEM.returnToApps && !quitOnReturn)
      return next(model, {screen: 'connecting', overlay: false}, [{type: 'stopStream'}]);
    if (quitOnReturn || (op === 'a' && item === ITEM.quitHost))
      return next(model, {screen: 'quitting', overlay: false}, [
        {type: 'stopStream'},
        {type: 'quitHost', host: model.host}
      ]);
    return same(model);
  }

  /**
   * A console command on the current screen.
   * @param {Model} model @param {Command} command
   * @returns {Step}
   */
  function onCommand(model, command) {
    const {op} = command;
    if (op === 'x' && ['hosts', 'apps'].includes(model.screen))
      return next(model, {screen: 'settings', from: model.screen, editing: null});

    switch (model.screen) {
      case 'hosts':
        return onHostsCommand(model, command);
      case 'addHost':
        return onAddHostCommand(model, command);
      case 'hostMenu':
        return onHostMenuCommand(model, command);
      case 'connecting':
        if (op === 'b') return next(model, {screen: 'hosts', host: null}, [{type: 'cancelList'}]);
        return same(model);
      case 'pairing':
        if (op !== 'b') return same(model);
        return next(model, {screen: 'hosts', host: null, pin: null, url: null}, [
          {type: 'cancelPair'}
        ]);
      case 'apps':
        return onAppsCommand(model, command);
      case 'quitConfirm':
        return onQuitConfirmCommand(model, command);
      case 'settings':
        return onSettingsCommand(model, command);
      case 'launching':
        if (op === 'b') return next(model, {screen: 'connecting', app: null}, [{type: 'stopStream'}]);
        return same(model);
      case 'streaming':
        return onStreamingCommand(model, command);
      case 'error':
      case 'connectionLost':
        if (op !== 'a' && op !== 'b') return same(model);
        if (model.screen === 'connectionLost' && op === 'b')
          return next(model, {screen: 'hosts', host: null, message: null});
        if (model.back === 'apps' && model.host) return openHost(model, model.host);
        return next(model, {screen: 'hosts', host: null, message: null});
      default:
        return same(model);
    }
  }

  /**
   * The host's apps arrived: show them and fetch their covers.
   * @param {Model} model
   * @param {Listed} listed
   * @returns {Step}
   */
  function onListed(model, {apps, currentGame, message}) {
    if (!['connecting', 'pairing', 'quitting'].includes(model.screen)) return same(model);

    const appPage = Math.min(model.appPage, lastPage(apps.length, APPS_PER_PAGE));
    return next(
      model,
      {
        screen: 'apps',
        apps,
        currentGame,
        appPage,
        pin: null,
        url: null,
        message: message ?? null
      },
      [{type: 'covers', host: model.host, apps}]
    );
  }

  /**
   * The console link dropped. Given the PC a stream was on and still saved, A reconnects to it
   * and B goes to the PCs with it selected.
   * @param {Model} model @param {Host | null | undefined} lost
   */
  function onConnectionLost(model, lost) {
    const index = model.hosts.findIndex(host => host.address === lost?.address);
    const page = {screen: 'connectionLost', app: null, apps: [], overlay: false};
    if (index < 0) {
      const message = 'Connection lost. Select a PC to reconnect.';
      return next(model, {...page, host: null, back: 'hosts', message});
    }

    const host = model.hosts[index];
    return next(model, {
      ...page,
      host,
      hostIndex: index,
      hostPage: Math.floor(index / HOSTS_PER_PAGE),
      back: 'apps',
      message: 'The stream from ' + host.name + ' was cut off. Press A to reconnect.'
    });
  }

  /**
   * @param {Model} model
   * @param {Event} event A console command or a service result, told apart by type.
   * @returns {Step}
   */
  function reduce(model, event) {
    switch (event.type) {
      case 'command':
        return onCommand(model, event);
      case 'attached':
        if (model.screen === 'connectionLost') return same(model);
        return next(model, {screen: 'hosts'});
      case 'connectionLost':
        return onConnectionLost(model, event.host);
      case 'hosts':
        return next(model, {
          hosts: event.hosts,
          hostPage: Math.min(model.hostPage, lastPage(event.hosts.length, HOSTS_PER_PAGE))
        });
      case 'listed':
        return onListed(model, event);
      case 'notPaired':
        if (model.screen !== 'connecting') return same(model);
        return next(model, {screen: 'pairing', pin: null, url: null}, [
          {type: 'pair', host: model.host}
        ]);
      case 'pin':
        if (model.screen !== 'pairing') return same(model);
        return next(model, {pin: event.pin, url: event.url});
      case 'paired':
        if (model.screen !== 'pairing') return same(model);
        return next(model, {screen: 'connecting', pin: null, url: null}, [
          {type: 'list', host: model.host}
        ]);
      case 'streamStarted':
        if (model.screen !== 'launching') return same(model);
        return next(model, {screen: 'streaming', overlay: false});
      case 'stage':
        if (model.screen !== 'launching') return same(model);
        return next(model, {message: event.message});
      case 'streamEnded':
        if (!['launching', 'streaming', 'connecting'].includes(model.screen)) return same(model);
        return next(model, {screen: 'connecting', app: null, overlay: false}, [
          {type: 'list', host: model.host}
        ]);
      case 'unpaired':
        if (model.screen !== 'unpairing') return same(model);
        return next(model, {screen: 'hosts', message: 'Unpaired ' + model.host?.name, host: null});
      case 'quitDone':
        if (model.screen !== 'quitting') return same(model);
        return next(model, {screen: 'connecting', app: null}, [{type: 'list', host: model.host}]);
      case 'failed':
        if (IDLE_SCREENS.includes(model.screen)) return same(model);
        return fail(model, event.message, event.back ?? (model.host ? 'apps' : 'hosts'));
      case 'appGone':
        return next(model, {screen: 'stopped'}, [{type: 'exit'}]);
      case 'operationMode':
        if (event.docked === model.docked) return same(model);
        return next(model, {docked: event.docked});
      default:
        return same(model);
    }
  }

  return {ITEM, KEYS, APPS_PER_PAGE, HOSTS_PER_PAGE, isAddress, makeModel, reduce};
}

const {ITEM, KEYS, APPS_PER_PAGE, HOSTS_PER_PAGE, isAddress, makeModel, reduce} = createMachine({
  rows: settingsRules.VALUES,
  defaults: settingsRules.defaults,
  adjust: settingsRules.adjust
});

export {ITEM, KEYS, APPS_PER_PAGE, HOSTS_PER_PAGE, isAddress, createMachine, makeModel, reduce};
