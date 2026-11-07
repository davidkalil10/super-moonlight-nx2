#!/usr/bin/env node
/**
 * Prints a run's latency legs from its events.jsonl (or run directory): civ7/README.md, "Latency".
 *     node src/streamer/civ7/tools/latency-report.js RUN_DIR_OR_EVENTS_JSONL [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import {latencyReport} from '../latency.js';

const LABELS = {
  network: 'PC send -> console arrival',
  decode: 'arrival -> decoded',
  present: 'decoded -> present returned',
  input: 'input sample -> PC forward',
  ack: 'PC send -> ack (round trip)'
};

function readEvents(target) {
  const file = fs.statSync(target).isDirectory() ? path.join(target, 'events.jsonl') : target;
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return events;
}

const cell = value => (value === null || value === undefined ? '-' : value.toFixed(2)).padStart(8);

function print(report) {
  console.log(`${report.seconds} s with timing, ${report.frames} frames, ${report.caughtUp} caught up`);
  if (report.clock)
    console.log(`clock ±${report.clock.uncertaintyMs} ms (worst ±${report.clock.worstUncertaintyMs}), ` +
      `offset moved ${report.clock.offsetDriftMs} ms over the run`);
  else console.log('no clock sync: network and input legs are missing');
  for (const message of report.clockErrors) console.log('clock error: ' + message);

  console.log('\n' + 'leg'.padEnd(30) + 'p50'.padStart(8) + 'p90'.padStart(8) + 'max'.padStart(8) + '  frames');
  for (const [leg, label] of Object.entries(LABELS)) {
    const row = report.legs[leg];
    if (!row) continue;
    console.log(label.padEnd(30) + cell(row.p50) + cell(row.p90) + cell(row.max) + '  ' + row.frames);
  }

  const parts = ['network', 'decode', 'present'].map(leg => report.legs[leg]?.p50);
  if (parts.every(Number.isFinite))
    console.log('\nPC send -> present returned, sum of p50: ' + parts.reduce((a, b) => a + b, 0).toFixed(2) + ' ms');
  if (report.queueAgeMaxMs)
    console.log(`PC queue age (per-second max): p50 ${report.queueAgeMaxMs.p50} ms, max ${report.queueAgeMaxMs.max} ms`);
}

const args = process.argv.slice(2);
const target = args.find(arg => !arg.startsWith('--'));
if (!target) {
  console.error('usage: latency-report.js RUN_DIR_OR_EVENTS_JSONL [--json]');
  process.exit(2);
}

const report = latencyReport(readEvents(target));
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else print(report);
