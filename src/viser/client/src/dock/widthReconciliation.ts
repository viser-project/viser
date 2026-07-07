// Region-width reconciliation across layout ops: keeps docked panes at their
// pixel widths when the layout's STRUCTURE changes. Pure except for mutating
// `next` (the caller owns it, a fresh draft): top-column weights may be
// rewritten to pixels, and `next.regionWidth` is always (re)written.
//
// Width model (D40, 2026-07 stability pass): `layout.regionWidth[edge]` is
// the region's RENDERED CONTENT NEED -- what the region reserves, minus the
// inter-column divider chrome. It is maintained here, on every applyOp
// commit, under ONE semantic:
//
//   - The width-determining columns (the widest band's, `widthColumns`)
//     store their pixel widths as tree weights; a RAILED column's weight is
//     ALWAYS its P8 restore width and is never read as rendered width.
//   - Whenever the width row has at least one EXPANDED column, regionWidth
//     IS the sum over the width row of (railed ? 36 : weight) -- enforced on
//     every commit (layout invariant #16), so railing/expanding a column
//     moves the region by exactly (weight - 36) and the restore round-trips.
//   - A FULLY-RAILED width row cannot express the region's content need in
//     its weights: with expanded content in OTHER bands, regionWidth carries
//     that need forward (the rails pack inside it; D3 deltas apply -- a
//     born-railed newcomer adds its rendered 36px, a departing rail removes
//     it). With NO expanded content anywhere the rails ARE the content:
//     regionWidth is 36 x columns (never a phantom panel width).
//   - A SINGLE width column's px lives in regionWidth directly (its weight
//     may be a height share) -- unchanged from the pre-D40 model.
//
// The width lives IN the layout (DockLayout.regionWidth), so it has one
// source of truth: clones carry it through every op, snapshots restore it,
// and this reconciliation -- run on every applyOp commit -- is the only
// writer. Layouts that bypassed the ops (test literals, injected layouts)
// simply lack the field and get defaults here; a wholesale injection
// (api.replace, server-built layouts) ESTABLISHES the semantic from the
// newColumnPx defaults.

import { collectLeafGroups, minRegionWidth, widthColumns, widthRow } from "./layoutOps";
import { planRegion, RegionPlan } from "./regionPlan";
import {
  DEFAULT_REGION_PX,
  DockColumn,
  DockEdge,
  DockLayout,
  DockRegion,
  DockRow,
  MINIMIZED_STRIP_PX,
  regionWidthsOf,
} from "./types";

// regionWidth is the rendered content need with NO dividers -- the
// inter-column dividers are chrome, added on top via the render plan's
// chromePx (see regionPlan.plannedReservedWidth). So the bounds that clamp
// regionWidth must NOT include dividers either, or the divider px would be
// double-counted (once in the floor, once again in chromePx).

/** Sum of `cols`' minimum RENDERED widths (no dividers -- those are chrome),
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
 * region grows by the NEWCOMER's width -- which is the dragged floating
 * window's width whenever the column's groups came from one (every drag-dock
 * path floats first, so `prev.floating` still holds the window across the
 * op). WIDTH CONTRACT (D40): a railed column's WEIGHT is always its P8
 * restore width, so a column born RAILED from a window stores the window's
 * width too -- expanding it later must render the window's width, not a 36px
 * sliver (the strip's fixed 36px is accounted at RENDER time by every
 * aggregator, never stored as a weight). Columns with NO source window
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

/** What a column contributes to the region's RENDERED width: railed columns
 * render at the fixed 36px strip regardless of their stored restore weight
 * (D40), so every aggregation into regionWidth counts them at
 * MINIMIZED_STRIP_PX. */
function renderedGrowthPx(col: DockColumn): number {
  return col.railed === true ? MINIMIZED_STRIP_PX : col.weight;
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

/** Whether any band OTHER than the width row holds an expanded column --
 * the guard for the fully-railed width row: expanded content elsewhere means
 * regionWidth carries that content's need (the rails pack inside it), never
 * the rails' own 36s (e2e: an expanded band is not squished by a railed
 * wider band). */
function expandedOutsideWidthRow(region: DockRegion): boolean {
  const wr = widthRow(region);
  return region.rows.some(
    (row) => row !== wr && row.columns.some((c) => c.railed !== true),
  );
}

/** Reconcile docked region widths across a layout transition, writing the
 * result into `next.regionWidth` (and, for structural changes, into the
 * top columns' weights).
 *
 * - When a region's SET of width-determining columns changes (dock/undock/
 *   merge/unmerge/snap/split), the column weights are rewritten to absolute
 *   pixel widths -- surviving columns keep their previous pixels, new columns
 *   get a default -- and regionWidth becomes the columns' rendered need
 *   (railed at 36, expanded at px; see the module note for the fully-railed
 *   width row).
 * - Pure-internal changes (resize, reorder, collapse toggles, floating moves)
 *   leave the column SET alone; regionWidth is re-derived from the width
 *   row's rendered need whenever that row can express it (so a railed-flag
 *   flip moves the region by exactly weight-36 and D13 zip flag-drops stay
 *   consistent), and carries over otherwise. An op that deliberately wrote
 *   `next.regionWidth` (setRegionWidth) is trusted as the carry-over base --
 *   setRegionWidth keeps the width-row weights on the same basis by
 *   construction.
 * - INVARIANT, enforced on every commit: regionWidth is never below the
 *   columns' summed minimum -- a tiny grabbable sliver per expanded column
 *   (MIN_REGION_GRAB_PX) and the 36px strip per railed one, NOT the
 *   panel-content minimum. A region narrower than its panes' content simply
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
      // Same width columns. A NON-width band can still gain a column (a drop
      // beside a cell of a narrower band). When the width-determining band
      // is fully RAILED, regionWidth is the expanded-content width every
      // other band renders at -- so the newcomer must GROW the region by its
      // own RENDERED width (D3) while the gaining band's surviving columns
      // keep their pixels (the op's scale-invariant 50/50 halving is
      // corrected here, where the newcomer's real width is known). With an
      // EXPANDED widthRow, regionWidth is that band's rendered need and must
      // not drift: the gaining band redistributes internally (a railed
      // neighbor is fixed chrome, so there is slack to give).
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
              // D3: the region grows by the newcomer -- by its RENDERED
              // width (a railed newcomer renders the 36px strip; its weight
              // stays the restore width).
              nextRW[edge] += renderedGrowthPx(c);
            }
          }
        }
      }
      // D40 rendered-need maintenance for the width row itself. Flag flips
      // (setColumnRailed / expand's rail-clear) and D13 zip flag-drops are
      // NON-structural, so this is where their regionWidth bookkeeping
      // lands: whenever a multi-column width row holds an expanded column
      // its rendered need is expressible in the weights -- re-derive it, so
      // railing moves the region by exactly (weight - 36) and expanding
      // restores it. A fully-railed width row keeps the carried content
      // need while ANY other band is expanded (rails pack inside it), and
      // otherwise IS the content: exactly the rails.
      if (nextCols.length > 1 && nextCols.some((c) => c.railed !== true)) {
        // Pinned to the width row's rendered need -- authoritative, no
        // clamp on top (the per-column minimums are the resize ops'
        // business; a floor here would break the exact px identity the
        // D40 invariant asserts).
        nextRW[edge] = renderedRowPx(nextCols);
        return;
      }
      if (
        nextCols.length > 1 &&
        !expandedOutsideWidthRow(nextTree)
      ) {
        nextRW[edge] = nextCols.length * MINIMIZED_STRIP_PX;
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
        railed: c.railed === true,
        fromWidthRow: band === prevWidthBand,
        used: false,
      })),
    );
    let anyMatched = false;
    const isNewcomer: boolean[] = [];
    const intended = nextCols.map((c) => {
      const groupSet = collectLeafGroups(c);
      const match = prevInfo.find(
        (p) => !p.used && groupSet.some((g) => p.groups.has(g)),
      );
      if (match !== undefined) {
        match.used = true;
        anyMatched = true;
        isNewcomer.push(false);
        // Clamp the carried-over width to THIS column's own min: the column's
        // contents may have changed shape across the op, so the old pixel
        // width isn't automatically still legal for it.
        return Math.max(match.px, minRegionWidth());
      }
      isNewcomer.push(true);
      // New column, previously EMPTY edge: the edge's preserved regionWidth
      // IS this content's width -- e.g. a layout snapshot being restored
      // (Escape after an undock), where the carried width must round-trip
      // exactly rather than reset to the default.
      if (prevCols.length === 0 && nextCols.length === 1) {
        return Math.max(nextRW[edge], minRegionWidth());
      }
      // New column joining existing content: the newcomer's own width when
      // it came from a floating window (D3), else the region default --
      // stored as the RESTORE width even when it lands railed (D40).
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
    // regionWidth = the region's rendered content need (D40).
    if (nextCols.length === 1) {
      // Single width column: its px IS the region width.
      nextRW[edge] = Math.max(intended[0], colsMin(nextCols));
    } else if (nextCols.some((c) => c.railed !== true)) {
      // The width row holds expanded content: its rendered need is exact --
      // expanded columns at their px, rails at the 36px strip. Authoritative
      // (no clamp on top): `intended` is already per-column floored, so the
      // sum can't be degenerate, and the D40 invariant asserts the identity.
      nextRW[edge] = renderedRowPx(nextCols, intended);
      return;
    } else if (!expandedOutsideWidthRow(nextTree)) {
      // Fully-railed width row and nothing expanded anywhere: the rails ARE
      // the content (an injected all-railed row must never reserve phantom
      // panel widths -- zones audit W14).
      nextRW[edge] = nextCols.length * MINIMIZED_STRIP_PX;
    } else if (!anyMatched) {
      // Fully-railed width row, expanded content in other bands, and NO
      // surviving content: a wholesale injection (api.replace / server-built
      // layout). There is no carried need to extend, so ESTABLISH it: the
      // expanded bands' need defaults to the region default (single-column
      // bands store no px of their own), floored at the rails' pack width.
      nextRW[edge] = Math.max(
        DEFAULT_REGION_PX,
        nextCols.length * MINIMIZED_STRIP_PX,
      );
    } else {
      // Fully-railed width row beside expanded bands, incremental change:
      // regionWidth carries the expanded content's need; apply the D3
      // deltas for the width row's churn -- a born-railed newcomer adds its
      // rendered 36px strip, and a departing width-row column (floated /
      // undocked, its groups gone from the region) takes its rendered width
      // back out.
      let base = nextRW[edge];
      nextCols.forEach((c, i) => {
        if (isNewcomer[i]) base += MINIMIZED_STRIP_PX;
      });
      const remainingGroups = new Set(
        nextTree.rows.flatMap((row) =>
          row.columns.flatMap((c) => collectLeafGroups(c)),
        ),
      );
      for (const p of prevInfo) {
        if (!p.fromWidthRow || p.used) continue;
        if ([...p.groups].some((g) => remainingGroups.has(g))) continue;
        base -= p.railed ? MINIMIZED_STRIP_PX : p.px;
      }
      nextRW[edge] = Math.max(base, nextCols.length * MINIMIZED_STRIP_PX);
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
  // Floor the width on EVERY commit so a server set_width can't drive the region
  // below its panes' summed grab-min (interactive resize already clamps; this
  // guards the server-driven path). The floor is the grabbable sliver per
  // expanded column (a narrower region scrolls its body) and the fixed 36px
  // strip per railed one. There is no max ceiling.
  const min = colsMin(plan.columns);
  if (rw[edge] < min) rw[edge] = min;
}
