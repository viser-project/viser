// Unit tests for invariantViolations -- the production invariant checker that
// applyOp asserts on every commit (dev) and the fuzz suite asserts over random
// sequences. Beyond the fuzzer's coverage, these pin the AREA-awareness that
// distinguishes the production checker: a real layout with a dockable area
// (created by inline GUI tab groups) must be considered valid, not flagged as an
// orphan group.

import { describe, expect, it } from "vitest";
import { addPaneToArea, dockToEdge } from "./layoutOps";
import { invariantViolations } from "./layoutInvariants";
import { emptyLayout, DockLayout } from "./types";
import { leaf, group, floatingWindow } from "./testUtils";

describe("invariantViolations", () => {
  it("a healthy docked layout has no violations", () => {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.docked.right = leaf("a");
    l.floating = [floatingWindow({ id: "w", x: 10, y: 10, width: 240, stack: ["b"] })];
    expect(invariantViolations(l)).toEqual([]);
  });

  it("an AREA group is NOT flagged as an orphan (area-awareness)", () => {
    // Inline GUI tab groups live in dockable areas: the area's backing group is
    // referenced via `areas`, not docked/floating. The fuzz original would have
    // called it an orphan; the production checker must not.
    let l: DockLayout = emptyLayout();
    l = addPaneToArea(l, "gui-area", "tab1");
    expect(invariantViolations(l)).toEqual([]);
    // And it composes with docked/floating panels.
    l.groups["p"] = group("p");
    l = dockToEdge(l, ["p"], "right");
    expect(invariantViolations(l)).toEqual([]);
  });

  it("flags a pane that appears in two groups (the duplication class)", () => {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: { id: "b", paneIds: ["dup"], activeId: "dup" } };
    // Inject the duplication: "dup" also in a.
    l.groups["a"].paneIds = ["a", "dup"];
    l.docked.left = leaf("a");
    l.floating = [floatingWindow({ id: "w", x: 0, y: 0, width: 240, stack: ["b"] })];
    const v = invariantViolations(l);
    expect(v.some((s) => s.includes("dup") && s.includes("both"))).toBe(true);
  });

  it("flags a group referenced from two locations", () => {
    const l = emptyLayout();
    l.groups = { a: group("a") };
    l.docked.left = leaf("a");
    l.floating = [floatingWindow({ id: "w", x: 0, y: 0, width: 240, stack: ["a"] })]; // also here
    const v = invariantViolations(l);
    expect(v.some((s) => s.includes("referenced 2x"))).toBe(true);
  });

  it("flags an orphan group (in groups but referenced nowhere)", () => {
    const l = emptyLayout();
    l.groups = { a: group("a"), orphan: group("orphan") };
    l.docked.left = leaf("a");
    expect(invariantViolations(l).some((s) => s.includes("orphan"))).toBe(true);
  });
});
