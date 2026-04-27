/**
 * Viewer-level drag coordinator.
 *
 * A single ``<DragLayer>`` is mounted under the Canvas and owns:
 *   - the active-drag state (only one drag active at a time across all nodes)
 *   - the drag-indicator arrow (one ArrowHelper per viewer, not per node)
 *   - the window pointermove / pointerup / pointercancel / blur listeners
 *   - the camera-control disable/re-enable around a drag (stashes the exact
 *     instance so a camera-type swap mid-drag doesn't leave the old one
 *     disabled)
 *
 * Scene nodes interact with this layer through the context `useDragLayer()`
 * hook: on pointerdown they match their bindings against the input and
 * call ``beginDrag(...)``; on unmount or binding revoke they call
 * ``stopIfNodeIs(nodeName)``.
 */

import React from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { ViewerContext } from "./ViewerContext";
import { SceneNodeDragMessage } from "./WebsocketMessages";
import {
  ndcFromPointerXyClamped,
  opencvXyFromPointerXy,
} from "./utils/pointerCoords";
import { normalizeScale } from "./utils/normalizeScale";
import { useThrottledMessageSender } from "./WebsocketUtils";
import {
  ActiveDragState,
  DragBinding,
  DragInput,
  DragScratches,
  anyBindingMatches,
  computeInstanceWorldMatrix,
  isInstancedMesh2VendoredMessage,
  pointToViserTuple,
  rayToViserTuples,
} from "./dragUtils";
import { useDragArrow } from "./useDragArrow";

// =============================================================================
// Context.
// =============================================================================

export type BeginDragArgs = {
  nodeName: string;
  /** Instance index for batched meshes/GLBs/axes. ``null`` for non-batched
   * nodes. Frozen at drag-start and sent on every drag message. */
  instanceIndex: number | null;
  targetObj: THREE.Object3D;
  eventPoint: THREE.Vector3;
  eventRay: THREE.Ray;
  pointerXy: [number, number];
  /** PointerId of the pointerdown that's starting this drag. Used to
   * filter unrelated pointer events on multi-touch surfaces. */
  pointerId: number;
  input: DragInput;
  bindings: DragBinding[];
};

export interface DragLayerApi {
  /** Attempt to start a drag on the given scene node. No-op if any drag
   * is already active, or if no binding matches the current input. */
  beginDrag(args: BeginDragArgs): void;
  /** End the active drag if (and only if) it targets the given node. */
  stopIfNodeIs(nodeName: string): void;
}

const DragLayerContext = React.createContext<DragLayerApi | null>(null);

export function useDragLayer(): DragLayerApi | null {
  return React.useContext(DragLayerContext);
}

// =============================================================================
// DragLayer component.
// =============================================================================

export function DragLayer({ children }: { children?: React.ReactNode }) {
  const viewer = React.useContext(ViewerContext)!;
  const viewerMutable = viewer.mutable.current;
  const { raycaster, camera } = useThree();

  const { send: sendDragsThrottled, flush: flushDragsThrottled } =
    useThrottledMessageSender(50);

  const activeDragRef = React.useRef<ActiveDragState | null>(null);

  // Reused across the drag-active hot path (pointermove + message
  // build). All reads/writes are serial on the main thread so a shared
  // mutable store is safe.
  const frameScratches = React.useMemo(
    () => ({
      instanceWorld: new THREE.Matrix4(),
      drag: {
        instanceLocal: new THREE.Matrix4(),
        quat: new THREE.Quaternion(),
        pos: new THREE.Vector3(),
        scale: new THREE.Vector3(),
      } satisfies DragScratches,
    }),
    [],
  );

  // Recompute the live pointer-on-drag-plane intersection and stash the
  // result on the active drag. Returns false if the camera ray misses
  // the plane (e.g. ray parallel to plane); the caller should skip
  // sending an update in that case. Mutates the existing scratch
  // vectors/ray on ``activeDrag`` — no allocation per pointermove.
  const updateActiveDragEnd = React.useCallback(
    (clientX: number, clientY: number): boolean => {
      const activeDrag = activeDragRef.current;
      if (activeDrag === null) return false;
      const canvasBbox = viewerMutable.canvas!.getBoundingClientRect();
      activeDrag.endPointerXy[0] = clientX - canvasBbox.left;
      activeDrag.endPointerXy[1] = clientY - canvasBbox.top;
      const ndc = ndcFromPointerXyClamped(viewer, activeDrag.endPointerXy);
      raycaster.setFromCamera(ndc, camera);
      if (
        raycaster.ray.intersectPlane(
          activeDrag.dragPlane,
          activeDrag.endPointWorld,
        ) === null
      )
        return false;
      activeDrag.endRay.copy(raycaster.ray);
      return true;
    },
    [camera, raycaster, viewer, viewerMutable],
  );

  // Project a Three.js world-space point through the current camera and
  // return its OpenCV-style screen position ([0,1] x [0,1], origin at
  // top-left). Allocation-free via a memoized scratch. */
  const screenProjScratch = React.useMemo(() => new THREE.Vector3(), []);
  const projectToOpenCvScreen = React.useCallback(
    (pointWorld: THREE.Vector3): [number, number] => {
      screenProjScratch.copy(pointWorld).project(camera);
      return [
        (screenProjScratch.x + 1) * 0.5,
        (1 - screenProjScratch.y) * 0.5,
      ];
    },
    [camera, screenProjScratch],
  );

  // Compute the live "start" world point: the click point in instance-
  // local frame, transformed by the current instance-to-world matrix.
  // Returns ``null`` if the batched pose is unavailable.
  const computeStartWorld = React.useCallback(
    (
      activeDrag: ActiveDragState,
      out: THREE.Vector3,
    ): THREE.Vector3 | null => {
      const m = computeInstanceWorldMatrix(
        viewer,
        activeDrag.nodeName,
        activeDrag.targetObj,
        activeDrag.instanceIndex,
        frameScratches.instanceWorld,
        frameScratches.drag,
      );
      if (m === null) return null;
      return out.copy(activeDrag.startLocalOffset).applyMatrix4(m);
    },
    [frameScratches, viewer],
  );

  const dragArrow = useDragArrow(activeDragRef, computeStartWorld);

  // Build the flat wire payload for a SceneNodeDragMessage. Reads the
  // *current* state of activeDrag — start_position is recomputed from
  // ``startLocalOffset`` so it tracks the object's live pose. */
  const startWorldScratch = React.useMemo(() => new THREE.Vector3(), []);
  const buildDragMessage = React.useCallback(
    (
      activeDrag: ActiveDragState,
      phase: "start" | "update" | "end",
    ): SceneNodeDragMessage | null => {
      // If the live grab point is unavailable (node removed mid-drag,
      // batched index out of bounds, etc.) we have no honest value for
      // ``start_position`` — skip the message rather than synthesize a
      // misleading ``start == end`` payload. The drag will be torn
      // down by ``stopIfNodeIs`` (called from the unmount path) once
      // React processes the removal.
      const startWorld = computeStartWorld(activeDrag, startWorldScratch);
      if (startWorld === null) return null;
      const endRayViser = rayToViserTuples(viewer, activeDrag.endRay);
      const endScreenPos = opencvXyFromPointerXy(
        viewer,
        activeDrag.endPointerXy,
      );
      return {
        type: "SceneNodeDragMessage",
        phase,
        name: activeDrag.nodeName,
        instance_index: activeDrag.instanceIndex,
        start_position: pointToViserTuple(viewer, startWorld),
        start_screen_pos: projectToOpenCvScreen(startWorld),
        end_position: pointToViserTuple(viewer, activeDrag.endPointWorld),
        end_screen_pos: [endScreenPos.x, endScreenPos.y],
        end_ray_origin: endRayViser.origin,
        end_ray_direction: endRayViser.direction,
        button: activeDrag.input.button,
        ctrl: activeDrag.input.ctrl,
        meta: activeDrag.input.meta,
        shift: activeDrag.input.shift,
        alt: activeDrag.input.alt,
      };
    },
    [computeStartWorld, projectToOpenCvScreen, startWorldScratch, viewer],
  );

  // Build + send a drag message in one call, no-op if ``buildDragMessage``
  // returns null (live grab point unavailable). Wraps the duplicated
  // null-check pattern at the three send sites. */
  const sendDragMessage = React.useCallback(
    (
      activeDrag: ActiveDragState,
      phase: "start" | "update" | "end",
      throttle: boolean,
    ) => {
      const message = buildDragMessage(activeDrag, phase);
      if (message === null) return;
      if (throttle) sendDragsThrottled(message);
      else viewerMutable.sendMessage(message);
    },
    [buildDragMessage, sendDragsThrottled, viewerMutable],
  );

  type EndInfo = {
    clientX: number;
    clientY: number;
  };

  const stopActiveDrag = React.useCallback(
    (sendEndMessage: boolean, endInfo?: EndInfo) => {
      const activeDrag = activeDragRef.current;
      if (activeDrag === null) return;

      if (endInfo !== undefined) {
        // Refresh end fields from the final pointer position; if the
        // ray misses the plane (rare grazing case) we keep whatever was
        // set on the last successful pointermove.
        updateActiveDragEnd(endInfo.clientX, endInfo.clientY);
      }

      flushDragsThrottled();
      if (sendEndMessage) {
        // Modifier state is frozen at drag_start: a drag is "owned" by
        // whichever (button, modifiers) combo was held when the user
        // pressed the mouse, and stays owned by that combo until release
        // regardless of modifier changes mid-drag. This guarantees the
        // drag_start / drag_end callbacks see the same dispatch and
        // avoids a class of footguns where a key-up arrives a beat
        // before mouse-up (downgrading the gesture at the last moment)
        // or a modifier is accidentally pressed mid-drag.
        sendDragMessage(activeDrag, "end", false);
      }

      activeDrag.cleanup();
      activeDragRef.current = null;
      dragArrow.visible = false;
      // Re-enable the *same* camera control instance we disabled — a
      // camera-type swap during the drag would have replaced
      // viewerMutable.cameraControl, and restoring the new one would
      // leave the stashed one disabled forever.
      if (activeDrag.cameraControl !== null) {
        activeDrag.cameraControl.enabled = true;
      }
    },
    [
      dragArrow,
      flushDragsThrottled,
      sendDragMessage,
      updateActiveDragEnd,
      viewerMutable,
    ],
  );

  const api = React.useMemo<DragLayerApi>(
    () => ({
      beginDrag: ({
        nodeName,
        instanceIndex,
        targetObj,
        eventPoint,
        eventRay,
        pointerXy,
        pointerId,
        input,
        bindings,
      }) => {
        if (activeDragRef.current !== null) return;
        if (!anyBindingMatches(bindings, input)) return;

        // Convert the raycast hit point to world coords. The frame of
        // ``eventPoint`` depends on which raycast produced it:
        //   - ``BatchedMeshesMessage`` / ``BatchedGlbMessage`` use the
        //     vendored ``InstancedMesh2``, whose raycast leaves the
        //     intersection point in InstancedMesh2-local space (it
        //     skips the standard ``mesh.matrixWorld`` re-application;
        //     see ``vendor/instanced-mesh/core/feature/Raycasting.ts``).
        //     We compose with the inner scale-group's world transform
        //     to recover world coords.
        //   - All other meshes (incl. ``BatchedAxesMessage`` which uses
        //     a stock ``THREE.InstancedMesh``) emit ``e.point`` in
        //     world coords already.
        const node = viewer.useSceneTree.get(nodeName);
        const startWorld = eventPoint.clone();
        if (node !== undefined && isInstancedMesh2VendoredMessage(node.message)) {
          targetObj.updateWorldMatrix(true, false);
          const [sx, sy, sz] = normalizeScale(node.message.props.scale);
          startWorld.applyMatrix4(
            new THREE.Matrix4()
              .copy(targetObj.matrixWorld)
              .scale(new THREE.Vector3(sx, sy, sz)),
          );
        }

        // Stash the click point in the active instance's local coords
        // so the per-frame tail update (and start_position on each wire
        // message) can recover its world position from the instance's
        // current transform. For a non-batched node this degenerates
        // to the scene-node's local frame.
        const instanceWorldStart = new THREE.Matrix4();
        const computed = computeInstanceWorldMatrix(
          viewer,
          nodeName,
          targetObj,
          instanceIndex,
          instanceWorldStart,
          frameScratches.drag,
        );
        if (computed === null) return;
        const startLocalOffset = startWorld
          .clone()
          .applyMatrix4(instanceWorldStart.invert());

        const handleWindowPointerMove = (event: PointerEvent) => {
          const activeDrag = activeDragRef.current;
          if (activeDrag === null) return;
          // Ignore pointers that didn't start this drag — multi-touch
          // surfaces happily deliver other fingers' events through the
          // same window listener.
          if (event.pointerId !== activeDrag.pointerId) return;
          if (!updateActiveDragEnd(event.clientX, event.clientY)) return;

          // Modifier/button state is frozen at drag_start and reused on
          // every update/end — see the note in `stopActiveDrag` above.
          // ``start_position`` is recomputed live inside buildDragMessage,
          // so the wire payload always reflects the click point's
          // current world position (tracking the moving object).
          sendDragMessage(activeDrag, "update", true);
          // The per-frame useFrame updates the arrow tail from target
          // transforms; no manual update needed here.
        };

        const handleWindowPointerUp = (event: PointerEvent) => {
          // Ignore mismatched pointers — we only end the drag when the
          // *same* pointer that started it lifts up (or cancels).
          const activeDrag = activeDragRef.current;
          if (activeDrag === null) return;
          if (event.pointerId !== activeDrag.pointerId) return;
          stopActiveDrag(true, {
            clientX: event.clientX,
            clientY: event.clientY,
          });
        };

        const handleWindowBlur = () => {
          stopActiveDrag(true);
        };

        const cleanup = () => {
          window.removeEventListener("pointermove", handleWindowPointerMove);
          window.removeEventListener("pointerup", handleWindowPointerUp);
          window.removeEventListener("pointercancel", handleWindowPointerUp);
          window.removeEventListener("blur", handleWindowBlur);
        };

        // Plane parallel to the camera image plane, through the start
        // intersection. The drag tracks the pointer across this plane for
        // the duration of the drag.
        const cameraDir = new THREE.Vector3();
        camera.getWorldDirection(cameraDir);
        const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          cameraDir,
          startWorld,
        );

        activeDragRef.current = {
          nodeName,
          instanceIndex,
          targetObj,
          pointerId,
          startLocalOffset,
          dragPlane,
          // At drag-start the pointer is exactly at the click point, so
          // ``end`` collapses onto ``start`` (and the message's start_*
          // / end_* fields agree).
          endPointWorld: startWorld.clone(),
          endRay: eventRay.clone(),
          endPointerXy: [pointerXy[0], pointerXy[1]],
          input,
          cameraControl: viewerMutable.cameraControl,
          cleanup,
        };
        dragArrow.visible = false;
        if (viewerMutable.cameraControl !== null) {
          viewerMutable.cameraControl.enabled = false;
        }
        window.addEventListener("pointermove", handleWindowPointerMove);
        window.addEventListener("pointerup", handleWindowPointerUp);
        window.addEventListener("pointercancel", handleWindowPointerUp);
        window.addEventListener("blur", handleWindowBlur);
        sendDragMessage(activeDragRef.current, "start", false);
      },
      stopIfNodeIs: (nodeName) => {
        if (activeDragRef.current?.nodeName === nodeName) {
          stopActiveDrag(true);
        }
      },
    }),
    [
      camera,
      dragArrow,
      frameScratches,
      sendDragMessage,
      stopActiveDrag,
      updateActiveDragEnd,
      viewer,
      viewerMutable,
    ],
  );

  // End any active drag if the DragLayer itself unmounts (viewer
  // teardown). The cleanup must run only at unmount, not whenever
  // ``stopActiveDrag``'s identity changes — so we route through a ref
  // that always points at the latest closure.
  const stopActiveDragRef = React.useRef(stopActiveDrag);
  stopActiveDragRef.current = stopActiveDrag;
  React.useEffect(() => {
    return () => {
      if (activeDragRef.current !== null) {
        stopActiveDragRef.current(false);
      }
    };
  }, []);

  return (
    <DragLayerContext.Provider value={api}>
      {children}
    </DragLayerContext.Provider>
  );
}
