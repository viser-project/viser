import * as THREE from "three";
import React from "react";
import { disposeMaterial } from "./meshMaterialUtils";
import { GLTF, GLTFLoader, DRACOLoader } from "three-stdlib";

// We use a CDN for Draco. We could move this locally if we want to use Viser offline.
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");

/**
 * Dispose a 3D object and its resources
 */
/**
 * True if the geometry has an RGBA vertex color attribute with any alpha below
 * 1. glTF COLOR_0 may be VEC4, and three.js does blend that alpha into the
 * fragment color (USE_COLOR_ALPHA) -- but GLTFLoader never flags the material
 * as transparent for it, so without this the mesh renders opaque. trimesh
 * exports RGBA vertex/face colors this way (#525).
 */
export function hasTranslucentVertexColors(
  geometry: THREE.BufferGeometry,
): boolean {
  const color = geometry.getAttribute("color");
  if (color === undefined || color.itemSize !== 4) return false;
  for (let i = 0; i < color.count; i++) {
    // getW() denormalizes UNSIGNED_BYTE colors to [0, 1].
    if (color.getW(i) < 1.0) return true;
  }
  return false;
}

export function disposeNode(node: any) {
  if (node instanceof THREE.Mesh) {
    if (node.geometry) {
      node.geometry.dispose();
    }
    if (node.material) {
      if (Array.isArray(node.material)) {
        node.material.forEach((material) => {
          disposeMaterial(material);
        });
      } else {
        disposeMaterial(node.material);
      }
    }
  }
}

/**
 * Custom hook for loading a GLB model.
 */
export function useGlbLoader(glb_data: Uint8Array) {
  // State for loaded model and meshes, tagged by the exact input object they
  // were parsed from. On a `glb_data` change, render must stop returning the
  // previous scene immediately: the old load's cleanup can dispose it before
  // the new parse completes.
  const [loaded, setLoaded] = React.useState<
    | {
        source: Uint8Array;
        gltf: GLTF;
        meshes: THREE.Mesh[];
        // Per-mesh transforms relative to the gltf.scene root. These capture
        // ancestor node transforms (e.g. translations on glTF nodes) that are
        // not present in mesh.position/mesh.geometry alone.
        meshMatrices: THREE.Matrix4[];
      }
    | undefined
  >();

  // Animation mixer reference.
  const mixerRef = React.useRef<THREE.AnimationMixer | null>(null);

  // Load the GLB model.
  React.useEffect(() => {
    // Tracks teardown so an async parse that resolves after unmount (or after
    // ``glb_data`` changes) neither updates state nor leaks GPU resources.
    let cancelled = false;
    // The parsed scene, captured in effect scope so cleanup disposes the
    // *actual* loaded resources. (Reading the ``gltf`` state in cleanup would
    // capture the render-time value, which is always ``undefined`` here since
    // it's set asynchronously -- so nothing would ever be disposed.)
    let loadedScene: THREE.Object3D | null = null;

    // Drop the stale result from state as soon as effects run. The return value
    // below also gates by source identity, so stale data is hidden during the
    // render that happens before this effect/cleanup pair runs.
    setLoaded((current) =>
      current?.source === glb_data ? current : undefined,
    );

    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);
    loader.parse(
      new Uint8Array(glb_data).buffer,
      "",
      (gltf) => {
        if (cancelled) {
          // Unmounted/changed before the parse finished: dispose the freshly
          // parsed resources rather than leaking them, and skip the state
          // updates (which would warn and write into a dead component).
          gltf.scene.traverse(disposeNode);
          return;
        }
        loadedScene = gltf.scene;

        // Setup animations if present.
        if (gltf.animations && gltf.animations.length) {
          mixerRef.current = new THREE.AnimationMixer(gltf.scene);
          gltf.animations.forEach((clip) => {
            mixerRef.current!.clipAction(clip).play();
          });
        }

        // Compute world matrices relative to gltf.scene root before it gets
        // attached to the live scene graph (after attach, matrixWorld is
        // re-computed against the real scene).
        gltf.scene.updateMatrixWorld(true);
        const sceneInverse = new THREE.Matrix4()
          .copy(gltf.scene.matrixWorld)
          .invert();

        // Process all meshes in the scene.
        const meshes: THREE.Mesh[] = [];
        const meshMatrices: THREE.Matrix4[] = [];
        gltf?.scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.computeVertexNormals();
            obj.geometry.computeBoundingSphere();
            if (hasTranslucentVertexColors(obj.geometry)) {
              // Material-less primitives with vertex colors share one cached
              // material, so mark a copy rather than the shared instance.
              const markTransparent = (material: THREE.Material) => {
                const copy = material.clone();
                copy.transparent = true;
                return copy;
              };
              obj.material = Array.isArray(obj.material)
                ? obj.material.map(markTransparent)
                : markTransparent(obj.material);
            }
            meshes.push(obj);
            meshMatrices.push(
              new THREE.Matrix4().multiplyMatrices(
                sceneInverse,
                obj.matrixWorld,
              ),
            );
          }
        });

        setLoaded({
          source: glb_data,
          gltf,
          meshes,
          meshMatrices,
        });
      },
      (error) => {
        console.log("Error loading GLB!");
        console.log(error);
      },
    );

    // Cleanup function.
    return () => {
      cancelled = true;
      if (mixerRef.current) {
        mixerRef.current.stopAllAction();
        mixerRef.current = null;
      }
      // Free the GPU resources owned by this load. If the parse hasn't
      // resolved yet, the ``cancelled`` branch above disposes them instead.
      if (loadedScene) {
        loadedScene.traverse(disposeNode);
      }
    };
  }, [glb_data]);

  // Return the loaded model, meshes, per-mesh matrices, and mixer for
  // animation updates.
  const current = loaded?.source === glb_data ? loaded : undefined;
  return {
    gltf: current?.gltf,
    meshes: current?.meshes ?? [],
    meshMatrices: current?.meshMatrices ?? [],
    mixerRef,
  };
}
