// THE single source of truth for how a docked region's tree maps to rendered
// width: which width-determining columns render as fixed-width minimized
// strips, which are expanded panes, and how much fixed "chrome" (strips +
// inter-column dividers) sits on top of the expanded columns' regionWidth.
//
// Every width consumer derives from this one classification -- the region box
// width in DockManager, the edge resizer's redistribution set, the auto-grow
// minimum, and the reconciler's collapse-pattern comparison -- so they cannot
// disagree with each other.
//
// RENDER CONTRACT (mirrors SplitView, which renders strips in exactly two
// places):
//   1. A region root that is FULLY minimized renders one strip per top-level
//      column (side by side, with dividers).
//   2. Inside a genuine render row, a fully-minimized child column renders as
//      a strip (collapsedInRow).
// Everything else renders full-width: in particular, a COLUMN split holding a
// collapsed leaf above an expanded one renders the collapsed leaf as a
// full-width horizontal bar -- NOT a strip -- so a width-determining column
// that happens to be minimized while the region has expanded content
// elsewhere must not be counted as a strip. (Getting this wrong squeezed a
// freshly docked panel into a 36px region.)

import { isColumnMinimized, isRegionMinimized, widthColumns } from "./layoutOps";
import {
  DockColumn,
  DockEdge,
  DockRegion,
  GroupId,
  MINIMIZED_STRIP_PX,
  SPLIT_DIVIDER_PX,
  TabGroup,
} from "./types";

export interface RegionPlan {
  /** Any panel in the region is expanded: the region renders at
   * regionWidth + chromePx. False -> the whole region is strips. */
  hasExpanded: boolean;
  /** The region's columns, in render order. */
  columns: DockColumn[];
  /** Per-column: renders as a fixed-width minimized strip. Same length and
   * order as `columns`. */
  isStrip: boolean[];
  /** Columns that carry pixel widths (the non-strips). The resizer
   * redistributes over these; the reconciler sums them. */
  expandedColumns: DockColumn[];
  /** True when the region has a single column. Its WEIGHT is a horizontal share
   * that's irrelevant when alone, so its pixels live in regionWidth state, not
   * in the column weight. */
  singleColumn: boolean;
  /** Fixed chrome on top of regionWidth: strips + inter-column dividers. */
  chromePx: number;
  /** True when ANY band in the region has an expanded column -- not just the
   * width-determining row `hasExpanded` reflects. A non-widthRow band can be
   * expanded while the widthRow is all strips (e.g. a wide band minimized above
   * a narrower expanded band); the region must still reserve its content width,
   * or the expanded band gets squished to strip width. The reserved-width math
   * gates on THIS, while the resizer/reconciler still use the widthRow fields.
   *
   * Equals `!isRegionMinimized(region, groups)`. SplitView recomputes the same
   * predicate as `regionHasExpanded` -- deliberately, NOT a missed dedup: this
   * plan is widthRow-shaped (it has discarded per-band structure), while
   * SplitView needs the full per-band collapsed mask anyway, so threading this
   * one scalar down would couple the width plan to the renderer for no saving. */
  anyBandExpanded: boolean;
}

export function planRegion(
  region: DockRegion,
  groups: Record<GroupId, TabGroup>,
): RegionPlan {
  // Width is set by the widest row band's columns (a full-width band spans the
  // region width; narrower bands ride along). A column is a fixed-width
  // minimized strip exactly when all its leaves are collapsed.
  const columns = widthColumns(region);
  const isStrip = columns.map((c) => isColumnMinimized(c, groups));
  const expandedColumns = columns.filter((_, i) => !isStrip[i]);
  // Region-wide: any band (not just the widthRow) with an expanded column means
  // the region must reserve its content width so that band isn't squished.
  // "Some band not minimized" is exactly the negation of "every band minimized".
  const anyBandExpanded = !isRegionMinimized(region, groups);

  if (columns.length === 1) {
    if (isStrip[0]) {
      // A fully-minimized lone column renders as a single strip; its preserved
      // width is kept (in regionWidth) for restore.
      return {
        hasExpanded: false,
        columns,
        isStrip: [true],
        expandedColumns: [],
        singleColumn: true,
        chromePx: MINIMIZED_STRIP_PX,
        anyBandExpanded,
      };
    }
    // An expanded lone column renders full-width: there is no render row for it
    // to be a strip in, so even a minimized leaf stacked above an expanded one
    // (the column itself is NOT fully minimized) is a full-width horizontal bar,
    // not a strip.
    return {
      hasExpanded: true,
      columns,
      isStrip: [false],
      expandedColumns: columns,
      singleColumn: true,
      chromePx: 0,
      anyBandExpanded,
    };
  }

  if (expandedColumns.length === 0) {
    // Fully-minimized multi-column region: every column is a strip.
    return {
      hasExpanded: false,
      columns,
      isStrip,
      expandedColumns: [],
      singleColumn: false,
      chromePx:
        columns.length * MINIMIZED_STRIP_PX +
        Math.max(0, columns.length - 1) * SPLIT_DIVIDER_PX,
      anyBandExpanded,
    };
  }

  // Genuine render row: fully-minimized columns are strips, the rest expand.
  return {
    hasExpanded: true,
    columns,
    isStrip,
    expandedColumns,
    singleColumn: false,
    chromePx:
      isStrip.filter(Boolean).length * MINIMIZED_STRIP_PX +
      Math.max(0, columns.length - 1) * SPLIT_DIVIDER_PX,
    anyBandExpanded,
  };
}

/** Rendered width of the region.
 *
 * - widthRow has expanded columns (mixed): regionWidth (expanded cols) + chrome
 *   (its minimized-strip columns + dividers render ON TOP).
 * - widthRow is all strips but ANOTHER band is expanded: that band renders
 *   full-width and the all-strip widthRow renders as a full-width horizontal
 *   bar -- so the region reserves regionWidth with NO strip chrome (the strip
 *   chrome only applies to strips sitting BESIDE expanded columns in the same
 *   render row, which there are none of here).
 * - nothing expanded anywhere: chrome only (the all-minimized region renders
 *   just its strips; the preserved regionWidth is kept in state for restore). */
export function plannedReservedWidth(
  plan: RegionPlan,
  regionWidthPx: number,
): number {
  if (plan.hasExpanded) return regionWidthPx + plan.chromePx;
  // widthRow all strips: if another band is expanded, reserve its content width
  // (no strip chrome -- the minimized widthRow is a full-width bar, not strips
  // beside expanded columns). Else fully minimized: chrome only.
  return plan.anyBandExpanded ? regionWidthPx : plan.chromePx;
}

/** Width (px) of the contiguous run of minimized strips on the region's
 * CANVAS-FACING side -- the strips between the region's outer (resize) edge and
 * its first expanded column. The region resizer is offset inward by this so the
 * handle sits on the boundary of the panel it actually resizes
 * (`[strip]│[panel]`), not on the far side of the strip (`│[strip][panel]`).
 *
 * Render order in `columns` is left->right. The canvas is on the LEFT of a right
 * region (so leading columns are canvas-facing) and on the RIGHT of a left
 * region (so trailing columns are). Each leading strip contributes its strip
 * width plus the divider that follows it (the divider between it and the next
 * column). Returns 0 when there are no expanded columns (nothing to resize) or
 * no canvas-facing strips. */
export function canvasFacingStripOffsetPx(
  plan: RegionPlan,
  edge: DockEdge,
): number {
  if (!plan.hasExpanded) return 0;
  // Walk from the canvas-facing end toward the first expanded column.
  const order =
    edge === "right"
      ? plan.isStrip.map((_, i) => i) // leading
      : plan.isStrip.map((_, i) => plan.isStrip.length - 1 - i); // trailing
  let offset = 0;
  for (const i of order) {
    if (!plan.isStrip[i]) break; // reached the first expanded column
    offset += MINIMIZED_STRIP_PX + SPLIT_DIVIDER_PX;
  }
  return offset;
}
