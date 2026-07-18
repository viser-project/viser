// THE single decision point for applying server placement to a panel -- shared
// by the main control panel and standalone panels so their gating can't drift.
//
// The server's placement commands are per-axis (position / width / height /
// collapsed), each stamped with (counter, runId). This gate decides PER AXIS
// whether the stored command should be (re)applied. The rule is ONE
// comparison, with no notion of "user touched" (D52):
//
// - Panel NOT PLACED in the layout (its group vanished -- fresh arrival, full
//   tab-container swap, re-shown after hide): every present axis applies. You
//   can't yank what isn't placed, and a stale-but-real server position beats
//   dumping the panel at a default float.
// - PLACED: an axis applies iff its stamp is NEWER than everything previously
//   applied FROM ITS OWN RUN -- a higher counter than that run's recorded
//   high-water mark, or a run never seen for this axis at all (a restarted
//   server or another scope: a genuinely fresh command). Recording a PER-RUN
//   high-water map (not just the last stamp) is what makes a reconnect replay
//   of an OLD run's command stale even when the most recent apply came from a
//   different scope -- "runId differs from the last applied" alone would
//   misread that replay as fresh and yank the panel.
//
// Why no user-touched bit: the high-water marks subsume it. A panel the user
// rearranged is protected because every replayed stamp is at or below the
// mark recorded when it FIRST applied -- true whether or not the user touched
// anything -- and a genuinely new command (higher counter / unseen run)
// applies to touched and untouched panels alike (P6: the server re-asserts by
// SENDING, never by replay). The old "an untouched panel re-applies every
// present axis" arm existed to re-seed panels whose placement a reconnect had
// destroyed; the explicit reconnect phase (D51) keeps them placed instead,
// and the arm's one remaining live effect was a bug -- a new message on ANY
// axis re-freed every stale axis of an untouched panel, so a set_width could
// replay an already-applied collapse into a shared container and re-collapse
// a column another panel's newer command had expanded.
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
  applied: AppliedAxes | undefined,
  placed: boolean,
): GatedPlacement {
  // Per-axis freshness, resolved with full types (no loop over axis names --
  // that shape forced a Record cast to write the heterogeneous values back).
  const freshAxis = <A extends PlacementAxisName>(axis: A) => {
    const stored = entry?.[axis];
    if (stored === undefined) return undefined;
    // Fresh iff newer than this axis's high-water mark FOR THE COMMAND'S OWN
    // RUN; an unseen run has no mark and is always fresh. An unplaced panel
    // applies everything (there is nothing to disturb).
    const appliedForRun = applied?.[axis]?.[stored.runId] ?? -1;
    const fresh = !placed || stored.counter > appliedForRun;
    return fresh ? stored : undefined;
  };
  const position = freshAxis("position");
  const width = freshAxis("width");
  const height = freshAxis("height");
  const collapsed = freshAxis("collapsed");
  const appliedOut: AppliedAxes = {};
  for (const [axis, stored] of [
    ["position", position],
    ["width", width],
    ["height", height],
    ["collapsed", collapsed],
  ] as const) {
    if (stored !== undefined)
      appliedOut[axis] = { [stored.runId]: stored.counter };
  }
  return {
    placement: {
      position: position?.value ?? null,
      width: width?.value ?? null,
      height: height?.value ?? null,
      collapsed: collapsed?.value ?? null,
    },
    applied: appliedOut,
    anyFresh:
      position !== undefined ||
      width !== undefined ||
      height !== undefined ||
      collapsed !== undefined,
  };
}
