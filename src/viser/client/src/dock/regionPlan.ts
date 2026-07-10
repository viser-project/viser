// THE single source of truth for how a docked region's tree maps to rendered
// width: which columns carry the region's pixel widths, and how much fixed
// "chrome" (inter-column dividers) sits on top of regionWidth.
//
// The width model post-D20/D21/D40 is simple: `layout.regionWidth[edge]` IS
// the region's rendered content need (what the region reserves, minus the
// divider chrome), maintained by width reconciliation on every commit -- a
// railed column contributes the fixed 36px strip to it while its stored
// weight keeps the P8 restore width (see widthReconciliation.ts and layout
// invariant #16). A minimized CELL renders as its 26px bar in place at its
// column's width, so per-cell minimize never changes region width. The only
// other 36px form is the PACKED region rail (D21/D44: derived -- every
// band single-column, every column railed), which overrides the drawn
// width at the DockManager level while the model widths are preserved for
// restore.

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
  // Resize math runs over the widest row band's columns (a full-width band
  // spans the region width; narrower bands ride along).
  const columns = widthColumns(region);
  return {
    columns,
    singleColumn: columns.length === 1,
    chromePx: (columns.length - 1) * SPLIT_DIVIDER_PX,
  };
}

/** Rendered (reserved) width of the region: the EXPLICIT collapse state (D21)
 * reserves exactly the 36px rail; otherwise regionWidth plus divider chrome.
 * ONE uniform rule (D40, 2026-07 stability pass): regionWidth is maintained
 * as the rendered content need BY CONSTRUCTION -- railed columns are counted
 * at the 36px strip inside it by width reconciliation, so no per-plan railed
 * accounting happens here. Model column weights are untouched by collapse, so
 * expand restores them exactly. */
export function plannedReservedWidth(
  plan: RegionPlan,
  regionWidthPx: number,
  regionPacked: boolean,
): number {
  if (regionPacked) return MINIMIZED_STRIP_PX;
  return regionWidthPx + plan.chromePx;
}
