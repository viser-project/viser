import React from "react";
import * as THREE from "three";
import { BoxMessage } from "../WebsocketMessages";
import { PrimitiveMesh } from "../scene/PrimitiveMesh";
import { normalizeScale } from "../utils/normalizeScale";

let boxGeometry: THREE.BoxGeometry | null = null;

/**
 * Component for rendering box meshes
 */
export const BoxMesh = React.forwardRef<
  THREE.Group,
  BoxMessage & { children?: React.ReactNode }
>(function BoxMesh({ children, props }, ref: React.ForwardedRef<THREE.Group>) {
  // Create box geometry only once.
  if (boxGeometry === null) {
    boxGeometry = new THREE.BoxGeometry(1.0, 1.0, 1.0);
  }
  const s = normalizeScale(props.scale);
  const d = props.dimensions;
  return (
    <PrimitiveMesh
      ref={ref}
      geometry={boxGeometry}
      scale={[s[0] * d[0], s[1] * d[1], s[2] * d[2]]}
      material={props}
      castShadow={props.cast_shadow}
      receiveShadow={props.receive_shadow}
      outlineCreaseAngle={true}
    >
      {children}
    </PrimitiveMesh>
  );
});
