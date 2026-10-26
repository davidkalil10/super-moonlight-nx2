// Path of the hbmoonlight helper binary (tools/moonlight/helper), $HBMOONLIGHT first.
import os from 'node:os';
import path from 'node:path';

const HELPER =
  process.env.HBMOONLIGHT ||
  path.join(os.homedir(), 'claude-builds/HBLauncher/moonlight-helper/build/hbmoonlight');

export {HELPER};
