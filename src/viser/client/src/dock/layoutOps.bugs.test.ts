// REGRESSION GUARDS for layoutOps bugs found by adversarial invariant fuzzing
// and since FIXED in production. Each test pins the minimal repro that used to
// lose data and asserts the now-correct behavior. If any of these starts
// failing again, the corresponding data-loss bug has regressed.
//
// History (now fixed):
//   BUG #1 (was HIGH): snapToWindowStack of a window's entire stack back into
//     that same window deleted the window and orphaned the groups (panels lost).
//     FIX: detach first, re-find the target window; if it was consumed, abort
//     (return the input unchanged) -- a safe no-op.
//   BUG #2 (was HIGH): dropOnDockedLeaf with a non-center region, where the
//     dragged set includes the target leaf's own group, orphaned/lost the
//     dragged group. FIX: re-find the target leaf AFTER detach; if it's gone
//     (a self-drop that collapsed the node), abort -- a safe no-op.
//   BUG #3 (LOW/UX, intentionally unchanged): a self-drop onto a SOLE docked
//     leaf stays a no-op (returns the input). Documented, by design.
//   NOTE (input validation): resizeWindow* still do NOT validate numeric inputs
//     (0/negative/NaN accepted) -- callers clamp.

import { describe, it, expect } from "vitest";
import { DockLayout, emptyLayout } from "./types";
import {
  snapToWindowStack,
  dropOnDockedLeaf,
  resizeWindow,
  findGroupLocation,
} from "./layoutOps";
import { group, refCount } from "./testUtils";

/** Left edge holds row [a | b] with fixed node ids S / La / Lb. */
function twoLeafRow(): DockLayout {
  const l = emptyLayout();
  l.groups = { a: group("a"), b: group("b") };
  l.docked.left = {
    type: "split",
    id: "S",
    dir: "row",
    weight: 1,
    children: [
      { type: "leaf", id: "La", group: "a", weight: 1 },
      { type: "leaf", id: "Lb", group: "b", weight: 1 },
    ],
  };
  return l;
}

// ===========================================================================
// BUG #1 (FIXED) -- snapToWindowStack into a window whose entire stack is dragged.
// ===========================================================================
describe("BUG #1 (fixed): snapToWindowStack self-target no longer empties the window", () => {
  it("snapping the sole group of a window into that same window is a safe no-op", () => {
    const l = emptyLayout();
    l.groups = { a: group("a") };
    l.floating = [{ id: "w1", x: 10, y: 10, width: 260, stack: ["a"] }];

    const out = snapToWindowStack(l, ["a"], "w1", 0);

    // FIXED: window preserved, `a` still referenced exactly once, no orphan.
    expect(out).toBe(l); // safe no-op: returns the input unchanged
    expect(out.floating).toEqual([
      { id: "w1", x: 10, y: 10, width: 260, stack: ["a"] },
    ]);
    expect(refCount(out, "a")).toBe(1);
  });

  it("snapping a window's ENTIRE multi-group stack into itself is a safe no-op", () => {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.floating = [{ id: "w1", x: 0, y: 0, width: 260, stack: ["a", "b"] }];

    const out = snapToWindowStack(l, ["a", "b"], "w1", 0);

    expect(out).toBe(l); // safe no-op
    expect(refCount(out, "a")).toBe(1);
    expect(refCount(out, "b")).toBe(1);
  });

  it("PARTIAL overlap still snaps in correctly (unchanged)", () => {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b"), c: group("c") };
    l.floating = [
      { id: "w1", x: 0, y: 0, width: 260, stack: ["a", "b"] },
      { id: "w2", x: 300, y: 0, width: 260, stack: ["c"] },
    ];
    const out = snapToWindowStack(l, ["a", "c"], "w1", 0);
    expect(out.floating.map((w) => w.id)).toEqual(["w1"]); // w2 cleaned up
    expect(refCount(out, "a")).toBe(1);
    expect(refCount(out, "c")).toBe(1);
  });
});

// ===========================================================================
// BUG #2 (FIXED) -- dropOnDockedLeaf non-center self-drop in a multi-leaf region.
// ===========================================================================
describe("BUG #2 (fixed): dropOnDockedLeaf side-region self-drop no longer loses the group", () => {
  it("dropping a group onto its OWN leaf (side region) in a 2-leaf row is a safe no-op", () => {
    const l = twoLeafRow();
    const out = dropOnDockedLeaf(l, ["a"], "left", "La", "top");

    // FIXED: `a` stays docked, referenced once; the tree is unchanged.
    expect(out).toBe(l); // safe no-op
    expect(refCount(out, "a")).toBe(1);
    expect(findGroupLocation(out, "a")).toEqual({
      kind: "docked",
      edge: "left",
      nodeId: "La",
    });
  });

  it("no loss for any of the four non-center regions", () => {
    for (const region of ["top", "bottom", "left", "right"] as const) {
      const out = dropOnDockedLeaf(twoLeafRow(), ["a"], "left", "La", region);
      expect(refCount(out, "a")).toBe(1); // FIXED: never orphaned
      expect(refCount(out, "b")).toBe(1);
    }
  });

  it("center self-drop is still safe (merges into self = no-op)", () => {
    const out = dropOnDockedLeaf(twoLeafRow(), ["a"], "left", "La", "center");
    expect(refCount(out, "a")).toBe(1);
  });
});

// ===========================================================================
// BUG #3 -- harmless no-op self-drop onto a sole leaf (intentionally unchanged).
// ===========================================================================
describe("BUG #3 (by design): self-drop onto a sole docked leaf is a no-op", () => {
  it("returns the input unchanged when the region has a single leaf", () => {
    const l = emptyLayout();
    l.groups = { a: group("a") };
    l.docked.left = { type: "leaf", id: "La", group: "a", weight: 1 };
    const out = dropOnDockedLeaf(l, ["a"], "left", "La", "right");
    expect(out).toBe(l); // intentional no-op
    expect(refCount(out, "a")).toBe(1);
  });
});

// ===========================================================================
// NOTE -- input validation gaps (still by contract; callers clamp).
// ===========================================================================
describe("NOTE: numeric ops do not validate their inputs", () => {
  it("resizeWindow accepts a non-finite width verbatim", () => {
    const l = emptyLayout();
    l.groups = { a: group("a") };
    l.floating = [{ id: "w1", x: 0, y: 0, width: 260, stack: ["a"] }];
    const out = resizeWindow(l, "w1", Number.NaN);
    expect(Number.isNaN(out.floating[0].width)).toBe(true); // no validation
  });
});
