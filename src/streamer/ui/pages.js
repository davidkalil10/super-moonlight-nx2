/**
 * The PC side of the page layouts in page-composer.js: the promise API service.js publishes
 * from, on Civ7 and the legacy route alike, with cover tiles painted from the helper's PNGs.
 */
import {ITEM, KEYS, APPS_PER_PAGE, HOSTS_PER_PAGE, isAddress} from './model.js';
import {createPageEncoder} from './page-encode.js';
import {createPageComposer} from './page-composer.js';
import {UI_PAGE_BYTES} from '../shared/ring.js';
import * as uiSettings from './settings.js';

/**
 * @typedef {import('./raster.js').Painted} Painted
 * @typedef {import('./model.js').Model} Model
 * @typedef {import('./page.js').Page} Page
 * @typedef {ReturnType<import('./raster.js').createRaster>} Raster
 */

/**
 * Which ways each value of a row steps, handheld and docked, as settings.js adjust() steps it.
 * @param {import('./settings.js').Setting} setting
 * @returns {import('./page-composer.js').SettingEnds}
 */
function settingEnds(setting) {
  /** @type {import('./page-composer.js').SettingEnds} */
  const ends = {handheld: {}, docked: {}};
  for (const value of setting.values) {
    const settings = {...uiSettings.defaults(), [setting.id]: value};
    const [handheld] = uiSettings.rows(settings, false).filter(entry => entry.id === setting.id);
    const [docked] = uiSettings.rows(settings, true).filter(entry => entry.id === setting.id);
    ends.handheld[JSON.stringify(value)] = [handheld.canLeft, handheld.canRight];
    ends.docked[JSON.stringify(value)] = [docked.canLeft, docked.canRight];
  }
  return ends;
}

/**
 * Every value text of the settings page, so the composer needs no catalog code: one text per row
 * value, the Auto bitrate text per size and rate, and the ends of every row.
 * @returns {import('./page-composer.js').SettingTexts}
 */
function settingTexts() {
  const rows = uiSettings.CATALOG.map(setting => {
    const [row] = uiSettings.rows(uiSettings.defaults()).filter(entry => entry.id === setting.id);
    /** @type {Record<string, string>} */
    const texts = {};
    for (const value of setting.values) {
      if (value === 'auto') continue;
      texts[JSON.stringify(value)] = setting.text(value, uiSettings.defaults());
    }
    return {id: setting.id, label: setting.label, adjustable: row.adjustable, greyed: row.greyed, texts,
      lockedSizes: setting.lockedSizes ?? [],
      ends: settingEnds(setting)};
  });

  /** @type {Record<string, string>} */
  const auto = {};
  /** @param {string} id */
  const catalog = id => {
    const setting = uiSettings.CATALOG.find(entry => entry.id === id);
    if (!setting) throw Error('No setting ' + id);
    return setting;
  };
  const bitrate = catalog('bitrate');
  /** @type {import('./page-composer.js').SettingTexts['handheld']} */
  const handheld = {};
  for (const size of catalog('size').values) {
    for (const fps of catalog('fps').values) {
      for (const codec of catalog('codec').values) {
        const settings = {...uiSettings.defaults(), size, fps, codec, bitrate: 'auto'};
        auto[size + '@' + fps + '@' + codec] = bitrate.text('auto', settings);
      }
      const saved = {...uiSettings.defaults(), size, fps};
      const used = uiSettings.inUse(saved, false);
      const texts = Object.fromEntries(uiSettings.rows(saved, false)
        .filter(row => row.id === 'size' || row.id === 'fps')
        .map(row => [row.id, row.value]));
      handheld[size + '@' + fps] = {size: used.size, fps: used.fps, texts};
    }
  }
  return {rows, auto, handheld};
}

/** What createPageComposer takes. */
function composerOptions() {
  const {LAYOUT} = createPageEncoder(UI_PAGE_BYTES);
  return {
    item: ITEM,
    keys: KEYS,
    isAddress,
    appsPerPage: APPS_PER_PAGE,
    hostsPerPage: HOSTS_PER_PAGE,
    settingTexts: settingTexts(),
    layout: {
      PAGE_FLAG: LAYOUT.PAGE_FLAG,
      ITEM_FLAG: LAYOUT.ITEM_FLAG,
      MAX_ITEMS: LAYOUT.MAX_ITEMS,
      MAX_TEXTS: LAYOUT.MAX_TEXTS,
      MAX_IMAGES: LAYOUT.MAX_IMAGES
    }
  };
}

const {COLOR, COVER, GRID} = createPageComposer(null, composerOptions());

/**
 * @param {Raster} raster
 */
function createPages(raster) {
  const composer = createPageComposer(raster, composerOptions());
  /** @type {Map<string, Promise<Painted>>} */
  const tiles = new Map();

  /**
   * The cover tile under `key`; a failed paint is dropped so the next page tries again.
   * @param {string} key @param {() => Promise<Painted>} paint
   */
  function remember(key, paint) {
    const cached = tiles.get(key);
    if (cached) return cached;

    const painted = paint();
    painted.catch(() => tiles.delete(key));
    tiles.set(key, painted);
    return painted;
  }

  return {
    /**
     * The page for the model's screen without its epoch and sequence, or null for the screens
     * the static atlas draws (splash, stopped).
     * @param {Model} model
     * @param {Map<number, Promise<Painted>>} [covers] Tiles by app id; a missing, failed or empty
     *   one gets a letter tile.
     * @returns {Promise<Omit<Page, 'epoch' | 'sequence'> | null>}
     */
    async page(model, covers = new Map()) {
      const resolved = new Map();
      for (const [id, tile] of covers) {
        const painted = await tile.catch(() => null);
        if (painted?.width) resolved.set(id, painted);
      }
      return composer.page(model, resolved);
    },

    /**
     * A short string that changes whenever the page's layout or pixels do: painted strips and
     * tiles are cached, so an unchanged page keeps its signature.
     * @param {Omit<Page, 'epoch' | 'sequence'>} built
     */
    signature: built => composer.signature(/** @type {import('./page-composer.js').ComposedPage} */ (built)),

    /**
     * A cover tile from a PNG the helper fetched, painted once per key.
     * @param {string} key @param {string} png
     */
    cover: (key, png) => remember(key, () => raster.tile(png, COVER.width, COVER.height))
  };
}

export {COLOR, COVER, GRID, composerOptions, createPages, settingTexts};
