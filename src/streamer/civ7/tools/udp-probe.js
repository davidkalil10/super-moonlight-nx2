#!/usr/bin/env node
/**
 * Phase 0 UDP probe: paced datagrams to the console, which reports gaps, reorders and timing.
 *     node src/streamer/civ7/tools/udp-probe.js --console IP --host IP --directory NEW_DIR [--rates 20,40]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {attach} from '../transport.js';
import {sdkResolver} from '../sdk.js';
import {receiveBufferRequest} from '../socket-options.js';
import {runUdpProbe, UDP_PROBE} from '../udp-probe.js';

const {values} = parseArgs({options: {
  console: {type: 'string'}, host: {type: 'string'}, directory: {type: 'string'},
  rates: {type: 'string', default: '20,40'}, seconds: {type: 'string', default: '10'},
  mode: {type: 'string', default: 'auto'}, help: {type: 'boolean', short: 'h'}
}});

const USAGE = 'node src/streamer/civ7/tools/udp-probe.js --console IP --host IP --directory NEW_DIR ' +
  '[--rates 20,40] [--seconds 10] [--mode auto|recv|mmsg]';

/**
 * @param {(name: string) => Promise<number>} resolve
 * @param {string} name
 */
async function optional(resolve, name) {
  try {
    return '0x' + (await resolve(name)).toString(16);
  } catch {
    return undefined;
  }
}

/** @param {Record<string, any>} result */
function summary(result) {
  const share = (/** @type {number} */ part) => result.expected ? (100 * part / result.expected).toFixed(2) + '%' : '-';
  return `${result.rateMbps} Mbps ${result.mode}: ${result.received}/${result.expected} received, ` +
    `lost ${result.lost} (${share(result.lost)}), gaps ${result.gapEvents}, reorders ${result.reorders}, ` +
    `duplicates ${result.duplicates}, max arrival gap ${result.maxArrivalGapMs} ms, ` +
    `delay spread max ${result.delayMs?.maxMs} ms, rcvbuf ${JSON.stringify(result.rcvbuf)}, ` +
    `GetLastErrno ${result.errnoCallUs} us/call`;
}

if (values.help || !values.console || !values.host || !values.directory) {
  console.log(USAGE);
  if (!values.help) process.exitCode = 2;
} else {
  const rates = values.rates.split(',').map(Number);
  const seconds = Number(values.seconds);
  if (rates.some(rate => !(rate > 0 && rate <= 200)) || !(seconds > 0 && seconds <= 50))
    throw Error('Expected rates in (0, 200] Mbps and 0-50 s');
  if (!['auto', 'recv', 'mmsg'].includes(values.mode)) throw Error('Expected --mode auto, recv or mmsg');

  const directory = path.resolve(values.directory);
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const events = await fs.open(path.join(directory, 'events.jsonl'), 'wx', 0o600);
  /** @param {object} event */
  const log = async event => {
    const line = JSON.stringify({at: new Date().toISOString(), ...event});
    await events.write(line + '\n');
  };

  const rpc = await attach({consoleHost: values.console, hostAddress: values.host,
    log: message => process.stderr.write(message)});
  /** @type {number | undefined} */
  let buffer;
  try {
    const resolve = sdkResolver(rpc);
    const functions = {errno: '0x' + (await resolve('GetLastErrno')).toString(16)};
    const recvMMsg = await optional(resolve, 'RecvMMsg');
    const poll = await optional(resolve, 'Poll');
    const mode = values.mode === 'auto' ? (recvMMsg ? 'mmsg' : 'recv') : values.mode;
    if (mode === 'mmsg' && !recvMMsg) throw Error('RecvMMsg did not verify; use --mode recv');

    buffer = await rpc.allocate(UDP_PROBE.bufferBytes);
    const receiveBuffer = await receiveBufferRequest(rpc, buffer + UDP_PROBE.reportOffset, {resolve});
    await log({type: 'udp-probe-start', session: rpc.a.session, mode, rates, seconds,
      verified: {recvMMsg: Boolean(recvMMsg), poll: Boolean(poll), setSockOpt: Boolean(receiveBuffer)}});

    for (const [index, rateMbps] of rates.entries()) {
      const result = await runUdpProbe({rpc, hostAddress: values.host, buffer, rateMbps, seconds,
        mode: /** @type {'recv' | 'mmsg'} */ (mode), run: index + 1, receiveBuffer,
        functions: {...functions, ...(recvMMsg ? {recvMMsg} : {}), ...(poll ? {poll} : {})}});
      await log({type: 'udp-probe', ...result});
      console.log(summary(result));
    }
  } catch (error) {
    await log({type: 'udp-probe-error', error: error instanceof Error ? error.message : String(error)});
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (buffer !== undefined) await rpc.release(buffer).catch(() => {});
    await rpc.close().catch(() => {});
    await events.close();
  }
}
