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
  setColumnRailed,
  setRegionWidth,
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
  SPLIT_DIVIDER_PX,
} from "./types";
import { reconcileRegionWidths } from "./widthReconciliation";
import { planRegion, plannedReservedWidth } from "./regionPlan";
import { MINIMIZED_STRIP_PX } from "./types";
import {
  col,
  floatingWindow,
  group,
  leaf,
  row,
  toRegion,
  TreeSpec,
} from "./testUtils";

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
    // a arrives RAILED (the region rail migrates to its column, D38), so it
    // contributes the rendered 36px strip to regionWidth (D40) while its
    // weight keeps the 500px restore.
    expect(regionWidthsOf(m2).right).toBe(
      MINIMIZED_STRIP_PX + DEFAULT_REGION_PX,
    );
  });

  it("expanding afterwards restores the preserved width (never dropped)", () => {
    const l = loneAt500();
    const m1 = toggleCollapsed(l, "a");
    reconcileRegionWidths(l, m1);
    const m2 = dockToRegionEdge(m1, ["b"], "right", "left");
    reconcileRegionWidths(m1, m2);
    const m3 = toggleCollapsed(m2, "a"); // expand A: 36 -> 500 (P8)
    expect(recon(m2, m3).right).toBe(500 + DEFAULT_REGION_PX);
  });
});

describe("single-column px carries into the weights when the region gains a column", () => {
  it("the surviving stack keeps its rendered px (not the default)", () => {
    // A lone column [x/z] rendering 500 wide (a single column's px lives in
    // regionWidth). Dropping W beside z makes the region 2 columns: the
    // stack's weight becomes its carried 500px (matched by content
    // identity), the newcomer gets the default.
    const l = emptyLayout();
    l.groups = { x: group("x"), z: group("z"), w: group("w") };
    l.docked.right = toRegion(col([leaf("x"), leaf("z")]));
    l.regionWidth = { left: 0, right: 500 };
    const zNodeId = l.docked.right!.columns[0].leaves[1].id;
    const next = dropOnDockedLeaf(l, ["w"], "right", zNodeId, "left");
    reconcileRegionWidths(l, next);
    const cols = widthColumns(next.docked.right!);
    const zCol = cols.find((c) => c.leaves.some((lf) => lf.group === "z"))!;
    const wCol = cols.find((c) => c.leaves.some((lf) => lf.group === "w"))!;
    expect(zCol.weight).toBe(500); // carried px preserved across the change
    expect(wCol.weight).toBe(DEFAULT_REGION_PX); // genuinely new content
    expect(regionWidthsOf(next).right).toBe(500 + DEFAULT_REGION_PX);
  });
});

describe("reconcileRegionWidths with railed columns (D38/D40: rail moves width by weight-36, restore exact)", () => {
  // toggleCollapsed on a docked group in a multi-column region rails its
  // COLUMN (D38): the column renders the fixed 36px strip while its weight
  // keeps the P8 restore px. regionWidth is the rendered content need
  // (D40), so each rail flip moves it by exactly (weight - 36) -- and the
  // expand flip restores the original width bit-for-bit.
  it("railing a column swaps its px for the 36px strip in regionWidth", () => {
    const prev = threeColumns([300, 300, 300]);
    const next = toggleCollapsed(prev, "b");
    expect(recon(prev, next).right).toBe(300 + MINIMIZED_STRIP_PX + 300);
  });

  it("expand toggle restores the full sum (P8 round-trip)", () => {
    const prev0 = threeColumns([300, 300, 300]);
    const prev = toggleCollapsed(prev0, "b"); // b railed
    expect(recon(prev0, prev).right).toBe(636);
    const next = toggleCollapsed(prev, "b"); // b expands again
    expect(recon(prev, next).right).toBe(900);
  });

  it("two of three railed: strips + the expanded survivor", () => {
    const prev = threeColumns([300, 280, 320]);
    const mid = toggleCollapsed(prev, "a");
    expect(recon(prev, mid).right).toBe(MINIMIZED_STRIP_PX + 280 + 320);
    const next = toggleCollapsed(mid, "b");
    expect(recon(mid, next).right).toBe(2 * MINIMIZED_STRIP_PX + 320);
  });

  it("fully railed: exactly the rails (no phantom content width)", () => {
    // Built directly (railRegion / successive chevrons produce it too --
    // D46: setColumnRailed is a bare flag flip, no accordion); the
    // all-railed WIDTH accounting is what's under test.
    const prev = threeColumns([300, 300, 300]);
    const next = structuredClone(prev);
    for (const c of next.docked.right!.columns) c.railed = true;
    expect(recon(prev, next).right).toBe(3 * MINIMIZED_STRIP_PX);
    // ...and expanding them all restores the original 900 (P8).
    let back = toggleCollapsed(next, "a");
    back = toggleCollapsed(back, "b");
    back = toggleCollapsed(back, "c");
    expect(recon(next, back).right).toBe(900);
  });

  it("pure-internal change (same column set) leaves widths alone", () => {
    const prev = threeColumns([300, 300, 300]);
    const next = structuredClone(prev);
    expect(recon(prev, next)).toEqual({ left: 0, right: 900 });
  });

  it("structural change carries every column's px (railed included)", () => {
    // Start with [a 400, b railed 250]; undock a -> [b] alone.
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.docked.right = toRegion(row([leaf("a", 400), leaf("b", 250)]));
    l.regionWidth = { left: 0, right: 650 };
    const prev = toggleCollapsed(l, "b");
    expect(recon(l, prev).right).toBe(400 + MINIMIZED_STRIP_PX);

    // Remove a's column entirely (structural: column set changes).
    const next = structuredClone(prev);
    // Remove a's column: keep only the second column (b).
    next.docked.right = { columns: [next.docked.right!.columns[1]] };
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
    // The deliberate-write path is the setRegionWidth OP (server set_width /
    // region resizer): it lands the width in the expanded width-row weights
    // too (D40: regionWidth IS their rendered sum), so reconciliation keeps
    // the requested width instead of snapping back to the old sum.
    const prev = threeColumns([300, 300, 300]);
    const next = setRegionWidth(prev, "right", 5000);
    expect(recon(prev, next).right).toBe(5000);
    // The weights absorbed it proportionally.
    const weights = widthColumns(next.docked.right!).map((c) => c.weight);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(5000, 6);
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

// ---------------------------------------------------------------------------
// Railed-column width paths (2026-07 rail drop-zone/width fixes, re-based on
// D46's columns-only region): pins for the surviving W-rows -- real ops +
// reconcile, in the same order applyOp runs them. The recurring layout is two
// RAILED columns whose stored weights are P8 restore pixels (150 each), plus
// a 240px floating window being dragged in.
// ---------------------------------------------------------------------------
describe("railed-column width paths (drop beside a rail)", () => {
  const NEW_G = "n";
  const WIN_W = 240;

  function railCol(g: string, weight?: number): TreeSpec {
    const c = col([leaf(g)]);
    if (c.kind === "col") {
      c.column.railed = true;
      if (weight !== undefined) c.column.weight = weight;
    }
    return c;
  }

  function withDraggedWindow(l: DockLayout, collapsed = false): DockLayout {
    l.groups[NEW_G] = group(NEW_G);
    l.floating = [
      floatingWindow({
        id: "wnew",
        stack: [NEW_G],
        x: 500,
        y: 300,
        width: WIN_W,
        collapsed,
      }),
    ];
    return l;
  }

  /** The user's layout: [rail b | rail c] (a packed region). */
  function v1(railWeight = 150, collapsedWindow = false): DockLayout {
    const l = emptyLayout();
    l.groups = { b: group("b"), c: group("c") };
    l.docked.left = toRegion(
      row([railCol("b", railWeight), railCol("c", railWeight)]),
    );
    l.regionWidth = { left: 2 * MINIMIZED_STRIP_PX, right: 300 };
    return withDraggedWindow(l, collapsedWindow);
  }

  const railLeafId = (l: DockLayout, colIdx: number): string =>
    l.docked.left!.columns[colIdx].leaves[0].id;

  it("W1/W2: an expanded 240px window docked beside a rail takes ITS width; the rails' restore px are untouched", () => {
    const prev = v1();
    const next = dropOnDockedLeaf(
      prev,
      [NEW_G],
      "left",
      railLeafId(prev, 1),
      "right",
    );
    reconcileRegionWidths(prev, next);
    const cols = next.docked.left!.columns;
    // Newcomer = the dragged window's width (D3), NOT DEFAULT_REGION_PX;
    // the rails keep their P8 restore pixels.
    expect(cols.map((c) => c.weight)).toEqual([150, 150, WIN_W]);
    expect(cols.map((c) => c.railed === true)).toEqual([true, true, false]);
    // D40: regionWidth is the columns' RENDERED need -- the rails count at
    // their 36px strips (restore px stay in the weights), the expanded
    // newcomer at its window width.
    expect(regionWidthsOf(next).left).toBe(2 * MINIMIZED_STRIP_PX + WIN_W);
  });

  it("W5: a born-railed column STORES the window width (P8 restore) and RENDERS the 36px strip", () => {
    // WIDTH CONTRACT: a railed column's WEIGHT is always its P8 restore
    // width -- the dragged window's width -- while every aggregator
    // accounts it at MINIMIZED_STRIP_PX rendered. (The old rule stored 36
    // as the weight, so expanding the newcomer rendered a 36px sliver.)
    const prev = v1(150, true);
    const next = dropOnDockedLeaf(
      prev,
      [NEW_G],
      "left",
      railLeafId(prev, 1),
      "right",
    );
    reconcileRegionWidths(prev, next);
    const cols = next.docked.left!.columns;
    expect(cols[2].railed).toBe(true);
    expect(cols[2].weight).toBe(WIN_W); // restore width, not 36.
    // Fully railed region: the rails ARE the content (D46 -- the old
    // expanded-band carve-out is gone with the bands themselves), so
    // regionWidth is exactly 3 strips, never a phantom 240.
    expect(regionWidthsOf(next).left).toBe(3 * MINIMIZED_STRIP_PX);
  });

  it("W13 round-trip: dock a 260px collapsed window railed, expand it, get 260px back (region grows)", () => {
    // Drop a 260px COLLAPSED window beside the rails, then click expand on
    // the newcomer. The rail arrives packed (rails-only width); expanding
    // pins regionWidth to the rendered need -- the newcomer renders exactly
    // its 260px restore width, never a 36px sliver.
    const prev = v1(150, true);
    prev.floating[0].width = 260;
    const reservedOf = (l: DockLayout) =>
      plannedReservedWidth(
        planRegion(l.docked.left!),
        regionWidthsOf(l).left,
        false,
      );
    const next = dropOnDockedLeaf(
      prev,
      [NEW_G],
      "left",
      railLeafId(prev, 1),
      "right",
    );
    reconcileRegionWidths(prev, next);
    // After the drop: fully railed -- exactly the rails (D46).
    expect(regionWidthsOf(next).left).toBe(3 * MINIMIZED_STRIP_PX);
    const newCol = next.docked.left!.columns[2];
    expect(newCol.railed).toBe(true);
    expect(newCol.weight).toBe(260);
    // The user expands the newcomer (rail cell +): a pure flag clear.
    const expanded = setColumnRailed(next, "left", newCol.id, false);
    reconcileRegionWidths(next, expanded);
    const cols = expanded.docked.left!.columns;
    // Restore width intact -- the survivors' too.
    expect(cols.map((c) => c.weight)).toEqual([150, 150, 260]);
    expect(cols.map((c) => c.railed === true)).toEqual([true, true, false]);
    // regionWidth pinned to the rendered need (invariant #16): two 36px
    // rails + the 260px restore -- the region grows by (restore - 36).
    expect(regionWidthsOf(expanded).left).toBe(2 * MINIMIZED_STRIP_PX + 260);
    const reservedExpanded = reservedOf(expanded);
    expect(reservedExpanded).toBe(
      260 + 2 * MINIMIZED_STRIP_PX + 2 * SPLIT_DIVIDER_PX,
    );
    // The rendered share of the expanded column is exactly its restore px:
    // reserved - rails - chrome = 260.
    expect(
      reservedExpanded - 2 * MINIMIZED_STRIP_PX - 2 * SPLIT_DIVIDER_PX,
    ).toBe(260);
  });

  it("W14: an injected all-railed region without source windows keeps DEFAULT restore px and packs to its rails", () => {
    // The injection path (api.apply / server-built layouts): [railB | railC],
    // no regionWidth field, prev empty. The rails' weights take the region
    // DEFAULT as their P8 restore width (no source window to read; a 36px
    // default would expand to a sliver). regionWidth is ESTABLISHED as the
    // rails' pack width -- never the 600px sum of phantom restore widths.
    const prev = emptyLayout();
    const next = emptyLayout();
    next.groups = { b: group("b"), c: group("c") };
    const railB = col([leaf("b")]);
    const railC = col([leaf("c")]);
    if (railB.kind === "col") railB.column.railed = true;
    if (railC.kind === "col") railC.column.railed = true;
    next.docked.left = toRegion(row([railB, railC]));
    delete next.regionWidth;
    reconcileRegionWidths(prev, next);
    const cols = next.docked.left!.columns;
    expect(cols.map((c) => c.weight)).toEqual([
      DEFAULT_REGION_PX,
      DEFAULT_REGION_PX,
    ]);
    expect(regionWidthsOf(next).left).toBe(2 * MINIMIZED_STRIP_PX);
    // Rendered: the rails plus their divider chrome.
    const reserved = plannedReservedWidth(
      planRegion(next.docked.left!),
      regionWidthsOf(next).left,
      false,
    );
    expect(reserved).toBe(2 * MINIMIZED_STRIP_PX + SPLIT_DIVIDER_PX);
  });

  it("W9: docking beside a lone expanded panel grows the region by the newcomer; the target is not halved", () => {
    const prev = emptyLayout();
    prev.groups = { a: group("a") };
    prev.docked.left = toRegion(leaf("a"));
    prev.regionWidth = { left: 300, right: 300 };
    withDraggedWindow(prev);
    const aLeaf = prev.docked.left!.columns[0].leaves[0].id;
    const next = dropOnDockedLeaf(prev, [NEW_G], "left", aLeaf, "right");
    reconcileRegionWidths(prev, next);
    const cols = next.docked.left!.columns;
    // Panel a keeps its 300px (the op's 50/50 halving is corrected by the
    // content-identity carry); the newcomer takes its window width and the
    // region GROWS by it (D3).
    expect(cols.map((c) => c.weight)).toEqual([300, WIN_W]);
    expect(regionWidthsOf(next).left).toBe(540);
  });

  it("W11: born-railed rails (weight 1): the newcomer still takes the window width; rails floor at the grab-min", () => {
    const prev = v1(1);
    const next = dropOnDockedLeaf(
      prev,
      [NEW_G],
      "left",
      railLeafId(prev, 1),
      "right",
    );
    reconcileRegionWidths(prev, next);
    const cols = next.docked.left!.columns;
    expect(cols.map((c) => c.weight)).toEqual([
      MIN_REGION_GRAB_PX,
      MIN_REGION_GRAB_PX,
      WIN_W,
    ]);
    // Rendered need: the rails count at their 36px strips (their restore
    // weights only floor at the grab-min), the newcomer at its window width.
    expect(regionWidthsOf(next).left).toBe(2 * MINIMIZED_STRIP_PX + WIN_W);
  });

  it("W12: a side drop on a RAILED target never halves the rail's P8 restore px", () => {
    // [a expanded 150 | rail c 150]: dropping beside the rail must not run
    // the 50/50 split against the rail's stored restore width (that would
    // permanently corrupt what it re-expands to).
    const prev = emptyLayout();
    prev.groups = { a: group("a"), c: group("c") };
    prev.docked.left = toRegion(row([leaf("a", 150), railCol("c", 150)]));
    prev.regionWidth = { left: 150 + MINIMIZED_STRIP_PX, right: 300 };
    withDraggedWindow(prev);
    const next = dropOnDockedLeaf(
      prev,
      [NEW_G],
      "left",
      railLeafId(prev, 1),
      "right",
    );
    reconcileRegionWidths(prev, next);
    const cols = next.docked.left!.columns;
    const cCol = cols.find((c) => c.leaves.some((lf) => lf.group === "c"))!;
    expect(cCol.railed).toBe(true);
    expect(cCol.weight).toBe(150); // was corrupted to 75.
    // a untouched; the newcomer takes its window width; regionWidth is the
    // rendered need of all three.
    expect(cols.map((c) => c.weight)).toEqual([150, 150, WIN_W]);
    expect(regionWidthsOf(next).left).toBe(
      150 + MINIMIZED_STRIP_PX + WIN_W,
    );
  });
});
