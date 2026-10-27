/**
 * Path of the hbmoonlight helper binary built from tools/moonlight/helper. $HBMOONLIGHT wins
 * over the default build location.
 */
import os from 'node:os';
import path from 'node:path';

/** @type {string} */
const HELPER =
  process.env.HBMOONLIGHT ||
  path.join(os.homedir(), 'claude-builds/HBLauncher/moonlight-helper/build/hbmoonlight');

export {HELPER};
