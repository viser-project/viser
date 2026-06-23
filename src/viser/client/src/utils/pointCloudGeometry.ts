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

  syncBufferGeometry(geometry, attributes);
}
