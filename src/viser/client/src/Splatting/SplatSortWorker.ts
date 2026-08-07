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
      updateNumGroups: number;
    }
  | {
      setTz_camera_groups: Float32Array;
    }
  | { close: true };

{
  let sorter: any = null;
  let Tz_camera_groups: Float32Array | null = null;
  let sortRunning = false;
  // Set when updateBuffer swaps the sorter's contents; cleared when a sort
  // actually begins (that sort reads the new buffer). Without it, an
  // updateBuffer arriving while a sort runs is dropped by the throttle, and
  // the deferred retry below only re-sorts on a VIEW change -- so with a
  // stationary camera (the main thread only posts setTz_camera_groups when
  // groups move w.r.t. the camera) the stale order persisted indefinitely.
  let bufferDirty = false;
  const throttledSort = () => {
    if (sorter === null || Tz_camera_groups === null) {
      setTimeout(throttledSort, 1);
      return;
    }
    if (sortRunning) return;

    sortRunning = true;
    bufferDirty = false; // This sort consumes the latest buffer.
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
        bufferDirty ||
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

  const handleMessage = async (data: SorterWorkerIncoming) => {
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
        // Mark the swapped buffer as unsorted so the post-sort retry re-sorts
        // even when the view hasn't changed (throttledSort clears this when a
        // sort starts).
        bufferDirty = true;
        // If the group COUNT changed, the current Tz_camera_groups is the
        // wrong size: sort() derives num_groups from Tz's length, so it
        // would gather transforms past Tz's end (OOB heap read) for the new
        // group's splats. Drop the stale Tz and wait for a correctly-sized
        // one -- the next per-frame setTz_camera_groups. (Same group count:
        // the existing Tz is still valid, so sort immediately as before.)
        if (
          Tz_camera_groups !== null &&
          Tz_camera_groups.length / 4 !== data.updateNumGroups
        ) {
          Tz_camera_groups = null;
        }
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

  // Serialize handling in ARRIVAL order: the setBuffer branch awaits the
  // WASM module, and the browser does not await async onmessage handlers --
  // so an updateBuffer dispatched while that await was pending saw
  // `sorter === null` and was silently dropped, leaving the worker sorting
  // V1's centers while the renderer displayed V2's texture (same-size
  // results pass the main thread's length check, so the mismatch never
  // healed). Chaining guarantees updateBuffer runs after setBuffer
  // completes; errors are surfaced rather than wedging the chain.
  let chain: Promise<void> = Promise.resolve();
  self.onmessage = (e) => {
    const data = e.data as SorterWorkerIncoming;
    chain = chain.then(() => handleMessage(data)).catch(console.error);
  };
}
