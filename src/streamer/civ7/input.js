import {sdkResolver} from './sdk.js';
import {decode, NPAD_BYTES} from '../input/controller.js';

/** @import {Civ7Rpc} from './transport.js' */
/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */

/** @param {number | bigint} value */
const address = value => '0x' + BigInt(value).toString(16);

/**
 * Finds the connected controller and the console addresses createInputReader needs.
 * @param {Civ7Rpc} rpc
 * @param {number} controls the shader controls block
 */
export async function createInput(rpc, controls) {
  const resolve = sdkResolver(rpc);
  const styleFunction = await resolve('padStyle');
  const touch = await resolve('touch');
  const copy = await resolve('copy');
  /** @type {Record<number, string>} */
  const styles = {};
  /** @type {[number, string][]} */
  const styleReaders = [[1, 'padFullKey'], [2, 'padHandheld'], [4, 'padJoyDual']];
  for (const [bit, name] of styleReaders)
    styles[bit] = address(await resolve(name));
  const memory = await rpc.allocate(0x1000);
  try {
    await rpc.write(memory, Buffer.alloc(0x1000));
    const candidates = [];
    for (const id of [0x20, 0, 1, 2, 3, 4, 5, 6, 7]) {
      const value = Buffer.alloc(4);
      value.writeUInt32LE(id);
      await rpc.write(memory + 0x100, value);
      await rpc.callAddress(styleFunction, [memory + 0x104, memory + 0x100]);
      const style = (await rpc.read(memory + 0x104, 4)).readUInt32LE();
      const name = style & 1 ? 'padFullKey' : style & 2 ? 'padHandheld' : style & 4 ? 'padJoyDual' : null;
      if (!name) continue;
      const read = await resolve(name);
      await rpc.callAddress(read, [memory, memory + 0x100]);
      const pad = decode(await rpc.read(memory, NPAD_BYTES));
      candidates.push({id, style, name, read, pad});
      if (pad.connected) break;
    }
    const selected = candidates.find(item => item.pad.connected);
    if (!selected) throw Error('No supported connected controller');
    return {selected, configuration: {memory: address(memory), id: selected.id,
      read: address(selected.read), controls: address(controls), style: address(styleFunction), styles,
      touch: address(touch), copy: address(copy)},
      close: () => rpc.release(memory)};
  } catch (error) {
    await rpc.release(memory);
    throw error;
  }
}

/**
 * Console side, shipped by payload.js: each call reads the pad and touch, updates the shader
 * controls and returns the raw reads for input/input-record.js. `steady` says the pad's state
 * words match the last read and no touch point was down then or now.
 * @param {Pick<ConsoleNative, 'address' | 'integer' | 'checkMemory' | 'verified' | 'call' | 'read32' |
 *   'read64' | 'write32' | 'writeBuffer' | 'readMemory'>} native
 * @param {ConsoleRequest} configuration createInput's configuration
 */
export function createInputReader(native, configuration) {
  const {address, integer, checkMemory, verified, call, read32, read64, write32, writeBuffer, readMemory} = native;
  const memory = address(configuration.memory);
  const controls = address(configuration.controls);
  let read = address(configuration.read);
  if (!verified.has('0x' + read.toString(16))) throw Error('Unverified controller reader');
  checkMemory(memory, 0x1000, 3);
  checkMemory(controls, 40, 3);
  write32(memory + 0x100n, BigInt(integer(configuration.id, 0, 0x20)));
  const style = configuration.style ? address(configuration.style) : null;
  const touch = configuration.touch ? address(configuration.touch) : null;
  const copy = configuration.copy ? address(configuration.copy) : null;
  if (touch) checkMemory(controls + 128n, 656, 3);
  /** @type {Record<string, bigint>} */
  const styles = Object.fromEntries(Object.entries(configuration.styles || {}).map(([key, value]) => [key, address(value)]));
  for (const fn of [style, touch, copy, ...Object.values(styles)])
    if (fn && !verified.has('0x' + fn.toString(16))) throw Error('Unverified controller style function');
  /** @type {bigint[]} the last pad's words after its sampling number */
  let lastPad = [];
  let lastTouches = -1;

  /**
   * `qwords` aligned words from `pointer` as bytes, one word read per qword; `known` is one
   * already read.
   * @param {bigint} pointer @param {number} qwords @param {{index: number, value: bigint}} [known]
   */
  function words(pointer, qwords, known) {
    const bytes = new Uint8Array(qwords * 8);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < qwords; index++) {
      const value = index === known?.index ? known.value : read64(pointer + BigInt(index * 8));
      view.setBigUint64(index * 8, value, true);
    }
    return bytes;
  }

  /** @param {Uint8Array} pad */
  function samePad(pad) {
    const view = new DataView(pad.buffer);
    const current = [1, 2, 3, 4].map(index => view.getBigUint64(index * 8, true));
    const same = current.every((value, index) => value === lastPad[index]);
    lastPad = current;
    return same;
  }

  /** @param {Uint8Array} pad */
  const connected = pad => (pad[32] & 1) === 1;

  return () => {
    call(read, memory, memory + 0x100n);
    let pad = words(memory, 5);
    if (style && !connected(pad)) {
      let found = false;
      for (const id of [0x20, 0, 1, 2, 3, 4, 5, 6, 7]) {
        write32(memory + 0x100n, BigInt(id));
        call(style, memory + 0x104n, memory + 0x100n);
        const bits = Number(read32(memory + 0x104n));
        const key = [1, 2, 4].find(bit => bits & bit);
        if (!key) continue;
        read = styles[key];
        call(read, memory, memory + 0x100n);
        pad = words(memory, 5);
        if (connected(pad)) { found = true; break; }
      }
      if (!found) {
        pad = new Uint8Array(40);
        writeBuffer(memory, pad);
      }
    }
    if (copy) call(copy, controls, memory, 40n);
    else writeBuffer(controls, pad);
    const padSteady = samePad(pad);
    if (!touch) return {pad, touch: null, steady: padSteady};

    call(touch, memory + 0x400n);
    const head = read64(memory + 0x408n);
    const count = Number(head & 0xffffffffn);
    if (count > 16) throw Error('Invalid touch point count');
    if (copy) call(copy, controls + 128n, memory + 0x400n, 656n);
    else writeBuffer(controls + 128n, readMemory(memory + 0x400n, 656));
    const untouched = count === 0 && lastTouches === 0;
    lastTouches = count;
    return {pad, touch: words(memory + 0x400n, 2 + count * 5, {index: 1, value: head}), steady: padSteady && untouched};
  };
}
