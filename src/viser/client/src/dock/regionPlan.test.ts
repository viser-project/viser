// Tests for planRegion -- THE classification every width consumer derives
// from. Post-D20/D21 the plan is deliberately small: every width-determining
// column carries pixels (minimized cells are in-place bars at their column's
// width), chrome is just the inter-column dividers, and the only 36px form is
// the railed column's strip, counted inside regionWidth by reconciliation --
// uniformly, single columns included (the always-px weights migration retired
// the packed-single carve-out, so plannedReservedWidth has no packed
// override).

import { describe, expect, it } from "vitest";
import { setColumnRailed, railRegion, toggleCollapsed } from "./layoutOps";
import { planRegion, plannedReservedWidth } from "./regionPlan";
import { emptyLayout, MINIMIZED_STRIP_PX, SPLIT_DIVIDER_PX } from "./types";
import { reconcileRegionWidths } from "./widthReconciliation";
import {
  leaf,
  row,
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
    expect(plan.chromePx).toBe(0);
    expect(plannedReservedWidth(plan, 300)).toBe(300);
  });

  it("a RAILED width-column swaps its px for the strip width (D28/D38/D40)", () => {
    // regionWidth is the rendered content need, maintained by
    // reconciliation: railing a width-row column moves it by exactly
    // (weight - 36), so the reserved width swaps the column's px for the
    // fixed strip while the weight keeps the P8 restore width.
    const l = emptyLayout();
    l.groups = groups("a", "b");
    l.docked.left = toRegion(row([leaf("a", 150), leaf("b", 150)]));
    l.regionWidth = { left: 300, right: 300 };
    const next = setColumnRailed(l, "left", l.docked.left!.columns[0].id, true);
    reconcileRegionWidths(l, next);
    expect(next.regionWidth!.left).toBe(150 + MINIMIZED_STRIP_PX);
    // The railed column's WEIGHT is untouched (P8 restore width).
    expect(next.docked.left!.columns[0].weight).toBe(150);
    const plan = planRegion(next.docked.left!);
    expect(plannedReservedWidth(plan, next.regionWidth!.left)).toBe(
      150 + MINIMIZED_STRIP_PX + SPLIT_DIVIDER_PX,
    );
  });

  it("two side-by-side columns: divider chrome only", () => {
    const plan = planOf(row([leaf("a"), leaf("b")]));
    expect(plan.columns).toHaveLength(2);
    expect(plan.chromePx).toBe(SPLIT_DIVIDER_PX);
    expect(plannedReservedWidth(plan, 300)).toBe(300 + SPLIT_DIVIDER_PX);
  });

  it("a column stacking 2 leaves is ONE column (shared width)", () => {
    const plan = planOf(col([leaf("a"), leaf("b")]));
    expect(plan.columns).toHaveLength(1);
    expect(plan.chromePx).toBe(0);
  });

  it("an ALL-RAILED region with NOTHING expanded reserves rails + chrome", () => {
    // Pure rails: railing every column walks regionWidth down to exactly
    // the rails (D40/D46) -- an all-railed region never reserves a phantom
    // content width (zones audit W14). Built with the chevron op directly:
    // setColumnRailed is a bare flag flip (no D43 accordion anymore).
    const l = emptyLayout();
    l.groups = groups("a", "b");
    l.docked.right = toRegion(row([leaf("a", 150), leaf("b", 150)]));
    l.regionWidth = { left: 300, right: 300 };
    const cols = l.docked.right!.columns;
    const cur = setColumnRailed(l, "right", cols[0].id, true);
    reconcileRegionWidths(l, cur);
    const next = setColumnRailed(cur, "right", cols[1].id, true);
    reconcileRegionWidths(cur, next);
    expect(next.regionWidth!.right).toBe(2 * MINIMIZED_STRIP_PX);
    const plan = planRegion(next.docked.right!);
    expect(plannedReservedWidth(plan, next.regionWidth!.right)).toBe(
      2 * MINIMIZED_STRIP_PX + SPLIT_DIVIDER_PX,
    );
  });

  it("a packed MULTI-column region reserves its true strip run (D46)", () => {
    // Reconciliation pins a fully railed 2-column region's regionWidth to
    // 2 x 36; reserved = that plus divider chrome. No packed override
    // exists anymore: a packed SINGLE-column region reconciles to 36 the
    // same way (its restore width lives in the column weight, D40).
    const plan = planOf(row([leaf("a"), leaf("b")]));
    expect(plannedReservedWidth(plan, 2 * MINIMIZED_STRIP_PX)).toBe(
      2 * MINIMIZED_STRIP_PX + SPLIT_DIVIDER_PX,
    );
  });
});

describe("reconcile: collapse round-trips through the column weight (D20/D40)", () => {
  it("minimizing a lone panel (rails its column, D46) packs to the strip; the weight keeps the restore px", () => {
    const l = emptyLayout();
    l.groups = groups("a");
    l.docked.right = toRegion(leaf("a", 320));
    l.regionWidth = { left: 0, right: 320 };
    // A sole docked panel's toggle rails its COLUMN (the packed region).
    const next = toggleCollapsed(l, "a");
    reconcileRegionWidths(l, next);
    // The packed single region reserves exactly its rail -- like every
    // other packed region (always-px weights: no regionWidth carve-out).
    expect(next.regionWidth!.right).toBe(MINIMIZED_STRIP_PX);
    // The restore width stays in the column weight (P8/D40).
    expect(next.docked.right!.columns[0].weight).toBe(320);
    const plan = planRegion(next.docked.right!);
    expect(plannedReservedWidth(plan, next.regionWidth!.right)).toBe(
      MINIMIZED_STRIP_PX,
    );
    // Expanding restores exactly (weight -> rendered need).
    const restored = toggleCollapsed(next, "a");
    reconcileRegionWidths(next, restored);
    expect(restored.regionWidth!.right).toBe(320);
  });

  it("explicit region collapse keeps the restore width in the weight", () => {
    const l = emptyLayout();
    l.groups = groups("a");
    l.docked.right = toRegion(leaf("a", 320));
    l.regionWidth = { left: 0, right: 320 };
    const collapsed = railRegion(l, "right");
    reconcileRegionWidths(l, collapsed);
    // Drawn AND model: the rail (D40 uniform pack width).
    expect(collapsed.regionWidth!.right).toBe(MINIMIZED_STRIP_PX);
    expect(collapsed.docked.right!.columns[0].weight).toBe(320);
    const plan = planRegion(collapsed.docked.right!);
    expect(plannedReservedWidth(plan, collapsed.regionWidth!.right)).toBe(
      MINIMIZED_STRIP_PX,
    );
  });
});
