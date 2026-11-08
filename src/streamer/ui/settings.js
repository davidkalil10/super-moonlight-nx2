/**
 * Stream settings the console UI offers, their pure rules (shipped to the console), the PC file
 * store and the arguments of the next launch. Catalog rules: CLAUDE.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import {hostsFile} from './hosts.js';
import {defaultBitrate} from '../session/bitrate.js';

/** Mbps steps the bitrate row walks through: 5 to 40 in steps of 2.5. */
const BITRATES = Array.from({length: 15}, (_, i) => 5 + i * 2.5);

/** Bitrate value that leaves the choice to bitrate.js for the chosen size and rate. */
const AUTO = 'auto';

/**
 * Value text of the on/off toggles.
 * @param {boolean} value
 */
const onOff = value => (value ? 'On' : 'Off');

/**
 * Value text of the bitrate row; Auto shows what it resolves to with the current settings.
 * @param {number | string} value
 * @param {Record<string, any>} settings
 */
function bitrateText(value, settings) {
  if (value !== AUTO) return value + ' Mbps';

  const [width, height] = settings.size.split('x').map(Number);
  return `Auto (${defaultBitrate(width, height, settings.fps, settings.codec) / 1000} Mbps)`;
}

/** Value text of the codec row. */
const CODECS = {h264: 'H.264', av1: 'AV1'};

/** Sizes above 1080p: AV1 only and docked only; 2160p runs at 60 fps (civ7/README.md, "Fallbacks"). */
const DOCKED_SIZES = ['2560x1440', '3840x2160'];

/**
 * Value text of the resolution row.
 * @param {string} value
 */
function sizeText(value) {
  const text = value.replace('x', ' × ');
  if (value === '3840x2160') return text + ' (docked, 60 fps)';
  if (DOCKED_SIZES.includes(value)) return text + ' (docked)';
  return text;
}

/** How the docked note of a handheld row names a docked-only size. */
const SHORT_SIZES = {'2560x1440': '1440p', '3840x2160': '4K'};

/**
 * What a launch streams in this operation mode: handheld, a docked-only size streams 1080p, and
 * 4K at 120 fps (`--undocked-fps`, application.js). The saved settings stay as they are.
 * @param {Record<string, any>} settings
 * @param {boolean} docked
 */
function inUse(settings, docked) {
  if (docked || !DOCKED_SIZES.includes(settings.size)) return settings;

  return {...settings, size: '1920x1080', fps: settings.size === '3840x2160' ? 120 : settings.fps};
}

/** Value text of the button layout row (input/CLAUDE.md, "Controller"). */
const BUTTONS = {position: 'By position', labels: 'By letter'};

/**
 * A catalog row. `formerDefaults` are fallbacks of the unversioned format: a save from before
 * version 2 holding one of them gets today's fallback instead. A save older than `resetBefore`
 * takes today's fallback for the row whatever it holds. `docked` values are only stepped onto
 * while the console is docked.
 * @typedef {{id: string, label: string, values: any[], fallback: any,
 *   text: (value: any, settings: Record<string, any>) => string,
 *   short?: (value: any) => string, unbacked?: boolean, formerDefaults?: any[],
 *   resetBefore?: number, docked?: any[], lockedSizes?: string[]}} Setting
 */

/** @type {Setting[]} */
const CATALOG = [
  {
    id: 'size',
    label: 'Resolution',
    values: ['1280x720', '1920x1080', ...DOCKED_SIZES],
    fallback: '1920x1080',
    text: sizeText,
    short: (/** @type {keyof typeof SHORT_SIZES} */ value) => SHORT_SIZES[value],
    docked: DOCKED_SIZES
  },
  {
    id: 'fps',
    label: 'Frame rate',
    values: [60, 120],
    fallback: 60,
    text: value => value + ' fps',
    lockedSizes: ['3840x2160']
  },
  {
    id: 'bitrate',
    label: 'Bitrate',
    values: [AUTO, ...BITRATES],
    fallback: AUTO,
    text: bitrateText,
    formerDefaults: [20]
  },
  {
    id: 'codec',
    label: 'Codec',
    values: ['h264', 'av1'],
    fallback: 'av1',
    text: (/** @type {keyof typeof CODECS} */ value) => CODECS[value],
    resetBefore: 4
  },
  {
    id: 'hostAudio',
    label: 'Play audio on the PC',
    values: [false, true],
    fallback: false,
    text: onOff
  },
  {
    id: 'optimise',
    label: 'Optimise game settings',
    values: [false, true],
    fallback: false,
    text: onOff
  },
  {
    id: 'quitOnReturn',
    label: 'Quit host app on return',
    values: [false, true],
    fallback: false,
    text: onOff
  },
  {
    id: 'buttons',
    label: 'Button layout',
    values: ['position', 'labels'],
    fallback: 'position',
    text: (/** @type {keyof typeof BUTTONS} */ value) => BUTTONS[value]
  },
  {
    id: 'streamInfo',
    label: 'Stream info badge',
    values: [false, true],
    fallback: false,
    text: onOff
  },
  {
    id: 'frameCounter',
    label: 'Frame counter',
    values: [false, true],
    fallback: false,
    text: onOff
  }
];

/** What the reducer needs of each row: the catalog without its labels and value text. */
const VALUES = CATALOG.map(setting => ({
  id: setting.id,
  values: setting.values,
  fallback: setting.fallback,
  unbacked: Boolean(setting.unbacked),
  formerDefaults: setting.formerDefaults ?? [],
  resetBefore: setting.resetBefore ?? 0,
  docked: setting.docked ?? [],
  lockedSizes: setting.lockedSizes ?? []
}));

/**
 * Defaults, sanitising and stepping over the catalog values. Self-contained: payload.js ships it
 * with toString() so the console model uses the same rules.
 * @param {{id: string, values: any[], fallback: any, unbacked: boolean,
 *   formerDefaults: any[], resetBefore: number, docked: any[], lockedSizes?: string[]}[]} rows
 */
function createSettingsCore(rows) {
  /**
   * Saved format; version 2 made Auto the bitrate default and dropped the present rate, version
   * 3 added AV1 to the codec row, version 4 added the transport row and moved every save to AV1
   * over UDP once, version 5 dropped 30 fps and added the host audio, SOPS, quit on return,
   * button layout and stream info rows, keeping every other value.
   */
  const version = 5;
  /** The first version whose saves hold today's defaults rather than the former ones. */
  const currentDefaults = 2;

  /** Every setting at its catalog fallback. */
  function defaults() {
    /** @type {Record<string, any>} */
    const settings = {version};
    for (const row of rows) settings[row.id] = row.fallback;
    return settings;
  }

  /**
   * A settings object built from `saved`, each value checked against its row; anything missing,
   * unknown or out of range falls back to the default, and so does a former default in a save
   * older than version 2 and any value of a row reset since the save's version.
   * @param {unknown} saved
   */
  function sanitize(saved) {
    const settings = defaults();
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return settings;

    const fields = /** @type {Record<string, unknown>} */ (saved);
    const savedVersion = Number(fields.version);
    const versioned = Number.isInteger(savedVersion);
    const oldDefaults = !versioned || savedVersion < currentDefaults;
    for (const row of rows) {
      const value = fields[row.id];
      const known = row.values.includes(value);
      const former = oldDefaults && row.formerDefaults.includes(value);
      const reset = row.resetBefore > 0 && (!versioned || savedVersion < row.resetBefore);
      if (known && !former && !reset) settings[row.id] = value;
    }
    if (settings.size === '3840x2160') {
      settings.fpsBefore4k = [60, 120].includes(Number(fields.fpsBefore4k))
        ? Number(fields.fpsBefore4k) : settings.fps;
      settings.fps = 60;
    }
    return settings;
  }

  /**
   * One step up or down the row's values, without wrapping, skipping the docked-only values
   * while handheld; unbacked rows do not move. A docked-only value saved while docked
   * stays until stepped off.
   * @param {Record<string, any>} settings
   * @param {string} id
   * @param {number} direction 1 right, -1 left.
   * @param {boolean} [docked]
   */
  function adjust(settings, id, direction, docked = false) {
    const row = rows.find(entry => entry.id === id);
    if (!row || row.unbacked || row.lockedSizes?.includes(settings.size)) return settings;

    const step = Math.sign(direction);
    const offered = (/** @type {any} */ value) => docked || !row.docked.includes(value);
    let index = row.values.indexOf(settings[id]) + step;
    while (index >= 0 && index < row.values.length && !offered(row.values[index])) index += step;
    if (index < 0 || index >= row.values.length) return settings;

    const value = row.values[index];
    if (id === 'size' && value === '3840x2160')
      return {...settings, size: value, fps: 60, fpsBefore4k: settings.fps};
    if (id === 'size' && settings.size === '3840x2160') {
      const {fpsBefore4k, ...rest} = settings;
      return {...rest, size: value, fps: [60, 120].includes(fpsBefore4k) ? fpsBefore4k : settings.fps};
    }
    return {...settings, [id]: value};
  }

  return {version, defaults, sanitize, adjust};
}

const core = createSettingsCore(VALUES);
const {defaults, sanitize, adjust} = core;

/** settings.json beside hosts.json. */
function settingsFile() {
  return path.join(path.dirname(hostsFile()), 'settings.json');
}

/**
 * The saved settings, cleaned against the catalog; a missing or corrupt file gives the defaults.
 * @param {string} file
 */
function load(file) {
  try {
    return sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return defaults();
  }
}

/**
 * Writes the settings as JSON, creating the config directory first.
 * @param {string} file
 * @param {Record<string, any>} settings
 */
function save(file, settings) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * The PC settings file behind the narrow store the UI uses, until the console keeps its own
 * (ui/CLAUDE.md, "Settings storage"). `load` is also the one-time migration source.
 * @param {string} [file]
 * @returns {{load: () => Record<string, any>, save: (settings: Record<string, any>) => void}}
 */
function createFileStore(file = settingsFile()) {
  return {
    load: () => load(file),
    save: settings => save(file, sanitize(settings))
  };
}

/**
 * The value text of a row in this operation mode: what is in use, followed by the saved value
 * when that only applies docked ("1920 × 1080 · 4K when docked").
 * @param {Setting} setting
 * @param {Record<string, any>} settings
 * @param {boolean} docked
 */
function valueText(setting, settings, docked) {
  const saved = settings[setting.id];
  const used = inUse(settings, docked);
  if (used[setting.id] === saved) return setting.text(saved, used);

  const short = setting.short ? setting.short(saved) : setting.text(saved, settings);
  return setting.text(used[setting.id], used) + ' · ' + short + ' when docked';
}

/**
 * The settings page rows: label, value text, whether the row takes left/right, and which way a
 * step would change the value, as adjust() steps it in this operation mode.
 * @param {Record<string, any>} settings
 * @param {boolean} [docked]
 */
function rows(settings, docked = false) {
  /** @param {string} id @param {number} direction */
  const moves = (id, direction) => adjust(settings, id, direction, docked)[id] !== settings[id];

  return CATALOG.map(setting => ({
    id: setting.id,
    label: setting.label,
    value: valueText(setting, settings, docked),
    adjustable: !setting.unbacked && !setting.lockedSizes?.includes(settings.size),
    greyed: Boolean(setting.unbacked),
    canLeft: moves(setting.id, -1),
    canRight: moves(setting.id, 1)
  }));
}

/**
 * The `--bitrate` value in kbps, or `auto` for the launcher to resolve with bitrate.js.
 * @param {number | string} value
 */
function bitrateArg(value) {
  if (value === AUTO) return AUTO;
  return String(Math.round(Number(value) * 1000));
}

/**
 * The stream arguments of a launch with these settings: the proven control shape, then the
 * opt-in rows. The frame rate is also the display rate; there is no separate present rate. Quit
 * on return is the model's, not an argument.
 * @param {Record<string, any>} settings
 */
function streamArgs(settings) {
  settings = sanitize(settings);
  const args = [
    '--codec',
    settings.codec,
    '--size',
    settings.size,
    '--fps',
    String(settings.fps),
    '--bitrate',
    bitrateArg(settings.bitrate),
    '--staggered',
    '--socket-audio'
  ];
  if (settings.size === '3840x2160') args.push('--undocked-fps', '120');

  if (settings.hostAudio) args.push('--local-audio');
  if (settings.optimise) args.push('--sops');
  if (settings.buttons === 'labels') args.push('--buttons', 'labels');
  if (settings.streamInfo) args.push('--stream-info');
  if (settings.frameCounter) args.push('--frame-counter');
  return args;
}

export {
  CATALOG,
  VALUES,
  core,
  createSettingsCore,
  createFileStore,
  settingsFile,
  defaults,
  sanitize,
  load,
  save,
  adjust,
  rows,
  inUse,
  streamArgs
};
