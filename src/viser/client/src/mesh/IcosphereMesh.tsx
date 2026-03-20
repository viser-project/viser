import React from "react";
import * as THREE from "three";
import { ViserStandardMeshMaterial, ShadowMesh } from "./MeshUtils";
import { IcosphereMessage } from "../WebsocketMessages";
import { OutlinesIfHovered } from "../OutlinesIfHovered";
import { normalizeScale } from "../utils/normalizeScale";

// Cache icosphere geometries based on # of subdivisions. In theory this cache
// can grow indefinitely, but this doesn't seem worth the complexity of
// preventing.
const icosphereGeometryCache = new Map<number, THREE.IcosahedronGeometry>();

/**
 * Component for rendering icosphere meshes
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

  // Check if we should render a shadow mesh.
  const shadowOpacity =
    typeof message.props.receive_shadow === "number"
      ? message.props.receive_shadow
      : 0.0;

  // Calculate scaling values.
  const normalizedScale = normalizeScale(message.props.scale);
  const scale: [number, number, number] = [
    normalizedScale[0] * message.props.radius,
    normalizedScale[1] * message.props.radius,
    normalizedScale[2] * message.props.radius,
  ];

  return (
    <group ref={ref}>
      <mesh
        geometry={geometry}
        scale={scale}
        castShadow={message.props.cast_shadow}
        receiveShadow={message.props.receive_shadow === true}
      >
        <ViserStandardMeshMaterial {...message.props} />
        <OutlinesIfHovered />
      </mesh>
      <ShadowMesh opacity={shadowOpacity} geometry={geometry} scale={scale} />
      {children}
    </group>
  );
});
