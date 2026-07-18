/**
 * Viewer-level drag coordinator.
 *
 * A single ``<DragLayer>`` is mounted under the Canvas and owns:
 *   - the active-drag state (only one drag active at a time across all nodes)
 *   - the drag-indicator arrow (one ArrowHelper per viewer, not per node)
 *   - the window pointermove / pointerup / pointercancel / blur listeners
 *   - the camera-control lease around a drag
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
import {
  computeT_threeworld_worldInto,
  pointToViserCoordsInto,
} from "./WorldTransformUtils";
import { useThrottledMessageSender } from "./WebsocketUtils";
import {
  ActiveDragState,
  DragScratches,
  KeyModifier,
  anyBindingMatches,
  computeInstanceWorldMatrix,
  isInstancedMesh2VendoredMessage,
  keyModifierFromEvent,
  planDragStart,
  planModifierTransition,
} from "./dragUtils";
import { DragLayerApi, DragLayerContext } from "./dragLayerContext";
import { useDragArrow } from "./useDragArrow";

// =============================================================================
// DragLayer component.
// =============================================================================

/** In playback / embedded / static viewers ``sendMessage`` is a no-op,
 * so dragging makes no sense (it would disable camera controls and
 * swallow left-clicks with nothing on the receiving end). The outer
 * component branches on ``messageSource`` so the inner
 * ``DragLayerActive`` component -- which installs ``useFrame``,
 * pointer-event listeners, and per-frame scratches -- only mounts when
 * a live websocket session is connected. */
export function DragLayer({ children }: { children?: React.ReactNode }) {
  const viewer = React.useContext(ViewerContext)!;
  if (viewer.messageSource !== "websocket") {
    return (
      <DragLayerContext.Provider value={null}>
        {children}
      </DragLayerContext.Provider>
    );
  }
  return <DragLayerActive>{children}</DragLayerActive>;
}

function DragLayerActive({ children }: { children?: React.ReactNode }) {
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
      // Per-buildDragMessage: amortize the viser-coords conversion
      // across the start + end point. Without these, each point
      // conversion would allocate a fresh Matrix4 + Quaternion via
      // ``computeT_threeworld_world`` (4 allocs/message at 20Hz).
      // ``tWorldQuat`` is a separate Quaternion scratch (vs reusing
      // ``drag.quat``) so future refactors can't introduce a sequencing
      // bug between ``computeStartWorld`` and the T_world_threeworld
      // computation, both of which use a quaternion scratch.
      tWorldThreeworld: new THREE.Matrix4(),
      tWorldQuat: new THREE.Quaternion(),
      viserStart: new THREE.Vector3(),
      viserEnd: new THREE.Vector3(),
    }),
    [],
  );

  // Recompute the live pointer-on-drag-plane intersection and stash the
  // result on the active drag. Returns false if the camera ray misses
  // the plane (e.g. ray parallel to plane); the caller should skip
  // sending an update in that case. Mutates the existing scratch
  // vectors/ray on ``activeDrag`` -- no allocation per pointermove.
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
      return [(screenProjScratch.x + 1) * 0.5, (1 - screenProjScratch.y) * 0.5];
    },
    [camera, screenProjScratch],
  );

  // Compute the live "start" world point: the click point in instance-
  // local frame, transformed by the current instance-to-world matrix.
  // Returns ``null`` if the batched pose is unavailable.
  const computeStartWorld = React.useCallback(
    (activeDrag: ActiveDragState, out: THREE.Vector3): THREE.Vector3 | null => {
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
  // *current* state of activeDrag -- start_position is recomputed from
  // ``startLocalOffset`` so it tracks the object's live pose. */
  const startWorldScratch = React.useMemo(() => new THREE.Vector3(), []);
  const buildDragMessage = React.useCallback(
    (
      activeDrag: ActiveDragState,
      phase: "start" | "update" | "end",
    ): SceneNodeDragMessage | null => {
      // Live grab point. If unavailable (node removed mid-drag,
      // batched index out of bounds, etc.):
      //   - For ``start``/``update``: skip -- emitting a degenerate
      //     ``start == end`` would mislead users who diff them.
      //   - For ``end``: still emit, falling back to ``endPointWorld``
      //     for ``start_position``. The server-side ``on_drag_end``
      //     callback MUST fire so users can release per-drag state;
      //     ``start == end`` here is the documented signal that the
      //     grab point was lost (target removed, batch shrunk, etc).
      const liveStart = computeStartWorld(activeDrag, startWorldScratch);
      const startPointWorld =
        liveStart ?? (phase === "end" ? activeDrag.endPointWorld : null);
      if (startPointWorld === null) return null;
      // Compute T_world_threeworld once and reuse for both points --
      // halves Matrix4/Quaternion allocations per drag message.
      computeT_threeworld_worldInto(
        viewer,
        frameScratches.tWorldThreeworld,
        frameScratches.tWorldQuat,
      ).invert();
      const startViser = pointToViserCoordsInto(
        startPointWorld,
        frameScratches.tWorldThreeworld,
        frameScratches.viserStart,
      );
      const endViser = pointToViserCoordsInto(
        activeDrag.endPointWorld,
        frameScratches.tWorldThreeworld,
        frameScratches.viserEnd,
      );
      const endScreenPos = opencvXyFromPointerXy(
        viewer,
        activeDrag.endPointerXy,
      );
      return {
        type: "SceneNodeDragMessage",
        phase,
        name: activeDrag.nodeName,
        instance_index: activeDrag.instanceIndex,
        start_position: [startViser.x, startViser.y, startViser.z],
        start_screen_pos: projectToOpenCvScreen(startPointWorld),
        end_position: [endViser.x, endViser.y, endViser.z],
        end_screen_pos: [endScreenPos.x, endScreenPos.y],
        button: activeDrag.input.button,
        modifier: activeDrag.input.modifier,
      };
    },
    [
      computeStartWorld,
      frameScratches,
      projectToOpenCvScreen,
      startWorldScratch,
      viewer,
    ],
  );

  // Build + send a drag message in one call, no-op if ``buildDragMessage``
  // returns null (live grab point unavailable). Wraps the duplicated
  // null-check pattern at the send sites. Returns whether a message was
  // actually sent -- callers use this to keep ``segmentActive`` honest
  // (a ``start`` that couldn't build must not be paired with a later
  // ``end``). */
  const sendDragMessage = React.useCallback(
    (
      activeDrag: ActiveDragState,
      phase: "start" | "update" | "end",
      throttle: boolean,
    ): boolean => {
      const message = buildDragMessage(activeDrag, phase);
      if (message === null) return false;
      if (throttle) sendDragsThrottled(message);
      else viewerMutable.sendMessage(message);
      return true;
    },
    [buildDragMessage, sendDragsThrottled, viewerMutable],
  );

  // Apply a mid-drag modifier change. Ends the current segment (if any),
  // switches ownership to ``nextModifier``, and starts a fresh segment
  // when the new combo is bound. Geometry is untouched, so the drag
  // continues without a visual jump -- only the addressed callback set
  // changes. Dormant (unbound) modifiers send nothing; see
  // ``planModifierTransition``. */
  const transitionDragModifier = React.useCallback(
    (activeDrag: ActiveDragState, nextModifier: KeyModifier | null) => {
      // Bindings are read live from the scene-tree store (not a
      // drag-start snapshot): a callback the server registers or removes
      // *mid-drag* takes effect at the next modifier switch. A missing
      // node (removed mid-gesture) reads as no bindings -- the switch
      // goes dormant, and the revoke path ends the drag separately.
      const liveBindings =
        viewer.useSceneTree.get(activeDrag.nodeName)?.dragBindings ?? [];
      const plan = planModifierTransition(
        activeDrag.input.modifier,
        nextModifier,
        liveBindings,
        activeDrag.input.button,
        activeDrag.segmentActive,
      );
      if (plan === null) return;
      if (plan.emitEnd) {
        // Flush queued throttled updates so the old segment's pending
        // update lands *before* its synthetic end -- preserves wire
        // ordering across the segment boundary.
        flushDragsThrottled();
        sendDragMessage(activeDrag, "end", false);
      }
      // Switch ownership before emitting the new ``start`` so the start
      // message carries the new modifier. ``button`` is unchanged.
      activeDrag.input = { ...activeDrag.input, modifier: nextModifier };
      activeDrag.segmentActive = plan.emitStart
        ? sendDragMessage(activeDrag, "start", false)
        : false;
    },
    [flushDragsThrottled, sendDragMessage, viewer],
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
      if (sendEndMessage && activeDrag.segmentActive) {
        // End the currently-active segment. A drag is partitioned into
        // one segment per (button, modifier) combo; the modifier can
        // switch mid-drag (see ``transitionDragModifier``), and each
        // switch already emitted the prior segment's ``end``. So here we
        // only emit when a segment is still active -- a release while
        // dormant (current modifier matches no binding) has nothing left
        // to end.
        sendDragMessage(activeDrag, "end", false);
      }

      activeDrag.cleanup();
      activeDragRef.current = null;
      dragArrow.visible = false;
      // Drop the camera-control lock. `cameraLock` reapplies to the
      // current instance, which handles a mid-drag camera-type swap
      // (the old instance was re-enabled at swap time; the new one's
      // `enabled` flag flips back to true here).
      if (activeDrag.releaseCameraLock !== null) {
        activeDrag.releaseCameraLock();
      }
    },
    [dragArrow, flushDragsThrottled, sendDragMessage, updateActiveDragEnd],
  );

  const api = React.useMemo<DragLayerApi>(
    () => ({
      beginDrag: ({
        nodeName,
        instanceIndex,
        targetObj,
        eventPoint,
        pointerXy,
        pointerId,
        input,
        bindings,
        promotionModifier,
      }) => {
        if (activeDragRef.current !== null) return false;
        if (!anyBindingMatches(bindings, input)) return false;

        // The gate above validates the POINTERDOWN input against the
        // POINTERDOWN bindings (the combo that made this gesture a drag
        // candidate). The opening segment is instead attributed to the
        // PROMOTION-TIME modifier, planned against the LIVE bindings --
        // both may have changed inside the pointerdown->promotion window
        // (a binding-clear cancels the candidate before promotion, but a
        // partial edit doesn't). An unbound promotion-time combo begins
        // the drag dormant; the key/pointermove listeners below pick up
        // the next switch.
        const liveBindings =
          viewer.useSceneTree.get(nodeName)?.dragBindings ?? [];
        const opening = planDragStart(input, promotionModifier, liveBindings);

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
        if (
          node !== undefined &&
          isInstancedMesh2VendoredMessage(node.message)
        ) {
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
        if (computed === null) return false;
        const startLocalOffset = startWorld
          .clone()
          .applyMatrix4(instanceWorldStart.invert());

        const handleWindowPointerMove = (event: PointerEvent) => {
          const activeDrag = activeDragRef.current;
          if (activeDrag === null) return;
          // Ignore pointers that didn't start this drag -- multi-touch
          // surfaces happily deliver other fingers' events through the
          // same window listener.
          if (event.pointerId !== activeDrag.pointerId) return;
          if (!updateActiveDragEnd(event.clientX, event.clientY)) return;

          // A modifier change carried on this move ends the current
          // segment and starts a new one under the new combo. Run it
          // *after* refreshing the end position so the synthetic end
          // reports the latest pointer location, and *before* the update
          // so the update is attributed to the new segment.
          const liveModifier = keyModifierFromEvent(event);
          if (liveModifier !== activeDrag.input.modifier) {
            transitionDragModifier(activeDrag, liveModifier);
          }

          // ``start_position`` is recomputed live inside buildDragMessage,
          // so the wire payload always reflects the click point's
          // current world position (tracking the moving object). Skip
          // while dormant -- the current modifier matches no binding.
          if (activeDrag.segmentActive) {
            sendDragMessage(activeDrag, "update", true);
          }
          // The per-frame useFrame updates the arrow tail from target
          // transforms; no manual update needed here.
        };

        // Modifier changes can also arrive with the pointer stationary
        // (the user taps a modifier key without moving the mouse). Listen
        // for key transitions during the drag and re-evaluate ownership
        // using the last-known pointer position. ``keyModifierFromEvent``
        // reads ``ctrl/meta/shift/alt`` off the KeyboardEvent, so both
        // keydown and keyup resolve the current combo.
        const handleWindowKeyChange = (event: KeyboardEvent) => {
          const activeDrag = activeDragRef.current;
          if (activeDrag === null) return;
          const liveModifier = keyModifierFromEvent(event);
          if (liveModifier !== activeDrag.input.modifier) {
            transitionDragModifier(activeDrag, liveModifier);
          }
        };

        const handleWindowPointerUp = (event: PointerEvent) => {
          // Ignore mismatched pointers -- we only end the drag when the
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
          window.removeEventListener("keydown", handleWindowKeyChange);
          window.removeEventListener("keyup", handleWindowKeyChange);
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

        // Assign the active-drag state first, *then* acquire the
        // camera lock. If lock acquisition throws between the two we
        // never reach the assignment, so no half-initialised state
        // strands the lock. Acquire-after-assign also means
        // `stopActiveDrag` is reachable for any teardown after this
        // point.
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
          endPointerXy: [pointerXy[0], pointerXy[1]],
          input: opening.input,
          // Set from the initial ``start`` send below. The opening
          // segment is dormant when the promotion-time combo is unbound
          // (``opening.emitStart`` false); even when bound, the send can
          // still fail if the live grab point is unavailable, so we
          // trust its return value rather than assuming ``true``.
          segmentActive: false,
          releaseCameraLock: null,
          cleanup,
        };
        activeDragRef.current.releaseCameraLock =
          viewer.interaction.cameraLocks.acquire("node-drag");
        dragArrow.visible = false;
        window.addEventListener("pointermove", handleWindowPointerMove);
        window.addEventListener("pointerup", handleWindowPointerUp);
        window.addEventListener("pointercancel", handleWindowPointerUp);
        window.addEventListener("blur", handleWindowBlur);
        window.addEventListener("keydown", handleWindowKeyChange);
        window.addEventListener("keyup", handleWindowKeyChange);
        activeDragRef.current.segmentActive = opening.emitStart
          ? sendDragMessage(activeDragRef.current, "start", false)
          : false;
        return true;
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
      transitionDragModifier,
      updateActiveDragEnd,
      viewer,
      viewerMutable,
    ],
  );

  // End any active drag if the DragLayer itself unmounts (viewer
  // teardown). The cleanup must run only at unmount, not whenever
  // ``stopActiveDrag``'s identity changes -- so we route through a ref
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
