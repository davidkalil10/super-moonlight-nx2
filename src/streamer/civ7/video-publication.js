/** @import {ConsoleNative, ConsoleRequest} from './console-runtime.js' */

/**
 * The ring layout payload.js inlines from shared/ring.js.
 * @typedef {{control: Record<string, number>, frameBytes: number, framesOffset: number, nativeABI: number}}
 *   PublicationLayout
 */

/** @typedef {{width: number, height: number, stride: number, sliceHeight: number}} FrameFormat */

/**
 * Console side, shipped by payload.js: publishes each decoded frame by writing its frame slot's
 * own words, which the slot's command buffers read directly; README.md, "Frame slots".
 * @param {Pick<ConsoleNative, 'address' | 'integer' | 'checkMemory' | 'read32' | 'write32' | 'call'> & {
 *   publicationLayout: PublicationLayout}} native
 * @param {ConsoleRequest} request
 * @param {{functions: Record<string, bigint>, slots: Record<string, bigint>, destination: bigint,
 *   destinationBytes: number, alternate?: bigint | null, format?: {stride: number, sliceHeight: number}}}
 *   context decodeBatch's verified functions and decoder slots; `alternate` is a second destination,
 *   the frame `request.alternate`; `format` is a layout the decoder fixes (AV1), in place of the
 *   movie output format
 */
export function createFramePublication(native, request, context) {
  const {address, integer, checkMemory, read32, write32, call} = native;
  const {control, frameBytes, framesOffset, nativeABI} = native.publicationLayout;
  const {functions, slots, destination, destinationBytes} = context;
  const memory = address(request.address);
  const index = integer(request.index, 0, 2);
  const color = integer(request.color, 1, 2);
  const width = integer(request.width, 2, 1920);
  const height = integer(request.height, 2, 1088);
  const alternate = context.alternate ? integer(request.alternate, 0, 2) : index;
  const frameAt = (/** @type {number} */ frame) => memory + BigInt(framesOffset + frame * frameBytes);
  checkMemory(memory, 0x10000, 3);
  if (read32(memory + BigInt(control.nativeReady)) !== BigInt(nativeABI))
    throw Error('Moonlight shader ABI is not ready');
  if (destination !== frameAt(index) || destinationBytes !== frameBytes)
    throw Error('Decoder destination differs from the Moonlight frame');
  if (context.alternate && (alternate === index || context.alternate !== frameAt(alternate)))
    throw Error('Alternate destination differs from its Moonlight frame');
  /** @type {FrameFormat | undefined} */
  let format;
  const slotLayout = checkedSlots(/** @type {Record<string, unknown>} */ (request.slots));
  /** The shader only reads the metadata words, so a word is stored again only when it changes. */
  const slotStored = [Array(5).fill(-1), Array(5).fill(-1)];
  const slotSequences = [0, 0];
  let moded = false;
  if (index !== 0 || (context.alternate && alternate !== 1))
    throw Error('Frame slots need frames 0 and 1');

  /**
   * @param {string} name
   * @param {number} fallback
   */
  function field(name, fallback) {
    for (let offset = 0; offset < 32; offset += 4) {
      let value = 0;
      for (let byte = 0; byte < 4; byte++) value |= (name.charCodeAt(offset + byte) || 0) << (byte * 8);
      write32(slots.key + BigInt(offset), BigInt(value >>> 0));
    }
    write32(slots.value, 0n);
    const found = call(functions.mediaFindInt, slots.format, slots.key, slots.value);
    return found ? Number(read32(slots.value)) : fallback;
  }

  /** The decoder's frame layout: fixed by the caller, or read from the movie output format. */
  function decoderLayout() {
    if (context.format) return {width, height, ...context.format};

    const actualWidth = field('width', width);
    const actualHeight = field('height', height);
    return {width: actualWidth, height: actualHeight, stride: field('stride', actualWidth),
      sliceHeight: field('slice-height', actualHeight)};
  }

  /** @param {boolean} [second] the frame is in the alternate destination */
  function publish(second = false) {
    if (!format) {
      const {width: actualWidth, height: actualHeight, stride, sliceHeight} = decoderLayout();
      if (actualWidth !== width || actualHeight !== height || stride < width || sliceHeight < height ||
          stride % 2 || sliceHeight % 2 || stride * sliceHeight * 3 / 2 > frameBytes)
        throw Error('Unsupported presentation frame layout');
      format = {width, height, stride, sliceHeight};
    }
    publishSlot(second ? 1 : 0, format);
  }

  /**
   * Two slots of word fields; the bounds keep both inside the checked control block.
   * @param {Record<string, unknown> | undefined} layout
   */
  function checkedSlots(layout) {
    if (!layout) throw Error('Frame publication needs frame slots');
    const base = integer(layout.base, 0x100, 0xf000);
    const slotBytes = integer(layout.slotBytes, 24, 0x100);
    /** @type {Record<string, number>} */
    const checked = {base, slotBytes, mode: integer(layout.mode, 1, 8)};
    for (const field of ['sequence', 'width', 'height', 'stride', 'sliceHeight', 'color']) {
      const offset = integer(layout[field], 0, slotBytes - 4);
      if (offset % 4) throw Error('Unaligned frame slot field');
      checked[field] = offset;
    }
    return checked;
  }

  /**
   * @param {number} slot
   * @param {FrameFormat} frame
   */
  function publishSlot(slot, frame) {
    const layout = slotLayout;
    const base = memory + BigInt(layout.base + slot * layout.slotBytes);
    const fields = ['width', 'height', 'stride', 'sliceHeight', 'color'];
    const values = [frame.width, frame.height, frame.stride, frame.sliceHeight, color];
    for (let field = 0; field < fields.length; field++) {
      if (slotStored[slot][field] === values[field]) continue;

      write32(base + BigInt(layout[fields[field]]), BigInt(values[field]));
      slotStored[slot][field] = values[field];
    }
    slotSequences[slot] = (slotSequences[slot] + 1) >>> 0 || 1;
    write32(base + BigInt(layout.sequence), BigInt(slotSequences[slot]));
    if (moded) return;

    write32(memory + BigInt(control.mode), BigInt(layout.mode));
    moded = true;
  }

  return {publish, layout: () => format};
}
