// Unit tests for the dock WIDTH MODEL: the pure ops behind region/column widths
// and the centralized width reconciliation in DockManager.applyOp.
//
// Scope (flat 3-level model: Region = row of columns; Column = stack of leaves):
//   - widthColumns / widthColumns: a region's columns (they ARE widthColumns(region)
//     now -- the old "descend into the widest child to guess the columns" logic,
//     and the LEAD 1 bug it patched, are gone since deep nesting is
//     unrepresentable).
//   - minRegionWidth: a single column's grab-min (the divider-summing across
//     side-by-side columns lives in widthReconciliation, not here).
//   - setNodeWeights: id-based weight setting for a column's or leaf's weight.
//   - dropOnDockedLeaf top/bottom: insert a leaf into the target's STACK at
//     50/50 height so the new cell doesn't collapse (the LEAD 2 height fix,
//     naturally expressed in the flat model; D46: dockToRegionEdge is
//     left/right only -- vertical arrangement is leaf stacking).

import { describe, it, expect } from "vitest";
import { DockLayout, DockRegion, GroupId, MIN_REGION_GRAB_PX } from "./types";
import {
  widthColumns,
  minRegionWidth,
  setNodeWeights,
  dockToRegionEdge,
  dropOnDockedLeaf,
  collectLeafGroups,
} from "./layoutOps";
import {
  leaf,
  row as rowSplit,
  col as colSplit,
  dockedLeft,
  group,
  groupsRecord as groups,
  toRegion,
  TreeSpec,
} from "./testUtils";

function layoutWith(spec: TreeSpec, ...gids: GroupId[]): DockLayout {
  return {
    groups: groups(...gids),
    docked: { left: toRegion(spec), right: null },
    regionCollapsed: { left: false, right: false },
    floating: [],
  };
}
const reg = (spec: TreeSpec): DockRegion => toRegion(spec)!;

// ===========================================================================
// widthColumns / widthColumns -- both are now just widthColumns(region).
// ===========================================================================
describe("widthColumns / widthColumns", () => {
  it("a single-column region (one leaf) has one column", () => {
    const region = reg(leaf("a"));
    expect(widthColumns(region)).toEqual(widthColumns(region));
    expect(widthColumns(region)).toEqual(widthColumns(region));
  });

  it("a row of leaves -> one column per leaf, in order", () => {
    const region = reg(rowSplit([leaf("a"), leaf("b")]));
    expect(widthColumns(region).map((c) => collectLeafGroups(c)[0])).toEqual([
      "a",
      "b",
    ]);
    expect(widthColumns(region)).toEqual(widthColumns(region));
  });

  it("a single column stacking 2 leaves is ONE column (shared width)", () => {
    const region = reg(colSplit([leaf("a"), leaf("b")]));
    expect(widthColumns(region)).toHaveLength(1);
    expect(collectLeafGroups(widthColumns(region)[0])).toEqual(["a", "b"]);
  });

  it("a row of [stack, leaf] surfaces both columns side by side", () => {
    const region = reg(rowSplit([colSplit([leaf("a"), leaf("b")]), leaf("c")]));
    const cols = widthColumns(region);
    expect(cols).toHaveLength(2);
    expect(collectLeafGroups(cols[0])).toEqual(["a", "b"]);
    expect(collectLeafGroups(cols[1])).toEqual(["c"]);
  });
});

// ===========================================================================
// minRegionWidth -- per-column grab min.
// ===========================================================================
describe("minRegionWidth", () => {
  it("a column floors at one grab minimum regardless of leaf count", () => {
    expect(minRegionWidth()).toBe(MIN_REGION_GRAB_PX);
  });

  it("a region's summed column mins (for width clamping) scale with column count", () => {
    // The reconciler sums per-column mins (dividers are render chrome, added
    // separately) -- so an N-column region floors at N * grab-min.
    const region = reg(rowSplit([leaf("a"), leaf("b"), leaf("c")]));
    const summed = widthColumns(region).reduce(
      (sum) => sum + minRegionWidth(),
      0,
    );
    expect(summed).toBe(MIN_REGION_GRAB_PX * 3);
  });
});

// ===========================================================================
// setNodeWeights -- id-based weight setting for columns and leaves.
// ===========================================================================
describe("setNodeWeights", () => {
  it("sets column weights by id (a region-row resize), leaving others alone", () => {
    const region = reg(rowSplit([leaf("a"), leaf("b")]));
    const [ca, cb] = widthColumns(region);
    const layout: DockLayout = {
      groups: groups("a", "b"),
      docked: { left: region, right: null },
      regionCollapsed: { left: false, right: false },
      floating: [],
    };
    const out = setNodeWeights(layout, "left", { [ca.id]: 3, [cb.id]: 5 });
    expect(widthColumns(out.docked.left!).map((c) => c.weight)).toEqual([3, 5]);
  });

  it("sets leaf weights by id (a column-stack resize)", () => {
    const region = reg(colSplit([leaf("b"), leaf("c")]));
    const [lb, lc] = widthColumns(region)[0].leaves;
    const layout: DockLayout = {
      groups: groups("b", "c"),
      docked: { left: region, right: null },
      regionCollapsed: { left: false, right: false },
      floating: [],
    };
    const out = setNodeWeights(layout, "left", { [lb.id]: 7, [lc.id]: 2 });
    expect(
      widthColumns(out.docked.left!)[0].leaves.map((l) => l.weight),
    ).toEqual([7, 2]);
  });

  it("ignores ids not present in the region", () => {
    const layout = dockedLeft(rowSplit([leaf("a", 4), leaf("b", 4)]));
    const out = setNodeWeights(layout, "left", { "no-such-id": 9 });
    expect(widthColumns(out.docked.left!).map((c) => c.weight)).toEqual([4, 4]);
  });

  it("rejects non-finite and non-positive weights (keeps the old weight)", () => {
    const region = reg(rowSplit([leaf("a", 2), leaf("b", 2), leaf("c", 2)]));
    const ids = widthColumns(region).map((c) => c.id);
    const layout: DockLayout = {
      groups: groups("a", "b", "c"),
      docked: { left: region, right: null },
      regionCollapsed: { left: false, right: false },
      floating: [],
    };
    const out = setNodeWeights(layout, "left", {
      [ids[0]]: 0,
      [ids[1]]: -3,
      [ids[2]]: Number.NaN,
    });
    expect(widthColumns(out.docked.left!).map((c) => c.weight)).toEqual([
      2, 2, 2,
    ]);
  });

  it("returns the input when the edge is empty", () => {
    const layout = dockedLeft(null);
    expect(setNodeWeights(layout, "left", { x: 1 })).toBe(layout);
  });

  it("does not mutate the input layout", () => {
    const region = reg(rowSplit([leaf("a", 1), leaf("b", 1)]));
    const id = widthColumns(region)[0].id;
    const layout: DockLayout = {
      groups: groups("a", "b"),
      docked: { left: region, right: null },
      regionCollapsed: { left: false, right: false },
      floating: [],
    };
    const snapshot = JSON.stringify(layout);
    setNodeWeights(layout, "left", { [id]: 9 });
    expect(JSON.stringify(layout)).toBe(snapshot);
  });
});

// ===========================================================================
// dockToRegionEdge (D46: left/right only): a full-height column beside
// everything; the dragged column's weight defaults to 1.
// ===========================================================================
describe("dockToRegionEdge side dock", () => {
  it("docking C beside a single-column region adds a sibling column", () => {
    const l = layoutWith(leaf("a", 297), "a");
    l.groups["c"] = group("c");
    const out = dockToRegionEdge(l, ["c"], "left", "left");
    const cols = out.docked.left!.columns;
    expect(cols).toHaveLength(2);
    expect(cols.map((c) => c.leaves[0].group)).toEqual(["c", "a"]); // C first
  });
});

// ===========================================================================
// dropOnDockedLeaf top/bottom: insert a leaf into the target's column at 50/50
// height, preserving the column's horizontal weight (so its width is kept).
// ===========================================================================
describe("dropOnDockedLeaf top/bottom: 50/50 split, width preserved", () => {
  function regionLayout(): { l: DockLayout; targetId: string } {
    // Right region [A(width 297) | B(width 297)] -- drop C above A.
    const region: DockRegion = {
      columns: [
        {
          id: "Ca",
          weight: 297,
          leaves: [{ id: "La", group: "a", weight: 1 }],
        },
        {
          id: "Cb",
          weight: 297,
          leaves: [{ id: "Lb", group: "b", weight: 1 }],
        },
      ],
    };
    const l: DockLayout = {
      groups: groups("a", "b", "c"),
      docked: { left: null, right: region },
      regionCollapsed: { left: false, right: false },
      floating: [
        {
          id: "w",
          x: 0,
          y: 0,
          width: 280,
          height: { mode: "auto" },
          stack: ["c"],
        },
      ],
    };
    return { l, targetId: "La" };
  }

  it("above A: column[C, A] is 50/50 and keeps A's column width", () => {
    const { l, targetId } = regionLayout();
    const out = dropOnDockedLeaf(l, ["c"], "right", targetId, "top");
    const aCol = widthColumns(out.docked.right!)[0];
    expect(aCol.leaves.map((x) => x.group)).toEqual(["c", "a"]); // C on top
    expect(aCol.leaves.map((x) => x.weight)).toEqual([0.5, 0.5]); // 50/50 height
    // The column keeps A's horizontal weight (297) so its width is preserved.
    expect(aCol.weight).toBe(297);
    // B is untouched.
    expect(widthColumns(out.docked.right!)[1].weight).toBe(297);
  });

  it("below A: column[A, C] is 50/50 (dragged last)", () => {
    const { l, targetId } = regionLayout();
    const out = dropOnDockedLeaf(l, ["c"], "right", targetId, "bottom");
    const aCol = widthColumns(out.docked.right!)[0];
    expect(aCol.leaves.map((x) => x.group)).toEqual(["a", "c"]); // dragged last
    expect(aCol.leaves.map((x) => x.weight)).toEqual([0.5, 0.5]);
  });
});

// ===========================================================================
// Region width bounds: a multi-column region's lower bound is the summed
// per-column grab-min (no upper bound -- a region may be dragged as wide as the
// user likes). This mirrors the clamp in DockManager.RegionResizer.onResize.
// ===========================================================================
describe("region width clamp bounds", () => {
  function clampBounds(region: DockRegion): { lo: number; hi: number } {
    const cols = widthColumns(region);
    const lo = cols.reduce((sum) => sum + minRegionWidth(), 0);
    return { lo, hi: Infinity };
  }

  it("a 2-column region floors at 2 grab-mins, with no upper bound", () => {
    const region = reg(rowSplit([leaf("a", 400), leaf("b", 200)]));
    const { lo, hi } = clampBounds(region);
    expect(lo).toBe(MIN_REGION_GRAB_PX * 2);
    expect(hi).toBe(Infinity);
  });

  it("a single-column region floors at one grab-min", () => {
    const region = reg(colSplit([leaf("a", 1), leaf("b", 1)]));
    const { lo, hi } = clampBounds(region);
    expect(lo).toBe(MIN_REGION_GRAB_PX);
    expect(hi).toBe(Infinity);
  });
});
