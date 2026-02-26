import React from "react";
import * as THREE from "three";
import { createStandardMaterial } from "./MeshUtils";
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
  // Create material based on props.
  const material = React.useMemo(() => {
    return createStandardMaterial(message.props);
  }, [
    message.props.material,
    message.props.color,
    message.props.wireframe,
    message.props.opacity,
    message.props.flat_shading,
    message.props.side,
  ]);

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

  // Clean up material when it changes.
  React.useEffect(() => {
    return () => {
      if (material) material.dispose();
    };
  }, [material]);

  // Check if we should render a shadow mesh.
  const shadowOpacity =
    typeof message.props.receive_shadow === "number"
      ? message.props.receive_shadow
      : 0.0;

  // Create shadow material for shadow mesh.
  const shadowMaterial = React.useMemo(() => {
    if (shadowOpacity === 0.0) return null;
    return new THREE.ShadowMaterial({
      opacity: shadowOpacity,
      color: 0x000000,
      depthWrite: false,
    });
  }, [shadowOpacity]);

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
        material={material}
        castShadow={message.props.cast_shadow}
        receiveShadow={message.props.receive_shadow === true}
      >
        <OutlinesIfHovered />
        {shadowMaterial && shadowOpacity > 0 ? (
          <mesh geometry={geometry} material={shadowMaterial} receiveShadow />
        ) : null}
      </mesh>
      {children}
    </group>
  );
});
