/** Worker for sorting splats.
 */

import MakeSorterModuleFactory from "./WasmSorter/Sorter.mjs";
// Import WASM as base64 URL for inlining - avoids import.meta.url issues with blob URLs.
import SorterWasmUrl from "./WasmSorter/Sorter.wasm?url";

export type SorterWorkerIncoming =
  | {
      setBuffer: Uint32Array;
      setGroupIndices: Uint32Array;
    }
  | {
      updateBuffer: Uint32Array;
      updateGroupIndices: Uint32Array;
    }
  | {
      setTz_camera_groups: Float32Array;
    }
  | { close: true };

{
  let sorter: any = null;
  let Tz_camera_groups: Float32Array | null = null;
  let sortRunning = false;
  const throttledSort = () => {
    if (sorter === null || Tz_camera_groups === null) {
      setTimeout(throttledSort, 1);
      return;
    }
    if (sortRunning) return;

    sortRunning = true;
    const lastView = Tz_camera_groups;

    // Important: we clone the output so we can transfer the buffer to the main
    // thread. Compared to relying on postMessage for copying, this reduces
    // backlog artifacts.
    const sortedIndices = (
      sorter.sort(Tz_camera_groups) as Uint32Array
    ).slice();

    // @ts-ignore
    self.postMessage({ sortedIndices: sortedIndices }, [sortedIndices.buffer]);

    setTimeout(() => {
      sortRunning = false;
      if (Tz_camera_groups === null) return;
      if (
        !lastView.every(
          // Cast is needed because of closure...
          (val, i) => val === (Tz_camera_groups as Float32Array)[i],
        )
      ) {
        throttledSort();
      }
    }, 0);
  };

  // Fetch WASM binary and pass to Emscripten module to avoid import.meta.url issues.
  const SorterModulePromise = fetch(SorterWasmUrl)
    .then((response) => response.arrayBuffer())
    .then((wasmBinary) => MakeSorterModuleFactory({ wasmBinary }));

  self.onmessage = async (e) => {
    const data = e.data as SorterWorkerIncoming;
    if ("setBuffer" in data) {
      // Instantiate sorter with buffers populated.
      sorter = new (await SorterModulePromise).Sorter(
        data.setBuffer,
        data.setGroupIndices,
      );
    } else if ("updateBuffer" in data) {
      // Update existing sorter with new buffer data.
      if (sorter !== null) {
        sorter.setBuffer(data.updateBuffer, data.updateGroupIndices);
        // Trigger immediate sort if we have camera data.
        if (Tz_camera_groups !== null) {
          throttledSort();
        }
      }
    } else if ("setTz_camera_groups" in data) {
      // Update object transforms.
      Tz_camera_groups = data.setTz_camera_groups;
      throttledSort();
    } else if ("close" in data) {
      // Done!
      self.close();
    }
  };
}
