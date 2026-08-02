import type * as THREE from "three";
import { radixSort } from "three/examples/jsm/utils/SortUtils.js";
import type { RadixSortOptions } from "three/examples/jsm/utils/SortUtils.js";
import type { InstancedRenderItem } from "../vendor/instanced-mesh/index.js";

// Largest key radixSort can bucket: it reads keys as unsigned 32-bit ints.
const UINT32_MAX = 2 ** 32 - 1;

/**
 * Whether a batched mesh's material (or any material in a multi-material
 * array) blends, and therefore needs its instances drawn back-to-front.
 */
export function isTransparentMaterial(
  material: THREE.Material | THREE.Material[],
): boolean {
  return Array.isArray(material)
    ? material.some((m) => m.transparent)
    : material.transparent;
}

/**
 * Build a per-frame sort callback that orders a batched mesh's visible
 * instances farthest-first.
 *
 * Three.js sorts *objects*, not instances. Every instance of a batched mesh
 * shares one draw call, so a transparent batch gets a single depth sort for
 * the whole object and then draws its instances in buffer order -- the
 * blend is wrong, and the artifacts shift discontinuously as the camera
 * orbits. InstancedMesh2 hands us the visible instances plus their
 * view-space depths each frame; reordering them here is what makes alpha
 * compositing correct.
 *
 * We use a radix sort (linear time, following three.js's own batched-mesh
 * example) rather than the vendor's default comparison sort, since this runs
 * every frame at the instance counts batched meshes exist for. Note that the
 * vendor ships an equivalent `createRadixSort()`, but it keys its sort
 * direction off `mesh.material.transparent` -- which is `undefined` for the
 * multi-material arrays that batched GLB assets produce, silently flipping
 * them to front-to-back. We only install this callback on transparent
 * meshes, so the direction is unconditional.
 */
export function createBackToFrontSort(): (list: InstancedRenderItem[]) => void {
  // Scratch buffer for radixSort's ping-pong passes. Kept across frames and
  // grown as needed, so a steady-state render allocates nothing.
  const aux: InstancedRenderItem[] = [];
  const options: RadixSortOptions<InstancedRenderItem> = {
    get: (item) => item.depthSort,
    aux,
    reversed: true, // Descending depth: farthest instance drawn first.
  };

  return function sortBackToFront(list: InstancedRenderItem[]): void {
    const count = list.length;
    if (count < 2) return;

    // `depth` is distance along the camera's forward axis, so it can be
    // negative (instances behind the camera plane) and is unbounded.
    // radixSort needs unsigned 32-bit keys, so rescale the observed range
    // onto [0, UINT32_MAX] -- this is monotonic, which is all sorting needs.
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    for (let i = 0; i < count; i++) {
      const depth = list[i].depth;
      if (depth < minDepth) minDepth = depth;
      if (depth > maxDepth) maxDepth = depth;
    }

    // A zero span (every instance equidistant) or an infinite one (an
    // instance at an infinite position) makes the rescale factor Infinity,
    // and radixSort's `key >>> 0` would quietly turn every key into 0. There
    // is no meaningful order to produce in either case, so leave the list as
    // it is rather than shuffling it into an arbitrary one. An isolated NaN
    // depth doesn't reach here -- NaN loses every comparison above, so the
    // span stays finite, that one instance keys to 0, and it sorts to the
    // back while the rest of the batch orders correctly.
    const depthSpan = maxDepth - minDepth;
    if (!(depthSpan > 0 && depthSpan < Infinity)) return;

    const scale = UINT32_MAX / depthSpan;
    for (let i = 0; i < count; i++) {
      const item = list[i];
      item.depthSort = (item.depth - minDepth) * scale;
    }

    if (aux.length < count) aux.length = count;
    radixSort(list, options);
  };
}
