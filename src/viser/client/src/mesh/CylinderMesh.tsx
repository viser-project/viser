import React from "react";
import * as THREE from "three";
import { CylinderMessage } from "../WebsocketMessages";
import { PrimitiveMesh } from "../scene/PrimitiveMesh";
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
          // Height is along Y for three.js, but Z for us.
        ).rotateX(Math.PI / 2.0),
      );
    }
    return cylinderGeometryCache.get(message.props.radial_segments)!;
  }, [message.props.radial_segments]);

  const s = normalizeScale(message.props.scale);
  const r = message.props.radius;
  const h = message.props.height;
  return (
    <PrimitiveMesh
      ref={ref}
      geometry={geometry}
      scale={[s[0] * r, s[1] * r, s[2] * h]}
      material={message.props}
      castShadow={message.props.cast_shadow}
      receiveShadow={message.props.receive_shadow}
      outlineCreaseAngle={true}
    >
      {children}
    </PrimitiveMesh>
  );
});
