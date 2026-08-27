/** Shared zstd decompression.
 *
 * The production single-file build already ships a zstd WASM decoder in its
 * page loader (vite-plugin-compress-html.mts), which decompresses the bundle
 * itself and then exposes the compiled WebAssembly.Module on globalThis.
 * Reusing that module here keeps a second ~70 KiB copy of the same WASM out
 * of the app bundle.
 *
 * Workers can't see the main thread's globals, so they receive the module
 * via postMessage instead (WebAssembly.Module is structured-cloneable; see
 * WebsocketInterface.tsx / WebsocketClientWorker.ts).
 *
 * In dev builds and unit tests there is no page loader; the zstddec package
 * is imported dynamically instead. That import sits inside an
 * `import.meta.env.DEV` branch, so it is dead-code-eliminated from
 * production bundles.
 */

export interface ZstdDecoder {
  decode(data: Uint8Array, uncompressedSize: number): Uint8Array;
}

declare global {
  var __viserZstdWasm: WebAssembly.Module | undefined;
}

/** The zstd WASM module published by the single-file loader, when running
 * from a production build. */
export function getLoaderZstdModule(): WebAssembly.Module | undefined {
  return globalThis.__viserZstdWasm;
}

interface ZstdExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  ZSTD_decompress(
    dstPtr: number,
    dstSize: number,
    srcPtr: number,
    srcSize: number,
  ): number;
}

/** Instantiate a decoder from the given module, from the loader's published
 * module, or (dev/test only) from the zstddec package. */
export async function createZstdDecoder(
  module?: WebAssembly.Module,
): Promise<ZstdDecoder> {
  module = module ?? getLoaderZstdModule();
  if (module === undefined) {
    if (import.meta.env.DEV) {
      const { ZSTDDecoder } = await import("zstddec");
      const decoder = new ZSTDDecoder();
      await decoder.init();
      return decoder;
    }
    throw new Error(
      "zstd WASM module unavailable: expected the single-file loader to " +
        "publish it on globalThis, or a worker to receive it via postMessage.",
    );
  }

  let heap: Uint8Array;
  const instance = await WebAssembly.instantiate(module, {
    env: {
      emscripten_notify_memory_growth: () => {
        heap = new Uint8Array(exports.memory.buffer);
      },
    },
  });
  const exports = instance.exports as unknown as ZstdExports;
  heap = new Uint8Array(exports.memory.buffer);

  return {
    decode(data: Uint8Array, uncompressedSize: number): Uint8Array {
      const compressedPtr = exports.malloc(data.byteLength);
      heap.set(data, compressedPtr);
      const uncompressedPtr = exports.malloc(uncompressedSize);
      const actualSize = exports.ZSTD_decompress(
        uncompressedPtr,
        uncompressedSize,
        compressedPtr,
        data.byteLength,
      );
      const decompressed = heap.slice(
        uncompressedPtr,
        uncompressedPtr + actualSize,
      );
      exports.free(compressedPtr);
      exports.free(uncompressedPtr);
      return decompressed;
    },
  };
}
