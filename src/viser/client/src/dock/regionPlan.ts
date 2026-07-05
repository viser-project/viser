// THE single source of truth for how a docked region's tree maps to rendered
// width: which columns carry the region's pixel widths, and how much fixed
// "chrome" (inter-column dividers) sits on top of regionWidth.
//
// The width model post-D20/D21 is simple: EVERY width-determining column
// carries pixels -- a minimized cell renders as its 26px bar IN PLACE at its
// column's width, so minimize never changes region width. The only 36px form
// is the EXPLICITLY collapsed region (D21, layout.regionCollapsed[edge]),
// which overrides the drawn width at the DockManager level while the model
// widths are preserved for restore.

import { widthColumns } from "./layoutOps";
import {
  DockColumn,
  DockRegion,
  MINIMIZED_STRIP_PX,
  SPLIT_DIVIDER_PX,
} from "./types";

export interface RegionPlan {
  /** The width-determining columns (the widest row band's), in render order.
   * ALL of them carry pixel widths (see module note). */
  columns: DockColumn[];
  /** True when the region has a single column. Its WEIGHT is a horizontal share
   * that's irrelevant when alone, so its pixels live in regionWidth state, not
   * in the column weight. */
  singleColumn: boolean;
  /** Fixed chrome on top of regionWidth: the inter-column dividers. */
  chromePx: number;
}

export function planRegion(region: DockRegion): RegionPlan {
  // Width is set by the widest row band's columns (a full-width band spans the
  // region width; narrower bands ride along).
  const columns = widthColumns(region);
  return {
    columns,
    singleColumn: columns.length === 1,
    chromePx: (columns.length - 1) * SPLIT_DIVIDER_PX,
  };
}

/** Rendered (reserved) width of the region: the EXPLICIT collapse state (D21)
 * reserves exactly the 36px rail; otherwise regionWidth plus divider chrome.
 * Model widths are untouched by collapse, so expand restores them exactly.
 *
 * Per-COLUMN rails: a railed width-column renders at the fixed strip width
 * while its stored weight is preserved for restore (P8), so the rendered
 * width swaps that column's SHARE of regionWidth out for MINIMIZED_STRIP_PX.
 * The share is proportional over the plan's column weights: with reconciled
 * (pixel) weights it is exact, and it degrades gracefully for unreconciled
 * flex-share weights (test literals, pre-reconcile drafts). */
export function plannedReservedWidth(
  plan: RegionPlan,
  regionWidthPx: number,
  regionCollapsed: boolean,
): number {
  if (regionCollapsed) return MINIMIZED_STRIP_PX;
  const railedCount = plan.columns.filter((c) => c.railed === true).length;
  if (railedCount === 0) return regionWidthPx + plan.chromePx;
  const totalW = plan.columns.reduce((s, c) => s + c.weight, 0) || 1;
  const expandedW = plan.columns.reduce(
    (s, c) => s + (c.railed === true ? 0 : c.weight),
    0,
  );
  return (
    (regionWidthPx * expandedW) / totalW +
    railedCount * MINIMIZED_STRIP_PX +
    plan.chromePx
  );
}
