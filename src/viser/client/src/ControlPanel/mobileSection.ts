// The mobile bottom-sheet's collapse arbitration -- kept free of GuiState's
// module-level window access so the pure decision function is testable in a
// node environment (same separation as placementGate.ts).

import type { PlacementAxis, AppliedAxisRecord } from "./GuiState";

/** One mobile bottom-sheet section's state: its rendered collapse state AND
 * its own applied watermark for the collapsed axis. Both live in the store
 * because a watermark is only valid as long as the state its application
 * produced: component-local state dies on remount (reconnect, breakpoint
 * flip) while a surviving mark would suppress the replay that could restore
 * it. The mark is SURFACE-SPECIFIC, not shared with the dock's
 * panelLayoutTracking -- desktop and mobile are independent representations
 * of collapse, so a command consumed by the dock must still apply to the
 * sheet when the viewport shrinks (external re-review, third pass). */
export interface MobilePanelSection {
  expanded: boolean;
  collapsedApplied: AppliedAxisRecord;
}

/** The mobile section's next state after a collapsed-axis command, or null
 * when the command is at/below the section's own high-water mark (stale:
 * replay or already applied here). Pure, so the arbitration is unit-testable;
 * the store action is a thin wrapper. */
export function mobileSectionAfterAxis(
  prev: MobilePanelSection | undefined,
  axis: PlacementAxis<boolean>,
): MobilePanelSection | null {
  if ((prev?.collapsedApplied[axis.runId] ?? -1) >= axis.counter) return null;
  return {
    expanded: !axis.value,
    collapsedApplied: {
      ...prev?.collapsedApplied,
      [axis.runId]: axis.counter,
    },
  };
}

/** Rebuild every mobile section from the LATEST stored collapsed axis -- the
 * "layout the server set" -- discarding user taps and watermarks. Panels with
 * no stored collapse command return to the sheet default (collapsed, i.e. no
 * entry). Used by resetPanelLayout: the mobile command effect only re-runs
 * when an axis CHANGES, and reset re-applies axes without changing them, so
 * the rebuild must happen synchronously in the store. */
export function mobileSectionsFromPlacement(panelPlacement: {
  [uuid: string]: { collapsed?: PlacementAxis<boolean> };
}): { [uuid: string]: MobilePanelSection } {
  const out: { [uuid: string]: MobilePanelSection } = {};
  for (const [uuid, placement] of Object.entries(panelPlacement)) {
    if (placement.collapsed === undefined) continue;
    const next = mobileSectionAfterAxis(undefined, placement.collapsed);
    if (next !== null) out[uuid] = next;
  }
  return out;
}
