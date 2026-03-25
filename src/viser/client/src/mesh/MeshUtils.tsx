import React from "react";
import * as THREE from "three";
import {
  rgbToInt,
  assertUnreachable,
  GRADIENT_MAP_3,
  GRADIENT_MAP_5,
  sideMap,
} from "./meshMaterialUtils";
import type { StandardMaterialProps } from "./meshMaterialUtils";

export type { StandardMaterialProps } from "./meshMaterialUtils";

/**
 * Declarative material component for standard/toon materials.
 * R3F manages lifecycle — no manual disposal needed.
 */
export function ViserStandardMeshMaterial(props: StandardMaterialProps) {
  const color = props.color === undefined ? 0xffffff : rgbToInt(props.color);
  const transparent = props.opacity !== null;
  const opacity = props.opacity ?? 1.0;
  const side = sideMap[props.side];

  // Force material recreation when shader-affecting properties change.
  // R3F's applyProps sets properties but doesn't set needsUpdate, so
  // Three.js won't recompile shaders for flatShading/side changes or
  // re-sort render passes for transparent changes.
  const materialKey = `${transparent}-${props.flat_shading}-${side}-${props.wireframe}`;

  if (props.material === "standard" || props.wireframe) {
    return (
      <meshStandardMaterial
        key={materialKey}
        color={color}
        wireframe={props.wireframe}
        transparent={transparent}
        opacity={opacity}
        side={side}
        flatShading={props.flat_shading && !props.wireframe}
      />
    );
  } else if (props.material === "toon3") {
    return (
      <meshToonMaterial
        key={materialKey}
        gradientMap={GRADIENT_MAP_3}
        color={color}
        wireframe={props.wireframe}
        transparent={transparent}
        opacity={opacity}
        side={side}
      />
    );
  } else if (props.material === "toon5") {
    return (
      <meshToonMaterial
        key={materialKey}
        gradientMap={GRADIENT_MAP_5}
        color={color}
        wireframe={props.wireframe}
        transparent={transparent}
        opacity={opacity}
        side={side}
      />
    );
  } else {
    return assertUnreachable(props.material);
  }
}

/**
 * Declarative shadow mesh. Renders a mesh with ShadowMaterial when opacity > 0.
 * R3F manages material lifecycle — no manual disposal needed.
 */
export function ShadowMesh({
  opacity,
  geometry,
  scale,
  position,
  rotation,
}: {
  opacity: number;
  geometry: THREE.BufferGeometry;
  scale?: [number, number, number] | number;
  position?: THREE.Vector3 | [number, number, number];
  rotation?: THREE.Euler;
}) {
  if (opacity <= 0) return null;
  return (
    <mesh
      geometry={geometry}
      receiveShadow
      scale={scale}
      position={position}
      rotation={rotation}
    >
      <shadowMaterial opacity={opacity} color={0x000000} depthWrite={false} />
    </mesh>
  );
}

/**
 * Declarative shadow skinned mesh. Like ShadowMesh but for skinned meshes
 * that need skeleton deformation.
 */
export function ShadowSkinnedMesh({
  opacity,
  geometry,
  skeleton,
  scale,
}: {
  opacity: number;
  geometry: THREE.BufferGeometry;
  skeleton: THREE.Skeleton;
  scale?: [number, number, number] | number;
}) {
  if (opacity <= 0) return null;
  return (
    <skinnedMesh
      geometry={geometry}
      skeleton={skeleton}
      receiveShadow
      frustumCulled={false}
      scale={scale}
    >
      <shadowMaterial opacity={opacity} color={0x000000} depthWrite={false} />
    </skinnedMesh>
  );
}
