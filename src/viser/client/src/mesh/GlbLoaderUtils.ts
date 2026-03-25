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

        // Process all meshes in the scene
        const meshes: THREE.Mesh[] = [];
        gltf?.scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.computeVertexNormals();
            obj.geometry.computeBoundingSphere();
            meshes.push(obj);
          }
        });

        setMeshes(meshes);
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

  // Return the loaded model, meshes, and mixer for animation updates
  return { gltf, meshes, mixerRef };
}
