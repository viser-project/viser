import * as THREE from "three";

/** Layer for objects that should be raycast against, but not drawn. */
export const RAYCAST_ONLY_LAYER = 30;
export const raycastOnlyLayers = new THREE.Layers();
raycastOnlyLayers.set(RAYCAST_ONLY_LAYER);

export const raycastOnlyMaterials = {
  front: new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
  back: new THREE.MeshBasicMaterial({ side: THREE.BackSide }),
  double: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
};
