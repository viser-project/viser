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
import { invariantViolations } from "./layoutInvariants";
import {
  DockEdge,
  DockLayout,
  GroupId,
  MIN_PANEL_WIDTH_PX,
  MIN_REGION_GRAB_PX,
  PaneId,
  emptyLayout,
  isRegionPackedOn,
} from "./types";
import {
  leaf,
  row,
  col,
  columnIdOf,
  makeLayout,
  shapeOf,
  groupsInTree,
  group,
  refCount,
  floatingWindow,
  toRegion,
} from "./testUtils";
import {
  isSoleFloatingGroup,
  edgeIsSingleLeaf,
  minRegionWidth,
  findGroupLocation,
  dockToEdge,
  dockToRegionEdge,
  insertColumnAt,
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
  expandGroup,
  railRegion,
  setColumnRailed,
  isGroupEffectivelyCollapsed,
  isRailedDockedCell,
  collectLeafGroups,
  floatRegion,
  removePane,
  minimizeStack,
  expandStack,
  expandStackOf,
  stackGroupIdsOf,
  setActiveTab,
  cascadeResize,
  resizeRegionColumns,
  setStackWeights,
} from "./layoutOps";

// ===========================================================================
// railRegion (D21/D44): the region chevron rails every column; the packed
// rail is DERIVED (isRegionPackedOn).
// ===========================================================================

describe("railRegion (D21/D44)", () => {
  it("rails every column", () => {
    const ca = col([leaf("a")]);
    const layout = makeLayout({ left: row([ca, leaf("b")]) });
    const withRail = setColumnRailed(layout, "left", columnIdOf(ca), true);
    const collapsed = railRegion(withRail, "left");
    // Every column railed IS the packed region (D46: derived, no region
    // store -- side-by-side 36px strips).
    expect(isRegionPackedOn(collapsed, "left")).toBe(true);
    for (const c of collapsed.docked.left!.columns) expect(c.railed).toBe(true);
  });

  it("a single-column stack rails to the PACKED form (derived)", () => {
    const layout = makeLayout({ left: col([leaf("a"), leaf("b")]) });
    const collapsed = railRegion(layout, "left");
    expect(isRegionPackedOn(collapsed, "left")).toBe(true);
    expect(collapsed.docked.left!.columns[0].railed).toBe(true);
  });

  it("collapsing an EMPTY edge is a no-op (nothing to rail)", () => {
    const layout = makeLayout({ left: leaf("a") });
    expect(railRegion(layout, "right")).toBe(layout);
  });

  it("no-ops when the flag already matches", () => {
    const layout = makeLayout({ left: leaf("a") });
    const collapsed = railRegion(layout, "left");
    expect(railRegion(collapsed, "left")).toBe(collapsed);
  });

  it("expandGroup from a packed rail is GRANULAR: just that column (D46)", () => {
    // User-adjudicated: a spine-row expand reveals ITS column; the other
    // railed columns stay railed (the packed strip un-packs around them).
    const layout = makeLayout({ left: row([leaf("a"), leaf("b")]) });
    const collapsed = railRegion(layout, "left");
    const out = expandGroup(collapsed, "a");
    expect(isRegionPackedOn(out, "left")).toBe(false);
    expect(out.docked.left!.columns[0].railed).toBeUndefined();
    expect(out.docked.left!.columns[1].railed).toBe(true);
    // Idempotent: nothing left to clear for this group -> same reference.
    expect(expandGroup(out, "a")).toBe(out);
  });

  it("toggleCollapsed on a sole docked panel rails its COLUMN (the packed region, D46)", () => {
    // The ONE docked collapse store is the column's railed flag; a sole
    // docked panel's railed column IS the packed region (derived).
    const layout = makeLayout({ left: leaf("a") });
    const collapsed = railRegion(layout, "left");
    const out = toggleCollapsed(collapsed, "a"); // expand -> clears the column flag
    expect(isRegionPackedOn(out, "left")).toBe(false);
    expect(out.docked.left!.columns[0].railed).toBeUndefined();
    const minimized = toggleCollapsed(out, "a"); // minimize -> rails the column
    expect(minimized.docked.left!.columns[0].railed).toBe(true);
    expect(isRegionPackedOn(minimized, "left")).toBe(true);
  });

  it("floatRegion clears the flag and births a COLLAPSED window (identity)", () => {
    const layout = makeLayout({ left: col([leaf("a"), leaf("b")]) });
    const collapsed = railRegion(layout, "left");
    const res = floatRegion(collapsed, "left", 10, 10, 300);
    expect(res.windowId).not.toBeNull();
    expect(res.layout.docked.left).toBeNull();
    expect(isRegionPackedOn(res.layout, "left")).toBe(false);
    // The state MOVED to the window store (D38: transfers are identity).
    expect(res.layout.floating[0].collapsed).toBe(true);
  });

  it("floatRegion of an EXPANDED region births an expanded window", () => {
    const layout = makeLayout({ left: col([leaf("a"), leaf("b")]) });
    const res = floatRegion(layout, "left", 10, 10, 300);
    expect(res.layout.floating[0].collapsed).not.toBe(true);
  });
});

// ===========================================================================
// setColumnRailed (per-column rail): a column collapsed to a 36px spine in
// place, with its width weight preserved. Expands clear it. D46: a bare flag
// flip -- no accordion, no region-store conversion (the rail IS the one
// docked collapse store).
// ===========================================================================

describe("setColumnRailed (per-column rail)", () => {
  it("isSoleFloatingGroup: floating singles only (D32)", () => {
    // The panel-level collapse control's gate: true ONLY for the sole
    // group of a floating window. Docked panels -- sole panels of a
    // region included -- are false (docked collapse is chevron -> rail),
    // as are stacked floating cells and unplaced groups.
    const layout = makeLayout({
      right: row([col([leaf("b"), leaf("c")]), leaf("a")]),
      left: leaf("m"),
      floating: [
        { id: "w1", stack: ["x", "y"] },
        { id: "w2", stack: ["z"] },
      ],
    });
    expect(isSoleFloatingGroup(layout, "z")).toBe(true);
    expect(isSoleFloatingGroup(layout, "x")).toBe(false);
    expect(isSoleFloatingGroup(layout, "y")).toBe(false);
    expect(isSoleFloatingGroup(layout, "a")).toBe(false);
    expect(isSoleFloatingGroup(layout, "m")).toBe(false); // docked sole panel
    expect(isSoleFloatingGroup(layout, "nowhere")).toBe(false);
  });

  /** Left edge: two single-leaf columns [a | b]. */
  const twoColumns = () => {
    const ca = col([leaf("a")]);
    const cb = col([leaf("b")]);
    const layout = makeLayout({ left: row([ca, cb]) });
    return { layout, aColId: columnIdOf(ca) };
  };

  it("round-trips, no-ops on a missing column, and expand-to-tab clears it", () => {
    const { layout, aColId } = twoColumns();
    const on = setColumnRailed(layout, "left", aColId, true);
    expect(on.docked.left!.columns[0].railed).toBe(true);
    // Clearing (or setting) on a missing column is a no-op.
    expect(setColumnRailed(on, "left", "missing", false)).toBe(on);
    expect(setColumnRailed(on, "left", aColId, true)).toBe(on);
    const off = setColumnRailed(on, "left", aColId, false);
    expect(off.docked.left!.columns[0].railed).toBeUndefined();
    // The expand-to-tab path (setActiveTab + expandGroup) clears the
    // containing column's railed flag: expanding reveals the panel (P5).
    const expanded = expandGroup(setActiveTab(on, "a", "a:0"), "a");
    expect(expanded.docked.left!.columns[0].railed).toBeUndefined();
  });

  it("railing a region's sole (multi-leaf) column packs the region (D46)", () => {
    // setColumnRailed is a bare flag flip; the packed region is DERIVED
    // (isRegionPackedOn: every column railed), so railing the lone column
    // of a single-column region IS the packed form -- no routing, no
    // region store.
    const layout = makeLayout({ left: col([leaf("a"), leaf("b")]) });
    const colId = layout.docked.left!.columns[0].id;
    const out = setColumnRailed(layout, "left", colId, true);
    expect(isRegionPackedOn(out, "left")).toBe(true);
    expect(out.docked.left!.columns[0].railed).toBe(true);
    expect(invariantViolations(out)).toEqual([]);
  });

  it("a group in a railed column reads as effectively collapsed", () => {
    const { layout, aColId } = twoColumns();
    const on = setColumnRailed(layout, "left", aColId, true);
    expect(isGroupEffectivelyCollapsed(on, "a")).toBe(true);
    expect(isRailedDockedCell(on, "a")).toBe(true);
    expect(isGroupEffectivelyCollapsed(on, "b")).toBe(false);
    expect(isRailedDockedCell(on, "b")).toBe(false);
  });

  it("side-docking beside a fully railed region: old columns keep their rails", () => {
    // D46: no conversion machinery -- the rail was already per-column, so
    // docking beside a packed region just inserts the expanded newcomer as
    // a new column. The old column stays railed; the region un-packs.
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w", stack: ["n"] }],
    });
    const railed = railRegion(layout, "left");
    const out = dockToRegionEdge(railed, ["n"], "left", "right");
    expect(isRegionPackedOn(out, "left")).toBe(false);
    const cols = out.docked.left!.columns;
    expect(cols.map((c) => collectLeafGroups(c))).toEqual([["a"], ["n"]]);
    expect(cols[0].railed).toBe(true);
    expect(cols[1].railed).toBeUndefined();
  });

  it("side-docking beside a railed multi-leaf stack keeps the stack railed", () => {
    // A railed stack is ONE multi-leaf column (D46: nothing to zip); the
    // newcomer lands as an expanded sibling column beside it.
    const layout = makeLayout({
      left: col([leaf("a"), leaf("b")]),
      floating: [{ id: "w", stack: ["n"] }],
    });
    const railed = railRegion(layout, "left");
    const out = dockToRegionEdge(railed, ["n"], "left", "left");
    expect(isRegionPackedOn(out, "left")).toBe(false);
    const cols = out.docked.left!.columns;
    expect(cols.map((c) => collectLeafGroups(c))).toEqual([["n"], ["a", "b"]]);
    expect(cols[0].railed).toBeUndefined();
    expect(cols[1].railed).toBe(true);
  });

  it("dropOnDockedLeaf beside a packed rail: a new column; the rail stays railed (D46)", () => {
    // A side drop on a railed cell inserts a full-height column beside the
    // target's COLUMN (no band split -- bands are unrepresentable). The
    // railed target keeps its flag AND its stored restore width (the 50/50
    // weight split must not corrupt a rail's P8 width).
    const layout = makeLayout({
      left: col([leaf("a"), leaf("b")]),
      floating: [{ id: "w", stack: ["n"], width: 250, x: 10, y: 10 }],
    });
    const railed = railRegion(layout, "left");
    const aLeafId = railed.docked.left!.columns[0].leaves[0].id;
    const out = dropOnDockedLeaf(railed, ["n"], "left", aLeafId, "right");
    expect(isRegionPackedOn(out, "left")).toBe(false);
    const cols = out.docked.left!.columns;
    expect(cols.map((c) => collectLeafGroups(c))).toEqual([["a", "b"], ["n"]]);
    expect(cols[0].railed).toBe(true); // the target's rail stays railed...
    expect(cols[1].railed).toBeUndefined(); // ...the newcomer expanded.
    expect(invariantViolations(out)).toEqual([]);
  });

  it("dockToEdge (server) beside a packed rail: everything stays railed (D46)", () => {
    const layout = makeLayout({
      left: col([leaf("a"), leaf("b")]),
      floating: [
        { id: "w", stack: ["n"], collapsed: true, width: 250, x: 5, y: 5 },
      ],
    });
    const railed = railRegion(layout, "left");
    const out = dockToEdge(railed, ["n"], "left");
    // A collapsed source lands as a RAILED column (identity transfer, D38)
    // at the outermost position; the existing railed stack keeps its flag.
    // Every group railed -> the region is still the packed form.
    const railedGroups = out.docked
      .left!.columns.filter((c) => c.railed === true)
      .flatMap((c) => collectLeafGroups(c));
    expect(new Set(railedGroups)).toEqual(new Set(["a", "b", "n"]));
    expect(out.docked.left!.columns).toHaveLength(2);
    expect(isRegionPackedOn(out, "left")).toBe(true);
    expect(invariantViolations(out)).toEqual([]);
  });

  it("removing a railed column's last sibling keeps it railed", () => {
    // [c railed | d], then the server removes d (removePane): the surviving
    // railed c keeps its flag -- now the region's sole column, i.e. the
    // packed form (derived).
    const cc = col([leaf("c")]);
    const layout = makeLayout({ left: row([cc, col([leaf("d")])]) });
    const railed = setColumnRailed(layout, "left", columnIdOf(cc), true);
    const out = removePane(railed, "d:0");
    expect(out.docked.left!.columns).toHaveLength(1);
    expect(out.docked.left!.columns[0].leaves[0].group).toBe("c");
    expect(out.docked.left!.columns[0].railed).toBe(true);
    expect(isRegionPackedOn(out, "left")).toBe(true);
    expect(invariantViolations(out)).toEqual([]);
  });

  it("railing the LAST expanded column just rails it (no accordion, D46)", () => {
    // D43's accordion is gone: setColumnRailed is a bare flag flip, so
    // railing the last expanded column packs the region instead of
    // swapping with a railed sibling.
    const ca = col([leaf("a")]);
    const cb = col([leaf("b")]);
    const layout = makeLayout({ left: row([ca, cb]) });
    const step1 = setColumnRailed(layout, "left", columnIdOf(ca), true);
    const step2 = setColumnRailed(step1, "left", columnIdOf(cb), true);
    const cols = step2.docked.left!.columns;
    expect(cols[0].railed).toBe(true);
    expect(cols[1].railed).toBe(true);
    expect(isRegionPackedOn(step2, "left")).toBe(true);
    expect(invariantViolations(step2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shared regression fixtures (used by the bug pins below).
// ---------------------------------------------------------------------------

/** Left edge holds columns [a | b] with fixed node ids Sa/Sb / La/Lb. */
function twoLeafRow(): DockLayout {
  const l = emptyLayout();
  l.groups = { a: group("a"), b: group("b") };
  l.docked.left = {
    columns: [
      { id: "Sa", weight: 1, leaves: [{ id: "La", group: "a", weight: 1 }] },
      { id: "Sb", weight: 1, leaves: [{ id: "Lb", group: "b", weight: 1 }] },
    ],
  };
  return l;
}

/** Floating-only layout with explicit per-window stacks and stack weights. */
function floatingLayout(
  windows: {
    id: string;
    stack: GroupId[];
    stackWeights?: Record<GroupId, number>;
  }[],
): DockLayout {
  const l = emptyLayout();
  l.floating = windows.map(floatingWindow);
  for (const w of windows)
    for (const g of w.stack)
      if (l.groups[g] === undefined) {
        // Test shorthand: the group's single pane reuses the group's name.
        const pane: PaneId = String(g);
        l.groups[g] = { id: g, paneIds: [pane], activeId: pane };
      }
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
  l.areas = { "area-1": { group: "area-grp" } };
  return l;
}

// ===========================================================================
// findGroupLocation
// ===========================================================================

describe("findGroupLocation", () => {
  it("finds a group docked on the left edge", () => {
    const layout = makeLayout({ left: leaf("a") });
    const loc = findGroupLocation(layout, "a");
    expect(loc).toEqual({
      kind: "docked",
      edge: "left",
      nodeId: expect.any(String),
    });
  });

  it("finds a group docked on the right edge (nested in a split)", () => {
    const layout = makeLayout({
      right: row([leaf("a"), col([leaf("b"), leaf("c")])]),
    });
    expect(findGroupLocation(layout, "c")).toEqual({
      kind: "docked",
      edge: "right",
      nodeId: expect.any(String),
    });
  });

  it("finds a group inside a floating stack", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a", "b"] }] });
    expect(findGroupLocation(layout, "b")).toEqual({
      kind: "floating",
      windowId: "w1",
    });
  });

  it("returns null for an unknown group", () => {
    const layout = makeLayout({ left: leaf("a") });
    expect(findGroupLocation(layout, "zzz")).toBeNull();
  });
});

// ===========================================================================
// edgeIsSingleLeaf  (D46: side-independent -- one column, one leaf)
// ===========================================================================

describe("edgeIsSingleLeaf", () => {
  const reg = (spec: ReturnType<typeof leaf>) => toRegion(spec)!;

  it("a lone leaf (single-column, single-leaf region) is single", () => {
    expect(edgeIsSingleLeaf(reg(leaf("a")))).toBe(true);
  });

  it("side-by-side columns are not single", () => {
    expect(edgeIsSingleLeaf(reg(row([leaf("a"), leaf("b")])))).toBe(false);
    expect(
      edgeIsSingleLeaf(reg(row([col([leaf("a"), leaf("b")]), leaf("c")]))),
    ).toBe(false);
  });

  it("a single column of stacked leaves is not single", () => {
    expect(edgeIsSingleLeaf(reg(col([leaf("a"), leaf("b")])))).toBe(false);
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

  it("restores a floated stack's preserved height split when docking back", () => {
    // Regression: floatColumn carefully carries a docked column's 70/30 leaf
    // weights into win.stackWeights, but docking the window back rebuilt the
    // column with every leaf at weight 1 -- the height split silently reset
    // (while column WIDTHS survive the same round-trip via the reconciler).
    const layout = makeLayout({
      floating: [{ id: "w1", stack: ["a", "b"] }],
    });
    layout.floating[0].stackWeights = { a: 70, b: 30 };
    const out = dockToEdge(layout, ["a", "b"], "right");
    const leaves = out.docked.right!.columns[0].leaves;
    expect(leaves.map((l) => ({ g: l.group, w: l.weight }))).toEqual([
      { g: "a", w: 70 },
      { g: "b", w: 30 },
    ]);
  });

  it("docks a single floating group to an empty left edge as a leaf", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    const out = dockToEdge(layout, ["a"], "left");
    expect(shapeOf(out.docked.left)).toEqual({ leaf: "a" });
    expect(out.floating).toHaveLength(0); // empty window cleaned up
    expect(out).not.toBe(layout); // new object
  });

  it("docks to the far-left (outermost) when the edge already has content", () => {
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w1", stack: ["b"] }],
    });
    const out = dockToEdge(layout, ["b"], "left");
    // New group goes first (outermost on the left), existing second.
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "row",
      children: [{ leaf: "b" }, { leaf: "a" }],
    });
  });

  it("docks to the far-right (outermost) for the right edge", () => {
    const layout = makeLayout({
      right: leaf("a"),
      floating: [{ id: "w1", stack: ["b"] }],
    });
    const out = dockToEdge(layout, ["b"], "right");
    // Existing first, new group last (outermost on the right).
    expect(shapeOf(out.docked.right)).toEqual({
      dir: "row",
      children: [{ leaf: "a" }, { leaf: "b" }],
    });
  });

  it("docks a multi-group snapped stack as a column subtree, preserving order", () => {
    const layout = makeLayout({
      floating: [{ id: "w1", stack: ["a", "b", "c"] }],
    });
    const out = dockToEdge(layout, ["a", "b", "c"], "left");
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "column",
      children: [{ leaf: "a" }, { leaf: "b" }, { leaf: "c" }],
    });
    expect(out.floating).toHaveLength(0);
  });

  it("stays a flat columns list when docking next to existing columns", () => {
    // Existing right edge is already [a | b]; dock a single group -> a flat
    // 3-wide columns list (D46: the region IS the one horizontal partition).
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
// dockToRegionEdge  (left/right only, D46: a full-height column beside
// everything; with & without weights)
// ===========================================================================

describe("dockToRegionEdge", () => {
  it("no-op for empty group list", () => {
    const layout = makeLayout({ left: leaf("a") });
    expect(dockToRegionEdge(layout, [], "left", "left")).toBe(layout);
  });

  it("docks into an empty edge as a plain single column", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    const out = dockToRegionEdge(layout, ["a"], "left", "left");
    expect(shapeOf(out.docked.left)).toEqual({ leaf: "a" });
  });

  // Inserts a full-height column, dragged-first for left and last for right.
  it.each([
    ["left", ["b", "a"]],
    ["right", ["a", "b"]],
  ] as const)("%s: inserts a column with order %j", (side, order) => {
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w1", stack: ["b"] }],
    });
    const out = dockToRegionEdge(layout, ["b"], "left", side);
    expect(shapeOf(out.docked.left)).toEqual({
      dir: "row",
      children: order.map((g) => ({ leaf: g })),
    });
  });

  it("applies explicit weights (existing/dragged) to the region's columns", () => {
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w1", stack: ["b"] }],
    });
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
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w1", stack: ["b"] }],
    });
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

  it("keeps a dragged stack together as ONE multi-leaf column (left side)", () => {
    // Dragged stack [a/b] docks as a single column beside x: the stack IS
    // a column (D46), so its vertical arrangement survives verbatim.
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
// insertColumnAt (D55): THE canonical full-height column insert. Region-edge
// docking (0/N via dockToRegionEdge), per-panel side drops (dropOnDockedLeaf
// left/right) and the hit-test's columnInsert result all delegate here.
// ===========================================================================

describe("insertColumnAt", () => {
  const mk = () =>
    makeLayout({
      left: row([leaf("a"), leaf("b")]),
      floating: [{ id: "w", stack: ["c"] }],
    });

  it("index 0 / N equal dockToRegionEdge's left/right sides (delegation sanity)", () => {
    const via0 = insertColumnAt(mk(), ["c"], "left", 0);
    const edge0 = dockToRegionEdge(mk(), ["c"], "left", "left");
    expect(groupsInTree(via0.docked.left)).toEqual(["c", "a", "b"]);
    expect(shapeOf(via0.docked.left)).toEqual(shapeOf(edge0.docked.left));
    const viaN = insertColumnAt(mk(), ["c"], "left", 2);
    const edgeN = dockToRegionEdge(mk(), ["c"], "left", "right");
    expect(groupsInTree(viaN.docked.left)).toEqual(["a", "b", "c"]);
    expect(shapeOf(viaN.docked.left)).toEqual(shapeOf(edgeN.docked.left));
  });

  it("an interior seam inserts between the flanking columns", () => {
    const out = insertColumnAt(mk(), ["c"], "left", 1);
    expect(groupsInTree(out.docked.left)).toEqual(["a", "c", "b"]);
    expect(refCount(out, "c")).toBe(1);
    expect(out.floating).toHaveLength(0);
  });

  it("clamps a stale index after a same-region detach (only group of column k to a far seam)", () => {
    // [a][b]: dragging a (column 0's only group) to seam 2 detaches a's
    // column first, so a splice at the captured index 2 would dangle past
    // the end. The surviving-neighbor re-derivation lands it after b.
    const l = makeLayout({ left: row([leaf("a"), leaf("b")]) });
    const out = insertColumnAt(l, ["a"], "left", 2);
    expect(groupsInTree(out.docked.left)).toEqual(["b", "a"]);
    expect(refCount(out, "a")).toBe(1);
    expect(invariantViolations(out)).toEqual([]);
  });

  it("dragging the only group of column k to its OWN seam is the identity (no id churn)", () => {
    const l = makeLayout({ left: row([leaf("a"), leaf("b"), leaf("c")]) });
    // Both seams of b's own column: re-inserting there changes nothing, so
    // the op is a no-op rather than a detach + rebuild with fresh node ids.
    expect(insertColumnAt(l, ["b"], "left", 1)).toBe(l);
    expect(insertColumnAt(l, ["b"], "left", 2)).toBe(l);
    // A genuinely different seam still moves it.
    const out = insertColumnAt(l, ["b"], "left", 3);
    expect(groupsInTree(out.docked.left)).toEqual(["a", "c", "b"]);
  });

  it("out-of-range indices clamp to the seam range [0..N]", () => {
    const big = insertColumnAt(mk(), ["c"], "left", 99);
    expect(groupsInTree(big.docked.left)).toEqual(["a", "b", "c"]);
    const neg = insertColumnAt(mk(), ["c"], "left", -1);
    expect(groupsInTree(neg.docked.left)).toEqual(["c", "a", "b"]);
  });
});

// ===========================================================================
// dropOnDockedLeaf  (center merge + 4 splits, with weights)
// ===========================================================================

describe("dropOnDockedLeaf", () => {
  /** Helper: find the node id of the leaf holding `group` on the given edge. */
  function leafIdOf(
    layout: DockLayout,
    _edge: DockEdge,
    group: GroupId,
  ): string {
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
    expect(dropOnDockedLeaf(layout, ["b"], "left", "nope", "left")).toBe(
      layout,
    );
  });

  it("returns input when the target node id is missing", () => {
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w1", stack: ["b"] }],
    });
    expect(dropOnDockedLeaf(layout, ["b"], "left", "missing", "left")).toBe(
      layout,
    );
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
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w1", stack: ["b"] }],
    });
    const id = leafIdOf(layout, "left", "a");
    const out = dropOnDockedLeaf(layout, ["b"], "left", id, region);
    expect(shapeOf(out.docked.left)).toEqual({
      dir,
      children: order.map((g) => ({ leaf: g })),
    });
  });

  it("a top/bottom drop splits the target's weight in half (scale-invariant)", () => {
    const layout = makeLayout({
      left: row([leaf("a", 4), leaf("t", 7)]),
      floating: [{ id: "w1", stack: ["b"] }],
    });
    const id = leafIdOf(layout, "left", "t");
    // Drop "b" above "t" -> a column split replacing the "t" leaf, weight 7.
    // Each side takes half the target's weight: sibling weights may be on a
    // px scale after divider drags, so absolute defaults (1/1) would render
    // the pair as slivers; halves keep the hint's 50/50 promise.
    const out = dropOnDockedLeaf(layout, ["b"], "left", id, "top");
    expect(shapeOf(out.docked.left, true)).toEqual({
      dir: "row",
      weight: 1,
      children: [
        { leaf: "a", weight: 4 },
        {
          dir: "column",
          weight: 7, // inherited from the replaced target leaf
          children: [
            { leaf: "b", weight: 3.5 },
            { leaf: "t", weight: 3.5 },
          ],
        },
      ],
    });
  });

  // Side drops beside a cell of a multi-leaf column insert a FULL-HEIGHT
  // column beside the target's COLUMN (D46: no band split -- the old "beside
  // just this cell" landing is unrepresentable; the hint spans the column).
  const colsOf = (region: DockLayout["docked"]["left"]) =>
    region === null
      ? null
      : region.columns.map((c) => c.leaves.map((l) => l.group));

  it("left of a cell in a stacked column lands a column beside the WHOLE stack", () => {
    const layout = makeLayout({
      left: col([leaf("a"), leaf("b")]),
      floating: [{ id: "w1", stack: ["c"] }],
    });
    const id = leafIdOf(layout, "left", "a");
    const out = dropOnDockedLeaf(layout, ["c"], "left", id, "left");
    expect(colsOf(out.docked.left)).toEqual([["c"], ["a", "b"]]);
    expect(out.floating).toHaveLength(0);
  });

  it("right of the BOTTOM cell lands the same full-height column (after)", () => {
    const layout = makeLayout({
      left: col([leaf("a"), leaf("b")]),
      floating: [{ id: "w1", stack: ["c"] }],
    });
    const id = leafIdOf(layout, "left", "b");
    const out = dropOnDockedLeaf(layout, ["c"], "left", id, "right");
    expect(colsOf(out.docked.left)).toEqual([["a", "b"], ["c"]]);
  });

  it("a side drop never touches existing columns' weights (D55/D40)", () => {
    // The side arm delegates to insertColumnAt, which leaves every existing
    // column's weight alone (a railed target's weight is its P8 restore
    // width -- rewriting any weight here could corrupt it) and gives the
    // newcomer a placeholder 1. Real pixels are assigned centrally by
    // applyOp's width reconciliation on every consumer-visible path
    // (pinned in widthReconciliation.test.ts, W9/W12).
    const layout = makeLayout({
      left: row([leaf("x"), col([leaf("a"), leaf("b")], 6)]),
      floating: [{ id: "w1", stack: ["c"] }],
    });
    const id = leafIdOf(layout, "left", "a");
    const out = dropOnDockedLeaf(layout, ["c"], "left", id, "left");
    const cols = out.docked.left!.columns;
    expect(colsOf(out.docked.left)).toEqual([["x"], ["c"], ["a", "b"]]);
    expect(cols[1].weight).toBe(1); // newcomer: placeholder, reconciled later
    expect(cols[2].weight).toBe(6); // target: untouched
  });

  it("beside a cell of a column with column SIBLINGS: a new column at that seam", () => {
    // Region = [x | col(a, b)]: c lands as a full-height column between x
    // and the target's column.
    const layout = makeLayout({
      left: row([leaf("x"), col([leaf("a"), leaf("b")])]),
      floating: [{ id: "w1", stack: ["c"] }],
    });
    const id = leafIdOf(layout, "left", "a");
    const out = dropOnDockedLeaf(layout, ["c"], "left", id, "left");
    expect(colsOf(out.docked.left)).toEqual([["x"], ["c"], ["a", "b"]]);
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
  // Left region holds columns [b | a] with fixed leaf ids Lb / La.
  function sideBySide(): DockLayout {
    const l = emptyLayout();
    l.docked.left = {
      columns: [
        { id: "Sb", weight: 1, leaves: [{ id: "Lb", group: "b", weight: 1 }] },
        { id: "Sa", weight: 1, leaves: [{ id: "La", group: "a", weight: 1 }] },
      ],
    };
    l.groups = { a: group("a"), b: group("b"), c: group("c") };
    l.floating = [
      {
        id: "w",
        x: 0,
        y: 0,
        width: 280,
        height: { mode: "auto" },
        stack: ["c"],
      },
    ];
    return l;
  }

  it("both seam approaches insert c between b and a -> [b, c, a]", () => {
    // Aim at the RIGHT band of the left panel (b): split right of b.
    const rightOfB = dropOnDockedLeaf(
      sideBySide(),
      ["c"],
      "left",
      "Lb",
      "right",
    );
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
      columns: [
        { id: "Ca", weight: 1, leaves: [{ id: "La", group: "a", weight: 1 }] },
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
    expect(out.areas!["area-1"]).toEqual({ group: "area-grp" });
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
      floatingWindow({
        id: "w1",
        x: 0,
        y: 0,
        width: 300,
        stack: ["plain-src"],
      }),
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
    expect(dockToRegionEdge(l, ["area-grp"], "left", "left")).toBe(l);
  });

  it("dropOnDockedLeaf with only the area group is a no-op", () => {
    const l = areaDragLayout();
    l.docked.left = {
      columns: [
        {
          id: "Cp",
          weight: 1,
          leaves: [{ id: "La", group: "plain-src", weight: 1 }],
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
    expect(win).toMatchObject({
      x: 7,
      y: 8,
      width: 240,
      stack: [res.floatingGroupId],
    });
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
    expect(out.floating.find((w) => w.id === "w1")!.stack).toEqual([
      "a",
      "b",
      "c",
    ]);
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
    expect(out.floating.find((w) => w.id === "w1")!.stack).toEqual([
      "b",
      "c",
      "a",
    ]);
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
    l.floating = [
      floatingWindow({ id: "w1", x: 10, y: 10, width: 260, stack: ["a"] }),
    ];

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
    l.floating = [
      floatingWindow({ id: "w1", x: 0, y: 0, width: 260, stack: ["a", "b"] }),
    ];

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
      {
        id: "w1",
        stack: ["a", "b", "c"],
        stackWeights: { a: 100, b: 200, c: 50 },
      },
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

describe("toggleCollapsed (D38: one flag per container)", () => {
  it("floating: toggles the WINDOW's flag", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    const once = toggleCollapsed(layout, "a");
    expect(once.floating[0].collapsed).toBe(true);
    const twice = toggleCollapsed(once, "a");
    expect(twice.floating[0].collapsed).not.toBe(true);
  });

  it("multi-group window: the same ONE flag (toggle-all is just toggle)", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a", "b"] }] });
    const once = toggleCollapsed(layout, "b");
    expect(once.floating[0].collapsed).toBe(true);
    expect(isGroupEffectivelyCollapsed(once, "a")).toBe(true);
    expect(isGroupEffectivelyCollapsed(once, "b")).toBe(true);
  });

  it("docked single-column stack: rails the COLUMN, which IS the packed region (D46)", () => {
    // toggleCollapsed ALWAYS rails the containing column; for a
    // single-column region that fully packs the edge (derived).
    const layout = makeLayout({ right: col([leaf("a"), leaf("b")]) });
    const once = toggleCollapsed(layout, "a");
    expect(once.docked.right!.columns[0].railed).toBe(true);
    expect(isRegionPackedOn(once, "right")).toBe(true);
    const twice = toggleCollapsed(once, "a");
    expect(isRegionPackedOn(twice, "right")).toBe(false);
  });

  it("docked beside content: targets the containing COLUMN's railed flag", () => {
    const ca = col([leaf("a")]);
    const layout = makeLayout({ left: row([ca, leaf("b")]) });
    const once = toggleCollapsed(layout, "a");
    expect(once.docked.left!.columns[0].railed).toBe(true);
    expect(isRegionPackedOn(once, "left")).toBe(false);
    const twice = toggleCollapsed(once, "a");
    expect(twice.docked.left!.columns[0].railed).toBeUndefined();
  });

  it("returns input for an unknown group", () => {
    const layout = makeLayout({ left: leaf("a") });
    expect(toggleCollapsed(layout, "zzz")).toBe(layout);
  });
});

// ===========================================================================
// minimizeStack / expandStack (the stack handle's minimize toggle). Under
// D38/D46 these resolve the stack's CONTAINER and flip its one flag: the
// window's collapsed, or the containing docked column's railed flag.
// ===========================================================================

describe("minimizeStack / expandStack (D38)", () => {
  const stacked = () =>
    makeLayout({ floating: [{ id: "w1", stack: ["a", "b", "c"] }] });

  it("floating: minimize sets the WINDOW flag; expand clears it", () => {
    const min = minimizeStack(stacked(), ["a", "b", "c"]);
    expect(min.floating[0].collapsed).toBe(true);
    for (const g of ["a", "b", "c"])
      expect(isGroupEffectivelyCollapsed(min, g)).toBe(true);
    const max = expandStack(min, ["a", "b", "c"]);
    expect(max.floating[0].collapsed).not.toBe(true);
    for (const g of ["a", "b", "c"])
      expect(isGroupEffectivelyCollapsed(max, g)).toBe(false);
  });

  it("docked: rails the containing column (sole column -> packed region)", () => {
    const plain = makeLayout({ right: col([leaf("a"), leaf("b")]) });
    const min = minimizeStack(plain, ["a", "b"]);
    expect(min.docked.right!.columns[0].railed).toBe(true);
    expect(isRegionPackedOn(min, "right")).toBe(true);

    const cxy = col([leaf("x"), leaf("y")]);
    const beside = makeLayout({ left: row([cxy, leaf("z")]) });
    const railed = minimizeStack(beside, ["x", "y"]);
    expect(railed.docked.left!.columns[0].railed).toBe(true);
    expect(isRegionPackedOn(railed, "left")).toBe(false);
  });

  it("no-ops return the input layout unchanged", () => {
    const allExpanded = stacked();
    expect(expandStack(allExpanded, ["a", "b", "c"])).toBe(allExpanded);
    const allMin = minimizeStack(allExpanded, ["a", "b", "c"]);
    expect(minimizeStack(allMin, ["a", "b", "c"])).toBe(allMin);
  });
});

// ===========================================================================
// expandStackOf: expanding from any one bar of a stack reveals the WHOLE
// stack. Under D38 this is structural -- collapse IS container state, so the
// op is exactly "clear the container's one flag".
// ===========================================================================

describe("expandStackOf (D38)", () => {
  it("floating stack: clears the window's flag (whole stack reveals)", () => {
    let layout = makeLayout({
      floating: [{ id: "w1", stack: ["a", "b", "c"] }],
    });
    layout = minimizeStack(layout, ["a", "b", "c"]);
    const out = expandStackOf(layout, "b");
    expect(out.floating[0].collapsed).not.toBe(true);
    for (const g of ["a", "b", "c"])
      expect(isGroupEffectivelyCollapsed(out, g)).toBe(false);
  });

  it("docked plain stack: clears the containing COLUMN's flag (whole stack)", () => {
    // A plain stack IS one multi-leaf column (D46), so the stack scope's
    // store is that column's railed flag.
    let layout = makeLayout({ right: col([leaf("a"), leaf("b")]) });
    layout = minimizeStack(layout, ["a", "b"]);
    const out = expandStackOf(layout, "a");
    expect(isRegionPackedOn(out, "right")).toBe(false);
    expect(isGroupEffectivelyCollapsed(out, "b")).toBe(false);
  });

  it("stacked column: clears its own rail only; sibling column untouched", () => {
    const cab = col([leaf("a"), leaf("b")]);
    const ccd = col([leaf("c"), leaf("d")]);
    let layout = makeLayout({ left: row([cab, ccd]) });
    layout = setColumnRailed(layout, "left", columnIdOf(cab), true);
    layout = setColumnRailed(layout, "left", columnIdOf(ccd), true);
    const out = expandStackOf(layout, "a");
    expect(out.docked.left!.columns[0].railed).toBeUndefined();
    expect(out.docked.left!.columns[1].railed).toBe(true); // sibling
    expect(isGroupEffectivelyCollapsed(out, "c")).toBe(true);
  });

  it("expanding from a fully railed region is granular: only the containing column", () => {
    // Every column railed (the packed form): one expand reveals ITS column
    // only -- the other column stays railed and the region un-packs (D46:
    // there is only the column flag; no region store to also clear).
    const ca = col([leaf("x"), leaf("y")]);
    let layout = makeLayout({ left: row([ca, leaf("z")]) });
    layout = railRegion(layout, "left");
    const out = expandStackOf(layout, "x");
    expect(isRegionPackedOn(out, "left")).toBe(false);
    expect(out.docked.left!.columns[0].railed).toBeUndefined();
    expect(out.docked.left!.columns[1].railed).toBe(true); // z stays railed
  });

  it("no-op (same reference) when the container is already expanded", () => {
    const layout = makeLayout({
      floating: [{ id: "w1", stack: ["a", "b"] }],
    });
    expect(expandStackOf(layout, "a")).toBe(layout);
    expect(expandStackOf(layout, "zzz")).toBe(layout); // unknown group
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
    const layout = makeLayout({
      floating: [{ id: "w1", stack: ["a"], x: 0, y: 0 }],
    });
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
    const layout = makeLayout({
      floating: [{ id: "w1", stack: ["a"], x: 5, width: 100 }],
    });
    const out = resizeWindow(layout, "w1", 200);
    expect(out.floating[0]).toMatchObject({ width: 200, x: 5 });
  });
  it("sets width and x for a left-edge resize", () => {
    const layout = makeLayout({
      floating: [{ id: "w1", stack: ["a"], x: 5, width: 100 }],
    });
    const out = resizeWindow(layout, "w1", 200, 50);
    expect(out.floating[0]).toMatchObject({ width: 200, x: 50 });
  });
  it("returns input for unknown window", () => {
    const layout = makeLayout({ floating: [{ id: "w1", stack: ["a"] }] });
    expect(resizeWindow(layout, "zzz", 100)).toBe(layout);
  });
  it("floors width at the grab minimum (server set_width(0)/negative)", () => {
    const layout = makeLayout({
      floating: [{ id: "w1", stack: ["a"], width: 300 }],
    });
    expect(resizeWindow(layout, "w1", 0).floating[0].width).toBe(
      MIN_REGION_GRAB_PX,
    );
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
    l.floating = [
      floatingWindow({ id: "w1", x: 0, y: 0, width: 260, stack: ["a"] }),
    ];
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

  it("sums to the clamped target under mixed finite bounds", () => {
    // regression: opposite-direction clamps (one column pulled UP to its
    // min, another pushed DOWN to its max) froze every column with the sum
    // stranded off target, violating the documented postcondition. The
    // leftover phase hands the difference to columns with room. (Not
    // reachable from production callers -- they pass Infinity maxes -- but
    // the exported contract must hold for any caller.)
    const cases: [number[], number[], number[], number][] = [
      // From fuzz: proportional shares put col0 below its min and col1
      // above its max simultaneously.
      [[7.11, 230.84], [87.43, 8.31], [376.41, 282.51], 357.72],
      // Target below sumMin: result must sum to sumMin exactly.
      [[302.17, 102.38], [23.55, 91.5], [68.92, 365.4], 28.17],
      // Target above sumMax with a finite max mix.
      [[207.46, 15.21], [65.28, 115.61], [118.42, 352.14], 1480.67],
    ];
    for (const [init, mins, maxs, target] of cases) {
      const w = resizeRegionColumns(init, mins, maxs, target);
      const sumMin = mins.reduce((a, b) => a + b, 0);
      const sumMax = maxs.reduce((a, b) => a + b, 0);
      const clamped = Math.min(Math.max(target, sumMin), sumMax);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(clamped, 3);
      w.forEach((x, i) => {
        expect(x).toBeGreaterThanOrEqual(mins[i] - 1e-6);
        expect(x).toBeLessThanOrEqual(maxs[i] + 1e-6);
      });
    }
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
    expect(region.columns[1].leaves).toEqual([
      { id: expect.any(String), group: "b", weight: 5 },
    ]);
  });

  it("empties the whole region to null when its last group leaves", () => {
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w1", stack: ["z"] }],
    });
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
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w1", stack: ["b"] }],
    });
    const snapshot = structuredClone(layout);
    dockToEdge(layout, ["b"], "left");
    dropOnDockedLeaf(
      layout,
      ["b"],
      "left",
      layout.docked.left!.columns[0].leaves[0].id,
      "left",
    );
    expect(layout).toEqual(snapshot);
  });
});

// ===========================================================================
// Unmergeable helpers.
// ===========================================================================
import { isPaneUnmergeable, isGroupUnmergeable, makeGroup } from "./layoutOps";
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
      regionCollapsed: { left: false, right: false },
      floating: [],
    };
    expect(isGroupUnmergeable(layout, panes, normal.id)).toBe(false);
    expect(isGroupUnmergeable(layout, panes, special.id)).toBe(true);
    expect(isGroupUnmergeable(layout, panes, "no-such-group")).toBe(false);
  });
});
