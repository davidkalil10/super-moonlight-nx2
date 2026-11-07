/**
 * The PC hosts the console UI offers, kept in hosts.json under the Moonlight config directory,
 * and the app list the helper prints for one of them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The Sunshine host every list carries, whatever hosts.json says. */
const DEFAULT_HOST = {name: 'Sunshine', address: '192.168.8.245'};

/** The Moonlight config directory under XDG_CONFIG_HOME, or ~/.config when it is unset. */
function configDirectory() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'moonlight-nx2');
}

/** Copies the old hblauncher/moonlight directory to the config directory once, keeping pairings. */
function migrateConfig() {
  const directory = configDirectory();
  const legacy = path.join(path.dirname(directory), 'hblauncher', 'moonlight');
  if (fs.existsSync(directory) || !fs.existsSync(legacy)) return;

  fs.cpSync(legacy, directory, {recursive: true, preserveTimestamps: true});
}

/** hosts.json in the Moonlight config directory. */
function hostsFile() {
  return path.join(configDirectory(), 'hosts.json');
}

/**
 * @typedef {{name: string, address: string, uniqueid?: string}} SavedHost
 * @typedef {{address: string, uniqueid?: string}} RemovedHost
 */

/**
 * A saved host's name, or its address when the name is missing or empty.
 * @param {{name?: unknown, address: string}} host
 */
function savedName(host) {
  if (typeof host.name !== 'string' || !host.name) return host.address;
  return host.name;
}

/**
 * The entry with a trimmed address and a uniqueid only when it is a non-empty string, or null
 * without an address.
 * @param {any} entry
 * @returns {RemovedHost | null}
 */
function addressOf(entry) {
  if (!entry || typeof entry.address !== 'string') return null;

  const address = entry.address.trim();
  if (!address) return null;

  /** @type {RemovedHost} */
  const host = {address};
  if (typeof entry.uniqueid === 'string' && entry.uniqueid) host.uniqueid = entry.uniqueid;
  return host;
}

/**
 * The entries of `list` that have an address, each address once, first one kept.
 * @param {unknown} list
 */
function addresses(list) {
  if (!Array.isArray(list)) return [];

  const seen = new Set();
  /** @type {{entry: any, host: RemovedHost}[]} */
  const kept = [];
  for (const entry of list) {
    const host = addressOf(entry);
    if (!host || seen.has(host.address)) continue;
    seen.add(host.address);
    kept.push({entry, host});
  }

  return kept;
}

/**
 * hosts.json as written: `{hosts, removed}`, or the plain host array of older versions.
 * @param {string} file
 * @returns {{hosts?: unknown, removed?: unknown}}
 */
function readHostsFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return {hosts: parsed};
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}

  return {};
}

/**
 * The hosts saved in `file`: addresses trimmed, entries without one dropped, each address once,
 * a missing name becomes the address. An unreadable or malformed file reads as no hosts.
 * @param {string} file
 * @returns {SavedHost[]}
 */
function loadHosts(file) {
  return addresses(readHostsFile(file).hosts).map(({entry, host}) => ({
    name: savedName({name: entry.name, address: host.address}),
    ...host
  }));
}

/**
 * The hosts the user removed, which discovery does not add back (ui/CLAUDE.md, Hosts).
 * @param {string} file
 * @returns {RemovedHost[]}
 */
function loadRemoved(file) {
  return addresses(readHostsFile(file).removed).map(({host}) => host);
}

/**
 * Writes the list through a .part file and a rename, so a crash never leaves half a file.
 * The removed list is kept as it is unless one is given.
 * @param {string} file
 * @param {SavedHost[]} hosts
 * @param {RemovedHost[]} [removed]
 */
function saveHosts(file, hosts, removed = loadRemoved(file)) {
  fs.mkdirSync(path.dirname(file), {recursive: true});

  const partial = file + '.part';
  fs.writeFileSync(partial, JSON.stringify({hosts, removed}, null, 2) + '\n');
  fs.renameSync(partial, file);
}

/**
 * Whether two entries are the same PC: the same uniqueid when both know one, else the same
 * address.
 * @param {RemovedHost} a @param {RemovedHost} b
 */
function sameHost(a, b) {
  if (a.uniqueid && b.uniqueid) return a.uniqueid === b.uniqueid;
  return a.address === b.address;
}

/**
 * The saved list once `host` listed: a known uniqueid at a new address moves that entry there
 * (a new DHCP lease) and drops any other entry at the address; an unknown host is appended.
 * Returns `saved` itself when nothing changed.
 * @param {SavedHost[]} saved
 * @param {SavedHost} host
 * @returns {SavedHost[]}
 */
function rememberIn(saved, host) {
  const atAddress = saved.findIndex(entry => entry.address === host.address);
  const byId = host.uniqueid ? saved.findIndex(entry => entry.uniqueid === host.uniqueid) : -1;
  const target = byId >= 0 ? byId : atAddress;
  if (target < 0) return [...saved, host];

  const entry = saved[target];
  const moved = entry.address !== host.address;
  const learned = Boolean(host.uniqueid) && entry.uniqueid !== host.uniqueid;
  if (!moved && !learned) return saved;

  /** @type {SavedHost} */
  const updated = {...entry, address: host.address};
  if (host.uniqueid) updated.uniqueid = host.uniqueid;
  return saved
    .map((other, index) => (index === target ? updated : other))
    .filter((other, index) => index === target || other.address !== host.address);
}

/**
 * The configured hosts, then any extra addresses, then the default Sunshine host, each address
 * once. Pairing state is not stored per host (libgamestream keeps only client-side keys), so
 * it is queried live on open.
 * @param {{name?: string, address: string}[]} existing
 * @param {string[]} [extra]
 */
function seedHosts(existing, extra = []) {
  /** @type {{name: string, address: string}[]} */
  const hosts = [];
  const seen = new Set();

  /** @param {{name?: string, address: string} | null | undefined} host */
  const add = host => {
    if (!host || seen.has(host.address)) return;
    seen.add(host.address);
    hosts.push({name: host.name || host.address, address: host.address});
  };

  for (const host of existing) add(host);
  for (const address of extra) add({name: address, address});
  add(DEFAULT_HOST);

  return hosts;
}

/**
 * The app list from the helper's `list` output: the one JSON line that carries "apps", and the
 * host's uniqueid when the helper reports it.
 * @param {string} stdout
 * @returns {{currentGame: number, apps: {id: number, name: string, cover?: string}[],
 *   uniqueid?: string}}
 */
function parseList(stdout) {
  const line = stdout.split('\n').find(text => text.includes('"apps"'));
  if (!line) throw Error('no app list in hbmoonlight output');

  /** @type {{currentGame?: number, apps?: {id: number, name: string, cover?: unknown}[],
   *   uniqueid?: unknown}} */
  const parsed = JSON.parse(line);
  /** @type {ReturnType<typeof parseList>} */
  const listed = {
    currentGame: parsed.currentGame || 0,
    apps: (parsed.apps || []).map(app => {
      /** @type {{id: number, name: string, cover?: string}} */
      const entry = {id: app.id, name: app.name};
      if (typeof app.cover === 'string') entry.cover = app.cover;
      return entry;
    })
  };
  if (typeof parsed.uniqueid === 'string' && parsed.uniqueid) listed.uniqueid = parsed.uniqueid;

  return listed;
}

export {DEFAULT_HOST, configDirectory, migrateConfig, hostsFile, loadHosts, loadRemoved, saveHosts,
  sameHost, rememberIn, seedHosts, parseList};
