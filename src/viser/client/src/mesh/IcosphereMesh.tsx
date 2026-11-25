import React from "react";
import * as THREE from "three";
import { IcosphereMessage } from "../WebsocketMessages";
import { PrimitiveMesh } from "../scene/PrimitiveMesh";
import { normalizeScale } from "../utils/normalizeScale";

// Cache icosphere geometries based on # of subdivisions. In theory this cache
// can grow indefinitely, but this doesn't seem worth the complexity of
// preventing.
const icosphereGeometryCache = new Map<number, THREE.IcosahedronGeometry>();

/**
 * Component for rendering icosphere meshes.
 */
export const IcosphereMesh = React.forwardRef<
  THREE.Group,
  IcosphereMessage & { children?: React.ReactNode }
>(function IcosphereMesh(
  { children, ...message },
  ref: React.ForwardedRef<THREE.Group>,
) {
  // Setup geometry using memoization.
  const geometry = React.useMemo(() => {
    if (!icosphereGeometryCache.has(message.props.subdivisions)) {
      icosphereGeometryCache.set(
        message.props.subdivisions,
        new THREE.IcosahedronGeometry(1.0, message.props.subdivisions),
      );
    }
    return icosphereGeometryCache.get(message.props.subdivisions)!;
  }, [message.props.subdivisions]);

  const s = normalizeScale(message.props.scale);
  const r = message.props.radius;
  return (
    <PrimitiveMesh
      ref={ref}
      geometry={geometry}
      scale={[s[0] * r, s[1] * r, s[2] * r]}
      material={message.props}
      castShadow={message.props.cast_shadow}
      receiveShadow={message.props.receive_shadow}
      outlineCreaseAngle={false}
    >
      {children}
    </PrimitiveMesh>
  );
});
