// Region-width reconciliation across layout ops: keeps docked panes at their
// pixel widths when the layout's STRUCTURE changes. Pure except for mutating
// `next` (the caller owns it, a fresh draft): top-column weights may be
// rewritten to pixels, and `next.regionWidth` is always (re)written.
//
// Width model (post-D20): a region's width-determining columns store their
// pixel widths as tree weights, and `layout.regionWidth[edge]` is their sum.
// EVERY column participates -- a minimized cell renders as its 26px bar in
// place at its column's width, so collapse states never move region width.
// The explicit region collapse (D21) only overrides the DRAWN width; the
// model widths here are what expand restores.
//
// The width lives IN the layout (DockLayout.regionWidth), so it has one
// source of truth: clones carry it through every op, snapshots restore it,
// and this reconciliation -- run on every applyOp commit -- is the only
// writer. Layouts that bypassed the ops (test literals, injected layouts)
// simply lack the field and get defaults here.

import { collectLeafGroups, minRegionWidth, widthColumns, widthRow } from "./layoutOps";
import { planRegion, RegionPlan } from "./regionPlan";
import {
  DEFAULT_REGION_PX,
  DockColumn,
  DockEdge,
  DockLayout,
  DockRow,
  MINIMIZED_STRIP_PX,
  regionWidthsOf,
} from "./types";

// regionWidth is the columns' summed widths with NO dividers -- the
// inter-column dividers are chrome, added on top via the render plan's
// chromePx (see regionPlan.plannedReservedWidth). So the bounds that clamp
// regionWidth must NOT include dividers either, or the divider px would be
// double-counted (once in the floor, once again in chromePx).

/** Sum of `cols`' minimum widths (no dividers -- those are chrome), for
 * clamping regionWidth. */
function colsMin(cols: DockColumn[]): number {
  return cols.reduce((s) => s + minRegionWidth(), 0);
}

// There is no upper bound on region width -- a docked region may be dragged as
// wide as the user likes. Only the grab-min floor is enforced (below + in
// clampRegionWidth); the render-time MIN_CANVAS_PX guard keeps a canvas sliver
// visible.

/** Default pixel width for a column newly joining a docked region. D3: the
 * region grows by the NEWCOMER's width -- which is the dragged floating
 * window's width whenever the column's groups came from one (every drag-dock
 * path floats first, so `prev.floating` still holds the window across the
 * op). A RAILED landing from a window renders as the fixed 36px strip and
 * contributes exactly that -- a content-width default here reserved a full
 * panel width for a 36px rail (+300px of dead region on the collapsed-drop
 * path). Columns with NO source window (injected/server-built layouts) keep
 * the region default even when born railed: there the weight doubles as the
 * column's only P8 restore width, and regionWidth as the region's content
 * width -- a 36px default would float/expand it as a sliver. */
function newColumnPx(col: DockColumn, prev: DockLayout): number {
  const groups = new Set(collectLeafGroups(col));
  for (const win of prev.floating) {
    if (win.stack.some((g) => groups.has(g))) {
      return col.railed === true
        ? MINIMIZED_STRIP_PX
        : Math.max(win.width, minRegionWidth());
    }
  }
  return Math.max(DEFAULT_REGION_PX, minRegionWidth());
}

/** Reconcile docked region widths across a layout transition, writing the
 * result into `next.regionWidth` (and, for structural changes, into the
 * top columns' weights).
 *
 * - When a region's SET of width-determining columns changes (dock/undock/
 *   merge/unmerge/snap/split), the column weights are rewritten to absolute
 *   pixel widths -- surviving columns keep their previous pixels, new columns
 *   get a default -- and regionWidth becomes the columns' sum.
 * - Pure-internal changes (resize, reorder, collapse toggles, floating moves)
 *   leave the column set alone, so widths carry over untouched. An op that
 *   deliberately wrote `next.regionWidth` (setRegionWidth) is trusted: its
 *   value is the carry-over base.
 * - INVARIANT, enforced on every commit: regionWidth is never below the
 *   columns' summed minimum -- just a tiny grabbable sliver per column
 *   (MIN_REGION_GRAB_PX), NOT the panel-content minimum. A region narrower
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
    // The width-determining columns are simply the widest band's columns --
    // plan and reconciler iterate the identical list.
    const prevCols = prevTree ? widthColumns(prevTree) : [];
    const nextPlan = planRegion(nextTree);
    // The plan's columns ARE widthColumns(nextTree) (same array object), so
    // consuming them keeps this module's per-column indexing aligned with the
    // plan by construction rather than by re-derivation.
    const nextCols = nextPlan.columns;
    const sameSet =
      prevCols.length === nextCols.length &&
      prevCols.every((c, i) => c.id === nextCols[i].id);
    if (sameSet) {
      // Same columns: a collapse toggle no longer moves width (bars render in
      // place at their column's width, D20), so only the floor applies...
      // EXCEPT that a NON-width band can still gain a column (a drop beside
      // a cell of a narrower band). When the width-determining band is
      // fully RAILED, regionWidth is the expanded-content width every other
      // band renders at -- so the newcomer must GROW the region by its own
      // width (D3) while the band's surviving columns keep their pixels
      // (the op's scale-invariant 50/50 halving is corrected here, where
      // the newcomer's real width is known). With an EXPANDED widthRow,
      // regionWidth is that band's px sum and must not drift: the gaining
      // band redistributes internally (a railed neighbor is fixed chrome,
      // so there is slack to give).
      if (
        prevTree !== null &&
        nextCols.every((c) => c.railed === true)
      ) {
        const wr = widthRow(nextTree);
        const prevBandById = new Map(prevTree.rows.map((r) => [r.id, r]));
        for (const band of nextTree.rows) {
          if (band === wr) continue; // the width band itself is `sameSet`.
          const prevBand = prevBandById.get(band.id);
          if (prevBand === undefined) continue;
          const prevColById = new Map(prevBand.columns.map((c) => [c.id, c]));
          if (!band.columns.some((c) => !prevColById.has(c.id))) continue;
          for (const c of band.columns) {
            const p = prevColById.get(c.id);
            if (p !== undefined) {
              c.weight = p.weight; // un-halve: survivors keep their px.
            } else {
              c.weight = newColumnPx(c, prev);
              nextRW[edge] += c.weight; // D3: the region grows by the newcomer.
            }
          }
        }
      }
      clampRegionWidth(nextRW, edge, nextPlan);
      return;
    }

    // Structural column change: rewrite weights to pixels. Match by shared
    // panel groups (content identity), not node id: a column's root id changes
    // when it's split internally (leaf -> split) even though it still holds
    // the same panel, so id matching would wrongly treat it as new and reset
    // its width. Each prev column matches at most one next column. The match
    // pool spans ALL prev bands, not just the prev widthRow: when the
    // width-determining band FLIPS identity (a narrower band gains a column
    // and overtakes), the new widthRow's columns existed in another band --
    // matching only against the old widthRow would treat them as brand new
    // and reset every width to the default.
    const prevWidthBand = prevTree !== null ? widthRow(prevTree) : null;
    // A prev column's carried-over pixel width:
    // - NON-widthRow columns: their weights are plain flex shares, but the
    //   band renders at the full region width, so the RENDERED px is the
    //   share of regionWidth -- the width the column should keep if it
    //   becomes a widthRow column (widthRow-identity flip).
    // - widthRow columns: weights ARE pixels once the row has multiple
    //   columns (this function wrote them); a SINGLE column's px lives in
    //   regionWidth instead (its weight is never rewritten).
    const prevPxOf = (band: DockRow, c: DockColumn): number => {
      if (band !== prevWidthBand) {
        const bandTotal = band.columns.reduce((s, x) => s + x.weight, 0) || 1;
        return prevRW[edge] * (c.weight / bandTotal);
      }
      return prevCols.length === 1 ? prevRW[edge] : c.weight;
    };
    const prevInfo = (prevTree?.rows ?? []).flatMap((band) =>
      band.columns.map((c) => ({
        groups: new Set(collectLeafGroups(c)),
        px: prevPxOf(band, c),
        used: false,
      })),
    );
    const intended = nextCols.map((c) => {
      const groupSet = collectLeafGroups(c);
      const match = prevInfo.find(
        (p) => !p.used && groupSet.some((g) => p.groups.has(g)),
      );
      if (match !== undefined) {
        match.used = true;
        // Clamp the carried-over width to THIS column's own min: the column's
        // contents may have changed shape across the op, so the old pixel
        // width isn't automatically still legal for it.
        return Math.max(match.px, minRegionWidth());
      }
      // New column, previously EMPTY edge: the edge's preserved regionWidth
      // IS this content's width -- e.g. a layout snapshot being restored
      // (Escape after an undock), where the carried width must round-trip
      // exactly rather than reset to the default.
      if (prevCols.length === 0 && nextCols.length === 1) {
        return Math.max(nextRW[edge], minRegionWidth());
      }
      // New column joining existing content: the newcomer's own width when
      // it came from a floating window (D3), 36px when it lands railed,
      // else the region default.
      return newColumnPx(c, prev);
    });
    // Set the columns' weights to their pixel widths so each renders at
    // `intended` px within the summed region width. ONLY when there are
    // genuinely multiple side-by-side columns -- their weights are then widths
    // (children of a row), safe to rewrite. A single surfaced column is either
    // the root leaf (its weight is irrelevant -- it fills the region) or a
    // lone vertical child of a column root; rewriting that would clobber a
    // HEIGHT weight and collapse the stack. In both single-column cases we
    // only need regionWidth.
    if (nextCols.length > 1) {
      nextCols.forEach((c, i) => {
        c.weight = intended[i];
      });
    }
    // regionWidth = the width-determining columns' summed pixels.
    const summed = intended.reduce((s, w) => s + w, 0);
    nextRW[edge] = Math.max(summed, colsMin(nextCols));
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
  // Floor the width on EVERY commit so a server set_width can't drive the region
  // below its panes' summed grab-min (interactive resize already clamps; this
  // guards the server-driven path). The floor is the grabbable sliver, not the
  // content min -- a narrower region scrolls its body. There is no max ceiling.
  const min = colsMin(plan.columns);
  if (rw[edge] < min) rw[edge] = min;
}
