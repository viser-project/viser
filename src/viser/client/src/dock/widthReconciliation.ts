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
// died with the always-px weights migration; migrateLegacyLayout adopts the
// carried regionWidth into the weight for persisted layouts, and the sameSet
// path below heals layouts that bypassed the chokepoint.)
//
// The width lives in the layout (DockLayout.regionWidth), so it has one
// source of truth: clones carry it through every op, snapshots restore it,
// and this reconciliation -- run on every applyOp commit -- is the only
// writer. Layouts that bypassed the ops (test literals, injected layouts)
// simply lack the field and get defaults here; a wholesale injection
// (api.replace, server-built layouts) establishes the semantic from the
// newColumnPx defaults.

import { collectLeafGroups, minRegionWidth, widthColumns } from "./layoutOps";
import { planRegion } from "./regionPlan";
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
      // is where their regionWidth bookkeeping lands. Legacy heal first
      // (one-shot): a lone column committed before the always-px weights
      // migration carries a bare flex share (e.g. 1) while regionWidth holds
      // its px -- adopt the carried width into the weight (the
      // migrateLegacyLayout chokepoint does this for persisted layouts; this
      // covers layouts that bypassed it, e.g. test literals). Any real width
      // clears the grab-min, so a sub-min weight is a reliable flex-share
      // tell.
      if (
        nextCols.length === 1 &&
        nextCols[0].weight < minRegionWidth() &&
        nextRW[edge] > (nextCols[0].railed === true ? MINIMIZED_STRIP_PX : 0)
      ) {
        nextCols[0].weight = Math.max(nextRW[edge], minRegionWidth());
      }
      // Whenever the region holds an expanded column its rendered need is
      // expressible in the weights -- re-derive it, so railing moves the
      // region by exactly (weight - 36) and expanding restores it.
      if (nextCols.some((c) => c.railed !== true)) {
        // Pinned to the rendered need -- authoritative, no clamp on top
        // (the per-column minimums are the resize ops' business; a floor
        // here would break the exact px identity invariant #12 asserts).
        nextRW[edge] = renderedRowPx(nextCols);
        return;
      }
      // Fully railed: the rails are the content (D40/D46) -- any column
      // count. A packed single column reserves its strip like the rest; its
      // restore width stays in the weight.
      nextRW[edge] = nextCols.length * MINIMIZED_STRIP_PX;
      return;
    }

    // Structural column change: rewrite weights to pixels. Match by shared
    // panel groups (content identity), not node id: a column's root id
    // changes when it's split internally (leaf -> split) even though it
    // still holds the same panel, so id matching would wrongly treat it as
    // new and reset its width. Each prev column matches at most one next
    // column.
    // A prev column's carried-over pixel width: weights are always
    // reconciled pixels (this function wrote them, lone columns included).
    // Legacy fallback: a pre-migration lone column's weight is a bare flex
    // share (sub-grab-min) while regionWidth carries its px.
    const prevPxOf = (c: DockColumn): number =>
      prevCols.length === 1 && c.weight < minRegionWidth()
        ? prevRW[edge]
        : c.weight;
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
      // Otherwise (a fresh flex-share column) the edge's preserved
      // regionWidth is this content's width -- the P8 "recreate at the
      // remembered width" round-trip -- as long as that memory is a real
      // content width, not a packed region's 36px strip run (then the
      // newcomer's own window width / the default below is the truth).
      if (
        prevCols.length === 0 &&
        nextCols.length === 1 &&
        nextRW[edge] >= minRegionWidth()
      ) {
        return nextRW[edge];
      }
      // New column joining existing content: the newcomer's own width when
      // it came from a floating window (D3), else the region default --
      // stored as the restore width even when it lands railed (D40).
      return newColumnPx(c, prev);
    });
    // Set the columns' weights to their pixel widths so each renders at
    // `intended` px within the summed region width -- EVERY column, lone
    // ones included (the weight is the one width memory; regionWidth is
    // derived from it below).
    nextCols.forEach((c, i) => {
      c.weight = intended[i];
    });
    // regionWidth = the region's rendered content need (D40).
    if (nextCols.some((c) => c.railed !== true)) {
      // Expanded content present: the rendered need is exact -- expanded
      // columns at their px, rails at the 36px strip. Authoritative (no
      // clamp on top): `intended` is already per-column floored, so the sum
      // can't be degenerate, and the D40 invariant asserts the identity.
      nextRW[edge] = renderedRowPx(nextCols, intended);
    } else {
      // Fully railed: the rails are the content (D40/D46 -- an injected
      // all-railed region must never reserve phantom panel widths), for
      // any column count.
      nextRW[edge] = nextCols.length * MINIMIZED_STRIP_PX;
    }
  });

  next.regionWidth = nextRW;
}
