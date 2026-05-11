/**
 * Sole writer for ``canvas.style.cursor``.
 *
 * Step 9 of the migration. Three callers feed inputs:
 *
 *   - ``SceneTree`` per-node ``onPointerOver`` / ``onPointerOut``
 *     report hover-count deltas via :func:`adjustHoveredClickable`.
 *   - ``MessageHandler.ScenePointerEnableMessage`` reports the
 *     scene-pointer filter set via :func:`setFilters`.
 *   - ``InputManager.setGesture`` reports gesture transitions via
 *     :func:`setGesture`.
 *
 * All three write through this controller; the controller runs the
 * pure :func:`deriveCursor` reducer and writes the result to
 * ``canvas.style.cursor``. ``document.body.style.cursor`` is no
 * longer touched anywhere in the client.
 */

import {
  registrationsFromScenePointerFilters,
  type Gesture,
  type ScenePointerEventType,
} from "./types";
import type { KeyModifier } from "../dragUtils";
import { deriveCursor } from "./reducers";

const IDLE: Gesture = { kind: "idle" };

export class CursorController {
  private hoveredClickable = 0;
  private filters: Map<ScenePointerEventType, (KeyModifier | null)[]> =
    new Map();
  private gesture: Gesture = IDLE;
  private heldModifier: KeyModifier | null = null;
  private getCanvas: () => HTMLCanvasElement | null = () => null;

  /** Override the canvas getter. Called once at viewer mount. */
  setCanvasGetter(get: () => HTMLCanvasElement | null): void {
    this.getCanvas = get;
    // Force re-apply: a fresh canvas may carry a different default
    // cursor from the browser, so the cached ``lastApplied`` is stale.
    this.lastApplied = null;
    this.apply();
  }

  /** Track per-node hover. Pass ``+1`` on ``onPointerOver`` of a
   * clickable node, ``-1`` on ``onPointerOut`` (and the matching
   * ``-1`` on the cleanup effect for the still-hovered case). The
   * controller clamps below zero internally so an extra ``-1`` from
   * a React StrictMode double-invoke or a cleanup race doesn't break
   * the cursor.
   *
   * Clamping is *load-bearing* (StrictMode legitimately fires extra
   * cleanup calls in dev), but it can also hide real delta-imbalance
   * bugs: SceneTree has four ``-1`` sites (frame loop unhover,
   * visibility-loss, interactivity-toggle, unmount), and a node that
   * goes through several of those for a single ``+1`` would silently
   * over-decrement. We log a ``console.warn`` in dev when the clamp
   * would have driven the count negative, so the bug is visible
   * without breaking the cursor. */
  adjustHoveredClickable(delta: 1 | -1): void {
    const next = this.hoveredClickable + delta;
    if (next < 0 && process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[CursorController] adjustHoveredClickable underflow: " +
          `count=${this.hoveredClickable} delta=${delta} -- clamping to 0. ` +
          "Likely cause: a SceneTree unhover path fired a ``-1`` " +
          "without a matching prior ``+1``. Investigate the four " +
          "decrement sites in SceneTree.tsx.",
      );
    }
    this.hoveredClickable = Math.max(0, next);
    this.apply();
  }

  /** Replace the registered scene-pointer filter set. Mirrored from
   * ``MessageHandler.ScenePointerEnableMessage``. */
  setFilters(
    filters: Map<ScenePointerEventType, (KeyModifier | null)[]>,
  ): void {
    this.filters = filters;
    this.apply();
  }

  /** Track the active gesture. Called from ``InputManager.setGesture``
   * (alongside ``cameraControlOwner.setGesture``). */
  setGesture(gesture: Gesture): void {
    this.gesture = gesture;
    this.apply();
  }

  /** Track the currently-held modifier (or ``null`` for none). Wired
   * from a window-level ``keydown`` / ``keyup`` listener in App.tsx;
   * the cursor reducer uses this to gate pointer cursor on
   * modifier-filtered click callbacks (e.g. cmd/ctrl-click only
   * paints pointer cursor while cmd/ctrl is held). */
  setHeldModifier(modifier: KeyModifier | null): void {
    if (modifier === this.heldModifier) return;
    this.heldModifier = modifier;
    this.apply();
  }

  /** Compute the cursor for the current state. Public for tests. */
  derive(): "auto" | "pointer" | "crosshair" {
    return deriveCursor(
      this.gesture,
      this.hoverState(),
      registrationsFromScenePointerFilters(this.filters),
      this.heldModifier,
    );
  }

  private hoverState() {
    return {
      // Identity of the hovered node doesn't matter to the reducer
      // (it just checks ``clickableNode !== null``); we only track
      // a count.
      clickableNode:
        this.hoveredClickable > 0
          ? { nodeName: "<aggregate>", instanceIndex: null }
          : null,
    };
  }


  private lastApplied: "auto" | "pointer" | "crosshair" | null = null;

  private apply(): void {
    const canvas = this.getCanvas();
    if (canvas === null) return;
    const next = this.derive();
    if (next === this.lastApplied) return;
    this.lastApplied = next;
    canvas.style.cursor = next;
  }
}
