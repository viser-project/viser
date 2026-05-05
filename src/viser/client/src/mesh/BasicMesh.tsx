import React from "react";
import * as THREE from "three";
import { ViserStandardMeshMaterial, ShadowMesh } from "./MeshUtils";
import { MeshMessage } from "../WebsocketMessages";
import { OutlinesIfHovered } from "../OutlinesIfHovered";
import { normalizeScale } from "../utils/normalizeScale";

/**
 * Component for rendering basic THREE.js meshes
 */
export const BasicMesh = React.forwardRef<
  THREE.Group,
  MeshMessage & { children?: React.ReactNode }
>(function BasicMesh(
  { children, ...message },
  ref: React.ForwardedRef<THREE.Group>,
) {
  // Setup geometry using memoization.
  // Kept imperative because setAttribute/setIndex/computeVertexNormals
  // can't be expressed as JSX props, and the geometry is shared with
  // the shadow mesh and accessed for OutlinesIfHovered heuristics.
  const geometry = React.useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    // Vertices and faces arrive as Float32Array / Uint32Array views.
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(message.props.vertices, 3),
    );
    geometry.setIndex(new THREE.BufferAttribute(message.props.faces, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }, [message.props.vertices, message.props.faces]);

  // Clean up geometry when it changes.
  React.useEffect(() => {
    return () => {
      if (geometry) geometry.dispose();
    };
  }, [geometry]);

  // Check if we should render a shadow mesh.
  const shadowOpacity =
    typeof message.props.receive_shadow === "number"
      ? message.props.receive_shadow
      : 0.0;

  return (
    <group ref={ref}>
      <mesh
        geometry={geometry}
        scale={normalizeScale(message.props.scale)}
        castShadow={message.props.cast_shadow}
        receiveShadow={message.props.receive_shadow === true}
      >
        <ViserStandardMeshMaterial {...message.props} />
        <OutlinesIfHovered
          enableCreaseAngle={
            geometry.attributes.position.count < 1024 &&
            geometry.boundingSphere!.radius > 0.1
          }
        />
      </mesh>
      <ShadowMesh
        opacity={shadowOpacity}
        geometry={geometry}
        scale={normalizeScale(message.props.scale)}
      />
      {children}
    </group>
  );
});
