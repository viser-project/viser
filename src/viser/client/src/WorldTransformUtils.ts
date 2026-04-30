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

/** Helper for converting a point from the three.js world frame to the Python
 * world frame.
 */
export function pointToViserCoords(
  viewer: ViewerContextContents,
  point: THREE.Vector3,
): THREE.Vector3 {
  return point.clone().applyMatrix4(computeT_threeworld_world(viewer).invert());
}

/** Scratch-aware variant of ``computeT_threeworld_world`` — writes the
 * matrix into ``out`` and uses ``scratchQuat`` for the intermediate
 * quaternion. Allocation-free; intended for hot paths (e.g. the drag
 * message builder, which calls this once per send). */
export function computeT_threeworld_worldInto(
  viewer: ViewerContextContents,
  out: THREE.Matrix4,
  scratchQuat: THREE.Quaternion,
): THREE.Matrix4 {
  const rootNode = viewer.useSceneTree.get("");
  const wxyz = rootNode!.wxyz!;
  const rootPose = viewer.mutable.current.nodePoseData[""];
  const position = rootPose?.position ?? rootNode!.position ?? [0, 0, 0];
  scratchQuat.set(wxyz[1], wxyz[2], wxyz[3], wxyz[0]);
  return out
    .makeRotationFromQuaternion(scratchQuat)
    .setPosition(position[0], position[1], position[2]);
}

/** Scratch-aware point conversion: writes ``point`` transformed by
 * ``T_world_threeworld`` into ``out``. Caller is responsible for
 * computing the matrix (via ``computeT_threeworld_worldInto`` then
 * ``.invert()``) — typically once and reused across multiple points. */
export function pointToViserCoordsInto(
  point: THREE.Vector3,
  T_world_threeworld: THREE.Matrix4,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.copy(point).applyMatrix4(T_world_threeworld);
}
