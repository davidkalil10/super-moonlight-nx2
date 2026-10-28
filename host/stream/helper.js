/**
 * Path of the hbmoonlight helper binary built from tools/moonlight/helper. $HBMOONLIGHT wins
 * over the default build location.
 */
/** @type {string} */
const HELPER =
  process.env.HBMOONLIGHT ||
  '/media/storage2/builds/HBLauncher/moonlight-helper-main-47b81a0/build/hbmoonlight';

export {HELPER};
