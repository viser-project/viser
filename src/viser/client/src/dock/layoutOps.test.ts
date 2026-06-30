// Exhaustive structural tests for the pure layout ops.
//
// These exercise every dock/undock transition and assert the resulting tree
// shape. The ops use module-scoped `freshId` counters, so we never assert on
// concrete ids -- instead we walk the structure and check shape (dir, child
// counts, weights) and *which groups* end up where. The shared makeLayout /
// shapeOf helpers (testUtils) build layouts and describe tree shape id-free.
//
// Regression pins (from adversarial fuzzing and bug batches, all since FIXED
// in production) live next to the describe of the op they pin, marked with a
// "regression:" comment. The recurring contracts they guard:
//   - Self-targeting drops (snapping a window's whole stack into itself,
//     dropping a group onto its own leaf) are safe no-ops -- the ops re-find
//     the target AFTER detach and abort if it was consumed, so no panel is
//     ever lost or orphaned.
//   - An AREA-backing group is a fixed fixture: detachInPlace is a no-op on
//     it, so the merge/dock/snap ops skip it as a source / in the dragged set
//     (it must never be consumed or referenced from a second place).
//   - Numeric ops (resizeWindow*) do NOT validate inputs (0/negative/NaN
//     accepted) -- callers clamp; this is by contract.

import { describe, it, expect } from "vitest";
import {
  DockEdge,
  DockLayout,
  GroupId,
  MIN_PANEL_WIDTH_PX,
  MIN_REGION_GRAB_PX,
  emptyLayout,
} from "./types";
import {
  leaf,
  row,
  rows,
  col,
  makeLayout,
  shapeOf,
  groupsInTree,
  group,
  refCount,
  floatingWindow,
  toRegion,
} from "./testUtils";
import {
  edgeIsSingleLeaf,
  minRegionWidth,
  findGroupLocation,
  dockToEdge,
  dockToRegionEdge,
  dockBandAtIndex,
  dropOnDockedLeaf,
  insertTabsInto,
  mergeGroupsInto,
  floatGroup,
  tearOutPane,
  moveWindow,
  resizeWindow,
  resizeWindowHeight,
  snapToWindowStack,
  bringToFront,
  reorderTab,
  toggleCollapsed,
  minimizeStack,
  expandStack,
  normalizeStackCollapse,
  stackGroupIdsOf,
  setActiveTab,
  cascadeResize,
  resizeRegionColumns,
  setStackWeights,
  widthColumns,
} from "./layoutOps";

// ---------------------------------------------------------------------------
// Shared regression fixtures (used by the bug pins below).
// ---------------------------------------------------------------------------

/** Left edge holds row [a | b] with fixed node ids S / La / Lb. */
function twoLeafRow(): DockLayout {
  const l = emptyLayout();
  l.groups = { a: group("a"), b: group("b") };
  l.docked.left = {
    rows: [
      {
        id: "r106",
        weight: 1,
        columns: [
      { id: "Sa", weight: 1, leaves: [{ id: "La", group: "a", weight: 1 }] },
      { id: "Sb", weight: 1, leaves: [{ id: "Lb", group: "b", weight: 1 }] },
    ],
      },
    ],
  };
  return l;
}

/** Floating-only layout with explicit per-window stacks and stack weights. */
function floatingLayout(
  windows: { id: string; stack: GroupId[]; stackWeights?: Record<GroupId, number> }[],
): DockLayout {
  const l = emptyLayout();
  l.floating = windows.map(floatingWindow);
  for (const w of windows)
    for (const g of w.stack)
      if (l.groups[g] === undefined)
        l.groups[g] = { id: g, paneIds: [g], activeId: g };
  return l;
}

/** One area (backed by "area-grp" with two panes) plus plain target/source
 * groups, for the area-as-fixture guards. */
function areaSourceLayout(): DockLayout {
  const l = emptyLayout();
  // Backing group for an area, holding two panes.
  l.groups["area-grp"] = {
    id: "area-grp",
    paneIds: ["props", "history"],
    activeId: "props",
  };
  // A plain target group to merge into.
  l.groups["target"] = { id: "target", paneIds: ["scene"], activeId: "scene" };
  // A plain source we DO expect to be consumed.
  l.groups["plain-src"] = {
    id: "plain-src",
    paneIds: ["controls"],
    activeId: "controls",
  };
  l.areas = { "area-1": { id: "area-1", group: "area-grp" } };
  return l;
}

// ===========================================================================
// findGroupLocation
// ===========================================================================

describe("findGroupLocation", () => {
  it("finds a group docked on the left edge", () => {
    const layout = makeLayout({ left: leaf("a") });
    const loc = findGroupLocation(layout, "a");
    expect(loc).toEqual({ kind: "docked", edge: "left", nodeId: expect.any(String) });
  });

  it("finds a group docked on the right edge (nested in a split)", () => {
    const layout = makeLayout({ right: row([leaf("a"), col([leaf("b"), leaf("c")])]) });
    expect(findGroupLocation(layout, "c")).toEqual({
      kind: "docked",
      edge: "right",
      nodeId: expect.any(String),
    });
  });

  it("finds a group inside a floating stack", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a", "b"] }] });
    expect(findGroupLocation(layout, "b")).toEqual({ kind: "floating", windowId: "w1" });
  });

  it("returns null for an unknown group", () => {
    const layout = makeLayout({ left: leaf("a") });
    expect(findGroupLocation(layout, "zzz")).toBeNull();
  });
});

// ===========================================================================
// edgeIsSingleLeaf  (4 sides x leaf / row / column)
// ===========================================================================

describe("edgeIsSingleLeaf", () => {
  /** Build a region from a spec for the helper, which takes a DockRegion now. */
  const reg = (spec: ReturnType<typeof leaf>) => toRegion(spec)!;

  it("a lone leaf (single-column, single-leaf region) is single on all sides", () => {
    const region = reg(leaf("a"));
    for (const s of ["top", "bottom", "left", "right"] as const)
      expect(edgeIsSingleLeaf(region, s)).toBe(true);
  });

  describe("a row of side-by-side columns", () => {
    // [a | b]: top/bottom span both columns (multi-column -> not single);
    // left/right touch a single-leaf edge column -> single.
    const region = reg(row([leaf("a"), leaf("b")]));
    it("top/bottom span multiple columns -> not single", () => {
      expect(edgeIsSingleLeaf(region, "top")).toBe(false);
      expect(edgeIsSingleLeaf(region, "bottom")).toBe(false);
    });
    it("left/right touch a single-leaf edge column -> single", () => {
      expect(edgeIsSingleLeaf(region, "left")).toBe(true);
      expect(edgeIsSingleLeaf(region, "right")).toBe(true);
    });
    it("left/right are not single when the edge column stacks 2+ leaves", () => {
      const n = reg(row([col([leaf("a"), leaf("b")]), leaf("c")]));
      expect(edgeIsSingleLeaf(n, "left")).toBe(false); // left column is a stack
      expect(edgeIsSingleLeaf(n, "right")).toBe(true); // right column is a leaf
    });
  });

  describe("a single column of stacked leaves", () => {
    // [a / b]: one column of 2 stacked leaves. left/right span both leaves -> not
    // single. top/bottom add a full-width ROW BAND spanning the column -- that's
    // distinct from a per-panel split of one of the two leaves, so NOT single
    // either (the 4-level model makes the band a real, non-redundant target).
    const region = reg(col([leaf("a"), leaf("b")]));
    it("left/right span multiple stacked leaves -> not single", () => {
      expect(edgeIsSingleLeaf(region, "left")).toBe(false);
      expect(edgeIsSingleLeaf(region, "right")).toBe(false);
    });
    it("top/bottom band a multi-leaf column -> not single", () => {
      expect(edgeIsSingleLeaf(region, "top")).toBe(false);
      expect(edgeIsSingleLeaf(region, "bottom")).toBe(false);
    });
  });
});

// ===========================================================================
// minRegionWidth  (now per-column; the layout floor is one grabbable sliver)
// ===========================================================================

describe("minRegionWidth", () => {
  // The per-column floor is the grabbable sliver (MIN_REGION_GRAB_PX), NOT the
  // panel-content minimum -- a region narrower than its content scrolls its body
  // rather than refusing to shrink. A column's min is the sliver regardless of
  // its leaf count (leaves stacked in a column share one width); the
  // summing-with-dividers across side-by-side columns lives in widthReconciliation.
  it("a column floors at one grab minimum", () => {
    expect(minRegionWidth()).toBe(MIN_REGION_GRAB_PX);
  });
});

// ===========================================================================
// dockToEdge
// ===========================================================================

describe("dockToEdge", () => {
  it("no-op for an empty group list (returns same reference)", () => {
    const layout = makeLayout({ left: leaf("a") });
    expect(dockToEdge(layout, [], "left")).toBe(layout);
  });

  it("docks a single floating group to an empty left edge as a leaf", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    const out = dockToEdge(layout, ["a"], "left");
    expect(shapeOf(out.docked.left)).toEqual({ leaf: "a" });
    expect(out.floating).toHaveLength(0); // empty window cleaned up
    expect(out).not.toBe(layout); // new object
  });

  it("docks to the far-left (outermost) when the edge already has content", () => {
    const layout = makeLayout({ left: leaf("a"), floating: [{ id: "w1", stack: ["b"] }] });
    const out = dockToEdge(layout, ["b"], "left");
    // New group goes first (outermost on the left), existing second.
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "row",
      children: [{ leaf: "b" }, { leaf: "a" }],
    });
  });

  it("docks to the far-right (outermost) for the right edge", () => {
    const layout = makeLayout({ right: leaf("a"), floating: [{ id: "w1", stack: ["b"] }] });
    const out = dockToEdge(layout, ["b"], "right");
    // Existing first, new group last (outermost on the right).
    expect(shapeOf(out.docked.right)).toEqual({
      dir: "row",
      children: [{ leaf: "a" }, { leaf: "b" }],
    });
  });

  it("docks a multi-group snapped stack as a column subtree, preserving order", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a", "b", "c"] }] });
    const out = dockToEdge(layout, ["a", "b", "c"], "left");
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "column",
      children: [{ leaf: "a" }, { leaf: "b" }, { leaf: "c" }],
    });
    expect(out.floating).toHaveLength(0);
  });

  it("flattens when docking a column subtree next to an existing row", () => {
    // Existing right edge is already a row [a | b]; dock a single group -> stays
    // a flat 3-wide row (normalizeTree merges same-dir nesting).
    const layout = makeLayout({
      right: row([leaf("a"), leaf("b")]),
      floating: [{ id: "w1", stack: ["c"] }],
    });
    const out = dockToEdge(layout, ["c"], "right");
    expect(shapeOf(out.docked.right)).toEqual({
      dir: "row",
      children: [{ leaf: "a" }, { leaf: "b" }, { leaf: "c" }],
    });
  });

  it("detaches from the source edge when re-docking within docked regions", () => {
    const layout = makeLayout({ left: leaf("a"), right: leaf("b") });
    const out = dockToEdge(layout, ["b"], "left");
    expect(out.docked.right).toBeNull(); // source edge emptied
    expect(groupsInTree(out.docked.left).sort()).toEqual(["a", "b"]);
  });
});

// ===========================================================================
// dockToRegionEdge  (all 4 sides; with & without weights)
// ===========================================================================

describe("dockToRegionEdge", () => {
  it("no-op for empty group list", () => {
    const layout = makeLayout({ left: leaf("a") });
    expect(dockToRegionEdge(layout, [], "left", "top")).toBe(layout);
  });

  it("docks into an empty edge as a plain subtree (no wrapping split)", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    const out = dockToRegionEdge(layout, ["a"], "left", "top");
    expect(shapeOf(out.docked.left)).toEqual({ leaf: "a" });
  });

  // Wraps the region in a column (top/bottom) or row (left/right), with the
  // dragged band first for top/left and last for bottom/right.
  it.each([
    ["top", "column", ["b", "a"]],
    ["bottom", "column", ["a", "b"]],
    ["left", "row", ["b", "a"]],
    ["right", "row", ["a", "b"]],
  ] as const)("%s: wraps in a %s with order %j", (side, dir, order) => {
    const layout = makeLayout({ left: leaf("a"), floating: [{ id: "w1", stack: ["b"] }] });
    const out = dockToRegionEdge(layout, ["b"], "left", side);
    expect(shapeOf(out.docked.left)).toEqual({
      dir,
      children: order.map((g) => ({ leaf: g })),
    });
  });

  it("applies explicit weights (existing/dragged) to the wrapping split's children", () => {
    const layout = makeLayout({ left: leaf("a"), floating: [{ id: "w1", stack: ["b"] }] });
    const out = dockToRegionEdge(layout, ["b"], "left", "right", {
      existing: 3,
      dragged: 1,
    });
    expect(shapeOf(out.docked.left, true)).toEqual({
      dir: "row",
      weight: 1,
      children: [
        { leaf: "a", weight: 3 },
        { leaf: "b", weight: 1 },
      ],
    });
  });

  it("weights also apply on the dragged-first side (left)", () => {
    const layout = makeLayout({ left: leaf("a"), floating: [{ id: "w1", stack: ["b"] }] });
    const out = dockToRegionEdge(layout, ["b"], "left", "left", {
      existing: 2,
      dragged: 5,
    });
    expect(shapeOf(out.docked.left, true)).toEqual({
      dir: "row",
      weight: 1,
      children: [
        { leaf: "b", weight: 5 },
        { leaf: "a", weight: 2 },
      ],
    });
  });

  it("docks a multi-group stack as a top ROW BAND, preserving order", () => {
    const layout = makeLayout({
      left: leaf("x"),
      floating: [{ id: "w1", stack: ["a", "b"] }],
    });
    // top adds a full-width row band [a/b] ABOVE the existing x band. The region
    // is now two stacked bands: the [a,b] column on top, x below. (shapeOf reads
    // a multi-band region as an outer {dir:"column"} of bands.)
    const out = dockToRegionEdge(layout, ["a", "b"], "left", "top");
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "column",
      children: [
        { dir: "column", children: [{ leaf: "a" }, { leaf: "b" }] },
        { leaf: "x" },
      ],
    });
  });

  it("keeps the dragged band nested when its axis differs from the wrap (left side)", () => {
    // Dragged stack [a/b] is a column; docking to the *left* wraps in a row, so
    // the column survives as a nested child (no same-axis flattening).
    const layout = makeLayout({
      left: leaf("x"),
      floating: [{ id: "w1", stack: ["a", "b"] }],
    });
    const out = dockToRegionEdge(layout, ["a", "b"], "left", "left");
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "row",
      children: [
        { dir: "column", children: [{ leaf: "a" }, { leaf: "b" }] },
        { leaf: "x" },
      ],
    });
  });
});

// ===========================================================================
// dockBandAtIndex  (insert a full-width band at any row index)
// ===========================================================================

describe("dockBandAtIndex", () => {
  it("no-op for empty group list", () => {
    const layout = makeLayout({ left: leaf("a") });
    expect(dockBandAtIndex(layout, [], "left", 0)).toBe(layout);
  });

  it("docks into an empty edge as the region (index ignored)", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    const out = dockBandAtIndex(layout, ["a"], "left", 5);
    expect(shapeOf(out.docked.left)).toEqual({ leaf: "a" });
  });

  it("index 0 docks a band ABOVE everything", () => {
    const layout = makeLayout({ left: leaf("a"), floating: [{ id: "w1", stack: ["b"] }] });
    const out = dockBandAtIndex(layout, ["b"], "left", 0);
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "column",
      children: [{ leaf: "b" }, { leaf: "a" }],
    });
  });

  it("index rows.length docks a band BELOW everything", () => {
    const layout = makeLayout({ left: leaf("a"), floating: [{ id: "w1", stack: ["b"] }] });
    const out = dockBandAtIndex(layout, ["b"], "left", 1);
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "column",
      children: [{ leaf: "a" }, { leaf: "b" }],
    });
  });

  it("an interior index docks a band BETWEEN two existing bands", () => {
    // Region starts with two stacked bands [a] over [b]; drop c at index 1 ->
    // [a] over [c] over [b]. This is the cross-band-seam affordance.
    const base = makeLayout({
      left: rows([row([leaf("a")]), row([leaf("b")])]),
      floating: [{ id: "wf-c", stack: ["c"] }],
    });
    const out = dockBandAtIndex(base, ["c"], "left", 1);
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "column",
      children: [{ leaf: "a" }, { leaf: "c" }, { leaf: "b" }],
    });
  });

  it("a band is FULL WIDTH even when inserted next to a multi-column band", () => {
    // Top band is two columns [a|b]; drop c as a band below it. c must be a
    // full-width band (one column spanning both), NOT a stack under one column.
    const layout = makeLayout({
      left: row([leaf("a"), leaf("b")]),
      floating: [{ id: "w1", stack: ["c"] }],
    });
    const out = dockBandAtIndex(layout, ["c"], "left", 1);
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "column",
      children: [{ dir: "row", children: [{ leaf: "a" }, { leaf: "b" }] }, { leaf: "c" }],
    });
  });

  it("clamps an out-of-range index to the end", () => {
    const layout = makeLayout({ left: leaf("a"), floating: [{ id: "w1", stack: ["b"] }] });
    const out = dockBandAtIndex(layout, ["b"], "left", 99);
    expect(groupsInTree(out.docked.left)).toEqual(["a", "b"]);
  });

  it("applies explicit weights (existing rescaled, dragged band weighted)", () => {
    const layout = makeLayout({ left: leaf("a"), floating: [{ id: "w1", stack: ["b"] }] });
    const out = dockBandAtIndex(layout, ["b"], "left", 1, { existing: 3, dragged: 1 });
    // Two bands: a (weight 3) over b (weight 1). shapeOf reads bands as a
    // column of rows, each one-column band reading as a weighted leaf.
    expect(shapeOf(out.docked.left, true)).toEqual({
      dir: "column",
      weight: 1,
      children: [
        { leaf: "a", weight: 3 },
        { leaf: "b", weight: 1 },
      ],
    });
  });
});

// ===========================================================================
// dropOnDockedLeaf  (center merge + 4 splits, with weights)
// ===========================================================================

describe("dropOnDockedLeaf", () => {
  /** Helper: find the node id of the leaf holding `group` on the given edge. */
  function leafIdOf(layout: DockLayout, edge: DockEdge, group: GroupId): string {
    const loc = findGroupLocation(layout, group);
    if (loc === null || loc.kind !== "docked") throw new Error("not docked");
    return loc.nodeId;
  }

  it("no-op for empty dragged list", () => {
    const layout = makeLayout({ left: leaf("a") });
    const id = leafIdOf(layout, "left", "a");
    expect(dropOnDockedLeaf(layout, [], "left", id, "center")).toBe(layout);
  });

  it("returns input when the edge is empty", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["b"] }] });
    expect(dropOnDockedLeaf(layout, ["b"], "left", "nope", "left")).toBe(layout);
  });

  it("returns input when the target node id is missing", () => {
    const layout = makeLayout({ left: leaf("a"), floating: [{ id: "w1", stack: ["b"] }] });
    expect(dropOnDockedLeaf(layout, ["b"], "left", "missing", "left")).toBe(layout);
  });

  it("center: merges every dragged panel into the target group's tabs", () => {
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w1", stack: ["b"] }],
      groups: { a: 1, b: 2 },
    });
    const id = leafIdOf(layout, "left", "a");
    const out = dropOnDockedLeaf(layout, ["b"], "left", id, "center");
    expect(shapeOf(out.docked.left)).toEqual({ leaf: "a" });
    expect(out.groups["a"].paneIds).toEqual(["a:0", "b:0", "b:1"]);
    expect(out.groups["b"]).toBeUndefined(); // source group dropped
    expect(out.floating).toHaveLength(0);
  });

  // Side splits: dragged goes before the target for left/top, after for
  // right/bottom; left/right split as a row, top/bottom as a column.
  it.each([
    ["left", "row", ["b", "a"]],
    ["right", "row", ["a", "b"]],
    ["top", "column", ["b", "a"]],
    ["bottom", "column", ["a", "b"]],
  ] as const)("%s split: %s with order %j", (region, dir, order) => {
    const layout = makeLayout({ left: leaf("a"), floating: [{ id: "w1", stack: ["b"] }] });
    const id = leafIdOf(layout, "left", "a");
    const out = dropOnDockedLeaf(layout, ["b"], "left", id, region);
    expect(shapeOf(out.docked.left)).toEqual({
      dir,
      children: order.map((g) => ({ leaf: g })),
    });
  });

  it("the new split inherits the target leaf's weight; children get drag/target weights", () => {
    const layout = makeLayout({
      left: row([leaf("a", 4), leaf("t", 7)]),
      floating: [{ id: "w1", stack: ["b"] }],
    });
    const id = leafIdOf(layout, "left", "t");
    // Drop "b" above "t" -> a column split replacing the "t" leaf, weight 7.
    const out = dropOnDockedLeaf(layout, ["b"], "left", id, "top", {
      dragged: 1,
      target: 3,
    });
    expect(shapeOf(out.docked.left, true)).toEqual({
      dir: "row",
      weight: 1,
      children: [
        { leaf: "a", weight: 4 },
        {
          dir: "column",
          weight: 7, // inherited from the replaced target leaf
          children: [
            { leaf: "b", weight: 1 },
            { leaf: "t", weight: 3 },
          ],
        },
      ],
    });
  });

  it("a same-edge dragged group is detached before the split (no duplication)", () => {
    // Both a and b live on the left; drop b to the right of a.
    const layout = makeLayout({ left: row([leaf("a"), leaf("b")]) });
    const id = leafIdOf(layout, "left", "a");
    const out = dropOnDockedLeaf(layout, ["b"], "left", id, "right");
    // b removed from its old spot, then re-inserted next to a; flattened to a row.
    expect(groupsInTree(out.docked.left).sort()).toEqual(["a", "b"]);
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "row",
      children: [{ leaf: "a" }, { leaf: "b" }],
    });
  });

  it("drops a multi-group stack kept together as a column subtree on a side", () => {
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w1", stack: ["b", "c"] }],
    });
    const id = leafIdOf(layout, "left", "a");
    const out = dropOnDockedLeaf(layout, ["b", "c"], "left", id, "right");
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "row",
      children: [
        { leaf: "a" },
        { dir: "column", children: [{ leaf: "b" }, { leaf: "c" }] },
      ],
    });
  });
});

// Seam equivalence: in a side-by-side region [b | a], inserting a new column on
// the A|B seam must resolve to the SAME order whether the user aims at the RIGHT
// band of the left panel (split right of b) or the LEFT band of the right panel
// (split left of a). Both are the "between b and a" insert -> [b, c, a].
//
// This is the pure-layout counterpart of the e2e
// test_right_of_A_and_left_of_B_are_the_same_seam_insert (dropzones), which
// opened TWO full browser sessions to assert the same equivalence by reading
// rendered column geometry. Here it is deterministic and free.
describe("dropOnDockedLeaf seam equivalence (right-of-left == left-of-right)", () => {
  // Left region holds row [b | a] with fixed leaf ids Lb / La.
  function sideBySide(): DockLayout {
    const l = emptyLayout();
    l.docked.left = {
      rows: [
        {
          id: "r107",
          weight: 1,
          columns: [
        { id: "Sb", weight: 1, leaves: [{ id: "Lb", group: "b", weight: 1 }] },
        { id: "Sa", weight: 1, leaves: [{ id: "La", group: "a", weight: 1 }] },
      ],
        },
      ],
    };
    l.groups = { a: group("a"), b: group("b"), c: group("c") };
    l.floating = [
      { id: "w", x: 0, y: 0, width: 280, height: { mode: "auto" }, stack: ["c"] },
    ];
    return l;
  }

  it("both seam approaches insert c between b and a -> [b, c, a]", () => {
    // Aim at the RIGHT band of the left panel (b): split right of b.
    const rightOfB = dropOnDockedLeaf(sideBySide(), ["c"], "left", "Lb", "right");
    // Aim at the LEFT band of the right panel (a): split left of a.
    const leftOfA = dropOnDockedLeaf(sideBySide(), ["c"], "left", "La", "left");

    const order = (l: DockLayout) => groupsInTree(l.docked.left);
    expect(order(rightOfB)).toEqual(["b", "c", "a"]);
    expect(order(leftOfA)).toEqual(["b", "c", "a"]);
    // The equivalence claim itself: identical left-to-right column order.
    expect(order(rightOfB)).toEqual(order(leftOfA));
    // c lands in the MIDDLE (between the two originals), and no panel is lost.
    expect(order(rightOfB)[1]).toBe("c");
    expect(refCount(rightOfB, "c")).toBe(1);
    expect(rightOfB.floating).toHaveLength(0);
  });
});

// regression: dropOnDockedLeaf with a non-center region, where the dragged set
// includes the target leaf's own group, used to orphan/lose the dragged group
// (was HIGH). FIX: re-find the target leaf AFTER detach; if it's gone (a
// self-drop that collapsed the node), abort -- a safe no-op.
describe("BUG #2 (fixed): dropOnDockedLeaf side-region self-drop no longer loses the group", () => {
  it("dropping a group onto its OWN leaf (side region) in a 2-leaf row is a safe no-op", () => {
    const l = twoLeafRow();
    const out = dropOnDockedLeaf(l, ["a"], "left", "La", "top");

    // FIXED: `a` stays docked, referenced once; the tree is unchanged.
    expect(out).toBe(l); // safe no-op
    expect(refCount(out, "a")).toBe(1);
    expect(findGroupLocation(out, "a")).toEqual({
      kind: "docked",
      edge: "left",
      nodeId: "La",
    });
  });

  it("no loss for any of the four non-center regions", () => {
    for (const region of ["top", "bottom", "left", "right"] as const) {
      const out = dropOnDockedLeaf(twoLeafRow(), ["a"], "left", "La", region);
      expect(refCount(out, "a")).toBe(1); // FIXED: never orphaned
      expect(refCount(out, "b")).toBe(1);
    }
  });

  it("center self-drop is still safe (merges into self = no-op)", () => {
    const out = dropOnDockedLeaf(twoLeafRow(), ["a"], "left", "La", "center");
    expect(refCount(out, "a")).toBe(1);
  });
});

// regression: harmless no-op self-drop onto a sole leaf (LOW/UX, intentionally
// unchanged -- documented, by design).
describe("BUG #3 (by design): self-drop onto a sole docked leaf is a no-op", () => {
  it("returns the input unchanged when the region has a single leaf", () => {
    const l = emptyLayout();
    l.groups = { a: group("a") };
    l.docked.left = {
      rows: [
        {
          id: "r108",
          weight: 1,
          columns: [{ id: "Ca", weight: 1, leaves: [{ id: "La", group: "a", weight: 1 }] }],
        },
      ],
    };
    const out = dropOnDockedLeaf(l, ["a"], "left", "La", "right");
    expect(out).toBe(l); // intentional no-op
    expect(refCount(out, "a")).toBe(1);
  });
});

// ===========================================================================
// insertTabsInto  (incl. index clamping)
// ===========================================================================

describe("insertTabsInto", () => {
  it("inserts source panes at the given index, dropping the source group", () => {
    const layout = makeLayout({
      left: row([leaf("t"), leaf("s")]),
      groups: { t: 2, s: 1 },
    });
    const out = insertTabsInto(layout, "t", ["s"], 1);
    expect(out.groups["t"].paneIds).toEqual(["t:0", "s:0", "t:1"]);
    expect(out.groups["s"]).toBeUndefined();
    // s's leaf removed; left collapses to a single leaf t.
    expect(shapeOf(out.docked.left)).toEqual({ leaf: "t" });
  });

  it.each([
    ["clamps a too-large index to the end", 999, ["t:0", "t:1", "s:0"]],
    ["clamps a negative index to 0", -5, ["s:0", "t:0", "t:1"]],
  ] as const)("%s", (_name, index, expected) => {
    const layout = makeLayout({
      left: row([leaf("t"), leaf("s")]),
      groups: { t: 2, s: 1 },
    });
    const out = insertTabsInto(layout, "t", ["s"], index);
    expect(out.groups["t"].paneIds).toEqual([...expected]);
  });

  it("the last source group's active tab becomes active", () => {
    const layout = makeLayout({
      left: row([leaf("t"), leaf("s")]),
      groups: { t: 1, s: 2 },
    });
    layout.groups["s"].activeId = "s:1";
    const out = insertTabsInto(layout, "t", ["s"], 0);
    expect(out.groups["t"].activeId).toBe("s:1");
  });

  it("ignores a source equal to the target", () => {
    const layout = makeLayout({ left: leaf("t"), groups: { t: 2 } });
    expect(insertTabsInto(layout, "t", ["t"], 0)).toBe(layout); // nothing incoming
  });

  it("repairs a stale activeId carried by the last source", () => {
    const layout = makeLayout({
      left: row([leaf("t"), leaf("s")]),
      groups: { t: 2, s: 1 },
    });
    // Corrupt the source's activeId (e.g. a group emptied by a concurrent op
    // whose activeId was never repaired); the merge must not propagate it.
    layout.groups["s"].activeId = "ghost";
    const out = insertTabsInto(layout, "t", ["s"], 0);
    expect(out.groups["t"].paneIds).toContain(out.groups["t"].activeId);
  });

  it("returns input when the target group is unknown", () => {
    const layout = makeLayout({ left: leaf("t"), groups: { t: 1 } });
    expect(insertTabsInto(layout, "zzz", ["t"], 0)).toBe(layout);
  });

  it("returns input when no source contributes panes", () => {
    const layout = makeLayout({ left: leaf("t"), groups: { t: 1 } });
    expect(insertTabsInto(layout, "t", ["unknown"], 0)).toBe(layout);
  });

  it("merges multiple source groups in order", () => {
    const layout = makeLayout({
      left: col([leaf("t"), leaf("s1"), leaf("s2")]),
      groups: { t: 1, s1: 1, s2: 1 },
    });
    const out = insertTabsInto(layout, "t", ["s1", "s2"], 1);
    expect(out.groups["t"].paneIds).toEqual(["t:0", "s1:0", "s2:0"]);
    expect(out.groups["s1"]).toBeUndefined();
    expect(out.groups["s2"]).toBeUndefined();
  });
});

// regression: insertTabsInto skips an AREA group passed as a SOURCE. An
// area-backing group is a fixed fixture: detachInPlace is a no-op on it, so
// consuming it as a merge source would delete it from layout.groups while
// leaving layout.areas dangling. The guard skips any source that backs an
// area; the area's group (and its panes) must survive untouched.
describe("(6) insertTabsInto guards an area group used as a SOURCE", () => {
  it("skips the area source: it is not consumed and its panes survive", () => {
    const l = areaSourceLayout();
    // Try to merge the AREA group into `target`. The guard must skip it.
    const out = insertTabsInto(l, "target", ["area-grp"], 1);
    // Nothing merged -> insertTabsInto found no incoming panes -> input
    // returned unchanged (same reference).
    expect(out).toBe(l);
    // The area group's backing group and panes are intact.
    expect(out.groups["area-grp"].paneIds).toEqual(["props", "history"]);
    // The area mapping still points at the surviving group.
    expect(out.areas!["area-1"]).toEqual({ id: "area-1", group: "area-grp" });
    // The target was not modified.
    expect(out.groups["target"].paneIds).toEqual(["scene"]);
  });

  it("skips ONLY the area source in a mixed source list; plain sources merge", () => {
    const l = areaSourceLayout();
    // Mixed list: the area group (must be skipped) plus a plain group (consumed).
    const out = insertTabsInto(l, "target", ["area-grp", "plain-src"], 1);
    // The plain source merged in at index 1; the area's panes did NOT.
    expect(out.groups["target"].paneIds).toEqual(["scene", "controls"]);
    expect(out.groups["target"].paneIds).not.toContain("props");
    expect(out.groups["target"].paneIds).not.toContain("history");
    // The plain source was consumed; the area's backing group survives.
    expect(out.groups["plain-src"]).toBeUndefined();
    expect(out.groups["area-grp"].paneIds).toEqual(["props", "history"]);
    expect(out.areas!["area-1"].group).toBe("area-grp");
  });
});

// regression: dock/snap ops skip an AREA group in the dragged set. detachInPlace
// is a no-op on an area-backing group (it's a fixed fixture), so docking/
// snapping one would insert a SECOND reference to it while it stays in its
// area -- a duplicated group rendered in two places. The dock/snap ops filter
// area groups out of the dragged set (and no-op when nothing remains),
// mirroring the insertTabsInto source guard.
describe("(7) dock/snap ops guard an area group in the dragged set", () => {
  function areaDragLayout(): DockLayout {
    const l = areaSourceLayout();
    // A floating window to snap into / drag from.
    l.floating = [
      floatingWindow({ id: "w1", x: 0, y: 0, width: 300, stack: ["plain-src"] }),
      floatingWindow({ id: "w2", x: 350, y: 0, width: 300, stack: ["target"] }),
    ];
    return l;
  }
  it("dockToEdge with only the area group is a no-op", () => {
    const l = areaDragLayout();
    expect(dockToEdge(l, ["area-grp"], "left")).toBe(l);
  });

  it("dockToEdge with a mixed set docks only the plain group", () => {
    const l = areaDragLayout();
    const out = dockToEdge(l, ["area-grp", "plain-src"], "left");
    expect(refCount(out, "area-grp")).toBe(0); // never docked/floated
    expect(refCount(out, "plain-src")).toBe(1); // docked
    expect(out.docked.left).not.toBeNull();
    expect(out.areas!["area-1"].group).toBe("area-grp");
  });

  it("dockToRegionEdge with only the area group is a no-op", () => {
    const l = areaDragLayout();
    expect(dockToRegionEdge(l, ["area-grp"], "left", "top")).toBe(l);
  });

  it("dropOnDockedLeaf with only the area group is a no-op", () => {
    const l = areaDragLayout();
    l.docked.left = {
      rows: [
        {
          id: "r109",
          weight: 1,
          columns: [
        { id: "Cp", weight: 1, leaves: [{ id: "La", group: "plain-src", weight: 1 }] },
      ],
        },
      ],
    };
    l.floating = l.floating.filter((w) => w.id !== "w1");
    expect(dropOnDockedLeaf(l, ["area-grp"], "left", "La", "top")).toBe(l);
  });

  it("snapToWindowStack with only the area group is a no-op", () => {
    const l = areaDragLayout();
    expect(snapToWindowStack(l, ["area-grp"], "w2", 0)).toBe(l);
  });

  it("snapToWindowStack with a mixed set snaps only the plain group", () => {
    const l = areaDragLayout();
    const out = snapToWindowStack(l, ["area-grp", "plain-src"], "w2", 0);
    expect(out.floating.find((w) => w.id === "w2")!.stack).toEqual([
      "plain-src",
      "target",
    ]);
    expect(refCount(out, "area-grp")).toBe(0);
    expect(out.areas!["area-1"].group).toBe("area-grp");
  });
});

// ===========================================================================
// mergeGroupsInto  (== insertTabsInto at the end)
// ===========================================================================

describe("mergeGroupsInto", () => {
  it("appends source panes to the end of the target tab strip", () => {
    const layout = makeLayout({
      left: row([leaf("t"), leaf("s")]),
      groups: { t: 2, s: 2 },
    });
    const out = mergeGroupsInto(layout, "t", ["s"]);
    expect(out.groups["t"].paneIds).toEqual(["t:0", "t:1", "s:0", "s:1"]);
    expect(out.groups["s"]).toBeUndefined();
  });

  it("handles an unknown target gracefully (end index 0 -> no-op return)", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["s"] }] });
    expect(mergeGroupsInto(layout, "zzz", ["s"])).toBe(layout);
  });
});

// ===========================================================================
// floatGroup
// ===========================================================================

describe("floatGroup", () => {
  it("moves a docked group into a new floating window at the given position", () => {
    const layout = makeLayout({ left: leaf("a") });
    const { layout: out, windowId } = floatGroup(layout, "a", 10, 20, 250);
    expect(out.docked.left).toBeNull();
    expect(out.floating).toHaveLength(1);
    const win = out.floating[0];
    expect(win.id).toBe(windowId);
    expect(win).toMatchObject({ x: 10, y: 20, width: 250, stack: ["a"] });
  });

  it("collapses a split when one of its leaves floats out", () => {
    const layout = makeLayout({ left: row([leaf("a"), leaf("b")]) });
    const { layout: out } = floatGroup(layout, "a", 0, 0, 200);
    expect(shapeOf(out.docked.left)).toEqual({ leaf: "b" }); // single-child collapse
  });

  it("floats a group that was already in another floating window (detaches first)", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a", "b"] }] });
    const { layout: out } = floatGroup(layout, "b", 5, 5, 200);
    expect(out.floating).toHaveLength(2);
    expect(out.floating.find((w) => w.id === "w1")!.stack).toEqual(["a"]);
    expect(out.floating[out.floating.length - 1].stack).toEqual(["b"]);
  });

  it("sets win.height when an explicit height is passed", () => {
    const layout = makeLayout({ left: leaf("a") });
    const { layout: out, windowId } = floatGroup(layout, "a", 10, 20, 250, 420);
    const win = out.floating.find((w) => w.id === windowId)!;
    expect(win.height).toEqual({ mode: "pinned", px: 420 });
  });

  it("omits height (auto-size) when no height is passed", () => {
    const layout = makeLayout({ left: leaf("a") });
    const { layout: out, windowId } = floatGroup(layout, "a", 10, 20, 250);
    const win = out.floating.find((w) => w.id === windowId)!;
    // Auto-size (the explicit tagged-union state, not a missing key).
    expect(win.height).toEqual({ mode: "auto" });
  });
});

// ===========================================================================
// tearOutPane  (single-panel floats whole group vs multi-panel splits one out)
// ===========================================================================

describe("tearOutPane", () => {
  it("single-panel group: floats the whole group (no new group created)", () => {
    const layout = makeLayout({ left: leaf("a"), groups: { a: 1 } });
    const res = tearOutPane(layout, "a", "a:0", 1, 2, 200);
    expect(res.floatingGroupId).toBe("a");
    expect(res.layout.docked.left).toBeNull();
    expect(res.layout.floating[0].stack).toEqual(["a"]);
    expect(Object.keys(res.layout.groups)).toEqual(["a"]); // no extra group
  });

  it("multi-panel group: splits the torn panel into a new floating group", () => {
    const layout = makeLayout({ left: leaf("a"), groups: { a: 3 } });
    const res = tearOutPane(layout, "a", "a:1", 7, 8, 240);
    // Source group keeps the other two panes.
    expect(res.layout.groups["a"].paneIds).toEqual(["a:0", "a:2"]);
    // New floating group holds just the torn panel.
    const newGroup = res.layout.groups[res.floatingGroupId!];
    expect(newGroup.paneIds).toEqual(["a:1"]);
    expect(res.floatingGroupId).not.toBe("a");
    const win = res.layout.floating.find((w) => w.id === res.windowId)!;
    expect(win).toMatchObject({ x: 7, y: 8, width: 240, stack: [res.floatingGroupId] });
    // Source stays docked.
    expect(shapeOf(res.layout.docked.left)).toEqual({ leaf: "a" });
  });

  it("tearing out the active panel reassigns active to the first survivor", () => {
    const layout = makeLayout({ left: leaf("a"), groups: { a: 3 } });
    layout.groups["a"].activeId = "a:1";
    const res = tearOutPane(layout, "a", "a:1", 0, 0, 200);
    expect(res.layout.groups["a"].activeId).toBe("a:0");
  });

  it("unknown group falls back to floatGroup semantics", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["x"] }] });
    const res = tearOutPane(layout, "x", "x:0", 0, 0, 200);
    expect(res.floatingGroupId).toBe("x");
  });
});

// ===========================================================================
// snapToWindowStack  (explicit index + append)
// ===========================================================================

describe("snapToWindowStack", () => {
  it("appends when no index is given", () => {
    const layout = makeLayout({
      floating: [
        { id: "w1", stack: ["a"] },
        { id: "w2", stack: ["b"] },
      ],
    });
    const out = snapToWindowStack(layout, ["b"], "w1");
    expect(out.floating.find((w) => w.id === "w1")!.stack).toEqual(["a", "b"]);
    expect(out.floating.find((w) => w.id === "w2")).toBeUndefined(); // emptied window removed
  });

  it("inserts at an explicit index", () => {
    const layout = makeLayout({
      floating: [
        { id: "w1", stack: ["a", "c"] },
        { id: "w2", stack: ["b"] },
      ],
    });
    const out = snapToWindowStack(layout, ["b"], "w1", 1);
    expect(out.floating.find((w) => w.id === "w1")!.stack).toEqual(["a", "b", "c"]);
  });

  it("clamps an out-of-range index", () => {
    const layout = makeLayout({
      floating: [
        { id: "w1", stack: ["a"] },
        { id: "w2", stack: ["b"] },
      ],
    });
    const out = snapToWindowStack(layout, ["b"], "w1", 99);
    expect(out.floating.find((w) => w.id === "w1")!.stack).toEqual(["a", "b"]);
  });

  it("snaps a multi-group stack in as a whole, preserving order", () => {
    const layout = makeLayout({
      floating: [
        { id: "w1", stack: ["a"] },
        { id: "w2", stack: ["b", "c"] },
      ],
    });
    const out = snapToWindowStack(layout, ["b", "c"], "w1", 0);
    expect(out.floating.find((w) => w.id === "w1")!.stack).toEqual(["b", "c", "a"]);
  });

  it("snaps a docked group into a floating stack (detaches from edge)", () => {
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w1", stack: ["b"] }],
    });
    const out = snapToWindowStack(layout, ["a"], "w1");
    expect(out.docked.left).toBeNull();
    expect(out.floating.find((w) => w.id === "w1")!.stack).toEqual(["b", "a"]);
  });

  it("no-op for empty list / unknown target window", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    expect(snapToWindowStack(layout, [], "w1")).toBe(layout);
    expect(snapToWindowStack(layout, ["a"], "nope")).toBe(layout);
  });
});

// ===========================================================================
// snapToWindowStack height preservation. When the dragged (source) window has
// an explicit height and the target auto-sizes, the merged target adopts the
// source's height so a height the user set on the snapped-in panel isn't lost.
// If the target already has its own height, it keeps it.
// ===========================================================================

describe("snapToWindowStack height preservation", () => {
  it("adopts the dragged source's height when the target auto-sizes", () => {
    // Target w1 has no explicit height (auto); the dragged source w2 has 333.
    const layout = makeLayout({
      floating: [
        { id: "w1", stack: ["a"] },
        { id: "w2", stack: ["b"], height: 333 },
      ],
    });
    const out = snapToWindowStack(layout, ["b"], "w1");
    const merged = out.floating.find((w) => w.id === "w1")!;
    expect(merged.stack).toEqual(["a", "b"]);
    // The source height carries over to the merged (previously auto) target.
    expect(merged.height).toEqual({ mode: "pinned", px: 333 });
  });

  it("keeps the target's own height when it already has one", () => {
    // Target w1 already fixed at 200; the dragged source w2 has 333. The target
    // must keep its OWN height (the source's is discarded with its window).
    const layout = makeLayout({
      floating: [
        { id: "w1", stack: ["a"], height: 200 },
        { id: "w2", stack: ["b"], height: 333 },
      ],
    });
    const out = snapToWindowStack(layout, ["b"], "w1");
    const merged = out.floating.find((w) => w.id === "w1")!;
    expect(merged.stack).toEqual(["a", "b"]);
    expect(merged.height).toEqual({ mode: "pinned", px: 200 });
  });

  it("stays auto when neither source nor target has a height", () => {
    const layout = makeLayout({
      floating: [
        { id: "w1", stack: ["a"] },
        { id: "w2", stack: ["b"] },
      ],
    });
    const out = snapToWindowStack(layout, ["b"], "w1");
    const merged = out.floating.find((w) => w.id === "w1")!;
    expect(merged.height).toEqual({ mode: "auto" });
  });
});

// regression: snapToWindowStack of a window's entire stack back into that same
// window used to delete the window and orphan the groups (was HIGH; panes
// lost). FIX: detach first, re-find the target window; if it was consumed,
// abort (return the input unchanged) -- a safe no-op.
describe("BUG #1 (fixed): snapToWindowStack self-target no longer empties the window", () => {
  it("snapping the sole group of a window into that same window is a safe no-op", () => {
    const l = emptyLayout();
    l.groups = { a: group("a") };
    l.floating = [floatingWindow({ id: "w1", x: 10, y: 10, width: 260, stack: ["a"] })];

    const out = snapToWindowStack(l, ["a"], "w1", 0);

    // FIXED: window preserved, `a` still referenced exactly once, no orphan.
    expect(out).toBe(l); // safe no-op: returns the input unchanged
    expect(out.floating).toEqual([
      floatingWindow({ id: "w1", x: 10, y: 10, width: 260, stack: ["a"] }),
    ]);
    expect(refCount(out, "a")).toBe(1);
  });

  it("snapping a window's ENTIRE multi-group stack into itself is a safe no-op", () => {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.floating = [floatingWindow({ id: "w1", x: 0, y: 0, width: 260, stack: ["a", "b"] })];

    const out = snapToWindowStack(l, ["a", "b"], "w1", 0);

    expect(out).toBe(l); // safe no-op
    expect(refCount(out, "a")).toBe(1);
    expect(refCount(out, "b")).toBe(1);
  });

  it("PARTIAL overlap still snaps in correctly (unchanged)", () => {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b"), c: group("c") };
    l.floating = [
      floatingWindow({ id: "w1", x: 0, y: 0, width: 260, stack: ["a", "b"] }),
      floatingWindow({ id: "w2", x: 300, y: 0, width: 260, stack: ["c"] }),
    ];
    const out = snapToWindowStack(l, ["a", "c"], "w1", 0);
    expect(out.floating.map((w) => w.id)).toEqual(["w1"]); // w2 cleaned up
    expect(refCount(out, "a")).toBe(1);
    expect(refCount(out, "c")).toBe(1);
  });
});

// ===========================================================================
// setStackWeights
//
// Merges groupId->weight entries into a floating window's stackWeights, keeping
// any existing entries. Rejects non-finite / non-positive values. A missing
// window is a no-op (returns the input reference).
// ===========================================================================
describe("setStackWeights", () => {
  it("merges groupId->weight into a window's stackWeights (creating the map)", () => {
    const l = floatingLayout([{ id: "w1", stack: ["a", "b"] }]);
    const out = setStackWeights(l, "w1", { a: 2, b: 3 });
    const win = out.floating.find((w) => w.id === "w1")!;
    expect(win.stackWeights).toEqual({ a: 2, b: 3 });
  });

  it("keeps existing entries and overrides only the provided keys", () => {
    const l = floatingLayout([
      { id: "w1", stack: ["a", "b", "c"], stackWeights: { a: 1, b: 1, c: 1 } },
    ]);
    const out = setStackWeights(l, "w1", { b: 5 });
    const win = out.floating.find((w) => w.id === "w1")!;
    // a and c untouched; b replaced.
    expect(win.stackWeights).toEqual({ a: 1, b: 5, c: 1 });
  });

  it("rejects non-finite and non-positive weights (entry is not written)", () => {
    const l = floatingLayout([
      { id: "w1", stack: ["a", "b"], stackWeights: { a: 4 } },
    ]);
    const out = setStackWeights(l, "w1", {
      a: 0, // non-positive -> rejected, existing 4 kept
      b: -3, // non-positive -> rejected, not added
    });
    const win = out.floating.find((w) => w.id === "w1")!;
    expect(win.stackWeights).toEqual({ a: 4 });

    const out2 = setStackWeights(l, "w1", {
      b: Number.POSITIVE_INFINITY,
    });
    expect(out2.floating.find((w) => w.id === "w1")!.stackWeights).toEqual({
      a: 4,
    });

    const out3 = setStackWeights(l, "w1", { b: NaN });
    expect(out3.floating.find((w) => w.id === "w1")!.stackWeights).toEqual({
      a: 4,
    });
  });

  it("is a no-op (same reference) for a missing window", () => {
    const l = floatingLayout([{ id: "w1", stack: ["a"] }]);
    expect(setStackWeights(l, "nope", { a: 2 })).toBe(l);
  });

  it("does not mutate the input layout (pure)", () => {
    const l = floatingLayout([{ id: "w1", stack: ["a"] }]);
    const before = structuredClone(l);
    setStackWeights(l, "w1", { a: 9 });
    expect(l).toEqual(before);
  });
});

// regression: a group leaving a floating window used to leave its key behind
// in the window's stackWeights; a later snap-in of a DIFFERENT group with a
// recycled id (or just inspection of the record) would see the stale weight.
describe("(8) detaching a group prunes its stackWeights entry", () => {
  it("floatGroup out of a weighted stack drops the group's weight key", () => {
    const l = floatingLayout([
      { id: "w1", stack: ["a", "b", "c"], stackWeights: { a: 100, b: 200, c: 50 } },
    ]);
    l.floating[0].height = { mode: "pinned", px: 400 };
    const out = floatGroup(l, "b", 10, 10, 260).layout;
    const w1 = out.floating.find((w) => w.id === "w1")!;
    expect(w1.stack).toEqual(["a", "c"]);
    expect(w1.stackWeights).toEqual({ a: 100, c: 50 }); // b pruned
  });

  it("snapping a group from one stack to another prunes it from the source", () => {
    const l = floatingLayout([
      { id: "w1", stack: ["a", "b"], stackWeights: { a: 100, b: 200 } },
      { id: "w2", stack: ["c"] },
    ]);
    l.floating[0].height = { mode: "pinned", px: 300 };
    const out = snapToWindowStack(l, ["b"], "w2", 0);
    const w1 = out.floating.find((w) => w.id === "w1")!;
    expect(w1.stackWeights).toEqual({ a: 100 });
    expect(out.floating.find((w) => w.id === "w2")!.stack).toEqual(["b", "c"]);
  });
});

// ===========================================================================
// reorderTab  (incl. the no-op returns the SAME reference)
// ===========================================================================

describe("reorderTab", () => {
  it("moves a panel to a new index", () => {
    const layout = makeLayout({ left: leaf("g"), groups: { g: 3 } });
    const out = reorderTab(layout, "g", "g:0", 2);
    expect(out.groups["g"].paneIds).toEqual(["g:1", "g:2", "g:0"]);
  });

  it("clamps the insert index", () => {
    const layout = makeLayout({ left: leaf("g"), groups: { g: 3 } });
    expect(reorderTab(layout, "g", "g:0", 99).groups["g"].paneIds).toEqual([
      "g:1",
      "g:2",
      "g:0",
    ]);
  });

  it("returns the SAME reference when the order would not change", () => {
    const layout = makeLayout({ left: leaf("g"), groups: { g: 3 } });
    // g:0 is already at index 0.
    expect(reorderTab(layout, "g", "g:0", 0)).toBe(layout);
  });

  it("returns input for an unknown group or panel", () => {
    const layout = makeLayout({ left: leaf("g"), groups: { g: 2 } });
    expect(reorderTab(layout, "zzz", "g:0", 0)).toBe(layout);
    expect(reorderTab(layout, "g", "nope", 0)).toBe(layout);
  });

  it("moving from middle to its current position is a no-op (same ref)", () => {
    const layout = makeLayout({ left: leaf("g"), groups: { g: 3 } });
    // g:1 is at index 1; after removing it, inserting at 1 restores the order.
    expect(reorderTab(layout, "g", "g:1", 1)).toBe(layout);
  });
});


// ===========================================================================
// toggleCollapsed
// ===========================================================================

describe("toggleCollapsed", () => {
  it("toggles undefined -> true -> false", () => {
    const layout = makeLayout({ left: leaf("a") });
    const once = toggleCollapsed(layout, "a");
    expect(once.groups["a"].collapsed).toBe(true);
    const twice = toggleCollapsed(once, "a");
    expect(twice.groups["a"].collapsed).toBe(false);
  });

  it("returns input for an unknown group", () => {
    const layout = makeLayout({ left: leaf("a") });
    expect(toggleCollapsed(layout, "zzz")).toBe(layout);
  });

});

// ===========================================================================
// minimizeStack / expandStack (the stack handle's minimize-all button) -- a
// stack is uniform-collapse, so these are simple all/none toggles.
// ===========================================================================

describe("minimizeStack / expandStack", () => {
  const stacked = () =>
    makeLayout({ floating: [{ id: "w1", stack: ["a", "b", "c"] }] });

  it("minimize collapses every group; expand expands every group", () => {
    const min = minimizeStack(stacked(), ["a", "b", "c"]);
    for (const g of ["a", "b", "c"]) expect(min.groups[g].collapsed).toBe(true);
    const max = expandStack(min, ["a", "b", "c"]);
    for (const g of ["a", "b", "c"]) expect(max.groups[g].collapsed).toBe(false);
  });

  it("minimize from a partial state still collapses all", () => {
    const layout = toggleCollapsed(stacked(), "a"); // a minimized, b/c expanded
    const min = minimizeStack(layout, ["a", "b", "c"]);
    for (const g of ["a", "b", "c"]) expect(min.groups[g].collapsed).toBe(true);
  });

  it("no-ops return the input layout unchanged", () => {
    const allExpanded = stacked();
    expect(expandStack(allExpanded, ["a", "b", "c"])).toBe(allExpanded);
    const allMin = minimizeStack(allExpanded, ["a", "b", "c"]);
    expect(minimizeStack(allMin, ["a", "b", "c"])).toBe(allMin);
  });
});

// ===========================================================================
// normalizeStackCollapse: a 2+ stack is uniform; expanded dominates.
// ===========================================================================

describe("normalizeStackCollapse", () => {
  it("a mixed floating stack -> all expanded (expanded dominates)", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a", "b"] }] });
    layout.groups["a"].collapsed = true; // a minimized, b expanded -> mixed
    const changed = normalizeStackCollapse(layout);
    expect(changed).toBe(true);
    expect(layout.groups["a"].collapsed).not.toBe(true);
    expect(layout.groups["b"].collapsed).not.toBe(true);
  });

  it("a uniformly-minimized stack is left alone", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a", "b"] }] });
    layout.groups["a"].collapsed = true;
    layout.groups["b"].collapsed = true;
    expect(normalizeStackCollapse(layout)).toBe(false);
    expect(layout.groups["a"].collapsed).toBe(true);
    expect(layout.groups["b"].collapsed).toBe(true);
  });

  it("a LONE group keeps its own minimized state", () => {
    const layout = makeLayout({ left: leaf("a") });
    layout.groups["a"].collapsed = true;
    expect(normalizeStackCollapse(layout)).toBe(false);
    expect(layout.groups["a"].collapsed).toBe(true);
  });

  it("a mixed docked column -> all expanded", () => {
    const layout = makeLayout({ left: col([leaf("a"), leaf("b")]) });
    layout.groups["a"].collapsed = true; // mixed within the column
    normalizeStackCollapse(layout);
    expect(layout.groups["a"].collapsed).not.toBe(true);
    expect(layout.groups["b"].collapsed).not.toBe(true);
  });
});

// ===========================================================================
// stackGroupIdsOf: a group's stack siblings (or just itself when lone).
// ===========================================================================

describe("stackGroupIdsOf", () => {
  it("a floating multi-stack returns the whole stack", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a", "b"] }] });
    expect(stackGroupIdsOf(layout, "a").sort()).toEqual(["a", "b"]);
  });

  it("a docked column returns its leaf groups", () => {
    const layout = makeLayout({ left: col([leaf("a"), leaf("b")]) });
    expect(stackGroupIdsOf(layout, "b").sort()).toEqual(["a", "b"]);
  });

  it("a lone group returns just itself", () => {
    const layout = makeLayout({ left: leaf("a") });
    expect(stackGroupIdsOf(layout, "a")).toEqual(["a"]);
  });

  it("a lone floating group returns just itself", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    expect(stackGroupIdsOf(layout, "a")).toEqual(["a"]);
  });
});

// ===========================================================================
// setActiveTab
// ===========================================================================

describe("setActiveTab", () => {
  it("activates a member panel", () => {
    const layout = makeLayout({ left: leaf("g"), groups: { g: 3 } });
    const out = setActiveTab(layout, "g", "g:2");
    expect(out.groups["g"].activeId).toBe("g:2");
  });

  it("returns input for a non-member panel", () => {
    const layout = makeLayout({ left: leaf("g"), groups: { g: 2 } });
    expect(setActiveTab(layout, "g", "nope")).toBe(layout);
  });

  it("returns input for an unknown group", () => {
    const layout = makeLayout({ left: leaf("g"), groups: { g: 1 } });
    expect(setActiveTab(layout, "zzz", "g:0")).toBe(layout);
  });
});

// ===========================================================================
// moveWindow / resizeWindow / resizeWindowHeight
// ===========================================================================

describe("moveWindow", () => {
  it("sets position", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"], x: 0, y: 0 }] });
    const out = moveWindow(layout, "w1", 30, 40);
    expect(out.floating[0]).toMatchObject({ x: 30, y: 40 });
  });
  it("returns input for unknown window", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    expect(moveWindow(layout, "zzz", 1, 1)).toBe(layout);
  });
});

describe("resizeWindow", () => {
  it("sets width only when x is omitted", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"], x: 5, width: 100 }] });
    const out = resizeWindow(layout, "w1", 200);
    expect(out.floating[0]).toMatchObject({ width: 200, x: 5 });
  });
  it("sets width and x for a left-edge resize", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"], x: 5, width: 100 }] });
    const out = resizeWindow(layout, "w1", 200, 50);
    expect(out.floating[0]).toMatchObject({ width: 200, x: 50 });
  });
  it("returns input for unknown window", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    expect(resizeWindow(layout, "zzz", 100)).toBe(layout);
  });
  it("floors width at the grab minimum (server set_width(0)/negative)", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"], width: 300 }] });
    expect(resizeWindow(layout, "w1", 0).floating[0].width).toBe(MIN_REGION_GRAB_PX);
    expect(resizeWindow(layout, "w1", -50).floating[0].width).toBe(
      MIN_REGION_GRAB_PX,
    );
  });
});

describe("resizeWindowHeight", () => {
  it("sets explicit height", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    const out = resizeWindowHeight(layout, "w1", 333);
    expect(out.floating[0].height).toEqual({ mode: "pinned", px: 333 });
  });
  it("returns input for unknown window", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    expect(resizeWindowHeight(layout, "zzz", 100)).toBe(layout);
  });
});

// regression / NOTE: input validation gaps (still by contract; callers clamp).
describe("NOTE: numeric ops do not validate their inputs", () => {
  it("resizeWindow accepts a non-finite width verbatim", () => {
    const l = emptyLayout();
    l.groups = { a: group("a") };
    l.floating = [floatingWindow({ id: "w1", x: 0, y: 0, width: 260, stack: ["a"] })];
    const out = resizeWindow(l, "w1", Number.NaN);
    expect(Number.isNaN(out.floating[0].width)).toBe(true); // no validation
  });
});

// ===========================================================================
// cascadeResize -- the pure cascading-divider resize shared by docked splits
// and floating snap-stacks (regression pins for grow/shrink conservation,
// min-floor push-through, collapsed-cell exclusion, no-op guards).
//
// Returns per-cell pixel sizes (collapsed -> 0), conserving the live total, or
// null on a no-op. Grow side: deltaPx>0 grows cell `dividerIndex`, taking from
// later siblings in order (push-through); deltaPx<0 grows `dividerIndex+1`,
// taking from earlier siblings in order. Floors the shrink side at `minCell`.
// ===========================================================================
describe("cascadeResize", () => {
  // Sum the live (non-zero) cells. With no collapsed cells this equals the
  // whole container; with collapsed cells (-> 0) it equals the live remainder.
  const liveTotal = (cells: number[]) => cells.reduce((s, c) => s + c, 0);

  it("grows the drag-side cell and shrinks the next sibling, conserving total", () => {
    // Two equal cells in a 1000px container -> 500/500. Drag the divider right
    // by 100: left grows to 600, right shrinks to 400.
    const next = cascadeResize({
      weights: [1, 1],
      collapsed: [false, false],
      containerPx: 1000,
      dividerIndex: 0,
      deltaPx: 100,
      minCell: MIN_PANEL_WIDTH_PX,
      maxCell: Infinity,
    })!;
    expect(next).not.toBeNull();
    expect(next[0]).toBeCloseTo(600, 5);
    expect(next[1]).toBeCloseTo(400, 5);
    expect(liveTotal(next)).toBeCloseTo(1000, 5);
  });

  it("negative delta grows the cell AFTER the divider, taking from earlier ones", () => {
    const next = cascadeResize({
      weights: [1, 1],
      collapsed: [false, false],
      containerPx: 1000,
      dividerIndex: 0,
      deltaPx: -100,
      minCell: MIN_PANEL_WIDTH_PX,
      maxCell: Infinity,
    })!;
    expect(next[0]).toBeCloseTo(400, 5);
    expect(next[1]).toBeCloseTo(600, 5);
    expect(liveTotal(next)).toBeCloseTo(1000, 5);
  });

  it("floors the shrink side at minCell, then pushes through to the next sibling", () => {
    // Three equal cells in 900px -> 300 each. Drag divider 0 right hard (+1000).
    // Cell 1 can only give down to minCell (220), i.e. 80px; the rest of the
    // demand pushes through to cell 2. Total is conserved.
    const min = MIN_PANEL_WIDTH_PX; // 220
    const next = cascadeResize({
      weights: [1, 1, 1],
      collapsed: [false, false, false],
      containerPx: 900,
      dividerIndex: 0,
      deltaPx: 1000,
      minCell: min,
      maxCell: Infinity,
    })!;
    // Siblings 1 and 2 are floored at minCell; cell 0 absorbs the rest.
    expect(next[1]).toBeCloseTo(min, 5);
    expect(next[2]).toBeCloseTo(min, 5);
    expect(next[0]).toBeCloseTo(900 - 2 * min, 5);
    expect(liveTotal(next)).toBeCloseTo(900, 5);
    // And no cell dipped below the floor.
    expect(Math.min(...next)).toBeGreaterThanOrEqual(min - 1e-6);
  });

  it("excludes collapsed cells: they stay 0 and neither give nor take space", () => {
    // Three cells, the middle one collapsed. Live total comes from cells 0 and 2
    // only (1000 split 500/500); the collapsed cell renders at 0 here. Dragging
    // divider 0 right must shrink cell 2 (the next LIVE sibling), skipping cell 1.
    const next = cascadeResize({
      weights: [1, 1, 1],
      collapsed: [false, true, false],
      containerPx: 1000,
      dividerIndex: 0,
      deltaPx: 100,
      minCell: MIN_PANEL_WIDTH_PX,
      maxCell: Infinity,
    })!;
    expect(next[1]).toBe(0); // collapsed -> 0
    expect(next[0]).toBeCloseTo(600, 5);
    expect(next[2]).toBeCloseTo(400, 5);
    // Live total (excluding the collapsed cell) is conserved.
    expect(liveTotal(next)).toBeCloseTo(1000, 5);
  });

  it("returns null when growing a collapsed cell (drag-side is collapsed)", () => {
    // deltaPx>0 grows dividerIndex (cell 0); it's collapsed -> no-op.
    expect(
      cascadeResize({
        weights: [1, 1],
        collapsed: [true, false],
        containerPx: 1000,
        dividerIndex: 0,
        deltaPx: 100,
        minCell: MIN_PANEL_WIDTH_PX,
        maxCell: Infinity,
      }),
    ).toBeNull();
    // deltaPx<0 grows dividerIndex+1 (cell 1); it's collapsed -> no-op.
    expect(
      cascadeResize({
        weights: [1, 1],
        collapsed: [false, true],
        containerPx: 1000,
        dividerIndex: 0,
        deltaPx: -100,
        minCell: MIN_PANEL_WIDTH_PX,
        maxCell: Infinity,
      }),
    ).toBeNull();
  });

  it("returns null when the container has no width (containerPx <= 0)", () => {
    expect(
      cascadeResize({
        weights: [1, 1],
        collapsed: [false, false],
        containerPx: 0,
        dividerIndex: 0,
        deltaPx: 100,
        minCell: MIN_PANEL_WIDTH_PX,
        maxCell: Infinity,
      }),
    ).toBeNull();
  });

  it("caps the grow side at maxCell (excess demand is dropped)", () => {
    // Two cells 500/500 in 1000px, maxCell 600. Drag right by 300: cell 0 can
    // only reach 600 (its cap), so it takes just 100 from cell 1 (-> 400). The
    // surplus 200 of demand is dropped (the boundary stops at the cap).
    const next = cascadeResize({
      weights: [1, 1],
      collapsed: [false, false],
      containerPx: 1000,
      dividerIndex: 0,
      deltaPx: 300,
      minCell: MIN_PANEL_WIDTH_PX,
      maxCell: 600,
    })!;
    expect(next[0]).toBeCloseTo(600, 5);
    expect(next[1]).toBeCloseTo(400, 5);
  });
});

// ===========================================================================
// resizeRegionColumns -- region-edge resize redistributes across columns.
//
// regression: with [wide][narrow][wide] columns, shrinking used to lock up as
// soon as the narrow column hit its minimum, even though the wide neighbours
// had plenty of room. The redistribution clamps violators and hands the
// difference to columns that still have room.
// ===========================================================================
describe("(9) resizeRegionColumns", () => {
  const M = MIN_PANEL_WIDTH_PX; // 220

  it("scales proportionally when nothing clamps", () => {
    const w = resizeRegionColumns([300, 300], [M, M], [600, 600], 900);
    expect(w[0]).toBeCloseTo(450);
    expect(w[1]).toBeCloseTo(450);
  });

  it("keeps shrinking past one column's minimum (wide-narrow-wide)", () => {
    // 400 + 220 + 400 = 1020; shrink to 900. The narrow middle column is
    // already at its minimum; the wide columns absorb the whole reduction.
    const w = resizeRegionColumns(
      [400, M, 400],
      [M, M, M],
      [600, 600, 600],
      900,
    );
    expect(w[1]).toBeCloseTo(M); // clamped, not below
    expect(w[0]).toBeCloseTo((900 - M) / 2);
    expect(w[2]).toBeCloseTo((900 - M) / 2);
    expect(w[0] + w[1] + w[2]).toBeCloseTo(900);
  });

  it("keeps growing past one column's maximum", () => {
    // Growing: the column at max stays there; others take the surplus.
    const w = resizeRegionColumns(
      [580, 300, 300],
      [M, M, M],
      [600, 600, 600],
      1400,
    );
    expect(w[0]).toBeCloseTo(600); // clamped at max
    expect(w[1] + w[2]).toBeCloseTo(800);
    expect(w[1]).toBeCloseTo(400);
    expect(w[2]).toBeCloseTo(400);
  });

  it("clamps the target to the columns' aggregate bounds", () => {
    const w = resizeRegionColumns([300, 300], [M, M], [600, 600], 100);
    expect(w[0] + w[1]).toBeCloseTo(2 * M);
    const w2 = resizeRegionColumns([300, 300], [M, M], [600, 600], 5000);
    expect(w2[0] + w2[1]).toBeCloseTo(1200);
  });

  it("cascades: redistribution can push a second column to its limit", () => {
    // Shrink hard: middle hits min first, then the small-ish first column
    // also bottoms out; the wide last column absorbs the rest.
    const w = resizeRegionColumns(
      [260, M, 500],
      [M, M, M],
      [600, 600, 600],
      700,
    );
    expect(w[0]).toBeCloseTo(M);
    expect(w[1]).toBeCloseTo(M);
    expect(w[2]).toBeCloseTo(700 - 2 * M);
  });
});

// ===========================================================================
// bringToFront
// ===========================================================================

describe("bringToFront", () => {
  it("moves a window to the end (topmost) of the paint order", () => {
    const layout = makeLayout({
      floating: [
        { id: "w1", stack: ["a"] },
        { id: "w2", stack: ["b"] },
        { id: "w3", stack: ["c"] },
      ],
    });
    const out = bringToFront(layout, "w1");
    expect(out.floating.map((w) => w.id)).toEqual(["w2", "w3", "w1"]);
  });

  it("returns the SAME reference when already topmost", () => {
    const layout = makeLayout({
      floating: [
        { id: "w1", stack: ["a"] },
        { id: "w2", stack: ["b"] },
      ],
    });
    expect(bringToFront(layout, "w2")).toBe(layout);
  });

  it("returns the SAME reference for an unknown window", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    expect(bringToFront(layout, "zzz")).toBe(layout);
  });
});

// ===========================================================================
// Tree normalization invariants (exercised end-to-end through the ops):
//   - same-axis split flattening
//   - single-child split collapse (weight promoted)
//   - cleanup of empty splits/regions
//   - cleanup of empty floating windows on detach
// ===========================================================================

describe("normalization invariants", () => {
  it("flattens same-axis nesting when docking onto a same-axis edge", () => {
    // Right edge already a row; dropping to the right of the rightmost leaf
    // should stay a flat row, not a nested one.
    const layout = makeLayout({
      right: row([leaf("a"), leaf("b")]),
      floating: [{ id: "w1", stack: ["c"] }],
    });
    const loc = findGroupLocation(layout, "b")!;
    const out = dropOnDockedLeaf(
      layout,
      ["c"],
      "right",
      (loc as { nodeId: string }).nodeId,
      "right",
    );
    expect(shapeOf(out.docked.right)).toEqual({
      dir: "row",
      children: [{ leaf: "a" }, { leaf: "b" }, { leaf: "c" }],
    });
  });

  it("drops a column to its sole surviving leaf when one of two leaves leaves", () => {
    // A region [colX | col(a,b)]; float a out -> the second column persists,
    // now holding just b (no nested split level to collapse in the flat model).
    const layout = makeLayout({
      left: row([leaf("x"), col([leaf("a"), leaf("b", 5)])]),
    });
    const { layout: out } = floatGroup(layout, "a", 0, 0, 200);
    // Structure: two side-by-side columns, the second a one-leaf column (b).
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "row",
      children: [{ leaf: "x" }, { leaf: "b" }],
    });
    // b's own leaf weight is preserved through the removal.
    const region = out.docked.left!;
    expect(widthColumns(region)[1].leaves).toEqual([
      { id: expect.any(String), group: "b", weight: 5 },
    ]);
  });

  it("empties the whole region to null when its last group leaves", () => {
    const layout = makeLayout({ left: leaf("a"), floating: [{ id: "w1", stack: ["z"] }] });
    const out = snapToWindowStack(layout, ["a"], "w1");
    expect(out.docked.left).toBeNull();
  });

  it("removes a floating window when its last group is detached", () => {
    const layout = makeLayout({
      left: leaf("dock"),
      floating: [{ id: "w1", stack: ["a"] }],
    });
    const out = dockToEdge(layout, ["a"], "left");
    expect(out.floating).toHaveLength(0);
  });

  it("keeps a floating window when it still has other groups after detach", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a", "b"] }] });
    const out = dockToEdge(layout, ["a"], "left");
    expect(out.floating).toHaveLength(1);
    expect(out.floating[0].stack).toEqual(["b"]);
  });

  it("does not mutate the input layout (immutability)", () => {
    const layout = makeLayout({ left: leaf("a"), floating: [{ id: "w1", stack: ["b"] }] });
    const snapshot = structuredClone(layout);
    dockToEdge(layout, ["b"], "left");
    dropOnDockedLeaf(
      layout,
      ["b"],
      "left",
      widthColumns(layout.docked.left!)[0].leaves[0].id,
      "left",
    );
    expect(layout).toEqual(snapshot);
  });
});

// ===========================================================================
// Unmergeable helpers.
// ===========================================================================
import {
  isPaneUnmergeable,
  isGroupUnmergeable,
  makeGroup,
} from "./layoutOps";
import { PaneRegistry } from "./types";

describe("unmergeable helpers", () => {
  const panes: PaneRegistry = {
    a: { id: "a", title: "A", render: () => null },
    u: { id: "u", title: "U", render: () => null, unmergeable: true },
  };

  it("isPaneUnmergeable reflects the registry flag", () => {
    expect(isPaneUnmergeable(panes, "a")).toBe(false);
    expect(isPaneUnmergeable(panes, "u")).toBe(true);
    expect(isPaneUnmergeable(panes, "missing")).toBe(false);
  });

  it("isGroupUnmergeable is true when any panel in the group is unmergeable", () => {
    const normal = makeGroup(["a"]);
    const special = makeGroup(["u"]);
    const layout: DockLayout = {
      groups: { [normal.id]: normal, [special.id]: special },
      docked: { left: null, right: null },
      floating: [],
    };
    expect(isGroupUnmergeable(layout, panes, normal.id)).toBe(false);
    expect(isGroupUnmergeable(layout, panes, special.id)).toBe(true);
    expect(isGroupUnmergeable(layout, panes, "no-such-group")).toBe(false);
  });
});
