/**
 * Stream settings the console UI offers, persisted next to hosts.json and turned into the
 * arguments of the next launch. Only values the console path has run are offered (team note
 * research/ui-settings-catalog.md); the two toggles without host plumbing stay greyed until it
 * lands, so the page shows them without pretending they work.
 */
import fs from 'node:fs';
import path from 'node:path';
import {hostsFile} from './ui-hosts.js';

/** Mbps steps the bitrate row walks through. */
const BITRATES = Array.from({length: 15}, (_, i) => 5 + i * 2.5);

/**
 * @typedef {{id: string, label: string, values: any[], fallback: any,
 *   text: (value: any) => string, locked?: boolean, unbacked?: boolean}} Setting
 */

/** @type {Setting[]} */
const CATALOG = [
  {
    id: 'size',
    label: 'Resolution',
    values: ['1280x720', '1920x1080'],
    fallback: '1920x1080',
    text: value => value.replace('x', ' × ')
  },
  {id: 'fps', label: 'Frame rate', values: [30, 60], fallback: 60, text: value => value + ' fps'},
  {
    id: 'bitrate',
    label: 'Bitrate',
    values: BITRATES,
    fallback: 20,
    text: value => value + ' Mbps'
  },
  {
    id: 'codec',
    label: 'Codec',
    values: ['h264'],
    fallback: 'h264',
    text: () => 'H.264',
    locked: true
  },
  {
    id: 'audio',
    label: 'Audio',
    values: ['stereo'],
    fallback: 'stereo',
    text: () => 'Stereo',
    locked: true
  },
  {
    id: 'quitOnReturn',
    label: 'Quit host app on return',
    values: [false, true],
    fallback: false,
    text: value => (value ? 'On' : 'Off'),
    unbacked: true
  },
  {
    id: 'optimise',
    label: 'Optimise game settings',
    values: [false, true],
    fallback: false,
    text: value => (value ? 'On' : 'Off'),
    unbacked: true
  },
  {
    id: 'presentHz',
    label: 'Present rate',
    values: [60, 120],
    fallback: 60,
    text: value => (value === 120 ? '120 Hz (experimental)' : '60 Hz')
  }
];

/** settings.json beside hosts.json. */
function settingsFile() {
  return path.join(path.dirname(hostsFile()), 'settings.json');
}

function defaults() {
  return Object.fromEntries(CATALOG.map(setting => [setting.id, setting.fallback]));
}

/**
 * The saved settings, each value checked against its catalog row; anything missing, unknown
 * or out of range falls back to the default.
 * @param {string} file
 */
function load(file) {
  let parsed = {};
  try {
    const read = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (read && typeof read === 'object' && !Array.isArray(read)) parsed = read;
  } catch {}
  const settings = defaults();
  for (const setting of CATALOG)
    if (setting.values.includes(parsed[setting.id])) settings[setting.id] = parsed[setting.id];
  return settings;
}

/**
 * @param {string} file
 * @param {Record<string, any>} settings
 */
function save(file, settings) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * One step up or down the row's values, without wrapping; locked and unbacked rows do not move.
 * @param {Record<string, any>} settings
 * @param {string} id
 * @param {number} direction 1 right, -1 left.
 */
function adjust(settings, id, direction) {
  const setting = CATALOG.find(entry => entry.id === id);
  if (!setting || setting.locked || setting.unbacked) return settings;
  const index = setting.values.indexOf(settings[id]);
  const next = Math.min(setting.values.length - 1, Math.max(0, index + Math.sign(direction)));
  if (setting.values[next] === settings[id]) return settings;
  return {...settings, [id]: setting.values[next]};
}

/**
 * The settings page rows: label, value text, and whether the row takes left/right.
 * @param {Record<string, any>} settings
 */
function rows(settings) {
  return CATALOG.map(setting => ({
    id: setting.id,
    label: setting.label,
    value: setting.text(settings[setting.id]),
    adjustable: !setting.locked && !setting.unbacked,
    greyed: Boolean(setting.unbacked)
  }));
}

/**
 * The live.js arguments of a launch with these settings: the proven control shape, with the
 * present rate added only in the staggered form that supports it.
 * @param {Record<string, any>} settings
 */
function streamArgs(settings) {
  const args = [
    '--codec',
    'h264',
    '--size',
    settings.size,
    '--fps',
    String(settings.fps),
    '--bitrate',
    String(Math.round(settings.bitrate * 1000)),
    '--staggered',
    '--socket-audio'
  ];
  if (settings.presentHz === 120) args.push('--present-hz', '120');
  return args;
}

export {CATALOG, settingsFile, defaults, load, save, adjust, rows, streamArgs};
