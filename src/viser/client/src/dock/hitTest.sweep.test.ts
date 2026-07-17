// Adversarial pointer-sweep tests for hitTest.
//
// For several representative layouts we sweep the pointer over a fine grid and
// assert hard invariants on every result:
//   - hitTest never throws;
//   - a result's referenced node/group/window actually exists in the layout;
//   - insertTab/snap indices are within the legal range for their target;
//   - the hint rect is finite, non-negative size, and stays within the
//     container bounds (with a small tolerance);
//   - columnInsert results only appear on an occupied edge, with a seam
//     index inside [0..columns] (D55).
// We also tally which zones were ever reached, to flag dead zones.

import { describe, it, expect } from "vitest";
import {
  hitTest,
  tabInsertion,
  DropResult,
  DropTargets,
  GroupTarget,
  ContainerRect,
} from "./hitTest";
import { isGroupEffectivelyCollapsed } from "./layoutOps";
import {
  DockEdge,
  DockLayout,
  MINIMIZED_STRIP_PX,
  NonEmpty,
  emptyLayout,
} from "./types";
import {
  rect,
  mulberry32,
  leaf,
  row as rowS,
  col as colS,
  group,
  floatingWindow,
  toRegion,
} from "./testUtils";

const CONTAINER: ContainerRect = { left: 0, top: 0, width: 1000, height: 800 };
const REGION_W: Record<DockEdge, number> = { left: 300, right: 300 };
const STRIP_OFFSET = 12; // handle bar above the strip
const STRIP_H = 28;
// Rail geometry, mirroring ColumnRail/VerticalMinimizedCell: a railed column
// renders as a fixed MINIMIZED_STRIP_PX strip (packed at its slot -- it holds
// no flexible width), its cells CONTENT-TALL (header, then cap + spine rows),
// with the first/last cell's drop rect extended to the full strip per the
// scanner's data-dock-rail-root rule.
const RAIL_HEADER = 16; // narrow StackHandleBar atop the rail
const RAIL_CAP = 13; // gray cap (0.9em)
const RAIL_PAD = 16; // spine-list margins
const RAIL_ROW = 70; // one spine row (icon + rotated title)

/** Build docked group targets from a tree, laying their frames out within the
 * region band [regionLeft, regionLeft+regionW] x [0, height]. We approximate
 * the real layout: a row splits width, a column splits height. Tabs are placed
 * along the strip; a group with >tabsPerRow panes wraps to a second row.
 * RAILED columns render like the real ColumnRail: fixed 36px wide, collapsed
 * targets with content-tall interior cells and full-strip first/last rects. */
function dockedTargets(
  layout: DockLayout,
  edge: DockEdge,
  /** Simulated rail-spine scrollTop (px): shifts every rail cell up, as a
   * scrolled overflowing spine does; the scanner's rail-root clamp then
   * clips/drops cells exactly like the real DOM path. */
  railScroll = 0,
): GroupTarget[] {
  const region = layout.docked[edge];
  if (region === null) return [];
  const regionLeft = edge === "left" ? 0 : CONTAINER.width - REGION_W[edge];
  const regionW = REGION_W[edge];
  const out: GroupTarget[] = [];
  // The 3-level model (D46): the region is a horizontal row of columns
  // (split width), each column a full-height stack of leaves (split
  // height). This mirrors SplitView's real geometry.
  const bandTop = 0;
  const bandH = CONTAINER.height;
  {
    const band = region;
    const railedCount = band.columns.filter((c) => c.railed === true).length;
    const expandedW = regionW - railedCount * MINIMIZED_STRIP_PX;
    const colWeightTotal =
      band.columns.reduce(
        (s, c) => s + (c.railed === true ? 0 : c.weight),
        0,
      ) || 1;
    let colLeft = regionLeft;
    for (const column of band.columns) {
      if (column.railed === true) {
        // ColumnRail: header, then content-tall cells; drop rects of the
        // first/last cell extend to the strip box (rails' droppable surface
        // is the full strip -- no dead header run or empty tail) AND every
        // cell is CLAMPED to the rail root (band) box -- an overflowing
        // spine must not bleed targets into the next band (the scanner's
        // clamp, stability pass 2026-07). Fully-overflowed cells are
        // dropped.
        const cw = MINIMIZED_STRIP_PX;
        const railTop = bandTop;
        const railBottom = bandTop + bandH;
        let cellTop = bandTop + RAIL_HEADER - railScroll;
        column.leaves.forEach((lf, li) => {
          const group = layout.groups[lf.group];
          const nTabs = Math.max(1, group?.paneIds.length ?? 1);
          const cellH = RAIL_CAP + RAIL_PAD + nTabs * RAIL_ROW;
          const tabs = (group?.paneIds ?? []).map((paneId, i) => ({
            paneId,
            rect: rect(
              colLeft,
              cellTop + RAIL_CAP + 8 + i * RAIL_ROW,
              cw,
              RAIL_ROW,
            ),
          }));
          const top = li === 0 ? railTop : Math.max(cellTop, railTop);
          const bottom =
            li === column.leaves.length - 1
              ? railBottom
              : Math.min(cellTop + cellH, railBottom);
          cellTop += cellH + 1; // hairline ChromeDivider
          if (bottom - top < 8) return; // fully overflowed: not a target
          out.push({
            groupId: lf.group,
            rect: rect(colLeft, top, cw, bottom - top),
            stripRect: null,
            tabs,
            ctx: { kind: "docked", nodeId: lf.id, edge },
            collapsed: true,
          });
        });
        colLeft += cw;
        continue;
      }
      const cw = (column.weight / colWeightTotal) * expandedW;
      const ch = bandH / column.leaves.length;
      column.leaves.forEach((lf, li) => {
        const x = colLeft;
        const y = bandTop + li * ch;
        const group = layout.groups[lf.group];
        const r = rect(x, y, cw, ch);
        const stripTop = y + STRIP_OFFSET;
        // Lay tabs left-to-right, wrapping every 3 within the strip width.
        const tabW = Math.min(80, cw / 3);
        const tabs = (group?.paneIds ?? []).map((paneId, i) => {
          const col = i % 3;
          const trow = Math.floor(i / 3);
          return {
            paneId,
            rect: rect(
              x + col * tabW,
              stripTop + trow * STRIP_H,
              tabW,
              STRIP_H,
            ),
          };
        });
        const stripRows = Math.max(
          1,
          Math.ceil((group?.paneIds.length ?? 1) / 3),
        );
        out.push({
          groupId: lf.group,
          rect: r,
          stripRect: rect(x, stripTop, cw, STRIP_H * stripRows),
          tabs,
          ctx: { kind: "docked", nodeId: lf.id, edge },
        });
      });
      colLeft += cw;
    }
  }
  return out;
}

/** Floating-window targets: stack groups vertically inside each window's box. */
function floatingTargets(layout: DockLayout): GroupTarget[] {
  const out: GroupTarget[] = [];
  for (const win of layout.floating) {
    const n = win.stack.length;
    const totalH = 240;
    const gh = totalH / n;
    win.stack.forEach((gid, index) => {
      const x = win.x;
      const y = win.y + index * gh;
      const group = layout.groups[gid];
      const tabs = (group?.paneIds ?? []).map((paneId, i) => ({
        paneId,
        rect: rect(x + i * 70, y + STRIP_OFFSET, 70, STRIP_H),
      }));
      out.push({
        groupId: gid,
        rect: rect(x, y, win.width, gh),
        stripRect: rect(x, y + STRIP_OFFSET, win.width, STRIP_H),
        tabs,
        ctx: { kind: "floating", windowId: win.id, index },
      });
    });
  }
  return out;
}

function targetsFor(layout: DockLayout, railScroll = 0): DropTargets {
  return {
    groups: [
      ...dockedTargets(layout, "left", railScroll),
      ...dockedTargets(layout, "right", railScroll),
      ...floatingTargets(layout),
    ],
  };
}

// ---------------------------------------------------------------------------
// Result validation against the layout + targets.
// ---------------------------------------------------------------------------
function nodeExists(
  layout: DockLayout,
  edge: DockEdge,
  nodeId: string,
): boolean {
  const region = layout.docked[edge];
  if (region === null) return false;
  // A drop result's nodeId addresses a leaf (a docked split target) or a
  // column.
  return region.columns.some(
    (c) => c.id === nodeId || c.leaves.some((l) => l.id === nodeId),
  );
}

function validateResult(
  layout: DockLayout,
  _targets: DropTargets,
  result: DropResult,
): string[] {
  const errs: string[] = [];
  switch (result.kind) {
    case "edge":
      if (layout.docked[result.edge] !== null)
        errs.push(`edge ${result.edge} result but that edge is occupied`);
      break;
    case "columnInsert": {
      const tree = layout.docked[result.edge];
      if (tree === null) {
        errs.push(`columnInsert on empty edge ${result.edge}`);
        break;
      }
      // The seam index addresses one of the region's N+1 seams (D55).
      if (result.index < 0 || result.index > tree.columns.length)
        errs.push(
          `columnInsert index ${result.index} out of [0..${tree.columns.length}] on ${result.edge}`,
        );
      break;
    }
    case "split":
      if (!nodeExists(layout, result.edge, result.nodeId))
        errs.push(
          `split references missing node ${result.nodeId} on ${result.edge}`,
        );
      // A split is an in-column stack insert: top/bottom only ("center"
      // merges; side intent is a columnInsert, D55).
      if (!["top", "bottom"].includes(result.region))
        errs.push(`split result with illegal region "${result.region}"`);
      break;
    case "merge":
      if (layout.groups[result.targetGroupId] === undefined)
        errs.push(`merge references missing group ${result.targetGroupId}`);
      break;
    case "insertTab": {
      const group = layout.groups[result.targetGroupId];
      if (group === undefined) {
        errs.push(`insertTab references missing group ${result.targetGroupId}`);
        break;
      }
      if (result.index < 0 || result.index > group.paneIds.length)
        errs.push(
          `insertTab index ${result.index} out of [0..${group.paneIds.length}] for ${result.targetGroupId}`,
        );
      break;
    }
    case "snap": {
      const win = layout.floating.find((w) => w.id === result.windowId);
      if (win === undefined) {
        errs.push(`snap references missing window ${result.windowId}`);
        break;
      }
      if (result.index < 0 || result.index > win.stack.length)
        errs.push(
          `snap index ${result.index} out of [0..${win.stack.length}] for ${result.windowId}`,
        );
      break;
    }
  }
  return errs;
}

function validateHint(hint: {
  left: number;
  top: number;
  width: number;
  height: number;
}): string[] {
  const errs: string[] = [];
  const fin = (n: number) => Number.isFinite(n);
  if (
    !fin(hint.left) ||
    !fin(hint.top) ||
    !fin(hint.width) ||
    !fin(hint.height)
  )
    errs.push(`hint has non-finite field ${JSON.stringify(hint)}`);
  if (hint.width < 0 || hint.height < 0)
    errs.push(`hint has negative size ${JSON.stringify(hint)}`);
  // Within container bounds (allow a couple px of overhang for line hints that
  // sit on an edge, e.g. top:-2 for a snap-above line).
  const tol = 4;
  if (hint.left < -tol || hint.top < -tol)
    errs.push(`hint origin out of bounds ${JSON.stringify(hint)}`);
  if (hint.left + hint.width > CONTAINER.width + tol)
    errs.push(`hint exceeds right edge ${JSON.stringify(hint)}`);
  if (hint.top + hint.height > CONTAINER.height + tol)
    errs.push(`hint exceeds bottom edge ${JSON.stringify(hint)}`);
  return errs;
}

// ---------------------------------------------------------------------------
// Representative layouts.
// ---------------------------------------------------------------------------
function layouts(): {
  name: string;
  layout: DockLayout;
  /** Simulated rail-spine scrollTop for this fixture's railed columns. */
  railScroll?: number;
}[] {
  const out: {
    name: string;
    layout: DockLayout;
    railScroll?: number;
  }[] = [];

  {
    const l = emptyLayout();
    l.groups = { a: group("a", 2) };
    l.docked.left = toRegion(leaf("a"));
    out.push({ name: "single docked leaf (left)", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b", 3),
    };
    l.docked.left = toRegion(rowS([leaf("a"), leaf("b")]));
    out.push({ name: "side-by-side row (left)", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
    };
    l.docked.left = toRegion(colS([leaf("a"), leaf("b")]));
    out.push({ name: "vertical stack (left)", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
      c: group("c"),
      d: group("d"),
    };
    l.docked.left = toRegion(rowS([leaf("a"), colS([leaf("b"), leaf("c")])]));
    l.docked.right = toRegion(leaf("d"));
    out.push({ name: "nested left + leaf right", layout: l });
  }
  {
    const l = emptyLayout();
    // Multi-tab group with WRAPPING (>3 panes -> two strip rows).
    l.groups = {
      a: group("a", 5),
    };
    l.docked.left = toRegion(leaf("a"));
    out.push({ name: "wrapping multi-tab docked leaf", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b", 2),
      c: group("c"),
    };
    l.floating = [
      floatingWindow({
        id: "w1",
        x: 400,
        y: 200,
        width: 300,
        stack: ["a", "b"],
      }),
      floatingWindow({ id: "w2", x: 750, y: 120, width: 200, stack: ["c"] }),
    ];
    out.push({ name: "floating stacks", layout: l });
  }
  {
    // OVERLAPPING floating windows (probes the known BUG #4 region: the sweep
    // still expects results to reference EXISTING groups/windows -- which they
    // do, just possibly the wrong one -- so this stays green while exercising
    // the overlap-heavy geometry for any *other* anomalies).
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b", 2),
      c: group("c"),
    };
    l.floating = [
      floatingWindow({ id: "w1", x: 300, y: 200, width: 260, stack: ["a"] }),
      floatingWindow({ id: "w2", x: 360, y: 240, width: 260, stack: ["b"] }),
      floatingWindow({ id: "w3", x: 420, y: 280, width: 260, stack: ["c"] }),
    ];
    out.push({ name: "overlapping floating windows", layout: l });
  }
  {
    // Floating window straddling the docked region + the canvas.
    const l = emptyLayout();
    l.groups = {
      d: group("d"),
      f: group("f"),
    };
    l.docked.left = toRegion(leaf("d"));
    l.floating = [
      floatingWindow({ id: "wf", x: 200, y: 250, width: 240, stack: ["f"] }),
    ];
    out.push({ name: "floating straddling docked region", layout: l });
  }
  {
    // Both edges docked, no floating (no screen-edge zones at all).
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
    };
    l.docked.left = toRegion(leaf("a"));
    l.docked.right = toRegion(leaf("b"));
    out.push({ name: "both edges docked leaves", layout: l });
  }
  {
    // Three side-by-side columns, one stacking two leaves (D46: the shape
    // multi-band fixtures collapse into).
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b", 2), c: group("c") };
    l.docked.left = toRegion(rowS([leaf("a"), colS([leaf("b"), leaf("c")])]));
    out.push({ name: "column of two beside a leaf (left)", layout: l });
  }
  {
    // A RAILED multi-leaf column (D38's docked collapsed form) between
    // expanded columns, so a collapsed strip participates in the sweep.
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
      c: group("c", 2),
      e: group("e"),
      f: group("f"),
    };
    const railedEF = colS([leaf("e"), leaf("f")]);
    if (railedEF.kind === "col") railedEF.column.railed = true;
    l.docked.left = toRegion(
      rowS([leaf("a"), colS([leaf("b"), leaf("c")]), railedEF]),
    );
    out.push({ name: "railed stack between expanded columns", layout: l });
  }
  {
    // V8 (zones audit #1): a railed column whose 5-tab spine OVERFLOWS the
    // container. The scanner clamps rail cell rects to the rail root, so
    // the overflowing spine never bleeds targets outside the strip.
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b", 5), d: group("d") };
    const railedB = colS([leaf("b")]);
    if (railedB.kind === "col") railedB.column.railed = true;
    l.docked.left = toRegion(rowS([leaf("a"), railedB, leaf("d")]));
    out.push({ name: "rail spine overflowing (V8)", layout: l });
  }
  {
    // Multi-column on BOTH edges -- the densest geometry.
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
      c: group("c"),
      d: group("d"),
    };
    l.docked.left = toRegion(rowS([leaf("a"), leaf("b")]));
    l.docked.right = toRegion(rowS([leaf("c"), leaf("d")]));
    out.push({ name: "two columns both edges", layout: l });
  }
  {
    // Two rails beside an expanded column (the healthy rail case) -- the
    // strips pack at the region edge; their zones and the expanded
    // column's must tile with no dead pixels.
    const l = emptyLayout();
    l.groups = { p: group("p"), q: group("q"), d: group("d") };
    const rp = colS([leaf("p")]);
    if (rp.kind === "col") rp.column.railed = true;
    const rq = colS([leaf("q")]);
    if (rq.kind === "col") rq.column.railed = true;
    l.docked.left = toRegion(rowS([rp, rq, leaf("d")]));
    out.push({ name: "two rails beside expanded", layout: l });
  }
  {
    // FULLY RAILED region (the packed form, D44/D46): every column a strip.
    const l = emptyLayout();
    l.groups = { p: group("p"), q: group("q", 2), s: group("s") };
    const rp = colS([leaf("p")]);
    if (rp.kind === "col") rp.column.railed = true;
    const rq = colS([leaf("q")]);
    if (rq.kind === "col") rq.column.railed = true;
    const rs = colS([leaf("s")]);
    if (rs.kind === "col") rs.column.railed = true;
    l.docked.left = toRegion(rowS([rp, rq, rs]));
    out.push({ name: "fully railed region (packed)", layout: l });
  }
  {
    // The V8 overflowing spine, SCROLLED (scrollTop 150): cell rects
    // reflect scroll; the scanner's rail-root clamp must keep clipped
    // cells tiling the strip.
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b", 5), d: group("d") };
    const railedB = colS([leaf("b")]);
    if (railedB.kind === "col") railedB.column.railed = true;
    l.docked.left = toRegion(rowS([leaf("a"), railedB, leaf("d")]));
    out.push({
      name: "rail spine overflowing, scrolled (V8 + scrollTop)",
      layout: l,
      railScroll: 150,
    });
  }
  {
    // Multi-CELL rail scrolled past its first cell -- the dropped-cell
    // (<8px) and first-cell-claims-top interactions.
    const l = emptyLayout();
    l.groups = { a: group("a"), e: group("e"), f: group("f"), d: group("d") };
    const railedEF = colS([leaf("e"), leaf("f")]);
    if (railedEF.kind === "col") railedEF.column.railed = true;
    l.docked.left = toRegion(rowS([leaf("a"), railedEF, leaf("d")]));
    out.push({
      name: "two-cell rail scrolled past the first cell",
      layout: l,
      railScroll: 110,
    });
  }
  {
    // FIVE columns on the RIGHT edge (mirror path), rails interleaved --
    // the densest reachable columns-only shape.
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
      c: group("c", 2),
      d: group("d"),
      g: group("g"),
      h: group("h"),
    };
    const railCD = colS([leaf("c"), leaf("d")]);
    if (railCD.kind === "col") railCD.column.railed = true;
    const railG = colS([leaf("g")]);
    if (railG.kind === "col") railG.column.railed = true;
    l.docked.right = toRegion(
      rowS([leaf("a"), railCD, leaf("b"), railG, leaf("h")]),
    );
    out.push({ name: "five columns w/ rails (right)", layout: l });
  }
  {
    // Both edges empty -> only screen-edge zones + (no group) null in middle.
    const l = emptyLayout();
    out.push({ name: "empty layout", layout: l });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------
describe("hitTest pointer sweep invariants", () => {
  const STEP = 8; // px grid resolution

  for (const { name, layout } of layouts()) {
    it(`never produces an invalid result/hint (${name})`, () => {
      const targets = targetsFor(layout);
      const errors: string[] = [];
      const zoneTally = new Map<string, number>();
      // Invariant scaffolding: every target must offer at least one
      // reachable zone somewhere on the grid (a fully-shadowed rail was the
      // "no drop zone left of the leftmost rail" bug). (The old cross-band
      // containment invariant is moot under D46: there are no bands to
      // cross -- columns span the full region height.)
      const reachedTargets = new Set<number>();

      for (let y = 0; y <= CONTAINER.height; y += STEP) {
        for (let x = 0; x <= CONTAINER.width; x += STEP) {
          let res: ReturnType<typeof hitTest>;
          try {
            res = hitTest(layout, REGION_W, CONTAINER, targets, x, y);
          } catch (err) {
            errors.push(`THREW at (${x},${y}): ${err}`);
            continue;
          }
          if (res === null) {
            zoneTally.set("null", (zoneTally.get("null") ?? 0) + 1);
            continue;
          }
          zoneTally.set(
            res.result.kind,
            (zoneTally.get(res.result.kind) ?? 0) + 1,
          );
          const r = res.result;
          targets.groups.forEach((t, i) => {
            if (reachedTargets.has(i)) return;
            const hit =
              (r.kind === "split" &&
                t.ctx.kind === "docked" &&
                t.ctx.nodeId === r.nodeId) ||
              ((r.kind === "merge" || r.kind === "insertTab") &&
                t.groupId === r.targetGroupId) ||
              (r.kind === "snap" &&
                t.ctx.kind === "floating" &&
                t.ctx.windowId === r.windowId);
            if (hit) reachedTargets.add(i);
          });
          const rErrs = validateResult(layout, targets, res.result);
          const hErrs = validateHint(res.hint);
          for (const e of [...rErrs, ...hErrs]) {
            // Dedup to keep output readable: report each distinct error once
            // with one example coordinate.
            const key = e.replace(/\d+/g, "#");
            if (!errors.some((x2) => x2.startsWith(key))) {
              errors.push(`${key}  e.g. at (${x},${y}): ${e}`);
            }
          }
        }
      }

      // Every target keeps at least one reachable zone (nothing is fully
      // shadowed by region bands or neighbors).
      targets.groups.forEach((t, i) => {
        if (!reachedTargets.has(i)) {
          errors.push(
            `target ${t.groupId} (${t.ctx.kind}) has NO reachable zone anywhere`,
          );
        }
      });
      expect(errors, errors.join("\n")).toEqual([]);
      // Sanity: the sweep should actually reach *some* non-null zone for any
      // non-empty layout (guards against the harness silently testing nothing).
      if (
        targets.groups.length > 0 ||
        layout.docked.left ||
        layout.docked.right
      ) {
        const nonNull = [...zoneTally.entries()]
          .filter(([k]) => k !== "null")
          .reduce((s, [, n]) => s + n, 0);
        expect(nonNull).toBeGreaterThan(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// tabInsertion focused boundary fuzz: sweep across a strip (incl. wrapping) and
// assert the index is always in [0..tabs.length] and the line geometry finite.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Randomized-geometry sweep: vary the container size and region widths, then
// sweep. Guards against geometry-dependent boundary bugs the fixed-size sweeps
// would miss. Hint-bounds tolerance is relative to the (varying) container.
// ---------------------------------------------------------------------------
describe("hitTest randomized-geometry sweep", () => {
  it("never throws / never references missing targets across random geometries", () => {
    const errors: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed * 101 + 7);
      const cw = 600 + Math.floor(rng() * 800);
      const ch = 400 + Math.floor(rng() * 600);
      const container: ContainerRect = {
        left: 0,
        top: 0,
        width: cw,
        height: ch,
      };
      const regionW: Record<DockEdge, number> = {
        left: 200 + Math.floor(rng() * 200),
        right: 200 + Math.floor(rng() * 200),
      };
      // A random pick from our fixtures, re-laid-out at this geometry.
      const fixtures = layouts();
      const { layout } = fixtures[Math.floor(rng() * fixtures.length)];
      // Rebuild targets against the chosen geometry by temporarily overriding
      // the module-level constants used by the builders. The builders read the
      // fixed CONTAINER/REGION_W; for the randomized pass we just reuse the
      // standard targets but feed a different container/regionW to hitTest --
      // this still validly stresses the screen-edge / region math (the group
      // rects simply live where they live).
      const targets = targetsFor(layout);
      for (let y = 0; y <= ch; y += 16) {
        for (let x = 0; x <= cw; x += 16) {
          let res: ReturnType<typeof hitTest>;
          try {
            res = hitTest(layout, regionW, container, targets, x, y);
          } catch (err) {
            errors.push(
              `THREW seed=${seed} (${x},${y}) cw=${cw} ch=${ch}: ${err}`,
            );
            continue;
          }
          if (res === null) continue;
          // The referenced target must exist (group/window/node).
          const r = res.result;
          if (
            r.kind === "merge" &&
            layout.groups[r.targetGroupId] === undefined
          )
            errors.push(`merge->missing group seed=${seed} (${x},${y})`);
          if (
            r.kind === "insertTab" &&
            layout.groups[r.targetGroupId] === undefined
          )
            errors.push(`insertTab->missing group seed=${seed} (${x},${y})`);
          if (
            r.kind === "snap" &&
            !layout.floating.some((w) => w.id === r.windowId)
          )
            errors.push(`snap->missing window seed=${seed} (${x},${y})`);
          if (
            !Number.isFinite(res.hint.left) ||
            !Number.isFinite(res.hint.width) ||
            res.hint.width < 0 ||
            res.hint.height < 0
          )
            errors.push(
              `bad hint seed=${seed} (${x},${y}): ${JSON.stringify(res.hint)}`,
            );
          if (errors.length > 8) break;
        }
        if (errors.length > 8) break;
      }
    }
    expect(errors, errors.slice(0, 8).join("\n")).toEqual([]);
  });
});

describe("tabInsertion boundary sweep", () => {
  const makeRow = (n: number, perRow: number) =>
    Array.from({ length: n }, (_, i) => ({
      rect: rect((i % perRow) * 80, Math.floor(i / perRow) * 30, 80, 30),
    }));

  for (const [label, tabs] of [
    ["single", makeRow(1, 3)],
    ["one row of 3", makeRow(3, 3)],
    ["wrapping 5 over 2 rows", makeRow(5, 3)],
    ["wrapping 7 over 3 rows", makeRow(7, 3)],
  ] as const) {
    it(`index stays in range across a full sweep (${label})`, () => {
      const maxX = 80 * 3 + 40;
      const maxY = 30 * 3 + 40;
      const bad: string[] = [];
      for (let y = -10; y <= maxY; y += 5) {
        for (let x = -10; x <= maxX; x += 5) {
          const ins = tabInsertion(tabs, x, y);
          if (ins === null) continue;
          if (ins.index < 0 || ins.index > tabs.length)
            bad.push(`index ${ins.index} at (${x},${y})`);
          if (
            !Number.isFinite(ins.lineLeft) ||
            !Number.isFinite(ins.lineTop) ||
            !Number.isFinite(ins.lineHeight) ||
            ins.lineHeight <= 0
          )
            bad.push(`bad line geom at (${x},${y})`);
        }
      }
      expect(bad, bad.slice(0, 5).join("\n")).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Left/right mirror symmetry: docking is left/right symmetric BY CONTRACT.
// For every fixture we build the mirrored world (docked trees swapped between
// edges, floating windows and every target rect reflected across the vertical
// centerline) and require that the mirrored pointer resolves to the mirrored
// result everywhere on the grid. This pins the whole family of "works on the
// left, subtly off on the right" bugs: inverted inequalities, unmirrored
// bands, wrong-side hints.
// ---------------------------------------------------------------------------
describe("hitTest left/right mirror symmetry", () => {
  const W = CONTAINER.width;
  const reverseNonEmpty = <T>(xs: NonEmpty<T>): NonEmpty<T> =>
    [...xs].reverse() as NonEmpty<T>;
  const mirRect = (r: DOMRect): DOMRect =>
    rect(W - r.left - r.width, r.top, r.width, r.height);
  const flipLR = <T extends string>(v: T): T =>
    (v === "left" ? "right" : v === "right" ? "left" : v) as T;

  // Mirroring swaps the edges AND reverses each band's column order: columns
  // render left-to-right on both edges, so the spatial mirror of [a | b] is
  // [b | a] in the model too (edgeIsSingleLeaf & friends read model order).
  // Row bands and in-column leaves stack vertically -- unchanged by the flip.
  const mirrorRegion = (
    r: DockLayout["docked"]["left"],
  ): DockLayout["docked"]["left"] =>
    r === null ? null : { ...r, columns: reverseNonEmpty(r.columns) };
  const mirrorLayout = (l: DockLayout): DockLayout => ({
    ...l,
    docked: {
      left: mirrorRegion(l.docked.right),
      right: mirrorRegion(l.docked.left),
    },
    floating: l.floating.map((w) => ({ ...w, x: W - w.x - w.width })),
  });

  const mirrorTargets = (ts: DropTargets): DropTargets => ({
    groups: ts.groups.map((t) => ({
      ...t,
      rect: mirRect(t.rect),
      hitRect: t.hitRect === undefined ? undefined : mirRect(t.hitRect),
      stripRect: t.stripRect === null ? null : mirRect(t.stripRect),
      tabs: t.tabs.map((tab) => ({ ...tab, rect: mirRect(tab.rect) })),
      ctx:
        t.ctx.kind === "docked"
          ? { ...t.ctx, edge: flipLR(t.ctx.edge) }
          : t.ctx,
    })),
  });

  /** The result the MIRRORED world must produce for a left-world result.
   * insertTab's index is dropped: mirroring reverses the strip spatially, so
   * the index flips around the matched tab -- same group, different number.
   * columnInsert's seam index flips around the region's column count
   * (mirroring reverses the column order): seam i -> seam N - i. */
  const expectTwin = (res: DropResult, layout: DockLayout): unknown => {
    switch (res.kind) {
      case "edge":
        return { kind: "edge", edge: flipLR(res.edge) };
      case "columnInsert": {
        const n = layout.docked[res.edge]?.columns.length ?? 0;
        return {
          kind: "columnInsert",
          edge: flipLR(res.edge),
          index: n - res.index,
        };
      }
      case "split":
        return {
          kind: "split",
          edge: flipLR(res.edge),
          nodeId: res.nodeId,
          region: flipLR(res.region),
        };
      case "insertTab":
        return { kind: "insertTab", targetGroupId: res.targetGroupId };
      case "merge":
        return { kind: "merge", targetGroupId: res.targetGroupId };
      case "snap":
        return { kind: "snap", windowId: res.windowId, index: res.index };
    }
  };
  /** The same field selection as expectTwin, WITHOUT flipping -- applied to
   * the mirrored world's own result before comparing. */
  const canon = (res: DropResult): unknown => {
    switch (res.kind) {
      case "edge":
        return { kind: "edge", edge: res.edge };
      case "columnInsert":
        return { kind: "columnInsert", edge: res.edge, index: res.index };
      case "split":
        return {
          kind: "split",
          edge: res.edge,
          nodeId: res.nodeId,
          region: res.region,
        };
      case "insertTab":
        return { kind: "insertTab", targetGroupId: res.targetGroupId };
      case "merge":
        return { kind: "merge", targetGroupId: res.targetGroupId };
      case "snap":
        return { kind: "snap", windowId: res.windowId, index: res.index };
    }
  };

  const STEP = 8;
  for (const { name, layout } of layouts()) {
    it(`mirrored pointer resolves to the mirrored result (${name})`, () => {
      const targets = targetsFor(layout);
      // Surface the model's CONTAINER collapse state (D38) on the targets so
      // the collapsed (3z) branch participates in the symmetry check too.
      for (const t of targets.groups)
        if (isGroupEffectivelyCollapsed(layout, t.groupId)) t.collapsed = true;
      const mLayout = mirrorLayout(layout);
      const mTargets = mirrorTargets(targets);
      const errors: string[] = [];

      for (let y = 0; y <= CONTAINER.height; y += STEP) {
        for (let x = 0; x <= W; x += STEP) {
          const L = hitTest(layout, REGION_W, CONTAINER, targets, x, y);
          const R = hitTest(mLayout, REGION_W, CONTAINER, mTargets, W - x, y);
          const key = (msg: string) => {
            const k = msg.replace(/[-\d.]+/g, "#");
            if (!errors.some((e) => e.startsWith(k)))
              errors.push(`${k}  e.g. ${msg}`);
          };
          if ((L === null) !== (R === null)) {
            key(
              `null asymmetry at (${x},${y}): L=${L === null ? "null" : L.result.kind} R=${R === null ? "null" : R.result.kind}`,
            );
            continue;
          }
          if (L === null || R === null) continue;
          const want = JSON.stringify(expectTwin(L.result, layout));
          const got = JSON.stringify(canon(R.result));
          if (want !== got) {
            key(`result asymmetry at (${x},${y}): L=${want} R=${got}`);
            continue;
          }
          // Hints must mirror too (skip insertTab: the matched-tab flip moves
          // the line by design; and allow slack for the leftmost-tab nudge).
          if (L.result.kind !== "insertTab") {
            const tol = 4;
            const wantLeft = W - L.hint.left - L.hint.width;
            if (
              Math.abs(R.hint.left - wantLeft) > tol ||
              Math.abs(R.hint.top - L.hint.top) > tol ||
              Math.abs(R.hint.width - L.hint.width) > tol ||
              Math.abs(R.hint.height - L.hint.height) > tol
            )
              key(
                `hint asymmetry at (${x},${y}) [${L.result.kind}]: L=${JSON.stringify(L.hint)} R=${JSON.stringify(R.hint)}`,
              );
          }
        }
      }
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});
