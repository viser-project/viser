import {
  radixSort,
  RadixSortOptions,
} from "three/examples/jsm/utils/SortUtils.js";
import type { InstancedRenderItem } from "../vendor/instanced-mesh/index.js";

/**
 * Creates a back-to-front (descending depth) radix sort for InstancedMesh2
 * render lists.
 *
 * The vendored `createRadixSort()` decides sort direction from `.transparent`
 * on `mesh.material`, which reads as undefined (opaque, front-to-back) for
 * material arrays. Viser only enables instance sorting when transparency is
 * in play, so the direction is always back-to-front and can be fixed here.
 * An O(n) radix sort matters at batched-mesh scale: a comparator
 * `Array.prototype.sort` is several times slower at large instance counts.
 */
export function createBackToFrontRadixSort(): (
  list: InstancedRenderItem[],
) => void {
  const options: RadixSortOptions<InstancedRenderItem> = {
    get: (el) => el.depthSort,
    aux: [],
    reversed: true,
  };

  return (list: InstancedRenderItem[]): void => {
    if (list.length > options.aux!.length) {
      options.aux!.length = list.length;
    }

    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const { depth } of list) {
      if (depth > maxZ) maxZ = depth;
      if (depth < minZ) minZ = depth;
    }

    // All depths equal (e.g. a single instance): any order is back-to-front.
    // Skipping also avoids the divide-by-zero below producing NaN sort keys.
    const depthDelta = maxZ - minZ;
    if (depthDelta === 0) return;

    // Normalize depths into the uint32 key range the radix sort operates on.
    const factor = (2 ** 32 - 1) / depthDelta;
    for (const item of list) {
      item.depthSort = (item.depth - minZ) * factor;
    }

    radixSort(list, options);
  };
}
