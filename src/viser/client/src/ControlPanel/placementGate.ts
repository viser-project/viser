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
  PanelPlacementState,
  PlacementAxisName,
} from "./GuiState";
import type { PanelPlacement } from "../dock/layoutOps";

const AXES: PlacementAxisName[] = ["position", "width", "height", "collapsed"];

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
  tracking:
    | { applied: AppliedAxes; userTouched: boolean }
    | undefined,
  placed: boolean,
): GatedPlacement {
  const placement: PanelPlacement = {
    position: null,
    width: null,
    height: null,
    collapsed: null,
  };
  const applied: AppliedAxes = {};
  let anyFresh = false;
  const gateOpen = tracking?.userTouched !== true || !placed;
  for (const axis of AXES) {
    const stored = entry?.[axis];
    if (stored === undefined) continue;
    const last = tracking?.applied[axis];
    const fresh =
      gateOpen ||
      last === undefined ||
      stored.runId !== last.runId ||
      stored.counter > last.counter;
    if (!fresh) continue;
    // The axes' value types line up field-by-field (position/width/height/
    // collapsed); TypeScript can't prove it across the loop variable.
    (placement as Record<PlacementAxisName, unknown>)[axis] = stored.value;
    applied[axis] = { counter: stored.counter, runId: stored.runId };
    anyFresh = true;
  }
  return { placement, applied, anyFresh };
}
