/** Shared types + pure helpers for scene-node drag handling.
 *
 * Split from ``DragLayer.tsx`` so the Fast Refresh (HMR) module boundary
 * only contains components — React warns when a component file also
 * exports non-components. */

import * as THREE from "three";
import { ViewerContextContents } from "./ViewerContext";
import { SceneNodeMessage } from "./WebsocketMessages";
import { pointToViserCoords, rayToViserCoords } from "./WorldTransformUtils";
import { normalizeScale } from "./utils/normalizeScale";

/** Wire-format drag-input filter that the server registers for a node.
 * Mirrors the inlined ``bindings`` field on
 * ``SetSceneNodeDragBindingsMessage`` (the message generator inlines
 * nested-dataclass types so this isn't named on the generated side). */
export type DragBinding = {
  button: "left" | "middle" | "right" | "any";
  modifiers: ("cmd/ctrl" | "alt" | "shift")[] | null;
};

export type PointerButton = "left" | "middle" | "right";

export type DragInput = {
  button: PointerButton;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
};

export function pointerButtonFromNative(native: number): PointerButton | null {
  if (native === 0) return "left";
  if (native === 1) return "middle";
  if (native === 2) return "right";
  return null;
}

/** Match an input against a registered DragBinding. ``modifiers=null`` is a
 * wildcard; otherwise the listed modifiers must be held and any others
 * must not be. ``"cmd/ctrl"`` treats Ctrl and Cmd (meta) as interchangeable
 * — matches whenever either is held. */
export function matchesDragBinding(
  binding: DragBinding,
  input: DragInput,
): boolean {
  if (binding.button !== "any" && binding.button !== input.button) return false;
  if (binding.modifiers === null) return true;
  const modSet = new Set(binding.modifiers);
  if (input.shift !== modSet.has("shift")) return false;
  if (input.alt !== modSet.has("alt")) return false;
  if (modSet.has("cmd/ctrl")) {
    if (!input.ctrl && !input.meta) return false;
  } else {
    if (input.ctrl || input.meta) return false;
  }
  return true;
}

export function anyBindingMatches(
  bindings: DragBinding[],
  input: DragInput,
): boolean {
  return bindings.some((b) => matchesDragBinding(b, input));
}

/** Convert a Three.js world-space point to viser coords as a 3-tuple. */
export function pointToViserTuple(
  viewer: ViewerContextContents,
  pointThreeWorld: THREE.Vector3,
): [number, number, number] {
  const v = pointToViserCoords(viewer, pointThreeWorld);
  return [v.x, v.y, v.z];
}

/** Convert a Three.js world-space ray to viser coords as a pair of 3-tuples. */
export function rayToViserTuples(
  viewer: ViewerContextContents,
  ray: THREE.Ray,
): {
  origin: [number, number, number];
  direction: [number, number, number];
} {
  const r = rayToViserCoords(viewer, ray);
  return {
    origin: [r.origin.x, r.origin.y, r.origin.z],
    direction: [r.direction.x, r.direction.y, r.direction.z],
  };
}

// ============================================================================
// Active-drag state shape + batched-pose math.
// ============================================================================

/** State of an in-progress drag, owned by ``DragLayer``. Refs into
 * scene/three.js objects (targetObj, cameraControl) are captured at
 * drag-start; mutable fields (``endPointWorld``, ``endRay``,
 * ``endPointerXy``) are updated in place on every pointermove. */
export type ActiveDragState = {
  nodeName: string;
  /** Frozen at drag-start. Non-null for batched scene nodes (meshes,
   * GLBs, axes); ``null`` otherwise. */
  instanceIndex: number | null;
  targetObj: THREE.Object3D;
  /** PointerId from the pointerdown that started this drag. Window-level
   * pointermove / pointerup / pointercancel events carry their own
   * pointerId and we ignore mismatches — a second finger's release on a
   * multi-touch surface shouldn't end the first finger's drag. */
  pointerId: number;
  /** Click point expressed in the instance's local coordinate frame
   * (for batched nodes) or the scene-node's local frame (for
   * non-batched). Recovered to world coords each frame via the current
   * instance-to-world matrix; used both for the arrow tail and for
   * ``start_position`` on the wire. */
  startLocalOffset: THREE.Vector3;
  /** Camera-aligned plane, parallel to the image plane and through the
   * initial click point. The pointer ray is intersected with this plane
   * each frame to get ``end_position``. */
  dragPlane: THREE.Plane;
  /** Latest pointer-ray hit point on the drag plane, in Three world
   * coords. Updated on every pointermove (and at end). */
  endPointWorld: THREE.Vector3;
  /** Latest pointer ray (camera origin + direction toward cursor) in
   * Three world coords. Updated on every pointermove (and at end). */
  endRay: THREE.Ray;
  /** Latest pointer pixel coordinates relative to the canvas. Used to
   * compute ``end_screen_pos`` and (re)solve the pointer ray. */
  endPointerXy: [number, number];
  input: DragInput;
  /** Camera-control instance captured at drag-start, so we re-enable the
   * same instance even if the viewer swaps camera types mid-drag. */
  cameraControl: ViewerContextContents["mutable"]["current"]["cameraControl"];
  cleanup: () => void;
};

/** A scene-node message whose props carry per-instance pose arrays. */
export type BatchedSceneNodeMessage = Extract<
  SceneNodeMessage,
  {
    type: "BatchedMeshesMessage" | "BatchedGlbMessage" | "BatchedAxesMessage";
  }
>;

export function isBatchedMessage(
  msg: SceneNodeMessage,
): msg is BatchedSceneNodeMessage {
  return (
    msg.type === "BatchedMeshesMessage" ||
    msg.type === "BatchedGlbMessage" ||
    msg.type === "BatchedAxesMessage"
  );
}

/** Subset of batched message types that route through the vendored
 * ``InstancedMesh2`` (BatchedMesh, BatchedGlb), whose raycast emits
 * ``intersection.point`` in InstancedMesh-local coords instead of
 * world coords — see ``vendor/instanced-mesh/core/feature/Raycasting.ts``.
 *
 * ``BatchedAxesMessage`` is intentionally NOT included: it uses a stock
 * ``THREE.InstancedMesh`` which does the standard ``mesh.matrixWorld``
 * re-application, so its ``e.point`` is already world coords. */
export function isInstancedMesh2VendoredMessage(
  msg: SceneNodeMessage,
): msg is Extract<
  SceneNodeMessage,
  { type: "BatchedMeshesMessage" | "BatchedGlbMessage" }
> {
  return (
    msg.type === "BatchedMeshesMessage" || msg.type === "BatchedGlbMessage"
  );
}

/** Per-frame scratches reused by ``computeInstanceWorldMatrix`` and its
 * helper, so the per-frame tail-update path makes zero allocations. */
export type DragScratches = {
  instanceLocal: THREE.Matrix4;
  quat: THREE.Quaternion;
  pos: THREE.Vector3;
  scale: THREE.Vector3;
};

/** Build the instance-local transform for a single batched-message
 * instance directly from the message's typed-array props. Returns null
 * if the index is out of bounds.
 *
 * Reading from the message rather than ``InstancedMesh2.getMatrixAt``
 * avoids three brittlenesses:
 *   1. ``BatchedAxes`` writes 3 InstancedMesh entries per logical axis,
 *      so ``getMatrixAt(logicalIndex)`` returns the X-axis cylinder for
 *      that frame, not the frame's logical pose.
 *   2. The InstancedMesh2 child can be remounted (e.g. when LoD switches
 *      reconstruct it), invalidating any stashed reference.
 *   3. ``getMatrixAt`` does no bounds-check — past-end reads silently
 *      return whatever was last written there. */
export function readBatchedInstanceLocalMatrix(
  message: BatchedSceneNodeMessage,
  instanceIndex: number,
  out: THREE.Matrix4,
  scratch: DragScratches,
): THREE.Matrix4 | null {
  const { batched_positions, batched_wxyzs, batched_scales } = message.props;
  const numInstances = batched_wxyzs.length / 4;
  if (instanceIndex < 0 || instanceIndex >= numInstances) return null;

  const posIdx = instanceIndex * 3;
  const wxyzIdx = instanceIndex * 4;
  scratch.quat.set(
    batched_wxyzs[wxyzIdx + 1],
    batched_wxyzs[wxyzIdx + 2],
    batched_wxyzs[wxyzIdx + 3],
    batched_wxyzs[wxyzIdx],
  );
  scratch.pos.set(
    batched_positions[posIdx],
    batched_positions[posIdx + 1],
    batched_positions[posIdx + 2],
  );
  if (batched_scales === null) {
    scratch.scale.set(1, 1, 1);
  } else if (batched_scales.length === numInstances * 3) {
    const scaleIdx = instanceIndex * 3;
    scratch.scale.set(
      batched_scales[scaleIdx],
      batched_scales[scaleIdx + 1],
      batched_scales[scaleIdx + 2],
    );
  } else {
    const s = batched_scales[instanceIndex] ?? 1;
    scratch.scale.set(s, s, s);
  }
  return out.compose(scratch.pos, scratch.quat, scratch.scale);
}

/** Compute the matrix that maps a point in the active drag target's
 * local frame to Three.js world coords.
 *
 * For a non-batched node, the target is ``targetObj`` (the scene-node
 * Group) and its ``matrixWorld`` already includes the full ancestor
 * chain — including the ``""`` root node's frame-conversion rotation.
 *
 * For a batched node, the per-instance transform is read from the scene
 * store via ``readBatchedInstanceLocalMatrix``. The full world matrix
 * is then ``targetObj.matrixWorld @ scaleMatrix @ instanceLocal``,
 * where ``scaleMatrix`` is the inner ``<group scale={...}>`` that wraps
 * the InstancedMesh2/InstancedMesh in BatchedMesh / BatchedGlb /
 * InstancedAxes. Returns null if the batched pose is unavailable
 * (out-of-bounds index, node removed, etc.). */
export function computeInstanceWorldMatrix(
  viewer: ViewerContextContents,
  nodeName: string,
  targetObj: THREE.Object3D,
  instanceIndex: number | null,
  out: THREE.Matrix4,
  scratch: DragScratches,
): THREE.Matrix4 | null {
  targetObj.updateWorldMatrix(true, false);
  if (instanceIndex === null) {
    return out.copy(targetObj.matrixWorld);
  }
  const node = viewer.useSceneTree.get(nodeName);
  if (node === undefined || !isBatchedMessage(node.message)) return null;
  const instLocal = readBatchedInstanceLocalMatrix(
    node.message,
    instanceIndex,
    scratch.instanceLocal,
    scratch,
  );
  if (instLocal === null) return null;
  const [sx, sy, sz] = normalizeScale(node.message.props.scale);
  return out
    .copy(targetObj.matrixWorld)
    .scale(scratch.scale.set(sx, sy, sz))
    .multiply(instLocal);
}
