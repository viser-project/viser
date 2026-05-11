/**
 * Types for the InputManager — a single pointer-input coordinator that
 * owns gesture classification, lifecycle, and derived camera-control /
 * cursor / context-menu state for the viewer canvas.
 *
 * Background and rationale: see ``input_manager_design_merged.md`` at
 * the repo root. This file is the type vocabulary the rest of the
 * coordinator builds on; the pure classifier lives in ``classify.ts``,
 * the derivation reducers in ``reducers.ts``, and the live event-loop
 * wiring in ``InputManager.tsx`` (added in later migration steps).
 *
 * No runtime dependencies on React or Three.js; importable from tests.
 */

import type * as THREE from "three";
import type { CameraControls } from "@react-three/drei";
import type {
  ActiveDragState,
  DragBinding,
  DragInput,
  KeyModifier,
  PointerButton,
} from "../dragUtils";

// ============================================================================
// Pointer input vocabulary.
// ============================================================================

/** Frozen pointerdown input. Mirrors :data:`DragInput` but generalised
 * to *any* pointer gesture (clicks, rect-select, camera). Modifier state
 * is captured at pointerdown and held for the gesture's lifetime --
 * matches the existing drag-callback policy and avoids "release-Shift-
 * before-mouse-up" surprises. */
export type PointerInput = DragInput;

/** A registered click filter: button + exact-match modifier set. The
 * client-side analogue of :class:`viser.DragBinding` for the click
 * channel. ``modifier=null`` means the binding fires when no modifiers
 * are held; non-null means an exact-match against the canonical modifier
 * string built by :func:`keyModifierFromEvent`. */
export type ClickBinding = {
  button: PointerButton;
  modifier: KeyModifier | null;
};

/** Re-export for callers who only need the binding shape. */
export type { DragBinding, KeyModifier, PointerButton, DragInput };

/** Set of canvas-level scene-pointer event types the server has
 * registered callbacks for. Each value is the list of click-bindings
 * accepted; an entry whose list is empty / missing is disabled. */
export type ScenePointerEventType = "click" | "rect-select";

// ============================================================================
// Hit-testing adapter type.
// ============================================================================

/** Raycast hit on an interactive scene node. Consumed by
 * :func:`classifyPointerDown` so the classifier can decide between
 * node-drag, node-click, and scene-level gestures based on what the
 * pointerdown landed on.
 *
 * Today this type is a contract only -- the actual hit-test is still
 * performed by ``SceneTree.tsx``'s R3F per-node handlers, which then
 * route into ``DragLayer.beginDrag``. A future migration step (see
 * ``INPUT_MANAGER_HANDOFF.md``) will move hit-testing into a central
 * raycaster that returns a ``NodeHit`` directly; until then the
 * fields here document what that adapter must produce.
 *
 * ``instanceIndex`` is non-null for batched scene nodes (BatchedMesh,
 * BatchedGlb, BatchedAxes) and ``null`` otherwise. The mapping from
 * raw three.js ``InstancedMesh.instanceId`` to the logical
 * scene-node instance is non-trivial (BatchedAxes writes 3
 * InstancedMesh entries per logical axis); see
 * ``computeClickInstanceIndexFromInstanceId`` in ``SceneTree.tsx``
 * for the current implementation. ``targetObj`` is the scene-node
 * ``<group>`` whose pose drives drag math. ``pointWorld`` is the
 * raycast hit point in Three.js world coords (for batched nodes,
 * already lifted out of InstancedMesh2-local space). */
export type NodeHit = {
  nodeName: string;
  instanceIndex: number | null;
  targetObj: THREE.Object3D;
  pointWorld: THREE.Vector3;
  ray: THREE.Ray;
  distance: number;
};

// ============================================================================
// Per-node interaction registry.
// ============================================================================

/** What a scene node listens for. ``clickBindings: null`` is the
 * "legacy" sentinel for nodes whose server hasn't been upgraded to send
 * exact click filters yet (see Migration §6 of the design doc): in that
 * case the client falls back to "any pointerup with no motion fires a
 * click" -- matching today's behavior -- but exact context-menu
 * suppression is not available. Once ``SetSceneNodeClickBindingsMessage``
 * is wired up, all clickable nodes will carry their exact bindings. */
export type NodeInteractionSpec = {
  clickBindings: ClickBinding[] | null;
  dragBindings: DragBinding[];
};

/** Every registry the classifier consults. Both maps are read-only
 * inputs to ``classifyPointerDown``; the InputManager mutates copies
 * via the existing ``MessageHandler`` paths and re-runs derivation. */
export type Registrations = {
  nodes: Map<string, NodeInteractionSpec>;
  scenePointerFilters: Map<ScenePointerEventType, ClickBinding[]>;
};

/** Build a classifier-shaped :data:`Registrations` from the
 * wire-format scene-pointer filter map. Synthesises a ``button:
 * "left"`` for each modifier; the existing
 * :class:`ScenePointerEnableMessage` wire format carries only
 * modifiers, and the historical convention is left-button-only.
 * ``nodes`` is empty: per-node interactions don't flow through the
 * canvas-level path (still owned by ``SceneTree.tsx``). */
export function registrationsFromScenePointerFilters(
  scenePointerFilters: Map<ScenePointerEventType, (KeyModifier | null)[]>,
): Registrations {
  const out = new Map<ScenePointerEventType, ClickBinding[]>();
  for (const [eventType, modifiers] of scenePointerFilters) {
    out.set(
      eventType,
      modifiers.map((m) => ({ button: "left", modifier: m })),
    );
  }
  return { nodes: new Map(), scenePointerFilters: out };
}

// ============================================================================
// Gesture: discriminated union owned by the InputManager.
// ============================================================================

/** Hover state derived from the central raycast. Drives the cursor
 * reducer and (transitively) the per-node hover styling. */
export type HoverState = {
  /** Top-most clickable node currently under the pointer, or ``null``. */
  clickableNode: { nodeName: string; instanceIndex: number | null } | null;
};

/** Discriminated gesture owned by the InputManager. Exhaustive: every
 * pointerdown maps to exactly one ``kind``; transitions between kinds
 * are explicit (see ``transitions`` in ``classify.ts`` / the
 * design doc).
 *
 * The two ``*-candidate`` kinds let InputManager own the *semantic*
 * decision (click vs drag, rect vs orbit) without taking the native
 * pointer stream away from camera-controls. ``cameraMayAlsoHandle`` is
 * derived once at classification and read by
 * :func:`deriveCameraControlEnabled`. */
export type Gesture =
  | { kind: "idle" }
  | {
      kind: "camera";
      pointerId: number;
      input: PointerInput;
      startXy: [number, number];
    }
  | {
      kind: "scene-pointer-candidate";
      pointerId: number;
      input: PointerInput;
      /** event_types whose filter set matched the input at pointerdown.
       * Always click-only here; rect-select short-circuits to the
       * committed ``scene-rect-select`` state. */
      eligible: Set<ScenePointerEventType>;
      startXy: [number, number];
      endXy: [number, number];
      moved: boolean;
      cameraMayAlsoHandle: boolean;
    }
  | {
      kind: "node-click-candidate";
      pointerId: number;
      input: PointerInput;
      nodeName: string;
      instanceIndex: number | null;
      startXy: [number, number];
      moved: boolean;
      cameraMayAlsoHandle: boolean;
      /** Drag bindings on the same node that *also* match the input.
       * When motion crosses :data:`MOTION_THRESHOLD_PX`, the gesture
       * transitions to ``node-drag`` and the InputManager dispatches
       * ``drag_start`` retroactively (with ``startXy`` as the
       * pointerdown position).
       *
       * ``null`` when the node has no matching drag binding -- in that
       * case motion past threshold falls through to camera-compatible
       * orbit, no click on release.
       *
       * This implements the "tap fires click, drag fires drag" rule
       * for nodes with overlapping bindings: drag does NOT win at
       * pointerdown anymore; it wins only after the user actually
       * moves past threshold. */
      dragBindingsToCommit: DragBinding[] | null;
    }
  | {
      kind: "scene-rect-select";
      pointerId: number;
      input: PointerInput;
      /** Includes ``"rect-select"``; may also include ``"click"`` when
       * a stationary press should fall back to a click on release. */
      eligible: Set<ScenePointerEventType>;
      startXy: [number, number];
      endXy: [number, number];
    }
  | {
      kind: "node-drag";
      pointerId: number;
      input: PointerInput;
      nodeName: string;
      instanceIndex: number | null;
      startXy: [number, number];
      /** Live drag state owned by ``DragLayer``. The InputManager owns
       * lifecycle (start/cancel/end); ``DragLayer`` keeps owning the
       * drag-plane math, arrow visualisation, and per-frame
       * recomputation. */
      dragState: ActiveDragState | null;
      /** Camera-control instance pinned at drag-start. A camera-type
       * swap during the drag would otherwise leave the original
       * instance disabled forever. See ``applyCameraEnabled`` in
       * ``cameraControlOwner.ts`` (step 3). */
      cameraControlAtStart: CameraControls | null;
    };

/** Discriminator union of just the ``kind`` strings. Useful for tests
 * and switch exhaustiveness checks. */
export type GestureKind = Gesture["kind"];

// ============================================================================
// Context-menu policy.
// ============================================================================

/** Short-lived suppression policy attached to the most recent
 * pointerdown. Browsers differ on ``contextmenu`` timing (macOS
 * ctrl-click fires before pointerup, plain right-click can fire after),
 * so we record the policy at classification and read it at the
 * ``contextmenu`` listener instead of guessing from event state -- the
 * ``contextmenu`` event does not reliably carry the original button
 * code (Chromium reports ``button=0`` for macOS ctrl+click). */
export type ContextMenuPolicy = {
  pointerId: number;
  input: PointerInput;
  /** Identity of the DOM target that received the pointerdown. The
   * ``contextmenu`` listener consults this to ignore stray context
   * menus on other targets within the same task. */
  target: EventTarget | null;
  suppress: boolean;
};
