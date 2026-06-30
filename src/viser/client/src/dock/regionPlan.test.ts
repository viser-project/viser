// Tests for planRegion -- THE classification every width consumer derives
// from. The cases mirror the render contract documented in regionPlan.ts;
// the drop-below-strip case is a regression guard for a real bug where
// widthColumns-based helpers disagreed with the render and squeezed an
// expanded panel into a 36px region.

import { describe, expect, it } from "vitest";
import { toggleCollapsed } from "./layoutOps";
import {
  canvasFacingStripOffsetPx,
  planRegion,
  plannedReservedWidth,
} from "./regionPlan";
import {
  emptyLayout,
  MINIMIZED_STRIP_PX,
  SPLIT_DIVIDER_PX,
} from "./types";
import { reconcileRegionWidths } from "./widthReconciliation";
import {
  leaf,
  row,
  col,
  groupsRecord as groups,
  toRegion,
  TreeSpec,
} from "./testUtils";
import type { TabGroup } from "./types";

// planRegion takes a DockRegion now; the tests build specs, so wrap them.
const planOf = (spec: TreeSpec, g: Record<string, TabGroup>) =>
  planRegion(toRegion(spec)!, g);

describe("planRegion", () => {
  it("expanded single leaf: one expanded column, no chrome", () => {
    const plan = planOf(leaf("a"), groups(["a"]));
    expect(plan.hasExpanded).toBe(true);
    expect(plan.isStrip).toEqual([false]);
    expect(plan.singleColumn).toBe(true);
    expect(plan.chromePx).toBe(0);
    expect(plannedReservedWidth(plan, 300)).toBe(300);
  });

  it("fully-minimized single leaf: one strip, no regionWidth contribution", () => {
    const plan = planOf(leaf("a"), groups(["a", true]));
    expect(plan.hasExpanded).toBe(false);
    expect(plan.isStrip).toEqual([true]);
    expect(plan.chromePx).toBe(MINIMIZED_STRIP_PX);
    expect(plannedReservedWidth(plan, 300)).toBe(MINIMIZED_STRIP_PX);
  });

  it("row with one strip and one expanded column", () => {
    const tree = row([leaf("a"), leaf("b")]);
    const plan = planOf(tree, groups(["a", true], ["b"]));
    expect(plan.hasExpanded).toBe(true);
    expect(plan.isStrip).toEqual([true, false]);
    expect(plan.expandedColumns.length).toBe(1);
    expect(plan.chromePx).toBe(MINIMIZED_STRIP_PX + SPLIT_DIVIDER_PX);
  });

  it("fully-minimized row: every column is a strip", () => {
    const tree = row([leaf("a"), leaf("b")]);
    const plan = planOf(tree, groups(["a", true], ["b", true]));
    expect(plan.hasExpanded).toBe(false);
    expect(plan.isStrip).toEqual([true, true]);
    expect(plan.chromePx).toBe(2 * MINIMIZED_STRIP_PX + SPLIT_DIVIDER_PX);
  });

  it("REGRESSION: collapsed leaf stacked above an expanded one is NOT a strip", () => {
    // column[collapsed a, expanded b]: renders full-width (the collapsed
    // leaf is a horizontal bar), regardless of which child widthColumns
    // surfaces as width-determining.
    const tree = col([leaf("a"), leaf("b")]);
    const plan = planOf(tree, groups(["a", true], ["b"]));
    expect(plan.hasExpanded).toBe(true);
    expect(plan.isStrip).toEqual([false]);
    expect(plan.chromePx).toBe(0);
    expect(plannedReservedWidth(plan, 320)).toBe(320);
  });
});

describe("reconcile: dropping an expanded panel below a strip", () => {
  it("restores the region to the preserved width, not strip width", () => {
    // Region = single minimized leaf (a strip) with preserved width 320.
    const l = emptyLayout();
    l.groups = groups(["a"], ["b"]);
    l.docked.right = toRegion(leaf("a", 320));
    l.regionWidth = { left: 0, right: 320 };
    const prev = toggleCollapsed(l, "a");
    reconcileRegionWidths(l, prev);

    // Drop b BELOW the strip: the single column gains leaf b (collapsed a above,
    // expanded b below) -- a single-column region that renders full-width.
    const next = structuredClone(prev);
    next.docked.right!.columns[0].leaves.push({
      id: "Lb",
      group: "b",
      weight: 1,
    });
    reconcileRegionWidths(prev, next);
    expect(next.regionWidth!.right).toBe(320);
    // And the rendered region uses that width (no strip chrome).
    const plan = planRegion(next.docked.right!, next.groups);
    expect(plannedReservedWidth(plan, next.regionWidth!.right)).toBe(320);
  });
});
describe("canvasFacingStripOffsetPx", () => {
  const STRIP_AND_DIVIDER = MINIMIZED_STRIP_PX + SPLIT_DIVIDER_PX;

  it("RIGHT region: [strip][expanded] offsets past the leading strip", () => {
    // The user's case -- handle should sit between the strip and the expanded
    // panel, i.e. offset inward by one strip + its divider.
    const plan = planOf(row([leaf("a"), leaf("b")]), groups(["a", true], ["b"]));
    expect(canvasFacingStripOffsetPx(plan, "right")).toBe(STRIP_AND_DIVIDER);
  });

  it("RIGHT region: [expanded][strip] -- strip is NOT canvas-facing, offset 0", () => {
    const plan = planOf(row([leaf("a"), leaf("b")]), groups(["a"], ["b", true]));
    expect(canvasFacingStripOffsetPx(plan, "right")).toBe(0);
  });

  it("LEFT region: [expanded][strip] offsets past the trailing strip", () => {
    // On a left edge the canvas is on the RIGHT, so a trailing strip is the
    // canvas-facing one.
    const plan = planOf(row([leaf("a"), leaf("b")]), groups(["a"], ["b", true]));
    expect(canvasFacingStripOffsetPx(plan, "left")).toBe(STRIP_AND_DIVIDER);
  });

  it("LEFT region: [strip][expanded] -- leading strip is away from canvas, offset 0", () => {
    const plan = planOf(row([leaf("a"), leaf("b")]), groups(["a", true], ["b"]));
    expect(canvasFacingStripOffsetPx(plan, "left")).toBe(0);
  });

  it("counts MULTIPLE contiguous canvas-facing strips", () => {
    const plan = planOf(
      row([leaf("a"), leaf("b"), leaf("c")]),
      groups(["a", true], ["b", true], ["c"]),
    );
    expect(canvasFacingStripOffsetPx(plan, "right")).toBe(2 * STRIP_AND_DIVIDER);
  });

  it("no expanded columns (fully minimized) -> 0 (nothing to resize)", () => {
    const plan = planOf(row([leaf("a"), leaf("b")]), groups(["a", true], ["b", true]));
    expect(canvasFacingStripOffsetPx(plan, "right")).toBe(0);
  });

  it("no strips -> 0", () => {
    const plan = planOf(row([leaf("a"), leaf("b")]), groups(["a"], ["b"]));
    expect(canvasFacingStripOffsetPx(plan, "right")).toBe(0);
  });
});
