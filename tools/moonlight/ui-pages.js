/**
 * The console UI pages: one layout per screen of the state machine, as the items, text strips
 * and images ui-page.js serializes. Layout is the host's; the console only draws what it is
 * given, moves the cursor over the items and forwards presses with the item ids ui-model.js
 * assigns. Strips are painted once per text, size and width and kept.
 */
import {ITEM, APPS_PER_PAGE} from './ui-model.js';
import {PAGE_FLAG, ITEM_FLAG, MAX_ITEMS, MAX_TEXTS, MAX_IMAGES} from './ui-page.js';
import * as uiSettings from './ui-settings.js';

/** Colours as the page carries them: RGBA8 packed 0xAABBGGRR. */
const COLOR = {
  ink: 0xfff5eee2,
  muted: 0xffbeaf96,
  accent: 0xffddf66f,
  grey: 0xff82786e,
  background: 0xff3a250e,
  clear: 0x00000000
};
const COVER = {width: 160, height: 90};
const GRID = {x: 120, y: 200, columns: 5, cellWidth: 340, cellHeight: 190};
const TITLE = {x: 120, y: 56, size: 64};
const FOOTER = 1024;
const MAX_HOSTS = 20;
/** Strips kept across pages, by text, size, width and alignment. */
const CACHE_LIMIT = 512;

/**
 * @typedef {import('./ui-raster.js').Painted} Painted
 * @typedef {import('./ui-model.js').Model} Model
 * @typedef {import('./ui-page.js').Page} Page
 * @typedef {ReturnType<import('./ui-raster.js').createRaster>} Raster
 */

/**
 * @param {Raster} raster
 */
function createPages(raster) {
  /** @type {Map<string, Promise<Painted>>} */
  const strips = new Map();
  /** @type {Map<string, Promise<Painted>>} */
  const tiles = new Map();

  /** @param {Map<string, Promise<Painted>>} cache @param {string} key @param {() => Promise<Painted>} paint */
  function remember(cache, key, paint) {
    let painted = cache.get(key);
    if (!painted) {
      painted = paint();
      painted.catch(() => cache.delete(key));
      cache.set(key, painted);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    }
    return painted;
  }

  /**
   * A page under construction: text() and image() queue strips, build() awaits them all.
   * @param {Partial<Page>} header
   */
  function compose(header) {
    /** @type {Promise<Page['texts'][number]>[]} */
    const texts = [];
    /** @type {Promise<Page['images'][number]>[]} */
    const images = [];
    /** @type {Page['items']} */
    const items = [];
    const page = {
      /**
       * @param {number} x @param {number} y @param {string} label @param {number} size
       * @param {number} width @param {number} [color] @param {'left' | 'center' | 'right'} [align]
       */
      text(x, y, label, size, width, color = COLOR.ink, align = 'left') {
        const key = [label, size, width, align].join('\u0000');
        texts.push(
          remember(strips, key, () => raster.text(label, size, width, align)).then(strip => ({
            x,
            y,
            w: strip.width,
            h: strip.height,
            alpha: strip.bytes,
            color
          }))
        );
        return page;
      },
      /** @param {number} x @param {number} y @param {Promise<Painted>} tile */
      image(x, y, tile) {
        images.push(
          tile.then(painted => ({
            x,
            y,
            w: painted.width,
            h: painted.height,
            rgba: painted.bytes
          }))
        );
        return page;
      },
      /** @param {Page['items'][number]} item */
      item(item) {
        items.push(item);
        return page;
      },
      async build() {
        const built = {
          ...header,
          items,
          texts: await Promise.all(texts),
          images: await Promise.all(images)
        };
        if (built.items.length > MAX_ITEMS || built.texts.length > MAX_TEXTS)
          throw Error('UI page over the item or text limit');
        if (built.images.length > MAX_IMAGES) throw Error('UI page over the image limit');
        return built;
      }
    };
    return page;
  }

  /** @param {string} label @param {string} [hint] */
  function framed(label, hint) {
    const page = compose({background: COLOR.background, cursorHome: 0});
    page.text(TITLE.x, TITLE.y, label, TITLE.size, 1000, COLOR.accent);
    if (hint) page.text(TITLE.x, FOOTER, hint, 26, 1680, COLOR.muted);
    return page;
  }

  /**
   * A status page: a headline, a line under it, no cursor.
   * @param {string} title @param {string} headline @param {string | null} line @param {string} hint
   */
  function status(title, headline, line, hint) {
    const page = framed(title, hint);
    page.text(160, 400, headline, 48, 1600, COLOR.ink, 'center');
    if (line) page.text(160, 480, line, 32, 1600, COLOR.muted, 'center');
    return page.build().then(built => ({...built, flags: PAGE_FLAG.hideCursor}));
  }

  /** @param {Model} model */
  function hosts(model) {
    const page = framed('Moonlight', 'A  Open      X  Settings      Y  Refresh');
    const shown = model.hosts.slice(0, MAX_HOSTS);
    page.text(
      TITLE.x,
      140,
      shown.length ? 'Choose a PC' : 'No hosts yet: add one to hosts.json on the PC',
      28,
      1400,
      COLOR.muted
    );
    shown.forEach((host, i) => {
      const y = 220 + i * 84;
      page.item({id: ITEM.host + i, x: 100, y, w: 1720, h: 72});
      page.text(140, y + 14, host.name, 36, 900);
      page.text(1040, y + 22, host.address, 28, 740, COLOR.muted, 'right');
    });
    return page.build();
  }

  /**
   * @param {Model} model
   * @param {Map<number, Promise<Painted>>} covers Tiles by app id; apps without one get a letter tile.
   */
  function apps(model, covers) {
    const page = framed(
      'Moonlight',
      'A  Launch      B  Hosts      X  Settings      Y  Quit host app'
    );
    const host = model.host?.name ?? '';
    const start = model.appPage * APPS_PER_PAGE;
    const shown = model.apps.slice(start, start + APPS_PER_PAGE);
    const pages = Math.max(1, Math.ceil(model.apps.length / APPS_PER_PAGE));
    page.text(
      TITLE.x,
      140,
      `${host} · ${model.apps.length} apps` +
        (pages > 1 ? ` · page ${model.appPage + 1} of ${pages}` : ''),
      28,
      1400,
      COLOR.muted
    );
    shown.forEach((app, i) => {
      const x = GRID.x + (i % GRID.columns) * GRID.cellWidth,
        y = GRID.y + Math.floor(i / GRID.columns) * GRID.cellHeight;
      const current = app.id === model.currentGame;
      page.item({
        id: ITEM.app + start + i,
        x,
        y,
        w: GRID.cellWidth,
        h: GRID.cellHeight - 4,
        flags: current ? ITEM_FLAG.current : 0
      });
      const tile =
        covers.get(app.id) ??
        remember(tiles, app.name, () => raster.letters(app.name, COVER.width, COVER.height));
      page.image(x + (GRID.cellWidth - COVER.width) / 2, y + 14, tile);
      page.text(
        x + 10,
        y + 116,
        app.name,
        26,
        GRID.cellWidth - 20,
        current ? COLOR.accent : COLOR.ink,
        'center'
      );
    });
    const footer = GRID.y + 4 * GRID.cellHeight + 10;
    page.item({id: ITEM.back, x: 120, y: footer, w: 360, h: 56});
    page.text(140, footer + 10, 'Back to hosts', 30, 320);
    const first = model.appPage === 0,
      last = model.appPage >= pages - 1;
    page.item({
      id: ITEM.previous,
      x: 960,
      y: footer,
      w: 340,
      h: 56,
      flags: first ? ITEM_FLAG.greyed : 0
    });
    page.text(980, footer + 10, 'Previous page', 30, 300, first ? COLOR.grey : COLOR.ink);
    page.item({
      id: ITEM.next,
      x: 1340,
      y: footer,
      w: 340,
      h: 56,
      flags: last ? ITEM_FLAG.greyed : 0
    });
    page.text(1360, footer + 10, 'Next page', 30, 300, last ? COLOR.grey : COLOR.ink);
    return page.build();
  }

  /** @param {Model} model */
  function pairing(model) {
    const page = framed('Moonlight', 'B  Cancel');
    page.text(160, 240, model.host?.name ?? '', 40, 1600, COLOR.ink, 'center');
    if (model.pin) {
      page.text(160, 320, model.pin, 80, 1600, COLOR.accent, 'center');
      page.text(160, 460, model.url ?? '', 30, 1600, COLOR.muted, 'center');
      page.text(160, 540, 'Enter this PIN on the PC', 36, 1600, COLOR.ink, 'center');
    } else page.text(160, 400, 'Waiting for a PIN…', 36, 1600, COLOR.muted, 'center');
    return page.build().then(built => ({...built, flags: PAGE_FLAG.hideCursor}));
  }

  /** @param {Model} model */
  function settings(model) {
    const page = framed('Settings', '◀ ▶  Change      B  Back      Y  Reset to defaults');
    uiSettings.rows(model.settings).forEach((row, i) => {
      const y = 180 + i * 80;
      const flags =
        (row.adjustable ? ITEM_FLAG.adjustable : 0) | (row.greyed ? ITEM_FLAG.greyed : 0);
      const color = row.greyed ? COLOR.grey : COLOR.ink;
      page.item({id: ITEM.setting + i, x: 100, y, w: 1720, h: 68, flags});
      page.text(140, y + 14, row.label, 34, 1000, color);
      const value = row.adjustable
        ? `◀  ${row.value}  ▶`
        : row.greyed
          ? `${row.value} · not wired yet`
          : row.value;
      page.text(1100, y + 14, value, 34, 680, row.greyed ? COLOR.grey : COLOR.accent, 'right');
    });
    return page.build();
  }

  /** @param {Model} model */
  function quitConfirm(model) {
    const page = framed('Moonlight', 'A  Choose      B  Back');
    const running = model.apps.find(app => app.id === model.currentGame);
    page.text(
      160,
      360,
      `Quit ${running ? running.name : 'the running app'} on ${model.host?.name ?? ''}?`,
      40,
      1600,
      COLOR.ink,
      'center'
    );
    page.item({id: ITEM.confirmQuit, x: 760, y: 500, w: 400, h: 72});
    page.text(760, 514, 'Quit', 36, 400, COLOR.ink, 'center');
    page.item({id: ITEM.cancel, x: 760, y: 600, w: 400, h: 72});
    page.text(760, 614, 'Cancel', 36, 400, COLOR.ink, 'center');
    return page.build().then(built => ({...built, cursorHome: 1}));
  }

  /** @param {Model} model */
  function overlay(model) {
    const page = compose({background: COLOR.clear, cursorHome: 0, flags: PAGE_FLAG.overlay});
    page.text(160, 300, model.app?.name ?? 'Streaming', 40, 1600, COLOR.ink, 'center');
    page.item({id: ITEM.returnToApps, x: 660, y: 420, w: 600, h: 80});
    page.text(660, 438, 'Return to apps', 36, 600, COLOR.ink, 'center');
    page.item({id: ITEM.quitHost, x: 660, y: 540, w: 600, h: 80});
    page.text(660, 558, 'Quit host app', 36, 600, COLOR.ink, 'center');
    page.text(160, 700, 'B  Hide', 26, 1600, COLOR.muted, 'center');
    return page.build();
  }

  /** @param {Model} model */
  function error(model) {
    const page = framed('Moonlight', 'A  Back');
    page.text(160, 400, model.message ?? 'Something went wrong', 36, 1600, COLOR.ink, 'center');
    page.item({id: ITEM.back, x: 760, y: 540, w: 400, h: 72});
    page.text(760, 554, 'Back', 36, 400, COLOR.ink, 'center');
    return page.build();
  }

  return {
    /**
     * The page for the model's screen without its epoch and sequence, or null for the screens
     * the static atlas draws (splash, stopped) and for streaming without an overlay to show.
     * @param {Model} model
     * @param {Map<number, Promise<Painted>>} [covers]
     * @returns {Promise<Omit<Page, 'epoch' | 'sequence'> | null>}
     */
    page(model, covers = new Map()) {
      const host = model.host?.name ?? '';
      switch (model.screen) {
        case 'hosts':
          return hosts(model);
        case 'connecting':
          return status('Moonlight', host, 'Connecting…', 'B  Cancel');
        case 'pairing':
          return pairing(model);
        case 'apps':
          return apps(model, covers);
        case 'quitConfirm':
          return quitConfirm(model);
        case 'settings':
          return settings(model);
        case 'launching':
          return status(
            'Moonlight',
            model.app?.name ?? '',
            model.message ?? 'Starting the stream…',
            'B  Cancel'
          );
        case 'streaming':
          return overlay(model);
        case 'quitting':
          return status('Moonlight', host, 'Quitting the host app…', '');
        case 'error':
          return error(model);
        default:
          return Promise.resolve(null);
      }
    },
    /** A cover tile from a PNG the helper fetched, through the same cache as the letter tiles. */
    cover: (key, png) => remember(tiles, key, () => raster.tile(png, COVER.width, COVER.height))
  };
}

export {COLOR, COVER, GRID, createPages};
