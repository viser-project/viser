// Tests for planRegion -- THE classification every width consumer derives
// from. Post-D20/D21 the plan is deliberately small: every width-determining
// column carries pixels (minimized cells are in-place bars at their column's
// width), chrome is just the inter-column dividers, and the ONLY 36px form is
// the explicit region collapse, which plannedReservedWidth keys on directly.

import { describe, expect, it } from "vitest";
import { setRegionCollapsed, toggleCollapsed } from "./layoutOps";
import { planRegion, plannedReservedWidth } from "./regionPlan";
import { emptyLayout, MINIMIZED_STRIP_PX, SPLIT_DIVIDER_PX } from "./types";
import { reconcileRegionWidths } from "./widthReconciliation";
import {
  leaf,
  row,
  rows,
  col,
  groupsRecord as groups,
  toRegion,
  TreeSpec,
} from "./testUtils";

const planOf = (spec: TreeSpec) => planRegion(toRegion(spec)!);

describe("planRegion", () => {
  it("single leaf: one column, no chrome", () => {
    const plan = planOf(leaf("a"));
    expect(plan.columns).toHaveLength(1);
    expect(plan.singleColumn).toBe(true);
    expect(plan.chromePx).toBe(0);
    expect(plannedReservedWidth(plan, 300, false)).toBe(300);
  });

  it("a MINIMIZED single leaf still reserves the full width (bar in place, D20)", () => {
    const l = emptyLayout();
    l.groups = groups(["a", true]);
    l.docked.left = toRegion(leaf("a"));
    const plan = planRegion(l.docked.left!);
    expect(plannedReservedWidth(plan, 300, false)).toBe(300);
  });

  it("two side-by-side columns: divider chrome only", () => {
    const plan = planOf(row([leaf("a"), leaf("b")]));
    expect(plan.columns).toHaveLength(2);
    expect(plan.singleColumn).toBe(false);
    expect(plan.chromePx).toBe(SPLIT_DIVIDER_PX);
    expect(plannedReservedWidth(plan, 300, false)).toBe(300 + SPLIT_DIVIDER_PX);
  });

  it("a column stacking 2 leaves is ONE column (shared width)", () => {
    const plan = planOf(col([leaf("a"), leaf("b")]));
    expect(plan.columns).toHaveLength(1);
    expect(plan.chromePx).toBe(0);
  });

  it("width-determining row is the WIDEST band", () => {
    const plan = planOf(rows([row([leaf("a"), leaf("b")]), row([leaf("c")])]));
    expect(plan.columns).toHaveLength(2);
    expect(plan.chromePx).toBe(SPLIT_DIVIDER_PX);
  });

  it("an EXPLICITLY collapsed region reserves exactly the rail width (D21)", () => {
    const plan = planOf(row([leaf("a"), leaf("b")]));
    expect(plannedReservedWidth(plan, 300, true)).toBe(MINIMIZED_STRIP_PX);
  });
});

describe("reconcile: collapse states never move region width (D20)", () => {
  it("minimizing a lone panel keeps the preserved width", () => {
    const l = emptyLayout();
    l.groups = groups(["a"]);
    l.docked.right = toRegion(leaf("a", 320));
    l.regionWidth = { left: 0, right: 320 };
    const next = toggleCollapsed(l, "a");
    reconcileRegionWidths(l, next);
    expect(next.regionWidth!.right).toBe(320);
    const plan = planRegion(next.docked.right!);
    expect(plannedReservedWidth(plan, next.regionWidth!.right, false)).toBe(
      320,
    );
  });

  it("explicit region collapse keeps the model width for restore", () => {
    const l = emptyLayout();
    l.groups = groups(["a"]);
    l.docked.right = toRegion(leaf("a", 320));
    l.regionWidth = { left: 0, right: 320 };
    const collapsed = setRegionCollapsed(l, "right", true);
    reconcileRegionWidths(l, collapsed);
    expect(collapsed.regionWidth!.right).toBe(320);
    const plan = planRegion(collapsed.docked.right!);
    // Drawn: the rail. Model: preserved.
    expect(plannedReservedWidth(plan, 320, true)).toBe(MINIMIZED_STRIP_PX);
    // Expanding restores exactly.
    const restored = setRegionCollapsed(collapsed, "right", false);
    reconcileRegionWidths(collapsed, restored);
    expect(restored.regionWidth!.right).toBe(320);
  });
});
