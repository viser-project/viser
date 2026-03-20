import React from "react";
import * as THREE from "three";
import { ViserStandardMeshMaterial, ShadowMesh } from "./MeshUtils";
import { CylinderMessage } from "../WebsocketMessages";
import { OutlinesIfHovered } from "../OutlinesIfHovered";
import { normalizeScale } from "../utils/normalizeScale";

// Cache cylinder geometries based on # of radial segments.
const cylinderGeometryCache = new Map<number, THREE.CylinderGeometry>();

/**
 * Component for rendering cylinder meshes
 */
export const CylinderMesh = React.forwardRef<
  THREE.Group,
  CylinderMessage & { children?: React.ReactNode }
>(function CylinderMesh(
  { children, ...message },
  ref: React.ForwardedRef<THREE.Group>,
) {
  // Setup geometry using memoization.
  const geometry = React.useMemo(() => {
    if (!cylinderGeometryCache.has(message.props.radial_segments)) {
      cylinderGeometryCache.set(
        message.props.radial_segments,
        new THREE.CylinderGeometry(
          1.0,
          1.0,
          1.0,
          message.props.radial_segments,
        ),
      );
    }
    return cylinderGeometryCache.get(message.props.radial_segments)!;
  }, [message.props.radial_segments]);

  // Check if we should render a shadow mesh.
  const shadowOpacity =
    typeof message.props.receive_shadow === "number"
      ? message.props.receive_shadow
      : 0.0;

  // The cylinder geometry has height along Y, but the PI/2 rotation around X
  // remaps axes: local Y→Z, local Z→-Y. To make the user-facing scale axes
  // match the visual axes (sx→X, sy→Y, sz→Z/height), we reorder:
  //   local X = sx * radius, local Y = sz * height, local Z = sy * radius.
  const s = normalizeScale(message.props.scale);
  const r = message.props.radius;
  const h = message.props.height;

  return (
    <group ref={ref}>
      <mesh
        geometry={geometry}
        scale={[s[0] * r, s[2] * h, s[1] * r]}
        rotation={new THREE.Euler(Math.PI / 2.0, 0.0, 0.0)}
        castShadow={message.props.cast_shadow}
        receiveShadow={message.props.receive_shadow === true}
      >
        <ViserStandardMeshMaterial {...message.props} />
        <OutlinesIfHovered enableCreaseAngle />
      </mesh>
      <ShadowMesh
        opacity={shadowOpacity}
        geometry={geometry}
        scale={[s[0] * r, s[2] * h, s[1] * r]}
        rotation={new THREE.Euler(Math.PI / 2.0, 0.0, 0.0)}
      />
      {children}
    </group>
  );
});
