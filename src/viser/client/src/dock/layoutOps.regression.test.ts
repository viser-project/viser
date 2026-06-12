// Regression unit tests for a batch of docking-library changes.
//
// These pin behaviors that were not previously covered by the structural /
// fuzz / width suites:
//   (1) cascadeResize -- the pure cascading-divider resize shared by docked
//       splits and floating snap-stacks (grow/shrink conservation, min-floor
//       push-through, collapsed-cell exclusion, no-op guards).
//   (2) setStackWeights -- merging groupId->height-weight into a floating
//       window's stack (validation + missing-window no-op).
//   (6) insertTabsInto -- the guard that skips an AREA-backing group passed as a
//       merge SOURCE (the area group is a fixed fixture and must survive).
//
// Items (3) snapToWindowStack height preservation, (4) floatGroup height, and
// (5) tabInsertion row-awareness are already covered in layoutOps.test.ts /
// hitTest.test.ts and are not duplicated here.

import { describe, it, expect } from "vitest";
import {
  DockLayout,
  GroupId,
  emptyLayout,
  MIN_PANEL_WIDTH_PX,
} from "./types";
import {
  cascadeResize,
  resizeRegionColumns,
  setStackWeights,
  insertTabsInto,
  dockToEdge,
  dockToRegionEdge,
  dropOnDockedLeaf,
  snapToWindowStack,
  floatGroup,
} from "./layoutOps";
import { refCount } from "./testUtils";

// ===========================================================================
// (1) cascadeResize
//
// Returns per-cell pixel sizes (collapsed -> 0), conserving the live total, or
// null on a no-op. Grow side: deltaPx>0 grows cell `dividerIndex`, taking from
// later siblings in order (push-through); deltaPx<0 grows `dividerIndex+1`,
// taking from earlier siblings in order. Floors the shrink side at `minCell`.
// ===========================================================================
describe("cascadeResize", () => {
  // Sum the live (non-zero) cells. With no collapsed cells this equals the
  // whole container; with collapsed cells (-> 0) it equals the live remainder.
  const liveTotal = (cells: number[]) => cells.reduce((s, c) => s + c, 0);

  it("grows the drag-side cell and shrinks the next sibling, conserving total", () => {
    // Two equal cells in a 1000px container -> 500/500. Drag the divider right
    // by 100: left grows to 600, right shrinks to 400.
    const next = cascadeResize({
      weights: [1, 1],
      collapsed: [false, false],
      containerPx: 1000,
      dividerIndex: 0,
      deltaPx: 100,
      minCell: MIN_PANEL_WIDTH_PX,
      maxCell: Infinity,
    })!;
    expect(next).not.toBeNull();
    expect(next[0]).toBeCloseTo(600, 5);
    expect(next[1]).toBeCloseTo(400, 5);
    expect(liveTotal(next)).toBeCloseTo(1000, 5);
  });

  it("negative delta grows the cell AFTER the divider, taking from earlier ones", () => {
    const next = cascadeResize({
      weights: [1, 1],
      collapsed: [false, false],
      containerPx: 1000,
      dividerIndex: 0,
      deltaPx: -100,
      minCell: MIN_PANEL_WIDTH_PX,
      maxCell: Infinity,
    })!;
    expect(next[0]).toBeCloseTo(400, 5);
    expect(next[1]).toBeCloseTo(600, 5);
    expect(liveTotal(next)).toBeCloseTo(1000, 5);
  });

  it("floors the shrink side at minCell, then pushes through to the next sibling", () => {
    // Three equal cells in 900px -> 300 each. Drag divider 0 right hard (+1000).
    // Cell 1 can only give down to minCell (220), i.e. 80px; the rest of the
    // demand pushes through to cell 2. Total is conserved.
    const min = MIN_PANEL_WIDTH_PX; // 220
    const next = cascadeResize({
      weights: [1, 1, 1],
      collapsed: [false, false, false],
      containerPx: 900,
      dividerIndex: 0,
      deltaPx: 1000,
      minCell: min,
      maxCell: Infinity,
    })!;
    // Siblings 1 and 2 are floored at minCell; cell 0 absorbs the rest.
    expect(next[1]).toBeCloseTo(min, 5);
    expect(next[2]).toBeCloseTo(min, 5);
    expect(next[0]).toBeCloseTo(900 - 2 * min, 5);
    expect(liveTotal(next)).toBeCloseTo(900, 5);
    // And no cell dipped below the floor.
    expect(Math.min(...next)).toBeGreaterThanOrEqual(min - 1e-6);
  });

  it("excludes collapsed cells: they stay 0 and neither give nor take space", () => {
    // Three cells, the middle one collapsed. Live total comes from cells 0 and 2
    // only (1000 split 500/500); the collapsed cell renders at 0 here. Dragging
    // divider 0 right must shrink cell 2 (the next LIVE sibling), skipping cell 1.
    const next = cascadeResize({
      weights: [1, 1, 1],
      collapsed: [false, true, false],
      containerPx: 1000,
      dividerIndex: 0,
      deltaPx: 100,
      minCell: MIN_PANEL_WIDTH_PX,
      maxCell: Infinity,
    })!;
    expect(next[1]).toBe(0); // collapsed -> 0
    expect(next[0]).toBeCloseTo(600, 5);
    expect(next[2]).toBeCloseTo(400, 5);
    // Live total (excluding the collapsed cell) is conserved.
    expect(liveTotal(next)).toBeCloseTo(1000, 5);
  });

  it("returns null when growing a collapsed cell (drag-side is collapsed)", () => {
    // deltaPx>0 grows dividerIndex (cell 0); it's collapsed -> no-op.
    expect(
      cascadeResize({
        weights: [1, 1],
        collapsed: [true, false],
        containerPx: 1000,
        dividerIndex: 0,
        deltaPx: 100,
        minCell: MIN_PANEL_WIDTH_PX,
        maxCell: Infinity,
      }),
    ).toBeNull();
    // deltaPx<0 grows dividerIndex+1 (cell 1); it's collapsed -> no-op.
    expect(
      cascadeResize({
        weights: [1, 1],
        collapsed: [false, true],
        containerPx: 1000,
        dividerIndex: 0,
        deltaPx: -100,
        minCell: MIN_PANEL_WIDTH_PX,
        maxCell: Infinity,
      }),
    ).toBeNull();
  });

  it("returns null when the container has no width (containerPx <= 0)", () => {
    expect(
      cascadeResize({
        weights: [1, 1],
        collapsed: [false, false],
        containerPx: 0,
        dividerIndex: 0,
        deltaPx: 100,
        minCell: MIN_PANEL_WIDTH_PX,
        maxCell: Infinity,
      }),
    ).toBeNull();
  });

  it("caps the grow side at maxCell (excess demand is dropped)", () => {
    // Two cells 500/500 in 1000px, maxCell 600. Drag right by 300: cell 0 can
    // only reach 600 (its cap), so it takes just 100 from cell 1 (-> 400). The
    // surplus 200 of demand is dropped (the boundary stops at the cap).
    const next = cascadeResize({
      weights: [1, 1],
      collapsed: [false, false],
      containerPx: 1000,
      dividerIndex: 0,
      deltaPx: 300,
      minCell: MIN_PANEL_WIDTH_PX,
      maxCell: 600,
    })!;
    expect(next[0]).toBeCloseTo(600, 5);
    expect(next[1]).toBeCloseTo(400, 5);
  });
});

// ===========================================================================
// (2) setStackWeights
//
// Merges groupId->weight entries into a floating window's stackWeights, keeping
// any existing entries. Rejects non-finite / non-positive values. A missing
// window is a no-op (returns the input reference).
// ===========================================================================
function floatingLayout(
  windows: { id: string; stack: GroupId[]; stackWeights?: Record<GroupId, number> }[],
): DockLayout {
  const l = emptyLayout();
  l.floating = windows.map((w) => ({
    id: w.id,
    x: 0,
    y: 0,
    width: 300,
    stack: [...w.stack],
    ...(w.stackWeights !== undefined ? { stackWeights: { ...w.stackWeights } } : {}),
  }));
  for (const w of windows)
    for (const g of w.stack)
      if (l.groups[g] === undefined)
        l.groups[g] = { id: g, panelIds: [g], activeId: g };
  return l;
}

describe("setStackWeights", () => {
  it("merges groupId->weight into a window's stackWeights (creating the map)", () => {
    const l = floatingLayout([{ id: "w1", stack: ["a", "b"] }]);
    const out = setStackWeights(l, "w1", { a: 2, b: 3 });
    const win = out.floating.find((w) => w.id === "w1")!;
    expect(win.stackWeights).toEqual({ a: 2, b: 3 });
  });

  it("keeps existing entries and overrides only the provided keys", () => {
    const l = floatingLayout([
      { id: "w1", stack: ["a", "b", "c"], stackWeights: { a: 1, b: 1, c: 1 } },
    ]);
    const out = setStackWeights(l, "w1", { b: 5 });
    const win = out.floating.find((w) => w.id === "w1")!;
    // a and c untouched; b replaced.
    expect(win.stackWeights).toEqual({ a: 1, b: 5, c: 1 });
  });

  it("rejects non-finite and non-positive weights (entry is not written)", () => {
    const l = floatingLayout([
      { id: "w1", stack: ["a", "b"], stackWeights: { a: 4 } },
    ]);
    const out = setStackWeights(l, "w1", {
      a: 0, // non-positive -> rejected, existing 4 kept
      b: -3, // non-positive -> rejected, not added
    });
    const win = out.floating.find((w) => w.id === "w1")!;
    expect(win.stackWeights).toEqual({ a: 4 });

    const out2 = setStackWeights(l, "w1", {
      b: Number.POSITIVE_INFINITY,
    });
    expect(out2.floating.find((w) => w.id === "w1")!.stackWeights).toEqual({
      a: 4,
    });

    const out3 = setStackWeights(l, "w1", { b: NaN });
    expect(out3.floating.find((w) => w.id === "w1")!.stackWeights).toEqual({
      a: 4,
    });
  });

  it("is a no-op (same reference) for a missing window", () => {
    const l = floatingLayout([{ id: "w1", stack: ["a"] }]);
    expect(setStackWeights(l, "nope", { a: 2 })).toBe(l);
  });

  it("does not mutate the input layout (pure)", () => {
    const l = floatingLayout([{ id: "w1", stack: ["a"] }]);
    const before = structuredClone(l);
    setStackWeights(l, "w1", { a: 9 });
    expect(l).toEqual(before);
  });
});

// ===========================================================================
// (6) insertTabsInto skips an AREA group passed as a SOURCE.
//
// An area-backing group is a fixed fixture: detachInPlace is a no-op on it, so
// consuming it as a merge source would delete it from layout.groups while
// leaving layout.areas dangling. The guard in insertTabsInto skips any source
// that backs an area; the area's group (and its panels) must survive untouched.
// ===========================================================================
function areaSourceLayout(): DockLayout {
  const l = emptyLayout();
  // Backing group for an area, holding two panels.
  l.groups["area-grp"] = {
    id: "area-grp",
    panelIds: ["props", "history"],
    activeId: "props",
  };
  // A plain target group to merge into.
  l.groups["target"] = { id: "target", panelIds: ["scene"], activeId: "scene" };
  // A plain source we DO expect to be consumed.
  l.groups["plain-src"] = {
    id: "plain-src",
    panelIds: ["controls"],
    activeId: "controls",
  };
  l.areas = { "area-1": { id: "area-1", group: "area-grp" } };
  return l;
}

describe("(6) insertTabsInto guards an area group used as a SOURCE", () => {
  it("skips the area source: it is not consumed and its panels survive", () => {
    const l = areaSourceLayout();
    // Try to merge the AREA group into `target`. The guard must skip it.
    const out = insertTabsInto(l, "target", ["area-grp"], 1);
    // Nothing merged -> insertTabsInto found no incoming panels -> input
    // returned unchanged (same reference).
    expect(out).toBe(l);
    // The area group's backing group and panels are intact.
    expect(out.groups["area-grp"].panelIds).toEqual(["props", "history"]);
    // The area mapping still points at the surviving group.
    expect(out.areas!["area-1"]).toEqual({ id: "area-1", group: "area-grp" });
    // The target was not modified.
    expect(out.groups["target"].panelIds).toEqual(["scene"]);
  });

  it("skips ONLY the area source in a mixed source list; plain sources merge", () => {
    const l = areaSourceLayout();
    // Mixed list: the area group (must be skipped) plus a plain group (consumed).
    const out = insertTabsInto(l, "target", ["area-grp", "plain-src"], 1);
    // The plain source merged in at index 1; the area's panels did NOT.
    expect(out.groups["target"].panelIds).toEqual(["scene", "controls"]);
    expect(out.groups["target"].panelIds).not.toContain("props");
    expect(out.groups["target"].panelIds).not.toContain("history");
    // The plain source was consumed; the area's backing group survives.
    expect(out.groups["plain-src"]).toBeUndefined();
    expect(out.groups["area-grp"].panelIds).toEqual(["props", "history"]);
    expect(out.areas!["area-1"].group).toBe("area-grp");
  });
});

// ===========================================================================
// (7) dock/snap ops skip an AREA group in the dragged set.
//
// detachInPlace is a no-op on an area-backing group (it's a fixed fixture), so
// docking/snapping one would insert a SECOND reference to it while it stays in
// its area -- a duplicated group rendered in two places. The dock/snap ops
// filter area groups out of the dragged set (and no-op when nothing remains),
// mirroring the insertTabsInto source guard.
// ===========================================================================
describe("(7) dock/snap ops guard an area group in the dragged set", () => {
  function areaDragLayout(): DockLayout {
    const l = areaSourceLayout();
    // A floating window to snap into / drag from.
    l.floating = [
      { id: "w1", x: 0, y: 0, width: 300, stack: ["plain-src"] },
      { id: "w2", x: 350, y: 0, width: 300, stack: ["target"] },
    ];
    return l;
  }
  it("dockToEdge with only the area group is a no-op", () => {
    const l = areaDragLayout();
    expect(dockToEdge(l, ["area-grp"], "left")).toBe(l);
  });

  it("dockToEdge with a mixed set docks only the plain group", () => {
    const l = areaDragLayout();
    const out = dockToEdge(l, ["area-grp", "plain-src"], "left");
    expect(refCount(out, "area-grp")).toBe(0); // never docked/floated
    expect(refCount(out, "plain-src")).toBe(1); // docked
    expect(out.docked.left).not.toBeNull();
    expect(out.areas!["area-1"].group).toBe("area-grp");
  });

  it("dockToRegionEdge with only the area group is a no-op", () => {
    const l = areaDragLayout();
    expect(dockToRegionEdge(l, ["area-grp"], "left", "top")).toBe(l);
  });

  it("dropOnDockedLeaf with only the area group is a no-op", () => {
    const l = areaDragLayout();
    l.docked.left = { type: "leaf", id: "La", group: "plain-src", weight: 1 };
    l.floating = l.floating.filter((w) => w.id !== "w1");
    expect(dropOnDockedLeaf(l, ["area-grp"], "left", "La", "top")).toBe(l);
  });

  it("snapToWindowStack with only the area group is a no-op", () => {
    const l = areaDragLayout();
    expect(snapToWindowStack(l, ["area-grp"], "w2", 0)).toBe(l);
  });

  it("snapToWindowStack with a mixed set snaps only the plain group", () => {
    const l = areaDragLayout();
    const out = snapToWindowStack(l, ["area-grp", "plain-src"], "w2", 0);
    expect(out.floating.find((w) => w.id === "w2")!.stack).toEqual([
      "plain-src",
      "target",
    ]);
    expect(refCount(out, "area-grp")).toBe(0);
    expect(out.areas!["area-1"].group).toBe("area-grp");
  });
});

// ===========================================================================
// (8) detach prunes the group's stale stackWeights entry.
//
// A group leaving a floating window used to leave its key behind in the
// window's stackWeights; a later snap-in of a DIFFERENT group with a recycled
// id (or just inspection of the record) would see the stale weight.
// ===========================================================================
describe("(8) detaching a group prunes its stackWeights entry", () => {
  it("floatGroup out of a weighted stack drops the group's weight key", () => {
    const l = floatingLayout([
      { id: "w1", stack: ["a", "b", "c"], stackWeights: { a: 100, b: 200, c: 50 } },
    ]);
    l.floating[0].height = 400;
    const out = floatGroup(l, "b", 10, 10, 260).layout;
    const w1 = out.floating.find((w) => w.id === "w1")!;
    expect(w1.stack).toEqual(["a", "c"]);
    expect(w1.stackWeights).toEqual({ a: 100, c: 50 }); // b pruned
  });

  it("snapping a group from one stack to another prunes it from the source", () => {
    const l = floatingLayout([
      { id: "w1", stack: ["a", "b"], stackWeights: { a: 100, b: 200 } },
      { id: "w2", stack: ["c"] },
    ]);
    l.floating[0].height = 300;
    const out = snapToWindowStack(l, ["b"], "w2", 0);
    const w1 = out.floating.find((w) => w.id === "w1")!;
    expect(w1.stackWeights).toEqual({ a: 100 });
    expect(out.floating.find((w) => w.id === "w2")!.stack).toEqual(["b", "c"]);
  });
});

// ===========================================================================
// (9) resizeRegionColumns: region-edge resize redistributes across columns.
//
// With [wide][narrow][wide] columns, shrinking used to lock up as soon as the
// narrow column hit its minimum, even though the wide neighbours had plenty of
// room. The redistribution clamps violators and hands the difference to
// columns that still have room.
// ===========================================================================
describe("(9) resizeRegionColumns", () => {
  const M = MIN_PANEL_WIDTH_PX; // 220

  it("scales proportionally when nothing clamps", () => {
    const w = resizeRegionColumns([300, 300], [M, M], [600, 600], 900);
    expect(w[0]).toBeCloseTo(450);
    expect(w[1]).toBeCloseTo(450);
  });

  it("keeps shrinking past one column's minimum (wide-narrow-wide)", () => {
    // 400 + 220 + 400 = 1020; shrink to 900. The narrow middle column is
    // already at its minimum; the wide columns absorb the whole reduction.
    const w = resizeRegionColumns(
      [400, M, 400],
      [M, M, M],
      [600, 600, 600],
      900,
    );
    expect(w[1]).toBeCloseTo(M); // clamped, not below
    expect(w[0]).toBeCloseTo((900 - M) / 2);
    expect(w[2]).toBeCloseTo((900 - M) / 2);
    expect(w[0] + w[1] + w[2]).toBeCloseTo(900);
  });

  it("keeps growing past one column's maximum", () => {
    // Growing: the column at max stays there; others take the surplus.
    const w = resizeRegionColumns(
      [580, 300, 300],
      [M, M, M],
      [600, 600, 600],
      1400,
    );
    expect(w[0]).toBeCloseTo(600); // clamped at max
    expect(w[1] + w[2]).toBeCloseTo(800);
    expect(w[1]).toBeCloseTo(400);
    expect(w[2]).toBeCloseTo(400);
  });

  it("clamps the target to the columns' aggregate bounds", () => {
    const w = resizeRegionColumns([300, 300], [M, M], [600, 600], 100);
    expect(w[0] + w[1]).toBeCloseTo(2 * M);
    const w2 = resizeRegionColumns([300, 300], [M, M], [600, 600], 5000);
    expect(w2[0] + w2[1]).toBeCloseTo(1200);
  });

  it("cascades: redistribution can push a second column to its limit", () => {
    // Shrink hard: middle hits min first, then the small-ish first column
    // also bottoms out; the wide last column absorbs the rest.
    const w = resizeRegionColumns(
      [260, M, 500],
      [M, M, M],
      [600, 600, 600],
      700,
    );
    expect(w[0]).toBeCloseTo(M);
    expect(w[1]).toBeCloseTo(M);
    expect(w[2]).toBeCloseTo(700 - 2 * M);
  });
});
