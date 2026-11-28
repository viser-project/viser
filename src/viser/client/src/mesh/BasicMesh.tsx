import React from "react";
import * as THREE from "three";
import { ViserStandardMeshMaterial, ShadowMesh } from "./MeshUtils";
import { createStandardMaterial, rgbToInt } from "./meshMaterialUtils";
import { MeshMessage } from "../WebsocketMessages";
import { OutlinesIfHovered } from "../OutlinesIfHovered";
import { InstanceSource, MIN_INSTANCE_SCALE } from "../scene/AutoInstancer";
import { raycastOnlyLayers, raycastOnlyMaterials } from "../scene/raycastOnly";
import { GeometryAppearance, GeometryBatch } from "../scene/GeometryBatch";
import { InstancingSpec, useInstanceSource } from "../scene/useInstanceSource";
import { normalizeScale } from "../utils/normalizeScale";
import { syncBufferGeometry } from "../utils/bufferGeometrySync";
import {
  computeBoundingSphere,
  computeVertexNormals,
} from "../utils/meshGeometry";

function indicesAreValid(indices: Uint32Array, numVertices: number): boolean {
  for (let i = 0; i < indices.length; i++)
    if (indices[i] >= numVertices) return false;
  return true;
}

/** Only small meshes are batched. Batches hold a copy of their contents in JS
 * memory, and draw calls aren't a bottleneck for large ones. */
const MAX_BATCHED_VERTICES = 1024;
const MAX_BATCHED_FACES = 2048;

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
  const { props } = message;
  const { vertices, faces } = props;
  const [source] = React.useState(() => new InstanceSource());
  const color = rgbToInt(props.color);
  const [sx, sy, sz] = normalizeScale(props.scale);

  // Streaming meshes are drawn individually.
  // Cleared when the geometry changes.
  const [initialGeometry, setInitialGeometry] = React.useState<{
    vertices: Float32Array;
    faces: Uint32Array;
  } | null>({ vertices, faces });
  const isStatic =
    initialGeometry?.vertices === vertices && initialGeometry.faces === faces;
  if (initialGeometry !== null && !isStatic) setInitialGeometry(null);

  // Not batched:
  // - Transparent meshes, which need to be depth-sorted.
  // - Meshes with a separate shadow mesh.
  const eligible =
    isStatic &&
    vertices.length <= 3 * MAX_BATCHED_VERTICES &&
    faces.length <= 3 * MAX_BATCHED_FACES &&
    vertices.length > 0 &&
    faces.length > 0 &&
    !props.wireframe &&
    (props.opacity === null || props.opacity >= 1.0) &&
    typeof props.receive_shadow !== "number" &&
    Math.min(sx, sy, sz) > MIN_INSTANCE_SCALE;
  // In a batch, invalid indices would refer to vertices of other meshes.
  const batchable = React.useMemo(
    () => eligible && indicesAreValid(faces, vertices.length / 3),
    [eligible, faces, vertices],
  );
  const radius = React.useMemo(() => {
    if (!batchable) return 0;
    const { center, radius } = computeBoundingSphere(vertices);
    return center.length() + radius;
  }, [batchable, vertices]);
  const appearance = React.useMemo<GeometryAppearance>(
    () => ({
      vertices,
      faces,
      color,
      scale: [sx, sy, sz],
      radius: radius * Math.max(sx, sy, sz),
    }),
    [vertices, faces, color, sx, sy, sz, radius],
  );
  const spec: InstancingSpec | null = batchable
    ? {
        key: [
          "geometry",
          props.material,
          props.flat_shading,
          props.side,
          props.cast_shadow,
          props.receive_shadow,
        ].join("|"),
        makeBatch: () =>
          new GeometryBatch(
            createStandardMaterial({ ...props, color: [255, 255, 255] }),
            props.cast_shadow,
            props.receive_shadow === true,
          ),
        appearance,
      }
    : null;
  const mode = useInstanceSource(source, spec);

  return (
    <primitive object={source} ref={ref}>
      {mode !== null ? (
        <IndividualMesh
          key={mode}
          message={message}
          raycastOnly={mode === "raycast"}
        />
      ) : null}
      {children}
    </primitive>
  );
});

function IndividualMesh({
  message,
  raycastOnly,
}: {
  message: MeshMessage;
  raycastOnly: boolean;
}) {
  const { props } = message;
  // Persistent geometry, synced in place: a streaming/deforming mesh reuses the
  // existing GL buffers via bufferSubData instead of allocating a new
  // BufferGeometry on every vertex/face update. Kept imperative (run during
  // render via useMemo) because the geometry is read synchronously below for
  // OutlinesIfHovered heuristics and the shadow mesh.
  const [geometry] = React.useState(() => new THREE.BufferGeometry());
  React.useMemo(() => {
    // Vertices and faces arrive as Float32Array / Uint32Array views.
    const reallocated = syncBufferGeometry(
      geometry,
      { position: { array: props.vertices, itemSize: 3 } },
      props.faces,
    );
    geometry.boundingSphere = computeBoundingSphere(
      props.vertices,
      geometry.boundingSphere ?? undefined,
    );
    if (raycastOnly) return;
    const oldNormals = geometry.getAttribute("normal") as
      THREE.BufferAttribute | undefined;
    if (reallocated || oldNormals === undefined) {
      geometry.setAttribute(
        "normal",
        new THREE.BufferAttribute(
          computeVertexNormals(props.vertices, props.faces),
          3,
        ),
      );
    } else {
      computeVertexNormals(
        props.vertices,
        props.faces,
        oldNormals.array as Float32Array,
      );
      oldNormals.needsUpdate = true;
    }
  }, [geometry, props.vertices, props.faces, raycastOnly]);

  // Clean up geometry when it changes.
  React.useEffect(() => {
    return () => {
      if (geometry) geometry.dispose();
    };
  }, [geometry]);

  // Check if we should render a shadow mesh.
  const shadowOpacity =
    typeof props.receive_shadow === "number" ? props.receive_shadow : 0.0;
  const scale = normalizeScale(props.scale);
  const outlines = (
    <OutlinesIfHovered
      enableCreaseAngle={
        geometry.attributes.position.count < 1024 &&
        geometry.boundingSphere!.radius > 0.1
      }
    />
  );

  if (raycastOnly) {
    return (
      <mesh
        geometry={geometry}
        scale={scale}
        layers={raycastOnlyLayers}
        material={raycastOnlyMaterials[props.side]}
      >
        {outlines}
      </mesh>
    );
  }
  return (
    <>
      <mesh
        geometry={geometry}
        scale={scale}
        castShadow={props.cast_shadow}
        receiveShadow={props.receive_shadow === true}
      >
        <ViserStandardMeshMaterial {...props} />
        {outlines}
      </mesh>
      <ShadowMesh opacity={shadowOpacity} geometry={geometry} scale={scale} />
    </>
  );
}
