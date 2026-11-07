import fs from 'node:fs/promises';
import {openSync, closeSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

/** @typedef {{id: string, state: string, pid: number}} HelperStatus */

/**
 * The running helper's status when it serves this bundle, or null.
 * @param {string} bundle
 * @param {string} id
 * @returns {Promise<HelperStatus | null>}
 */
async function status(bundle, id) {
  try {
    const ready = JSON.parse(await fs.readFile(path.join(bundle, 'ready.json'), 'utf8'));
    if (ready.id !== id) return null;
    const response = await fetch('http://127.0.0.1:' + ready.port + '/status', {signal: AbortSignal.timeout(1000)});
    const result = await response.json();
    return result.id === id ? result : null;
  } catch { return null; }
}

/**
 * Starts the bundle's helper unless it already runs, then sends the payload to the console.
 * @param {string} bundle
 * @param {string} consoleHost
 */
export async function launch(bundle, consoleHost, consolePort = 9026) {
  if (!net.isIPv4(consoleHost) || !Number.isInteger(consolePort) || consolePort < 1 || consolePort > 65535)
    throw Error('Moonlight launch requires a console IPv4 address and TCP port');
  const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'manifest.json'), 'utf8'));
  let ready = await status(bundle, manifest.id);
  if (!ready) {
    const output = openSync(path.join(bundle, 'helper.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, [path.join(bundle, 'serve.mjs')],
        {detached: true, stdio: ['ignore', output, output]});
      child.unref();
      const deadline = Date.now() + 15000;
      do {
        await delay(100);
        ready = await status(bundle, manifest.id);
      } while (!ready && Date.now() < deadline);
    } finally { closeSync(output); }
    if (!ready) throw Error('Moonlight helper did not start; see helper.log');
  }
  if (ready.state !== 'waiting') throw Error('Moonlight already has an active session');
  const payload = await fs.readFile(path.join(bundle, 'moonlight.js'));
  const socket = net.connect(consolePort, consoleHost);
  socket.setTimeout(10000);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.once('timeout', () => { socket.destroy(); reject(Error('Moonlight console connection timed out')); });
  });
  socket.setTimeout(0);
  const log = await fs.open(path.join(bundle, 'payload.log'), 'a', 0o600);
  socket.on('data', bytes => { log.write(bytes).catch(() => {}); });
  socket.on('error', error => { log.write(error.message + '\n').catch(() => {}); });
  socket.once('close', () => { log.close().catch(() => {}); });
  await fs.writeFile(path.join(bundle, 'launched.json'), JSON.stringify({sentAt: Date.now()}), {mode: 0o600});
  socket.end(payload);
  socket.unref();
  return {pid: ready.pid, state: 'launched'};
}
