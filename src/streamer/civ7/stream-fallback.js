// The codec and transport of one launch's sessions: a failed AV1 start runs again on H.264, a
// failed UDP start on TCP, each once per launch (README.md, "Fallbacks").
import {changeText} from './rate-badge.js';

/** @typedef {{codec: 'h264' | 'av1', transport: 'tcp' | 'udp'}} StreamChoice */

/** What each fallback changes, and its badge text. */
export const FALLBACKS = {
  codec: {from: 'av1', to: 'h264', text: changeText('AV1', 'H.264')},
  transport: {from: 'udp', to: 'tcp', text: changeText('UDP', 'TCP')}
};

/**
 * The fallback a failed start's error names (stream.js `withFallback`), or null.
 * @param {unknown} error
 * @returns {'codec' | 'transport' | null}
 */
export function fallbackOf(error) {
  if (!(error instanceof Error) || !('fallback' in error)) return null;

  const kind = error.fallback;
  if (kind === 'codec' || kind === 'transport') return kind;
  return null;
}

/** @param {unknown} error */
const errorText = error => error instanceof Error ? error.message : String(error);

/**
 * The one-time notice a failed start carries for the user (av1-decoder.js `AV1_RESTART_NOTICE`).
 * @param {unknown} error
 * @returns {{notice?: string}}
 */
function noticeOf(error) {
  const notice = error instanceof Error && 'notice' in error ? error.notice : undefined;
  return typeof notice === 'string' ? {notice} : {};
}

/**
 * `choice` with one fallback applied, or null when it does not apply to it.
 * @param {StreamChoice} choice
 * @param {'codec' | 'transport'} kind
 * @returns {StreamChoice | null}
 */
function applied(choice, kind) {
  if (kind === 'codec') return choice.codec === 'av1' ? {...choice, codec: 'h264'} : null;
  return choice.transport === 'udp' ? {...choice, transport: 'tcp'} : null;
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
        const next = kind ? applied(current, kind) : null;
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
