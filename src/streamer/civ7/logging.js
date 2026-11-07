/**
 * Caps each CivSwitch log call at 50 ms. Shipped by toString().
 * @template Timer
 * @param {{log?: unknown, __civ7BoundedLog?: boolean}} target the loader's window
 * @param {(callback: (value?: unknown) => void, ms: number) => Timer} schedule
 * @param {(timer: Timer) => void} cancel
 */
export function boundLoaderLogging(target, schedule, cancel) {
  if (target.__civ7BoundedLog) return;
  const original = target.log;
  if (typeof original !== 'function') throw Error('CivSwitch logger is missing');

  target.log = (/** @type {unknown} */ message) => new Promise((resolve, reject) => {
    const timer = schedule(resolve, 50);
    try {
      Promise.resolve(original(message)).then(value => {
        cancel(timer);
        resolve(value);
      }, error => {
        cancel(timer);
        reject(error);
      });
    } catch (error) {
      cancel(timer);
      reject(error);
    }
  });
  target.__civ7BoundedLog = true;
}
