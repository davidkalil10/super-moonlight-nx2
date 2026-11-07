import {create as createDecoder, MEMORY} from '../session/native-decoder.js';

/** @import {Civ7Rpc, NativeValue} from './transport.js' */

/**
 * The movie module on the civ7 transport: its functions verified at base + offset and a block of
 * console memory for the decoder's slots.
 * @param {Civ7Rpc} rpc
 * @param {{base: number, definitions: Record<string, {offset: number, hex: string}>, bytes?: number}} options
 */
async function createModule(rpc, {base, definitions, bytes = 0x10000}) {
  /** @type {Record<string, number>} */
  const functions = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const address = base + definition.offset;
    await rpc.request({command: 'verify-function', address, hex: definition.hex});
    functions[name] = address;
  }
  const memory = await rpc.allocate(bytes);
  let closed = false;
  /**
   * @param {number} offset
   * @param {number} length
   */
  function bounds(offset, length) {
    if (closed || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 0 || offset + length > bytes) throw Error('Invalid decoder memory range');
  }
  /** @param {string} name */
  function target(name) {
    if (closed || !Object.hasOwn(functions, name)) throw Error('Invalid decoder function');
    return functions[name];
  }
  return {
    base: memory, moduleBase: base, bytes, functions,
    /**
     * @param {string} name
     * @param {NativeValue[]} args
     */
    async call(name, args = []) {
      /** @type {Record<string, string>} */
      const destructors = {decoderCreate: 'decoderDestroy', decoderCreateMode: 'decoderDestroy',
        mediaCreate: 'mediaDestroy', bufferCreate: 'bufferDestroy'};
      const destructor = destructors[name];
      if (destructor) await rpc.resources?.prepare(memory, target(name), args,
        [{fn: functions[destructor], args: [args[0]], terminal: true}]);
      if (name === 'start') await rpc.resources?.prepare(memory, target(name), args,
        [{fn: functions.stop, args: [args[0]], expectedResult: 0}], 0);
      return (await rpc.callAddress(target(name), args)).result;
    },
    /**
     * @param {number} offset
     * @param {number} length
     */
    read(offset, length) {
      bounds(offset, length);
      return rpc.read(memory + offset, length);
    },
    /**
     * @param {number} offset
     * @param {Buffer} data
     */
    write(offset, data) {
      bounds(offset, data.length);
      return rpc.write(memory + offset, data);
    },
    async close() {
      if (!closed) {
        await rpc.release(memory);
        closed = true;
      }
      return true;
    }
  };
}

/**
 * The session's movie decoder on the civ7 transport, with the module memory and functions the
 * console-side decode batches use.
 * @param {{rpc: Civ7Rpc, directory: string, log?: (event: object) => void, mode?: number | null}} options
 */
export async function create({rpc, directory, log, mode}) {
  /** @type {Awaited<ReturnType<typeof createModule>> | undefined} */
  let module;
  const decoder = await createDecoder({directory, log, mode,
    openModule: async settings => (module = await createModule(rpc, settings))});
  if (!module) throw Error('Civ7 decoder module was not created');
  return Object.assign(decoder, {
    nativeContext: {
      memory: module.base,
      functions: {...module.functions},
      layout: {...MEMORY}
    }
  });
}
