import {createInput} from './input.js';
import {createPresenter} from './presentation.js';
import {streamVideo} from './stream.js';
import fs from 'node:fs';
import path from 'node:path';
import {createService, createChildren} from '../ui/service.js';
import {configDirectory, hostsFile, loadHosts, loadRemoved, saveHosts} from '../ui/hosts.js';
import {createPages} from '../ui/pages.js';
import {createRaster} from '../ui/raster.js';
import * as settings from '../ui/settings.js';
import {sessionBitrate} from './bitrate-adaptation.js';
import {createRemoteUi} from './console-ui.js';
import {runFrameRateSession} from './frame-rate.js';
import {createRefreshRate} from './refresh-rate.js';
import {BADGE_MS, BADGE_STAYS, badgeText, createQuadBadge, rateChangeText} from './rate-badge.js';
import {createStreamFallbacks, launchRate, sessionSize, shapeChanges} from './stream-fallback.js';
import {createOperationModeReader} from './operation-mode.js';
import {createDockMonitor, runDockSession} from './dock-switch.js';
import {createHostDisplay} from './host-display.js';
import {createRenderMode} from './render-mode.js';
import {fitLayer} from './layer-size.js';
import {DEFAULT_SIZE} from './display.js';

/** @import {Civ7Rpc} from './transport.js' */
/** @import {Host} from '../ui/model.js' */
/** @import {PresenterMenu, PresenterApp} from './presentation.js' */

/** The parts of prepareMoonlight's menu and GPU state this module and the presenter read. */
/** @typedef {PresenterMenu & {controls: {mapped: number}}} Menu */
/**
 * @typedef {PresenterApp & {privateStorage: {memory: string, mapped: number, bytes: number,
 *   memoryFlags: number}}} Gpu
 */

/** @param {unknown} error */
const errorText = error => error instanceof Error ? error.message : String(error);

/**
 * `args` with `--codec` set to `codec`.
 * @param {string[]} args
 * @param {string} codec
 */
function withCodec(args, codec) {
  const at = args.indexOf('--codec');
  if (at < 0) return [...args, '--codec', codec];

  return args.map((arg, index) => index === at + 1 ? codec : arg);
}

/**
 * The size and requested rate of a launch's stream arguments, and the bitrate of a session at
 * the rate and codec it actually runs: Auto is resolved again for each session, a 120 to 60
 * fallback, an AV1 to H.264 fallback and the adaptation scale included.
 * @param {string[]} args
 */
export function streamShape(args) {
  /** @param {string} name @param {string} fallback */
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const [width, height] = option('--size', '1920x1080').split('x').map(Number);
  const fps = Number(option('--fps', '60'));
  const undockedFps = Number(option('--undocked-fps', String(fps)));
  const codec = /** @type {'h264' | 'av1'} */ (option('--codec', 'h264') === 'av1' ? 'av1' : 'h264');
  const buttons = /** @type {'position' | 'labels'} */ (option('--buttons', '') === 'labels' ? 'labels' : 'position');
  const helperArgs = ['--local-audio', '--sops'].filter(flag => args.includes(flag));
  const streamInfo = args.includes('--stream-info');
  const frameCounter = args.includes('--frame-counter');
  const launched = option('--transport', '');
  /** @type {'tcp' | 'udp' | undefined} */
  let transport;
  if (launched) transport = launched === 'udp' ? 'udp' : 'tcp';

  /**
   * @param {number} sessionFps @param {'h264' | 'av1'} [sessionCodec]
   * @param {{width: number, height: number}} [size] the session's, when it falls back below the launch's
   */
  const bitrate = (sessionFps, sessionCodec = codec, size = {width, height}) =>
    sessionBitrate(withCodec(args, sessionCodec), size.width, size.height, sessionFps);
  return {width, height, fps, undockedFps, codec, transport, bitrate, buttons, helperArgs, streamInfo,
    frameCounter};
}

/**
 * The stream info badge text of one session: "1080p120 · AV1 · UDP · 30 Mbps".
 * @param {{height: number, fps: number, codec: string, transport: string, bitrate: number}} session
 */
export function streamInfoText({height, fps, codec, transport, bitrate}) {
  const codecName = codec === 'av1' ? 'AV1' : 'H.264';
  const mbps = Math.round(bitrate / 100) / 10;
  return [`${height}p${fps}`, codecName, transport.toUpperCase(), mbps + ' Mbps'].join(' · ');
}

/**
 * The saved host list: hosts.json once it exists, the bundle's hosts until then, so a list the
 * user emptied stays empty.
 * @param {Host[]} seed
 * @param {string} [file]
 */
export function hostStore(seed, file = hostsFile()) {
  const read = () => fs.existsSync(file) ? loadHosts(file) : seed;
  return {
    read,
    /** @param {Host[]} hosts */
    write: hosts => saveHosts(file, hosts),
    readRemoved: () => loadRemoved(file),
    /** @param {import('../ui/hosts.js').RemovedHost[]} removed */
    writeRemoved: removed => saveHosts(file, read(), removed)
  };
}

/** Frames wait for the first published page, or this long if none comes. */
const FIRST_PAGE_TIMEOUT_MS = 5000;

/**
 * Runs every cleanup step even when an earlier one fails, then throws the first failure.
 * @param {(() => unknown)[]} steps
 */
export async function closeInOrder(steps) {
  /** @type {unknown} */
  let failure = null;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure) throw failure;
}

/**
 * Holds Moonlight's first present until the service publishes a page, so the launcher's black
 * frame stays up until the menu; `timeoutMs` bounds the wait if no page comes.
 * @param {(event: Record<string, unknown>) => void} log
 * @param {number} [timeoutMs]
 */
export function firstPageGate(log, timeoutMs = FIRST_PAGE_TIMEOUT_MS) {
  /** @type {(value?: unknown) => void} */
  let open = () => {};
  const opened = new Promise(resolve => { open = resolve; });
  const timer = setTimeout(() => open(), timeoutMs);

  return {
    opened,
    /** @param {Record<string, unknown>} event */
    log(event) {
      if (event.event === 'published') open();
      log(event);
    },
    close() {
      open();
      clearTimeout(timer);
    }
  };
}

/**
 * Writes a stream event to the run log once, then hands it to the service on the `logged`
 * channel, which drives the model from it without logging it again.
 * @param {object} event
 * @param {(event: object) => void} log
 * @param {(channel: string, line: string) => void} onLine
 */
export function forwardStreamEvent(event, log, onLine) {
  log(event);

  const helperConnected = 'event' in event && event.event === 'connected';
  if ('type' in event && event.type === 'video-connected') onLine('logged', '{"event":"connected"}');
  else if (helperConnected) onLine('logged', '{"event":"video-starting"}');
  else onLine('logged', JSON.stringify(event));
}

/**
 * The Moonlight menu and its streams on one attached console, until the service stops.
 * @param {{rpc: Civ7Rpc, directory: string, menu: Menu, gpu: Gpu, hostAddress: string, helper: string,
 *   hosts: Host[], signal?: AbortSignal, raster?: ReturnType<typeof createRaster>,
 *   lostHost?: Host | null, onStream?: (host: Host | null) => void, transport?: 'tcp' | 'udp',
 *   layer?: {width: number, height: number}, log?: (event: object) => void,
 *   mark?: (name: string) => void}} options
 *   `lostHost` is the PC whose stream the console link dropped last launch; `onStream` hears
 *   each stream's PC as it starts and null as it ends;
 *   `transport` is the bundle's video transport; a launch's `--transport` (the Settings row)
 *   overrides it; `layer` is the open layer's size, which no stream exceeds; `mark` takes
 *   startup-timing.js marks
 */
export async function runApplication({rpc, directory, menu, gpu, hostAddress, helper,
  hosts, signal = undefined, raster: sharedRaster = undefined, lostHost = null,
  onStream = host => {}, transport = 'udp', layer = DEFAULT_SIZE, log = event => {}, mark = name => {}}) {
  /** @type {Awaited<ReturnType<typeof createPresenter>> | undefined} */
  let presenter;
  /** @type {Awaited<ReturnType<typeof createInput>> | undefined} */
  let input;
  /** @type {Awaited<ReturnType<typeof createRemoteUi>> | undefined} */
  let machine;
  let raster = sharedRaster;
  const children = createChildren({helperPath: helper});
  const settingsFile = settings.settingsFile();
  const savedHosts = hostStore(hosts);
  /** @type {ReturnType<typeof createService> | undefined} */
  let service;
  let streaming = false;
  let running = true;
  /** @type {Promise<unknown>} */
  let rendering = Promise.resolve();
  let streamDone = Promise.resolve();
  let renderLoop = Promise.resolve();
  let active = true;
  /** @type {Error | undefined} */
  let connectionError;
  const firstPage = firstPageGate(log);
  /** @type {ReturnType<typeof createRefreshRate> | undefined} */
  let refreshRate;
  /** @type {ReturnType<typeof createDockMonitor> | undefined} */
  let dockMonitor;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let dockTimer;
  const stop = () => {
    running = false;
    firstPage.close();
    return service?.stop().catch(error => log({event: 'stop-failed', message: errorText(error)}));
  };
  rpc.disconnected?.then(error => {
    if (!active) return;
    connectionError = error;
    log({event: 'connection-lost', message: errorText(error)});
    stop();
  });
  try {
    const ui = {
      presenter: presenter = await createPresenter(rpc, directory, menu, gpu, {size: layer}),
      input: input = await createInput(rpc, menu.controls.mapped),
      raster: raster ??= createRaster()
    };
    mark('presenter-input');
    const remote = machine = await createRemoteUi(rpc, gpu.privateStorage.mapped, savedHosts.read(),
      settings.load(settingsFile));
    mark('remote-ui');
    const display = refreshRate = createRefreshRate(rpc, {directory, log, present: async () => {
      await firstPage.opened;
      return (await ui.presenter.run(3, ui.input.configuration)).frames;
    }});
    display.cleanup();
    const renderMode = createRenderMode({rpc, storage: gpu.privateStorage.mapped, layer,
      presenter: ui.presenter, refresh: display, input: ui.input.configuration, log});
    const readMode = await createOperationModeReader(rpc);
    const docked = (await readMode()).docked;
    if (docked) remote.initial = await remote.dispatch({type: 'operationMode', docked});
    if (lostHost) remote.initial = await remote.dispatch({type: 'connectionLost', host: lostHost});
    const monitor = dockMonitor = createDockMonitor({initial: docked, read: readMode, log,
      changed: docked => {
        service?.dispatch({type: 'operationMode', docked})
          .catch(error => log({event: 'dispatch-failed', message: errorText(error)}));
      }});
    children.stream = (runDirectory, host, app, args, onLine) => {
      streaming = true;
      onStream(host);
      renderMode.invalidate();
      const abort = new AbortController();
      const {width, height, fps: requestedFps, undockedFps, codec, bitrate, transport: launched, buttons, helperArgs,
        streamInfo, frameCounter} = streamShape(args);
      let choice = {codec, transport: launched ?? transport};
      /** @type {ReturnType<typeof createQuadBadge> | undefined} */
      let shownBadge;
      /** @param {object} event */
      const streamLog = event => {
        forwardStreamEvent(event, log, onLine);
        void shownBadge?.observe(event);
        if ('type' in event && event.type === 'stop-chord') abort.abort(Error('Stream stopped'));
      };
      /** @param {string[]} changes */
      const badgeFor = changes => {
        if (!changes.length && !frameCounter) return shownBadge = undefined;

        const durationMs = streamInfo || frameCounter ? BADGE_STAYS : BADGE_MS;
        return shownBadge = createQuadBadge(rpc, {text: badgeText(changes), raster: ui.raster,
          storage: gpu.privateStorage, durationMs, counter: frameCounter, log});
      };
      const exited = (async () => {
        /** @type {ReturnType<typeof createHostDisplay>} */
        let hostDisplay = null;
        try {
          if (helperArgs.includes('--sops')) hostDisplay = createHostDisplay(host.address, {log});
          await rendering;
          await monitor.poll();
          const result = await runDockSession({monitor, signal: abort.signal, log,
            run: async (dockedAtLaunch, signal) => {
              await renderMode.apply(dockedAtLaunch);
              signal.throwIfAborted();
              const fallbacks = createStreamFallbacks(choice,
                {signal, log: streamLog});
              /** @param {'h264' | 'av1'} sessionCodec */
              const shown = sessionCodec => fitLayer(sessionSize({width, height}, {docked: dockedAtLaunch,
                codec: sessionCodec}), layer);
              const launchSize = shown(choice.codec);
              if (launchSize.fallback) forwardStreamEvent(launchSize.fallback, log, onLine);
              const fps = dockedAtLaunch ? requestedFps : undockedFps;
              const launchFps = launchRate({...launchSize.size, fps, codec: choice.codec}, dockedAtLaunch);
              void hostDisplay?.apply({...launchSize.size, fps: launchFps}).catch(() => {});
              if (launchFps <= 60) await display.set(60);
              try {
                return await runFrameRateSession({fps: launchFps,
                  measure: () => ui.presenter.run(24, ui.input.configuration),
                  signal, log,
                  display: {raise: async fps => (await display.set(fps)).ok, restore: display.restore,
                    measured: display.measured},
                  run: (fps, change) => fallbacks.run(async (choice, notes) => {
                    const {size} = shown(choice.codec);
                    const kbps = bitrate(fps, choice.codec, size);
                    await hostDisplay?.apply({...size, fps});
                    signal.throwIfAborted();
                    const rate = change
                      ? [rateChangeText({height: size.height, fps: change.from}, {height: size.height, fps: change.to})] : [];
                    return streamVideo({rpc, directory, hostAddress, host: host.address, app: String(app.id), helper,
                      helperArgs, buttons, width: size.width, height: size.height, codec: choice.codec,
                      transport: choice.transport, fps, bitrate: kbps,
                      badge: badgeFor([
                        ...shapeChanges({height, fps: requestedFps}, {height: size.height, fps: launchFps}),
                        ...rate,
                        ...notes,
                        ...(streamInfo ? [streamInfoText({height: size.height, fps, codec: choice.codec,
                          transport: choice.transport, bitrate: kbps})] : [])]),
                      duration: null, signal, controls: menu.controls.mapped,
                      presentation: {configuration: ui.presenter.configuration, storage: gpu.privateStorage},
                      log: streamLog});
                  })});
              } finally { choice = fallbacks.current(); }
            }});
          log({event: 'stream-result', ...result});
          return {code: 0, signal: null, out: '', err: ''};
        } catch (error) {
          if (abort.signal.aborted) return {code: 0, signal: null, out: '', err: ''};
          log({event: 'stream-failed', message: errorText(error)});
          return {code: 1, signal: null, out: '', err: errorText(error)};
        } finally {
          try { await hostDisplay?.restore(); }
          catch (error) { log({event: 'host-display-restore-failed', message: errorText(error)}); }
          renderMode.invalidate();
          streaming = false;
          onStream(null);
        }
      })();
      streamDone = exited.then(() => {});
      return {exited, cancel: () => { abort.abort(); return true; }};
    };
    const menuService = service = createService({memory: rpc, mapped: gpu.privateStorage.mapped,
      pages: createPages(ui.raster), children, directory, readHosts: savedHosts.read,
      writeHosts: savedHosts.write, readRemoved: savedHosts.readRemoved,
      writeRemoved: savedHosts.writeRemoved, coversDir: path.join(configDirectory(), 'covers'),
      saveSettings: () => {}, machine: remote, log: firstPage.log});
    dockTimer = setInterval(() => { void monitor.poll(); }, 500);
    signal?.addEventListener('abort', stop, {once: true});
    renderLoop = (async () => {
      await firstPage.opened;
      while (running) {
        if (streaming) {
          await new Promise(resolve => setTimeout(resolve, 10));
          continue;
        }
        const menuDocked = monitor.current();
        rendering = (async () => {
          await renderMode.menu(menuDocked, () => monitor.current() !== menuDocked);
          return ui.presenter.run(3, ui.input.configuration);
        })();
        await rendering;
      }
    })();
    renderLoop.catch(stop);
    if (signal?.aborted) stop();
    await menuService.start();
    if (connectionError) throw connectionError;
  } finally {
    active = false;
    running = false;
    firstPage.close();
    signal?.removeEventListener('abort', stop);
    clearInterval(dockTimer);
    await closeInOrder([
      () => dockMonitor?.close(),
      () => service?.stop(),
      () => streamDone,
      () => {
        running = false;
        return renderLoop;
      },
      () => sharedRaster ? undefined : raster?.close(),
      () => machine?.close(),
      () => refreshRate?.close(),
      () => input?.close(),
      () => presenter?.close()
    ]);
  }
}
