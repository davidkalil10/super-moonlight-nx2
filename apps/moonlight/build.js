// Generates the HBV1 decoder include, the HBV2 tables, ring constants, an HBV2
// test-card keyframe for the initial private memory and the text atlas, then
// compiles the shaders.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import * as ring from '../../tools/moonlight/ring.js';
import {STATE} from '../../../hbl-platform/sdk/host/state-layout.js';
import {isMain} from '../../../hbl-platform/sdk/cli.js';
import * as hbv from '../../tools/moonlight/hbv.js';
import * as hbv2 from '../../tools/moonlight/hbv2.js';

function testCard(width, height) {
  const bars = [
    [235, 235, 235],
    [235, 235, 16],
    [16, 235, 235],
    [16, 235, 16],
    [235, 16, 235],
    [235, 16, 16],
    [16, 16, 235]
  ];
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const color =
        y < (height * 2) / 3
          ? bars[Math.floor((x * bars.length) / width)]
          : Array(3).fill(Math.round((x * 255) / (width - 1)));
      color.forEach((value, c) => {
        rgb[(y * width + x) * 3 + c] = value;
      });
    }
  return rgb;
}

// Control words zeroed, the test card as keyframe TEST_CARD_SEQUENCE in its
// ring slot; the rest of the allocation starts zeroed on the console.
function initialMemory(hbv2) {
  const [width, height] = ring.TEST_CARD,
    source = hbv2.toFrame(testCard(width, height), width, height),
    slot = hbv2.encode(source, {sequence: ring.TEST_CARD_SEQUENCE, qp: 6}),
    offset = ring.slotOffset(ring.TEST_CARD_SEQUENCE),
    memory = Buffer.alloc(offset + slot.length);
  slot.copy(memory, offset);
  return memory;
}

async function main() {
  const state = Buffer.alloc(1024);
  state.writeFloatLE(1, STATE.fade);
  await fs.writeFile(path.join(import.meta.dirname, 'assets/state.bin'), state);
  await fs.writeFile(path.join(import.meta.dirname, 'shaders/hbv.glsl'), hbv.glsl());
  await fs.writeFile(path.join(import.meta.dirname, 'shaders/hbv2-tables.glsl'), hbv2.glslTables());
  await fs.writeFile(path.join(import.meta.dirname, 'shaders/ring.glsl'), ring.glsl());
  await fs.writeFile(path.join(import.meta.dirname, 'assets/memory.bin'), initialMemory(hbv2));
  execFileSync('python3', [path.join(import.meta.dirname, 'assets.py')], {stdio: 'inherit'});
  const {buildApp} = await import('../../../hbl-platform/sdk/build.js');
  await buildApp(import.meta.dirname);
}

if (isMain(import.meta))
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
export {testCard};
