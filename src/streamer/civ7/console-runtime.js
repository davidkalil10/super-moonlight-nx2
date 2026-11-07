// Types only: what the CivSwitch loader and runBridge (payload.js) hand the functions shipped by
// toString(). Shipped code names these through JSDoc comments, never at run time.

/**
 * A JSON request from the host. Every field is checked where it is read.
 * @typedef {{[field: string]: unknown}} ConsoleRequest
 */

/**
 * The loader's native primitives, as runBridge receives them.
 * @typedef {object} LoaderRuntime
 * @property {bigint} main
 * @property {bigint} sdk
 * @property {(pointer: bigint) => bigint} read64
 * @property {(pointer: bigint) => bigint} read32
 * @property {(pointer: bigint, value: bigint) => void} write64
 * @property {(pointer: bigint, value: number | bigint) => void} write32
 * @property {(pointer: bigint, length: number) => Uint8Array} readBuffer
 * @property {(pointer: bigint, bytes: Uint8Array) => void} writeBuffer
 * @property {(bytes: number) => bigint} allocate
 * @property {(pointer: bigint) => void} release
 * @property {(fn: bigint, ...args: bigint[]) => bigint} call call_rop: every argument is a bigint
 * @property {(domain: number, type: number, protocol: number) => bigint} socket
 * @property {(channel: bigint, address: bigint, length: number) => bigint} connect
 * @property {(channel: bigint, buffer: bigint, length: number, flags: number) => bigint} receive
 * @property {(channel: bigint, buffer: bigint, length: number, flags: number) => bigint} send
 * @property {(channel: bigint) => void} close
 * @property {(text: string) => Uint8Array} encode
 * @property {(bytes: Uint8Array) => string} decode
 */

/**
 * The checked helpers runBridge builds on top of the loader primitives.
 * @typedef {object} BridgeHelpers
 * @property {(value: unknown) => bigint} address a 0x string below 1 << 39
 * @property {(value: unknown, minimum: number, maximum: number) => number} integer
 * @property {(value: unknown) => bigint} argument a native register argument as u64
 * @property {(start: bigint, length: number, permissions: number) => void} checkMemory
 * @property {Set<string>} verified addresses whose signatures matched, as 0x text
 * @property {(pointer: bigint, length: number) => Uint8Array} readMemory
 * @property {(pointer: bigint, bytes: Uint8Array) => void} writeMemory
 * @property {(text: unknown) => Uint8Array} fromHex
 * @property {(bytes: Uint8Array) => string} toHex
 * @property {() => number} now
 */

/** @typedef {LoaderRuntime & BridgeHelpers} ConsoleNative */

export {};
