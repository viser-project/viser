// Tests for the region-width model: layout.regionWidth tracks only the
// EXPANDED width-columns' pixels; minimized columns keep their preserved px
// in their weight but render as fixed strips ON TOP of regionWidth. The
// width lives in the layout itself (single source of truth), and
// reconciliation -- run on every commit -- must (a) recompute the expanded
// sum when a column's minimized state flips, (b) exclude minimized columns
// from structural-change sums, and (c) leave pure-internal changes alone.

import { describe, expect, it } from "vitest";
import { toggleCollapsed } from "./layoutOps";
import { DockEdge, DockLayout, emptyLayout, regionWidthsOf } from "./types";
import { reconcileRegionWidths } from "./widthReconciliation";
import { leaf, row, group } from "./testUtils";

/** Reconcile and return next's resulting widths (the new single source). */
function recon(prev: DockLayout, next: DockLayout): Record<DockEdge, number> {
  reconcileRegionWidths(prev, next);
  return regionWidthsOf(next);
}

/** Layout with three side-by-side right-docked columns at px weights. */
function threeColumns(widths: [number, number, number]): DockLayout {
  const l = emptyLayout();
  l.groups = { a: group("a"), b: group("b"), c: group("c") };
  l.docked.right = row([
    leaf("a", widths[0]),
    leaf("b", widths[1]),
    leaf("c", widths[2]),
  ]);
  l.regionWidth = { left: 0, right: widths[0] + widths[1] + widths[2] };
  return l;
}

describe("reconcileRegionWidths with minimized columns", () => {
  it("collapse toggle drops the column from the expanded sum", () => {
    const prev = threeColumns([300, 300, 300]);
    const next = toggleCollapsed(prev, "b");
    expect(recon(prev, next).right).toBe(600); // a + c only; b is a strip.
  });

  it("expand toggle rejoins at the preserved pixel weight", () => {
    const prev0 = threeColumns([300, 300, 300]);
    const prev = toggleCollapsed(prev0, "b"); // b minimized
    expect(recon(prev0, prev).right).toBe(600);
    const next = toggleCollapsed(prev, "b"); // b expands again
    expect(recon(prev, next).right).toBe(900); // b's preserved 300 rejoins.
  });

  it("two of three minimized: sum is the lone expanded column", () => {
    const prev = threeColumns([300, 280, 320]);
    const mid = toggleCollapsed(prev, "a");
    recon(prev, mid);
    const next = toggleCollapsed(mid, "b");
    expect(recon(mid, next).right).toBe(320); // only c is expanded.
  });

  it("fully minimized keeps the previous width for restore", () => {
    const prev = threeColumns([300, 300, 300]);
    let next = toggleCollapsed(prev, "a");
    next = toggleCollapsed(next, "b");
    next = toggleCollapsed(next, "c");
    // No expanded columns left: regionWidth keeps its value (the strips render
    // at fixed width regardless; the value only matters again on expand).
    expect(recon(prev, next).right).toBe(900);
  });

  it("pure-internal change (same set, same pattern) leaves widths alone", () => {
    const prev = threeColumns([300, 300, 300]);
    const next = structuredClone(prev);
    expect(recon(prev, next)).toEqual({ left: 0, right: 900 });
  });

  it("structural change sums only the expanded columns", () => {
    // Start with [a expanded 400, b minimized 200]; undock a -> [b] alone.
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.docked.right = row([leaf("a", 400), leaf("b", 250)]);
    l.regionWidth = { left: 0, right: 650 };
    const prev = toggleCollapsed(l, "b");
    expect(recon(l, prev).right).toBe(400);

    // Remove a's column entirely (structural: column set changes).
    const next = structuredClone(prev);
    const tree = next.docked.right!;
    if (tree.type === "split") next.docked.right = tree.children[1];
    // The only remaining column is minimized: fall back to its preserved px.
    expect(recon(prev, next).right).toBe(250);
  });

  it("restoring a snapshot onto an empty edge keeps the preserved width", () => {
    // regression: Escape after an undock restores the layout snapshot; the
    // re-appearing single column must come back at the edge's preserved
    // width (carried in the layout), not the default.
    const docked = threeColumns([460, 0, 0]);
    docked.docked.right = leaf("a", 1); // single column, weight is NOT px
    docked.groups = { a: group("a") };
    docked.regionWidth = { left: 0, right: 460 };
    const floated = structuredClone(docked);
    floated.docked.right = null; // the column floated away; width preserved.
    expect(recon(docked, floated).right).toBe(460);
    const restored = structuredClone(docked);
    expect(recon(floated, restored).right).toBe(460);
  });
});

describe("reconcileRegionWidths min-width floor", () => {
  it("raises a too-narrow width to the expanded columns' summed minimum", () => {
    // Two 220px-minimum columns + divider = 447; a carried width of 300 is
    // unrepresentable and must be floored on commit (replaces the old
    // auto-grow effect).
    const prev = emptyLayout();
    prev.groups = { a: group("a") };
    prev.docked.right = leaf("a", 1);
    prev.regionWidth = { left: 0, right: 300 };
    const next = structuredClone(prev);
    next.groups["b"] = group("b");
    next.docked.right = row([leaf("a", 300), leaf("b", 300)]);
    expect(recon(prev, next).right).toBeGreaterThanOrEqual(447);
  });
});
