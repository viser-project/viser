/**
 * Pure pointerdown classifier — the single decision point that maps a
 * frozen ``(input, hit, registrations)`` tuple to the initial Gesture
 * the InputManager will own. No DOM, no React, no Three.js mutations.
 *
 * The precedence below is the contract; each rule has a corresponding
 * row in the design doc's behavior table. Tests in
 * ``classify.test.ts`` (driven via Playwright through the dev-mode
 * ``window.__viserInputManager__`` shim) exercise every cell.
 */

import {
  matchesDragBinding,
  matchesModifierFilter,
  type DragBinding,
} from "../dragUtils";
import type {
  ClickBinding,
  Gesture,
  NodeHit,
  PointerInput,
  Registrations,
  ScenePointerEventType,
} from "./types";

/** ``true`` when ``input`` matches at least one of ``bindings``.
 * Mirrors :func:`anyBindingMatches` for click bindings (which share
 * the ``button + modifier`` shape with drag bindings). */
export function anyClickBindingMatches(
  bindings: ClickBinding[],
  input: PointerInput,
): boolean {
  // ``ClickBinding`` and ``DragBinding`` are structurally identical;
  // reuse the drag binding matcher so future filter-shape additions
  // (e.g. double-click) only touch one matcher.
  return bindings.some((b) =>
    matchesDragBinding(b as DragBinding, input),
  );
}

/** ``true`` when the node has at least one click binding that matches
 * the input. ``clickBindings: null`` is the legacy sentinel: for nodes
 * whose server hasn't been upgraded to send exact bindings yet, fall
 * back to "any unmodified left-click counts as a click". This matches
 * the historical client behavior (``clickable: bool`` only) and
 * preserves backwards compatibility until ``SetSceneNodeClickBindings``
 * lands. */
export function nodeMatchesClick(
  clickBindings: ClickBinding[] | null,
  input: PointerInput,
): boolean {
  if (clickBindings === null) {
    return true;
  }
  return anyClickBindingMatches(clickBindings, input);
}

/** Compute the set of scene-pointer event types whose registered
 * filters match the input at pointerdown. The matcher is button +
 * exact-modifier; an event_type with no registered bindings is absent
 * from the result. */
export function eligibleScenePointerEventTypes(
  filters: Map<ScenePointerEventType, ClickBinding[]>,
  input: PointerInput,
): Set<ScenePointerEventType> {
  const out = new Set<ScenePointerEventType>();
  for (const [eventType, bindings] of filters) {
    if (anyClickBindingMatches(bindings, input)) {
      out.add(eventType);
    }
  }
  return out;
}

export type ClassifyArgs = {
  input: PointerInput;
  pointerId: number;
  startXy: [number, number];
  hit: NodeHit | null;
  registrations: Registrations;
};

/**
 * Map a pointerdown to the initial Gesture. Pure function; the
 * InputManager threads the result back into its state ref.
 *
 * Precedence (each rule's outcome is final):
 *   1. Hit a node + input matches a node click binding -> ``node-click-candidate``.
 *      The candidate carries any matching drag bindings on
 *      ``dragBindingsToCommit``; motion past threshold transitions
 *      to ``node-drag``, stationary release dispatches click.
 *   2. Hit a node + input matches a node drag binding (no click match)
 *      -> ``node-drag`` (committed at pointerdown).
 *   3. Input matches any scene-pointer filter -> ``scene-rect-select``
 *      if ``rect-select`` is among the matches (committed, camera off);
 *      otherwise ``scene-pointer-candidate`` (camera continues).
 *   4. Otherwise -> ``camera``.
 *
 * Rule 1's tap-vs-drag handling: a node with both bindings for the
 * same input no longer commits to drag at pointerdown. The gesture
 * starts as ``node-click-candidate`` and transitions to ``node-drag``
 * only when motion crosses :data:`MOTION_THRESHOLD_PX`. A stationary
 * release dispatches click as before. This is a deliberate change
 * from the historical behavior (drag-wins-always at pointerdown):
 * users with overlapping bindings expected stationary taps to fire
 * click, not a zero-motion drag.
 *
 * Modifier state is captured at pointerdown and frozen for the
 * gesture's lifetime; mid-gesture key changes don't perturb
 * classification. This generalises the existing drag-callback policy
 * to clicks and rect-select.
 *
 * ``cameraMayAlsoHandle`` is set on candidate states only and reflects
 * the design decision that click-only candidates leave camera-controls
 * receiving the original pointerdown -- so an orbit can start
 * naturally if motion crosses the threshold. Committed
 * (``scene-rect-select``, ``node-drag``) gestures take the canvas from
 * camera-controls immediately.
 */
export function classifyPointerDown(args: ClassifyArgs): Gesture {
  const { input, pointerId, startXy, hit, registrations } = args;

  if (hit !== null) {
    const spec = registrations.nodes.get(hit.nodeName);
    if (spec !== undefined) {
      const matchingDragBindings = spec.dragBindings.filter((b) =>
        matchesDragBinding(b, input),
      );
      const clickMatches = nodeMatchesClick(spec.clickBindings, input);
      // Rule 1: clickable node -> tap-vs-drag candidate. Motion past
      // threshold transitions to ``node-drag`` and the InputManager
      // dispatches drag_start retroactively; stationary release
      // dispatches click.
      if (clickMatches) {
        return {
          kind: "node-click-candidate",
          pointerId,
          input,
          nodeName: hit.nodeName,
          instanceIndex: hit.instanceIndex,
          startXy,
          moved: false,
          // Click candidates leave camera-controls observing the
          // original pointerdown, so motion past threshold becomes
          // a natural orbit when no drag bindings are eligible.
          // ``dragBindingsToCommit`` non-null pre-empts that and
          // commits to a node drag instead.
          cameraMayAlsoHandle: matchingDragBindings.length === 0,
          dragBindingsToCommit:
            matchingDragBindings.length > 0 ? matchingDragBindings : null,
        };
      }
      // Rule 2: drag-only node (no matching click binding) ->
      // committed at pointerdown.
      if (matchingDragBindings.length > 0) {
        return {
          kind: "node-drag",
          pointerId,
          input,
          nodeName: hit.nodeName,
          instanceIndex: hit.instanceIndex,
          startXy,
          dragState: null,
          cameraControlAtStart: null,
        };
      }
    }
  }

  // Rule 3: canvas-level scene pointer filter.
  const eligible = eligibleScenePointerEventTypes(
    registrations.scenePointerFilters,
    input,
  );
  if (eligible.size > 0) {
    if (eligible.has("rect-select")) {
      // Committed: camera disabled immediately. ``eligible`` may also
      // include ``"click"`` -- the transition table dispatches a click
      // on stationary release in that case.
      return {
        kind: "scene-rect-select",
        pointerId,
        input,
        eligible,
        startXy,
        endXy: startXy,
      };
    }
    return {
      kind: "scene-pointer-candidate",
      pointerId,
      input,
      eligible,
      startXy,
      endXy: startXy,
      moved: false,
      cameraMayAlsoHandle: true,
    };
  }

  // Rule 4: pure camera.
  return { kind: "camera", pointerId, input, startXy };
}

// ============================================================================
// Transitions on pointermove / pointerup.
// ============================================================================

/** Apply a pointermove to the active gesture and return the next
 * gesture. Pure: takes the displacement, returns the new gesture
 * struct. The caller is responsible for testing
 * :func:`motionExceedsThreshold` against the start/end pair before
 * invoking the "moved" branch.
 *
 * Move semantics by gesture kind:
 *
 *   - ``idle`` / ``camera``: pointermove is irrelevant to InputManager
 *     state; camera-controls observes its own native stream. Returned
 *     gesture is unchanged.
 *   - ``scene-pointer-candidate``: track ``endXy``; on first
 *     past-threshold move, set ``moved=true``. The reducer downstream
 *     keeps camera-controls enabled (``cameraMayAlsoHandle=true``), so
 *     the gesture *stays* as a candidate but no click will be dispatched
 *     on release once moved.
 *   - ``scene-rect-select``: track ``endXy``; the rectangle-overlay
 *     drawing path consumes the updated endXy.
 *   - ``node-click-candidate``: same idea -- once moved, no click
 *     fires on release; camera-controls is the motion owner.
 *   - ``node-drag``: motion is owned by ``DragLayer``; the gesture
 *     struct is unchanged here (the live drag state is mutated in
 *     place by ``DragLayer``'s window-level pointermove listener).
 */
export function applyPointerMove(
  gesture: Gesture,
  endXy: [number, number],
  movedPastThreshold: boolean,
): Gesture {
  switch (gesture.kind) {
    case "idle":
    case "camera":
    case "node-drag":
      return gesture;
    case "scene-pointer-candidate":
      return {
        ...gesture,
        endXy,
        moved: gesture.moved || movedPastThreshold,
      };
    case "scene-rect-select":
      return { ...gesture, endXy };
    case "node-click-candidate":
      // Tap-vs-drag transition: when a click candidate has matching
      // drag bindings on the same input AND motion crosses
      // threshold, commit to ``node-drag``. The InputManager
      // dispatches ``drag_start`` retroactively at this transition;
      // ``drag_end`` fires on pointerup as normal. ``dragState`` and
      // ``cameraControlAtStart`` are populated by ``DragLayer`` when
      // the runtime kicks the drag off.
      if (
        movedPastThreshold &&
        gesture.dragBindingsToCommit !== null &&
        gesture.dragBindingsToCommit.length > 0
      ) {
        return {
          kind: "node-drag",
          pointerId: gesture.pointerId,
          input: gesture.input,
          nodeName: gesture.nodeName,
          instanceIndex: gesture.instanceIndex,
          startXy: gesture.startXy,
          dragState: null,
          cameraControlAtStart: null,
        };
      }
      return {
        ...gesture,
        moved: gesture.moved || movedPastThreshold,
      };
  }
}

/** Outcome of finalising a gesture on pointerup.
 *
 *   - ``dispatch``: tells the InputManager which (if any) wire-level
 *     callback should fire (scene click, scene rect-select, node click,
 *     drag end). Drag-end is a special case: ``DragLayer`` already
 *     dispatches ``drag_end`` from its window listener, so the
 *     coordinator's outcome is just ``"none"`` for ``node-drag``.
 *   - ``next``: the gesture state to settle on (always ``idle`` here,
 *     since pointerup ends every gesture).
 */
export type FinalizeOutcome = {
  dispatch:
    | { kind: "none" }
    | { kind: "scene-click" }
    | { kind: "scene-rect-select" }
    | { kind: "node-click" };
  next: Gesture;
};

/** Compute what to dispatch (if anything) when a pointerup closes the
 * active gesture.
 *
 * Returns ``"none"`` rather than throwing for already-idle states so
 * the ``pointerup`` listener can be unconditional. */
export function finalizePointerUp(gesture: Gesture): FinalizeOutcome {
  const idle: Gesture = { kind: "idle" };
  switch (gesture.kind) {
    case "idle":
    case "camera":
    case "node-drag":
      return { dispatch: { kind: "none" }, next: idle };
    case "scene-pointer-candidate":
      // Stationary press matching ``"click"`` -> dispatch scene click.
      // ``cameraMayAlsoHandle=true`` ensures the orbit/pan branch is
      // owned by camera-controls; if the user actually moved, no click.
      if (!gesture.moved && gesture.eligible.has("click")) {
        return { dispatch: { kind: "scene-click" }, next: idle };
      }
      return { dispatch: { kind: "none" }, next: idle };
    case "scene-rect-select": {
      // Decide click vs rect by motion (caller will have already
      // updated ``endXy`` via :func:`applyPointerMove`).
      const moved =
        gesture.startXy[0] !== gesture.endXy[0] ||
        gesture.startXy[1] !== gesture.endXy[1];
      if (moved) {
        return { dispatch: { kind: "scene-rect-select" }, next: idle };
      }
      if (gesture.eligible.has("click")) {
        return { dispatch: { kind: "scene-click" }, next: idle };
      }
      return { dispatch: { kind: "none" }, next: idle };
    }
    case "node-click-candidate":
      if (!gesture.moved) {
        return { dispatch: { kind: "node-click" }, next: idle };
      }
      return { dispatch: { kind: "none" }, next: idle };
  }
}

/** Cancel-path outcome. ``pointercancel`` /
 * ``lostpointercapture`` / ``blur`` / unmount all route here. The
 * design doc commits each gesture kind to a documented cancellation
 * policy:
 *
 *   - Candidate states (``scene-pointer-candidate``,
 *     ``node-click-candidate``): no callback was promised on pointerup
 *     either; cancel sends nothing.
 *   - ``scene-rect-select``: nothing is sent until the user releases,
 *     so cancellation is a quiet drop. Tests confirm the rectangle
 *     overlay is cleared.
 *   - ``node-drag``: ``DragLayer`` already promises a ``drag_end``
 *     phase on every window blur / cancel. The coordinator delegates
 *     finalisation to ``DragLayer`` and only marks itself idle here.
 */
export function cancelGesture(): Gesture {
  return { kind: "idle" };
}

/** Match the modifier of an input against a held filter. Re-exported
 * from ``dragUtils`` for callers that only depend on this module. */
export { matchesModifierFilter };
