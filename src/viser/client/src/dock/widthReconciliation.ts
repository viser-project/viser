// Region-width reconciliation across layout ops: keeps docked panes at their
// pixel widths when the layout's STRUCTURE changes. Pure except for mutating
// `next` (the caller owns it, a fresh draft): top-column weights may be
// rewritten to pixels, and `next.regionWidth` is always (re)written.
//
// Width model: a region's width-determining columns store their EXPANDED
// pixel widths as tree weights, and `layout.regionWidth[edge]` is the sum
// over the EXPANDED columns only. Fully-minimized columns keep their
// preserved pixel width in their weight (it's what they get back on expand)
// but render as fixed MINIMIZED_STRIP_PX strips that sit ON TOP of
// regionWidth -- so resize math and the rendered layout agree, and resizing
// never touches a strip.
//
// The width lives IN the layout (DockLayout.regionWidth), so it has one
// source of truth: clones carry it through every op, snapshots restore it,
// and this reconciliation -- run on every applyOp commit -- is the only
// writer. Layouts that bypassed the ops (test literals, injected layouts)
// simply lack the field and get defaults here.

import { collectLeafGroups, minRegionWidth, widthColumns } from "./layoutOps";
import { planRegion, RegionPlan } from "./regionPlan";
import {
  DEFAULT_REGION_PX,
  DockColumn,
  DockEdge,
  DockLayout,
  regionWidthsOf,
} from "./types";

// regionWidth is the EXPANDED columns' summed widths with NO dividers -- the
// inter-column dividers (and strips) are chrome, added on top via the render
// plan's chromePx (see regionPlan.plannedReservedWidth). So the bounds that
// clamp regionWidth must NOT include dividers either, or the divider px would
// be double-counted (once in the floor, once again in chromePx).

/** Sum of `cols`' minimum widths (no dividers -- those are chrome), for
 * clamping regionWidth. */
function colsMin(cols: DockColumn[]): number {
  return cols.reduce((s) => s + minRegionWidth(), 0);
}

// There is no upper bound on region width -- a docked region may be dragged as
// wide as the user likes. Only the grab-min floor is enforced (below + in
// clampRegionWidth); the render-time MIN_CANVAS_PX guard keeps a canvas sliver
// visible.

/** Reconcile docked region widths across a layout transition, writing the
 * result into `next.regionWidth` (and, for structural changes, into the
 * top columns' weights).
 *
 * - When a region's SET of width-determining columns changes (dock/undock/
 *   merge/unmerge/snap/split), the column weights are rewritten to absolute
 *   pixel widths -- surviving columns keep their previous pixels, new columns
 *   get a default -- and regionWidth becomes the EXPANDED columns' sum.
 * - When only the columns' MINIMIZED pattern changes (collapse/expand
 *   toggles), regionWidth is recomputed from the expanded columns' stored
 *   pixel weights: a column entering minimization leaves the sum (its strip
 *   renders on top); one expanding rejoins at its preserved width.
 * - Pure-internal changes (resize, reorder, floating moves) leave both the
 *   column set and the pattern alone, so widths carry over untouched. An op
 *   that deliberately wrote `next.regionWidth` (setRegionWidth) is trusted:
 *   its value is the carry-over base.
 * - INVARIANT, enforced on every commit: regionWidth is never below the
 *   expanded columns' summed minimum -- now just a tiny grabbable sliver per
 *   column (MIN_REGION_GRAB_PX), NOT the panel-content minimum. A region narrower
 *   than its panes' content simply scrolls the body; it does not auto-grow. */
export function reconcileRegionWidths(prev: DockLayout, next: DockLayout): void {
  // Carry-over base: the op's own value when it set one (clones inherit
  // prev's, so a differing value is a deliberate write), else prev's.
  const nextRW = regionWidthsOf(next.regionWidth !== undefined ? next : prev);
  const prevRW = regionWidthsOf(prev);

  (["left", "right"] as DockEdge[]).forEach((edge) => {
    const nextTree = next.docked[edge];
    if (nextTree === null) return; // empty edge: keep the width for restore.
    const prevTree = prev.docked[edge];
    // The region IS a row of columns now, so the width-determining columns are
    // simply `region.columns` -- plan and reconciler iterate the identical list
    // (the old "descend into the widest child to guess the columns" logic, and
    // the LEAD 1 bug it patched, are gone).
    const prevCols = prevTree ? widthColumns(prevTree) : [];
    const nextCols = widthColumns(nextTree);
    const sameSet =
      prevCols.length === nextCols.length &&
      prevCols.every((c, i) => c.id === nextCols[i].id);

    const nextPlan = planRegion(nextTree, next.groups);
    if (sameSet) {
      // Same columns: only a STRIP-pattern flip (collapse/expand toggle)
      // changes regionWidth -- the toggled column leaves or rejoins the
      // expanded sum at its stored pixel weight. The strip classification is
      // the render's (planRegion), NOT raw per-column minimized-ness: a
      // minimized column stacked above expanded content renders full-width
      // and must stay in the sum.
      const prevPlan =
        prevTree !== null ? planRegion(prevTree, prev.groups) : null;
      const patternChanged =
        prevPlan === null ||
        prevPlan.isStrip.length !== nextPlan.isStrip.length ||
        prevPlan.isStrip.some((s, i) => s !== nextPlan.isStrip[i]);
      if (patternChanged && !nextPlan.singleColumn) {
        const expanded = nextPlan.expandedColumns;
        if (expanded.length > 0) {
          // Fully minimized would keep the width for restore; otherwise:
          const sum = expanded.reduce((s, c) => s + c.weight, 0);
          nextRW[edge] = Math.max(sum, colsMin(expanded));
        }
      }
      clampRegionWidth(nextRW, edge, nextPlan);
      return;
    }

    // Structural column change: rewrite weights to pixels. Match by shared
    // panel groups (content identity), not node id: a column's root id changes
    // when it's split internally (leaf -> split) even though it still holds
    // the same panel, so id matching would wrongly treat it as new and reset
    // its width. Each prev column matches at most one next column.
    const prevPlan =
      prevTree !== null ? planRegion(prevTree, prev.groups) : null;
    const prevExpanded = prevPlan?.expandedColumns ?? [];
    const prevInfo = prevCols.map((c) => ({
      groups: new Set(collectLeafGroups(c)),
      // Weights ARE pixels once a region has multiple columns (this function
      // wrote them); a single expanded column's px lives in regionWidth
      // instead (its weight may be a height -- see below).
      px:
        prevExpanded.length === 1 && prevExpanded[0] === c
          ? prevRW[edge]
          : c.weight,
      used: false,
    }));
    const intended = nextCols.map((c) => {
      const groupSet = collectLeafGroups(c);
      const match = prevInfo.find(
        (p) => !p.used && groupSet.some((g) => p.groups.has(g)),
      );
      if (match !== undefined) {
        match.used = true;
        // Clamp the carried-over width to THIS column's own min/max: the
        // column's contents may have changed shape across the op (e.g. a lone
        // leaf becoming row-rooted raises its per-panel minimum), so the old
        // pixel width isn't automatically still legal for it.
        return Math.max(match.px, minRegionWidth());
      }
      // New column, previously EMPTY edge: the edge's preserved regionWidth
      // IS this content's width -- e.g. a layout snapshot being restored
      // (Escape after an undock), where the carried width must round-trip
      // exactly rather than reset to the default.
      if (prevCols.length === 0 && nextCols.length === 1) {
        return Math.max(nextRW[edge], minRegionWidth());
      }
      // New column joining existing content: a sensible default, clamped to
      // its panes' min/max.
      return Math.max(DEFAULT_REGION_PX, minRegionWidth());
    });
    // Set the columns' weights to their pixel widths so each renders at
    // `intended` px within the summed region width. ONLY when there are
    // genuinely multiple side-by-side columns -- their weights are then widths
    // (children of a row), safe to rewrite. A single surfaced column is either
    // the root leaf (its weight is irrelevant -- it fills the region) or a
    // lone vertical child of a column root (e.g. column[B, A] -> widthColumns
    // surfaces just [B]); rewriting that would clobber a HEIGHT weight and
    // collapse the stack. In both single-column cases we only need regionWidth.
    if (nextCols.length > 1) {
      nextCols.forEach((c, i) => {
        c.weight = intended[i];
      });
    }
    // regionWidth = the EXPANDED (non-strip, per the render plan) columns'
    // pixels. When the whole region is strips, fall back to the full sum so
    // the preserved total survives until something expands.
    const expandedIdx = nextCols
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => !nextPlan.isStrip[i]);
    const summed = (
      expandedIdx.length > 0
        ? expandedIdx.map(({ i }) => intended[i])
        : intended
    ).reduce((s, w) => s + w, 0);
    const expandedCols = expandedIdx.map(({ c }) => c);
    nextRW[edge] =
      expandedCols.length > 0
        ? Math.max(summed, colsMin(expandedCols))
        : summed;
    clampRegionWidth(nextRW, edge, nextPlan);
  });

  next.regionWidth = nextRW;
}

/** The on-every-commit invariant: an edge's width is never below its expanded
 * columns' summed minimum. Subsumes the old auto-grow effect (which watched
 * for this after the fact) -- with the floor applied here, a too-narrow
 * region is unrepresentable in committed state. */
function clampRegionWidth(
  rw: Record<DockEdge, number>,
  edge: DockEdge,
  plan: RegionPlan,
): void {
  const expanded = plan.expandedColumns;
  if (expanded.length === 0) return; // fully minimized: width kept for restore.
  // Floor the width on EVERY commit so a server set_width can't drive the region
  // below its panes' summed grab-min (interactive resize already clamps; this
  // guards the server-driven path). The floor is the grabbable sliver, not the
  // content min -- a narrower region scrolls its body. There is no max ceiling.
  const min = colsMin(expanded);
  if (rw[edge] < min) rw[edge] = min;
}
