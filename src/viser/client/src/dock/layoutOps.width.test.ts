// Unit tests for the width-model pure ops added in the width overhaul:
//   topColumns, maxRegionWidth, partitionDockedColumns, setNodeWeights.
// These back the centralized width reconciliation in DockManager.applyOp.

import { describe, it, expect } from "vitest";
import { DockNode, MAX_PANEL_WIDTH_PX } from "./types";
import {
  topColumns,
  maxRegionWidth,
  setNodeWeights,
} from "./layoutOps";
import { leaf, row as rowSplit, col as colSplit, dockedLeft } from "./testUtils";

// ===========================================================================
// topColumns
// ===========================================================================
describe("topColumns", () => {
  it("a bare leaf is a single column (itself)", () => {
    const n = leaf("a");
    expect(topColumns(n)).toEqual([n]);
  });

  it("a row split's children are the columns", () => {
    const a = leaf("a");
    const b = leaf("b");
    expect(topColumns(rowSplit([a, b]))).toEqual([a, b]);
  });

  it("a COLUMN split is a single column (it's one stacked column)", () => {
    const stack = colSplit([leaf("a"), leaf("b")]);
    expect(topColumns(stack)).toEqual([stack]);
  });

  it("does not descend into nested row splits (only top level)", () => {
    const inner = rowSplit([leaf("b"), leaf("c")]);
    const tree = rowSplit([leaf("a"), inner]);
    // Top columns are [a, inner] -- the nested row is one (already-flat in
    // practice, but topColumns only looks one level deep).
    expect(topColumns(tree)).toEqual([tree.type === "split" ? tree.children[0] : tree, inner]);
  });
});

// ===========================================================================
// maxRegionWidth (mirror of minRegionWidth)
// ===========================================================================
describe("maxRegionWidth", () => {
  it("a leaf caps at the per-panel max", () => {
    expect(maxRegionWidth(leaf("a"))).toBe(MAX_PANEL_WIDTH_PX);
  });

  it("a row sums children maxima plus dividers", () => {
    const divider = 6;
    expect(maxRegionWidth(rowSplit([leaf("a"), leaf("b")]), divider)).toBe(
      MAX_PANEL_WIDTH_PX * 2 + divider,
    );
  });

  it("a column (stacked) takes the max of its children (shared width)", () => {
    expect(maxRegionWidth(colSplit([leaf("a"), leaf("b")]))).toBe(MAX_PANEL_WIDTH_PX);
  });

  it("honors a custom divider width and >=2 children", () => {
    expect(maxRegionWidth(rowSplit([leaf("a"), leaf("b"), leaf("c")]), 10)).toBe(
      MAX_PANEL_WIDTH_PX * 3 + 10 * 2,
    );
  });

  it("nested: a column containing a row uses the row's summed max", () => {
    const divider = 6;
    const node = colSplit([leaf("a"), rowSplit([leaf("b"), leaf("c")])]);
    expect(maxRegionWidth(node, divider)).toBe(MAX_PANEL_WIDTH_PX * 2 + divider);
  });
});

// ===========================================================================
// setNodeWeights -- id-based weight setting (fixes M1).
// ===========================================================================
describe("setNodeWeights", () => {
  it("sets weights of the matching nodes by id, leaving others alone", () => {
    const a = leaf("a", 1);
    const b = leaf("b", 1);
    const tree = rowSplit([a, b]);
    const layout = dockedLeft(tree);
    const out = setNodeWeights(layout, "left", { [a.id]: 3, [b.id]: 5 });
    const root = out.docked.left as Extract<DockNode, { type: "split" }>;
    expect(root.children.map((c) => c.weight)).toEqual([3, 5]);
  });

  it("sets a nested node's weight by id (works on partial/synthetic subtrees)", () => {
    // The M1 case: a divider in a reserved subtree references children by their
    // own ids, so even when only some children are present the right ones update.
    const b = leaf("b", 1);
    const c = leaf("c", 1);
    const inner = rowSplit([b, c]);
    const tree = rowSplit([leaf("a", 1), inner]);
    const layout = dockedLeft(tree);
    const out = setNodeWeights(layout, "left", { [b.id]: 7, [c.id]: 2 });
    const root = out.docked.left as Extract<DockNode, { type: "split" }>;
    const nested = root.children[1] as Extract<DockNode, { type: "split" }>;
    expect(nested.children.map((x) => x.weight)).toEqual([7, 2]);
  });

  it("ignores ids not present in the tree", () => {
    const a = leaf("a", 4);
    const layout = dockedLeft(rowSplit([a, leaf("b", 4)]));
    const out = setNodeWeights(layout, "left", { "no-such-id": 9 });
    const root = out.docked.left as Extract<DockNode, { type: "split" }>;
    expect(root.children.map((c) => c.weight)).toEqual([4, 4]); // unchanged
  });

  it("rejects non-finite and non-positive weights (keeps the old weight)", () => {
    const a = leaf("a", 2);
    const b = leaf("b", 2);
    const c = leaf("c", 2);
    const layout = dockedLeft(rowSplit([a, b, c]));
    const out = setNodeWeights(layout, "left", {
      [a.id]: 0,
      [b.id]: -3,
      [c.id]: Number.NaN,
    });
    const root = out.docked.left as Extract<DockNode, { type: "split" }>;
    expect(root.children.map((x) => x.weight)).toEqual([2, 2, 2]); // all kept
  });

  it("returns the input when the edge is empty", () => {
    const layout = dockedLeft(null);
    expect(setNodeWeights(layout, "left", { x: 1 })).toBe(layout);
  });

  it("does not mutate the input layout", () => {
    const a = leaf("a", 1);
    const layout = dockedLeft(rowSplit([a, leaf("b", 1)]));
    const snapshot = JSON.stringify(layout);
    setNodeWeights(layout, "left", { [a.id]: 9 });
    expect(JSON.stringify(layout)).toBe(snapshot);
  });
});
