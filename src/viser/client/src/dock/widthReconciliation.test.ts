// Tests for the region-width model (post-D20): layout.regionWidth is the
// width-determining columns' summed pixels -- ALL of them, minimized or not
// (a minimized cell renders as its 26px bar in place at its column's width,
// so collapse never moves region width). The width lives in the layout
// itself (single source of truth), and reconciliation -- run on every commit
// -- must (a) carry widths across structural changes by content identity,
// and (b) leave pure-internal changes (including collapse toggles) alone.

import { describe, expect, it } from "vitest";
import {
  dockToRegionEdge,
  dropOnDockedLeaf,
  toggleCollapsed,
  widthColumns,
} from "./layoutOps";
import {
  DEFAULT_REGION_PX,
  DockEdge,
  DockLayout,
  emptyLayout,
  MIN_REGION_GRAB_PX,
  regionWidthsOf,
} from "./types";
import { reconcileRegionWidths } from "./widthReconciliation";
import { leaf, row, rows, group, toRegion } from "./testUtils";

/** Reconcile and return next's resulting widths (the new single source). */
function recon(prev: DockLayout, next: DockLayout): Record<DockEdge, number> {
  reconcileRegionWidths(prev, next);
  return regionWidthsOf(next);
}

/** Layout with three side-by-side right-docked columns at px weights. */
function threeColumns(widths: [number, number, number]): DockLayout {
  const l = emptyLayout();
  l.groups = { a: group("a"), b: group("b"), c: group("c") };
  l.docked.right = toRegion(
    row([leaf("a", widths[0]), leaf("b", widths[1]), leaf("c", widths[2])]),
  );
  l.regionWidth = { left: 0, right: widths[0] + widths[1] + widths[2] };
  return l;
}

describe("lone minimized column: preserved width survives a sibling docking", () => {
  // Regression: a SINGLE column's px always lives in regionWidth (its weight is
  // never rewritten) -- including while minimized. The structural-change branch
  // used to read the minimized lone column's px from its weight (the bare flex
  // default, 1) and floor it to the grab-min, so dock A at 500 -> minimize ->
  // dock B beside -> expand A came back at 96px instead of 500.
  function loneAt500(): DockLayout {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.docked.right = toRegion(leaf("a"));
    l.regionWidth = { left: 0, right: 500 };
    return l;
  }

  it("carries the preserved px into the column weight when a sibling docks", () => {
    const l = loneAt500();
    const m1 = toggleCollapsed(l, "a"); // minimize the lone column
    expect(recon(l, m1).right).toBe(500); // width kept (bar in place, D20)
    const m2 = dockToRegionEdge(m1, ["b"], "right", "left"); // structural
    reconcileRegionWidths(m1, m2);
    const aCol = widthColumns(m2.docked.right!).find((c) =>
      c.leaves.some((lf) => lf.group === "a"),
    )!;
    expect(aCol.weight).toBe(500); // NOT the 96px grab-min floor
    // BOTH columns count (D20): a's preserved 500 plus B's default width.
    expect(regionWidthsOf(m2).right).toBe(500 + DEFAULT_REGION_PX);
  });

  it("expanding afterwards changes nothing (width was never dropped)", () => {
    const l = loneAt500();
    const m1 = toggleCollapsed(l, "a");
    reconcileRegionWidths(l, m1);
    const m2 = dockToRegionEdge(m1, ["b"], "right", "left");
    reconcileRegionWidths(m1, m2);
    const m3 = toggleCollapsed(m2, "a"); // expand A
    expect(recon(m2, m3).right).toBe(500 + DEFAULT_REGION_PX);
  });
});

describe("widthRow identity flip preserves rendered widths", () => {
  it("a column surviving the flip keeps its rendered px (not the default)", () => {
    // Two 1-column bands: X above Z. The widthRow is X's band (tie -> first);
    // the region renders 500 wide, so Z's band ALSO renders 500. Dropping W
    // beside Z gives Z's band 2 columns -- the widthRow flips to it. Z's
    // rendered width was 500; it must stay 500 (the old widthRow-only match
    // pool treated Z as brand new and reset it to the 300 default).
    const l = emptyLayout();
    l.groups = { x: group("x"), z: group("z"), w: group("w") };
    const zLeaf = leaf("z");
    l.docked.right = toRegion(rows([row([leaf("x")]), row([zLeaf])]));
    l.regionWidth = { left: 0, right: 500 };
    const zNodeId = l.docked.right!.rows[1].columns[0].leaves[0].id;
    const next = dropOnDockedLeaf(l, ["w"], "right", zNodeId, "left");
    reconcileRegionWidths(l, next);
    const cols = widthColumns(next.docked.right!);
    const zCol = cols.find((c) => c.leaves.some((lf) => lf.group === "z"))!;
    const wCol = cols.find((c) => c.leaves.some((lf) => lf.group === "w"))!;
    expect(zCol.weight).toBe(500); // rendered width preserved across the flip
    expect(wCol.weight).toBe(DEFAULT_REGION_PX); // genuinely new content
    expect(regionWidthsOf(next).right).toBe(500 + DEFAULT_REGION_PX);
  });
});

describe("reconcileRegionWidths with minimized columns (D20: collapse never moves width)", () => {
  it("collapse toggle leaves the width alone (bar renders in place)", () => {
    const prev = threeColumns([300, 300, 300]);
    const next = toggleCollapsed(prev, "b");
    expect(recon(prev, next).right).toBe(900);
  });

  it("expand toggle leaves the width alone", () => {
    const prev0 = threeColumns([300, 300, 300]);
    const prev = toggleCollapsed(prev0, "b"); // b minimized
    expect(recon(prev0, prev).right).toBe(900);
    const next = toggleCollapsed(prev, "b"); // b expands again
    expect(recon(prev, next).right).toBe(900);
  });

  it("two of three minimized: still the full sum", () => {
    const prev = threeColumns([300, 280, 320]);
    const mid = toggleCollapsed(prev, "a");
    recon(prev, mid);
    const next = toggleCollapsed(mid, "b");
    expect(recon(mid, next).right).toBe(900);
  });

  it("fully minimized keeps the width too", () => {
    const prev = threeColumns([300, 300, 300]);
    let next = toggleCollapsed(prev, "a");
    next = toggleCollapsed(next, "b");
    next = toggleCollapsed(next, "c");
    expect(recon(prev, next).right).toBe(900);
  });

  it("pure-internal change (same column set) leaves widths alone", () => {
    const prev = threeColumns([300, 300, 300]);
    const next = structuredClone(prev);
    expect(recon(prev, next)).toEqual({ left: 0, right: 900 });
  });

  it("structural change carries every column's px (minimized included)", () => {
    // Start with [a 400, b minimized 250]; undock a -> [b] alone.
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.docked.right = toRegion(row([leaf("a", 400), leaf("b", 250)]));
    l.regionWidth = { left: 0, right: 650 };
    const prev = toggleCollapsed(l, "b");
    expect(recon(l, prev).right).toBe(650);

    // Remove a's column entirely (structural: column set changes).
    const next = structuredClone(prev);
    // Remove a's column: keep only the second column (b).
    const keepRow = next.docked.right!.rows[0];
    next.docked.right = {
      rows: [{ ...keepRow, columns: [keepRow.columns[1]] }],
    };
    // The remaining (minimized) column keeps its preserved px.
    expect(recon(prev, next).right).toBe(250);
  });

  it("restoring a snapshot onto an empty edge keeps the preserved width", () => {
    // regression: Escape after an undock restores the layout snapshot; the
    // re-appearing single column must come back at the edge's preserved
    // width (carried in the layout), not the default.
    const docked = threeColumns([460, 0, 0]);
    docked.docked.right = toRegion(leaf("a", 1)); // single column, weight is NOT px
    docked.groups = { a: group("a") };
    docked.regionWidth = { left: 0, right: 460 };
    const floated = structuredClone(docked);
    floated.docked.right = null; // the column floated away; width preserved.
    expect(recon(docked, floated).right).toBe(460);
    const restored = structuredClone(docked);
    expect(recon(floated, restored).right).toBe(460);
  });
});

describe("reconcileRegionWidths width clamp (no max ceiling)", () => {
  it("preserves a deliberately wide single-column width (no per-panel cap)", () => {
    // There is no fixed max panel width: a server set_width(2000) on a docked
    // column keeps its requested width. (Render-time MIN_CANVAS_PX keeps a canvas
    // sliver visible; the model width itself is uncapped.) Same-set commit -> the
    // clamp runs every commit but only enforces the grab-min floor.
    const prev = emptyLayout();
    prev.groups = { a: group("a") };
    prev.docked.right = toRegion(leaf("a", 1));
    prev.regionWidth = { left: 0, right: 400 };
    const next = structuredClone(prev);
    next.regionWidth = { left: 0, right: 2000 };
    expect(recon(prev, next).right).toBe(2000);
  });

  it("preserves a deliberately wide multi-column width (no colsMax cap)", () => {
    const prev = threeColumns([300, 300, 300]);
    const next = structuredClone(prev);
    next.regionWidth = { left: 0, right: 5000 };
    expect(recon(prev, next).right).toBe(5000);
  });
});

describe("reconcileRegionWidths min-width floor", () => {
  it("raises a too-narrow carried width to the grab minimum (pure-internal)", () => {
    // A carried regionWidth below the layout floor is unrepresentable and must
    // be floored on commit (replaces the old auto-grow effect). Same column set
    // (a single leaf), so this exercises clampRegionWidth directly rather than
    // the structural default-width path. The floor is MIN_REGION_GRAB_PX -- the
    // grabbable sliver -- NOT the panel-content minimum (a narrower region
    // scrolls its body instead).
    const prev = emptyLayout();
    prev.groups = { a: group("a") };
    prev.docked.right = toRegion(leaf("a", 1));
    prev.regionWidth = { left: 0, right: 300 };
    const next = structuredClone(prev);
    next.regionWidth = { left: 0, right: 20 }; // deliberately below the floor.
    expect(recon(prev, next).right).toBe(MIN_REGION_GRAB_PX);
  });

  it("floors a too-narrow multi-column width to the summed grab minimum", () => {
    // Structural change (1 leaf -> 2-column row) carrying a width below the
    // two-column floor: must be raised to 2*grab. NO divider term -- regionWidth
    // is the divider-free expanded sum; the inter-column divider is chrome
    // (added once via chromePx at render), so the floor must not include it too.
    const prev = emptyLayout();
    prev.groups = { a: group("a") };
    prev.docked.right = toRegion(leaf("a", 1));
    prev.regionWidth = { left: 0, right: 10 };
    const next = structuredClone(prev);
    next.groups["b"] = group("b");
    next.docked.right = toRegion(row([leaf("a", 5), leaf("b", 5)]));
    expect(recon(prev, next).right).toBeGreaterThanOrEqual(
      MIN_REGION_GRAB_PX * 2,
    );
  });
});

describe("reconcileRegionWidths across multi-band (widthRow) changes", () => {
  // The width model is driven by the widthRow (the band with the most columns).
  // When THAT band changes -- a wider band inserted, or the widest band removed
  // -- reconciliation must keep the region width finite, positive, and floored;
  // the column SET changing legitimately resets new columns to a default (same
  // as docking a new column), but it must never produce NaN or a collapsed (<=0)
  // width.
  it("a wider band becoming the widthRow yields a finite, floored width", () => {
    const prev = emptyLayout();
    prev.groups = { a: group("a"), b: group("b"), c: group("c") };
    prev.docked.right = toRegion(leaf("a")); // single column, width 250
    prev.regionWidth = { left: 0, right: 250 };
    const next = emptyLayout();
    next.groups = { a: group("a"), b: group("b"), c: group("c") };
    // [a] over [b|c] -- the 2-column band is now the widthRow.
    next.docked.right = toRegion(
      rows([row([leaf("a")]), row([leaf("b"), leaf("c")])]),
    );
    next.regionWidth = { left: 0, right: 250 };
    const w = recon(prev, next).right;
    expect(Number.isFinite(w)).toBe(true);
    expect(w).toBeGreaterThanOrEqual(MIN_REGION_GRAB_PX * 2);
  });

  it("removing the widest band keeps the survivor's width finite & positive", () => {
    const prev = emptyLayout();
    prev.groups = { a: group("a"), b: group("b"), c: group("c") };
    prev.docked.right = toRegion(
      rows([row([leaf("a", 250), leaf("b", 250)]), row([leaf("c")])]),
    );
    prev.regionWidth = { left: 0, right: 500 };
    const next = emptyLayout();
    next.groups = { c: group("c") };
    next.docked.right = toRegion(rows([row([leaf("c")])]));
    next.regionWidth = { left: 0, right: 500 };
    const w = recon(prev, next).right;
    expect(Number.isFinite(w)).toBe(true);
    expect(w).toBeGreaterThanOrEqual(MIN_REGION_GRAB_PX);
  });
});
