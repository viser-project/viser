import React from "react";
import * as THREE from "three";
import { ShadowMesh, ViserStandardMeshMaterial } from "../mesh/MeshUtils";
import {
  createStandardMaterial,
  rgbToInt,
  StandardMaterialProps,
} from "../mesh/meshMaterialUtils";
import { HoverableContext } from "../HoverContext";
import { OutlinesIfHovered } from "../OutlinesIfHovered";
import { MeshBatch, raycastOnlyLayers } from "./AutoInstancer";
import { InstancingSpec, useInstanceSource } from "./useInstanceSource";

const raycastOnlyMaterials = {
  front: new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
  back: new THREE.MeshBasicMaterial({ side: THREE.BackSide }),
  double: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
};

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
  const raycastable = React.useContext(HoverableContext)?.raycastable ?? false;
  const color = rgbToInt(material.color);
  const [sx, sy, sz] = scale;

  // Not instanced:
  // - Transparent meshes, which need to be depth-sorted.
  // - Meshes with a separate shadow mesh.
  // - Mirrored meshes: front faces are determined for all instances at once.
  const eligible =
    (material.opacity === null || material.opacity >= 1.0) &&
    typeof receiveShadow !== "number" &&
    sx > 0 &&
    sy > 0 &&
    sz > 0;
  const appearance = React.useMemo(
    () => ({ color, scale: [sx, sy, sz] as [number, number, number] }),
    [color, sx, sy, sz],
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
  const { sourceRef, drawIndividually } = useInstanceSource(ref, spec);

  return (
    <instanceSource ref={sourceRef}>
      {drawIndividually ? (
        <mesh
          geometry={geometry}
          scale={scale}
          castShadow={castShadow}
          receiveShadow={receiveShadow === true}
        >
          <ViserStandardMeshMaterial {...material} />
          <OutlinesIfHovered enableCreaseAngle={outlineCreaseAngle} />
        </mesh>
      ) : raycastable ? (
        <mesh
          geometry={geometry}
          scale={scale}
          layers={raycastOnlyLayers}
          material={raycastOnlyMaterials[material.side]}
        >
          <OutlinesIfHovered enableCreaseAngle={outlineCreaseAngle} />
        </mesh>
      ) : null}
      <ShadowMesh
        opacity={typeof receiveShadow === "number" ? receiveShadow : 0.0}
        geometry={geometry}
        scale={scale}
      />
      {children}
    </instanceSource>
  );
});
