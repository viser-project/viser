// Audit tests for resizing / dimension-limit math (task #38).
//
// These pin the fixes for two confirmed bugs and guard their siblings:
//
// LEAD 1 (width): dockToRegionEdge with side top/bottom onto a multi-column
//   region produces a column-rooted tree column[C, row[A,B]]. The old width
//   reconciliation used topColumns, which sees the whole stack as ONE column and
//   collapsed the region to a single column's width (600 -> 446). widthColumns
//   surfaces the inner row's [A,B] so the side-by-side widths are preserved.
//
// LEAD 2 (height): the same top/bottom dock left the existing subtree's leftover
//   pixel weight (e.g. 300, from horizontal reconciliation) as a sibling of the
//   freshly-docked panel (weight 1) inside the new COLUMN split -- so the new
//   band rendered at ~1/301 of the height (3px). dockToRegionEdge now starts the
//   new split 50/50 when no explicit weights are given.

import { describe, it, expect } from "vitest";
import {
  DockLayout,
  DockNode,
  GroupId,
  MAX_PANEL_WIDTH_PX,
  MIN_PANEL_WIDTH_PX,
  SPLIT_DIVIDER_PX,
} from "./types";
import {
  widthColumns,
  topColumns,
  dockToRegionEdge,
  dropOnDockedLeaf,
  minRegionWidth,
  maxRegionWidth,
  collectLeafGroups,
} from "./layoutOps";
import { leaf, row, col, group, groupsRecord as groups } from "./testUtils";

function layoutWith(tree: DockNode, ...gids: GroupId[]): DockLayout {
  return { groups: groups(...gids), docked: { left: tree, right: null }, floating: [] };
}
/** The single split node in a tree shaped as one split (for weight checks). */
function asSplit(n: DockNode | null): Extract<DockNode, { type: "split" }> {
  if (n === null || n.type !== "split") throw new Error("expected split");
  return n;
}

// ===========================================================================
// widthColumns -- the width-determining horizontal columns.
// ===========================================================================
describe("widthColumns", () => {
  it("a leaf is its own single column", () => {
    const a = leaf("a");
    expect(widthColumns(a)).toEqual([a]);
  });

  it("a row split's columns are its children (same as topColumns)", () => {
    const a = leaf("a");
    const b = leaf("b");
    const tree = row([a, b]);
    expect(widthColumns(tree)).toEqual([a, b]);
    expect(widthColumns(tree)).toEqual(topColumns(tree));
  });

  it("a COLUMN root surfaces the inner row's columns (NOT the whole stack)", () => {
    // column[C, row[A,B]] -- the LEAD 1 shape. topColumns sees one column (the
    // whole stack); widthColumns descends to the widest child (the row) and
    // returns ITS [A,B], so width reconciliation preserves side-by-side widths.
    const a = leaf("a");
    const b = leaf("b");
    const inner = row([a, b]);
    const tree = col([leaf("c"), inner]);
    expect(topColumns(tree)).toEqual([tree]); // old (wrong-for-width) view
    expect(widthColumns(tree)).toEqual([a, b]); // fixed view
  });

  it("a plain vertical stack picks one leaf (stacked cells share one width)", () => {
    const a = leaf("a");
    const b = leaf("b");
    // Both leaves cap at the same max width, so the first is chosen; the result
    // is a single width-column (the stack renders all at one shared width).
    expect(widthColumns(col([a, b]))).toEqual([a]);
  });

  it("picks the WIDEST stacked child when extents differ", () => {
    // column[ leaf, row[x,y] ]: the row is wider (2 columns), so it wins.
    const x = leaf("x");
    const y = leaf("y");
    const wideRow = row([x, y]);
    const tree = col([leaf("solo"), wideRow]);
    expect(widthColumns(tree)).toEqual([x, y]);
  });

  it("recurses through nested column wrappers", () => {
    const a = leaf("a");
    const b = leaf("b");
    const tree = col([col([row([a, b])])]);
    expect(widthColumns(tree)).toEqual([a, b]);
  });

});

// ===========================================================================
// dockToRegionEdge -- top/bottom wraps in a column split with 50/50 weights
// (LEAD 2), independent of the existing subtree's leftover weight.
// ===========================================================================
describe("dockToRegionEdge top/bottom: equal vertical split (no weight leak)", () => {
  it("wrapping a heavy-weighted row puts BOTH children at equal weight", () => {
    // Existing region is a row whose root weight is a leftover pixel value (300).
    // Docking C above must NOT inherit 300 as a vertical proportion -- the new
    // column split must be 50/50 so C does not collapse.
    const a = leaf("a", 297);
    const b = leaf("b", 297);
    const existing = row([a, b], 300); // leftover px root weight
    const l = layoutWith(existing, "a", "b");
    l.groups["c"] = group("c");

    const out = dockToRegionEdge(l, ["c"], "left", "top");
    const root = asSplit(out.docked.left);
    expect(root.dir).toBe("column");
    // Two children: [C, row[A,B]] (C first, dragged-first for "top").
    expect(root.children).toHaveLength(2);
    expect(root.children.map((c) => c.weight)).toEqual([1, 1]); // 50/50
    // C is on top; the row is preserved underneath.
    expect(collectLeafGroups(root.children[0])).toEqual(["c"]);
    expect(collectLeafGroups(root.children[1]).sort()).toEqual(["a", "b"]);
  });

  it("bottom side puts the dragged panel last, still 50/50", () => {
    const existing = row([leaf("a", 250), leaf("b", 250)], 250);
    const l = layoutWith(existing, "a", "b");
    l.groups["c"] = group("c");
    const out = dockToRegionEdge(l, ["c"], "left", "bottom");
    const root = asSplit(out.docked.left);
    expect(root.dir).toBe("column");
    expect(root.children.map((c) => c.weight)).toEqual([1, 1]);
    expect(collectLeafGroups(root.children[1])).toEqual(["c"]); // dragged last
  });
});

// ===========================================================================
// LEAD 2 (per-panel "above just this one"): dropOnDockedLeaf top/bottom wraps the
// target leaf in a 50/50 column split and PRESERVES the leaf's horizontal weight
// on the wrapper (so the column keeps its width; the new band is ~50% height).
// ===========================================================================
describe("dropOnDockedLeaf top/bottom: 50/50 split, width preserved", () => {
  function regionLayout(): { l: DockLayout; targetId: string } {
    // Right region [A(297) | B(297)] -- drop C above A.
    const a: DockNode = { type: "leaf", id: "La", group: "a", weight: 297 };
    const b: DockNode = { type: "leaf", id: "Lb", group: "b", weight: 297 };
    const tree: DockNode = {
      type: "split",
      id: "S",
      dir: "row",
      weight: 1,
      children: [a, b],
    };
    const l: DockLayout = {
      groups: groups("a", "b", "c"),
      docked: { left: null, right: tree },
      floating: [{ id: "w", x: 0, y: 0, width: 280, stack: ["c"] }],
    };
    return { l, targetId: "La" };
  }

  it("above A: column[C, A] is 50/50 and keeps A's width on the wrapper", () => {
    const { l, targetId } = regionLayout();
    const out = dropOnDockedLeaf(l, ["c"], "right", targetId, "top");
    const root = asSplit(out.docked.right);
    // The first column (where A was) is now a column split [C, A].
    const aCol = root.children[0];
    const wrap = asSplit(aCol);
    expect(wrap.dir).toBe("column");
    expect(wrap.children.map((x) => x.weight)).toEqual([1, 1]); // 50/50 height
    expect(collectLeafGroups(wrap.children[0])).toEqual(["c"]); // C on top
    expect(collectLeafGroups(wrap.children[1])).toEqual(["a"]);
    // The wrapper preserves A's horizontal weight (297) so the column keeps width.
    expect(wrap.weight).toBe(297);
    // B is untouched.
    expect(root.children[1].weight).toBe(297);
  });

  it("below A: column[A, C] is 50/50 (dragged last)", () => {
    const { l, targetId } = regionLayout();
    const out = dropOnDockedLeaf(l, ["c"], "right", targetId, "bottom");
    const wrap = asSplit(asSplit(out.docked.right).children[0]);
    expect(wrap.dir).toBe("column");
    expect(wrap.children.map((x) => x.weight)).toEqual([1, 1]);
    expect(collectLeafGroups(wrap.children[1])).toEqual(["c"]); // dragged last
  });
});

// ===========================================================================
// LEAD 1 -- the column-rooted width result is sound: min/max width come from the
// inner row (side-by-side), not from a single column.
// ===========================================================================
describe("column-rooted region width bounds reflect the inner row", () => {
  it("widthColumns of the column root preserves the inner side-by-side widths", () => {
    // Simulate what applyOp does: width is the SUM of the inner row's columns.
    const a = leaf("a", 300);
    const b = leaf("b", 300);
    const tree = col([leaf("c", 1), row([a, b], 1)]);
    const cols = widthColumns(tree);
    const sum = cols.reduce((s, c) => s + c.weight, 0);
    expect(cols.map((c) => collectLeafGroups(c)[0])).toEqual(["a", "b"]);
    expect(sum).toBe(600); // NOT 300 (one column) -- both columns counted.
  });
});

// ===========================================================================
// RegionResizer clamp invariant: for a column-rooted region with UNEQUAL inner
// columns, the per-column clamp (built from widthColumns + min/maxRegionWidth)
// keeps every inner column within [min, max] when the whole region is scaled.
// This mirrors the clamp in DockManager.RegionResizer.onResize.
// ===========================================================================
describe("RegionResizer clamp bounds for a column-rooted unequal region", () => {
  /** Reproduce the clamp computation from DockManager for a region `tree`. */
  function clampBounds(tree: DockNode): { lo: number; hi: number } {
    let lo = minRegionWidth(tree);
    let hi = Math.max(lo, maxRegionWidth(tree));
    const cols = widthColumns(tree);
    const totalW = cols.reduce((s, c) => s + c.weight, 0) || 1;
    for (const c of cols) {
      const prop = c.weight / totalW;
      if (prop <= 0) continue;
      lo = Math.max(lo, minRegionWidth(c) / prop);
      hi = Math.min(hi, maxRegionWidth(c) / prop);
    }
    if (lo > hi) lo = hi;
    return { lo, hi };
  }

  it("a column root with an unequal inner row clamps so the smaller column keeps its min", () => {
    // column[C, row[A(400), B(200)]]: B is 1/3 of the width. At the region's lo
    // bound, B must still be >= MIN_PANEL_WIDTH_PX.
    const tree = col([leaf("c", 1), row([leaf("a", 400), leaf("b", 200)], 1)]);
    const { lo, hi } = clampBounds(tree);
    // B proportion = 200/600; min region so B >= 220 is 220 / (1/3) = 660.
    expect(lo).toBeCloseTo(MIN_PANEL_WIDTH_PX / (200 / 600), 0);
    // At lo, scaled B width >= the per-panel min.
    expect(lo * (200 / 600)).toBeGreaterThanOrEqual(MIN_PANEL_WIDTH_PX - 0.5);
    // At hi, the larger column A must not exceed its per-panel max.
    expect(hi * (400 / 600)).toBeLessThanOrEqual(MAX_PANEL_WIDTH_PX + 0.5);
    expect(lo).toBeLessThanOrEqual(hi);
  });

  it("matches plain summed bounds for a column root with an EQUAL inner row", () => {
    const tree = col([leaf("c", 1), row([leaf("a", 1), leaf("b", 1)], 1)]);
    const { lo, hi } = clampBounds(tree);
    // Equal columns (prop = 0.5 each):
    // - lo: the summed row min WITH the 7px divider (447) beats the per-column
    //   min/0.5 = 2*min (440), so the divider-inclusive summed min wins.
    // - hi: the per-column max/0.5 = 2*max (1200) is TIGHTER than the summed max
    //   with divider (1207), so the per-column bound wins (keeps each <= its max).
    expect(lo).toBeCloseTo(MIN_PANEL_WIDTH_PX * 2 + SPLIT_DIVIDER_PX, 0);
    expect(hi).toBeCloseTo(MAX_PANEL_WIDTH_PX * 2, 0);
  });
});
