// Intent tests for hitTest on MULTI-BAND docked regions (the 4-level shape's
// reason to exist).
//
// The sweep tests prove hitTest never produces an *invalid* result on
// multi-band layouts. These assert the INTENT: a given pixel must resolve to
// the drop a user expects, not merely to *some* valid target. Wrong-intent
// drops (e.g. a cross-band seam that silently stacks into one band's column
// instead of inserting a band) are exactly the "minor hitbox bugs" the user
// reported.
//
// Geometry helper: we lay a region out as SplitView does -- a vertical stack of
// full-width bands, each band a row of columns, each column a stack of leaves --
// so the synthetic rects match what the renderer produces and DockManager would
// collect.

import { describe, it, expect } from "vitest";
import { hitTest, GroupTarget, ContainerRect, DropResult } from "./hitTest";
import { DockEdge, DockLayout, emptyLayout } from "./types";
import { rect, leaf, row, rows, group, toRegion } from "./testUtils";

const CONTAINER: ContainerRect = { left: 0, top: 0, width: 1000, height: 800 };
const REGION_W: Record<DockEdge, number> = { left: 300, right: 300 };
const STRIP_OFFSET = 12;
const STRIP_H = 28;

/** Lay out a docked region exactly like SplitView: bands stacked by row weight,
 * columns by column weight, leaves by leaf weight. Returns the targets PLUS a
 * lookup of each leaf's frame rect by group id (for precise probing). */
function layoutTargets(
  layout: DockLayout,
  edge: DockEdge,
): { targets: GroupTarget[]; frameOf: Record<string, DOMRect> } {
  const region = layout.docked[edge];
  const targets: GroupTarget[] = [];
  const frameOf: Record<string, DOMRect> = {};
  if (region === null) return { targets, frameOf };
  const regionLeft = edge === "left" ? 0 : CONTAINER.width - REGION_W[edge];
  const regionW = REGION_W[edge];
  const rowTotal = region.rows.reduce((s, r) => s + r.weight, 0);
  let bandTop = 0;
  for (const band of region.rows) {
    const bandH = (band.weight / rowTotal) * CONTAINER.height;
    const colTotal = band.columns.reduce((s, c) => s + c.weight, 0);
    let colLeft = regionLeft;
    for (const column of band.columns) {
      const cw = (column.weight / colTotal) * regionW;
      const ch = bandH / column.leaves.length;
      column.leaves.forEach((lf, li) => {
        const x = colLeft;
        const y = bandTop + li * ch;
        const r = rect(x, y, cw, ch);
        frameOf[lf.group] = r;
        const g = layout.groups[lf.group];
        const tabW = Math.min(80, cw / 3);
        const tabs = (g?.paneIds ?? []).map((paneId, i) => ({
          paneId,
          rect: rect(x + i * tabW, y + STRIP_OFFSET, tabW, STRIP_H),
        }));
        targets.push({
          groupId: lf.group,
          rect: r,
          stripRect: rect(x, y + STRIP_OFFSET, cw, STRIP_H),
          tabs,
          collapsed: g?.collapsed === true ? true : undefined,
          ctx: { kind: "docked", nodeId: lf.id, edge },
        });
      });
      colLeft += cw;
    }
    bandTop += bandH;
  }
  return { targets, frameOf };
}

function run(
  layout: DockLayout,
  targets: GroupTarget[],
  x: number,
  y: number,
): { result: DropResult; hint: unknown } | null {
  return hitTest(layout, REGION_W, CONTAINER, { groups: targets }, x, y);
}

// ===========================================================================
// Two stacked bands: A (full-width) over [B | C].
// ===========================================================================
describe("multi-band intent: A over [B|C]", () => {
  function make(): DockLayout {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b"), c: group("c") };
    l.docked.left = toRegion(rows([row([leaf("a")]), row([leaf("b"), leaf("c")])]));
    return l;
  }

  it("center of band A merges into A", () => {
    const l = make();
    const { targets, frameOf } = layoutTargets(l, "left");
    const fa = frameOf["a"];
    const res = run(l, targets, fa.left + fa.width / 2, fa.top + fa.height / 2);
    expect(res?.result.kind).toBe("merge");
    if (res?.result.kind === "merge") expect(res.result.targetGroupId).toBe("a");
  });

  it("center of band B's left column merges into B (not A)", () => {
    const l = make();
    const { targets, frameOf } = layoutTargets(l, "left");
    const fb = frameOf["b"];
    const res = run(l, targets, fb.left + fb.width / 2, fb.top + fb.height / 2);
    expect(res?.result.kind).toBe("merge");
    if (res?.result.kind === "merge") expect(res.result.targetGroupId).toBe("b");
  });

  it("very top of the region docks a band ABOVE everything (regionEdge top)", () => {
    const l = make();
    const { targets } = layoutTargets(l, "left");
    const res = run(l, targets, 150, 2);
    expect(res?.result.kind).toBe("regionEdge");
    if (res?.result.kind === "regionEdge") {
      expect(res.result.edge).toBe("left");
      expect(res.result.side).toBe("top");
    }
  });

  it("very bottom of the region docks a band BELOW everything (regionEdge bottom)", () => {
    const l = make();
    const { targets } = layoutTargets(l, "left");
    const res = run(l, targets, 150, CONTAINER.height - 2);
    expect(res?.result.kind).toBe("regionEdge");
    if (res?.result.kind === "regionEdge") expect(res.result.side).toBe("bottom");
  });

  it("the left edge docks a column beside ALL bands (regionEdge left)", () => {
    const l = make();
    const { targets } = layoutTargets(l, "left");
    // Mid-height, hard against the left screen edge but past the screen-edge
    // zone gate (region occupies the left, so edgeReadsEmpty is false).
    const res = run(l, targets, 2, 400);
    expect(res?.result.kind).toBe("regionEdge");
    if (res?.result.kind === "regionEdge") expect(res.result.side).toBe("left");
  });
});

// ===========================================================================
// The cross-band SEAM: between band A (full width) and band B's columns.
// This is the case most likely to mis-resolve: A's panel and B's panels
// horizontally overlap, so the seam-sibling logic can treat them as a single
// stacked column and offer a column-split instead of a band insert.
// ===========================================================================
describe("multi-band intent: the A|B seam", () => {
  function make(): DockLayout {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b"), c: group("c") };
    l.docked.left = toRegion(rows([row([leaf("a")]), row([leaf("b"), leaf("c")])]));
    return l;
  }

  it("a drop in the seam resolves to a stable, valid drop (no NONE dead zone)", () => {
    const l = make();
    const { targets, frameOf } = layoutTargets(l, "left");
    const fa = frameOf["a"];
    // Just below A's bottom edge (the seam region). Must not be null.
    const res = run(l, targets, fa.left + fa.width / 2, fa.bottom + 1);
    expect(res).not.toBeNull();
  });

  it("the seam inserts a BAND between A and B (index 1), not a per-column split", () => {
    const l = make();
    const { targets, frameOf } = layoutTargets(l, "left");
    const fa = frameOf["a"];
    // Dead on the seam, in the middle horizontal span (past the side margins).
    const res = run(l, targets, fa.left + fa.width / 2, fa.bottom);
    expect(res?.result.kind).toBe("bandInsert");
    if (res?.result.kind === "bandInsert") {
      expect(res.result.edge).toBe("left");
      expect(res.result.index).toBe(1);
    }
  });
});

// ===========================================================================
// THE bug case: a MULTI-COLUMN top band [A1|A2] over [B]. Dropping at the seam
// below the multi-column band must insert a FULL-WIDTH band (bandInsert), not a
// split that stacks a half-width leaf under A1.
// ===========================================================================
describe("multi-band intent: [A1|A2] over [B] seam", () => {
  function make(): DockLayout {
    const l = emptyLayout();
    l.groups = { a1: group("a1"), a2: group("a2"), b: group("b") };
    l.docked.left = toRegion(
      rows([row([leaf("a1"), leaf("a2")]), row([leaf("b")])]),
    );
    return l;
  }

  it("the seam below the multi-column band is a full-width bandInsert", () => {
    const l = make();
    const { targets, frameOf } = layoutTargets(l, "left");
    const fa1 = frameOf["a1"];
    // A1's horizontal center is well within the seam's middle span; the seam y
    // is A1's bottom (= the band boundary).
    const res = run(l, targets, fa1.left + fa1.width / 2, fa1.bottom);
    expect(res?.result.kind).toBe("bandInsert");
    if (res?.result.kind === "bandInsert") expect(res.result.index).toBe(1);
  });

  it("the bandInsert hint spans the FULL region width (not one column)", () => {
    const l = make();
    const { targets, frameOf } = layoutTargets(l, "left");
    const fa1 = frameOf["a1"];
    const res = run(l, targets, fa1.left + fa1.width / 2, fa1.bottom);
    expect(res?.hint).toBeDefined();
    if (res) {
      // Region width is REGION_W.left (300); the hint must span it, not ~150.
      expect((res.hint as { width: number }).width).toBe(REGION_W.left);
    }
  });
});
