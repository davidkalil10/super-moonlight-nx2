/**
 * The console UI pages: one layout per screen of the state machine, as the items, text strips
 * and images page-encode.js writes. Runs on the console (shipped by toString()) and on the PC
 * for the legacy service, so it uses only what it is given.
 */

/**
 * @import {Item, Text, Image} from './page-encode.js'
 * @import {Model, App} from './model.js'
 * @typedef {{width: number, height: number, bytes: Uint8Array}} Bitmap
 * @typedef {Bitmap & {left: number, top: number}} Trimmed A bitmap cut to its ink and where
 *   the cut starts in the painted one.
 * @typedef {'left' | 'center' | 'right'} Align
 * @typedef {{weight?: number, tracking?: number, cursorItem?: number}} TextStyle `cursorItem`: shown
 *   only while the cursor is on that item, by the shader, so a cursor move publishes nothing
 * @typedef {{text: (text: string, size: number, width: number, align?: Align,
 *   style?: TextStyle) => Bitmap,
 *   legend: (keys: [string, string][], size: number, width: number) => Bitmap,
 *   letters: (text: string, width: number, height: number) => Bitmap}} Painter
 * @typedef {{handheld: Record<string, [boolean, boolean]>, docked: Record<string, [boolean, boolean]>}} SettingEnds
 *   Per JSON value, whether a step left and right changes it, in each operation mode.
 * @typedef {{id: string, label: string, adjustable: boolean, greyed: boolean,
 *   texts: Record<string, string>, ends: SettingEnds, lockedSizes?: string[]}} SettingText
 * @typedef {{rows: SettingText[], auto: Record<string, string>,
 *   handheld: Record<string, {size: string, fps: number, texts: Record<string, string>}>}} SettingTexts
 * @typedef {{item: Record<string, number>, keys: string, isAddress: (entry: string) => boolean,
 *   appsPerPage: number, hostsPerPage: number, settingTexts: SettingTexts, layout: {PAGE_FLAG: Record<string, number>,
 *   ITEM_FLAG: Record<string, number>, MAX_ITEMS: number, MAX_TEXTS: number, MAX_IMAGES: number},
 *   cacheBytes?: number}} ComposerOptions
 * @typedef {{background?: number, cursorHome?: number, flags?: number}} PageHeader
 * @typedef {PageHeader & {items: Item[], texts: Text[], images: Image[]}} ComposedPage
 * @typedef {{
 *   text: (x: number, y: number, label: string, size: number, width: number, color?: number,
 *     align?: Align, style?: TextStyle) => PageBuilder,
 *   stepper: (x: number, y: number, value: string, size: number, width: number, canLeft: boolean,
 *     canRight: boolean) => PageBuilder,
 *   solid: (x: number, y: number, w: number, h: number, color: number) => PageBuilder,
 *   legend: (x: number, y: number, keys: [string, string][], color?: number) => PageBuilder,
 *   legendTail: (x: number, y: number, head: [string, string][], keys: [string, string][],
 *     cursorItem: number, color?: number) => PageBuilder,
 *   image: (x: number, y: number, tile: Bitmap) => PageBuilder,
 *   item: (item: Item) => PageBuilder,
 *   build: () => ComposedPage
 * }} PageBuilder
 * @typedef {{id: string, label: string, value: string, adjustable: boolean, greyed: boolean,
 *   canLeft: boolean, canRight: boolean}} SettingRow
 * @typedef {[string | undefined, number, number]} Chip
 * @typedef {{y?: number, size?: number, color?: number, tracking?: number}} HeadingStyle
 */

/**
 * @param {Painter | null} painter Null only to read the style constants.
 * @param {ComposerOptions} options
 */
function createPageComposer(painter, options) {
  const ITEM = options.item;
  const KEYS = options.keys;
  const IS_ADDRESS = options.isAddress;
  const {PAGE_FLAG, ITEM_FLAG, MAX_ITEMS, MAX_TEXTS, MAX_IMAGES} = options.layout;
  const APPS_PER_PAGE = options.appsPerPage;
  const HOSTS_PER_PAGE = options.hostsPerPage;
  const SETTING_TEXTS = options.settingTexts;

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
  const SCREEN_WIDTH = 1920;
  /** The margin left and right of every page. */
  const SIDE = 96;
  const CONTENT_WIDTH = SCREEN_WIDTH - 2 * SIDE;
  const COVER = {width: 240, height: 135};
  /** Two rows of five covers, centred, a name under each. */
  const GRID = {y: 380, columns: 5, gap: 48, name: 16, row: 135 + 16 + 34 + 24};
  /** The labelled boxes top left that name the host or the page. */
  const CHIP = {y: 64, height: 54, pad: 10, size: 26};
  /** The button hints along the bottom. */
  const LEGEND = {y: 984, size: 26, height: 40};
  /** @type {[string, string][]} */
  const APP_KEYS = [['A', 'Launch'], ['B', 'PCs'], ['X', 'Settings']];
  /** Host and setting cards, two to a row; every button is a card this high. */
  const CARDS = {y: 300, width: 840, height: 96, gapX: 48, gapY: 32, pad: 32};
  const HOST_CARDS_Y = 430;
  /** Settings start under the chips and pack tighter so six rows of cards clear the legend. */
  const SETTING_GRID = {y: 180, gapY: 24};
  /** The address keypad: three columns of square-ish keys under the typed address. */
  const KEYPAD = {y: 430, width: 160, gap: 24};
  /** The small caps label on a setting card. */
  const LABEL = {size: 22, tracking: 22 * 0.08};
  /** Heading tops (normal and on status pages), kicker size and title size. */
  const HEADING = {y: 200, status: 340, kicker: 24, size: 72};
  const BUTTON = {y: 640, width: 400, gap: 48};
  const PAGER = {width: 300};
  /** The tag on the cover of the app the PC is running. */
  const RUNNING = {width: 112, height: 30};
  /** The notes top and bottom right are right aligned in a box this wide. */
  const NOTE_WIDTH = 700;
  const OVERLAY_BUTTON = 520;
  /** Strips are at most this tall, so a taller panel is a stack of them. */
  const STRIP_HEIGHT = 96;
  /** Painted strips and tiles kept across pages, oldest dropped first. */
  const CACHE_BYTES = options.cacheBytes ?? 8 * 1024 * 1024;

  /** @type {Map<string, Bitmap>} */
  const cache = new Map();
  /**
   * A number per painted bitmap, so a page's signature names its pixels cheaply.
   * @type {WeakMap<Uint8Array, number>}
   */
  const ids = new WeakMap();
  let nextId = 1;
  let cachedBytes = 0;

  /** The painter; only the constants are readable without one. */
  function usePainter() {
    if (!painter) throw Error('The page composer has no painter');
    return painter;
  }

  /** @param {Uint8Array} bytes */
  function idOf(bytes) {
    let id = ids.get(bytes);
    if (id === undefined) {
      id = nextId++;
      ids.set(bytes, id);
    }
    return id;
  }

  /**
   * The bitmap cached under `key`, painted now when it is not.
   * @param {string} key @param {() => Bitmap} paint
   */
  function remember(key, paint) {
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }

    const painted = paint();
    cache.set(key, painted);
    cachedBytes += painted.bytes.length;
    while (cachedBytes > CACHE_BYTES && cache.size > 1) {
      const first = cache.entries().next();
      if (first.done) break;

      const [oldest, bitmap] = first.value;
      cache.delete(oldest);
      cachedBytes -= bitmap.bytes.length;
    }
    return painted;
  }

  /**
   * `‹   value   ›` centred in the width, painted whole so the value keeps its place, with the
   * arrow that cannot step cleared: the first or last run of inked columns.
   * @param {string} value @param {number} size @param {number} width
   * @param {boolean} canLeft @param {boolean} canRight
   * @returns {Bitmap}
   */
  function stepperStrip(value, size, width, canLeft, canRight) {
    const whole = usePainter().text(`‹   ${value}   ›`, size, width, 'center', {weight: 700});
    if (canLeft && canRight) return whole;

    const bytes = Uint8Array.from(whole.bytes);
    const stepper = {width: whole.width, height: whole.height, bytes};
    if (!canLeft) clearColumns(stepper, inkRun(stepper, 0, 1));
    if (!canRight) clearColumns(stepper, inkRun(stepper, stepper.width - 1, -1));
    return stepper;
  }

  /**
   * The bitmap cut to its ink plus one clear pixel each side, so a filtered edge still fades to
   * nothing: a card label is a few hundred columns of an 840-column strip.
   * @param {Bitmap} bitmap
   * @returns {Trimmed}
   */
  function trim(bitmap) {
    const {width, height, bytes} = bitmap;
    let top = height;
    let bottom = -1;
    let left = width;
    let right = -1;
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        if (!bytes[row * width + column]) continue;

        top = Math.min(top, row);
        bottom = Math.max(bottom, row);
        left = Math.min(left, column);
        right = Math.max(right, column);
      }
    }
    if (bottom < 0) return {width: 1, height: 1, bytes: new Uint8Array(1), left: 0, top: 0};

    top = Math.max(0, top - 1);
    left = Math.max(0, left - 1);
    const cutWidth = Math.min(width - 1, right + 1) - left + 1;
    const cutHeight = Math.min(height - 1, bottom + 1) - top + 1;
    const cut = new Uint8Array(cutWidth * cutHeight);
    for (let row = 0; row < cutHeight; row++) {
      const from = (top + row) * width + left;
      cut.set(bytes.subarray(from, from + cutWidth), row * cutWidth);
    }
    return {width: cutWidth, height: cutHeight, bytes: cut, left, top};
  }

  /**
   * The columns of the legend of `head` and `tail` past the ink of `head` alone, so the tail
   * sits exactly where the whole legend draws it.
   * @param {[string, string][]} head @param {[string, string][]} tail
   * @returns {Trimmed}
   */
  function legendTail(head, tail) {
    const whole = usePainter().legend([...head, ...tail], LEGEND.size, 1200);
    const first = usePainter().legend(head, LEGEND.size, 1200);
    const from = inkRun(first, first.width - 1, -1)[0] + 1;
    const width = whole.width - from;
    const bytes = new Uint8Array(width * whole.height);
    for (let row = 0; row < whole.height; row++) {
      const at = row * whole.width + from;
      bytes.set(whole.bytes.subarray(at, at + width), row * width);
    }

    const cut = trim({width, height: whole.height, bytes});
    return {...cut, left: cut.left + from};
  }

  /** @param {Bitmap} bitmap @param {number} column */
  function inked(bitmap, column) {
    for (let row = 0; row < bitmap.height; row++)
      if (bitmap.bytes[row * bitmap.width + column]) return true;
    return false;
  }

  /**
   * The columns of the first run of ink met walking from `from` in `step`.
   * @param {Bitmap} bitmap @param {number} from @param {number} step
   * @returns {number[]}
   */
  function inkRun(bitmap, from, step) {
    const inside = (/** @type {number} */ column) => column >= 0 && column < bitmap.width;
    let column = from;
    while (inside(column) && !inked(bitmap, column)) column += step;

    const run = [];
    while (inside(column) && inked(bitmap, column)) {
      run.push(column);
      column += step;
    }
    return run;
  }

  /** @param {Bitmap} bitmap @param {number[]} columns */
  function clearColumns(bitmap, columns) {
    for (const column of columns)
      for (let row = 0; row < bitmap.height; row++) bitmap.bytes[row * bitmap.width + column] = 0;
  }

  /** @param {number} n @param {string} one @param {string} many */
  function count(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  /**
   * @template T
   * @param {T[]} list @param {number} at @param {number} size
   */
  function pageOf(list, at, size) {
    const pages = Math.max(1, Math.ceil(list.length / size));
    const start = at * size;
    return {pages, start, shown: list.slice(start, start + size)};
  }

  /**
   * Where the cursor starts: the remembered row when it is on this page, else the first one.
   * @param {number} index @param {number} start @param {unknown[]} shown
   */
  function homeSlot(index, start, shown) {
    const slot = index - start;
    return slot >= 0 && slot < shown.length ? slot : 0;
  }

  /** @param {number} i @param {number} top @param {number} [gapY] */
  function cardAt(i, top, gapY = CARDS.gapY) {
    return {
      x: SIDE + (i % 2) * (CARDS.width + CARDS.gapX),
      y: top + Math.floor(i / 2) * (CARDS.height + gapY)
    };
  }

  /**
   * The size and rate a launch streams in this mode (settings.js `inUse`), from the text table.
   * @param {Model['settings']} settings
   * @param {boolean} docked
   */
  function inUse(settings, docked) {
    const used = docked ? null : SETTING_TEXTS.handheld[settings.size + '@' + settings.fps];
    return used ? {...settings, size: used.size, fps: used.fps} : settings;
  }

  /**
   * The settings page rows from the PC-made text table (pages.js `settingTexts`), with the ways
   * each value steps in the operation mode.
   * @param {Model['settings']} settings
   * @param {boolean} [docked]
   * @returns {SettingRow[]}
   */
  function settingRows(settings, docked = false) {
    const used = inUse(settings, docked);
    const handheld = docked ? {} : SETTING_TEXTS.handheld[settings.size + '@' + settings.fps]?.texts ?? {};
    return SETTING_TEXTS.rows.map(row => {
      const value = settings[row.id];
      const text = value === 'auto'
        ? SETTING_TEXTS.auto[used.size + '@' + used.fps + '@' + settings.codec] ?? 'Auto'
        : handheld[row.id] ?? row.texts[JSON.stringify(value)] ?? String(value);
      const ends = docked ? row.ends.docked : row.ends.handheld;
      const [canLeft, canRight] = ends[JSON.stringify(value)] ?? [false, false];
      const adjustable = row.adjustable && !row.lockedSizes?.includes(settings.size);
      return {id: row.id, label: row.label, value: text, adjustable, greyed: row.greyed,
        canLeft: adjustable && canLeft, canRight: adjustable && canRight};
    });
  }

  /**
   * A page under construction; strips draw in the order they are added.
   * @param {PageHeader} header
   */
  function compose(header) {
    /** @type {Text[]} */
    const texts = [];
    /** @type {Image[]} */
    const images = [];
    /** @type {Item[]} */
    const items = [];

    /**
     * @param {number} x @param {number} y @param {number} color @param {Bitmap | Trimmed} bitmap
     * @param {number} [cursorItem]
     */
    function strip(x, y, color, bitmap, cursorItem) {
      const left = 'left' in bitmap ? bitmap.left : 0;
      const top = 'top' in bitmap ? bitmap.top : 0;
      /** @type {Text} */
      const text = {x: x + left, y: y + top, w: bitmap.width, h: bitmap.height, alpha: bitmap.bytes, color};
      if (cursorItem !== undefined) text.cursorItem = cursorItem;
      texts.push(text);
      return page;
    }

    /** @type {PageBuilder} */
    const page = {
      text(x, y, label, size, width, color = COLOR.ink, align = 'left', style = {}) {
        const {weight = 600, tracking = 0, cursorItem} = style;
        const key = ['t', label, size, width, align, weight, tracking].join('\u0000');
        const bitmap = remember(key, () => trim(usePainter().text(label, size, width, align, {weight, tracking})));
        return strip(x, y, color, bitmap, cursorItem);
      },

      /** A value between ‹ ›, an arrow cleared where it cannot step. */
      stepper(x, y, value, size, width, canLeft, canRight) {
        const key = ['v', value, size, width, canLeft, canRight].join('\u0000');
        return strip(x, y, COLOR.ink, remember(key, () => trim(stepperStrip(value, size, width, canLeft, canRight))));
      },

      /** A filled rectangle under the strips added after it. */
      solid(x, y, w, h, color) {
        const key = ['s', w, h].join('\u0000');
        const fill = () => ({width: w, height: h, bytes: new Uint8Array(w * h).fill(255)});
        return strip(x, y, color, remember(key, fill));
      },

      /** Button hints, each key in a ring. */
      legend(x, y, keys, color = COLOR.soft) {
        const key = ['l', JSON.stringify(keys)].join('\u0000');
        return strip(x, y, color, remember(key, () => trim(usePainter().legend(keys, LEGEND.size, 1200))));
      },

      /** The hints of `keys` after `head`, where the whole legend puts them, shown on one item. */
      legendTail(x, y, head, keys, cursorItem, color = COLOR.soft) {
        const key = ['lt', JSON.stringify(head), JSON.stringify(keys)].join('\u0000');
        return strip(x, y, color, remember(key, () => legendTail(head, keys)), cursorItem);
      },

      image(x, y, tile) {
        images.push({x, y, w: tile.width, h: tile.height, rgba: tile.bytes});
        return page;
      },

      item(item) {
        items.push(item);
        return page;
      },

      build() {
        if (items.length > MAX_ITEMS || texts.length > MAX_TEXTS)
          throw Error('UI page over the item or text limit');
        if (images.length > MAX_IMAGES) throw Error('UI page over the image limit');
        return {...header, items, texts, images};
      }
    };
    return page;
  }

  /**
   * The Horizon frame: chips top left, a note top right, button hints and a footer.
   * @param {{chips?: Chip[], note?: string, keys?: [string, string][], footer?: string,
   *   background?: number, cursorHome?: number, flags?: number}} frame
   */
  function horizon({chips = [], note = '', keys = [], footer = '', background = COLOR.background,
    cursorHome = 0, flags = 0}) {
    /** @type {PageHeader} */
    const header = {background, cursorHome};
    if (flags) header.flags = flags;
    const page = compose(header);

    let x = SIDE;
    for (const [label, color, width] of chips) {
      if (!label) continue;
      page.solid(x, CHIP.y, width, CHIP.height, COLOR.card);
      page.text(x, CHIP.y + CHIP.pad, label, CHIP.size, width, color, 'center');
      x += width + 16;
    }

    const noteX = SCREEN_WIDTH - SIDE - NOTE_WIDTH;
    if (note) page.text(noteX, CHIP.y + CHIP.pad, note, 26, NOTE_WIDTH, COLOR.muted, 'right');
    if (keys.length) page.legend(SIDE, LEGEND.y, keys);
    if (footer) page.text(noteX, LEGEND.y + 5, footer, 24, NOTE_WIDTH, COLOR.grey, 'right', {weight: 500});
    return page;
  }

  /** @param {Model} model @returns {Chip[]} */
  function hostChips(model) {
    return [
      [model.host?.name, COLOR.ink, 300],
      [model.host?.address, COLOR.muted, 300]
    ];
  }

  /**
   * A kicker in the accent, a big title and a line under it, left aligned.
   * @param {PageBuilder} page @param {string} kicker @param {string} title
   * @param {string | null} line @param {HeadingStyle} [style]
   */
  function heading(page, kicker, title, line, style = {}) {
    const {y = HEADING.y, size = HEADING.size, color = COLOR.ink, tracking = 0} = style;
    page.text(SIDE, y, kicker.toUpperCase(), HEADING.kicker, CONTENT_WIDTH, COLOR.accent, 'left', {
      tracking: HEADING.kicker * 0.1
    });
    page.text(SIDE, y + 44, title, size, CONTENT_WIDTH, color, 'left', {weight: 700, tracking});
    if (line) page.text(SIDE, y + 148, line, 28, CONTENT_WIDTH, COLOR.muted, 'left', {weight: 500});
  }

  /**
   * An opaque rectangle of any height, as a stack of strips.
   * @param {PageBuilder} page @param {number} x @param {number} y @param {number} w
   * @param {number} h @param {number} color
   */
  function panel(page, x, y, w, h, color) {
    for (let top = 0; top < h; top += STRIP_HEIGHT)
      page.solid(x, y + top, w, Math.min(STRIP_HEIGHT, h - top), color);
  }

  /**
   * A card the cursor can land on, its label centred.
   * @param {PageBuilder} page @param {number} id @param {number} x @param {number} y
   * @param {number} width @param {string} label @param {boolean} [greyed]
   */
  function button(page, id, x, y, width, label, greyed = false) {
    page.item({id, x, y, w: width, h: CARDS.height, flags: greyed ? ITEM_FLAG.greyed : 0});
    page.solid(x, y, width, CARDS.height, greyed ? COLOR.dim : COLOR.card);
    page.text(x, y + 28, label, 32, width, greyed ? COLOR.grey : COLOR.ink, 'center', {weight: 700});
  }

  /**
   * Previous and next page buttons at the bottom right, greyed at either end.
   * @param {PageBuilder} page @param {number} y @param {number} at @param {number} pages
   */
  function pager(page, y, at, pages) {
    const x = SCREEN_WIDTH - SIDE - 2 * PAGER.width - BUTTON.gap;
    const nextX = x + PAGER.width + BUTTON.gap;
    button(page, ITEM.previous, x, y, PAGER.width, '‹  Previous', at === 0);
    button(page, ITEM.next, nextX, y, PAGER.width, 'Next  ›', at >= pages - 1);
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

  /** Up to six host cards in two columns, with a pager when there are more. @param {Model} model */
  function hosts(model) {
    const {pages, start, shown} = pageOf(model.hosts, model.hostPage, HOSTS_PER_PAGE);
    const page = horizon({
      chips: [['Moonlight', COLOR.ink, 240]],
      note: pages > 1 ? `Page ${model.hostPage + 1} of ${pages}` : '',
      keys: [['A', 'Open'], ['X', 'Settings'], ['Y', 'PC options']],
      cursorHome: homeSlot(model.hostIndex, start, shown)
    });

    if (!shown.length) {
      const line = model.message ?? 'Add one by its address, or find PCs on this network';
      heading(page, 'No PCs yet', 'Add a PC', line);
    } else {
      const line = model.message ?? `${count(model.hosts.length, 'PC', 'PCs')} saved`;
      heading(page, 'Moonlight', 'Choose a PC', line);
    }

    const inner = CARDS.width - 2 * CARDS.pad;
    shown.forEach((host, i) => {
      const {x, y} = cardAt(i, HOST_CARDS_Y);
      page.item({id: ITEM.host + start + i, x, y, w: CARDS.width, h: CARDS.height});
      page.solid(x, y, CARDS.width, CARDS.height, COLOR.card);
      page.text(x + CARDS.pad, y + 12, host.name, 36, inner, COLOR.ink, 'left', {weight: 700});
      page.text(x + CARDS.pad, y + 60, host.address, 24, inner, COLOR.muted, 'left', {weight: 500});
    });

    const buttonsY = HOST_CARDS_Y + 3 * (CARDS.height + CARDS.gapY);
    button(page, ITEM.addHost, SIDE, buttonsY, PAGER.width, '+  Add PC');
    button(page, ITEM.findHosts, SIDE + PAGER.width + BUTTON.gap, buttonsY, PAGER.width, 'Find PCs');
    if (pages > 1) pager(page, buttonsY, model.hostPage, pages);
    return page.build();
  }

  /**
   * The typed address over a keypad, Connect greyed until the address is whole.
   * @param {Model} model
   * @param {boolean} ready
   */
  function addHost(model, ready) {
    const page = horizon({
      chips: [['Moonlight', COLOR.ink, 240], ['Add PC', COLOR.muted, 180]],
      keys: [['A', 'Type'], ['Y', 'Erase'], ['B', 'Cancel']]
    });
    const typed = model.entry || '_';
    heading(page, 'Add a PC', typed, 'The IP address of the PC running Sunshine, as 192.168.1.20', {
      color: model.entry ? COLOR.ink : COLOR.grey
    });

    const keys = [...KEYS, 'Erase'];
    keys.forEach((key, i) => {
      const x = SIDE + (i % 3) * (KEYPAD.width + KEYPAD.gap);
      const y = KEYPAD.y + Math.floor(i / 3) * (CARDS.height + KEYPAD.gap);
      const id = i < KEYS.length ? ITEM.key + i : ITEM.erase;
      button(page, id, x, y, KEYPAD.width, key);
    });

    const actionsX = SIDE + 3 * (KEYPAD.width + KEYPAD.gap) + BUTTON.gap;
    button(page, ITEM.connect, actionsX, KEYPAD.y, BUTTON.width, 'Connect', !ready);
    button(page, ITEM.cancel, actionsX, KEYPAD.y + CARDS.height + KEYPAD.gap, BUTTON.width, 'Cancel');
    return page.build();
  }

  /** Unpair, Remove or Cancel for the host Y was pressed on, the cursor on Cancel. @param {Model} model */
  function hostMenu(model) {
    const page = horizon({chips: hostChips(model), keys: [['A', 'Choose'], ['B', 'Back']], cursorHome: 2});
    const line = 'Unpair makes the PC forget this console; Remove only drops it from this list';
    heading(page, 'PC options', model.host?.name ?? 'PC', line, {y: HEADING.status});

    const width = 360;
    button(page, ITEM.unpair, SIDE, BUTTON.y, width, 'Unpair');
    button(page, ITEM.removeHost, SIDE + width + BUTTON.gap, BUTTON.y, width, 'Remove PC');
    button(page, ITEM.cancel, SIDE + 2 * (width + BUTTON.gap), BUTTON.y, width, 'Cancel');
    return page.build();
  }

  /**
   * The app's cover, or a letter tile when it has none or it is not usable.
   * @param {App} app @param {Map<number, Bitmap>} covers
   */
  function coverTile(app, covers) {
    const cover = covers.get(app.id);
    if (cover && cover.width) return cover;
    return remember('c\u0000' + app.name, () => usePainter().letters(app.name, COVER.width, COVER.height));
  }

  /**
   * The host name over two rows of five covers; covers keep their apps' ids across pages.
   * @param {Model} model @param {Map<number, Bitmap>} covers
   */
  function apps(model, covers) {
    const {pages, start, shown} = pageOf(model.apps, model.appPage, APPS_PER_PAGE);
    const shape = settingRows(inUse(model.settings, model.docked), model.docked)
      .filter(row => ['size', 'fps', 'bitrate'].includes(row.id))
      .map(row => row.value)
      .join(' · ');
    const page = horizon({
      chips: hostChips(model),
      note: shape,
      cursorHome: homeSlot(model.appIndex, start, shown),
      keys: APP_KEYS
    });
    const running = shown.findIndex(app => model.currentGame !== 0 && app.id === model.currentGame);
    if (running >= 0) page.legendTail(SIDE, LEGEND.y, APP_KEYS, [['Y', 'Quit host app']], ITEM.app + start + running);

    const line = [
      model.message,
      count(model.apps.length, 'app', 'apps'),
      pages > 1 ? `page ${model.appPage + 1} of ${pages}` : '',
      'Press A to launch'
    ].filter(Boolean).join(' · ');
    heading(page, 'Apps', model.host?.name ?? 'Moonlight', line, {y: 150});

    const left = (SCREEN_WIDTH - GRID.columns * COVER.width - (GRID.columns - 1) * GRID.gap) / 2;
    shown.forEach((app, i) => {
      const x = left + (i % GRID.columns) * (COVER.width + GRID.gap);
      const y = GRID.y + Math.floor(i / GRID.columns) * GRID.row;
      const current = app.id === model.currentGame;

      page.item({id: ITEM.app + start + i, x, y, w: COVER.width, h: COVER.height,
        flags: current ? ITEM_FLAG.current : 0});
      page.image(x, y, coverTile(app, covers));

      if (current) {
        page.solid(x + 8, y + 8, RUNNING.width, RUNNING.height, COLOR.running);
        page.text(x + 8, y + 13, 'RUNNING', 18, RUNNING.width, COLOR.background, 'center', {
          weight: 700,
          tracking: 1.2
        });
      }

      const nameColor = current ? COLOR.running : COLOR.ink;
      page.text(x, y + COVER.height + GRID.name, app.name, 26, COVER.width, nameColor, 'center');
    });

    const buttonsY = GRID.y + 2 * GRID.row + 8;
    button(page, ITEM.back, SIDE, buttonsY, PAGER.width, '‹  PCs');
    if (pages > 1) pager(page, buttonsY, model.appPage, pages);
    return page.build();
  }

  /** The PIN to type on the PC, or a wait until the PC sends one. @param {Model} model */
  function pairing(model) {
    const page = horizon({chips: hostChips(model), keys: [['B', 'Cancel']], flags: PAGE_FLAG.hideCursor});

    if (!model.pin) {
      heading(page, 'Pairing', 'Waiting for a PIN…', 'The PC is starting the pairing', {
        y: HEADING.status,
        size: 56
      });
      return page.build();
    }

    heading(page, 'Pairing', model.pin, 'Enter this PIN in Sunshine on the PC', {
      y: HEADING.status,
      color: COLOR.accent,
      tracking: HEADING.size * 0.2
    });
    if (model.url)
      page.text(SIDE, HEADING.status + 196, model.url, 26, CONTENT_WIDTH, COLOR.grey, 'left', {weight: 500});
    return page.build();
  }

  /**
   * One setting card: its label, then its value. The card being edited puts ‹ › around it, each
   * arrow only where a step changes the value; the others clear both, so the value stays put.
   * @param {PageBuilder} page @param {SettingRow} row @param {number} i
   * @param {boolean} editing The row A opened for left and right to step.
   */
  function settingCard(page, row, i, editing) {
    const {x, y} = cardAt(i, SETTING_GRID.y, SETTING_GRID.gapY);
    const inner = CARDS.width - 2 * CARDS.pad;
    const left = x + CARDS.pad;
    let flags = 0;
    if (row.adjustable) flags |= ITEM_FLAG.adjustable;
    if (row.adjustable && editing) flags |= ITEM_FLAG.editing;
    if (row.greyed) flags |= ITEM_FLAG.greyed;

    page.item({id: ITEM.setting + i, x, y, w: CARDS.width, h: CARDS.height, flags});
    page.solid(x, y, CARDS.width, CARDS.height, row.greyed ? COLOR.dim : COLOR.card);
    const labelColor = row.greyed ? COLOR.grey : COLOR.muted;
    page.text(left, y + 12, row.label.toUpperCase(), LABEL.size, inner, labelColor, 'left', {
      tracking: LABEL.tracking
    });

    if (row.greyed) {
      page.text(left, y + 46, 'Not available yet', 28, inner, COLOR.grey);
      return;
    }

    if (!row.adjustable) {
      page.text(left, y + 40, row.value, 40, inner, COLOR.ink, 'center', {weight: 700});
      return;
    }

    const canLeft = editing && row.canLeft;
    const canRight = editing && row.canRight;
    page.stepper(left, y + 40, row.value, 40, inner, canLeft, canRight);
  }

  /** @param {Model} model */
  function settings(model) {
    const rows = settingRows(model.settings, model.docked);
    const editing = rows.some(row => row.adjustable && row.id === model.editing);
    /** @type {[string, string][]} */
    const keys = editing ? [['◂▸', 'Change'], ['A', 'Done'], ['B', 'Done']]
      : [['A', 'Edit'], ['B', 'Back'], ['Y', 'Reset']];
    const page = horizon({
      chips: [[model.host?.name, COLOR.ink, 300], ['Settings', COLOR.muted, 180]],
      note: model.settingsError ? 'Settings could not be saved: ' + model.settingsError
        : 'Applies to the next launch',
      keys
    });
    rows.forEach((row, i) => settingCard(page, row, i, row.id === model.editing));
    const size = rows.findIndex(row => row.id === 'size');
    if (!model.docked && size >= 0) {
      page.text(SCREEN_WIDTH - SIDE - NOTE_WIDTH, LEGEND.y + 5, '1440p and 4K are only available when docked', 24,
        NOTE_WIDTH, COLOR.muted, 'right', {weight: 500, cursorItem: ITEM.setting + size});
    }
    return page.build();
  }

  /** Quit or Cancel, the cursor on Cancel. @param {Model} model */
  function quitConfirm(model) {
    const page = horizon({chips: hostChips(model), keys: [['A', 'Choose'], ['B', 'Back']], cursorHome: 1});
    const running = model.apps.find(app => app.id === model.currentGame)?.name ?? 'the running app';
    const line = 'The stream ends and the app closes on the PC';
    heading(page, 'Quit host app', `Quit ${running}?`, line, {y: HEADING.status});

    button(page, ITEM.confirmQuit, SIDE, BUTTON.y, BUTTON.width, 'Quit');
    button(page, ITEM.cancel, SIDE + BUTTON.width + BUTTON.gap, BUTTON.y, BUTTON.width, 'Cancel');
    return page.build();
  }

  /** The menu over the stream: transparent, with opaque panels behind its parts. @param {Model} model */
  function overlay(model) {
    const page = horizon({background: COLOR.clear, flags: PAGE_FLAG.overlay});

    const width = 2 * OVERLAY_BUTTON + BUTTON.gap;
    const top = HEADING.status - 40;
    const bottom = BUTTON.y + CARDS.height + 40;
    panel(page, SIDE - 40, top, width + 80, bottom - top, COLOR.background);
    panel(page, SIDE - 40, LEGEND.y - 16, 440, LEGEND.height + 32, COLOR.background);
    page.legend(SIDE, LEGEND.y, [['A', 'Choose'], ['B', 'Hide']]);

    heading(page, 'Streaming', model.app?.name ?? 'Moonlight', model.host?.name ?? null, {y: HEADING.status});
    button(page, ITEM.returnToApps, SIDE, BUTTON.y, OVERLAY_BUTTON, 'Return to apps');
    button(page, ITEM.quitHost, SIDE + OVERLAY_BUTTON + BUTTON.gap, BUTTON.y, OVERLAY_BUTTON, 'Quit host app');
    return page.build();
  }

  /** @param {Model} model */
  function error(model) {
    const lost = model.screen === 'connectionLost';
    const action = lost && model.host ? 'Reconnect' : 'Back';
    /** @type {[string, string][]} */
    const keys = action === 'Reconnect' ? [['A', action], ['B', 'PCs']] : [['A', action]];
    const page = horizon({chips: hostChips(model), keys});
    heading(page, lost ? 'Connection lost' : 'Something went wrong', model.message ?? 'Something went wrong',
      null, {y: HEADING.status, size: 48});
    button(page, ITEM.back, SIDE, BUTTON.y, BUTTON.width, action);
    return page.build();
  }

  /**
   * The page for the model's screen without its epoch and sequence, or null for the screens the
   * static atlas draws (splash, stopped).
   * @param {Model} model
   * @param {Map<number, Bitmap>} [covers] Cover tiles by app id; the rest get letter tiles.
   * @returns {ComposedPage | null}
   */
  function page(model, covers = new Map()) {
    const host = model.host?.name ?? '';
    /** @type {[string, string][]} */
    const cancel = [['B', 'Cancel']];
    switch (model.screen) {
      case 'hosts':
        return hosts(model);
      case 'addHost':
        return addHost(model, IS_ADDRESS(model.entry));
      case 'hostMenu':
        return hostMenu(model);
      case 'unpairing':
        return status(model, 'Unpairing', host, 'Asking the PC to forget this console…', []);
      case 'connecting':
        return status(model, 'Connecting', host, model.host?.address ?? null, cancel);
      case 'pairing':
        return pairing(model);
      case 'apps':
        return apps(model, covers);
      case 'quitConfirm':
        return quitConfirm(model);
      case 'settings':
        return settings(model);
      case 'launching':
        return status(model, 'Launching', model.app?.name ?? '', model.message ?? 'Starting the stream…', cancel);
      case 'streaming':
        return overlay(model);
      case 'quitting':
        return status(model, 'Quitting', host, 'Closing the app on the PC…', []);
      case 'connectionLost':
      case 'error':
        return error(model);
      default:
        return null;
    }
  }

  /**
   * A short string that changes whenever the page's layout or any of its pixels do.
   * @param {ComposedPage} built
   */
  function signature(built) {
    /** @type {(number | string | undefined)[]} */
    const parts = [built.flags ?? 0, built.background, built.cursorHome];
    for (const item of built.items) parts.push(item.id, item.x, item.y, item.w, item.h, item.flags ?? 0);
    parts.push('t');
    for (const text of built.texts) parts.push(text.x, text.y, text.color, text.cursorItem, idOf(text.alpha));
    parts.push('i');
    for (const image of built.images) parts.push(image.x, image.y, idOf(image.rgba));
    return parts.join(',');
  }

  return {page, signature, settingRows, COLOR, COVER, GRID, cacheBytes: () => cachedBytes};
}

export {createPageComposer};
