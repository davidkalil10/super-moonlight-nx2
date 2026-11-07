import fs from 'node:fs/promises';
import path from 'node:path';
import {functionResolver} from './modules.js';

/** @import {Civ7Rpc} from './transport.js' */
/** @import {Civ7Reply} from './protocol.js' */
/** @import {ModuleDescription} from './modules.js' */

/**
 * The launcher menu fields the presenter reads; handles are decimal strings.
 * @typedef {{session: unknown, ready: boolean, resources: {device: string, queue: string, swapchain: string,
 *   acquired: string, semaphores: string[]}}} PresenterMenu
 */

/**
 * `slots` is the renderer's per-slot presentation (renderer-pipelines.js).
 * @typedef {{interactive: string[][], streaming: string[][], acquired: string[], fences: string[]}} PresenterSlots
 * @typedef {{session: unknown, ready: boolean, commands: string[][], slots: PresenterSlots}} PresenterApp
 */

const address = (/** @type {number | bigint | string} */ value) => '0x' + BigInt(value).toString(16);

/** @param {PresenterSlots} slots */
function presenterSlots(slots) {
  const lists = (/** @type {string[][]} */ value) => value.map(list => list.map(address));
  return {interactive: lists(slots.interactive), streaming: lists(slots.streaming),
    acquired: slots.acquired.map(address), fences: slots.fences.map(address)};
}

/**
 * @param {Pick<Civ7Rpc, 'a' | 'allocate' | 'release' | 'request' | 'read' | 'verifiedFunctions'>} rpc
 * @param {string} directory
 * @param {PresenterMenu} menu
 * @param {PresenterApp} app
 */
export async function createPresenter(rpc, directory, menu, app) {
  if (menu.session !== rpc.a.session || app.session !== rpc.a.session || !menu.ready || !app.ready)
    throw Error('Presentation resources do not belong to this running session');
  /** @type {ModuleDescription} */
  const module = JSON.parse(await fs.readFile(path.join(directory, 'compatibility-module.json'), 'utf8'));
  const resolve = functionResolver(rpc, module);
  /** @type {Record<string, string>} */
  const functions = {};
  const names = {acquire: 'vkAcquireNextImage2KHR', submit: 'vkQueueSubmit', present: 'vkQueuePresentKHR',
    wait: 'vkQueueWaitIdle', waitFences: 'vkWaitForFences', resetFences: 'vkResetFences'};
  for (const [key, name] of Object.entries(names)) functions[key] = address(await resolve(name));
  const memory = await rpc.allocate(0x1000);
  const resources = menu.resources;
  const configuration = {memory: address(memory), functions,
    device: address(resources.device), queue: address(resources.queue),
    swapchain: address(resources.swapchain), acquired: address(resources.acquired),
    commands: app.commands[0].map(address), semaphores: resources.semaphores.map(address),
    slots: presenterSlots(app.slots)};
  let closed = false;
  return {
    configuration,
    /**
     * `intervals` also asks for the ms between presents.
     * @param {number} frames @param {object} [input] @param {{intervals?: boolean}} [options]
     */
    async run(frames, input = undefined, {intervals = false} = {}) {
      if (closed) throw Error('Presenter is closed');
      const request = {command: 'present-batch', ...configuration, frames, ...(input ? {input} : {}),
        ...(intervals ? {intervals: true} : {})};
      const reply = await rpc.request(request);
      if (typeof reply.frames !== 'number' || typeof reply.elapsedMs !== 'number')
        throw Error('Invalid present-batch reply');
      return /** @type {Civ7Reply & {frames: number, elapsedMs: number, intervals?: number[]}} */ (reply);
    },
    async close() {
      if (closed) return;
      await rpc.release(memory);
      closed = true;
    }
  };
}
