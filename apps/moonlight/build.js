/**
 * Generates the HBV1 decoder include, the HBV2 tables, ring constants, an HBV2 test-card
 * keyframe for the initial private memory and the text atlas, then compiles the shaders into
 * backend one's section of the package.
 *
 * The platform build is imported only when main runs, so check.cjs can load testCard without
 * the shader toolchain.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import * as ring from '../../tools/moonlight/ring.js';
import {STATE} from '../../../hbl-platform/sdk/host/state-layout.js';
import {isMain} from '../../../hbl-platform/sdk/cli.js';
import * as hbv from '../../tools/moonlight/hbv.js';
import * as hbv2 from '../../tools/moonlight/hbv2.js';

/** Studio-range RGB colour bars across the top two thirds of the test card. */
const BARS = [
  [235, 235, 235],
  [235, 235, 16],
  [16, 235, 235],
  [16, 235, 16],
  [235, 16, 235],
  [235, 16, 16],
  [16, 16, 235]
];
const TEST_CARD_QP = 6;
/** Size of the initial launcher state buffer, state.bin in the backend section. */
const STATE_BYTES = 1024;
/** Backend one's section of the package: its shaders, SPIR-V and memory images. */
const BACKEND = 'backends/hblauncher.gpu-app';

/**
 * RGB24 test card: colour bars over a full-range grey ramp in the bottom third.
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function testCard(width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const color =
        y < (height * 2) / 3
          ? BARS[Math.floor((x * BARS.length) / width)]
          : Array(3).fill(Math.round((x * 255) / (width - 1)));
      color.forEach((value, c) => {
        rgb[(y * width + x) * 3 + c] = value;
      });
    }
  return rgb;
}

/**
 * Control words zeroed, the test card as keyframe TEST_CARD_SEQUENCE in its ring slot; the
 * rest of the allocation starts zeroed on the console.
 * @param {typeof hbv2} codec
 * @returns {Buffer}
 */
function initialMemory(codec) {
  const [width, height] = ring.TEST_CARD;
  const source = codec.toFrame(testCard(width, height), width, height);
  const slot = codec.encode(source, {sequence: ring.TEST_CARD_SEQUENCE, qp: TEST_CARD_QP});
  const offset = ring.slotOffset(ring.TEST_CARD_SEQUENCE);
  const memory = Buffer.alloc(offset + slot.length);
  slot.copy(memory, offset);
  return memory;
}

/**
 * The launcher state the app starts from: zeroed, with the screen fully faded in.
 * @returns {Buffer}
 */
function initialState() {
  const state = Buffer.alloc(STATE_BYTES);
  state.writeFloatLE(1, STATE.fade);
  return state;
}

async function main() {
  const output = name => path.join(import.meta.dirname, name);
  const backend = name => output(path.join(BACKEND, name));
  await fs.writeFile(backend('state.bin'), initialState());
  await fs.writeFile(backend('hbv.glsl'), hbv.glsl());
  await fs.writeFile(backend('hbv2-tables.glsl'), hbv2.glslTables());
  await fs.writeFile(backend('ring.glsl'), ring.glsl());
  await fs.writeFile(backend('memory.bin'), initialMemory(hbv2));
  execFileSync('python3', [output('assets.py')], {stdio: 'inherit'});
  const {headers, compile} = await import('../../../hbl-platform/sdk/build.js');
  await headers(output(BACKEND));
  compile(output('src/app.vert'), backend('app.vert.spv'));
  for (const stage of ['frag', 'comp'])
    compile(backend('app.' + stage), backend('app.' + stage + '.spv'));
}

if (isMain(import.meta))
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });

export {testCard};
