import React from "react";
import * as THREE from "three";
import { ShadowMesh, ViserStandardMeshMaterial } from "../mesh/MeshUtils";
import {
  createStandardMaterial,
  rgbToInt,
  StandardMaterialProps,
} from "../mesh/meshMaterialUtils";
import { OutlinesIfHovered } from "../OutlinesIfHovered";
import {
  InstanceSource,
  MAX_INSTANCED_VERTICES,
  MIN_INSTANCE_SCALE,
} from "./AutoInstancer";
import { geometryRadius, MeshBatch } from "./MeshBatch";
import { drawnLayers, raycastOnlyLayers } from "./raycastOnly";
import { InstancingSpec, useInstanceSource } from "./useInstanceSource";

/** Scene node that draws a geometry which is shared between many nodes. Large
 * numbers of nodes with similar parameters are automatically instanced. */
export const PrimitiveMesh = React.forwardRef<
  THREE.Group,
  {
    geometry: THREE.BufferGeometry;
    /** Scale for the geometry. Doesn't affect children. */
    scale: [number, number, number];
    material: StandardMaterialProps & { color: [number, number, number] };
    castShadow: boolean;
    receiveShadow: boolean | number;
    outlineCreaseAngle: boolean;
    children?: React.ReactNode;
  }
>(function PrimitiveMesh(
  {
    geometry,
    scale,
    material,
    castShadow,
    receiveShadow,
    outlineCreaseAngle,
    children,
  },
  ref,
) {
  const color = rgbToInt(material.color);
  const [sx, sy, sz] = scale;

  // Not instanced:
  // - Transparent meshes, which need to be depth-sorted.
  // - Meshes with a separate shadow mesh.
  const eligible =
    (material.opacity === null || material.opacity >= 1.0) &&
    typeof receiveShadow !== "number" &&
    Math.min(sx, sy, sz) > MIN_INSTANCE_SCALE &&
    geometry.attributes.position.count <= MAX_INSTANCED_VERTICES;
  const appearance = React.useMemo(
    () => ({
      color,
      scale: [sx, sy, sz],
      radius: geometryRadius(geometry) * Math.max(sx, sy, sz),
    }),
    [geometry, color, sx, sy, sz],
  );
  const spec: InstancingSpec | null = eligible
    ? {
        key: [
          "mesh",
          geometry.uuid,
          material.material,
          material.flat_shading,
          material.side,
          material.wireframe,
          castShadow,
          receiveShadow,
        ].join("|"),
        makeBatch: () =>
          new MeshBatch(
            geometry,
            createStandardMaterial({ ...material, color: [255, 255, 255] }),
            castShadow,
            receiveShadow === true,
          ),
        appearance,
      }
    : null;
  const [source] = React.useState(() => new InstanceSource());
  const mode = useInstanceSource(source, spec);

  return (
    <primitive object={source} ref={ref}>
      {mode !== null ? (
        // Remounting this would lose track of whether it's hovered.
        <mesh
          geometry={geometry}
          scale={scale}
          layers={mode === "drawn" ? drawnLayers : raycastOnlyLayers}
          castShadow={mode === "drawn" && castShadow}
          receiveShadow={receiveShadow === true}
        >
          <ViserStandardMeshMaterial {...material} />
          <OutlinesIfHovered enableCreaseAngle={outlineCreaseAngle} />
        </mesh>
      ) : null}
      <ShadowMesh
        opacity={typeof receiveShadow === "number" ? receiveShadow : 0.0}
        geometry={geometry}
        scale={scale}
      />
      {children}
    </primitive>
  );
});
