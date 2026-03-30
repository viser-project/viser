/** Gaussian splatting implementation for viser.
 *
 * This borrows heavily from existing open-source implementations. Particularly
 * useful references:
 * - https://github.com/quadjr/aframe-gaussian-splatting
 * - https://github.com/antimatter15/splat
 * - https://github.com/pmndrs/drei
 * - https://github.com/vincent-lecrubier-skydio/react-three-fiber-gaussian-splat
 *
 * Usage should look like:
 *
 * <Canvas>
 *   <SplatRenderContext>
 *     <SplatObject buffer={buffer} />
 *   </SplatRenderContext>
 * </Canvas>
 *
 * Where `buffer` contains serialized Gaussian attributes. SplatObjects are
 * globally sorted by a worker (with some help from WebAssembly + SIMD
 * intrinsics), and then rendered as a single threejs mesh. Unlike other R3F
 * implementations that we're aware of, this enables correct compositing
 * between multiple splat objects.
 */

import MakeSorterModuleFactory from "./WasmSorter/Sorter.mjs";
// Import WASM as base64 URL for inlining - avoids import.meta.url issues with blob URLs.
import SorterWasmUrl from "./WasmSorter/Sorter.wasm?url";

// Fetch WASM binary and pass to Emscripten module to avoid import.meta.url issues.
const SorterModulePromise = fetch(SorterWasmUrl)
  .then((response) => response.arrayBuffer())
  .then((wasmBinary) => MakeSorterModuleFactory({ wasmBinary }));

import React from "react";
import * as THREE from "three";
import SplatSortWorker from "./SplatSortWorker?worker&inline";
import { useFrame, useThree } from "@react-three/fiber";
import { SorterWorkerIncoming } from "./SplatSortWorker";
import { v4 as uuidv4 } from "uuid";

import {
  GaussianSplatsContext,
  createGaussianMeshProps,
  useGaussianSplatStore,
  type GaussianMeshProps,
} from "./GaussianSplatsHelpers";

/**Provider for creating splat rendering context.*/
export function SplatRenderContext({
  children,
}: {
  children: React.ReactNode;
}) {
  const splatState = useGaussianSplatStore();
  return (
    <GaussianSplatsContext.Provider
      value={{
        gaussianSplatState: splatState,
        updateCamera: React.useRef(null),
        meshPropsRef: React.useRef(null),
      }}
    >
      <SplatRenderer />
      {children}
    </GaussianSplatsContext.Provider>
  );
}
export const SplatObject = React.forwardRef<
  THREE.Group,
  {
    buffer: Uint32Array;
    children?: React.ReactNode;
  }
>(function SplatObject({ buffer, children }, ref) {
  const splatContext = React.useContext(GaussianSplatsContext)!;
  const { setBuffer, removeBuffer } = splatContext.gaussianSplatState.actions;
  const nodeRefFromId = splatContext.gaussianSplatState.store(
    (state) => state.nodeRefFromId,
  );
  // Use stable ID per component instance (not dependent on buffer).
  const name = React.useMemo(() => uuidv4(), []);

  // Cleanup only on unmount.
  React.useEffect(() => {
    return () => {
      removeBuffer(name);
      delete nodeRefFromId.current[name];
    };
  }, [name, removeBuffer, nodeRefFromId]);

  // Update buffer when it changes.
  React.useEffect(() => {
    setBuffer(name, buffer);
  }, [name, buffer, setBuffer]);

  return (
    <group
      ref={(obj) => {
        // We'll (a) forward the ref and (b) store it in the splat rendering
        // state. The latter is used to update the sorter and shader.
        if (obj === null) return;
        if (ref !== null) {
          if ("current" in ref) {
            ref.current = obj;
          } else {
            ref(obj);
          }
        }
        nodeRefFromId.current[name] = obj;
      }}
    >
      {children}
    </group>
  );
});

/** External interface. Component should be added to the root of canvas.  */
function SplatRenderer() {
  const splatContext = React.useContext(GaussianSplatsContext)!;
  const groupBufferFromId = splatContext.gaussianSplatState.store(
    (state) => state.groupBufferFromId,
  );

  // Only mount implementation (which will load sort worker, etc) if there are
  // Gaussians to render.
  return Object.keys(groupBufferFromId).length > 0 ? (
    <SplatRendererImpl />
  ) : null;
}

function SplatRendererImpl() {
  const splatContext = React.useContext(GaussianSplatsContext)!;
  const groupBufferFromId = splatContext.gaussianSplatState.store(
    (state) => state.groupBufferFromId,
  );
  const nodeRefFromId = splatContext.gaussianSplatState.store(
    (state) => state.nodeRefFromId,
  );
  const maxTextureSize = useThree((state) => state.gl).capabilities
    .maxTextureSize;

  // Refs to persist resources across re-renders.
  const sortWorkerRef = React.useRef<Worker | null>(null);
  const meshPropsRef = React.useRef<GaussianMeshProps | null>(null);
  const prevMergedRef = React.useRef<{
    gaussianBuffer: Uint32Array;
    numGaussians: number;
    numGroups: number;
    groupIndices: Uint32Array;
  } | null>(null);
  const isFirstRenderRef = React.useRef(true);
  const initializedBufferTextureRef = React.useRef(false);

  // Force component to re-render when mesh props change.
  const [, forceUpdate] = React.useReducer((x) => x + 1, 0);

  // Consolidate Gaussian groups into a single buffer.
  const merged = mergeGaussianGroups(groupBufferFromId);

  // Helper function to post messages to worker.
  const postToWorker = React.useCallback((message: SorterWorkerIncoming) => {
    if (sortWorkerRef.current) {
      sortWorkerRef.current.postMessage(message);
    }
  }, []);

  // Check if buffer content has changed.
  const bufferChanged =
    !prevMergedRef.current ||
    merged.gaussianBuffer.length !==
      prevMergedRef.current.gaussianBuffer.length ||
    !arraysEqual(merged.gaussianBuffer, prevMergedRef.current.gaussianBuffer);

  // Check if number of Gaussians or groups changed (requires texture resize).
  const sizeChanged =
    prevMergedRef.current &&
    (merged.numGaussians !== prevMergedRef.current.numGaussians ||
      merged.numGroups !== prevMergedRef.current.numGroups);

  // Initialize resources on first render.
  if (isFirstRenderRef.current) {
    // Create mesh props.
    meshPropsRef.current = createGaussianMeshProps(
      merged.gaussianBuffer,
      merged.numGroups,
      maxTextureSize,
    );

    // Create sorting worker.
    sortWorkerRef.current = new SplatSortWorker();
    sortWorkerRef.current.onmessage = (e) => {
      const sortedIndices = e.data.sortedIndices as Uint32Array;
      if (meshPropsRef.current) {
        // Handle case where sorted indices might be from a previous buffer size.
        if (sortedIndices.length === meshPropsRef.current.numGaussians) {
          meshPropsRef.current.sortedIndexAttribute.set(sortedIndices);
          meshPropsRef.current.sortedIndexAttribute.needsUpdate = true;
        }

        // Trigger initial render.
        if (!initializedBufferTextureRef.current) {
          meshPropsRef.current.material.uniforms.numGaussians.value =
            meshPropsRef.current.numGaussians;
          meshPropsRef.current.textureBuffer.needsUpdate = true;
          initializedBufferTextureRef.current = true;
        }
      }
    };

    // Send initial buffer to worker.
    postToWorker({
      setBuffer: merged.gaussianBuffer,
      setGroupIndices: merged.groupIndices,
    });

    prevMergedRef.current = merged;
    isFirstRenderRef.current = false;
  } else if (bufferChanged && meshPropsRef.current) {
    // Handle buffer updates.
    if (sizeChanged) {
      // Size changed - need to recreate mesh props.
      const oldProps = meshPropsRef.current;

      // Create new mesh props with new size.
      meshPropsRef.current = createGaussianMeshProps(
        merged.gaussianBuffer,
        merged.numGroups,
        maxTextureSize,
      );

      // Dispose old resources.
      oldProps.textureBuffer.dispose();
      oldProps.geometry.dispose();
      oldProps.material.dispose();
      oldProps.textureT_camera_groups.dispose();

      // Update worker with new buffer.
      postToWorker({
        updateBuffer: merged.gaussianBuffer,
        updateGroupIndices: merged.groupIndices,
      });

      // Skip fade-in animation on updates, set numGaussians immediately.
      meshPropsRef.current.material.uniforms.transitionInState.value = 1.0;
      meshPropsRef.current.material.uniforms.numGaussians.value =
        merged.numGaussians;
      meshPropsRef.current.textureBuffer.needsUpdate = true;

      // Force re-render to update the mesh component.
      forceUpdate();
    } else {
      // Same size - update texture data in place.
      const textureData = meshPropsRef.current.textureBuffer.image
        .data as Uint32Array;
      const bufferPadded = new Uint32Array(textureData.length);
      bufferPadded.set(merged.gaussianBuffer);
      textureData.set(bufferPadded);
      meshPropsRef.current.textureBuffer.needsUpdate = true;

      // Update worker with new buffer.
      postToWorker({
        updateBuffer: merged.gaussianBuffer,
        updateGroupIndices: merged.groupIndices,
      });

      // Skip fade-in animation on updates.
      meshPropsRef.current.material.uniforms.transitionInState.value = 1.0;
    }

    prevMergedRef.current = merged;
  }

  // Keep context meshPropsRef in sync.
  splatContext.meshPropsRef.current = meshPropsRef.current;

  // Cleanup on unmount only.
  React.useEffect(() => {
    return () => {
      if (meshPropsRef.current) {
        meshPropsRef.current.textureBuffer.dispose();
        meshPropsRef.current.geometry.dispose();
        meshPropsRef.current.material.dispose();
        meshPropsRef.current.textureT_camera_groups.dispose();
      }
      if (sortWorkerRef.current) {
        sortWorkerRef.current.postMessage({ close: true });
      }
    };
  }, []);

  // Per-frame updates. This is in charge of synchronizing transforms and
  // triggering sorting.
  //
  // We pre-allocate matrices to make life easier for the garbage collector.
  const meshRef = React.useRef<THREE.Mesh>(null);
  const tmpT_camera_group = React.useMemo(() => new THREE.Matrix4(), []);
  const Tz_camera_groupsRef = React.useRef<Float32Array>(
    new Float32Array(merged.numGroups * 4),
  );
  const prevRowMajorT_camera_groupsRef = React.useRef<Float32Array>(
    new Float32Array(0),
  );
  const prevVisiblesRef = React.useRef<boolean[]>([]);

  // Update Tz_camera_groups size if numGroups changed.
  if (Tz_camera_groupsRef.current.length !== merged.numGroups * 4) {
    Tz_camera_groupsRef.current = new Float32Array(merged.numGroups * 4);
  }

  // Track previous camera parameters to avoid redundant updates.
  const prevCameraParams = React.useRef({
    fovY: 0,
    aspect: 0,
    near: 0,
    far: 0,
  });

  // Store projection matrix for 1-frame delay to match texture upload timing.
  const pendingProjectionMatrix = React.useRef(
    new THREE.Matrix4().makePerspective(-1, 1, 1, -1, 0.1, 1000),
  );

  // Make local sorter for blocking sorts (e.g., rendering from virtual cameras).
  const SorterRef = React.useRef<any>(null);
  const sorterBufferVersionRef = React.useRef<number>(0);
  const currentBufferVersionRef = React.useRef<number>(0);

  // Update buffer version when buffer changes.
  if (bufferChanged) {
    currentBufferVersionRef.current += 1;
  }

  // Update local sorter when buffer changes.
  React.useEffect(() => {
    if (sorterBufferVersionRef.current !== currentBufferVersionRef.current) {
      sorterBufferVersionRef.current = currentBufferVersionRef.current;
      (async () => {
        if (SorterRef.current) {
          SorterRef.current.setBuffer(
            merged.gaussianBuffer,
            merged.groupIndices,
          );
        } else {
          SorterRef.current = new (await SorterModulePromise).Sorter(
            merged.gaussianBuffer,
            merged.groupIndices,
          );
        }
      })();
    }
  }, [merged.gaussianBuffer, merged.groupIndices]);

  const updateCamera = React.useCallback(
    function updateCamera(
      camera: THREE.PerspectiveCamera,
      width: number,
      height: number,
      blockingSort: boolean,
    ) {
      const meshProps = meshPropsRef.current;
      if (meshProps === null) return;

      // Force immediate camera matrix updates to avoid lag.
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();

      // Update camera parameter uniforms.
      const fovY = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180.0;
      const aspect = width / height;

      if (meshProps.material === undefined) return;

      const uniforms = meshProps.material.uniforms;
      uniforms.near.value = camera.near;
      uniforms.far.value = camera.far;
      uniforms.viewport.value = [width, height];

      const Tz_camera_groups = Tz_camera_groupsRef.current;
      const prevVisibles = prevVisiblesRef.current;

      // Ensure prevRowMajorT_camera_groups has correct size.
      if (
        prevRowMajorT_camera_groupsRef.current.length !==
        meshProps.rowMajorT_camera_groups.length
      ) {
        prevRowMajorT_camera_groupsRef.current =
          meshProps.rowMajorT_camera_groups.slice().fill(0);
      }
      const prevRowMajorT_camera_groups =
        prevRowMajorT_camera_groupsRef.current;

      // Update group transforms.
      const T_camera_world = camera.matrixWorldInverse;
      const groupVisibles: boolean[] = [];
      let visibilitiesChanged = false;
      for (const [groupIndex, name] of Object.keys(
        groupBufferFromId,
      ).entries()) {
        const node = nodeRefFromId.current[name];
        if (node === undefined) continue;
        tmpT_camera_group.copy(T_camera_world).multiply(node.matrixWorld);
        const colMajorElements = tmpT_camera_group.elements;
        Tz_camera_groups.set(
          [
            colMajorElements[2],
            colMajorElements[6],
            colMajorElements[10],
            colMajorElements[14],
          ],
          groupIndex * 4,
        );
        const rowMajorElements = tmpT_camera_group.transpose().elements;
        meshProps.rowMajorT_camera_groups.set(
          rowMajorElements.slice(0, 12),
          groupIndex * 12,
        );

        // Determine visibility.
        const visibleNow = node.visible && node.parent !== null;
        groupVisibles.push(visibleNow && prevVisibles[groupIndex] === true);
        if (prevVisibles[groupIndex] !== visibleNow) {
          prevVisibles[groupIndex] = visibleNow;
          visibilitiesChanged = true;
        }
      }

      const groupsMovedWrtCam = !meshProps.rowMajorT_camera_groups.every(
        (v, i) => v === prevRowMajorT_camera_groups[i],
      );

      if (groupsMovedWrtCam) {
        // Gaussians need to be re-sorted.
        if (blockingSort && SorterRef.current !== null) {
          const sortedIndices = SorterRef.current.sort(
            Tz_camera_groups,
          ) as Uint32Array;
          meshProps.sortedIndexAttribute.set(sortedIndices);
          meshProps.sortedIndexAttribute.needsUpdate = true;
        } else {
          postToWorker({
            setTz_camera_groups: Tz_camera_groups,
          });
        }
      }
      if (groupsMovedWrtCam || visibilitiesChanged) {
        // If a group is not visible, throw it off the screen.
        for (const [i, visible] of groupVisibles.entries()) {
          if (!visible) {
            meshProps.rowMajorT_camera_groups[i * 12 + 3] = 1e10;
            meshProps.rowMajorT_camera_groups[i * 12 + 7] = 1e10;
            meshProps.rowMajorT_camera_groups[i * 12 + 11] = 1e10;
          }
        }
        prevRowMajorT_camera_groups.set(meshProps.rowMajorT_camera_groups);
        meshProps.textureT_camera_groups.needsUpdate = true;
      }

      // Apply the previous frame's projection matrix (1-frame delay for sync with texture).
      meshProps.material.uniforms.projectionMatrixCustom.value.copy(
        pendingProjectionMatrix.current,
      );

      // Calculate projection matrix for next frame (only if parameters changed).
      const near = camera.near;
      const far = camera.far;
      const params = prevCameraParams.current;

      if (
        fovY !== params.fovY ||
        aspect !== params.aspect ||
        near !== params.near ||
        far !== params.far
      ) {
        const tanHalfFovY = Math.tan(fovY / 2);
        const top = near * tanHalfFovY;
        const bottom = -top;
        const right = top * aspect;
        const left = -right;

        pendingProjectionMatrix.current.makePerspective(
          left,
          right,
          top,
          bottom,
          near,
          far,
          THREE.WebGLCoordinateSystem,
          camera.reversedDepth,
        );

        params.fovY = fovY;
        params.aspect = aspect;
        params.near = near;
        params.far = far;
      }
    },
    [groupBufferFromId, nodeRefFromId, tmpT_camera_group, postToWorker],
  );
  splatContext.updateCamera.current = updateCamera;

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    const meshProps = meshPropsRef.current;
    if (
      mesh === null ||
      meshProps === null ||
      sortWorkerRef.current === null ||
      meshProps.rowMajorT_camera_groups.length === 0
    )
      return;

    const uniforms = meshProps.material.uniforms;
    uniforms.transitionInState.value = Math.min(
      uniforms.transitionInState.value + delta * 2.0,
      1.0,
    );

    updateCamera(
      state.camera as THREE.PerspectiveCamera,
      state.viewport.dpr * state.size.width,
      state.viewport.dpr * state.size.height,
      false /* blockingSort */,
    );
  }, -100 /* This should be called early to reduce group transform artifacts. */);

  const meshProps = meshPropsRef.current!;
  return (
    <mesh
      ref={meshRef}
      geometry={meshProps.geometry}
      material={meshProps.material}
      renderOrder={10000.0 /*Generally, we want to render last.*/}
    />
  );
}

/** Fast comparison of two Uint32Arrays. */
function arraysEqual(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**Consolidate groups of Gaussians into a single buffer, to make it possible
 * for them to be sorted globally.*/
function mergeGaussianGroups(groupBufferFromName: {
  [name: string]: Uint32Array;
}) {
  // Create geometry. Each Gaussian will be rendered as a quad.
  let totalBufferLength = 0;
  for (const buffer of Object.values(groupBufferFromName)) {
    totalBufferLength += buffer.length;
  }
  const numGaussians = totalBufferLength / 8;
  const gaussianBuffer = new Uint32Array(totalBufferLength);
  const groupIndices = new Uint32Array(numGaussians);

  let offset = 0;
  for (const [groupIndex, groupBuffer] of Object.values(
    groupBufferFromName,
  ).entries()) {
    groupIndices.fill(
      groupIndex,
      offset / 8,
      (offset + groupBuffer.length) / 8,
    );
    gaussianBuffer.set(groupBuffer, offset);

    // Each Gaussian is allocated
    // - 12 bytes for center x, y, z (float32)
    // - 4 bytes for group index (uint32); we're filling this in now
    //
    // - 12 bytes for covariance (6 terms, float16)
    // - 4 bytes for RGBA (uint8)
    for (let i = 0; i < groupBuffer.length; i += 8) {
      gaussianBuffer[offset + i + 3] = groupIndex;
    }
    offset += groupBuffer.length;
  }

  const numGroups = Object.keys(groupBufferFromName).length;
  return { numGaussians, gaussianBuffer, numGroups, groupIndices };
}
