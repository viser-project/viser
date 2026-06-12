// Tests for the region-width model: regionWidth tracks only the EXPANDED
// width-columns' pixels; minimized columns keep their preserved px in their
// weight but render as fixed strips ON TOP of regionWidth. Reconciliation
// must (a) recompute the expanded sum when a column's minimized state flips,
// (b) exclude minimized columns from structural-change sums, and (c) leave
// pure-internal changes alone.

import { describe, expect, it } from "vitest";
import { toggleCollapsed } from "./layoutOps";
import { DockLayout, emptyLayout } from "./types";
import { reconcileRegionWidths } from "./widthReconciliation";
import { leaf, row, group } from "./testUtils";

/** Layout with three side-by-side right-docked columns at px weights. */
function threeColumns(widths: [number, number, number]): DockLayout {
  const l = emptyLayout();
  l.groups = { a: group("a"), b: group("b"), c: group("c") };
  l.docked.right = row([
    leaf("a", widths[0]),
    leaf("b", widths[1]),
    leaf("c", widths[2]),
  ]);
  return l;
}

const START = { left: 0, right: 900 };

describe("reconcileRegionWidths with minimized columns", () => {
  it("collapse toggle drops the column from the expanded sum", () => {
    const prev = threeColumns([300, 300, 300]);
    const next = toggleCollapsed(prev, "b");
    const { widths, changed } = reconcileRegionWidths(prev, next, START);
    expect(changed).toBe(true);
    expect(widths.right).toBe(600); // a + c only; b renders as a strip.
  });

  it("expand toggle rejoins at the preserved pixel weight", () => {
    const prev0 = threeColumns([300, 300, 300]);
    const prev = toggleCollapsed(prev0, "b"); // b minimized
    const afterCollapse = reconcileRegionWidths(prev0, prev, START).widths;
    expect(afterCollapse.right).toBe(600);
    const next = toggleCollapsed(prev, "b"); // b expands again
    const { widths } = reconcileRegionWidths(prev, next, afterCollapse);
    expect(widths.right).toBe(900); // b's preserved 300 rejoins.
  });

  it("two of three minimized: sum is the lone expanded column", () => {
    const prev = threeColumns([300, 280, 320]);
    const mid = toggleCollapsed(prev, "a");
    const w1 = reconcileRegionWidths(prev, mid, START).widths;
    const next = toggleCollapsed(mid, "b");
    const { widths } = reconcileRegionWidths(mid, next, w1);
    expect(widths.right).toBe(320); // only c is expanded.
  });

  it("fully minimized keeps the previous width for restore", () => {
    const prev = threeColumns([300, 300, 300]);
    let next = toggleCollapsed(prev, "a");
    next = toggleCollapsed(next, "b");
    next = toggleCollapsed(next, "c");
    const { widths } = reconcileRegionWidths(prev, next, START);
    // No expanded columns left: regionWidth keeps its value (the rail renders
    // at strip width regardless; the value only matters again on expand).
    expect(widths.right).toBe(900);
  });

  it("pure-internal change (same set, same pattern) leaves widths alone", () => {
    const prev = threeColumns([300, 300, 300]);
    const next = structuredClone(prev);
    const { widths, changed } = reconcileRegionWidths(prev, next, START);
    expect(changed).toBe(false);
    expect(widths).toEqual(START);
  });

  it("structural change sums only the expanded columns", () => {
    // Start with [a expanded 400, b minimized 200]; undock a -> [b] alone.
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.docked.right = row([leaf("a", 400), leaf("b", 250)]);
    const prev = toggleCollapsed(l, "b");
    const prevW = reconcileRegionWidths(l, prev, { left: 0, right: 650 });
    expect(prevW.widths.right).toBe(400);

    // Remove a's column entirely (structural: column set changes).
    const next = structuredClone(prev);
    const tree = next.docked.right!;
    if (tree.type === "split") next.docked.right = tree.children[1];
    const { widths } = reconcileRegionWidths(prev, next, prevW.widths);
    // The only remaining column is minimized: fall back to its preserved px.
    expect(widths.right).toBe(250);
  });
});