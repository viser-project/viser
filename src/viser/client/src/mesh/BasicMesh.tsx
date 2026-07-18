import React from "react";
import * as THREE from "three";
import { ViserStandardMeshMaterial, ShadowMesh } from "./MeshUtils";
import { MeshMessage } from "../WebsocketMessages";
import { OutlinesIfHovered } from "../OutlinesIfHovered";
import { normalizeScale } from "../utils/normalizeScale";
import { syncBufferGeometry } from "../utils/bufferGeometrySync";

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
  // Persistent geometry, synced in place: a streaming/deforming mesh reuses the
  // existing GL buffers via bufferSubData instead of allocating a new
  // BufferGeometry on every vertex/face update. Kept imperative (run during
  // render via useMemo) because the geometry is read synchronously below for
  // OutlinesIfHovered heuristics and the shadow mesh.
  const geometryRef = React.useRef<THREE.BufferGeometry | null>(null);
  if (geometryRef.current === null) {
    geometryRef.current = new THREE.BufferGeometry();
  }
  const geometry = geometryRef.current;
  React.useMemo(() => {
    // Vertices and faces arrive as Float32Array / Uint32Array views.
    const reallocated = syncBufferGeometry(
      geometry,
      { position: { array: message.props.vertices, itemSize: 3 } },
      message.props.faces,
    );
    // On realloc (e.g. vertex-count change), drop the stale 'normal' attribute:
    // computeVertexNormals reuses an existing attribute without a size check,
    // which would leave normals mismatched with the new position count.
    if (reallocated) {
      geometry.deleteAttribute("normal");
    }
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, message.props.vertices, message.props.faces]);

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
