/**
 * Runtime owner of canvas scene-pointer input.
 *
 * One ``InputManager`` lives on ``viewerMutable.inputManager`` for the
 * lifetime of the viewer. The React handlers in ``App.tsx`` thin-
 * delegate to it; the manager:
 *
 *   - Holds the typed :data:`Gesture` (single source of truth for
 *     "what is the canvas doing right now").
 *   - Calls :func:`CameraControlOwner.setGesture` on every transition.
 *   - Drives the rect-select rectangle overlay on ``canvas2d``.
 *   - Dispatches scene click and rect-select wire messages via the
 *     callback the ``ViewerCanvas`` injects at construction.
 *
 * Step 5 of the migration plan; the per-node click and drag paths
 * stay in ``SceneTree.tsx`` for now (step 8 moves them in).
 */

import {
  classifyPointerDown,
  applyPointerMove,
  cancelGesture,
  finalizePointerUp,
} from "./classify";
import {
  registrationsFromScenePointerFilters,
  type Gesture,
  type ScenePointerEventType,
} from "./types";
import type { CameraControlOwner } from "./cameraControlOwner";
import type { CursorController } from "./cursorController";
import {
  keyModifierFromEvent,
  motionExceedsThreshold,
  pointerButtonFromNative,
  type KeyModifier,
} from "../dragUtils";

/** Outcome of a pointerup that the canvas runtime should dispatch. */
export type DispatchAction =
  | { kind: "scene-click"; xy: [number, number]; modifier: KeyModifier | null }
  | {
      kind: "scene-rect-select";
      startXy: [number, number];
      endXy: [number, number];
      modifier: KeyModifier | null;
    };

/** Side-channel inputs the InputManager doesn't own: rectangle
 * drawing onto ``canvas2d``, message dispatch, and ndc-validity
 * checking. ``ViewerCanvas`` provides these at construction. */
export type InputManagerHooks = {
  /** Called when the rectangle-select overlay should be repainted.
   * ``rect`` is in canvas-local CSS pixels (origin top-left); ``null``
   * clears the overlay. */
  drawRectSelectOverlay(
    rect: { startXy: [number, number]; endXy: [number, number] } | null,
  ): void;
  /** Send the corresponding wire message. */
  dispatch(action: DispatchAction): void;
  /** Returns ``true`` if the pixel is inside the rendered viewport
   * (ndc derivation succeeds). Used to early-out at pointerdown for
   * gestures that started outside the projected scene area. */
  isInsideViewport(xy: [number, number]): boolean;
};

const IDLE: Gesture = { kind: "idle" };

export class InputManager {
  private gesture: Gesture = IDLE;
  private filters: Map<
    ScenePointerEventType,
    (KeyModifier | null)[]
  > = new Map();

  constructor(
    private readonly cameraControlOwner: CameraControlOwner,
    private readonly cursorController: CursorController,
    private readonly hooks: InputManagerHooks,
  ) {}

  /** Replace the registered scene-pointer filter set. Called from
   * ``MessageHandler`` when ``ScenePointerEnableMessage`` is
   * received. */
  setScenePointerFilters(
    filters: Map<ScenePointerEventType, (KeyModifier | null)[]>,
  ): void {
    this.filters = filters;
    this.cursorController.setFilters(filters);
  }

  /** Current gesture (read-only). Exposed for the dev-mode test
   * shim and the cursor reducer. */
  getGesture(): Gesture {
    return this.gesture;
  }

  /** Internal: write the new gesture and notify camera-control
   * ownership + cursor. Single application path so derived state is
   * always in sync with the current gesture. */
  private setGesture(gesture: Gesture): void {
    this.gesture = gesture;
    this.cameraControlOwner.setGesture(gesture);
    this.cursorController.setGesture(gesture);
  }

  /** Pointerdown on the canvas. Returns the chosen gesture so the
   * caller can decide whether to ``setPointerCapture`` on the canvas
   * element (the manager doesn't touch DOM directly). */
  onCanvasPointerDown(args: {
    pointerId: number;
    button: number;
    modifier: KeyModifier | null;
    xy: [number, number];
  }): Gesture {
    if (this.gesture.kind !== "idle") return this.gesture;
    if (this.filters.size === 0) return this.gesture;
    if (!this.hooks.isInsideViewport(args.xy)) return this.gesture;
    const buttonName = pointerButtonFromNative(args.button);
    if (buttonName === null) return this.gesture;
    const next = classifyPointerDown({
      input: { button: buttonName, modifier: args.modifier },
      pointerId: args.pointerId,
      startXy: args.xy,
      hit: null, // canvas-only: per-node hit testing stays in SceneTree.
      registrations: registrationsFromScenePointerFilters(this.filters),
    });
    if (next.kind === "camera" || next.kind === "idle") {
      // No scene-pointer match -- let camera-controls handle it.
      return next;
    }
    if (
      next.kind === "node-click-candidate" ||
      next.kind === "node-drag"
    ) {
      // Should be unreachable on the canvas-only path (hit=null), but
      // bail safely in case of future callers.
      return this.gesture;
    }
    this.setGesture(next);
    return next;
  }

  /** Pointermove on the canvas. */
  onCanvasPointerMove(args: {
    pointerId: number;
    xy: [number, number];
  }): void {
    const g = this.gesture;
    if (g.kind === "idle" || g.kind === "camera") return;
    // Multi-touch / stray-id defense: ignore pointermoves that don't
    // own the active gesture.
    if ("pointerId" in g && g.pointerId !== args.pointerId) return;
    if (
      g.kind !== "scene-pointer-candidate" &&
      g.kind !== "scene-rect-select"
    )
      return;
    const next = applyPointerMove(
      g,
      args.xy,
      motionExceedsThreshold(g.startXy, args.xy),
    );
    this.setGesture(next);
    // Repaint the rectangle overlay if the gesture is rect-select
    // (committed) and motion has actually started. Candidates never
    // draw the overlay -- they might still resolve to a click.
    if (
      next.kind === "scene-rect-select" &&
      motionExceedsThreshold(next.startXy, next.endXy)
    ) {
      this.hooks.drawRectSelectOverlay({
        startXy: next.startXy,
        endXy: next.endXy,
      });
    }
  }

  /** Pointerup on the canvas. */
  onCanvasPointerUp(args: { pointerId: number }): void {
    const g = this.gesture;
    if (g.kind === "idle" || g.kind === "camera") {
      this.setGesture(IDLE);
      return;
    }
    if ("pointerId" in g && g.pointerId !== args.pointerId) return;

    const outcome = finalizePointerUp(g);
    // Always clear the overlay; only rect-select draws into it but
    // a stale paint from a prior gesture would otherwise linger.
    this.hooks.drawRectSelectOverlay(null);

    if (outcome.dispatch.kind === "scene-click") {
      // ``g`` is one of the candidate / committed kinds at this
      // point; pull start position and modifier from it.
      const xy =
        g.kind === "scene-pointer-candidate" ||
        g.kind === "scene-rect-select"
          ? g.endXy
          : g.startXy;
      this.hooks.dispatch({ kind: "scene-click", xy, modifier: g.input.modifier });
    } else if (
      outcome.dispatch.kind === "scene-rect-select" &&
      g.kind === "scene-rect-select"
    ) {
      this.hooks.dispatch({
        kind: "scene-rect-select",
        startXy: g.startXy,
        endXy: g.endXy,
        modifier: g.input.modifier,
      });
    }
    this.setGesture(outcome.next);
  }

  /** Cancellation path. ``pointercancel`` / ``lostpointercapture`` /
   * window blur / unmount all route here. */
  onCanvasPointerCancel(): void {
    if (this.gesture.kind === "idle") return;
    this.hooks.drawRectSelectOverlay(null);
    this.setGesture(cancelGesture());
  }
}

export { keyModifierFromEvent };
