import React, { useMemo } from "react";
import * as THREE from "three";
import { createStandardMaterial } from "./MeshUtils";
import { BatchedMeshesMessage } from "../WebsocketMessages";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { ViewerContext } from "../ViewerContext";
import { BatchedMeshBase } from "./BatchedMeshBase";
import { normalizeScale } from "../utils/normalizeScale";

/**
 * Component for rendering batched/instanced meshes
 */
export const BatchedMesh = React.forwardRef<
  InstancedMesh2,
  BatchedMeshesMessage & { children?: React.ReactNode }
>(function BatchedMesh({ children, ...message }, ref) {
  const viewer = React.useContext(ViewerContext)!;
  const clickable =
    viewer.useSceneTree((state) => state[message.name]?.clickable) ?? false;

  // Create a material based on the message props.
  const material = useMemo(() => {
    // Create the material with properties from the message.
    // When per-instance opacities exist, material opacity stays at 1.0.
    const mat = createStandardMaterial({
      material: message.props.material,
      wireframe: message.props.wireframe,
      opacity: message.props.batched_opacities ? null : message.props.opacity,
      flat_shading: message.props.flat_shading,
      side: message.props.side,
    });

    // Set transparent flag if any transparency is involved.
    if (
      (message.props.opacity !== null && message.props.opacity < 1.0) ||
      message.props.batched_opacities !== null
    ) {
      mat.transparent = true;
    }

    return mat;
  }, [
    message.props.material,
    message.props.wireframe,
    message.props.opacity,
    message.props.batched_opacities,
    message.props.flat_shading,
    message.props.side,
  ]);

  // Setup geometry using memoization.
  const geometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array(
          message.props.vertices.buffer.slice(
            message.props.vertices.byteOffset,
            message.props.vertices.byteOffset +
              message.props.vertices.byteLength,
          ),
        ),
        3,
      ),
    );
    geometry.setIndex(
      new THREE.BufferAttribute(
        new Uint32Array(
          message.props.faces.buffer.slice(
            message.props.faces.byteOffset,
            message.props.faces.byteOffset + message.props.faces.byteLength,
          ),
        ),
        1,
      ),
    );
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }, [message.props.vertices.buffer, message.props.faces.buffer]);

  return (
    <group ref={ref}>
      <group scale={normalizeScale(message.props.scale)}>
        <BatchedMeshBase
          geometry={geometry}
          material={material}
          batched_positions={message.props.batched_positions}
          batched_wxyzs={message.props.batched_wxyzs}
          batched_scales={message.props.batched_scales}
          batched_colors={message.props.batched_colors}
          opacity={message.props.opacity}
          batched_opacities={message.props.batched_opacities}
          lod={message.props.lod}
          cast_shadow={message.props.cast_shadow}
          receive_shadow={message.props.receive_shadow}
          clickable={clickable}
        />
      </group>
      {children}
    </group>
  );
});
