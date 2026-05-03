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
 * Custom hook for loading a GLB model
 */
export function useGlbLoader(glb_data: Uint8Array) {
  // State for loaded model and meshes
  const [gltf, setGltf] = React.useState<GLTF>();
  const [meshes, setMeshes] = React.useState<THREE.Mesh[]>([]);
  // Per-mesh transforms relative to the gltf.scene root. These capture
  // ancestor node transforms (e.g. translations on glTF nodes) that are not
  // present in mesh.position/mesh.geometry alone.
  const [meshMatrices, setMeshMatrices] = React.useState<THREE.Matrix4[]>([]);

  // Animation mixer reference
  const mixerRef = React.useRef<THREE.AnimationMixer | null>(null);

  // Load the GLB model
  React.useEffect(() => {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);
    loader.parse(
      new Uint8Array(glb_data).buffer,
      "",
      (gltf) => {
        // Setup animations if present
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

        // Process all meshes in the scene
        const meshes: THREE.Mesh[] = [];
        const meshMatrices: THREE.Matrix4[] = [];
        gltf?.scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.computeVertexNormals();
            obj.geometry.computeBoundingSphere();
            meshes.push(obj);
            meshMatrices.push(
              new THREE.Matrix4().multiplyMatrices(
                sceneInverse,
                obj.matrixWorld,
              ),
            );
          }
        });

        setMeshes(meshes);
        setMeshMatrices(meshMatrices);
        setGltf(gltf);
      },
      (error) => {
        console.log("Error loading GLB!");
        console.log(error);
      },
    );

    // Cleanup function
    return () => {
      if (mixerRef.current) mixerRef.current.stopAllAction();

      // Attempt to free resources
      if (gltf) {
        gltf.scene.traverse(disposeNode);
      }
    };
  }, [glb_data]);

  // Return the loaded model, meshes, per-mesh matrices, and mixer for
  // animation updates.
  return { gltf, meshes, meshMatrices, mixerRef };
}
