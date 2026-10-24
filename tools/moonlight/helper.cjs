// Path of the hbmoonlight helper binary (tools/moonlight/helper), $HBMOONLIGHT first.
const os = require('node:os');
const path = require('node:path');

const HELPER =
  process.env.HBMOONLIGHT ||
  path.join(os.homedir(), 'claude-builds/HBLauncher/moonlight-helper/build/hbmoonlight');

module.exports = {HELPER};
