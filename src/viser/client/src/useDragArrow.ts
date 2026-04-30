/** Drag-arrow visualization for ``DragLayer``.
 *
 * Owns the ``THREE.ArrowHelper`` lifecycle (allocate, mount, dispose)
 * and the per-frame update that points the arrow from the live grab
 * point on the dragged object to the current pointer. Returns the
 * arrow so the caller can toggle ``visible`` directly at drag-start
 * (initial hide before the first frame computes the tail) and at
 * drag-end (immediate hide on pointerup). */

import React from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { ActiveDragState } from "./dragUtils";

export function useDragArrow(
  activeDragRef: React.RefObject<ActiveDragState | null>,
  computeStartWorld: (
    activeDrag: ActiveDragState,
    out: THREE.Vector3,
  ) => THREE.Vector3 | null,
): THREE.ArrowHelper {
  const { scene: threeScene } = useThree();

  const dragArrow = React.useMemo(() => {
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(),
      0,
      0xff8c42,
      0.18,
      0.09,
    );
    arrow.visible = false;
    arrow.line.raycast = () => null;
    arrow.cone.raycast = () => null;
    return arrow;
  }, []);

  React.useEffect(() => {
    threeScene.add(dragArrow);
    return () => {
      threeScene.remove(dragArrow);
      dragArrow.line.geometry.dispose();
      (dragArrow.line.material as THREE.Material).dispose();
      dragArrow.cone.geometry.dispose();
      (dragArrow.cone.material as THREE.Material).dispose();
    };
  }, [threeScene, dragArrow]);

  const tailScratch = React.useMemo(() => new THREE.Vector3(), []);
  const directionScratch = React.useMemo(() => new THREE.Vector3(), []);

  // Per-frame arrow update. Runs at priority 0 (after the per-node
  // useFrame(-1000) that applies pose updates to objRef.current), so
  // matrixWorld is current when we read it. Allocates nothing.
  useFrame(() => {
    const activeDrag = activeDragRef.current;
    if (activeDrag === null) return;
    const tailWorld = computeStartWorld(activeDrag, tailScratch);
    // Hide the arrow if the live grab point is unavailable (node
    // removed, batched index out of bounds, etc.) — otherwise the
    // arrow would freeze at its last known position until pointerup.
    if (tailWorld === null) {
      dragArrow.visible = false;
      return;
    }
    directionScratch.copy(activeDrag.endPointWorld).sub(tailWorld);
    const length = directionScratch.length();
    if (length <= 1e-6) {
      dragArrow.visible = false;
      return;
    }
    dragArrow.position.copy(tailWorld);
    dragArrow.setDirection(directionScratch.normalize());
    dragArrow.setLength(
      length,
      Math.min(0.18, length * 0.2),
      Math.min(0.09, length * 0.1),
    );
    dragArrow.visible = true;
  });

  return dragArrow;
}
