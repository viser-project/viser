import React from "react";
import * as THREE from "three";
import { ViserStandardMeshMaterial, ShadowMesh } from "./MeshUtils";
import { BoxMessage } from "../WebsocketMessages";
import { OutlinesIfHovered } from "../OutlinesIfHovered";
import { normalizeScale } from "../utils/normalizeScale";

let boxGeometry: THREE.BoxGeometry | null = null;

/**
 * Component for rendering box meshes
 */
export const BoxMesh = React.forwardRef<
  THREE.Group,
  BoxMessage & { children?: React.ReactNode }
>(function BoxMesh(
  { children, ...message },
  ref: React.ForwardedRef<THREE.Group>,
) {
  // Create box geometry only once.
  if (boxGeometry === null) {
    boxGeometry = new THREE.BoxGeometry(1.0, 1.0, 1.0);
  }

  // Check if we should render a shadow mesh.
  const shadowOpacity =
    typeof message.props.receive_shadow === "number"
      ? message.props.receive_shadow
      : 0.0;

  const s = normalizeScale(message.props.scale);
  const d = message.props.dimensions;
  const scaledDimensions: [number, number, number] = [
    s[0] * d[0],
    s[1] * d[1],
    s[2] * d[2],
  ];

  return (
    <group ref={ref}>
      <mesh
        geometry={boxGeometry}
        scale={scaledDimensions}
        castShadow={message.props.cast_shadow}
        receiveShadow={message.props.receive_shadow === true}
      >
        <ViserStandardMeshMaterial {...message.props} />
        <OutlinesIfHovered enableCreaseAngle />
      </mesh>
      <ShadowMesh
        opacity={shadowOpacity}
        geometry={boxGeometry}
        scale={scaledDimensions}
      />
      {children}
    </group>
  );
});
