// Pure hit-test resolution tests.
//
// Feeds SYNTHETIC rects (no DOM) into hitTest/tabInsertion and asserts the
// DropResult kind + key fields and that hint geometry is plausible. The module
// is DOM-free; the only DOM type it references is DOMRect, which we synthesize
// below.
//
// Regression pins (from adversarial pointer probing, since FIXED) live next to
// the describe of the zone/target they pin, marked with a "regression:"
// comment. Notably BUG #4: when drop targets overlap (two floating windows, or
// a floating window atop the docked region), hitTest used to resolve to the
// FIRST matching rect -- the target painted UNDERNEATH. FIX: hitTest iterates
// all targets and keeps the LAST match (targets are ordered back-to-front:
// docked behind, then floating ascending z), so the visually-topmost target
// wins. (DockManager collects floating targets in front-order; floating
// windows render in a stable DOM order with z from front-order, so raising a
// window no longer reorders the DOM.)

import { describe, it, expect } from "vitest";
import {
  hitTest,
  tabInsertion,
  inside,
  DEFAULT_REGION_PX,
  GroupTarget,
  ContainerRect,
  DropTargets,
} from "./hitTest";
import { DockEdge, DockLayout, GroupId, emptyLayout } from "./types";
import {
  rect,
  leaf,
  row as rowSplit,
  col as colSplit,
  group,
  floatingWindow,
  toRegion,
  leafIdOf,
  leafIdsOf,
} from "./testUtils";

const CONTAINER: ContainerRect = { left: 0, top: 0, width: 1000, height: 800 };

// Tunables mirrored from hitTest.ts for constructing pointer positions just
// inside / outside each zone. (Kept local so the test documents the contract.)
const EDGE_ZONE_PX = 48;
// Thin outer top/bottom band -> regionEdge "span all". Now 8px (was 22) so it
// doesn't shadow the topmost panel's grip bar.
const REGION_EDGE_PX = 8;
const REGION_SIDE_PX = 40;

function layoutWith(opts: {
  left?: ReturnType<typeof leaf> | null;
  right?: ReturnType<typeof leaf> | null;
}): DockLayout {
  const l = emptyLayout();
  l.docked.left = toRegion(opts.left ?? null);
  l.docked.right = toRegion(opts.right ?? null);
  return l;
}

const REGION_W: Record<DockEdge, number> = { left: 300, right: 300 };

// Real frames have a handle/title bar above the tab strip, so the strip starts
// a few px below the frame top -- which leaves an "above the strip" band that is
// still inside the frame rect (where the split-top / snap-above zones live).
const STRIP_OFFSET = 12;

/** A docked group target whose frame is `r`, with a tab strip starting
 * `STRIP_OFFSET` px below the frame top and `stripH` px tall. */
function dockedTarget(
  groupId: GroupId,
  nodeId: string,
  edge: DockEdge,
  r: DOMRect,
  stripH = 30,
  tabs: { paneId: string; rect: DOMRect }[] = [],
): GroupTarget {
  return {
    groupId,
    rect: r,
    stripRect: rect(r.left, r.top + STRIP_OFFSET, r.width, stripH),
    tabs,
    ctx: { kind: "docked", nodeId, edge },
  };
}

function floatingTarget(
  groupId: GroupId,
  windowId: string,
  index: number,
  r: DOMRect,
  stripH = 30,
): GroupTarget {
  return {
    groupId,
    rect: r,
    stripRect: rect(r.left, r.top + STRIP_OFFSET, r.width, stripH),
    tabs: [],
    ctx: { kind: "floating", windowId, index },
  };
}

function run(
  layout: DockLayout,
  targets: GroupTarget[],
  x: number,
  y: number,
  regionWidth = REGION_W,
) {
  return hitTest(layout, regionWidth, CONTAINER, { groups: targets }, x, y);
}

// ===========================================================================
// inside()
// ===========================================================================
describe("inside", () => {
  const r = rect(10, 20, 100, 50); // [10..110] x [20..70]
  it("true at center and on edges", () => {
    expect(inside(r, 60, 45)).toBe(true);
    expect(inside(r, 10, 20)).toBe(true);
    expect(inside(r, 110, 70)).toBe(true);
  });
  it("false outside", () => {
    expect(inside(r, 9, 45)).toBe(false);
    expect(inside(r, 60, 71)).toBe(false);
  });
});

// ===========================================================================
// tabInsertion (incl. wrapping / multi-row)
// ===========================================================================
describe("tabInsertion", () => {
  it("returns null for no tabs", () => {
    expect(tabInsertion([], 0, 0)).toBeNull();
  });

  it("before the first tab when pointer is on its left half", () => {
    const tabs = [{ rect: rect(0, 0, 100, 30) }, { rect: rect(100, 0, 100, 30) }];
    const ins = tabInsertion(tabs, 20, 15)!;
    expect(ins.index).toBe(0);
    // The row-leftmost line is nudged INWARD (its tab's left edge is the
    // strip's flush border; a line there would hang half off the panel).
    expect(ins.lineLeft).toBe(3);
  });

  it("before a NON-leftmost tab keeps the line on the shared edge", () => {
    const tabs = [{ rect: rect(0, 0, 100, 30) }, { rect: rect(100, 0, 100, 30) }];
    const ins = tabInsertion(tabs, 110, 15)!;
    expect(ins.index).toBe(1);
    expect(ins.lineLeft).toBe(100); // left edge of tab 1 = right edge of tab 0
  });

  it("nudges the line for a wrapped second row's leftmost tab too", () => {
    const tabs = [
      { rect: rect(0, 0, 100, 30) },
      { rect: rect(100, 0, 100, 30) },
      { rect: rect(0, 30, 100, 30) }, // wrapped: leftmost of row 2
    ];
    const ins = tabInsertion(tabs, 20, 45)!;
    expect(ins.index).toBe(2);
    expect(ins.lineLeft).toBe(3);
  });

  it("after a tab when pointer is on its right half", () => {
    const tabs = [{ rect: rect(0, 0, 100, 30) }, { rect: rect(100, 0, 100, 30) }];
    const ins = tabInsertion(tabs, 80, 15)!;
    expect(ins.index).toBe(1);
    expect(ins.lineLeft).toBe(100); // right edge of tab 0
  });

  it("appends after the last tab", () => {
    const tabs = [{ rect: rect(0, 0, 100, 30) }, { rect: rect(100, 0, 100, 30) }];
    const ins = tabInsertion(tabs, 190, 15)!;
    expect(ins.index).toBe(2);
    expect(ins.lineLeft).toBe(200);
  });

  it("uses nearest-tab in 2D when tabs wrap onto a second row", () => {
    // Row 0: tabs 0,1 at y=[0..30]. Row 1: tabs 2,3 at y=[30..60].
    const tabs = [
      { rect: rect(0, 0, 100, 30) },
      { rect: rect(100, 0, 100, 30) },
      { rect: rect(0, 30, 100, 30) },
      { rect: rect(100, 30, 100, 30) },
    ];
    // Pointer over the left half of tab 2 (second row).
    const ins = tabInsertion(tabs, 20, 45)!;
    expect(ins.index).toBe(2);
    // Line anchored to the matched tab's own row.
    expect(ins.lineTop).toBeGreaterThanOrEqual(30);
    expect(ins.lineTop).toBeLessThan(60);
  });

  it("line height is a fraction of the tab height", () => {
    const tabs = [{ rect: rect(0, 0, 100, 40) }];
    const ins = tabInsertion(tabs, 10, 20)!;
    expect(ins.lineHeight).toBeCloseTo(40 * 0.55);
  });

  // Row-awareness regression: with an UNEVEN wrap (a long top row + a short
  // bottom row), a point in the bottom row that is horizontally PAST the lone
  // bottom tab must still resolve to the bottom row -- never snap up to a top-row
  // tab that happens to be horizontally nearer. The fix picks the row containing
  // y FIRST, then the nearest tab within that row.
  describe("row-aware insertion across uneven rows", () => {
    // Row 1: tabs 0,1,2 at y in [0,32). Row 2: lone tab 3 at y in [32,64).
    const rowTabs = [
      { rect: rect(0, 0, 100, 32) }, // tab 0  row 1
      { rect: rect(100, 0, 100, 32) }, // tab 1  row 1
      { rect: rect(200, 0, 100, 32) }, // tab 2  row 1
      { rect: rect(0, 32, 100, 32) }, // tab 3  row 2 (lone)
    ];

    it("sweeping x across row 2 always maps to the row-2 tab", () => {
      // Whatever x (even far right, past where the top row extends), a y inside
      // row 2 must resolve against the lone row-2 tab only -> index 3 (left half)
      // or 4 (right half / beyond), and the line stays in row 2's band.
      for (let x = 5; x <= 500; x += 20) {
        const ins = tabInsertion(rowTabs, x, 48)!;
        expect([3, 4]).toContain(ins.index);
        expect(ins.lineTop).toBeGreaterThanOrEqual(32);
        expect(ins.lineTop).toBeLessThan(64);
      }
    });
  });
});

// ===========================================================================
// Screen edge zones (only on an EMPTY edge)
// ===========================================================================
describe("screen edge zones", () => {
  it("left edge dock on an empty left edge", () => {
    const out = run(layoutWith({}), [], EDGE_ZONE_PX - 5, 400)!;
    expect(out.result).toEqual({ kind: "edge", edge: "left" });
    expect(out.hint).toMatchObject({ left: 0, top: 0, width: DEFAULT_REGION_PX, variant: "fill" });
    expect(out.hint.height).toBe(CONTAINER.height);
  });

  it("right edge dock on an empty right edge", () => {
    const out = run(layoutWith({}), [], CONTAINER.width - (EDGE_ZONE_PX - 5), 400)!;
    expect(out.result).toEqual({ kind: "edge", edge: "right" });
    expect(out.hint).toMatchObject({
      left: CONTAINER.width - DEFAULT_REGION_PX,
      width: DEFAULT_REGION_PX,
      variant: "fill",
    });
  });

  it("suppressed when the edge already has a region (falls through)", () => {
    // Left edge occupied; pointer in the left screen-edge band but inside the
    // region -> region/per-panel logic handles it, not the screen-edge zone.
    const node = leaf("a");
    const layout = layoutWith({ left: node });
    const tgt = dockedTarget("a", leafIdOf(node), "left", rect(0, 0, 300, 800));
    const out = run(layout, [tgt], EDGE_ZONE_PX - 5, 400)!;
    expect(out.result.kind).not.toBe("edge");
  });

  it("returns null when no zone and no group is hit", () => {
    // Both edges empty but pointer in the middle, no targets.
    expect(run(layoutWith({}), [], 500, 400)).toBeNull();
  });
});

// regression: screen-edge zones over a fully-minimized region. The region
// renders as a compact overlay rail floating over the canvas, so the screen
// edge still reads as empty -- dropping at the far edge docks a new outer
// column (no need to hit the rail handle's narrow zones).
describe("screen-edge dock next to an occupied region", () => {
  function minimizedRight(collapsed: boolean) {
    const l = emptyLayout();
    l.groups = {
      m: { ...group("m"), collapsed },
    };
    l.docked.right = {
      rows: [
        {
          id: "r101",
          weight: 1,
          columns: [
        { id: "Cm", weight: 1, leaves: [{ id: "Lm", group: "m", weight: 1 }] },
      ],
        },
      ],
    };
    return l;
  }

  // Minimized columns RESERVE width as fixed strips (no canvas overlay), so a
  // region holding only minimized panes is still an occupied edge: drops at
  // the screen edge resolve against the strip's own zones (split/merge), not
  // the empty-edge zone.
  it("does NOT offer the edge zone when every docked group is minimized", () => {
    const hit = hitTest(minimizedRight(true), REGION_W, CONTAINER, { groups: [] }, 990, 400);
    expect(hit?.result.kind).not.toBe("edge");
  });

  it("does NOT offer the edge zone when the region has expanded content", () => {
    const hit = hitTest(minimizedRight(false), REGION_W, CONTAINER, { groups: [] }, 990, 400);
    expect(hit?.result.kind).not.toBe("edge");
  });
});

// ===========================================================================
// Region edges (top/bottom full-width, left/right inner+outer; suppressed for
// a single full-span leaf)
// ===========================================================================
describe("region edge zones", () => {
  // A multi-cell region so the edges are NOT single leaves: a row [a|b] makes
  // top/bottom span both columns; a column [a/b] makes left/right span rows.
  it("top band of a multi-column region -> regionEdge top (thin full-width line)", () => {
    const tree = rowSplit([leaf("a"), leaf("b")]);
    const layout = layoutWith({ left: tree });
    const out = run(layout, [], 100, REGION_EDGE_PX - 5)!;
    expect(out.result).toEqual({ kind: "regionEdge", edge: "left", side: "top" });
    // Region-edge spans now preview as a thin LINE (consistent with per-panel
    // split lines), spanning the full region width at the top edge.
    expect(out.hint.variant).toBe("line");
    expect(out.hint.top).toBe(0);
    expect(out.hint.width).toBe(REGION_W.left);
    expect(out.hint.height).toBeLessThan(8); // thin
  });

  it("bottom band of a multi-column region -> regionEdge bottom (thin line at bottom)", () => {
    const tree = rowSplit([leaf("a"), leaf("b")]);
    const layout = layoutWith({ left: tree });
    const out = run(layout, [], 100, CONTAINER.height - (REGION_EDGE_PX - 5))!;
    expect(out.result).toEqual({ kind: "regionEdge", edge: "left", side: "bottom" });
    expect(out.hint.variant).toBe("line");
    expect(out.hint.height).toBeLessThan(8);
    // Line sits at the bottom edge of the region.
    expect(out.hint.top + out.hint.height).toBeCloseTo(CONTAINER.height, 0);
  });

  it("left band of a multi-row region -> regionEdge left (thin full-height line)", () => {
    const tree = colSplit([leaf("a"), leaf("b")]);
    const layout = layoutWith({ left: tree });
    // Avoid the top band; pick a y in the vertical middle.
    const out = run(layout, [], REGION_SIDE_PX - 5, 400)!;
    expect(out.result).toEqual({ kind: "regionEdge", edge: "left", side: "left" });
    expect(out.hint.variant).toBe("line");
    expect(out.hint.height).toBe(CONTAINER.height);
    expect(out.hint.width).toBeLessThan(8); // thin
  });

  it("right band (inner) of a multi-row left region -> regionEdge right", () => {
    const tree = colSplit([leaf("a"), leaf("b")]);
    const layout = layoutWith({ left: tree });
    const regionRight = REGION_W.left; // left region spans [0..300]
    const out = run(layout, [], regionRight - (REGION_SIDE_PX - 5), 400)!;
    expect(out.result).toEqual({ kind: "regionEdge", edge: "left", side: "right" });
    // Hint sits at the inner edge of the region.
    expect(out.hint.left + out.hint.width).toBeLessThanOrEqual(regionRight + 1);
  });

  it("right region: bands anchored to the right side of the screen", () => {
    const tree = colSplit([leaf("a"), leaf("b")]);
    const layout = layoutWith({ right: tree });
    const regionLeft = CONTAINER.width - REGION_W.right; // [700..1000]
    // Outer-right band.
    const out = run(layout, [], CONTAINER.width - (REGION_SIDE_PX - 5), 400)!;
    expect(out.result).toEqual({ kind: "regionEdge", edge: "right", side: "right" });
    expect(out.hint.left).toBeGreaterThanOrEqual(regionLeft);
  });

  it("suppressed for top/bottom when the edge is a single full-span leaf", () => {
    // A bare leaf: every edge is a single leaf, so region-edge zones are
    // suppressed and the pointer falls through to the per-panel group logic.
    const node = leaf("a");
    const layout = layoutWith({ left: node });
    const tgt = dockedTarget("a", leafIdOf(node), "left", rect(0, 0, 300, 800));
    const out = run(layout, [tgt], 150, REGION_EDGE_PX - 5)!;
    expect(out.result.kind).not.toBe("regionEdge");
  });

  it("top band over a multi-leaf column is an active region-edge band", () => {
    // A column [a/b]: top/bottom now add a full-width ROW BAND spanning the
    // column (the 4-level affordance), so the top band is a real region-edge
    // target -- NOT suppressed as redundant the way a lone single leaf is.
    const tree = colSplit([leaf("a"), leaf("b")]);
    const layout = layoutWith({ left: tree });
    const tgt = dockedTarget("a", leafIdsOf(tree)[0], "left", rect(0, 0, 300, 400));
    // Pointer in the top band, middle horizontally (past the side bands).
    const out = run(layout, [tgt], 150, REGION_EDGE_PX - 5)!;
    expect(out.result.kind).toBe("regionEdge");
  });
});

// ===========================================================================
// Docking to the OUTER edge of a fully-minimized region (a narrow strip).
// A minimized region renders as a ~36px strip -- narrower than REGION_SIDE_PX
// (40) -- so the inner and outer side bands would overlap. They're capped at
// half the region width so the OUTER edge stays reachable (dock a new outer
// column beside the minimized strip), matching an expanded region.
// ===========================================================================
describe("outer-edge dock beside a minimized region strip", () => {
  const STRIP = 36; // MINIMIZED_STRIP_PX
  // Rendered reserved width of a fully-minimized region is the strip width.
  const STRIP_W: Record<DockEdge, number> = { left: STRIP, right: STRIP };
  const stripLeft = CONTAINER.width - STRIP; // right region flush at screen edge

  function collapsedRightTarget(
    groupId: GroupId,
    nodeId: string,
    r: DOMRect,
  ): GroupTarget {
    return {
      groupId,
      rect: r,
      stripRect: null,
      tabs: [],
      ctx: { kind: "docked", nodeId, edge: "right" },
      collapsed: true,
    };
  }

  it("multi-panel minimized strip: outer half -> regionEdge right (new outer column)", () => {
    const top = leaf("g1");
    const bot = leaf("g2");
    const tree = colSplit([top, bot]); // two stacked rows -> left/right span both
    const layout = layoutWith({ right: tree });
    const t1 = collapsedRightTarget("g1", leafIdOf(top), rect(stripLeft, 0, STRIP, 400));
    const t2 = collapsedRightTarget("g2", leafIdOf(bot), rect(stripLeft, 400, STRIP, 400));
    // At the very outer (screen) edge: previously the 40px inner band swallowed
    // the whole 36px strip and this resolved to regionEdge "left" -- there was
    // no way to dock a new outer column. Now the outer half wins.
    const out = run(layout, [t1, t2], CONTAINER.width - 1, 200, STRIP_W)!;
    expect(out.result).toEqual({ kind: "regionEdge", edge: "right", side: "right" });
  });

  it("multi-panel minimized strip: inner half still -> regionEdge left", () => {
    const top = leaf("g1");
    const bot = leaf("g2");
    const tree = colSplit([top, bot]);
    const layout = layoutWith({ right: tree });
    const t1 = collapsedRightTarget("g1", leafIdOf(top), rect(stripLeft, 0, STRIP, 400));
    const t2 = collapsedRightTarget("g2", leafIdOf(bot), rect(stripLeft, 400, STRIP, 400));
    const out = run(layout, [t1, t2], stripLeft + 1, 200, STRIP_W)!;
    expect(out.result).toEqual({ kind: "regionEdge", edge: "right", side: "left" });
  });

  it("single-leaf minimized strip: outer edge -> split right (new outer column)", () => {
    const node = leaf("g");
    const layout = layoutWith({ right: node });
    const tgt = collapsedRightTarget("g", leafIdOf(node), rect(stripLeft, 0, STRIP, 800));
    // A single leaf suppresses the region-edge bands, so the collapsed 5-way
    // (3z) handles it: the outer band maps to a per-panel "right" split, which
    // builds [target, dragged] -> the dragged panel becomes the new outer column.
    const out = run(layout, [tgt], CONTAINER.width - 1, 400, STRIP_W)!;
    expect(out.result).toMatchObject({ kind: "split", region: "right" });
  });

  it("single minimized strip: the EMPTY area below it docks a full-height column beside", () => {
    // The strip cell is content-tall (~120px) but the region is 800px tall, so
    // there's a large empty area below. A drop there must offer a full-height
    // "dock a column beside" zone (regionEdge) -- not a dead None.
    const node = leaf("g");
    const layout = layoutWith({ right: node });
    layout.groups["g"] = group("g", 1, true); // mark the region's group collapsed
    // Content-tall strip at the top of the region; empty below.
    const tgt = collapsedRightTarget("g", leafIdOf(node), rect(stripLeft, 0, STRIP, 120));
    const out = run(layout, [tgt], stripLeft + STRIP / 2, 500, STRIP_W);
    expect(out).not.toBeNull();
    expect(out!.result).toMatchObject({ kind: "regionEdge", edge: "right" });
    // Full-height hint line (spans the container), not a strip-tall sliver.
    expect(out!.hint.height).toBeGreaterThan(400);
  });

  it("single minimized strip: over the strip's own rows still inserts a tab (cell wins)", () => {
    const node = leaf("g");
    const layout = layoutWith({ right: node });
    layout.groups["g"] = group("g", 1, true);
    const tgt = collapsedRightTarget("g", leafIdOf(node), rect(stripLeft, 0, STRIP, 120));
    tgt.tabs = [{ paneId: "p", rect: rect(stripLeft, 40, STRIP, 30) }];
    // Over a row (inside the strip cell) -> the cell's tab-insert wins, not the
    // region-beside band.
    const out = run(layout, [tgt], stripLeft + STRIP / 2, 55, STRIP_W);
    expect(out!.result).toMatchObject({ kind: "insertTab", targetGroupId: "g" });
  });

  it("over a spine-label row -> insertTab with an INSET hint line (not full strip width)", () => {
    const node = leaf("g");
    const layout = layoutWith({ right: node });
    // A content-tall strip (~70px) with two spine-label rows near the top.
    const tgt = collapsedRightTarget("g", leafIdOf(node), rect(stripLeft, 0, STRIP, 70));
    tgt.tabs = [
      { paneId: "p0", rect: rect(stripLeft, 4, STRIP, 30) },
      { paneId: "p1", rect: rect(stripLeft, 36, STRIP, 30) },
    ];
    // Hover the middle of the strip's x, over the second row -> insert there.
    const out = run(layout, [tgt], stripLeft + STRIP / 2, 40, STRIP_W)!;
    expect(out.result).toMatchObject({ kind: "insertTab", targetGroupId: "g" });
    // The hint line is inset from BOTH strip edges (no full-width rule).
    expect(out.hint.variant).toBe("line");
    expect(out.hint.width).toBeLessThan(STRIP);
    expect(out.hint.left).toBeGreaterThan(stripLeft - CONTAINER.left);
  });

  it("collapsed strip drop zones use the CONTENT rect, not a region-tall box", () => {
    // The leaf rect equals the visible strip (~70px), so a point below the rows
    // is OUTSIDE the cell -> it must NOT resolve to a phantom 'bottom split'
    // pinned to an 800px region bottom. (Regression: the tall-rect bug.)
    const node = leaf("g");
    const layout = layoutWith({ right: node });
    const tgt = collapsedRightTarget("g", leafIdOf(node), rect(stripLeft, 0, STRIP, 70));
    tgt.tabs = [{ paneId: "p0", rect: rect(stripLeft, 4, STRIP, 40) }];
    // A point far below the 70px strip is not over the target at all.
    const out = run(layout, [tgt], stripLeft + STRIP / 2, 500, STRIP_W);
    // Either no target (null) or, at worst, not a split pinned to y=500+.
    if (out !== null && out.result.kind === "split") {
      expect(out.hint.top).toBeLessThan(200);
    }
  });

  it("a CHIP target (horizontal pill) merges instead of Y-based row insertion", () => {
    // A collapsed group rendered as a horizontal chip (band bar / floating
    // bar) is one visual unit with no per-tab rows: even if a tab rect is
    // present, the middle of the chip must MERGE -- Y-based row insertion
    // would pick an arbitrary before/after index on a ~24px-tall pill.
    const node = leaf("g");
    const layout = layoutWith({ right: node });
    layout.groups["g"] = group("g", 1, true);
    // A wide, bar-height chip wrapper (the horizontal band's leaf wrapper).
    const tgt = collapsedRightTarget("g", leafIdOf(node), rect(stripLeft - 200, 0, 236, STRIP));
    tgt.chip = true;
    tgt.tabs = [{ paneId: "p", rect: rect(stripLeft - 190, 6, 120, 24) }];
    // Dead-center of the chip: inside the tab rect, past the edge bands.
    const out = run(layout, [tgt], stripLeft - 130, STRIP / 2, STRIP_W)!;
    expect(out.result).toMatchObject({ kind: "merge", targetGroupId: "g" });
  });
});

// ===========================================================================
// Per-panel 5-way for a docked group
// ===========================================================================
describe("docked group per-panel zones", () => {
  // A single docked leaf so region-edge zones are suppressed; the frame fills a
  // central area away from the screen/region edges.
  const node = leaf("a");
  const layout = layoutWith({ left: node });
  const frame = rect(100, 100, 400, 400); // strip starts at y=112, 30px tall
  // Tabs live in the strip row (y in [112..142]).
  const baseTabs = [
    { paneId: "a:0", rect: rect(100, 112, 80, 30) },
    { paneId: "a:1", rect: rect(180, 112, 80, 30) },
  ];
  const target = () => dockedTarget("a", leafIdOf(node), "left", frame, 30, baseTabs);

  it("above the strip -> split top (thin insertion line at the panel's top edge)", () => {
    // y in [frame.top=100 .. strip.top=112): inside the frame, above the strip.
    const out = run(layout, [target()], 300, 105)!;
    expect(out.result).toEqual({ kind: "split", edge: "left", nodeId: leafIdOf(node), region: "top" });
    // Per-panel split now previews as a thin LINE at the boundary, not a ghost.
    expect(out.hint.variant).toBe("line");
    expect(out.hint.width).toBeCloseTo(frame.width); // full-width line on the top edge
    expect(out.hint.height).toBeLessThan(8); // thin
    // The line is centered on the panel's top edge (within its own thickness).
    expect(out.hint.top + out.hint.height / 2).toBeCloseTo(frame.top, 0);
  });

  it("content TOP (just below the strip) -> MERGE, not a split", () => {
    // The content area no longer has an "above" band: per-panel "above this one"
    // lives only in the grip bar above the tabs (covered by the test above).
    // Just below the strip is merge territory, so "above" always reads as
    // physically above the tabs, never below them.
    // Content area is [strip.bottom=142 .. 500]; y=160 is at the top of content
    // but in the horizontal middle (rx=0.5), so it merges.
    const out = run(layout, [target()], 300, 160)!;
    expect(out.result).toEqual({ kind: "merge", targetGroupId: "a" });
    expect(out.hint.variant).toBe("merge");
  });

  it("over the strip -> insertTab at the nearest tab position", () => {
    const out = run(layout, [target()], 110, 125)!; // left half of tab 0
    expect(out.result).toEqual({ kind: "insertTab", targetGroupId: "a", index: 0 });
    expect(out.hint.variant).toBe("line");
  });

  it("over the strip, right half of a tab -> insertTab after it", () => {
    const out = run(layout, [target()], 170, 125)!; // right half of tab 0
    expect(out.result).toEqual({ kind: "insertTab", targetGroupId: "a", index: 1 });
  });

  it("content left band -> split left (thin line at the panel's left edge)", () => {
    // rx < SPLIT_BAND. Frame x in [100..500], width 400. SPLIT_BAND*400=88.
    // Use a mid y (in the side band, not the top/bottom band).
    const out = run(layout, [target()], 100 + 40, 320)!;
    expect(out.result).toEqual({ kind: "split", edge: "left", nodeId: leafIdOf(node), region: "left" });
    expect(out.hint.variant).toBe("line");
    expect(out.hint.width).toBeLessThan(8); // thin vertical line
    expect(out.hint.height).toBeCloseTo(frame.height);
    // The line is centered on the panel's left edge.
    expect(out.hint.left + out.hint.width / 2).toBeCloseTo(frame.left, 0);
  });

  it("content right band -> split right (thin line at the panel's right edge)", () => {
    const out = run(layout, [target()], 500 - 40, 320)!; // rx > 1-SPLIT_BAND
    expect(out.result).toEqual({ kind: "split", edge: "left", nodeId: leafIdOf(node), region: "right" });
    expect(out.hint.variant).toBe("line");
    expect(out.hint.width).toBeLessThan(8);
    // The line is centered on the panel's right edge.
    expect(out.hint.left + out.hint.width / 2).toBeCloseTo(frame.right, 0);
  });

  it("content bottom band -> split bottom (thin line at the panel's bottom edge)", () => {
    // content area is [strip.bottom=142 .. 500], ch=358. ry>1-SPLIT_BAND.
    const out = run(layout, [target()], 300, 500 - 20)!;
    expect(out.result).toEqual({ kind: "split", edge: "left", nodeId: leafIdOf(node), region: "bottom" });
    expect(out.hint.variant).toBe("line");
    expect(out.hint.height).toBeLessThan(8); // thin horizontal line
    // The line is centered on the panel's bottom edge.
    expect(out.hint.top + out.hint.height / 2).toBeCloseTo(frame.bottom, 0);
  });

  it("content center -> merge (whole-frame highlight)", () => {
    const out = run(layout, [target()], 300, 300)!;
    expect(out.result).toEqual({ kind: "merge", targetGroupId: "a" });
    expect(out.hint.variant).toBe("merge");
    expect(out.hint.width).toBeCloseTo(frame.width);
    expect(out.hint.height).toBeCloseTo(frame.height);
  });

  it("multi-row tab strip resolves to the wrapped row's tab", () => {
    // Strip starts at y=112; two rows of tabs at [112..132] and [132..152].
    const wrapTabs = [
      { paneId: "a:0", rect: rect(100, 112, 80, 20) },
      { paneId: "a:1", rect: rect(180, 112, 80, 20) },
      { paneId: "a:2", rect: rect(100, 132, 80, 20) }, // second row
    ];
    const tgt = dockedTarget("a", leafIdOf(node), "left", frame, 40, wrapTabs);
    const out = run(layout, [tgt], 110, 142)!; // over tab 2 (second row), left half
    expect(out.result).toEqual({ kind: "insertTab", targetGroupId: "a", index: 2 });
  });
});

// regression: the SEAM between two vertically-stacked docked panels [A above B]
// is one stable "insert between A and B" target. Crossing it used to flicker:
// A's bottom band drew the line at A.bottom, the ~SPLIT_DIVIDER_PX divider gap
// hit no target (a NONE dead frame), and B's grip bar drew at B.top -- so the
// hint jumped A.bottom -> (gone) -> B.top. Now all three resolve to a split that
// inserts between A and B, with the hint pinned to the gap center.
describe("seam between vertically-stacked docked panels is one stable target", () => {
  // Mirror the live geometry: A[15..404], 7px divider, B[411..800], in a left
  // column. B's strip starts STRIP_OFFSET below B.top, so [411..423) is B's grip
  // bar (above-strip -> split top).
  const A = rect(0, 15, 300, 389); // bottom = 404
  const B = rect(0, 411, 300, 389); // top = 411
  const tree = colSplit([leaf("a"), leaf("b")]);
  const layout = layoutWith({ left: tree });
  const aNode = leafIdsOf(tree)[0];
  const bNode = leafIdsOf(tree)[1];
  const targets = () => [
    dockedTarget("a", aNode, "left", A),
    dockedTarget("b", bNode, "left", B),
  ];
  const seamCenter = (A.bottom + B.top) / 2; // 407.5

  it("A's content bottom band -> split BELOW A (region bottom), line at gap center", () => {
    const out = run(layout, targets(), 150, A.bottom - 5)!; // y=399, in A
    expect(out.result).toEqual({
      kind: "split",
      edge: "left",
      nodeId: aNode,
      region: "bottom",
    });
    expect(out.hint.variant).toBe("line");
    expect(out.hint.top + out.hint.height / 2).toBeCloseTo(seamCenter, 0);
  });

  it("the divider gap (dead spot) -> split ABOVE B (region top), line at gap center", () => {
    const out = run(layout, targets(), 150, 407)!; // y=407, over the 7px divider
    expect(out.result).toEqual({
      kind: "split",
      edge: "left",
      nodeId: bNode,
      region: "top",
    });
    expect(out.hint.variant).toBe("line");
    expect(out.hint.top + out.hint.height / 2).toBeCloseTo(seamCenter, 0);
  });

  it("B's grip bar -> split ABOVE B (region top), line at gap center", () => {
    const out = run(layout, targets(), 150, B.top + 6)!; // y=417, B's grip bar
    expect(out.result).toEqual({
      kind: "split",
      edge: "left",
      nodeId: bNode,
      region: "top",
    });
    expect(out.hint.variant).toBe("line");
    expect(out.hint.top + out.hint.height / 2).toBeCloseTo(seamCenter, 0);
  });

  it("the hint line stays at ONE position with NO null frame across the whole seam band", () => {
    let lastTop: number | null = null;
    const tops: number[] = [];
    for (let y = A.bottom - 8; y <= B.top + 10; y += 1) {
      const out = run(layout, targets(), 150, y);
      // Once we are in the seam band (at/after A.bottom) there must be no dead
      // frame and the result must insert between A and B.
      if (y >= A.bottom) {
        expect(out, `null hint at y=${y}`).not.toBeNull();
        const res = out!.result;
        expect(res.kind).toBe("split");
        if (res.kind === "split") {
          // Always either "below A" or "above B" -- both insert between them.
          expect(
            (res.nodeId === aNode && res.region === "bottom") ||
              (res.nodeId === bNode && res.region === "top"),
          ).toBe(true);
        }
        tops.push(out!.hint.top);
      }
      if (out !== null) lastTop = out.hint.top;
    }
    void lastTop;
    // Hint line never moves while crossing the seam (stable, no 7px jump).
    const min = Math.min(...tops);
    const max = Math.max(...tops);
    expect(max - min).toBeLessThanOrEqual(1);
  });

  it("single docked leaf (no sibling): bottom band still docks at the panel's own bottom edge", () => {
    // Region-edge zones are suppressed for a single full-span leaf, so the
    // per-panel bottom band must still work and anchor to the panel edge (the
    // seam-snap must not kick in without a sibling).
    const solo = leaf("a");
    const soloLayout = layoutWith({ left: solo });
    const frame = rect(0, 100, 300, 400); // bottom=500, mid-region (clamp inactive)
    const out = run(
      soloLayout,
      [dockedTarget("a", leafIdOf(solo), "left", frame)],
      150,
      frame.bottom - 10,
    )!;
    expect(out.result).toEqual({
      kind: "split",
      edge: "left",
      nodeId: leafIdOf(solo),
      region: "bottom",
    });
    expect(out.hint.top + out.hint.height / 2).toBeCloseTo(frame.bottom, 0);
  });
});

// A content-sized minimized strip reads top-to-bottom: a thin top/bottom EDGE
// band stacks a new cell above/below, the spine-label rows insert at a tab
// position, and the + cap (just inside the top edge) merges. The cap must NOT be
// swallowed by the "above" zone -- that was the merge-unreachable regression.
describe("collapsed-target vertical zones (content-sized strip)", () => {
  // A minimized RIGHT region renders as a strip flush at the screen edge, with
  // the rendered (reserved) region width == the strip width -- that's what
  // hitTest receives. Center the probes on the strip's MIDDLE third so they hit
  // the cell's own zones (the outer/inner thirds are the region "dock beside"
  // band, full height). The strip sits below the region top band.
  const STRIP = 40;
  const SW: Record<DockEdge, number> = { left: STRIP, right: STRIP };
  const left = CONTAINER.width - STRIP; // flush right
  const midX = left + STRIP / 2;
  const mkStrip = (tabs: { paneId: string; rect: DOMRect }[]): GroupTarget => ({
    groupId: "s",
    rect: rect(left, 100, STRIP, 80), // top at y=100, clear of the region top band
    stripRect: null,
    tabs,
    ctx: { kind: "docked", nodeId: "Ls", edge: "right" },
    collapsed: true,
  });
  const baseLayout = () => {
    const l = emptyLayout();
    l.groups = { s: group("s", 1, true) };
    l.docked.right = {
      rows: [
        {
          id: "r102",
          weight: 1,
          columns: [
        { id: "Cs", weight: 1, leaves: [{ id: "Ls", group: "s", weight: 1 }] },
      ],
        },
      ],
    };
    return l;
  };

  it("the + cap (just inside the top edge) -> add to the group, not split-above", () => {
    const l = baseLayout();
    const strip = mkStrip([
      { paneId: "p0", rect: rect(left, 124, STRIP, 26) },
      { paneId: "p1", rect: rect(left, 152, STRIP, 26) },
    ]);
    const targets: DropTargets = { groups: [strip] };
    // y=115: the + cap, above the first row (at y=124) but past the 6px edge
    // band (ends at y=106). It must ADD the panel to the group (insertTab at the
    // top), NOT a split-above -- regression: the cap used to be swallowed by the
    // "above" split zone, leaving no way to drop INTO a minimized strip.
    const out = hitTest(l, SW, CONTAINER, targets, midX, 115)?.result;
    expect(out).toMatchObject({ kind: "insertTab", targetGroupId: "s", index: 0 });
  });

  it("thin top/bottom edges -> split; over a row -> insertTab", () => {
    const l = baseLayout();
    const strip = mkStrip([
      { paneId: "p0", rect: rect(left, 124, STRIP, 26) },
      { paneId: "p1", rect: rect(left, 152, STRIP, 26) },
    ]);
    const targets: DropTargets = { groups: [strip] };
    // y=101: thin top edge -> split top.
    expect(hitTest(l, SW, CONTAINER, targets, midX, 101)?.result).toMatchObject({
      kind: "split",
      region: "top",
    });
    // y=130: over the first row -> insertTab.
    expect(hitTest(l, SW, CONTAINER, targets, midX, 130)?.result).toMatchObject({
      kind: "insertTab",
      targetGroupId: "s",
    });
    // y=179: thin bottom edge -> split bottom.
    expect(hitTest(l, SW, CONTAINER, targets, midX, 179)?.result).toMatchObject({
      kind: "split",
      region: "bottom",
    });
  });
});

// ===========================================================================
// Floating snap (above / below) with correct stack index
// ===========================================================================
describe("floating snap zones", () => {
  const layout = layoutWith({}); // no docked regions; both edges empty but
  // pointer stays in the middle so screen-edge zones don't fire.
  const frame = rect(400, 200, 300, 300); // strip 30px

  it("above the strip -> snap at this group's index (line hint above)", () => {
    const tgt = floatingTarget("g", "w1", 2, frame);
    // y in [frame.top=200 .. strip.top=212): inside the frame, above the strip.
    const out = run(layout, [tgt], 550, 205)!;
    expect(out.result).toEqual({ kind: "snap", windowId: "w1", index: 2 });
    expect(out.hint.variant).toBe("line");
    // Line sits just above the frame top.
    expect(out.hint.top).toBeLessThanOrEqual(frame.top - CONTAINER.top);
  });

  it("bottom band -> snap below at index+1 (line hint at frame bottom)", () => {
    const tgt = floatingTarget("g", "w1", 2, frame);
    // content area [230..500], ch=270; ry>1-SPLIT_BAND.
    const out = run(layout, [tgt], 550, 500 - 20)!;
    expect(out.result).toEqual({ kind: "snap", windowId: "w1", index: 3 });
    expect(out.hint.variant).toBe("line");
    expect(out.hint.top).toBeCloseTo(frame.bottom - CONTAINER.top - 2);
  });

  it("content center of a floating group -> merge (no split for floating)", () => {
    const tgt = floatingTarget("g", "w1", 0, frame);
    const out = run(layout, [tgt], 550, 350)!;
    expect(out.result).toEqual({ kind: "merge", targetGroupId: "g" });
    expect(out.hint.variant).toBe("merge");
  });

  it("over the strip of a floating group -> insertTab still applies", () => {
    // Strip starts at frame.top+12 = 212, 30px tall -> tabs in [212..242].
    const tabs = [{ paneId: "g:0", rect: rect(400, 212, 80, 30) }];
    const tgt: GroupTarget = {
      groupId: "g",
      rect: frame,
      stripRect: rect(frame.left, frame.top + 12, frame.width, 30),
      tabs,
      ctx: { kind: "floating", windowId: "w1", index: 0 },
    };
    const out = run(layout, [tgt], 420, 225)!;
    expect(out.result.kind).toBe("insertTab");
  });
});

// ===========================================================================
// Nested dockable AREA targets. An area is a FLAT tab group: the only drops are
// insert-at-a-tab-position (over its strip) or merge/append (anywhere else,
// including an empty area with no strip). Never split / snap / above-strip.
// ===========================================================================
describe("area target", () => {
  // An area group lives in layout.areas, not docked/floating. The pointer is
  // over its frame; the screen/region-edge zones don't apply (no docked region),
  // and the pointer is kept in the middle so screen-edge zones don't fire.
  const layout = (() => {
    const l = emptyLayout();
    l.groups = { area: { id: "area", paneIds: ["p0", "p1"], activeId: "p0" } };
    l.areas = { "a1": { group: "area" } };
    return l;
  })();
  const frame = rect(400, 200, 300, 300); // strip 30px, starts at y=212

  function areaTarget(opts?: {
    stripRect?: DOMRect | null;
    tabs?: { paneId: string; rect: DOMRect }[];
  }): GroupTarget {
    return {
      groupId: "area",
      rect: frame,
      stripRect:
        opts?.stripRect === undefined
          ? rect(frame.left, frame.top + STRIP_OFFSET, frame.width, 30)
          : opts.stripRect,
      tabs:
        opts?.tabs ?? [
          { paneId: "p0", rect: rect(400, frame.top + STRIP_OFFSET, 80, 30) },
          { paneId: "p1", rect: rect(480, frame.top + STRIP_OFFSET, 80, 30) },
        ],
      ctx: { kind: "area", areaId: "a1" },
    };
  }

  it("over the strip -> insertTab at the nearest tab position", () => {
    // Left half of tab 0 (strip y in [212..242]).
    const out = run(layout, [areaTarget()], 410, 225)!;
    expect(out.result).toEqual({ kind: "insertTab", targetGroupId: "area", index: 0 });
    expect(out.hint.variant).toBe("line");
  });

  it("over the strip, right half of tab 0 -> insertTab after it", () => {
    const out = run(layout, [areaTarget()], 470, 225)!; // right half of tab 0
    expect(out.result).toEqual({ kind: "insertTab", targetGroupId: "area", index: 1 });
  });

  it("over the body (below the strip) -> merge", () => {
    // y well below the strip (content area), middle of the frame.
    const out = run(layout, [areaTarget()], 550, 400)!;
    expect(out.result).toEqual({ kind: "merge", targetGroupId: "area" });
    expect(out.hint.variant).toBe("merge");
  });

  it("ABOVE the strip (in the frame, above tabs) -> merge, not a split/snap", () => {
    // y in [frame.top=200 .. strip.top=212): for a docked/floating group this is
    // a split/snap zone, but an area has no such zone -- it merges.
    const out = run(layout, [areaTarget()], 550, 205)!;
    expect(out.result).toEqual({ kind: "merge", targetGroupId: "area" });
  });

  it("near a frame edge -> still merge (areas never split or snap)", () => {
    // Far-left content band: a docked group would resolve to a left SPLIT here;
    // an area must merge instead.
    const out = run(layout, [areaTarget()], frame.left + 5, 400)!;
    expect(out.result).toEqual({ kind: "merge", targetGroupId: "area" });
  });

  it("inset hitRect: the leftmost tab is still droppable over the strip", () => {
    // regression: a full-bleed area's hitRect is inset on the left/right/bottom
    // (so its frame falls through to the host). The left inset used to slice
    // the leftmost tab's "insert before" zone, so dropping as the FIRST tab was
    // impossible (it fell through to the host). The strip must use full width.
    const INSET = 40;
    const t = areaTarget();
    t.hitRect = rect(
      frame.left + INSET,
      frame.top,
      frame.width - 2 * INSET,
      frame.height - INSET,
    );
    // Pointer over the LEFT half of tab 0, inside the inset band (x < left+40).
    const out = run(layout, [t], frame.left + 10, frame.top + STRIP_OFFSET + 15)!;
    expect(out.result).toEqual({
      kind: "insertTab",
      targetGroupId: "area",
      index: 0,
    });
    // And the rightmost edge of the strip (after the last tab) still inserts.
    const right = run(layout, [t], frame.right - 5, frame.top + STRIP_OFFSET + 15)!;
    expect(right.result).toEqual({
      kind: "insertTab",
      targetGroupId: "area",
      index: 2,
    });
    // The BODY keeps the inset: a far-left point below the strip is NOT the
    // area (falls through -- here there's no other target, so null).
    expect(run(layout, [t], frame.left + 10, 400)).toBeNull();
  });

  it("an EMPTY area (stripRect null, no tabs) -> merge anywhere in the frame", () => {
    const empty = areaTarget({ stripRect: null, tabs: [] });
    // Anywhere inside the frame resolves to merge -- the empty area is one big
    // drop target (its placeholder body).
    expect(run(layout, [empty], 550, 400)!.result).toEqual({
      kind: "merge",
      targetGroupId: "area",
    });
    // Even where a strip WOULD have been (top of the frame), it's still a merge.
    expect(run(layout, [empty], 550, 205)!.result).toEqual({
      kind: "merge",
      targetGroupId: "area",
    });
  });
});

// ===========================================================================
// Priority / fall-through ordering
// ===========================================================================
describe("zone priority", () => {
  it("screen edge wins over a group under the same pointer (empty edge)", () => {
    const node = leaf("a");
    const layout = layoutWith({ right: node }); // left edge empty
    const tgt = dockedTarget("a", leafIdOf(node), "right", rect(0, 0, 300, 800));
    // Pointer in the left screen-edge band AND over the (mis-placed) target.
    const out = run(layout, [tgt], EDGE_ZONE_PX - 5, 400)!;
    expect(out.result).toEqual({ kind: "edge", edge: "left" });
  });

  it("region edge wins over the per-panel split for the same pointer", () => {
    const tree = rowSplit([leaf("a"), leaf("b")]);
    const layout = layoutWith({ left: tree });
    const tgt = dockedTarget("a", leafIdsOf(tree)[0], "left", rect(0, 0, 150, 800));
    // Top band of the multi-column region; also over group a's frame.
    const out = run(layout, [tgt], 50, REGION_EDGE_PX - 5)!;
    expect(out.result.kind).toBe("regionEdge");
  });

  // regression: a tab-strip insert beats the region-edge band that overlaps it.
  // A region-edge band spans the WHOLE region, so the leftmost tab of a stacked
  // (column) region sits inside the 40px left region-side band, and a topmost
  // panel's strip sits inside the 8px top band. Dropping THERE must still
  // insert at the tab position (more specific than a region span) -- not dock a
  // region-wide column/row. (Lives in hitTest.ts: an "over an insertable strip"
  // guard skips the region-edge bands.)
  describe("tab-strip insert wins over the region-edge band it overlaps", () => {
    // Column [a/b]: left/right span rows, so edgeIsSingleLeaf(_, "left") is
    // false and the 40px left region-side band is LIVE across both panes.
    const tree = colSplit([leaf("a"), leaf("b")]);
    const layout = layoutWith({ left: tree });

    function colTarget(
      groupId: GroupId,
      nodeId: string,
      frame: DOMRect,
      stripTop: number,
    ): GroupTarget {
      return {
        groupId,
        rect: frame,
        stripRect: rect(frame.left, stripTop, frame.width, 30),
        tabs: [
          { paneId: `${groupId}:0`, rect: rect(frame.left, stripTop, 70, 30) },
          { paneId: `${groupId}:1`, rect: rect(frame.left + 70, stripTop, 70, 30) },
        ],
        ctx: { kind: "docked", nodeId, edge: "left" },
      };
    }

    it("lower stacked panel: leftmost tab in the left side band -> insertTab 0", () => {
      // b's strip is mid-region (clear of the 8px top band) but its leftmost tab
      // is flush at x=0, i.e. inside the 40px left region-side band.
      const tgt = colTarget("b", leafIdsOf(tree)[1], rect(0, 400, 300, 400), 412);
      const out = run(layout, [tgt], 20, 425)!;
      expect(out.result).toEqual({ kind: "insertTab", targetGroupId: "b", index: 0 });
    });

    it("topmost stacked panel: strip in the top band -> insertTab 0", () => {
      // a's strip is flush at the region top (y in the 8px top band) AND its
      // leftmost tab is in the left side band -- both region bands overlap it.
      const tgt = colTarget("a", leafIdsOf(tree)[0], rect(0, 0, 300, 400), 2);
      const out = run(layout, [tgt], 20, 7)!;
      expect(out.result).toEqual({ kind: "insertTab", targetGroupId: "a", index: 0 });
    });

    it("draggingUnmergeable: still a region span (no tab insert possible)", () => {
      // An unmergeable dragged stack can't become tabs, so the strip is NOT an
      // insertable target -- the region-edge band must still win there.
      const tgt = colTarget("b", leafIdsOf(tree)[1], rect(0, 400, 300, 400), 412);
      const out = hitTest(layout, REGION_W, CONTAINER, { groups: [tgt] }, 20, 425, {
        draggingUnmergeable: true,
      })!;
      expect(out.result.kind).toBe("regionEdge");
    });

    it("the region-edge band still wins OFF the strip (content side band)", () => {
      // Same column region, but the pointer is in the content area (below the
      // strip) within the left side band -> region span, as before.
      const tgt = colTarget("b", leafIdsOf(tree)[1], rect(0, 400, 300, 400), 412);
      const out = run(layout, [tgt], 20, 600)!;
      expect(out.result).toEqual({ kind: "regionEdge", edge: "left", side: "left" });
    });
  });
});

// ---------------------------------------------------------------------------
// Targets with a populated tab strip (one tab), used by the overlapping-target
// and draggingUnmergeable regression pins below.
// ---------------------------------------------------------------------------
function floatTarget(group: string, windowId: string, r: DOMRect): GroupTarget {
  return {
    groupId: group,
    rect: r,
    stripRect: rect(r.left, r.top + 12, r.width, 28),
    tabs: [{ paneId: `${group}.0`, rect: rect(r.left, r.top + 12, 70, 28) }],
    ctx: { kind: "floating", windowId, index: 0 },
  };
}
function dockTarget(group: string, nodeId: string, r: DOMRect): GroupTarget {
  return {
    groupId: group,
    rect: r,
    stripRect: rect(r.left, r.top + 12, r.width, 28),
    tabs: [{ paneId: `${group}.0`, rect: rect(r.left, r.top + 12, 80, 28) }],
    ctx: { kind: "docked", nodeId, edge: "left" },
  };
}

// regression: when drop targets overlapped, hitTest resolved to the FIRST
// matching rect (the target painted UNDERNEATH); the LAST match (topmost,
// back-to-front target order) must win. See the file header for the history.
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
      floatingWindow({ id: "w1", x: 400, y: 300, width: 200, stack: ["a"] }), // bottom
      floatingWindow({ id: "w2", x: 420, y: 320, width: 200, stack: ["b"] }), // top
    ];
    // Targets ordered back-to-front (ascending z): bottom window first, top last.
    const targets: DropTargets = {
      groups: [
        floatTarget("a", "w1", rect(400, 300, 200, 240)),
        floatTarget("b", "w2", rect(420, 320, 200, 240)),
      ],
    };
    // (500, 400) is inside BOTH windows; w2 is visually on top.
    const r = hitTest(l, REGION_W, CONTAINER, targets, 500, 400);
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
    l.docked.left = {
      rows: [
        {
          id: "r103",
          weight: 1,
          columns: [
        { id: "Cd", weight: 1, leaves: [{ id: "Ld", group: "d", weight: 1 }] },
      ],
        },
      ],
    };
    l.floating = [floatingWindow({ id: "wf", x: 100, y: 300, width: 180, stack: ["f"] })];
    const targets: DropTargets = {
      groups: [
        dockTarget("d", "Ld", rect(0, 0, 300, 800)),
        floatTarget("f", "wf", rect(100, 300, 180, 240)),
      ],
    };
    // (180, 420): inside the floating window AND the docked region's content area.
    const r = hitTest(l, REGION_W, CONTAINER, targets, 180, 420);
    expect(r?.result).toEqual({ kind: "merge", targetGroupId: "f" }); // FIXED: float on top wins
  });

  it("counter-case (works): non-overlapping windows resolve correctly", () => {
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
    };
    l.floating = [
      floatingWindow({ id: "w1", x: 50, y: 300, width: 150, stack: ["a"] }),
      floatingWindow({ id: "w2", x: 500, y: 300, width: 150, stack: ["b"] }),
    ];
    const targets: DropTargets = {
      groups: [
        floatTarget("a", "w1", rect(50, 300, 150, 240)),
        floatTarget("b", "w2", rect(500, 300, 150, 240)),
      ],
    };
    // Distinct, non-overlapping centers hit the right windows.
    expect(hitTest(l, REGION_W, CONTAINER, targets, 125, 400)?.result).toEqual({
      kind: "merge",
      targetGroupId: "a",
    });
    expect(hitTest(l, REGION_W, CONTAINER, targets, 575, 400)?.result).toEqual({
      kind: "merge",
      targetGroupId: "b",
    });
  });
});

// ===========================================================================
// Unmergeable groups: nothing may be merged or inserted into them.
// ===========================================================================
describe("unmergeable target", () => {
  // A single docked leaf, centered so the region-edge bands don't interfere.
  // Region is the left edge spanning [0..300]; put the frame's content area at
  // x in [40..260] (inside the side bands) and y in the middle.
  const node = leaf("u");
  const layout = layoutWith({ left: node });
  // Frame fills the left region; strip at the top.
  const frame = rect(0, 0, 300, 800);

  function target(unmergeable: boolean): GroupTarget {
    return {
      groupId: "u",
      rect: frame,
      stripRect: rect(frame.left, frame.top + STRIP_OFFSET, frame.width, 30),
      tabs: [{ paneId: "u:0", rect: rect(0, STRIP_OFFSET, 80, 30) }],
      ctx: { kind: "docked", nodeId: leafIdOf(node), edge: "left" },
      unmergeable,
    };
  }

  it("center of a normal docked group -> merge", () => {
    // Middle of the content area (past the side/below split bands).
    const out = run(layout, [target(false)], 150, 400)!;
    expect(out.result).toEqual({ kind: "merge", targetGroupId: "u" });
  });

  it("center of an UNMERGEABLE docked group -> null (no merge)", () => {
    const out = run(layout, [target(true)], 150, 400);
    expect(out).toBeNull();
  });

  it("over the header of an UNMERGEABLE group -> not an insertTab", () => {
    // y over the strip/header row.
    const out = run(layout, [target(true)], 40, STRIP_OFFSET + 15);
    // Header is not a tab-insert target; either null (merge-suppressed) or a
    // split, but never insertTab.
    expect(out?.result.kind).not.toBe("insertTab");
  });

  it("edge split still works on an UNMERGEABLE docked group", () => {
    // Right split band of the content area (rx > 1 - SPLIT_BAND).
    const out = run(layout, [target(true)], 300 - 10, 400)!;
    expect(out.result.kind).toBe("split");
    expect((out.result as { region: string }).region).toBe("right");
  });

  it("floating UNMERGEABLE: center is null, snap-below still works", () => {
    const fl = layoutWith({});
    const fr = rect(400, 200, 300, 300);
    const ft: GroupTarget = {
      groupId: "u",
      rect: fr,
      stripRect: rect(fr.left, fr.top + STRIP_OFFSET, fr.width, 30),
      tabs: [{ paneId: "u:0", rect: rect(400, 200 + STRIP_OFFSET, 80, 30) }],
      ctx: { kind: "floating", windowId: "w1", index: 0 },
      unmergeable: true,
    };
    // Center -> no merge.
    expect(run(fl, [ft], 550, 350)).toBeNull();
    // Snap below (bottom band) -> snap, unaffected by unmergeable.
    const below = run(fl, [ft], 550, 200 + 300 - 5)!;
    expect(below.result.kind).toBe("snap");
  });
});

// regression: draggingUnmergeable -- source-side merge policy lives in hitTest
// (not vetoed after the fact by DockManager), so hints never advertise a merge
// that the drop would discard.
describe("draggingUnmergeable suppresses merge/insertTab from the SOURCE side", () => {
  function floatingLayoutAB() {
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
    };
    l.floating = [
      floatingWindow({ id: "w1", x: 400, y: 300, width: 200, stack: ["a"] }),
      floatingWindow({ id: "w2", x: 700, y: 300, width: 200, stack: ["b"] }),
    ];
    return l;
  }

  it("content-area merge becomes null; the same point merges when mergeable", () => {
    const l = floatingLayoutAB();
    const targets: DropTargets = {
      groups: [floatTarget("a", "w1", rect(400, 300, 200, 240))],
    };
    // Mid-content point (past the strip, outside the snap-below band).
    const without = hitTest(l, REGION_W, CONTAINER, targets, 500, 400);
    expect(without?.result).toEqual({ kind: "merge", targetGroupId: "a" });
    const withFlag = hitTest(l, REGION_W, CONTAINER, targets, 500, 400, {
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
    const without = hitTest(l, REGION_W, CONTAINER, targets, 560, 326);
    expect(without?.result.kind).toBe("insertTab");
    const withFlag = hitTest(l, REGION_W, CONTAINER, targets, 560, 326, {
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
    const r = hitTest(l, REGION_W, CONTAINER, targets, 500, 538, {
      draggingUnmergeable: true,
    });
    expect(r?.result).toEqual({ kind: "snap", windowId: "w1", index: 1 });
  });

  it("docked split is still offered; only the center merge is suppressed", () => {
    const l = floatingLayoutAB();
    l.docked.left = {
      rows: [
        {
          id: "r104",
          weight: 1,
          columns: [
        { id: "Ca", weight: 1, leaves: [{ id: "La", group: "a", weight: 1 }] },
      ],
        },
      ],
    };
    const targets: DropTargets = {
      groups: [dockTarget("a", "La", rect(0, 0, 300, 800))],
    };
    // Left band of the content area (rx < 0.22) -> split left, allowed for
    // unmergeable. x=50 is past the 40px region-side band, inside the split band.
    const split = hitTest(l, REGION_W, CONTAINER, targets, 50, 400, {
      draggingUnmergeable: true,
    });
    expect(split?.result.kind).toBe("split");
    // Center of the content area -> merge without the flag, null with it.
    const center = hitTest(l, REGION_W, CONTAINER, targets, 150, 400);
    expect(center?.result.kind).toBe("merge");
    const centerFlagged = hitTest(l, REGION_W, CONTAINER, targets, 150, 400, {
      draggingUnmergeable: true,
    });
    expect(centerFlagged).toBeNull();
  });
});

// ===========================================================================
// regression: unmergeable docked panel -- its header is the "dock above" zone,
// and the left/right split bands are pixel-capped.
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
    l.groups = { ctrl: { id: "ctrl", paneIds: ["c.0"], activeId: "c.0" } };
    l.docked.right = {
      rows: [
        {
          id: "r105",
          weight: 1,
          columns: [
        { id: "Cc", weight: 1, leaves: [{ id: "Lc", group: "ctrl", weight: 1 }] },
      ],
        },
      ],
    };
    return l;
  }

  it("header of a docked unmergeable panel -> split top (dock above)", () => {
    const l = layoutDockedRight();
    const targets: DropTargets = {
      groups: [unmergeableDockTarget(rect(680, 0, 320, 800))],
    };
    // Header center; past the region's suppressed top band (y=22 > 8 works
    // because the single-leaf region suppresses the regionEdge zone).
    const hit = hitTest(l, REGION_W, CONTAINER, targets, 840, 22);
    expect(hit?.result).toEqual({
      kind: "split",
      edge: "right",
      nodeId: "Lc",
      region: "top",
    });
  });

  it("header of a floating unmergeable window -> snap above", () => {
    const l = emptyLayout();
    l.groups = { ctrl: { id: "ctrl", paneIds: ["c.0"], activeId: "c.0" } };
    l.floating = [floatingWindow({ id: "wc", x: 400, y: 100, width: 320, stack: ["ctrl"] })];
    const t: GroupTarget = {
      groupId: "ctrl",
      rect: rect(400, 100, 320, 400),
      stripRect: rect(400, 100, 320, 44),
      tabs: [],
      ctx: { kind: "floating", windowId: "wc", index: 0 },
      unmergeable: true,
    };
    const hit = hitTest(l, REGION_W, CONTAINER, { groups: [t] }, 560, 122);
    expect(hit?.result).toEqual({ kind: "snap", windowId: "wc", index: 0 });
  });

  it("content center of an unmergeable target is still a dead zone", () => {
    const l = layoutDockedRight();
    const targets: DropTargets = {
      groups: [unmergeableDockTarget(rect(680, 0, 320, 800))],
    };
    expect(hitTest(l, REGION_W, CONTAINER, targets, 840, 400)).toBeNull();
  });

  it("left/right split bands are pixel-capped on wide panes", () => {
    const l = layoutDockedRight();
    // 400px-wide panel: 22% would be 88px; the cap holds the band at 70px.
    const targets: DropTargets = {
      groups: [unmergeableDockTarget(rect(600, 0, 400, 800))],
    };
    const inBand = hitTest(l, REGION_W, CONTAINER, targets, 600 + 50, 400);
    expect(inBand?.result).toMatchObject({ kind: "split", region: "left" });
    const pastCap = hitTest(l, REGION_W, CONTAINER, targets, 600 + 80, 400);
    expect(pastCap).toBeNull(); // dead center for unmergeable, not "left"
  });
});
