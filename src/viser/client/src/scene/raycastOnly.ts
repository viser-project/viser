import * as THREE from "three";

/** Layer for objects that should be raycast against, but not drawn. */
export const RAYCAST_ONLY_LAYER = 30;
export const raycastOnlyLayers = new THREE.Layers();
raycastOnlyLayers.set(RAYCAST_ONLY_LAYER);

/** Layers for objects that are drawn. Should be set explicitly by objects that may
 * switch between the two. */
export const drawnLayers = new THREE.Layers();
