import React from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { HoverableContext } from "../HoverContext";
import { OutlinesMaterial } from "../OutlinesMaterial";

/**
 * Props for BatchedMeshHoverOutlines component
 */
interface BatchedMeshHoverOutlinesProps {
  geometry: THREE.BufferGeometry;
  /** Float32 position values (xyz) */
  batched_positions: Float32Array;
  /** Float32 quaternion values (wxyz) */
  batched_wxyzs: Float32Array;
  /** Float32 scale values (uniform or per-axis XYZ) */
  batched_scales: Float32Array | null;
  meshTransform?: {
    position: THREE.Vector3;
    rotation: THREE.Quaternion;
    scale: THREE.Vector3;
  };
  // Function to compute batch index from instance index - needed for cases like InstancedAxes.
  // where instanceId (from hover) doesn't match batched_positions indexing
  computeBatchIndexFromInstanceIndex?: (instanceId: number) => number;
}

/**
 * A reusable component that renders hover outlines for batched/instanced meshes
 * Shows a highlighted outline around the instance that is currently being hovered
 */
// Static reusable objects for matrix operations.
const _tempObjects = {
  instanceMatrix: new THREE.Matrix4(),
  transformMatrix: new THREE.Matrix4(),
  finalMatrix: new THREE.Matrix4(),
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  scale: new THREE.Vector3(),
  oneVector: new THREE.Vector3(1, 1, 1),
};

export const BatchedMeshHoverOutlines: React.FC<
  BatchedMeshHoverOutlinesProps
> = ({
  geometry,
  batched_positions,
  batched_wxyzs,
  batched_scales,
  meshTransform,
  computeBatchIndexFromInstanceIndex,
}) => {
  // Get hover state from context.
  const hoverContext = React.useContext(HoverableContext)!;

  // Create outline mesh reference.
  const outlineRef = React.useRef<THREE.Mesh>(null);

  // Get rendering context for screen size.
  const gl = useThree((state) => state.gl);
  const contextSize = React.useMemo(
    () => gl.getDrawingBufferSize(new THREE.Vector2()),
    [gl],
  );

  // Create outline geometry based on the original geometry using memoization.
  const outlineGeometry = React.useMemo(() => {
    if (!geometry) return null;
    // Clone the geometry to create an independent copy for the outline.
    return geometry.clone();
  }, [geometry]);

  // Create outline material with fixed properties.
  const outlineMaterial = React.useMemo(() => {
    const material = new OutlinesMaterial({
      side: THREE.BackSide,
      fog: true,
    });

    // Set fixed properties to match OutlinesIfHovered.
    material.thickness = 10;
    material.color = new THREE.Color(0xfbff00); // Yellow highlight color
    material.opacity = 0.8;
    material.size = contextSize;
    material.transparent = true;
    material.screenspace = true; // Use screenspace for consistent thickness
    material.toneMapped = true;

    return material;
  }, [contextSize]);

  // Separate cleanup for geometry and material to handle dependency changes correctly.
  // Clean up geometry when it changes or component unmounts.
  React.useEffect(() => {
    return () => {
      if (outlineGeometry) {
        outlineGeometry.dispose();
      }
    };
  }, [outlineGeometry]);

  // Clean up material when it changes or component unmounts.
  React.useEffect(() => {
    return () => {
      if (outlineMaterial) {
        outlineMaterial.dispose();
      }
    };
  }, [outlineMaterial]);

  // Update outline position based on hover state.
  useFrame(() => {
    if (!outlineRef.current || !outlineGeometry || !hoverContext) return;

    // Hide by default.
    outlineRef.current.visible = false;

    // Check if we're hovering and have a valid instanceId.
    if (
      hoverContext.state.current.isHovered &&
      hoverContext.state.current.instanceId !== null
    ) {
      // Get the instance ID from the hover state.
      const hoveredInstanceId = hoverContext.state.current.instanceId;

      // Calculate the actual batch index using the mapping function if provided.
      const batchIndex = computeBatchIndexFromInstanceIndex
        ? computeBatchIndexFromInstanceIndex(hoveredInstanceId)
        : hoveredInstanceId; // Default is identity mapping

      // Only show outline if the batch index is valid.
      if (batchIndex >= 0 && batchIndex * 3 < batched_positions.length) {
        // Use modulo as a defensive check to prevent out-of-bounds reads.
        const posIdx = (batchIndex * 3) % batched_positions.length;
        const wxyzIdx = (batchIndex * 4) % batched_wxyzs.length;

        // Position the outline at the hovered instance.
        outlineRef.current.position.set(
          batched_positions[posIdx], // x
          batched_positions[posIdx + 1], // y
          batched_positions[posIdx + 2], // z
        );

        // Set rotation to match the hovered instance (wxyz -> xyzw).
        outlineRef.current.quaternion.set(
          batched_wxyzs[wxyzIdx + 1], // x
          batched_wxyzs[wxyzIdx + 2], // y
          batched_wxyzs[wxyzIdx + 3], // z
          batched_wxyzs[wxyzIdx], // w
        );

        // Set scale to match the hovered instance.
        if (batched_scales !== null) {
          // Check if we have per-axis scaling (N,3) or uniform scaling (N,).
          const perAxisScaling =
            batched_scales.length === (batched_wxyzs.length / 4) * 3;
          if (perAxisScaling) {
            const scaleIdx = (batchIndex * 3) % batched_scales.length;
            outlineRef.current.scale.set(
              batched_scales[scaleIdx], // x scale
              batched_scales[scaleIdx + 1], // y scale
              batched_scales[scaleIdx + 2], // z scale
            );
          } else {
            const scale = batched_scales[batchIndex % batched_scales.length];
            outlineRef.current.scale.setScalar(scale);
          }
        } else {
          outlineRef.current.scale.set(1, 1, 1);
        }

        // Apply mesh transform if provided (for GLB assets)
        if (meshTransform) {
          // Create instance matrix from batched data.
          _tempObjects.instanceMatrix.compose(
            outlineRef.current.position,
            outlineRef.current.quaternion,
            outlineRef.current.scale,
          );

          // Create mesh transform matrix.
          _tempObjects.transformMatrix.compose(
            meshTransform.position,
            meshTransform.rotation,
            meshTransform.scale,
          );

          // Create final matrix by right-multiplying (match how it's done in ThreeAssets.tsx).
          _tempObjects.finalMatrix
            .copy(_tempObjects.instanceMatrix)
            .multiply(_tempObjects.transformMatrix);

          // Decompose the final matrix into position, quaternion, scale.
          _tempObjects.finalMatrix.decompose(
            _tempObjects.position,
            _tempObjects.quaternion,
            _tempObjects.scale,
          );

          // Apply the decomposed transformation.
          outlineRef.current.position.copy(_tempObjects.position);
          outlineRef.current.quaternion.copy(_tempObjects.quaternion);
          outlineRef.current.scale.copy(_tempObjects.scale);
        }

        // Show the outline.
        outlineRef.current.visible = true;
      }
    }
  });

  // This is now handled by the earlier cleanup effect.

  if (!hoverContext || !hoverContext.clickable || !outlineGeometry) {
    return null;
  }

  return (
    <mesh
      ref={outlineRef}
      geometry={outlineGeometry}
      material={outlineMaterial}
      visible={false}
    />
  );
};
