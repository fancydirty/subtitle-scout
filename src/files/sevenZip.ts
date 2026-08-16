import wasm from '7z-wasm'
import type { SevenZipModuleFactory } from '7z-wasm'

/** NodeNext types 7z-wasm's CJS default as a namespace; the runtime export is the factory. */
export const loadSevenZip = wasm as unknown as SevenZipModuleFactory
