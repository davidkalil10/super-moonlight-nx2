/**
 * The console UI state machine: pure, so the tests drive it without a console. The host
 * service feeds it the commands the console forwards (A/B/X/Y/ADJUST/CHORD on an item) and the
 * results of its own work (lists, PINs, stream events); it answers with the next model and the
 * intents the service must run. Screens and transitions: team note moonlight-ui-design.md.
 *
 * Item ids are the host's: ITEM groups a page's rows into id ranges so a command names a host,
 * an app or a setting without the console knowing what a row is.
 */
import {CATALOG, adjust, defaults} from './settings.js';

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
  host: 10000,
  app: 20000,
  setting: 30000
};
/** Covers per apps page: two rows of five, within the page's 24 images and 4 MiB body. */
const APPS_PER_PAGE = 10;
/** Host cards per hosts page: two columns of three. */
const HOSTS_PER_PAGE = 6;

/**
 * @typedef {{name: string, address: string}} Host
 * @typedef {{id: number, name: string}} App
 * @typedef {{type: string, [key: string]: any}} Intent
 * @typedef {{
 *   screen: string, hosts: Host[], host: Host | null, apps: App[], currentGame: number,
 *   app: App | null, appPage: number, appIndex: number, hostPage: number, hostIndex: number,
 *   pin: string | null, url: string | null,
 *   message: string | null, back: string, from: string, overlay: boolean,
 *   settings: Record<string, any>
 * }} Model
 * @typedef {{op: string, item: number, value: number}} Command
 * @typedef {{apps: App[], currentGame: number, message?: string | null}} Listed
 * @typedef {{model: Model, intents: Intent[]}} Step
 * @typedef {({type: 'command'} & Command)
 *   | {type: 'attached' | 'notPaired' | 'paired' | 'streamStarted' | 'streamEnded' | 'quitDone'
 *       | 'appGone'}
 *   | {type: 'hosts', hosts: Host[]}
 *   | ({type: 'listed'} & Listed)
 *   | {type: 'pin', pin: string | null, url: string | null}
 *   | {type: 'stage', message: string | null}
 *   | {type: 'failed', message: string, back?: string}} Event
 */

/**
 * @param {Host[]} hosts
 * @param {Record<string, any>} [settings]
 * @returns {Model}
 */
function makeModel(hosts, settings = defaults()) {
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
    message: null,
    back: 'hosts',
    from: 'hosts',
    overlay: false,
    settings
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
 * @param {Model} model @param {Host} host @param {number} [index] The host's place in the list.
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

/** A on a host card opens it; A on the pager turns the page; Y refreshes the list. */
function onHostsCommand(model, {op, item}) {
  const host = model.hosts[item - ITEM.host];
  if (op === 'a' && host) return openHost(model, host, item - ITEM.host);

  const last = lastPage(model.hosts.length, HOSTS_PER_PAGE);
  if (op === 'a' && item === ITEM.previous)
    return next(model, {hostPage: Math.max(0, model.hostPage - 1)});
  if (op === 'a' && item === ITEM.next)
    return next(model, {hostPage: Math.min(last, model.hostPage + 1)});

  if (op === 'y') return next(model, {}, [{type: 'refreshHosts'}]);
  return same(model);
}

/**
 * A on a cover launches it unless another app is running on the PC; B leaves the host and Y
 * asks to quit the running app.
 */
function onAppsCommand(model, {op, item}) {
  if (op === 'b') return next(model, LEAVE_HOST);
  if (op === 'y') return next(model, {screen: 'quitConfirm'});
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
      (running ?? 'Another app') + ' is still running on the PC; press Y to quit it first';
    return next(model, {message});
  }

  return next(model, {screen: 'launching', app, appIndex, message: null, overlay: false}, [
    {type: 'launch', host: model.host, app, settings: model.settings}
  ]);
}

/** ADJUST on a setting changes and saves it; Y resets all of them; B goes back. */
function onSettingsCommand(model, {op, item, value}) {
  if (op === 'b') return next(model, {screen: model.from});
  if (op === 'y') return next(model, {settings: defaults()}, [{type: 'saveSettings'}]);

  const setting = CATALOG[item - ITEM.setting];
  if (op !== 'adjust' || !setting) return same(model);

  const settings = adjust(model.settings, setting.id, value);
  if (settings === model.settings) return same(model);
  return next(model, {settings}, [{type: 'saveSettings'}]);
}

/** The chord shows the overlay; with it shown, B hides it and A picks one of its buttons. */
function onStreamingCommand(model, {op, item}) {
  if (op === 'chord') return next(model, {overlay: true}, [{type: 'pauseInput'}]);
  if (!model.overlay) return same(model);

  if (op === 'b') return next(model, {overlay: false}, [{type: 'resumeInput'}]);
  if (op === 'a' && item === ITEM.returnToApps)
    return next(model, {screen: 'connecting', overlay: false}, [{type: 'stopStream'}]);
  if (op === 'a' && item === ITEM.quitHost)
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
  const {op, item} = command;
  if (op === 'x' && ['hosts', 'apps'].includes(model.screen))
    return next(model, {screen: 'settings', from: model.screen});

  switch (model.screen) {
    case 'hosts':
      return onHostsCommand(model, command);
    case 'connecting':
      if (op === 'b') return next(model, {screen: 'hosts', host: null}, [{type: 'cancelList'}]);
      return same(model);
    case 'pairing':
      if (op === 'b')
        return next(model, {screen: 'hosts', pin: null, url: null}, [{type: 'cancelPair'}]);
      return same(model);
    case 'apps':
      return onAppsCommand(model, command);
    case 'quitConfirm':
      if (op === 'a' && item === ITEM.confirmQuit)
        return next(model, {screen: 'quitting'}, [{type: 'quitHost', host: model.host}]);
      if (op === 'b' || (op === 'a' && item === ITEM.cancel)) return next(model, {screen: 'apps'});
      return same(model);
    case 'settings':
      return onSettingsCommand(model, command);
    case 'launching':
      if (op === 'b') return next(model, {screen: 'connecting', app: null}, [{type: 'stopStream'}]);
      return same(model);
    case 'streaming':
      return onStreamingCommand(model, command);
    case 'error':
      if (op !== 'a' && op !== 'b') return same(model);
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
 * @param {Model} model
 * @param {Event} event A console command or a service result, told apart by type.
 * @returns {Step}
 */
function reduce(model, event) {
  switch (event.type) {
    case 'command':
      return onCommand(model, event);
    case 'attached':
      return next(model, {screen: 'hosts'});
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
    case 'quitDone':
      if (model.screen !== 'quitting') return same(model);
      return next(model, {screen: 'connecting', app: null}, [{type: 'list', host: model.host}]);
    case 'failed':
      return fail(model, event.message, event.back ?? (model.host ? 'apps' : 'hosts'));
    case 'appGone':
      return next(model, {screen: 'stopped'}, [{type: 'exit'}]);
    default:
      return same(model);
  }
}

export {ITEM, APPS_PER_PAGE, HOSTS_PER_PAGE, makeModel, reduce};
