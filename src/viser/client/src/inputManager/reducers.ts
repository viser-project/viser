/**
 * Pure reducers that derive view-side state from the current Gesture +
 * Hover + Registrations. These are the only paths the InputManager (and
 * its tests) need to consult to compute:
 *
 *   - ``cameraControl.enabled``  via :func:`deriveCameraControlEnabled`
 *   - canvas/cursor              via :func:`deriveCursor`
 *   - ``contextmenu`` policy     via :func:`shouldSuppressContextMenu`
 *
 * Keeping these as pure functions over the gesture/hover state means
 * tests can exhaust the cells of the design doc's behavior table
 * without instantiating the canvas. The InputManager wiring (later
 * migration steps) is just "compute these and write the result".
 */

import type {
  ContextMenuPolicy,
  Gesture,
  HoverState,
  Registrations,
} from "./types";
import type { KeyModifier } from "../dragUtils";
import { matchesModifierFilter } from "../dragUtils";

// ============================================================================
// Camera control.
// ============================================================================

/** Should ``cameraControl.enabled`` be ``true`` right now, given the
 * current gesture? Camera-compatible candidate states return
 * ``cameraMayAlsoHandle`` (typically ``true``); committed app-owned
 * gestures (``scene-rect-select``, ``node-drag``) always return
 * ``false``. ``idle`` and ``camera`` are always ``true``.
 *
 * The full ownership story includes lease tokens (modal overlays,
 * keyboard cinematics) that AND with this result; see
 * ``cameraControlOwner.ts`` (step 3 of the migration). */
export function deriveCameraControlEnabled(gesture: Gesture): boolean {
  switch (gesture.kind) {
    case "idle":
    case "camera":
      return true;
    case "scene-pointer-candidate":
    case "node-click-candidate":
      return gesture.cameraMayAlsoHandle;
    case "scene-rect-select":
    case "node-drag":
      return false;
  }
}

// ============================================================================
// Cursor.
// ============================================================================

/** Compute the cursor string (``"auto"`` / ``"pointer"`` /
 * ``"crosshair"``) from gesture + hover + registry state. Single
 * authority: external writes to ``canvas.style.cursor`` /
 * ``document.body.style.cursor`` are removed in step 9.
 *
 * Rules, in priority order:
 *
 *   1. While drawing a rect-select (a *committed* ``scene-rect-select``
 *      gesture), show ``"crosshair"``. We deliberately do NOT show
 *      crosshair before motion, since a stationary ctrl+click that
 *      happens to match a rect-select filter would otherwise flash
 *      crosshair on press.
 *   2. If a clickable node is currently hovered, ``"pointer"``.
 *   3. If a click filter is registered AND the currently-held
 *      modifier matches that filter's modifier, ``"pointer"`` --
 *      communicates that a press right now would dispatch a click.
 *      For modifier-filtered ``on_click`` callbacks the cursor only
 *      flips to pointer while the user is actually holding the
 *      modifier. Rect-select filters do NOT drive the cursor (a
 *      rectangle drag is not a click affordance).
 *   4. Otherwise ``"auto"``.
 */
export function deriveCursor(
  gesture: Gesture,
  hover: HoverState,
  registrations: Registrations,
  heldModifier: KeyModifier | null,
): "auto" | "pointer" | "crosshair" {
  if (gesture.kind === "scene-rect-select") {
    // Crosshair only after motion has actually started. Until then,
    // ``startXy === endXy`` and we keep whatever cursor the registry
    // implies.
    if (
      gesture.startXy[0] !== gesture.endXy[0] ||
      gesture.startXy[1] !== gesture.endXy[1]
    ) {
      return "crosshair";
    }
  }
  if (hover.clickableNode !== null) return "pointer";
  // Only ``click`` filters drive cursor. ``rect-select`` is a drag
  // affordance, not a click affordance, so it leaves the cursor
  // alone. A click filter with ``modifier=null`` only matches when no
  // modifiers are held; ``modifier="shift"`` only when shift is held;
  // etc. ``matchesModifierFilter`` is the same function the
  // classifier uses at pointerdown.
  const clickBindings = registrations.scenePointerFilters.get("click");
  if (clickBindings !== undefined) {
    for (const b of clickBindings) {
      if (matchesModifierFilter(heldModifier, b.modifier)) return "pointer";
    }
  }
  return "auto";
}

// ============================================================================
// Context menu.
// ============================================================================

/** True when an active or recent pointerdown classification said the
 * browser context menu should be suppressed. ``policy === null`` means
 * no recent pointerdown owned the menu, so the browser default
 * (preserve) wins.
 *
 * The InputManager keeps the policy short-lived: it is set at
 * pointerdown classification, may be updated on finalisation, and
 * cleared after the ``contextmenu`` event fires or the next task
 * (whichever comes first). This handles the macOS-style "contextmenu
 * fires before pointerup" case as well as plain right-click that fires
 * after pointerup. */
export function shouldSuppressContextMenu(
  policy: ContextMenuPolicy | null,
): boolean {
  return policy?.suppress === true;
}
