import * as THREE from "three";
import { AttributeSpec, syncBufferGeometry } from "./bufferGeometrySync";

/**
 * Update a point cloud's position/color attributes on an existing, persistent
 * BufferGeometry, reusing GPU buffers in place whenever the layout is unchanged.
 *
 * This is a thin wrapper over `syncBufferGeometry`; see that file for why buffer
 * reuse matters and how length/precision changes are handled leak-free and
 * without the three.js "Resizing buffer attributes is not supported" throw.
 */
export function syncPointCloudGeometry(
  geometry: THREE.BufferGeometry,
  points: Float32Array | Uint16Array, // Uint16Array carries float16 data.
  colors: Uint8Array,
): void {
  const pointsIsF32 = points instanceof Float32Array;
  const attributes: Record<string, AttributeSpec> = {
    position: { array: points, itemSize: 3, float16: !pointsIsF32 },
  };

  if (colors.length > 3) {
    attributes.color = { array: colors, itemSize: 3, normalized: true };
  } else if (colors.length < 3) {
    console.error(`Invalid color buffer length, got ${colors.length}`);
  }

  // Per-point -> uniform color transition: drop the stale per-point 'color'
  // attribute. three.js re-uploads every registered attribute regardless of
  // whether the material samples it, so leaving it registered costs bandwidth
  // every render (and serves stale data if per-point colors come back at a
  // matching length). Dispose BEFORE deleting: three only frees an
  // attribute's GL buffer via the geometry 'dispose' event, which walks the
  // attributes still present on the geometry -- deleteAttribute alone would
  // strand the GL buffer until the JS GC happens to reclaim the wrapper. The
  // surviving position attribute is re-uploaded into a fresh buffer on the
  // next render (same one-time cost as any realloc; this transition is rare).
  if (attributes.color === undefined && geometry.hasAttribute("color")) {
    geometry.dispose();
    geometry.deleteAttribute("color");
  }

  syncBufferGeometry(geometry, attributes);
}
