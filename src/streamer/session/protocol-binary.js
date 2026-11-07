/**
 * Path of the hbmoonlight helper binary built from src/streamer/protocol. $HBMOONLIGHT wins
 * over the default build location.
 */
/** @type {string} */
const HELPER =
  process.env.HBMOONLIGHT ||
  '/media/storage2/builds/moonlight/20261107T200357Z-19b4f09-helper/build/hbmoonlight';

export {HELPER};
