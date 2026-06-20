import { matchesModifierFilter, type KeyModifier } from "../dragUtils";

export type ScenePointerEventType = "click" | "rect-select";

/**
 * Per-viewer single writer for `canvas.style.cursor`.
 *
 * Hover is stored as a set of node keys, not a refcount, so repeated
 * over/out events cannot underflow the cursor state.
 */
export class HoverCursorManager {
  private readonly hovered = new Set<string>();
  private heldModifier: KeyModifier | null = null;
  private rectSelectActive = false;
  private lastApplied: "auto" | "pointer" | "crosshair" | null = null;

  constructor(
    private readonly getCanvas: () => HTMLCanvasElement | null,
    private readonly getScenePointerFilter: (
      eventType: ScenePointerEventType,
    ) => readonly (KeyModifier | null)[] | undefined,
  ) {}

  /** Mark a clickable node hovered or unhovered. Idempotent. */
  setHovered(key: string, on: boolean): void {
    const changed = on ? !this.hovered.has(key) : this.hovered.delete(key);
    if (on) this.hovered.add(key);
    if (changed) this.apply();
  }

  refresh(): void {
    this.apply();
  }

  setHeldModifier(modifier: KeyModifier | null): void {
    if (modifier === this.heldModifier) return;
    this.heldModifier = modifier;
    this.apply();
  }

  setRectSelectActive(active: boolean): void {
    if (active === this.rectSelectActive) return;
    this.rectSelectActive = active;
    this.apply();
  }

  resetForTest(): void {
    this.hovered.clear();
    this.heldModifier = null;
    this.rectSelectActive = false;
    this.lastApplied = null;
    this.apply();
  }

  private derive(): "auto" | "pointer" | "crosshair" {
    if (this.rectSelectActive) return "crosshair";
    if (this.hovered.size > 0) return "pointer";
    const clickFilters = this.getScenePointerFilter("click");
    if (clickFilters !== undefined) {
      for (const m of clickFilters) {
        if (matchesModifierFilter(this.heldModifier, m)) return "pointer";
      }
    }
    return "auto";
  }

  private apply(): void {
    const canvas = this.getCanvas();
    if (canvas === null) return;
    const next = this.derive();
    if (next === this.lastApplied) return;
    this.lastApplied = next;
    canvas.style.cursor = next;
  }
}
