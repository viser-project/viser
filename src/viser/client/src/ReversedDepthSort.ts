/** Workaround for inverted `renderOrder` under a reversed depth buffer in three r185.
 *
 * We render with `reversedDepthBuffer: true` for depth precision. r185's
 * "Fix sort of render lists with reversed depth buffer"
 * (https://github.com/mrdoob/three.js/pull/33700) made `WebGLRenderList.sort()`
 * reverse the opaque, transmissive, and transparent lists after sorting them,
 * whenever the camera renders with a reversed depth buffer:
 *
 * ```js
 * if ( opaque.length > 1 ) opaque.sort( customOpaqueSort || painterSortStable );
 * // ...
 * if ( reversedDepth ) {
 *   opaque.reverse();
 *   transmissive.reverse();
 *   transparent.reverse();
 * }
 * ```
 *
 * Flipping the list does fix depth: the projected `z` the default comparators
 * sort on has the opposite sign under a reversed depth buffer, so reversing
 * restores near-to-far for opaque and far-to-near for transparent. But the flip
 * also inverts the `groupOrder` and `renderOrder` keys, which are absolute -- an
 * object with `renderOrder = 10000` is supposed to draw last, and instead drew
 * first.
 *
 * That silently broke every explicit draw order in the viewer: scene labels
 * (their white background quad started painting over the text, which is what
 * made labels look washed out -- issue #767), Gaussian splats, outlines, and the
 * transform gizmos all rely on `renderOrder`.
 *
 * The comparators below sort into the exact reverse of the order we want, so
 * three's flip lands on the intended order: `groupOrder` and `renderOrder`
 * ascending, with the same `z` handling three arrives at on its own.
 *
 * r186 fixes this properly -- https://github.com/mrdoob/three.js/pull/33945
 * negates the projected `z` in `projectObject()` instead of reversing the sorted
 * lists, so `renderOrder` and custom comparators keep working. r185 is the only
 * affected release, so this is gated on the revision and should be deleted
 * outright when the three dependency moves past it.
 */
import * as THREE from "three";

/** The three revision that reverses its sorted render lists. */
const AFFECTED_REVISION = "185";

/** The subset of three's render-item shape that the comparators read. */
interface RenderItem {
  id: number;
  groupOrder: number;
  renderOrder: number;
  z: number;
  // `Material.id` exists at runtime but is missing from @types/three, so this
  // is structural rather than `THREE.Material`.
  material: { id: number };
  materialVariant: number;
}

/** Pre-inverted counterpart of three's `painterSortStable`. */
export function reversedDepthOpaqueSort(a: RenderItem, b: RenderItem): number {
  if (a.groupOrder !== b.groupOrder) {
    return b.groupOrder - a.groupOrder;
  } else if (a.renderOrder !== b.renderOrder) {
    return b.renderOrder - a.renderOrder;
  } else if (a.material.id !== b.material.id) {
    return b.material.id - a.material.id;
  } else if (a.materialVariant !== b.materialVariant) {
    return b.materialVariant - a.materialVariant;
  } else if (a.z !== b.z) {
    // Not inverted: three's flip is what makes this near-to-far, and we want to
    // keep the depth ordering it produces.
    return a.z - b.z;
  } else {
    return b.id - a.id;
  }
}

/** Pre-inverted counterpart of three's `reversePainterSortStable`. */
export function reversedDepthTransparentSort(
  a: RenderItem,
  b: RenderItem,
): number {
  if (a.groupOrder !== b.groupOrder) {
    return b.groupOrder - a.groupOrder;
  } else if (a.renderOrder !== b.renderOrder) {
    return b.renderOrder - a.renderOrder;
  } else if (a.z !== b.z) {
    // Not inverted, as above: the flip turns this into far-to-near.
    return b.z - a.z;
  } else {
    return b.id - a.id;
  }
}

/**
 * Whether the compensating comparators apply.
 *
 * `capabilities.reversedDepthBuffer` is true only if we asked for a reversed
 * depth buffer *and* `EXT_clip_control` is available; without the extension
 * three never flips the lists. The revision check keeps the workaround from
 * outliving the r185 behavior it compensates for -- installing these comparators
 * on r186+ would invert `renderOrder` rather than fix it.
 */
export function needsReversedDepthSortFix(
  revision: string,
  reversedDepthBuffer: boolean,
): boolean {
  return reversedDepthBuffer && revision === AFFECTED_REVISION;
}

/** Install the compensating comparators, if this three build needs them. */
export function applyReversedDepthSortFix(gl: THREE.WebGLRenderer): void {
  if (
    !needsReversedDepthSortFix(
      THREE.REVISION,
      gl.capabilities.reversedDepthBuffer,
    )
  ) {
    return;
  }
  gl.setOpaqueSort(reversedDepthOpaqueSort);
  gl.setTransparentSort(reversedDepthTransparentSort);
}
