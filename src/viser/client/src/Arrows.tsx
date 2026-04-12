/**
 * Component for rendering arrow meshes (shaft + head) using instanced rendering.
 *
 * Uses two BatchedMeshBase instances (shafts and heads) for efficient batched
 * rendering -- 2 draw calls total regardless of arrow count.
 */
import React, { useMemo, useEffect } from "react";
import * as THREE from "three";
import { ArrowMessage } from "./WebsocketMessages";
import { normalizeScale } from "./utils/normalizeScale";
import { BatchedMeshBase } from "./mesh/BatchedMeshBase";

// Unit geometries shared across all Arrows instances.
// BatchedMeshBase clones them internally so these are never disposed.
const SHAFT_GEOMETRY = new THREE.CylinderGeometry(1, 1, 1, 16);
const HEAD_GEOMETRY = new THREE.ConeGeometry(1, 1, 16);
const UP = new THREE.Vector3(0, 1, 0);

export const Arrows = React.forwardRef<
  THREE.Group,
  ArrowMessage & { children?: React.ReactNode }
>(function Arrows({ props, children }, ref) {
  const { points, colors, shaft_radius, head_radius, head_length, scale } =
    props;

  const numArrows = points.length / 6;

  const material = useMemo(() => new THREE.MeshStandardMaterial(), []);
  useEffect(() => () => material.dispose(), [material]);

  // Compute per-instance transforms and colors for shafts and heads.
  const instanceData = useMemo(() => {
    const shaftPositions = new Float32Array(numArrows * 3);
    const shaftScales = new Float32Array(numArrows * 3);
    const headPositions = new Float32Array(numArrows * 3);
    const headScales = new Float32Array(numArrows * 3);
    // Shafts and heads share the same orientation per arrow.
    const wxyzs = new Float32Array(numArrows * 4);

    const start = new THREE.Vector3();
    const end = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const q = new THREE.Quaternion();

    for (let i = 0; i < numArrows; i++) {
      start.set(points[i * 6], points[i * 6 + 1], points[i * 6 + 2]);
      end.set(points[i * 6 + 3], points[i * 6 + 4], points[i * 6 + 5]);

      dir.subVectors(end, start);
      const arrowLength = dir.length();

      if (arrowLength < 1e-8) {
        dir.set(0, 1, 0);
      } else {
        dir.divideScalar(arrowLength);
      }

      const shaftLength = Math.max(arrowLength - head_length, 0);

      // Shaft midpoint: center of [start, headBase] where headBase = end - dir * head_length.
      const headBaseX = end.x - dir.x * head_length;
      const headBaseY = end.y - dir.y * head_length;
      const headBaseZ = end.z - dir.z * head_length;

      shaftPositions[i * 3] = (start.x + headBaseX) * 0.5;
      shaftPositions[i * 3 + 1] = (start.y + headBaseY) * 0.5;
      shaftPositions[i * 3 + 2] = (start.z + headBaseZ) * 0.5;

      // Head center: end - dir * head_length * 0.5.
      // ConeGeometry is centered at origin (base at -h/2, tip at +h/2 along Y),
      // so this places the base exactly at headBase and the tip at end.
      headPositions[i * 3] = end.x - dir.x * head_length * 0.5;
      headPositions[i * 3 + 1] = end.y - dir.y * head_length * 0.5;
      headPositions[i * 3 + 2] = end.z - dir.z * head_length * 0.5;

      // Rotation aligning +Y axis to arrow direction.
      q.setFromUnitVectors(UP, dir);
      wxyzs[i * 4] = q.w;
      wxyzs[i * 4 + 1] = q.x;
      wxyzs[i * 4 + 2] = q.y;
      wxyzs[i * 4 + 3] = q.z;

      // Per-axis scales: unit geometry, so scale directly encodes radius/length.
      shaftScales[i * 3] = shaft_radius;
      shaftScales[i * 3 + 1] = shaftLength;
      shaftScales[i * 3 + 2] = shaft_radius;
      headScales[i * 3] = head_radius;
      headScales[i * 3 + 1] = head_length;
      headScales[i * 3 + 2] = head_radius;
    }

    // Split colors into shaft (start point) and head (end point) arrays.
    // BatchedMeshBase treats byteLength === 3 as a uniform broadcast, and
    // byteLength === N * 3 as per-instance colors.
    let shaftColors: Uint8Array<ArrayBuffer>;
    let headColors: Uint8Array<ArrayBuffer>;

    if (colors.length === 3) {
      shaftColors = colors;
      headColors = colors;
    } else {
      // colors has flat layout (N, 2, 3): index 0 = shaft, index 1 = head.
      shaftColors = new Uint8Array(numArrows * 3);
      headColors = new Uint8Array(numArrows * 3);
      for (let i = 0; i < numArrows; i++) {
        shaftColors[i * 3] = colors[i * 6];
        shaftColors[i * 3 + 1] = colors[i * 6 + 1];
        shaftColors[i * 3 + 2] = colors[i * 6 + 2];
        headColors[i * 3] = colors[i * 6 + 3];
        headColors[i * 3 + 1] = colors[i * 6 + 4];
        headColors[i * 3 + 2] = colors[i * 6 + 5];
      }
    }

    return { shaftPositions, shaftScales, headPositions, headScales, wxyzs, shaftColors, headColors };
  }, [points, colors, head_length, shaft_radius, head_radius]);

  return (
    <group ref={ref}>
      <group scale={normalizeScale(scale)}>
        <BatchedMeshBase
          geometry={SHAFT_GEOMETRY}
          material={material}
          batched_positions={instanceData.shaftPositions}
          batched_wxyzs={instanceData.wxyzs}
          batched_scales={instanceData.shaftScales}
          batched_colors={instanceData.shaftColors}
          opacity={null}
          batched_opacities={null}
          lod="off"
          cast_shadow={false}
          receive_shadow={false}
        />
        <BatchedMeshBase
          geometry={HEAD_GEOMETRY}
          material={material}
          batched_positions={instanceData.headPositions}
          batched_wxyzs={instanceData.wxyzs}
          batched_scales={instanceData.headScales}
          batched_colors={instanceData.headColors}
          opacity={null}
          batched_opacities={null}
          lod="off"
          cast_shadow={false}
          receive_shadow={false}
        />
      </group>
      {children}
    </group>
  );
});
