// THE single source of truth for how a docked region's tree maps to rendered
// width: which columns carry the region's pixel widths, and how much fixed
// "chrome" (inter-column dividers) sits on top of regionWidth.
//
// The width model (D20/D21/D40) is simple: `layout.regionWidth[edge]` is
// the region's rendered content need (what the region reserves, minus the
// divider chrome), maintained by width reconciliation on every commit -- a
// railed column contributes the fixed 36px strip to it while its stored
// weight keeps the P8 restore width (see widthReconciliation.ts and layout
// invariant #12). A minimized cell renders as its 26px bar in place at its
// column's width, so per-cell minimize never changes region width. The only
// other 36px form is the packed region rail (D21/D44: derived -- every
// column railed), which overrides the drawn width at the DockManager level
// while the model widths are preserved for restore.

import { widthColumns } from "./layoutOps";
import {
  DockColumn,
  DockRegion,
  MINIMIZED_STRIP_PX,
  SPLIT_DIVIDER_PX,
} from "./types";

export interface RegionPlan {
  /** The width-determining columns -- all of the region's (D46), in render
   * order. All of them carry pixel widths (see module note). */
  columns: DockColumn[];
  /** True when the region has a single column. Its weight is a horizontal share
   * that's irrelevant when alone, so its pixels live in regionWidth state, not
   * in the column weight. */
  singleColumn: boolean;
  /** Fixed chrome on top of regionWidth: the inter-column dividers. */
  chromePx: number;
}

export function planRegion(region: DockRegion): RegionPlan {
  // Resize math runs over all the region's columns (D46: one horizontal
  // partition).
  const columns = widthColumns(region);
  return {
    columns,
    singleColumn: columns.length === 1,
    chromePx: (columns.length - 1) * SPLIT_DIVIDER_PX,
  };
}

/** Rendered (reserved) width of the region: regionWidth plus divider
 * chrome (D40: regionWidth is the rendered content need by construction --
 * railed columns are counted at the 36px strip inside it by width
 * reconciliation; a fully railed multi-column region reconciles to 36 x
 * its column count, so N packed strips reserve their true width). The one
 * exception is a packed single-column region: there regionWidth keeps the
 * P8 restore width (a lone column's weight is an unreconciled flex share,
 * so regionWidth is its only width memory) while the rail renders 36px --
 * reserve the strip, not the restore width. */
export function plannedReservedWidth(
  plan: RegionPlan,
  regionWidthPx: number,
  regionPacked: boolean,
): number {
  if (regionPacked && plan.singleColumn) return MINIMIZED_STRIP_PX;
  return regionWidthPx + plan.chromePx;
}
