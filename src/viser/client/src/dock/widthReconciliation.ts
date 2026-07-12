// Region-width reconciliation across layout ops: keeps docked panes at their
// pixel widths when the layout's structure changes. Pure except for mutating
// `next` (the caller owns it, a fresh draft): top-column weights may be
// rewritten to pixels, and `next.regionWidth` is always (re)written.
//
// Width model (D40): `layout.regionWidth[edge]` is the region's RENDERED
// CONTENT NEED -- what the region reserves, minus the inter-column divider
// chrome. It is maintained here, on every applyOp commit, under one
// semantic:
//
//   - The width-determining columns are all of the region's columns (D46:
//     one horizontal partition). They store their pixel widths as tree
//     weights; a railed column's weight is always its P8 restore width and
//     is never read as rendered width.
//   - Whenever the region has at least one expanded column, regionWidth is
//     the sum over the columns of (railed ? 36 : weight) -- enforced on
//     every commit (layout invariant #12), so railing/expanding a column
//     moves the region by exactly (weight - 36) and the restore round-trips.
//   - A fully railed region's rails are its content: regionWidth is 36 x
//     columns (never a phantom panel width).
//   - A single column's px lives in regionWidth directly: its weight is an
//     unreconciled flex share, and regionWidth stays the lone column's width
//     memory until the planned always-px weights migration retires this
//     carve-out.
//
// The width lives in the layout (DockLayout.regionWidth), so it has one
// source of truth: clones carry it through every op, snapshots restore it,
// and this reconciliation -- run on every applyOp commit -- is the only
// writer. Layouts that bypassed the ops (test literals, injected layouts)
// simply lack the field and get defaults here; a wholesale injection
// (api.replace, server-built layouts) establishes the semantic from the
// newColumnPx defaults.

import { collectLeafGroups, minRegionWidth, widthColumns } from "./layoutOps";
import { planRegion, RegionPlan } from "./regionPlan";
import {
  DEFAULT_REGION_PX,
  DockColumn,
  DockEdge,
  DockLayout,
  MINIMIZED_STRIP_PX,
  regionWidthsOf,
} from "./types";

// regionWidth is the rendered content need with no dividers -- the
// inter-column dividers are chrome, added on top via the render plan's
// chromePx (see regionPlan.plannedReservedWidth). So the bounds that clamp
// regionWidth must not include dividers either, or the divider px would be
// double-counted (once in the floor, once again in chromePx).

/** Sum of `cols`' minimum rendered widths (no dividers -- those are chrome),
 * for clamping regionWidth. A railed column renders the fixed 36px strip, so
 * its floor is the strip, not the grab-min (a pure-rail row must be allowed
 * to reserve exactly its rails, D40). */
function colsMin(cols: DockColumn[]): number {
  return cols.reduce(
    (s, c) => s + (c.railed === true ? MINIMIZED_STRIP_PX : minRegionWidth()),
    0,
  );
}

// There is no upper bound on region width -- a docked region may be dragged as
// wide as the user likes. Only the grab-min floor is enforced (below + in
// clampRegionWidth); the render-time MIN_CANVAS_PX guard keeps a canvas sliver
// visible.

/** Default pixel width for a column newly joining a docked region. D3: the
 * region grows by the newcomer's width -- which is the dragged floating
 * window's width whenever the column's groups came from one (every drag-dock
 * path floats first, so `prev.floating` still holds the window across the
 * op). Width contract (D40): a railed column's weight is always its P8
 * restore width, so a column born railed from a window stores the window's
 * width too -- expanding it later must render the window's width, not a 36px
 * sliver (the strip's fixed 36px is accounted at render time by every
 * aggregator, never stored as a weight). Columns with no source window
 * (injected/server-built layouts) take the region default as their restore
 * width, railed or not. */
function newColumnPx(col: DockColumn, prev: DockLayout): number {
  const groups = new Set(collectLeafGroups(col));
  for (const win of prev.floating) {
    if (win.stack.some((g) => groups.has(g))) {
      return Math.max(win.width, minRegionWidth());
    }
  }
  return Math.max(DEFAULT_REGION_PX, minRegionWidth());
}

/** The width row's rendered need: expanded columns at their pixel weights,
 * railed columns at the 36px strip. Only meaningful when the weights are
 * reconciled pixels (i.e. `px` defaults to the stored weights; the
 * structural path passes its freshly-computed `intended` px instead). */
function renderedRowPx(cols: DockColumn[], px?: number[]): number {
  return cols.reduce(
    (s, c, i) =>
      s + (c.railed === true ? MINIMIZED_STRIP_PX : (px?.[i] ?? c.weight)),
    0,
  );
}

/** Reconcile docked region widths across a layout transition, writing the
 * result into `next.regionWidth` (and, for structural changes, into the
 * top columns' weights).
 *
 * - When a region's set of width-determining columns changes (dock/undock/
 *   merge/unmerge/snap/split), the column weights are rewritten to absolute
 *   pixel widths -- surviving columns keep their previous pixels, new columns
 *   get a default -- and regionWidth becomes the columns' rendered need
 *   (railed at 36, expanded at px; see the module note for the fully-railed
 *   width row).
 * - Pure-internal changes (resize, reorder, collapse toggles, floating moves)
 *   leave the column set alone; regionWidth is re-derived from the width
 *   row's rendered need whenever that row can express it (so a railed-flag
 *   flip moves the region by exactly weight-36), and carries over otherwise.
 *   An op that deliberately wrote `next.regionWidth` (setRegionWidth) is
 *   trusted as the carry-over base -- setRegionWidth keeps the width-row
 *   weights on the same basis by construction.
 * - INVARIANT, enforced on every commit: regionWidth is never below the
 *   columns' summed minimum -- a tiny grabbable sliver per expanded column
 *   (MIN_REGION_GRAB_PX) and the 36px strip per railed one, not the
 *   pane-content minimum. A region narrower than its panes' content simply
 *   scrolls the body; it does not auto-grow. */
export function reconcileRegionWidths(prev: DockLayout, next: DockLayout): void {
  // Carry-over base: the op's own value when it set one (clones inherit
  // prev's, so a differing value is a deliberate write), else prev's.
  const nextRW = regionWidthsOf(next.regionWidth !== undefined ? next : prev);
  const prevRW = regionWidthsOf(prev);

  (["left", "right"] as DockEdge[]).forEach((edge) => {
    const nextTree = next.docked[edge];
    if (nextTree === null) return; // empty edge: keep the width for restore.
    const prevTree = prev.docked[edge];
    // The width-determining columns are all of the region's columns (D46) --
    // plan and reconciler iterate the identical list.
    const prevCols = prevTree ? widthColumns(prevTree) : [];
    const nextPlan = planRegion(nextTree);
    // The plan's columns are widthColumns(nextTree) (same array object), so
    // consuming them keeps this module's per-column indexing aligned with the
    // plan by construction rather than by re-derivation.
    const nextCols = nextPlan.columns;
    const sameSet =
      prevCols.length === nextCols.length &&
      prevCols.every((c, i) => c.id === nextCols[i].id);
    if (sameSet) {
      // Same columns. D40 rendered-need maintenance: flag flips
      // (setColumnRailed / expand's rail-clear) are non-structural, so this
      // is where their regionWidth bookkeeping lands. Whenever a
      // multi-column region holds an expanded column its rendered need is
      // expressible in the weights -- re-derive it, so railing moves the
      // region by exactly (weight - 36) and expanding restores it.
      if (nextCols.length > 1 && nextCols.some((c) => c.railed !== true)) {
        // Pinned to the rendered need -- authoritative, no clamp on top
        // (the per-column minimums are the resize ops' business; a floor
        // here would break the exact px identity invariant #12 asserts).
        nextRW[edge] = renderedRowPx(nextCols);
        return;
      }
      // Fully railed: the rails are the content (D40/D46).
      if (nextCols.length > 1) {
        nextRW[edge] = nextCols.length * MINIMIZED_STRIP_PX;
      }
      clampRegionWidth(nextRW, edge, nextPlan);
      return;
    }

    // Structural column change: rewrite weights to pixels. Match by shared
    // panel groups (content identity), not node id: a column's root id
    // changes when it's split internally (leaf -> split) even though it
    // still holds the same panel, so id matching would wrongly treat it as
    // new and reset its width. Each prev column matches at most one next
    // column.
    // A prev column's carried-over pixel width: weights are pixels once the
    // region has multiple columns (this function wrote them); a single
    // column's px lives in regionWidth instead (its weight is never
    // rewritten).
    const prevPxOf = (c: DockColumn): number =>
      prevCols.length === 1 ? prevRW[edge] : c.weight;
    const prevInfo = (prevTree?.columns ?? []).map((c) => ({
      groups: new Set(collectLeafGroups(c)),
      px: prevPxOf(c),
      railed: c.railed === true,
      used: false,
    }));
    const intended = nextCols.map((c) => {
      const groupSet = collectLeafGroups(c);
      const match = prevInfo.find(
        (p) => !p.used && groupSet.some((g) => p.groups.has(g)),
      );
      if (match !== undefined) {
        match.used = true;
        // Clamp the carried-over width to this column's own min: the column's
        // contents may have changed shape across the op, so the old pixel
        // width isn't automatically still legal for it.
        return Math.max(match.px, minRegionWidth());
      }
      // New column, previously empty edge: the edge's preserved regionWidth
      // is this content's width -- e.g. a layout snapshot being restored
      // (Escape after an undock), where the carried width must round-trip
      // exactly rather than reset to the default.
      if (prevCols.length === 0 && nextCols.length === 1) {
        return Math.max(nextRW[edge], minRegionWidth());
      }
      // New column joining existing content: the newcomer's own width when
      // it came from a floating window (D3), else the region default --
      // stored as the restore width even when it lands railed (D40).
      return newColumnPx(c, prev);
    });
    // Set the columns' weights to their pixel widths so each renders at
    // `intended` px within the summed region width. Only for genuinely
    // side-by-side columns; a lone column's weight is an unreconciled flex
    // share (it fills the region regardless), so only regionWidth is
    // written (the planned always-px migration retires this gate).
    if (nextCols.length > 1) {
      nextCols.forEach((c, i) => {
        c.weight = intended[i];
      });
    }
    // regionWidth = the region's rendered content need (D40).
    if (nextCols.length === 1) {
      // Single width column: its px is the region width.
      nextRW[edge] = Math.max(intended[0], colsMin(nextCols));
    } else if (nextCols.some((c) => c.railed !== true)) {
      // Expanded content present: the rendered need is exact -- expanded
      // columns at their px, rails at the 36px strip. Authoritative (no
      // clamp on top): `intended` is already per-column floored, so the sum
      // can't be degenerate, and the D40 invariant asserts the identity.
      nextRW[edge] = renderedRowPx(nextCols, intended);
      return;
    } else {
      // Fully railed: the rails are the content (D40/D46 -- an injected
      // all-railed region must never reserve phantom panel widths).
      nextRW[edge] = nextCols.length * MINIMIZED_STRIP_PX;
    }
    clampRegionWidth(nextRW, edge, nextPlan);
  });

  next.regionWidth = nextRW;
}

/** The on-every-commit invariant: an edge's width is never below its columns'
 * summed minimum. Subsumes the old auto-grow effect (which watched for this
 * after the fact) -- with the floor applied here, a too-narrow region is
 * unrepresentable in committed state. */
function clampRegionWidth(
  rw: Record<DockEdge, number>,
  edge: DockEdge,
  plan: RegionPlan,
): void {
  // Floor the width on every commit so a server set_width can't drive the region
  // below its panes' summed grab-min (interactive resize already clamps; this
  // guards the server-driven path). The floor is the grabbable sliver per
  // expanded column (a narrower region scrolls its body) and the fixed 36px
  // strip per railed one. There is no max ceiling.
  const min = colsMin(plan.columns);
  if (rw[edge] < min) rw[edge] = min;
}
