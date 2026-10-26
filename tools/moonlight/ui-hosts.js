/**
 * The PC hosts the console UI offers, kept in hosts.json under the Moonlight config directory,
 * and the app list the helper prints for one of them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_HOST = {name: 'Sunshine', address: '192.168.8.245'};

function hostsFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'hblauncher', 'moonlight', 'hosts.json');
}

function loadHosts(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(h => h && typeof h.address === 'string')
      .map(h => ({
        name: typeof h.name === 'string' && h.name ? h.name : h.address,
        address: h.address
      }));
  } catch {
    return [];
  }
}

function saveHosts(file, hosts) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const partial = file + '.part';
  fs.writeFileSync(partial, JSON.stringify(hosts, null, 2) + '\n');
  fs.renameSync(partial, file);
}

// Keep the configured hosts, append any extra addresses, and make sure the
// default Sunshine host is always present. Pairing state is not stored per host
// (libgamestream keeps only client-side keys), so it is queried live on open.
function seedHosts(existing, extra = []) {
  const out = [];
  const seen = new Set();
  const add = host => {
    if (!host || seen.has(host.address)) return;
    seen.add(host.address);
    out.push({name: host.name || host.address, address: host.address});
  };
  for (const host of existing) add(host);
  for (const address of extra) add({name: address, address});
  add(DEFAULT_HOST);
  return out;
}

function parseList(stdout) {
  const line = stdout.split('\n').find(l => l.includes('"apps"'));
  if (!line) throw Error('no app list in hbmoonlight output');
  const parsed = JSON.parse(line);
  return {
    currentGame: parsed.currentGame || 0,
    apps: (parsed.apps || []).map(a => ({
      id: a.id,
      name: a.name,
      ...(typeof a.cover === 'string' ? {cover: a.cover} : {})
    }))
  };
}

export {DEFAULT_HOST, hostsFile, loadHosts, saveHosts, seedHosts, parseList};
