/**
 * The PC hosts the console UI offers, kept in hosts.json under the Moonlight config directory,
 * and the app list the helper prints for one of them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The Sunshine host every list carries, whatever hosts.json says. */
const DEFAULT_HOST = {name: 'Sunshine', address: '192.168.8.245'};

/** hosts.json under XDG_CONFIG_HOME, or ~/.config when it is unset. */
function hostsFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'hblauncher', 'moonlight', 'hosts.json');
}

/** A saved host's name, or its address when the name is missing or empty. */
function savedName(host) {
  if (typeof host.name !== 'string' || !host.name) return host.address;
  return host.name;
}

/**
 * The hosts saved in `file`: entries without an address are dropped, a missing name becomes
 * the address. An unreadable or malformed file reads as no hosts.
 * @param {string} file
 */
function loadHosts(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(host => host && typeof host.address === 'string')
      .map(host => ({name: savedName(host), address: host.address}));
  } catch {
    return [];
  }
}

/**
 * Writes the list through a .part file and a rename, so a crash never leaves half a file.
 * @param {string} file
 * @param {{name: string, address: string}[]} hosts
 */
function saveHosts(file, hosts) {
  fs.mkdirSync(path.dirname(file), {recursive: true});

  const partial = file + '.part';
  fs.writeFileSync(partial, JSON.stringify(hosts, null, 2) + '\n');
  fs.renameSync(partial, file);
}

/**
 * The configured hosts, then any extra addresses, then the default Sunshine host, each address
 * once. Pairing state is not stored per host (libgamestream keeps only client-side keys), so
 * it is queried live on open.
 * @param {{name?: string, address: string}[]} existing
 * @param {string[]} [extra]
 */
function seedHosts(existing, extra = []) {
  const hosts = [];
  const seen = new Set();

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
 * The app list from the helper's `list` output: the one JSON line that carries "apps".
 * @param {string} stdout
 * @returns {{currentGame: number, apps: {id: number, name: string, cover?: string}[]}}
 */
function parseList(stdout) {
  const line = stdout.split('\n').find(text => text.includes('"apps"'));
  if (!line) throw Error('no app list in hbmoonlight output');

  const parsed = JSON.parse(line);
  return {
    currentGame: parsed.currentGame || 0,
    apps: (parsed.apps || []).map(app => {
      const entry = {id: app.id, name: app.name};
      if (typeof app.cover === 'string') entry.cover = app.cover;
      return entry;
    })
  };
}

export {DEFAULT_HOST, hostsFile, loadHosts, saveHosts, seedHosts, parseList};
