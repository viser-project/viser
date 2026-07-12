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
// column's width, so per-cell minimize never changes region width. The
// packed region rail (D21/D44: derived -- every column railed) is no render
// exception: an all-railed region's regionWidth reconciles to 36 x its
// column count, single columns included, so the reserved width below is
// uniform for every region shape.

import { widthColumns } from "./layoutOps";
import { DockColumn, DockRegion, SPLIT_DIVIDER_PX } from "./types";

export interface RegionPlan {
  /** The width-determining columns -- all of the region's (D46), in render
   * order. All of them carry pixel widths as weights (a railed column's
   * weight is its P8 restore width; see the module note). */
  columns: DockColumn[];
  /** Fixed chrome on top of regionWidth: the inter-column dividers. */
  chromePx: number;
}

export function planRegion(region: DockRegion): RegionPlan {
  // Resize math runs over all the region's columns (D46: one horizontal
  // partition).
  const columns = widthColumns(region);
  return {
    columns,
    chromePx: (columns.length - 1) * SPLIT_DIVIDER_PX,
  };
}

/** Rendered (reserved) width of the region: regionWidth plus divider
 * chrome (D40: regionWidth is the rendered content need by construction --
 * railed columns are counted at the 36px strip inside it by width
 * reconciliation, and a fully railed region -- any column count -- holds
 * exactly 36 x its columns, so packed strips reserve their true width with
 * no special case). */
export function plannedReservedWidth(
  plan: RegionPlan,
  regionWidthPx: number,
): number {
  return regionWidthPx + plan.chromePx;
}
