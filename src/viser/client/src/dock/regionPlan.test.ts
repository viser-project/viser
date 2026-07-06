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

  it("a RAILED width-column swaps its share for the strip width (D28/D38)", () => {
    const l = emptyLayout();
    l.groups = groups("a", "b");
    l.docked.left = toRegion(row([leaf("a"), leaf("b")]));
    l.docked.left!.rows[0].columns[0].railed = true;
    const plan = planRegion(l.docked.left!);
    // Equal weights: the expanded column keeps half of 300, the railed one
    // renders at the fixed strip, plus the divider chrome.
    expect(plannedReservedWidth(plan, 300, false)).toBe(
      150 + MINIMIZED_STRIP_PX + SPLIT_DIVIDER_PX,
    );
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

  it("an ALL-RAILED width band with an expanded sibling band keeps content width", () => {
    const l = emptyLayout();
    l.groups = groups("a", "b", "c");
    l.docked.right = toRegion(
      rows([row([leaf("a"), leaf("b")]), row([leaf("c")])]),
    );
    const band = l.docked.right!.rows[0];
    band.columns[0].railed = true;
    band.columns[1].railed = true;
    const plan = planRegion(l.docked.right!);
    // The width-determining band is all rails, but band 2 (c) is expanded
    // content: the region must keep its content width, not shrink to rail
    // chrome (which squished c to ~strip width).
    expect(plan.hasExpandedContent).toBe(true);
    expect(plannedReservedWidth(plan, 300, false)).toBe(300 + SPLIT_DIVIDER_PX);
  });

  it("an EXPLICITLY collapsed region reserves exactly the rail width (D21)", () => {
    const plan = planOf(row([leaf("a"), leaf("b")]));
    expect(plannedReservedWidth(plan, 300, true)).toBe(MINIMIZED_STRIP_PX);
  });
});

describe("reconcile: collapse states never move region width (D20)", () => {
  it("minimizing a lone panel (region store, D38) keeps the preserved width", () => {
    const l = emptyLayout();
    l.groups = groups("a");
    l.docked.right = toRegion(leaf("a", 320));
    l.regionWidth = { left: 0, right: 320 };
    // A sole docked panel's toggle targets the REGION store (D32/D38).
    const next = toggleCollapsed(l, "a");
    reconcileRegionWidths(l, next);
    expect(next.regionWidth!.right).toBe(320);
    const plan = planRegion(next.docked.right!);
    // Model width preserved; the rail is drawn via the region-collapsed arg.
    expect(plannedReservedWidth(plan, next.regionWidth!.right, false)).toBe(
      320,
    );
  });

  it("explicit region collapse keeps the model width for restore", () => {
    const l = emptyLayout();
    l.groups = groups("a");
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
