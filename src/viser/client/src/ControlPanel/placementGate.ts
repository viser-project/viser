// THE single decision point for applying server placement to a panel -- shared
// by the main control panel and standalone panels so their gating can't drift.
//
// The server's four placement commands are per-axis (position / width / height
// / collapsed), each stamped with (counter, runId). This gate decides PER AXIS
// whether the stored command should be (re)applied:
//
// - Panel not yet user-touched: every present axis applies (a reconnect/re-run
//   re-seeds an untouched panel, even at a lower counter).
// - Panel NOT PLACED in the layout (its group vanished -- fresh arrival, full
//   tab-container swap, re-shown after hide): every present axis applies. You
//   can't yank what isn't placed, and a stale-but-real server position beats
//   dumping the panel at a default float.
// - Otherwise (user-touched AND placed): an axis applies only when its stamp is
//   NEWER than the last applied -- same run with a higher counter (the server
//   actively re-asserted), or a different runId (a restarted server or another
//   scope, whose counters aren't comparable -- treat as a fresh command).
//
// Applying a SUBSET of axes is what kills the yank bug by construction: a
// set_width after the user moved the panel re-applies only the width axis; the
// stale position axis stays gated off and cannot re-dock the panel.

import type {
  AppliedAxes,
  PanelLayoutEntry,
  PanelPlacementState,
  PlacementAxisName,
} from "./GuiState";
import type { PanelPlacement } from "../dock/layoutOps";

export interface GatedPlacement {
  /** Bundle for applyPanelPlacement: fresh axes carry their value, gated-off or
   * absent axes are null (= "don't touch this axis"). */
  placement: PanelPlacement;
  /** The (counter, runId) stamps of the axes included above, to record as
   * applied after the layout op commits. */
  applied: AppliedAxes;
  /** True when at least one axis is fresh (something to apply). */
  anyFresh: boolean;
}

export function gatePlacement(
  entry: PanelPlacementState | undefined,
  tracking: PanelLayoutEntry | undefined,
  placed: boolean,
): GatedPlacement {
  const gateOpen = tracking?.userTouched !== true || !placed;
  // Per-axis freshness, resolved with full types (no loop over axis names --
  // that shape forced a Record cast to write the heterogeneous values back).
  const freshAxis = <A extends PlacementAxisName>(axis: A) => {
    const stored = entry?.[axis];
    if (stored === undefined) return undefined;
    const last = tracking?.applied[axis];
    const fresh =
      gateOpen ||
      last === undefined ||
      stored.runId !== last.runId ||
      stored.counter > last.counter;
    return fresh ? stored : undefined;
  };
  const position = freshAxis("position");
  const width = freshAxis("width");
  const height = freshAxis("height");
  const collapsed = freshAxis("collapsed");
  const applied: AppliedAxes = {};
  for (const [axis, stored] of [
    ["position", position],
    ["width", width],
    ["height", height],
    ["collapsed", collapsed],
  ] as const) {
    if (stored !== undefined)
      applied[axis] = { counter: stored.counter, runId: stored.runId };
  }
  return {
    placement: {
      position: position?.value ?? null,
      width: width?.value ?? null,
      height: height?.value ?? null,
      collapsed: collapsed?.value ?? null,
    },
    applied,
    anyFresh:
      position !== undefined ||
      width !== undefined ||
      height !== undefined ||
      collapsed !== undefined,
  };
}
