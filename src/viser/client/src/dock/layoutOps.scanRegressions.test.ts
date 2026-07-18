// Regression pins for the 2026-07 full-scan findings (layout core). Each test
// reproduces a bug that shipped with a green suite -- keep them small and
// literal so a regression names its finding.

import { describe, it, expect } from "vitest";
import {
  applyPanelPlacement,
  floatGroup,
  reconcilePanelMembership,
  setRegionWidth,
  snapToWindowStack,
  tearOutPane,
  dropOnDockedLeaf,
} from "./layoutOps";
import { reconcileRegionWidths } from "./widthReconciliation";
import { MINIMIZED_STRIP_PX, pinnedPxOf } from "./types";
import { col, leaf, leafIdOf, makeLayout, refCount } from "./testUtils";

describe("scan regressions: membership reconcile", () => {
  it("does not duplicate a pane the user tore out (invariant #4)", () => {
    // Panel group "p" holds p:0/p:1; the user tears p:1 into its own window.
    const l0 = makeLayout({ left: leaf("p"), groups: { p: 2 } });
    const torn = tearOutPane(l0, "p", "p:1", 50, 50, 300).layout;
    // Server adds a tab: membership reconcile must append ONLY the new pane;
    // p:1 stays where the user put it (relocation is applyMembership's job).
    const out = reconcilePanelMembership(torn, ["p:0", "p:1", "p:2"], []);
    expect(out.groups["p"].paneIds).toEqual(["p:0", "p:2"]);
    const holders = Object.values(out.groups).filter((g) =>
      g.paneIds.includes("p:1"),
    );
    expect(holders.length).toBe(1);
  });
});

describe("scan regressions: per-axis float placement", () => {
  it("position-only float() leaves a user-resized window's size alone (§8)", () => {
    const l0 = makeLayout({
      floating: [{ id: "w", stack: ["p"], width: 500, height: 400 }],
    });
    const out = applyPanelPlacement(
      l0,
      ["p:0"],
      {
        position: { kind: "float", x: 40, y: 40 },
        width: null,
        height: null,
        collapsed: null,
      },
      () => null,
    );
    const win = out.floating.find((w) => w.stack.includes("p"))!;
    expect(win.width).toBe(500);
    expect(pinnedPxOf(win.height)).toBe(400);
  });
});

describe("scan regressions: snap into a px-weighted stack", () => {
  it("seeds the snapped-in group's weight on the target's scale", () => {
    const l0 = makeLayout({
      floating: [
        { id: "wt", stack: ["t1", "t2"] },
        { id: "ws", stack: ["s"] },
      ],
    });
    // A divider drag wrote px-scale weights on the target.
    l0.floating[0].stackWeights = { t1: 300, t2: 200 };
    const out = snapToWindowStack(l0, ["s"], "wt");
    const target = out.floating.find((w) => w.id === "wt")!;
    expect(target.stack).toEqual(["t1", "t2", "s"]);
    // Not the flex default 1 (a ~1px sliver next to px siblings): the mean of
    // the target's existing weights.
    expect(target.stackWeights?.["s"]).toBeCloseTo(250);
  });
});

describe("scan regressions: unknown-group ops no-op", () => {
  it("floatGroup on a ghost id returns the layout unchanged", () => {
    const l0 = makeLayout({ left: leaf("a") });
    const res = floatGroup(l0, "ghost", 10, 10, 300);
    expect(res.windowId).toBeNull();
    expect(res.layout).toBe(l0);
  });

  it("tearOutPane on a ghost group returns the layout unchanged", () => {
    const l0 = makeLayout({ left: leaf("a") });
    const res = tearOutPane(l0, "ghost", "ghost.0", 10, 10, 300);
    expect(res.windowId).toBeNull();
    expect(res.floatingGroupId).toBeNull();
    expect(res.layout).toBe(l0);
    expect(refCount(l0, "ghost")).toBe(0);
  });
});

describe("scan regressions: set_width on a fully railed region", () => {
  it("lands the px in the railed columns' restore weights (§8 replay parity)", () => {
    const l0 = makeLayout({ left: col([leaf("a")], 400) });
    l0.docked.left!.columns[0].railed = true;
    l0.regionWidth = { left: MINIMIZED_STRIP_PX, right: 0 };
    const out = setRegionWidth(l0, "left", 555);
    // The command is not discarded: the restore weight carries it, while the
    // rendered need stays the rails' pack width.
    expect(out.docked.left!.columns[0].weight).toBe(555);
    expect(out.regionWidth!.left).toBe(MINIMIZED_STRIP_PX);
  });
});

describe("scan regressions: width reconciler id-priority match", () => {
  it("a stationary column keeps its px when a new column is inserted before it", () => {
    const la = leaf("a");
    const lb = leaf("b");
    const prev = makeLayout({ left: col([la, lb], 500) });
    prev.regionWidth = { left: 500, right: 0 };
    // Docked->docked side split via the op API: group b becomes a NEW column
    // inserted BEFORE a's surviving column.
    const next = dropOnDockedLeaf(prev, ["b"], "left", leafIdOf(la), "left");
    reconcileRegionWidths(prev, next);
    const cols = next.docked.left!.columns;
    const colOf = (g: string) =>
      cols.find((c) => c.leaves.some((l) => l.group === g))!;
    // The column that never moved keeps its 500px; the mover gets the default
    // (it did not come from a floating window).
    expect(colOf("a").weight).toBe(500);
    expect(colOf("b").weight).not.toBe(500);
  });
});
