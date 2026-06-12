// REGRESSION GUARD for hitTest BUG #4 (found by adversarial pointer probing,
// since FIXED). Each case asserts the now-correct behavior: when drop targets
// overlap, the resolved target is the one painted ON TOP under the cursor.
//
// History (now fixed):
//   BUG #4 (was MEDIUM): when drop targets overlapped (two floating windows, or
//     a floating window atop the docked region), hitTest resolved to the FIRST
//     matching rect -- the target painted UNDERNEATH. FIX: hitTest now iterates
//     all targets and keeps the LAST match (targets are ordered back-to-front:
//     docked behind, then floating ascending z), so the visually-topmost target
//     wins. (DockManager collects floating targets in front-order; floating
//     windows render in a stable DOM order with z from front-order, so raising
//     a window no longer reorders the DOM.)

import { describe, it, expect } from "vitest";
import { hitTest, ContainerRect, DropTargets, GroupTarget } from "./hitTest";
import { DockEdge, DockNode, emptyLayout } from "./types";
import { rect, group } from "./testUtils";

const C: ContainerRect = { left: 0, top: 0, width: 1000, height: 800 };
const RW: Record<DockEdge, number> = { left: 300, right: 300 };

describe("BUG #4 (fixed): overlapping drop targets resolve to the one on TOP", () => {
  it("two overlapping floating windows -> hits the TOP window", () => {
    // w1 is painted first (bottom), w2 last (visually on top). A pointer in
    // their overlap now targets w2 (group b). hitTest takes the LAST matching
    // target (topmost), not the first.
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
    };
    l.floating = [
      { id: "w1", x: 400, y: 300, width: 200, stack: ["a"] }, // bottom
      { id: "w2", x: 420, y: 320, width: 200, stack: ["b"] }, // top
    ];
    // Targets ordered back-to-front (ascending z): bottom window first, top last.
    const targets: DropTargets = {
      groups: [
        floatTarget("a", "w1", rect(400, 300, 200, 240)),
        floatTarget("b", "w2", rect(420, 320, 200, 240)),
      ],
    };
    // (500, 400) is inside BOTH windows; w2 is visually on top.
    const r = hitTest(l, RW, C, targets, 500, 400);
    expect(r?.result).toEqual({ kind: "merge", targetGroupId: "b" }); // FIXED: top wins
  });

  it("a floating window over the docked region -> hits the FLOATING window", () => {
    // The floating window 'f' sits visually atop docked 'd'. Docked targets are
    // collected first (back), floating after (front), and the LAST match wins,
    // so a drop over 'f' now targets 'f'.
    const l = emptyLayout();
    l.groups = {
      d: group("d"),
      f: group("f"),
    };
    l.docked.left = { type: "leaf", id: "Ld", group: "d", weight: 1 } as DockNode;
    l.floating = [{ id: "wf", x: 100, y: 300, width: 180, stack: ["f"] }];
    const targets: DropTargets = {
      groups: [
        dockTarget("d", "Ld", rect(0, 0, 300, 800)),
        floatTarget("f", "wf", rect(100, 300, 180, 240)),
      ],
    };
    // (180, 420): inside the floating window AND the docked region's content area.
    const r = hitTest(l, RW, C, targets, 180, 420);
    expect(r?.result).toEqual({ kind: "merge", targetGroupId: "f" }); // FIXED: float on top wins
  });

  it("counter-case (works): non-overlapping windows resolve correctly", () => {
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
    };
    l.floating = [
      { id: "w1", x: 50, y: 300, width: 150, stack: ["a"] },
      { id: "w2", x: 500, y: 300, width: 150, stack: ["b"] },
    ];
    const targets: DropTargets = {
      groups: [
        floatTarget("a", "w1", rect(50, 300, 150, 240)),
        floatTarget("b", "w2", rect(500, 300, 150, 240)),
      ],
    };
    // Distinct, non-overlapping centers hit the right windows.
    expect(hitTest(l, RW, C, targets, 125, 400)?.result).toEqual({
      kind: "merge",
      targetGroupId: "a",
    });
    expect(hitTest(l, RW, C, targets, 575, 400)?.result).toEqual({
      kind: "merge",
      targetGroupId: "b",
    });
  });
});

function floatTarget(group: string, windowId: string, r: DOMRect): GroupTarget {
  return {
    groupId: group,
    rect: r,
    stripRect: rect(r.left, r.top + 12, r.width, 28),
    tabs: [{ panelId: `${group}.0`, rect: rect(r.left, r.top + 12, 70, 28) }],
    ctx: { kind: "floating", windowId, index: 0 },
  };
}
function dockTarget(group: string, nodeId: string, r: DOMRect): GroupTarget {
  return {
    groupId: group,
    rect: r,
    stripRect: rect(r.left, r.top + 12, r.width, 28),
    tabs: [{ panelId: `${group}.0`, rect: rect(r.left, r.top + 12, 80, 28) }],
    ctx: { kind: "docked", nodeId, edge: "left" },
  };
}

// ===========================================================================
// draggingUnmergeable: source-side merge policy lives in hitTest (not vetoed
// after the fact by DockManager), so hints never advertise a merge that the
// drop would discard.
// ===========================================================================
describe("draggingUnmergeable suppresses merge/insertTab from the SOURCE side", () => {
  function floatingLayoutAB() {
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
    };
    l.floating = [
      { id: "w1", x: 400, y: 300, width: 200, stack: ["a"] },
      { id: "w2", x: 700, y: 300, width: 200, stack: ["b"] },
    ];
    return l;
  }

  it("content-area merge becomes null; the same point merges when mergeable", () => {
    const l = floatingLayoutAB();
    const targets: DropTargets = {
      groups: [floatTarget("a", "w1", rect(400, 300, 200, 240))],
    };
    // Mid-content point (past the strip, outside the snap-below band).
    const without = hitTest(l, RW, C, targets, 500, 400);
    expect(without?.result).toEqual({ kind: "merge", targetGroupId: "a" });
    const withFlag = hitTest(l, RW, C, targets, 500, 400, {
      draggingUnmergeable: true,
    });
    expect(withFlag).toBeNull();
  });

  it("tab-strip insertTab becomes null", () => {
    const l = floatingLayoutAB();
    const targets: DropTargets = {
      groups: [floatTarget("a", "w1", rect(400, 300, 200, 240))],
    };
    // Over the strip (top + 12..40), right of the only tab.
    const without = hitTest(l, RW, C, targets, 560, 326);
    expect(without?.result.kind).toBe("insertTab");
    const withFlag = hitTest(l, RW, C, targets, 560, 326, {
      draggingUnmergeable: true,
    });
    expect(withFlag).toBeNull();
  });

  it("snap into a floating stack is still offered (snap-below band)", () => {
    const l = floatingLayoutAB();
    const targets: DropTargets = {
      groups: [floatTarget("a", "w1", rect(400, 300, 200, 240))],
    };
    // Bottom band of the content area -> snap below, allowed for unmergeable.
    const r = hitTest(l, RW, C, targets, 500, 538, {
      draggingUnmergeable: true,
    });
    expect(r?.result).toEqual({ kind: "snap", windowId: "w1", index: 1 });
  });

  it("docked split is still offered; only the center merge is suppressed", () => {
    const l = floatingLayoutAB();
    l.docked.left = { type: "leaf", id: "La", group: "a", weight: 1 };
    const targets: DropTargets = {
      groups: [dockTarget("a", "La", rect(0, 0, 300, 800))],
    };
    // Left band of the content area (rx < 0.22) -> split left, allowed for
    // unmergeable. x=50 is past the 40px region-side band, inside the split band.
    const split = hitTest(l, RW, C, targets, 50, 400, {
      draggingUnmergeable: true,
    });
    expect(split?.result.kind).toBe("split");
    // Center of the content area -> merge without the flag, null with it.
    const center = hitTest(l, RW, C, targets, 150, 400);
    expect(center?.result.kind).toBe("merge");
    const centerFlagged = hitTest(l, RW, C, targets, 150, 400, {
      draggingUnmergeable: true,
    });
    expect(centerFlagged).toBeNull();
  });
});

// ===========================================================================
// Unmergeable docked panel: its header is the "dock above" zone, and the
// left/right split bands are pixel-capped.
//
// An unmergeable group has no grip bar -- its full-width header sits flush at
// the panel top, so the generic "above the strip" zone (3a) is unreachable.
// The header itself must act as the above/snap-above zone; without that, a
// lone unmergeable docked panel offers NO way to dock above (the region's top
// band is suppressed as redundant for single-leaf regions).
// ===========================================================================
describe("unmergeable header acts as the dock-above / snap-above zone", () => {
  /** Docked unmergeable panel: header flush at the top (0..44), full height. */
  function unmergeableDockTarget(r: DOMRect): GroupTarget {
    return {
      groupId: "ctrl",
      rect: r,
      stripRect: rect(r.left, r.top, r.width, 44),
      tabs: [],
      ctx: { kind: "docked", nodeId: "Lc", edge: "right" },
      unmergeable: true,
    };
  }
  function layoutDockedRight() {
    const l = emptyLayout();
    l.groups = { ctrl: { id: "ctrl", panelIds: ["c.0"], activeId: "c.0" } };
    l.docked.right = { type: "leaf", id: "Lc", group: "ctrl", weight: 1 };
    return l;
  }

  it("header of a docked unmergeable panel -> split top (dock above)", () => {
    const l = layoutDockedRight();
    const targets: DropTargets = {
      groups: [unmergeableDockTarget(rect(680, 0, 320, 800))],
    };
    // Header center; past the region's suppressed top band (y=22 > 8 works
    // because the single-leaf region suppresses the regionEdge zone).
    const hit = hitTest(l, RW, C, targets, 840, 22);
    expect(hit?.result).toEqual({
      kind: "split",
      edge: "right",
      nodeId: "Lc",
      region: "top",
    });
  });

  it("header of a floating unmergeable window -> snap above", () => {
    const l = emptyLayout();
    l.groups = { ctrl: { id: "ctrl", panelIds: ["c.0"], activeId: "c.0" } };
    l.floating = [{ id: "wc", x: 400, y: 100, width: 320, stack: ["ctrl"] }];
    const t: GroupTarget = {
      groupId: "ctrl",
      rect: rect(400, 100, 320, 400),
      stripRect: rect(400, 100, 320, 44),
      tabs: [],
      ctx: { kind: "floating", windowId: "wc", index: 0 },
      unmergeable: true,
    };
    const hit = hitTest(l, RW, C, { groups: [t] }, 560, 122);
    expect(hit?.result).toEqual({ kind: "snap", windowId: "wc", index: 0 });
  });

  it("content center of an unmergeable target is still a dead zone", () => {
    const l = layoutDockedRight();
    const targets: DropTargets = {
      groups: [unmergeableDockTarget(rect(680, 0, 320, 800))],
    };
    expect(hitTest(l, RW, C, targets, 840, 400)).toBeNull();
  });

  it("left/right split bands are pixel-capped on wide panels", () => {
    const l = layoutDockedRight();
    // 400px-wide panel: 22% would be 88px; the cap holds the band at 70px.
    const targets: DropTargets = {
      groups: [unmergeableDockTarget(rect(600, 0, 400, 800))],
    };
    const inBand = hitTest(l, RW, C, targets, 600 + 50, 400);
    expect(inBand?.result).toMatchObject({ kind: "split", region: "left" });
    const pastCap = hitTest(l, RW, C, targets, 600 + 80, 400);
    expect(pastCap).toBeNull(); // dead center for unmergeable, not "left"
  });
});

// ===========================================================================
// Screen-edge zones over a fully-minimized region: the region renders as a
// compact overlay rail floating over the canvas, so the screen edge still
// reads as empty -- dropping at the far edge docks a new outer column (no
// need to hit the rail handle's narrow zones).
// ===========================================================================
describe("screen-edge dock next to an occupied region", () => {
  function minimizedRight(collapsed: boolean) {
    const l = emptyLayout();
    l.groups = {
      m: { ...group("m"), collapsed },
    };
    l.docked.right = { type: "leaf", id: "Lm", group: "m", weight: 1 };
    return l;
  }

  // Minimized columns RESERVE width as fixed strips (no canvas overlay), so a
  // region holding only minimized panels is still an occupied edge: drops at
  // the screen edge resolve against the strip's own zones (split/merge), not
  // the empty-edge zone.
  it("does NOT offer the edge zone when every docked group is minimized", () => {
    const hit = hitTest(minimizedRight(true), RW, C, { groups: [] }, 990, 400);
    expect(hit?.result.kind).not.toBe("edge");
  });

  it("does NOT offer the edge zone when the region has expanded content", () => {
    const hit = hitTest(minimizedRight(false), RW, C, { groups: [] }, 990, 400);
    expect(hit?.result.kind).not.toBe("edge");
  });
});

// ===========================================================================
// Collapsed-target vertical zones are pixel-capped: a minimized VERTICAL strip
// is narrow but region-tall; 30% of that height would be a huge "split
// above/below" band. (No-op for short horizontal handle bars.)
// ===========================================================================
describe("collapsed-target vertical zone pixel cap", () => {
  it("tall narrow strip: top split only near the top; mid-height merges", () => {
    const l = emptyLayout();
    l.groups = {
      s: group("s", 1, true),
      o: group("o"),
    };
    l.docked.right = {
      type: "split",
      id: "R",
      dir: "row",
      weight: 1,
      children: [
        { type: "leaf", id: "Lo", group: "o", weight: 1 },
        { type: "leaf", id: "Ls", group: "s", weight: 1 },
      ],
    };
    const strip: GroupTarget = {
      groupId: "s",
      rect: rect(960, 0, 40, 800),
      stripRect: null,
      tabs: [],
      ctx: { kind: "docked", nodeId: "Ls", edge: "right" },
      collapsed: true,
    };
    const targets: DropTargets = { groups: [strip] };
    // y=40 (< 70px cap) -> split top.
    expect(hitTest(l, RW, C, targets, 980, 40)?.result).toMatchObject({
      kind: "split",
      region: "top",
    });
    // y=300 (way past the cap, mid-strip, center x) -> merge, NOT a split.
    expect(hitTest(l, RW, C, targets, 980, 300)?.result).toMatchObject({
      kind: "merge",
      targetGroupId: "s",
    });
  });
});
