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
  container: ContainerRect = CONTAINER,
): { targets: GroupTarget[]; frameOf: Record<string, DOMRect> } {
  const region = layout.docked[edge];
  const targets: GroupTarget[] = [];
  const frameOf: Record<string, DOMRect> = {};
  if (region === null) return { targets, frameOf };
  // Target rects are CLIENT-space (getBoundingClientRect), so they include the
  // container's own client offset -- a container at top:100 puts band y=0 at
  // client y=100. Tests with an offset container exercise exactly that skew.
  const regionLeft =
    container.left +
    (edge === "left" ? 0 : container.width - REGION_W[edge]);
  const regionW = REGION_W[edge];
  const rowTotal = region.rows.reduce((s, r) => s + r.weight, 0);
  let bandTop = container.top;
  for (const band of region.rows) {
    const bandH = (band.weight / rowTotal) * container.height;
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
          // D38: collapsed-ness derives from the CONTAINER (the column's
          // railed flag; region collapse is handled at region scope).
          collapsed: column.railed === true ? true : undefined,
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
  container: ContainerRect = CONTAINER,
): { result: DropResult; hint: unknown } | null {
  return hitTest(layout, REGION_W, container, { groups: targets }, x, y);
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

  it("the left edge resolves PER BAND: a column insert into the pointed band", () => {
    // A non-zippable multi-band region (band 2 is multi-column) can't host a
    // literal "beside everything" column, and the old region-wide band
    // joined rows[0] regardless of the pointer's y -- a drop over band 2
    // committed into band 1 (cross-band bleed). The side band now resolves
    // per band: a hit at y over band N splits the band's OUTER leaf.
    const l = make();
    const { targets } = layoutTargets(l, "left");
    const nodeOf = (gid: string): string => {
      const t = targets.find((tg) => tg.groupId === gid)!;
      return t.ctx.kind === "docked" ? (t.ctx.nodeId as string) : "";
    };
    // Over band A (y=200): a new column at band A's left edge.
    const overA = run(l, targets, 2, 200);
    expect(overA?.result).toEqual({
      kind: "split",
      edge: "left",
      nodeId: nodeOf("a"),
      region: "left",
    });
    // Over band B|C (y=600): a new column at THAT band's left edge -- never
    // band A. The hint spans band 2, not the whole region.
    const overB = run(l, targets, 2, 600);
    expect(overB?.result).toEqual({
      kind: "split",
      edge: "left",
      nodeId: nodeOf("b"),
      region: "left",
    });
    const hint = overB?.hint as { top: number; height: number };
    expect(hint.top).toBeGreaterThanOrEqual(396);
    expect(hint.top + hint.height).toBeLessThanOrEqual(804);
    expect(hint.height).toBeGreaterThan(300);
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

// ===========================================================================
// OFFSET CONTAINER: the dock container does not start at client (0,0) -- the
// real app renders a Titlebar above it, so crect.top > 0. Target rects are
// client-space while cy/hints are container-relative; a coordinate-space mixup
// here once shifted the seam zone (and its hint) down by exactly crect.top.
// ===========================================================================
describe("multi-band intent: seam with an OFFSET container (titlebar above)", () => {
  const OFFSET: ContainerRect = { left: 0, top: 100, width: 1000, height: 800 };

  function make(): DockLayout {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b"), c: group("c") };
    l.docked.left = toRegion(rows([row([leaf("a")]), row([leaf("b"), leaf("c")])]));
    return l;
  }

  it("a drop ON the true seam is a bandInsert", () => {
    const l = make();
    const { targets, frameOf } = layoutTargets(l, "left", OFFSET);
    const fa = frameOf["a"]; // client-space; fa.bottom is the true seam
    const res = run(l, targets, fa.left + fa.width / 2, fa.bottom, OFFSET);
    expect(res?.result.kind).toBe("bandInsert");
    if (res?.result.kind === "bandInsert") expect(res.result.index).toBe(1);
  });

  it("the seam hint sits AT the seam (container-relative), not crect.top below it", () => {
    const l = make();
    const { targets, frameOf } = layoutTargets(l, "left", OFFSET);
    const fa = frameOf["a"];
    const res = run(l, targets, fa.left + fa.width / 2, fa.bottom, OFFSET);
    expect(res?.result.kind).toBe("bandInsert");
    const hint = res?.hint as { top: number; height: number };
    // Hint is container-relative: seam client y minus the container's top.
    const seamContainerY = fa.bottom - OFFSET.top;
    expect(hint.top + hint.height / 2).toBeCloseTo(seamContainerY, 0);
  });

  it("crect.top BELOW the seam (the old mis-accept point) is NOT a bandInsert", () => {
    const l = make();
    const { targets, frameOf } = layoutTargets(l, "left", OFFSET);
    const fa = frameOf["a"];
    const res = run(
      l,
      targets,
      fa.left + fa.width / 2,
      fa.bottom + OFFSET.top,
      OFFSET,
    );
    expect(res?.result.kind).not.toBe("bandInsert");
  });
});
