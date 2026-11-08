// The codec of one launch's sessions: a failed AV1 start runs again on H.264, once per launch;
// and the size and rate they run at (README.md, "Fallbacks").
import {changeText, rateChangeText} from './rate-badge.js';

/** @typedef {{codec: 'h264' | 'av1'}} StreamChoice */

/** What each fallback changes, and its badge text. */
export const FALLBACKS = {
  codec: {from: 'av1', to: 'h264', text: changeText('AV1', 'H.264')}
};

/** The largest size H.264 and a handheld console stream; above it needs AV1 docked. */
export const BASE_SIZE = {width: 1920, height: 1080};
/** Above this height the console decodes 60 fps at most (2160p). */
const FAST_HEIGHT = 1440;

/**
 * The size one session runs at: the requested one, or 1080p above 1080p unless docked on AV1.
 * @param {{width: number, height: number}} requested
 * @param {{docked: boolean, codec: 'h264' | 'av1'}} session
 */
export function sessionSize({width, height}, {docked, codec}) {
  const fits = height <= BASE_SIZE.height || (docked && codec === 'av1');
  return fits ? {width, height} : {...BASE_SIZE};
}

/**
 * The rate a launch asks for: 60 at most when it will stream 2160p.
 * @param {{width: number, height: number, fps: number, codec: 'h264' | 'av1'}} requested
 * @param {boolean} docked
 */
export function launchRate(requested, docked) {
  const {height} = sessionSize(requested, {docked, codec: requested.codec});
  if (height <= FAST_HEIGHT) return requested.fps;

  return Math.min(requested.fps, 60);
}

/**
 * The badge text of a session that runs below what was asked: "1440p ▸ 1080p",
 * "2160p120 ▸ 2160p60".
 * @param {{height: number, fps: number}} requested
 * @param {{height: number, fps: number}} session
 * @returns {string[]}
 */
export function shapeChanges(requested, session) {
  const same = session.height === requested.height && session.fps === requested.fps;
  return same ? [] : [rateChangeText(requested, session)];
}

/**
 * The fallback a failed start's error names (stream.js `withFallback`), or null.
 * @param {unknown} error
 * @returns {'codec' | null}
 */
export function fallbackOf(error) {
  if (!(error instanceof Error) || !('fallback' in error)) return null;

  return error.fallback === 'codec' ? 'codec' : null;
}

/** @param {unknown} error */
const errorText = error => error instanceof Error ? error.message : String(error);

/**
 * The notice a failed start carries for the user (av1-decoder.js `AV1_RESTART_NOTICE`, stream.js
 * `UDP_START_ERROR`).
 * @param {unknown} error
 * @returns {{notice?: string}}
 */
export function noticeOf(error) {
  const notice = error instanceof Error && 'notice' in error ? error.notice : undefined;
  return typeof notice === 'string' ? {notice} : {};
}

/**
 * `choice` with the codec fallback applied, or null when it does not apply to it.
 * @param {StreamChoice} choice
 * @returns {StreamChoice | null}
 */
function applied(choice) {
  return choice.codec === 'av1' ? {...choice, codec: 'h264'} : null;
}

/**
 * The launch's current choice, starting at `choice`. `run` starts a session with it and the
 * badge texts of fallbacks not shown yet; a start whose error allows a fallback that still
 * applies runs again with it, so each fallback happens at most once and later sessions keep it.
 * @param {StreamChoice} choice
 * @param {{signal?: AbortSignal, log?: (event: object) => void}} [options]
 */
export function createStreamFallbacks(choice, {signal = undefined, log = event => {}} = {}) {
  let current = {...choice};
  /** @type {string[]} */
  let pending = [];

  /**
   * @template T
   * @param {(choice: StreamChoice, notes: string[]) => Promise<T>} start
   * @returns {Promise<T>}
   */
  async function run(start) {
    for (;;) {
      const notes = pending;
      pending = [];
      try {
        return await start({...current}, notes);
      } catch (error) {
        const kind = fallbackOf(error);
        const next = kind ? applied(current) : null;
        if (!kind || !next || signal?.aborted) throw error;

        const {from, to, text} = FALLBACKS[kind];
        log({type: 'stream-fallback', kind, from, to, reason: errorText(error), ...noticeOf(error)});
        current = next;
        pending = [...notes, text];
      }
    }
  }

  return {run, current: () => ({...current})};
}
