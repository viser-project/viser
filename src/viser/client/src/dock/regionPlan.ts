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

import {
  isColumnMinimized,
  topColumns,
  widthColumns,
} from "./layoutOps";
import {
  DockNode,
  GroupId,
  MINIMIZED_STRIP_PX,
  SPLIT_DIVIDER_PX,
  TabGroup,
} from "./types";

export interface RegionPlan {
  /** Any panel in the region is expanded: the region renders at
   * regionWidth + chromePx. False -> the whole region is strips. */
  hasExpanded: boolean;
  /** The width-determining columns, in render order. */
  columns: DockNode[];
  /** Per-column: renders as a fixed-width minimized strip. Same length and
   * order as `columns`. */
  isStrip: boolean[];
  /** Columns that carry pixel widths (the non-strips). The resizer
   * redistributes over these; the reconciler sums them. */
  expandedColumns: DockNode[];
  /** True when only one width-determining column surfaced (a single leaf, or
   * a lone stacked child of a column root). Its WEIGHT may be a height, so
   * its pixels live in regionWidth state, not in the weight. */
  singleColumn: boolean;
  /** Fixed chrome on top of regionWidth: strips + inter-column dividers. */
  chromePx: number;
}

export function planRegion(
  tree: DockNode,
  groups: Record<GroupId, TabGroup>,
): RegionPlan {
  // Contract rule 1: fully-minimized region -> every top-level column is a
  // strip.
  if (isColumnMinimized(tree, groups)) {
    const columns = topColumns(tree);
    return {
      hasExpanded: false,
      columns,
      isStrip: columns.map(() => true),
      expandedColumns: [],
      singleColumn: columns.length === 1,
      chromePx:
        columns.length * MINIMIZED_STRIP_PX +
        Math.max(0, columns.length - 1) * SPLIT_DIVIDER_PX,
    };
  }
  const columns = widthColumns(tree);
  if (columns.length === 1) {
    // A single surfaced column governs the width but always renders
    // full-width (no render row exists for it to be a strip in) -- even if
    // the surfaced child itself is fully minimized, the region's expanded
    // content lives in a stacked sibling spanning the same width.
    return {
      hasExpanded: true,
      columns,
      isStrip: [false],
      expandedColumns: columns,
      singleColumn: true,
      chromePx: 0,
    };
  }
  // Contract rule 2: in a genuine render row, fully-minimized children are
  // strips.
  const isStrip = columns.map((c) => isColumnMinimized(c, groups));
  const expandedColumns = columns.filter((_, i) => !isStrip[i]);
  return {
    hasExpanded: true,
    columns,
    isStrip,
    expandedColumns,
    singleColumn: false,
    chromePx:
      isStrip.filter(Boolean).length * MINIMIZED_STRIP_PX +
      Math.max(0, columns.length - 1) * SPLIT_DIVIDER_PX,
  };
}

/** Rendered width of the region: the expanded columns' regionWidth plus the
 * fixed chrome. (A fully-minimized region keeps its preserved regionWidth in
 * state for restore, but renders only the strips.) */
export function plannedReservedWidth(
  plan: RegionPlan,
  regionWidthPx: number,
): number {
  return (plan.hasExpanded ? regionWidthPx : 0) + plan.chromePx;
}
