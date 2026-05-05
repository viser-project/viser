// @ts-nocheck
import { Material } from 'three';
import { radixSort, RadixSortOptions } from 'three/addons/utils/SortUtils.js';
import { InstancedMesh2 } from '../core/InstancedMesh2.js';
import { InstancedRenderItem } from '../core/utils/InstancedRenderList.js';

type radixSortCallback = (list: InstancedRenderItem[]) => void;

/**
 * Creates a radix sort function specifically for sorting `InstancedMesh2` instances.
 * The sorting is based on the `depth` property of each `InstancedRenderItem`.
 * This function dynamically adjusts for transparent materials by reversing the sort order if necessary.
 * @param target The `InstancedMesh2` instance that contains the instances to be sorted.
 * @returns A radix sort function.
 */
// Reference: https://github.com/mrdoob/three.js/blob/master/examples/webgl_mesh_batch.html#L291
export function createRadixSort(target: InstancedMesh2): radixSortCallback {
  const options: RadixSortOptions<InstancedRenderItem> = {
    get: (el) => el.depthSort,
    aux: new Array(target._capacity),
    reversed: false
  };

  return function sortFunction(list: InstancedRenderItem[]): void {
    options.reversed = !!(target.material as Material)?.transparent; // multimaterials are considered opaque

    if (target._capacity > options.aux.length) {
      options.aux.length = target._capacity;
    }

    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const { depth } of list) {
      if (depth > maxZ) maxZ = depth;
      if (depth < minZ) minZ = depth;
    }

    const depthDelta = maxZ - minZ;
    const factor = (2 ** 32 - 1) / depthDelta;

    for (const item of list) {
      item.depthSort = (item.depth - minZ) * factor;
    }

    radixSort(list, options);
  };
}

/** @internal */
export function sortOpaque(a: InstancedRenderItem, b: InstancedRenderItem): number {
  return a.depth - b.depth;
}

/** @internal */
export function sortTransparent(a: InstancedRenderItem, b: InstancedRenderItem): number {
  return b.depth - a.depth;
}
