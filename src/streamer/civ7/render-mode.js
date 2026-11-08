import {TARGET} from '../../renderer/civ7/layout.js';

/** @import {Civ7Rpc} from './transport.js' */

/**
 * The active drawing area inside the retained layer, and the menu's presentation rate.
 * @param {{rpc: Pick<Civ7Rpc, 'write'>, storage: number, layer: {width: number, height: number},
 *   presenter: Pick<Awaited<ReturnType<typeof import('./presentation.js').createPresenter>>, 'resize' | 'run'>,
 *   refresh: Pick<ReturnType<typeof import('./refresh-rate.js').createRefreshRate>, 'set' | 'measured' | 'restore'>,
 *   input: object, log?: (event: object) => void}} options
 */
export function createRenderMode({rpc, storage, layer, presenter, refresh, input, log = () => {}}) {
  let active = '';
  let menu = '';

  /** @param {boolean} docked */
  async function apply(docked) {
    const size = docked ? {...layer} : {width: Math.min(1920, layer.width), height: Math.min(1080, layer.height)};
    const key = size.width + 'x' + size.height;
    if (key === active) return size;

    presenter.resize(size);
    const words = Buffer.alloc(8);
    words.writeUInt32LE(size.width, 0);
    words.writeUInt32LE(size.height, 4);
    await rpc.write(storage + TARGET.width, words);
    active = key;
    menu = '';
    log({event: 'render-size', ...size, backingWidth: layer.width, backingHeight: layer.height, docked});
    return size;
  }

  return {
    apply,
    invalidate() { menu = ''; },
    /** @param {boolean} docked */
    async menu(docked) {
      const size = await apply(docked);
      const requested = size.height > 1440 ? 60 : 120;
      const key = active + '@' + requested;
      if (menu === key) return;

      const selected = await refresh.set(requested);
      let fps = requested;
      let confirmed = requested === 60 && selected.ok;
      if (requested > 60 && selected.ok) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const measurement = await presenter.run(24, input);
          const state = await refresh.measured(measurement);
          const fast = measurement.frames * 1000 / measurement.elapsedMs >= requested * 0.9;
          if (state === 'raised' && fast) { confirmed = true; break; }
          if (state === 'failed') break;
        }
      }
      if (requested > 60 && !confirmed) {
        await refresh.restore('menu-rate-unconfirmed');
        fps = 60;
      }
      menu = key;
      log({event: 'menu-mode', ...size, requestedFps: requested, fps, confirmed, docked});
    }
  };
}
