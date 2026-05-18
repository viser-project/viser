import {
  matchesModifierFilter,
  motionExceedsThreshold,
  pointerButtonFromNative,
  type DragInput,
  type KeyModifier,
} from "../dragUtils";
import { CameraLockManager } from "./cameraLock";
import {
  HoverCursorManager,
  type ScenePointerEventType,
} from "./hoverSet";

export type { ScenePointerEventType } from "./hoverSet";

export type CanvasGesture =
  | { kind: "idle" }
  | {
      kind: "scene-pointer-candidate";
      pointerId: number;
      input: DragInput;
      startXy: [number, number];
      endXy: [number, number];
      moved: boolean;
      eligible: Set<ScenePointerEventType>;
    }
  | {
      kind: "scene-rect-select";
      pointerId: number;
      input: DragInput;
      startXy: [number, number];
      endXy: [number, number];
      eligible: Set<ScenePointerEventType>;
      release: () => void;
    };

export type ScenePointerOutcome =
  | { kind: "none" }
  | {
      kind: "scene-click";
      xy: [number, number];
      modifier: KeyModifier | null;
    }
  | {
      kind: "scene-rect-select";
      startXy: [number, number];
      endXy: [number, number];
      modifier: KeyModifier | null;
    };

const IDLE: CanvasGesture = { kind: "idle" };

export class ScenePointerController {
  private gesture: CanvasGesture = IDLE;
  private readonly filters = new Map<ScenePointerEventType, (KeyModifier | null)[]>();
  /** Cleanup for window-level pointerup/pointercancel listeners
   * installed while a gesture is engaged. Null when idle. The
   * listeners catch releases that happen off the canvas -- a
   * `scene-pointer-candidate` does not call `setPointerCapture` (so
   * camera-controls stays responsive), so an off-canvas release would
   * otherwise leak the gesture and block all subsequent pointerdowns
   * until the next on-canvas release. */
  private windowListenerCleanup: (() => void) | null = null;

  constructor(
    private readonly cameraLocks: CameraLockManager,
    private readonly hover: HoverCursorManager,
  ) {}

  /** Install window-level safety net. On-canvas releases fire the
   * canvas listener first (bubble phase) and clear the gesture, so
   * the window listener is a no-op on the happy path. */
  private installWindowListeners(): void {
    if (this.windowListenerCleanup !== null) return;
    const onPointerUp = (event: PointerEvent): void => {
      if (this.gesture.kind === "idle") return;
      if (this.gesture.pointerId !== event.pointerId) return;
      // Off-canvas release: cancel rather than dispatch a click or
      // rect-select outcome. If the user dragged off the canvas they
      // didn't mean to commit the gesture against this viewport.
      this.cancelPointer(event.pointerId);
    };
    const onPointerCancel = (event: PointerEvent): void => {
      this.cancelPointer(event.pointerId);
    };
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerCancel, { passive: true });
    this.windowListenerCleanup = () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  }

  private removeWindowListeners(): void {
    if (this.windowListenerCleanup === null) return;
    this.windowListenerCleanup();
    this.windowListenerCleanup = null;
  }

  getGesture(): CanvasGesture {
    return this.gesture;
  }

  applyFiltersDelta(
    eventType: ScenePointerEventType,
    modifiers: readonly (KeyModifier | null)[],
  ): void {
    if (modifiers.length === 0) this.filters.delete(eventType);
    else this.filters.set(eventType, [...modifiers]);
    this.hover.refresh();
  }

  getFilter(
    eventType: ScenePointerEventType,
  ): readonly (KeyModifier | null)[] | undefined {
    return this.filters.get(eventType);
  }

  anyFilterMatches(modifier: KeyModifier | null): boolean {
    for (const list of this.filters.values()) {
      for (const f of list) {
        if (matchesModifierFilter(modifier, f)) return true;
      }
    }
    return false;
  }

  onPointerDown(args: {
    pointerId: number;
    button: number;
    modifier: KeyModifier | null;
    xy: [number, number];
    insideViewport: boolean;
  }): CanvasGesture {
    if (this.gesture.kind !== "idle") return this.gesture;
    if (!args.insideViewport) return this.gesture;
    const button = pointerButtonFromNative(args.button);
    if (button === null) return this.gesture;
    if (this.filters.size === 0) return this.gesture;

    const input: DragInput = { button, modifier: args.modifier };
    const eligible = new Set<ScenePointerEventType>();
    for (const [eventType, modifiers] of this.filters) {
      if (
        button === "left" &&
        modifiers.some((m) => matchesModifierFilter(args.modifier, m))
      ) {
        eligible.add(eventType);
      }
    }
    if (eligible.size === 0) return this.gesture;
    if (eligible.has("rect-select")) {
      this.gesture = {
        kind: "scene-rect-select",
        pointerId: args.pointerId,
        input,
        startXy: args.xy,
        endXy: args.xy,
        eligible,
        release: this.cameraLocks.acquire("scene-rect-select"),
      };
      this.installWindowListeners();
      return this.gesture;
    }
    this.gesture = {
      kind: "scene-pointer-candidate",
      pointerId: args.pointerId,
      input,
      startXy: args.xy,
      endXy: args.xy,
      moved: false,
      eligible,
    };
    this.installWindowListeners();
    return this.gesture;
  }

  /** Returns true when the rect-select overlay should repaint. */
  onPointerMove(args: { pointerId: number; xy: [number, number] }): boolean {
    const g = this.gesture;
    if (g.kind !== "scene-pointer-candidate" && g.kind !== "scene-rect-select") {
      return false;
    }
    if (g.pointerId !== args.pointerId) return false;
    const exceeded = motionExceedsThreshold(g.startXy, args.xy);
    g.endXy = args.xy;
    if (g.kind === "scene-pointer-candidate") {
      if (exceeded) g.moved = true;
      return false;
    }
    if (exceeded) {
      this.hover.setRectSelectActive(true);
      return true;
    }
    return false;
  }

  onPointerUp(args: { pointerId: number }): ScenePointerOutcome {
    const g = this.gesture;
    if (g.kind === "idle") return { kind: "none" };
    if (g.pointerId !== args.pointerId) return { kind: "none" };

    this.hover.setRectSelectActive(false);
    if (g.kind === "scene-pointer-candidate") {
      this.gesture = IDLE;
      this.removeWindowListeners();
      if (!g.moved && g.eligible.has("click")) {
        return {
          kind: "scene-click",
          xy: g.startXy,
          modifier: g.input.modifier,
        };
      }
      return { kind: "none" };
    }

    g.release();
    const moved = motionExceedsThreshold(g.startXy, g.endXy);
    this.gesture = IDLE;
    this.removeWindowListeners();
    if (moved) {
      return {
        kind: "scene-rect-select",
        startXy: g.startXy,
        endXy: g.endXy,
        modifier: g.input.modifier,
      };
    }
    if (g.eligible.has("click")) {
      return {
        kind: "scene-click",
        xy: g.startXy,
        modifier: g.input.modifier,
      };
    }
    return { kind: "none" };
  }

  cancelPointer(pointerId: number): void {
    const g = this.gesture;
    if (g.kind !== "idle" && g.pointerId === pointerId) {
      this.hover.setRectSelectActive(false);
      if (g.kind === "scene-rect-select") g.release();
      this.gesture = IDLE;
      this.removeWindowListeners();
    }
  }

  cancelAny(): void {
    if (this.gesture.kind === "idle") return;
    this.hover.setRectSelectActive(false);
    if (this.gesture.kind === "scene-rect-select") {
      this.gesture.release();
    }
    this.gesture = IDLE;
    this.removeWindowListeners();
  }

  resetForTest(): void {
    this.cancelAny();
    this.filters.clear();
    this.hover.refresh();
  }
}

type NodeCandidate = {
  pointerId: number;
  nodeKey: string;
  startClientXy: [number, number];
  release: (() => void) | null;
  cleanup: () => void;
  onPromote: (() => boolean) | null;
};

export class NodeGestureController {
  private candidate: NodeCandidate | null = null;
  private lastPointerDownInput: DragInput | null = null;

  constructor(private readonly cameraLocks: CameraLockManager) {}

  recordPointerDown(input: DragInput | null): void {
    this.lastPointerDownInput = input;
  }

  getLastPointerDownInput(): DragInput | null {
    return this.lastPointerDownInput;
  }

  clearLastPointerDownInput(): void {
    this.lastPointerDownInput = null;
  }

  beginCandidate(args: {
    pointerId: number;
    nodeKey: string;
    startClientXy: [number, number];
    lockCamera: boolean;
    onPromote: (() => boolean) | null;
  }): void {
    this.cancelCandidate();

    const handlePointerMove = (event: PointerEvent) => {
      const candidate = this.candidate;
      if (candidate === null || event.pointerId !== candidate.pointerId) return;
      if (
        !motionExceedsThreshold(candidate.startClientXy, [
          event.clientX,
          event.clientY,
        ])
      ) {
        return;
      }
      this.promoteOrCancelCandidate();
    };
    const handlePointerUp = (event: PointerEvent) => {
      const candidate = this.candidate;
      if (candidate === null || event.pointerId !== candidate.pointerId) return;
      this.lastPointerDownInput = null;
      this.cancelCandidate();
    };
    const handlePointerCancel = (event: PointerEvent) => {
      this.cancelPointer(event.pointerId);
    };
    const handleBlur = () => {
      this.cancelCandidate();
      this.lastPointerDownInput = null;
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", handleBlur);
    };

    this.candidate = {
      pointerId: args.pointerId,
      nodeKey: args.nodeKey,
      startClientXy: args.startClientXy,
      release: args.lockCamera
        ? this.cameraLocks.acquire("node-click-or-drag-candidate")
        : null,
      cleanup,
      onPromote: args.onPromote,
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    window.addEventListener("blur", handleBlur);
  }

  settlePointerUp(args: { pointerId: number }): "click" | "none" {
    const candidate = this.candidate;
    if (candidate === null || candidate.pointerId !== args.pointerId) {
      return "none";
    }
    this.cancelCandidate();
    return "click";
  }

  cancelPointer(pointerId: number): void {
    const candidate = this.candidate;
    if (candidate === null || candidate.pointerId !== pointerId) return;
    this.cancelCandidate();
    this.lastPointerDownInput = null;
  }

  cancelNode(nodeKey: string): void {
    const candidate = this.candidate;
    if (candidate === null || candidate.nodeKey !== nodeKey) return;
    this.cancelCandidate();
  }

  cancelAny(): void {
    this.cancelCandidate();
    this.lastPointerDownInput = null;
  }

  resetForTest(): void {
    this.cancelAny();
  }

  private promoteOrCancelCandidate(): void {
    const candidate = this.candidate;
    if (candidate === null) return;
    const promote = candidate.onPromote;
    this.cancelCandidate();
    if (promote !== null) promote();
  }

  private cancelCandidate(): void {
    const candidate = this.candidate;
    if (candidate === null) return;
    this.candidate = null;
    candidate.cleanup();
    if (candidate.release !== null) candidate.release();
  }
}
