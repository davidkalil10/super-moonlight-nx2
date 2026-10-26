/**
 * The console UI pages: one layout per screen of the state machine, as the items, text strips
 * and images ui-page.js serializes. Layout is the host's; the console only draws what it is
 * given, moves the cursor over the items and forwards presses with the item ids ui-model.js
 * assigns. Strips are painted once per text, size and width and kept.
 */
import {ITEM, APPS_PER_PAGE, HOSTS_PER_PAGE} from './ui-model.js';
import {PAGE_FLAG, ITEM_FLAG, MAX_ITEMS, MAX_TEXTS, MAX_IMAGES} from './ui-page.js';
import * as uiSettings from './ui-settings.js';

/** The Horizon palette as the page carries it: RGBA8 packed 0xAABBGGRR. */
const COLOR = {
  ink: 0xfff9fafa,
  soft: 0xffd1d3d6,
  muted: 0xff9ea2a8,
  grey: 0xff6c7178,
  accent: 0xfff8bd38,
  running: 0xffacef86,
  card: 0xff242529,
  dim: 0xff1d1f23,
  slot: 0xff3c4044,
  background: 0xff17191c,
  clear: 0x00000000
};
const COVER = {width: 240, height: 135};
/** Two rows of five covers, centred, a name under each. */
const GRID = {y: 380, columns: 5, gap: 48, name: 16, row: 135 + 16 + 34 + 24};
const SIDE = 96;
const CHIP = {y: 64, height: 54, pad: 10, size: 26};
const LEGEND = {y: 984, size: 26, height: 40};
const CARDS = {y: 300, width: 840, height: 96, gapX: 48, gapY: 32, pad: 32};
const LABEL = {size: 22, tracking: 22 * 0.08};
const HEADING = {y: 200, status: 340, kicker: 24, size: 72};
const BUTTON = {y: 640, width: 400, gap: 48};
const PAGER = {width: 300};
/** The tag on the cover of the app the PC is running. */
const RUNNING = {width: 112, height: 30};
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
    /** @param {number} x @param {number} y @param {number} color @param {() => Promise<Painted>} paint */
    function strip(x, y, color, paint) {
      texts.push(
        paint().then(painted => ({
          x,
          y,
          w: painted.width,
          h: painted.height,
          alpha: painted.bytes,
          color
        }))
      );
      return page;
    }
    const page = {
      /**
       * @param {number} x @param {number} y @param {string} label @param {number} size
       * @param {number} width @param {number} [color] @param {'left' | 'center' | 'right'} [align]
       * @param {{weight?: number, tracking?: number}} [style]
       */
      text(x, y, label, size, width, color = COLOR.ink, align = 'left', style = {}) {
        const {weight = 600, tracking = 0} = style;
        const key = [label, size, width, align, weight, tracking].join('\u0000');
        return strip(x, y, color, () =>
          remember(strips, key, () => raster.text(label, size, width, align, {weight, tracking}))
        );
      },
      /** A filled rectangle under the strips queued after it. */
      solid(x, y, w, h, color) {
        return strip(x, y, color, () =>
          remember(strips, ['\u0001solid', w, h].join('\u0000'), () =>
            Promise.resolve({width: w, height: h, bytes: Buffer.alloc(w * h, 255)})
          )
        );
      },
      /** Button hints, each key in a ring. @param {[string, string][]} keys */
      legend(x, y, keys, color = COLOR.soft) {
        const key = ['\u0001legend', JSON.stringify(keys)].join('\u0000');
        return strip(x, y, color, () =>
          remember(strips, key, () => raster.legend(keys, LEGEND.size, 1200))
        );
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

  /**
   * The Horizon frame: chips top left, a note top right, button hints and a footer at the bottom.
   * @param {{chips?: [string | undefined, number, number][], note?: string,
   *   keys?: [string, string][], footer?: string, background?: number, cursorHome?: number,
   *   flags?: number}} frame
   */
  function horizon({
    chips = [],
    note = '',
    keys = [],
    footer = '',
    background = COLOR.background,
    cursorHome = 0,
    flags = 0
  }) {
    const page = compose({background, cursorHome, ...(flags && {flags})});
    let x = SIDE;
    for (const [label, color, width] of chips) {
      if (!label) continue;
      page.solid(x, CHIP.y, width, CHIP.height, COLOR.card);
      page.text(x, CHIP.y + CHIP.pad, label, CHIP.size, width, color, 'center');
      x += width + 16;
    }
    if (note) page.text(1920 - SIDE - 700, CHIP.y + CHIP.pad, note, 26, 700, COLOR.muted, 'right');
    if (keys.length) page.legend(SIDE, LEGEND.y, keys);
    if (footer)
      page.text(1920 - SIDE - 700, LEGEND.y + 5, footer, 24, 700, COLOR.grey, 'right', {
        weight: 500
      });
    return page;
  }

  /** @param {Model} model @returns {[string | undefined, number, number][]} */
  function hostChips(model) {
    return [
      [model.host?.name, COLOR.ink, 300],
      [model.host?.address, COLOR.muted, 300]
    ];
  }

  /**
   * A kicker in the accent, a big title and a line under it, left aligned.
   * @param {ReturnType<typeof compose>} page @param {string} kicker @param {string} title
   * @param {string | null} line
   * @param {{y?: number, size?: number, color?: number, tracking?: number}} [style]
   */
  function heading(page, kicker, title, line, style = {}) {
    const {y = HEADING.y, size = HEADING.size, color = COLOR.ink, tracking = 0} = style;
    const width = 1920 - 2 * SIDE;
    page.text(SIDE, y, kicker.toUpperCase(), HEADING.kicker, width, COLOR.accent, 'left', {
      tracking: HEADING.kicker * 0.1
    });
    page.text(SIDE, y + 44, title, size, width, color, 'left', {weight: 700, tracking});
    if (line) page.text(SIDE, y + 148, line, 28, width, COLOR.muted, 'left', {weight: 500});
  }

  /**
   * A card the cursor can land on, its label centred.
   * @param {ReturnType<typeof compose>} page @param {number} id @param {number} x @param {number} y
   * @param {number} width @param {string} label @param {boolean} [greyed]
   */
  function button(page, id, x, y, width, label, greyed = false) {
    page.item({id, x, y, w: width, h: CARDS.height, flags: greyed ? ITEM_FLAG.greyed : 0});
    page.solid(x, y, width, CARDS.height, greyed ? COLOR.dim : COLOR.card);
    page.text(x, y + 28, label, 32, width, greyed ? COLOR.grey : COLOR.ink, 'center', {
      weight: 700
    });
  }

  /**
   * Previous and next page buttons at the bottom right, greyed at either end.
   * @param {ReturnType<typeof compose>} page @param {number} y @param {number} at
   * @param {number} count
   */
  function pager(page, y, at, count) {
    const x = 1920 - SIDE - 2 * PAGER.width - BUTTON.gap;
    button(page, ITEM.previous, x, y, PAGER.width, '‹  Previous', at === 0);
    button(
      page,
      ITEM.next,
      x + PAGER.width + BUTTON.gap,
      y,
      PAGER.width,
      'Next  ›',
      at >= count - 1
    );
  }

  /**
   * A status page: no cursor, the heading says what is happening.
   * @param {Model} model @param {string} kicker @param {string} title @param {string | null} line
   * @param {[string, string][]} keys
   */
  function status(model, kicker, title, line, keys) {
    const page = horizon({chips: hostChips(model), keys, flags: PAGE_FLAG.hideCursor});
    heading(page, kicker, title, line, {y: HEADING.status});
    return page.build();
  }

  /** @param {Model} model */
  function hosts(model) {
    const count = Math.max(1, Math.ceil(model.hosts.length / HOSTS_PER_PAGE));
    const start = model.hostPage * HOSTS_PER_PAGE;
    const shown = model.hosts.slice(start, start + HOSTS_PER_PAGE);
    const slot = model.hostIndex - start;
    const page = horizon({
      chips: [['Moonlight', COLOR.ink, 240]],
      note: count > 1 ? `Page ${model.hostPage + 1} of ${count}` : '',
      keys: [
        ['A', 'Open'],
        ['X', 'Settings'],
        ['Y', 'Refresh']
      ],
      cursorHome: slot >= 0 && slot < shown.length ? slot : 0
    });
    if (!shown.length)
      heading(page, 'No PCs yet', 'Add a PC to hosts.json', 'The service reads it on this PC');
    else
      heading(
        page,
        'Moonlight',
        'Choose a PC',
        `${model.hosts.length} ${model.hosts.length === 1 ? 'PC' : 'PCs'} in hosts.json`
      );
    shown.forEach((host, i) => {
      const x = SIDE + (i % 2) * (CARDS.width + CARDS.gapX),
        y = 430 + Math.floor(i / 2) * (CARDS.height + CARDS.gapY),
        inner = CARDS.width - 2 * CARDS.pad;
      page.item({id: ITEM.host + start + i, x, y, w: CARDS.width, h: CARDS.height});
      page.solid(x, y, CARDS.width, CARDS.height, COLOR.card);
      page.text(x + CARDS.pad, y + 12, host.name, 36, inner, COLOR.ink, 'left', {weight: 700});
      page.text(x + CARDS.pad, y + 60, host.address, 24, inner, COLOR.muted, 'left', {
        weight: 500
      });
    });
    if (count > 1) pager(page, 430 + 3 * (CARDS.height + CARDS.gapY), model.hostPage, count);
    return page.build();
  }

  /**
   * The host name over two rows of five covers; covers keep their apps' ids across pages.
   * @param {Model} model
   * @param {Map<number, Promise<Painted>>} covers Tiles by app id; apps without one get a letter tile.
   */
  function apps(model, covers) {
    const count = Math.max(1, Math.ceil(model.apps.length / APPS_PER_PAGE));
    const start = model.appPage * APPS_PER_PAGE;
    const shown = model.apps.slice(start, start + APPS_PER_PAGE);
    const shape = uiSettings
      .rows(model.settings)
      .filter(row => ['size', 'fps', 'bitrate'].includes(row.id))
      .map(row => row.value)
      .join(' · ');
    const slot = model.appIndex - start;
    const page = horizon({
      chips: hostChips(model),
      note: shape,
      cursorHome: slot >= 0 && slot < shown.length ? slot : 0,
      keys: [
        ['A', 'Launch'],
        ['B', 'PCs'],
        ['X', 'Settings'],
        ['Y', 'Quit host app']
      ]
    });
    const line = [
      model.message,
      `${model.apps.length} ${model.apps.length === 1 ? 'app' : 'apps'}`,
      count > 1 ? `page ${model.appPage + 1} of ${count}` : '',
      'Press A to launch'
    ]
      .filter(Boolean)
      .join(' · ');
    heading(page, 'Apps', model.host?.name ?? 'Moonlight', line, {y: 150});
    const left = (1920 - GRID.columns * COVER.width - (GRID.columns - 1) * GRID.gap) / 2;
    shown.forEach((app, i) => {
      const x = left + (i % GRID.columns) * (COVER.width + GRID.gap),
        y = GRID.y + Math.floor(i / GRID.columns) * GRID.row;
      const current = app.id === model.currentGame;
      page.item({
        id: ITEM.app + start + i,
        x,
        y,
        w: COVER.width,
        h: COVER.height,
        flags: current ? ITEM_FLAG.current : 0
      });
      const letters = () =>
        remember(tiles, app.name, () => raster.letters(app.name, COVER.width, COVER.height));
      const tile = covers.has(app.id)
        ? covers.get(app.id).then(painted => (painted.width ? painted : letters()), letters)
        : letters();
      page.image(x, y, tile);
      if (current) {
        page.solid(x + 8, y + 8, RUNNING.width, RUNNING.height, COLOR.running);
        page.text(x + 8, y + 13, 'RUNNING', 18, RUNNING.width, COLOR.background, 'center', {
          weight: 700,
          tracking: 1.2
        });
      }
      const nameY = y + COVER.height + GRID.name;
      page.text(x, nameY, app.name, 26, COVER.width, current ? COLOR.running : COLOR.ink, 'center');
    });
    const buttons = GRID.y + 2 * GRID.row + 8;
    button(page, ITEM.back, SIDE, buttons, PAGER.width, '‹  PCs');
    if (count > 1) pager(page, buttons, model.appPage, count);
    return page.build();
  }

  /** @param {Model} model */
  function pairing(model) {
    const page = horizon({
      chips: hostChips(model),
      keys: [['B', 'Cancel']],
      flags: PAGE_FLAG.hideCursor
    });
    if (model.pin) {
      heading(page, 'Pairing', model.pin, 'Enter this PIN on the PC', {
        y: HEADING.status,
        color: COLOR.accent,
        tracking: HEADING.size * 0.2
      });
      if (model.url)
        page.text(SIDE, HEADING.status + 196, model.url, 26, 1920 - 2 * SIDE, COLOR.grey, 'left', {
          weight: 500
        });
    } else
      heading(page, 'Pairing', 'Waiting for a PIN…', 'The PC is starting the pairing', {
        y: HEADING.status,
        size: 56
      });
    return page.build();
  }

  /** @param {Model} model */
  function settings(model) {
    const page = horizon({
      chips: [
        [model.host?.name, COLOR.ink, 300],
        ['Settings', COLOR.muted, 180]
      ],
      note: 'Applies to the next launch',
      keys: [
        ['◂▸', 'Change'],
        ['B', 'Back'],
        ['Y', 'Reset']
      ],
      footer: '1080p60 is the reference shape'
    });
    uiSettings.rows(model.settings).forEach((row, i) => {
      const x = SIDE + (i % 2) * (CARDS.width + CARDS.gapX),
        y = CARDS.y + Math.floor(i / 2) * (CARDS.height + CARDS.gapY),
        inner = CARDS.width - 2 * CARDS.pad;
      const flags =
        (row.adjustable ? ITEM_FLAG.adjustable : 0) | (row.greyed ? ITEM_FLAG.greyed : 0);
      page.item({id: ITEM.setting + i, x, y, w: CARDS.width, h: CARDS.height, flags});
      page.solid(x, y, CARDS.width, CARDS.height, row.greyed ? COLOR.dim : COLOR.card);
      page.text(
        x + CARDS.pad,
        y + 12,
        row.label.toUpperCase(),
        LABEL.size,
        inner,
        row.greyed ? COLOR.grey : COLOR.muted,
        'left',
        {tracking: LABEL.tracking}
      );
      if (row.greyed) {
        page.text(x + CARDS.pad, y + 46, 'Not available yet', 28, inner, COLOR.grey);
        return;
      }
      if (row.adjustable) {
        page.text(x + CARDS.pad, y + 40, '‹', 40, 40, COLOR.grey, 'left', {weight: 700});
        page.text(x + CARDS.pad + inner - 40, y + 40, '›', 40, 40, COLOR.grey, 'right', {
          weight: 700
        });
      }
      page.text(x + CARDS.pad + 48, y + 40, row.value, 40, inner - 96, COLOR.ink, 'center', {
        weight: 700
      });
    });
    return page.build();
  }

  /** @param {Model} model */
  function quitConfirm(model) {
    const page = horizon({
      chips: hostChips(model),
      keys: [
        ['A', 'Choose'],
        ['B', 'Back']
      ],
      cursorHome: 1
    });
    const running = model.apps.find(app => app.id === model.currentGame)?.name ?? 'the running app';
    heading(
      page,
      'Quit host app',
      `Quit ${running}?`,
      `The stream ends and the app closes on the PC`,
      {
        y: HEADING.status
      }
    );
    button(page, ITEM.confirmQuit, SIDE, BUTTON.y, BUTTON.width, 'Quit');
    button(page, ITEM.cancel, SIDE + BUTTON.width + BUTTON.gap, BUTTON.y, BUTTON.width, 'Cancel');
    return page.build();
  }

  /** @param {Model} model */
  function overlay(model) {
    const page = horizon({
      background: COLOR.clear,
      flags: PAGE_FLAG.overlay,
      keys: [
        ['A', 'Choose'],
        ['B', 'Hide']
      ]
    });
    heading(page, 'Streaming', model.app?.name ?? 'Moonlight', model.host?.name ?? null, {
      y: HEADING.status
    });
    button(page, ITEM.returnToApps, SIDE, BUTTON.y, 520, 'Return to apps');
    button(page, ITEM.quitHost, SIDE + 520 + BUTTON.gap, BUTTON.y, 520, 'Quit host app');
    return page.build();
  }

  /** @param {Model} model */
  function error(model) {
    const page = horizon({chips: hostChips(model), keys: [['A', 'Back']]});
    heading(page, 'Something went wrong', model.message ?? 'Something went wrong', null, {
      y: HEADING.status,
      size: 48
    });
    button(page, ITEM.back, SIDE, BUTTON.y, BUTTON.width, 'Back');
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
          return status(model, 'Connecting', host, model.host?.address ?? null, [['B', 'Cancel']]);
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
            model,
            'Launching',
            model.app?.name ?? '',
            model.message ?? 'Starting the stream…',
            [['B', 'Cancel']]
          );
        case 'streaming':
          return overlay(model);
        case 'quitting':
          return status(model, 'Quitting', host, 'Closing the app on the PC…', []);
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
