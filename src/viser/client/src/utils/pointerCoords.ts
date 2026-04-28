import * as THREE from "three";
import { ViewerContextContents } from "../ViewerContext";

/** Turn a canvas-local pointer position into Three.js NDC coordinates.
 *
 * Normalizes click coordinates to be between -1 and 1, with (0, 0) being
 * the center of the screen.
 *
 * Returns null if the pointer is outside the canvas.
 */
export function ndcFromPointerXy(
  viewer: ViewerContextContents,
  xy: [number, number],
): THREE.Vector2 | null {
  const mouseVector = new THREE.Vector2();
  mouseVector.x =
    2 * ((xy[0] + 0.5) / viewer.mutable.current.canvas!.clientWidth) - 1;
  mouseVector.y =
    1 - 2 * ((xy[1] + 0.5) / viewer.mutable.current.canvas!.clientHeight);
  return mouseVector.x < 1 &&
    mouseVector.x > -1 &&
    mouseVector.y < 1 &&
    mouseVector.y > -1
    ? mouseVector
    : null;
}

// Module-scoped scratch reused by ``ndcFromPointerXyClamped`` — the
// drag path calls it on every pointermove, and the only consumer is
// ``Raycaster.setFromCamera``, which reads ``.x``/``.y`` and copies
// onward, so returning a shared instance is safe.
const ndcClampedScratch = /*#__PURE__*/ new THREE.Vector2();

/** Like ``ndcFromPointerXy`` but never returns null: when the pointer is
 * outside the canvas the NDC values are clamped to ±2 instead. Used by
 * drag handling so the gesture keeps tracking when the user pulls the
 * cursor past the canvas edge. The clamp keeps ray/plane intersections
 * finite (without it a near-grazing camera angle could send the
 * intersection to ~infinity). */
export function ndcFromPointerXyClamped(
  viewer: ViewerContextContents,
  xy: [number, number],
): THREE.Vector2 {
  const x =
    2 * ((xy[0] + 0.5) / viewer.mutable.current.canvas!.clientWidth) - 1;
  const y =
    1 - 2 * ((xy[1] + 0.5) / viewer.mutable.current.canvas!.clientHeight);
  return ndcClampedScratch.set(
    Math.max(-2, Math.min(2, x)),
    Math.max(-2, Math.min(2, y)),
  );
}

/** Turn a canvas-local pointer position into normalized OpenCV image
 * coordinates.
 *
 * (0, 0) is the upper-left corner, (1, 1) is the bottom-right corner,
 * (0.5, 0.5) is the center of the screen.
 */
export function opencvXyFromPointerXy(
  viewer: ViewerContextContents,
  xy: [number, number],
): THREE.Vector2 {
  // Returns a fresh Vector2 — callers like ``App.tsx`` (rect-select)
  // call this twice in a row and use both results, so a shared scratch
  // would alias. The 1 alloc/call is acceptable on the drag path.
  const mouseVector = new THREE.Vector2();
  mouseVector.x = (xy[0] + 0.5) / viewer.mutable.current.canvas!.clientWidth;
  mouseVector.y = (xy[1] + 0.5) / viewer.mutable.current.canvas!.clientHeight;
  return mouseVector;
}
