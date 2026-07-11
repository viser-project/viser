// Unit tests for invariantViolations -- the production invariant checker that
// applyOp asserts on every commit (dev) and the fuzz suite asserts over random
// sequences. Beyond the fuzzer's coverage, these pin the AREA-awareness that
// distinguishes the production checker: a real layout with a dockable area
// (created by inline GUI tab groups) must be considered valid, not flagged as an
// orphan group.

import { describe, expect, it } from "vitest";
import {
  migrateRegionCollapsedInPlace, addPaneToArea, dockToEdge, ensureArea, removePane } from "./layoutOps";
import { invariantViolations } from "./layoutInvariants";
import { emptyLayout, DockLayout } from "./types";
import { leaf, group, floatingWindow, row, rows, toRegion } from "./testUtils";

describe("invariantViolations", () => {
  it("a healthy docked layout has no violations", () => {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.docked.right = toRegion(leaf("a"));
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

  it("an EMPTY area group is NOT flagged (persists as a drop affordance)", () => {
    // ensureArea creates an empty backing group (paneIds [], activeId null)
    // that is a legitimate committed state -- a "drop a panel here"
    // placeholder. The checker must not flag it for empty paneIds (an ordinary
    // group would be).
    let l: DockLayout = ensureArea(emptyLayout(), "gui-area");
    expect(invariantViolations(l)).toEqual([]);
    // It also goes empty when the last tab is removed (e.g. server drops it).
    l = addPaneToArea(l, "gui-area", "tab1");
    expect(invariantViolations(l)).toEqual([]);
    l = removePane(l, "tab1");
    expect(invariantViolations(l)).toEqual([]);
    // A NON-area empty group is still a violation (sanity: the exemption is
    // scoped to area groups only).
    l.groups["bad"] = { id: "bad", paneIds: [], activeId: null };
    expect(invariantViolations(l).some((s) => s.includes("empty paneIds"))).toBe(
      true,
    );
  });

  it("flags a pane that appears in two groups (the duplication class)", () => {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: { id: "b", paneIds: ["dup"], activeId: "dup" } };
    // Inject the duplication: "dup" also in a.
    l.groups["a"].paneIds = ["a", "dup"];
    l.docked.left = toRegion(leaf("a"));
    l.floating = [floatingWindow({ id: "w", x: 0, y: 0, width: 240, stack: ["b"] })];
    const v = invariantViolations(l);
    expect(v.some((s) => s.includes("dup") && s.includes("both"))).toBe(true);
  });

  it("flags a group referenced from two locations", () => {
    const l = emptyLayout();
    l.groups = { a: group("a") };
    l.docked.left = toRegion(leaf("a"));
    l.floating = [floatingWindow({ id: "w", x: 0, y: 0, width: 240, stack: ["a"] })]; // also here
    const v = invariantViolations(l);
    expect(v.some((s) => s.includes("referenced 2x"))).toBe(true);
  });

  it("flags an orphan group (in groups but referenced nowhere)", () => {
    const l = emptyLayout();
    l.groups = { a: group("a"), orphan: group("orphan") };
    l.docked.left = toRegion(leaf("a"));
    expect(invariantViolations(l).some((s) => s.includes("orphan"))).toBe(true);
  });

  it("#13 retired (D42/D46): a railed column beside expanded siblings is LEGAL", () => {
    // The lone rail renders its 36px strip beside the expanded column --
    // legal committed geometry (the column chevron produces it), so there
    // is no structural check against it.
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.docked.left = toRegion(row([leaf("a"), leaf("b")]));
    l.docked.left!.columns[0].railed = true;
    expect(invariantViolations(l)).toEqual([]);
  });

  it("#14/#15 retired (D44): an un-migrated legacy regionCollapsed field is flagged", () => {
    // The packed rail is DERIVED now; a committed layout still carrying the
    // legacy store means an injection/restore path skipped
    // migrateRegionCollapsedInPlace.
    const l = emptyLayout();
    l.groups = { a: group("a") };
    l.docked.left = toRegion(leaf("a"));
    l.regionCollapsed = { left: true, right: false };
    expect(
      invariantViolations(l).some((s) => s.includes("legacy regionCollapsed")),
    ).toBe(true);
    // Migration converts the flag into railed columns and drops the field.
    migrateRegionCollapsedInPlace(l);
    expect(l.regionCollapsed).toBeUndefined();
    expect(l.docked.left!.columns[0].railed).toBe(true);
    expect(invariantViolations(l)).toEqual([]);
  });

  it("#16: flags regionWidth drifting from the columns' rendered need (D40/D46)", () => {
    // With an EXPANDED column in a multi-column region, regionWidth must
    // equal sum(railed ? 36 : weight) -- reconciliation maintains it on
    // every commit, so a drift means a bypassed/broken width write.
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.docked.left = toRegion(row([leaf("a", 150), leaf("b", 150)]));
    l.docked.left!.columns[0].railed = true; // need = 36 + 150 = 186
    l.regionWidth = { left: 300, right: 300 };
    expect(
      invariantViolations(l).some((s) => s.includes("rendered need")),
    ).toBe(true);
    // The maintained value is clean.
    l.regionWidth = { left: 186, right: 300 };
    expect(invariantViolations(l)).toEqual([]);
  });

  it("#16: a fully railed multi-column region holds exactly its rails", () => {
    // Every column railed: the rails ARE the content (D46 -- there are no
    // other bands whose expanded content could carry the width), so
    // regionWidth is 36 x columns, never a phantom content width.
    const rails = emptyLayout();
    rails.groups = { a: group("a"), b: group("b") };
    rails.docked.left = toRegion(row([leaf("a", 150), leaf("b", 150)]));
    rails.docked.left!.columns[0].railed = true;
    rails.docked.left!.columns[1].railed = true;
    rails.regionWidth = { left: 300, right: 300 };
    expect(
      invariantViolations(rails).some((s) => s.includes("pack width")),
    ).toBe(true);
    rails.regionWidth = { left: 72, right: 300 };
    expect(invariantViolations(rails)).toEqual([]);
  });

  it("#16: gated off for unreconciled layouts and single-column regions", () => {
    // No regionWidth field: never reconciled (flex-share literals) -- no
    // basis to check against.
    const literal = emptyLayout();
    literal.groups = { a: group("a"), b: group("b") };
    literal.docked.left = toRegion(row([leaf("a"), leaf("b")]));
    expect(invariantViolations(literal)).toEqual([]);
    // Single column: its px lives in regionWidth itself; the weight may be
    // a height share.
    const single = emptyLayout();
    single.groups = { a: group("a") };
    single.docked.left = toRegion(leaf("a", 2));
    single.regionWidth = { left: 500, right: 300 };
    expect(invariantViolations(single)).toEqual([]);
    // A packed single-column STACK (the sole column railed) is also a
    // single width column -- gated off; regionWidth carries the restore
    // width reconciliation maintains.
    const collapsed = emptyLayout();
    collapsed.groups = { a: group("a"), b: group("b") };
    collapsed.docked.left = toRegion(rows([leaf("a"), leaf("b")]));
    collapsed.docked.left!.columns[0].railed = true;
    collapsed.regionWidth = { left: 480, right: 300 };
    expect(invariantViolations(collapsed)).toEqual([]);
  });
});
