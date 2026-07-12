// SCRATCH equivalence sweep (UX-consistency audit; delete after use).
//
// For each sweep fixture: grid-sweep the pointer, resolve hitTest, APPLY each
// DropResult with the production executors (dragController's dispatch mapping
// + applyOp's width reconciliation), and cluster grid points by outcome
// signature. Then report:
//   (a) same outcome, different hint class;
//   (b) adjacent different-outcome points with near-identical hints;
//   (c) one outcome claimed by disconnected islands.
import { describe, it, expect } from "vitest";
import {
  hitTest,
  DropResult,
  DropTargets,
  GroupTarget,
  ContainerRect,
  DropHint,
} from "./hitTest";
import * as ops from "./layoutOps";
import { cloneLayout } from "./layoutOps";
import { reconcileRegionWidths } from "./widthReconciliation";
import { DockEdge, DockLayout, MINIMIZED_STRIP_PX, emptyLayout } from "./types";
import {
  rect,
  leaf,
  row as rowS,
  col as colS,
  group,
  floatingWindow,
  toRegion,
  shapeOf,
  Shape,
} from "./testUtils";

const CONTAINER: ContainerRect = { left: 0, top: 0, width: 1000, height: 800 };
const REGION_W: Record<DockEdge, number> = { left: 300, right: 300 };
const STRIP_OFFSET = 12;
const STRIP_H = 28;
const RAIL_HEADER = 16;
const RAIL_CAP = 13;
const RAIL_PAD = 16;
const RAIL_ROW = 70;

// ---- geometry model copied from hitTest.sweep.test.ts -----------------
function dockedTargets(
  layout: DockLayout,
  edge: DockEdge,
  railScroll = 0,
): GroupTarget[] {
  const region = layout.docked[edge];
  if (region === null) return [];
  const regionLeft = edge === "left" ? 0 : CONTAINER.width - REGION_W[edge];
  const regionW = REGION_W[edge];
  const out: GroupTarget[] = [];
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
        const cw = MINIMIZED_STRIP_PX;
        const railTop = bandTop;
        const railBottom = bandTop + bandH;
        let cellTop = bandTop + RAIL_HEADER - railScroll;
        column.leaves.forEach((lf, li) => {
          const g = layout.groups[lf.group];
          const nTabs = Math.max(1, g?.paneIds.length ?? 1);
          const cellH = RAIL_CAP + RAIL_PAD + nTabs * RAIL_ROW;
          const tabs = (g?.paneIds ?? []).map((paneId, i) => ({
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
          cellTop += cellH + 1;
          if (bottom - top < 8) return;
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
        const g = layout.groups[lf.group];
        const r = rect(x, y, cw, ch);
        const stripTop = y + STRIP_OFFSET;
        const tabW = Math.min(80, cw / 3);
        const tabs = (g?.paneIds ?? []).map((paneId, i) => {
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
        const stripRows = Math.max(1, Math.ceil((g?.paneIds.length ?? 1) / 3));
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

function floatingTargets(layout: DockLayout): GroupTarget[] {
  const out: GroupTarget[] = [];
  for (const win of layout.floating) {
    const n = win.stack.length;
    const totalH = 240;
    const gh = totalH / n;
    win.stack.forEach((gid, index) => {
      const x = win.x;
      const y = win.y + index * gh;
      const g = layout.groups[gid];
      const tabs = (g?.paneIds ?? []).map((paneId, i) => ({
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

// ---- fixtures copied from hitTest.sweep.test.ts ------------------------
function layouts(): {
  name: string;
  layout: DockLayout;
  railScroll?: number;
}[] {
  const out: { name: string; layout: DockLayout; railScroll?: number }[] = [];
  {
    const l = emptyLayout();
    l.groups = { a: group("a", 2) };
    l.docked.left = toRegion(leaf("a"));
    out.push({ name: "single docked leaf (left)", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b", 3) };
    l.docked.left = toRegion(rowS([leaf("a"), leaf("b")]));
    out.push({ name: "side-by-side row (left)", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.docked.left = toRegion(colS([leaf("a"), leaf("b")]));
    out.push({ name: "vertical stack (left)", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b"), c: group("c"), d: group("d") };
    l.docked.left = toRegion(rowS([leaf("a"), colS([leaf("b"), leaf("c")])]));
    l.docked.right = toRegion(leaf("d"));
    out.push({ name: "nested left + leaf right", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = { a: group("a", 5) };
    l.docked.left = toRegion(leaf("a"));
    out.push({ name: "wrapping multi-tab docked leaf", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b", 2), c: group("c") };
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
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b", 2), c: group("c") };
    l.floating = [
      floatingWindow({ id: "w1", x: 300, y: 200, width: 260, stack: ["a"] }),
      floatingWindow({ id: "w2", x: 360, y: 240, width: 260, stack: ["b"] }),
      floatingWindow({ id: "w3", x: 420, y: 280, width: 260, stack: ["c"] }),
    ];
    out.push({ name: "overlapping floating windows", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = { d: group("d"), f: group("f") };
    l.docked.left = toRegion(leaf("d"));
    l.floating = [
      floatingWindow({ id: "wf", x: 200, y: 250, width: 240, stack: ["f"] }),
    ];
    out.push({ name: "floating straddling docked region", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b") };
    l.docked.left = toRegion(leaf("a"));
    l.docked.right = toRegion(leaf("b"));
    out.push({ name: "both edges docked leaves", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b", 2), c: group("c") };
    l.docked.left = toRegion(rowS([leaf("a"), colS([leaf("b"), leaf("c")])]));
    out.push({ name: "column of two beside a leaf (left)", layout: l });
  }
  {
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
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b", 5), d: group("d") };
    const railedB = colS([leaf("b")]);
    if (railedB.kind === "col") railedB.column.railed = true;
    l.docked.left = toRegion(rowS([leaf("a"), railedB, leaf("d")]));
    out.push({ name: "rail spine overflowing (V8)", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = { a: group("a"), b: group("b"), c: group("c"), d: group("d") };
    l.docked.left = toRegion(rowS([leaf("a"), leaf("b")]));
    l.docked.right = toRegion(rowS([leaf("c"), leaf("d")]));
    out.push({ name: "two columns both edges", layout: l });
  }
  {
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
    const l = emptyLayout();
    out.push({ name: "empty layout", layout: l });
  }
  return out;
}

// ---- outcome application (dragController's dispatch, then applyOp's
// width reconciliation) --------------------------------------------------
const DRAG = "zz";

function augment(l: DockLayout): DockLayout {
  const L = cloneLayout(l);
  L.groups[DRAG] = group(DRAG, 1);
  L.floating = [
    ...L.floating,
    floatingWindow({ id: "wzz", x: 20, y: 2000, width: 200, stack: [DRAG] }),
  ];
  return L;
}

function applyResult(base: DockLayout, r: DropResult): DockLayout {
  const stack = [DRAG];
  let next: DockLayout;
  switch (r.kind) {
    case "edge":
      next = ops.dockToEdge(base, stack, r.edge);
      break;
    case "regionEdge":
      next = ops.dockToRegionEdge(base, stack, r.edge, r.side);
      break;
    case "split":
      next = ops.dropOnDockedLeaf(base, stack, r.edge, r.nodeId, r.region);
      break;
    case "merge":
      next = ops.mergeGroupsInto(base, r.targetGroupId, stack);
      break;
    case "insertTab":
      next = ops.insertTabsInto(base, r.targetGroupId, stack, r.index);
      break;
    case "snap":
      next = ops.snapToWindowStack(base, stack, r.windowId, r.index);
      break;
  }
  if (next === base) return base;
  next = cloneLayout(next);
  reconcileRegionWidths(base, next); // applyOp's pipeline step.
  return next;
}

function roundShape(s: Shape | null): unknown {
  if (s === null) return null;
  if ("leaf" in s)
    return { leaf: s.leaf, w: Math.round((s.weight ?? 0) * 10) / 10 };
  return {
    dir: s.dir,
    w: Math.round((s.weight ?? 0) * 10) / 10,
    children: s.children.map((c) => roundShape(c)),
  };
}

function signature(l: DockLayout): string {
  const region = (e: DockEdge) => {
    const r = l.docked[e];
    return r === null
      ? null
      : {
          shape: roundShape(shapeOf(r, true)),
          railed: r.columns.map((c) => c.railed === true),
        };
  };
  return JSON.stringify({
    L: region("left"),
    R: region("right"),
    F: l.floating.map((w) => ({ id: w.id, stack: w.stack })),
    G: Object.keys(l.groups)
      .sort()
      .map((k) => [k, l.groups[k].paneIds]),
    W: {
      l: Math.round(l.regionWidth?.left ?? -1),
      r: Math.round(l.regionWidth?.right ?? -1),
    },
  });
}

// ---- hint classification -------------------------------------------------
function hintClass(h: DropHint): string {
  if (h.variant === "fill") return "fill";
  if (h.variant === "merge")
    return `merge@${Math.round(h.width / 40) * 40}x${Math.round(h.height / 40) * 40}`;
  const orient = h.width >= h.height ? "h" : "v";
  const long = Math.max(h.width, h.height);
  const extent =
    orient === "v" && long >= CONTAINER.height * 0.95
      ? "REGIONTALL"
      : `${Math.round(long / 30) * 30}`;
  return `line-${orient}-${extent}`;
}

const iou = (a: DropHint, b: DropHint): number => {
  const ix = Math.max(
    0,
    Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left),
  );
  const iy = Math.max(
    0,
    Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top),
  );
  const inter = ix * iy;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
};
const center = (h: DropHint) => ({
  x: h.left + h.width / 2,
  y: h.top + h.height / 2,
});

// ---- the sweep -----------------------------------------------------------
const STEP = 6;

interface Pt {
  x: number;
  y: number;
  sig: string;
  resKey: string;
  hint: DropHint | null;
}

describe("zone equivalence sweep (scratch audit)", () => {
  it("collects outcome clusters and prints the report", () => {
    let totalPoints = 0;
    const lines: string[] = [];
    const say = (s: string) => lines.push(s);

    for (const { name, layout, railScroll } of layouts()) {
      const L2 = augment(layout);
      const targets = targetsFor(layout, railScroll ?? 0);
      const cols = Math.floor(CONTAINER.width / STEP) + 1;
      const rows = Math.floor(CONTAINER.height / STEP) + 1;
      const grid: (Pt | null)[] = new Array(cols * rows).fill(null);
      const sigOfResult = new Map<string, string>();
      const pts: Pt[] = [];

      for (let iy = 0; iy < rows; iy++) {
        for (let ix = 0; ix < cols; ix++) {
          const x = ix * STEP;
          const y = iy * STEP;
          totalPoints++;
          const hit = hitTest(L2, REGION_W, CONTAINER, targets, x, y);
          if (hit === null) continue; // release floats at pointer: position-dependent, skip.
          const resKey = JSON.stringify(hit.result);
          let sig = sigOfResult.get(resKey);
          if (sig === undefined) {
            sig = signature(applyResult(L2, hit.result));
            sigOfResult.set(resKey, sig);
          }
          const p: Pt = { x, y, sig, resKey, hint: hit.hint };
          grid[iy * cols + ix] = p;
          pts.push(p);
        }
      }

      // Cluster stats.
      const bySig = new Map<string, Pt[]>();
      for (const p of pts) {
        const arr = bySig.get(p.sig);
        if (arr === undefined) bySig.set(p.sig, [p]);
        else arr.push(p);
      }
      say(`\n=== FIXTURE: ${name} ===`);
      say(
        `points=${cols * rows} nonNull=${pts.length} distinctResults=${sigOfResult.size} distinctOutcomes=${bySig.size}`,
      );

      // (a) same outcome, different hint class.
      for (const [sig, arr] of bySig) {
        const classes = new Map<
          string,
          { n: number; ex: Pt[]; kinds: Set<string> }
        >();
        for (const p of arr) {
          if (p.hint === null) continue;
          const c = hintClass(p.hint);
          let e = classes.get(c);
          if (e === undefined) {
            e = { n: 0, ex: [], kinds: new Set() };
            classes.set(c, e);
          }
          e.n++;
          if (e.ex.length < 2) e.ex.push(p);
          e.kinds.add(JSON.parse(p.resKey).kind);
        }
        if (classes.size > 1) {
          say(`  [a] SAME outcome, ${classes.size} hint classes:`);
          say(`      outcome: ${sig.slice(0, 200)}`);
          for (const [c, e] of classes) {
            const ex = e.ex[0];
            say(
              `      class=${c} n=${e.n} kinds=${[...e.kinds].join(",")} e.g. (${ex.x},${ex.y}) hint=${JSON.stringify(ex.hint)} result=${ex.resKey}`,
            );
          }
        }
        // Same class but wildly different placement (discontinuous jump).
        for (const [c, e] of classes) {
          if (e.n < 2) continue;
          const centers = arr
            .filter((p) => p.hint !== null && hintClass(p.hint) === c)
            .map((p) => center(p.hint!));
          const xs = centers.map((q) => q.x);
          const ys = centers.map((q) => q.y);
          const spread = Math.max(
            Math.max(...xs) - Math.min(...xs),
            Math.max(...ys) - Math.min(...ys),
          );
          if (spread > 60)
            say(
              `  [a2] outcome ${sig.slice(0, 110)}... class=${c}: hint center spread ${Math.round(spread)}px (same drop, hint moves)`,
            );
        }
      }

      // (b) adjacent points, different outcome, near-identical hints.
      const bPairs = new Map<string, { n: number; ex: [Pt, Pt] }>();
      for (let iy = 0; iy < rows; iy++) {
        for (let ix = 0; ix < cols; ix++) {
          const p = grid[iy * cols + ix];
          if (p === null || p.hint === null) continue;
          for (const [dx, dy] of [
            [1, 0],
            [0, 1],
          ] as const) {
            const jx = ix + dx;
            const jy = iy + dy;
            if (jx >= cols || jy >= rows) continue;
            const q = grid[jy * cols + jx];
            if (q === null || q.hint === null) continue;
            if (q.sig === p.sig) continue;
            const sameVariant = p.hint.variant === q.hint.variant;
            if (!sameVariant) continue;
            const o = iou(p.hint, q.hint);
            const cp = center(p.hint);
            const cq = center(q.hint);
            const dist = Math.hypot(cp.x - cq.x, cp.y - cq.y);
            const sameClass = hintClass(p.hint) === hintClass(q.hint);
            if (o > 0.5 || (sameClass && dist < 12)) {
              const key = [p.sig, q.sig].sort().join(" || ");
              const e = bPairs.get(key);
              if (e === undefined) bPairs.set(key, { n: 1, ex: [p, q] });
              else e.n++;
            }
          }
        }
      }
      for (const [key, e] of bPairs) {
        const [p, q] = e.ex;
        say(
          `  [b] DIFFERENT outcomes, look-alike hints (${e.n} boundary pairs): e.g. (${p.x},${p.y})->${p.resKey} hint=${JSON.stringify(p.hint)}  vs  (${q.x},${q.y})->${q.resKey} hint=${JSON.stringify(q.hint)}`,
        );
        say(`      outcomes: ${key.slice(0, 260)}`);
      }

      // (c) fragmented claims: connected components per outcome.
      const seen = new Uint8Array(cols * rows);
      const compsBySig = new Map<
        string,
        {
          size: number;
          bbox: [number, number, number, number];
          kinds: string;
        }[]
      >();
      for (let start = 0; start < grid.length; start++) {
        if (grid[start] === null || seen[start] === 1) continue;
        const sig = grid[start]!.sig;
        // BFS.
        const stack = [start];
        seen[start] = 1;
        let size = 0;
        let minx = Infinity,
          miny = Infinity,
          maxx = -Infinity,
          maxy = -Infinity;
        const kinds = new Set<string>();
        while (stack.length > 0) {
          const i = stack.pop()!;
          const p = grid[i]!;
          size++;
          kinds.add(JSON.parse(p.resKey).kind);
          minx = Math.min(minx, p.x);
          maxx = Math.max(maxx, p.x);
          miny = Math.min(miny, p.y);
          maxy = Math.max(maxy, p.y);
          const ix = i % cols;
          const iy = Math.floor(i / cols);
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const jx = ix + dx;
            const jy = iy + dy;
            if (jx < 0 || jy < 0 || jx >= cols || jy >= rows) continue;
            const j = jy * cols + jx;
            if (seen[j] === 1) continue;
            const q = grid[j];
            if (q === null || q.sig !== sig) continue;
            seen[j] = 1;
            stack.push(j);
          }
        }
        const arr = compsBySig.get(sig) ?? [];
        arr.push({
          size,
          bbox: [minx, miny, maxx, maxy],
          kinds: [...kinds].join(","),
        });
        compsBySig.set(sig, arr);
      }
      for (const [sig, comps] of compsBySig) {
        if (comps.length < 2) continue;
        say(
          `  [c] outcome claimed by ${comps.length} islands: ${sig.slice(0, 150)}`,
        );
        for (const cmp of comps.slice(0, 6))
          say(
            `      island size=${cmp.size} bbox=[${cmp.bbox.join(",")}] kinds=${cmp.kinds}`,
          );
      }
    }

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
    require("node:fs").writeFileSync(
      "/tmp/claude-1000/-home-brent-viser/a52374c5-e4c8-4ce2-974c-4bd54559a057/scratchpad/equiv-out.txt",
      lines.join("\n"),
    );
    expect(totalPoints).toBeGreaterThan(0);
  });
});
