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
//     one horizontal partition). EVERY column -- lone ones included --
//     stores its pixel width as its tree weight; a railed column's weight
//     is always its P8 restore width and is never read as rendered width.
//   - Whenever the region has at least one expanded column, regionWidth is
//     the sum over the columns of (railed ? 36 : weight) -- enforced on
//     every commit (layout invariant #12), so railing/expanding a column
//     moves the region by exactly (weight - 36) and the restore round-trips.
//   - A fully railed region's rails are its content: regionWidth is 36 x
//     columns (never a phantom panel width) -- for ANY column count. A
//     packed single column reserves its 36px strip like the rest; its
//     restore width lives in the weight (D40), not in regionWidth.
//
// (Historical note: lone columns used to be the one carve-out -- their weight
// stayed an unreconciled flex share while regionWidth carried the px. That
// died with the always-px weights change; the new-column carry below adopts a
// carried regionWidth into the weight on the first commit, and the sameSet
// path heals layouts that bypassed the chokepoint.)
//
// The width lives in the layout (DockLayout.regionWidth), so it has one
// source of truth: clones carry it through every op, snapshots restore it,
// and this reconciliation -- run on every applyOp commit -- is the only
// writer. Layouts that bypassed the ops (test literals, injected layouts)
// simply lack the field and get defaults here; a wholesale injection
// (api.replace, server-built layouts) establishes the semantic from the source-window/
// default widths in `intended`.

import { collectLeafGroups, minRegionWidth } from "./layoutOps";
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
// chromePx (see regionPlan.plannedReservedWidth). There is no upper bound on
// region width -- a docked region may be dragged as wide as the user likes.
// The grab-min floor is enforced per COLUMN at the weight-writing sites
// (`intended` below, the resize ops, setRegionWidth), so regionWidth -- the
// weights' sum -- can never be driven below the columns' summed minimum; the
// render-time MIN_CANVAS_PX guard keeps a canvas sliver visible.

/** The dragged source window's width for a column whose groups came from one
 * (min-floored), or null when the column has no source window. This is D3's
 * newcomer width: the region grows by the dragged floating window's width
 * (every drag-dock path floats first, so `prev.floating` still holds the
 * window across the op). Width contract (D40): a railed column's weight is
 * always its P8 restore width, so a column born railed from a window stores
 * the window's width too -- expanding it later must render the window's
 * width, not a 36px sliver. Columns with NO source window (injected/
 * server-built layouts) take the region default as their restore width,
 * railed or not -- the caller's fallback. */
function sourceWindowPx(col: DockColumn, prev: DockLayout): number | null {
  const groups = new Set(collectLeafGroups(col));
  for (const win of prev.floating) {
    if (win.stack.some((g) => groups.has(g))) {
      return Math.max(win.width, minRegionWidth());
    }
  }
  return null;
}

/** The width row's rendered need: expanded columns at their pixel weights,
 * railed columns at the 36px strip. Only meaningful when the weights are
 * reconciled pixels (i.e. `px` defaults to the stored weights; the
 * structural path passes its freshly-computed `intended` px instead). */
function renderedRowPx(cols: DockColumn[]): number {
  return cols.reduce(
    (s, c) => s + (c.railed === true ? MINIMIZED_STRIP_PX : c.weight),
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
 *   flip moves the region by exactly weight-36). An op that wrote
 *   `next.regionWidth` (setRegionWidth) keeps the width-row weights on the
 *   same basis by construction, so the re-derivation preserves its write.
 * - INVARIANT, enforced on every commit: regionWidth is never below the
 *   columns' summed minimum -- a tiny grabbable sliver per expanded column
 *   (MIN_REGION_GRAB_PX) and the 36px strip per railed one, not the
 *   pane-content minimum. This holds because every weight-writing site
 *   floors per column (a region narrower than its panes' content simply
 *   scrolls the body; it does not auto-grow). */
export function reconcileRegionWidths(
  prev: DockLayout,
  next: DockLayout,
): void {
  // Carry-over base: the op's own value when it set one (clones inherit
  // prev's, so a differing value is a deliberate write), else prev's.
  const nextRW = regionWidthsOf(next.regionWidth !== undefined ? next : prev);

  (["left", "right"] as DockEdge[]).forEach((edge) => {
    const nextTree = next.docked[edge];
    if (nextTree === null) return; // empty edge: keep the width for restore.
    const prevTree = prev.docked[edge];
    // The width-determining columns are all of the region's columns (D46) --
    // plan and reconciler iterate the identical list.
    const prevCols = prevTree ? prevTree.columns : [];
    // nextCols aliases the tree's own columns array, so it stays aligned
    // with the tree by construction.
    const nextCols = nextTree.columns;
    // plan by construction rather than by re-derivation.
    const sameSet =
      prevCols.length === nextCols.length &&
      prevCols.every((c, i) => c.id === nextCols[i].id);
    if (sameSet) {
      // Same columns. D40 rendered-need maintenance: flag flips
      // (setColumnRailed / expand's rail-clear) are non-structural, so this
      // is where their regionWidth bookkeeping lands. Weights are always
      // reconciled px (every consumer-visible layout has passed this
      // function -- the mount chokepoint reconciles too), so the rendered
      // need is a pure re-derivation for any column count: railing moves
      // the region by exactly (weight - 36) and expanding restores it. No
      // clamp on top -- the per-column minimums are the resize ops'
      // business; a floor here would break the exact px identity that
      // invariant #12 asserts.
      nextRW[edge] = renderedRowPx(nextCols);
      return;
    }

    // Structural column change: rewrite weights to pixels. Matching runs in
    // two passes. Pass 1 matches by SURVIVING COLUMN ID: a column that
    // persists across the op keeps its own px, so a new column inserted
    // before it in the array cannot steal its width via a shared group (the
    // greedy group scan alone is insertion-order dependent -- the stationary
    // column would reset to the default while the mover inherited its px).
    // Pass 2 matches the remainder by shared panel groups (content
    // identity): a column whose root id changed across the op (split
    // internally, rebuilt by detach/insert) still holds the same panel and
    // must keep its width. Each prev column matches at most one next column.
    // A prev column's carried-over pixel width: weights are always
    // reconciled pixels (this function wrote them, lone columns included;
    // the mount chokepoint reconciles, so no pre-reconcile layout is ever
    // consumer-visible).
    const prevPxOf = (c: DockColumn): number => c.weight;
    const prevInfo = (prevTree?.columns ?? []).map((c) => ({
      id: c.id,
      groups: new Set(collectLeafGroups(c)),
      px: prevPxOf(c),
      used: false,
    }));
    const idMatches = nextCols.map((c) => {
      const byId = prevInfo.find((p) => !p.used && p.id === c.id);
      if (byId !== undefined) byId.used = true;
      return byId;
    });
    const intended = nextCols.map((c, i) => {
      let match = idMatches[i];
      if (match === undefined) {
        const groupSet = collectLeafGroups(c);
        match = prevInfo.find(
          (p) => !p.used && groupSet.some((g) => p.groups.has(g)),
        );
        if (match !== undefined) match.used = true;
      }
      if (match !== undefined) {
        // Clamp the carried-over width to this column's own min: the column's
        // contents may have changed shape across the op, so the old pixel
        // width isn't automatically still legal for it.
        return Math.max(match.px, minRegionWidth());
      }
      // New column, previously empty edge. Its own weight wins when it is a
      // reconciled px (a layout snapshot being restored -- Escape after an
      // undock -- or a wholesale injection carrying committed widths): the
      // carried width must round-trip exactly rather than reset to the
      // default. This is also the packed-single restore path: the
      // snapshot's regionWidth is just the 36px strip, but the column's
      // weight kept the restore width (D40).
      if (prevCols.length === 0 && c.weight >= minRegionWidth()) {
        return c.weight;
      }
      // A newcomer with a SOURCE WINDOW brings its own width (D3: "the
      // newcomer's width IS the dragged window's width" -- every drag-dock
      // path floats first), empty edge included. Checked BEFORE the edge's
      // preserved regionWidth: a never-docked edge carries a synthesized
      // 300px default (regionWidthsOf materializes it on every commit),
      // indistinguishable from a real memory -- so preferring the memory
      // made docking a resized float onto an empty edge silently reset it
      // to 300. The P8 "recreate at the remembered width" round-trip
      // (edge case 7) still holds through the window itself: undocking
      // floats the panel at its measured docked width, so the re-dock's
      // window width IS the remembered width unless the user deliberately
      // resized the float in between -- then the newer intent wins.
      const fromWindow = sourceWindowPx(c, prev);
      if (fromWindow !== null) return fromWindow;
      // No source window (server-built / injected): the edge's preserved
      // regionWidth is this content's width -- the P8 "recreate at the
      // remembered width" round-trip -- as long as that memory is a real
      // content width, not a packed region's 36px strip run (then the
      // default below is the truth).
      if (
        prevCols.length === 0 &&
        nextCols.length === 1 &&
        nextRW[edge] >= minRegionWidth()
      ) {
        return nextRW[edge];
      }
      // New column joining existing content, no source window (checked
      // above): the region default -- stored as the restore width even when
      // it lands railed (D40). The source-window scan already ran
      // above and returned null.
      return Math.max(DEFAULT_REGION_PX, minRegionWidth());
    });
    // Set the columns' weights to their pixel widths so each renders at
    // `intended` px within the summed region width -- EVERY column, lone
    // ones included (the weight is the one width memory; regionWidth is
    // derived from it below).
    nextCols.forEach((c, i) => {
      c.weight = intended[i];
    });
    // regionWidth = the region's rendered content need (D40): expanded
    // columns at their (just-written, per-column-floored) px, rails at the
    // 36px strip -- one rule for any column count and any collapse state
    // (a fully railed region sums to exactly 36 x N). Authoritative, no
    // clamp on top; the D40 invariant asserts the identity.
    nextRW[edge] = renderedRowPx(nextCols);
  });

  next.regionWidth = nextRW;
}
