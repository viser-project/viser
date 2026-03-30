import { ViewerContextContents } from "./ViewerContext";
import * as THREE from "three";

/** Helper for computing the transformation between the three.js world and the
 * Python-exposed world frames. This is useful for things like switching
 * between +Y and +Z up directions for the world frame. */
export function computeT_threeworld_world(viewer: ViewerContextContents) {
  const rootNode = viewer.useSceneTree.get("");
  const wxyz = rootNode!.wxyz!;
  const rootPose = viewer.mutable.current.nodePoseData[""];
  const position = rootPose?.position ?? rootNode!.position ?? [0, 0, 0];
  return new THREE.Matrix4()
    .makeRotationFromQuaternion(
      new THREE.Quaternion(wxyz[1], wxyz[2], wxyz[3], wxyz[0]),
    )
    .setPosition(position[0], position[1], position[2]);
}

/** Helper for converting a ray from the three.js world frame to the Python
 * world frame. Applies the transformation from computeT_threeworld_world.
 */
export function rayToViserCoords(
  viewer: ViewerContextContents,
  ray: THREE.Ray,
): THREE.Ray {
  const T_world_threeworld = computeT_threeworld_world(viewer).invert();

  const origin = ray.origin.clone().applyMatrix4(T_world_threeworld);

  // Compute just the rotation term without new memory allocation; this
  // will mutate T_world_threeworld!
  const R_world_threeworld = T_world_threeworld.setPosition(0.0, 0.0, 0);
  const direction = ray.direction.clone().applyMatrix4(R_world_threeworld);

  return new THREE.Ray(origin, direction);
}
