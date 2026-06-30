// Adversarial invariant fuzzing for the pure layout ops.
//
// Goal: BREAK things. We apply long random sequences of ops from varied
// starting layouts and assert a battery of structural invariants after EVERY
// step. A seeded PRNG makes any failure reproducible; on failure we shrink to a
// minimal op sequence and print it.
//
// Confirmed bugs are captured as `it(..., () => {...})` wrapped so the suite
// stays green: a deterministic repro is asserted with the CURRENT (buggy)
// behavior and tagged `BUG:` so it's easy to find. The fuzzer's invariant set
// is tightened to skip the known-bug shapes so it keeps finding NEW issues.

import { describe, it, expect } from "vitest";
import {
  DockColumn,
  DockEdge,
  DockLayout,
  DockLeaf,
  DockRegion,
  DockRow,
  DropRegion,
  GroupId,
  NodeId,
  NonEmpty,
  emptyLayout,
} from "./types";
import { invariantViolations } from "./layoutInvariants";
import {
  planRegion,
  plannedReservedWidth,
  canvasFacingStripOffsetPx,
} from "./regionPlan";
import { regionWidthsOf } from "./types";
import {
  dockToEdge,
  dockToRegionEdge,
  dockBandAtIndex,
  dropOnDockedLeaf,
  insertTabsInto,
  mergeGroupsInto,
  floatGroup,
  floatColumn,
  isColumnMinimized,
  isMultiLeafColumn,
  tearOutPane,
  snapToWindowStack,
  reorderTab,
  toggleCollapsed,
  moveWindow,
  resizeWindow,
  resizeWindowHeight,
  bringToFront,
  setActiveTab,
  setNodeWeights,
  setRegionWidth,
  minimizeStack,
  expandStack,
  stackGroupIdsOf,
  normalizeStackCollapse,
} from "./layoutOps";
import {
  mulberry32,
  nid,
  leaf,
  row,
  row as rowS,
  rows,
  col as colS,
  group as grp,
  floatingWindow,
  toRegion,
} from "./testUtils";

type Rng = () => number;
const pick = <T>(rng: Rng, arr: readonly T[]): T =>
  arr[Math.floor(rng() * arr.length)];
const int = (rng: Rng, lo: number, hi: number) =>
  lo + Math.floor(rng() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// Layout walking helpers (flat model: region -> columns -> leaves).
// ---------------------------------------------------------------------------
function leaves(region: DockRegion | null): DockLeaf[] {
  if (region === null) return [];
  return region.rows.flatMap((r) => r.columns).flatMap((c) => c.leaves);
}

// THE INVARIANTS live in production (layoutInvariants.ts) so applyOp asserts the
// exact same definition on every commit in dev -- this fuzzer and the live app
// agree on "what valid means".

/** Multiset of all panel ids across all groups (for the conservation check). */
function allPanels(layout: DockLayout): string[] {
  return Object.values(layout.groups)
    .flatMap((g) => g.paneIds)
    .sort();
}

/** GEOMETRIC invariants: the structural checks above prove the tree is valid,
 * but not that it RENDERS coherently. regionPlan is THE source of truth every
 * width consumer derives from, so we run it on every docked region and assert
 * its output is internally consistent and finite -- and, critically, that EVERY
 * row band (not just the representative width-row regionPlan picks) classifies
 * coherently. The multi-band feature's fragility lives precisely here: the
 * width model is computed from one row, so a sibling band that can't be planned
 * is exactly the class of bug the structural invariants miss. */
function geometricViolations(layout: DockLayout): string[] {
  const v: string[] = [];
  const widths = regionWidthsOf(layout);
  const finite = (n: number) => Number.isFinite(n);
  for (const edge of ["left", "right"] as DockEdge[]) {
    const region = layout.docked[edge];
    if (region === null) continue;
    const plan = planRegion(region, layout.groups);
    // Plan internal consistency.
    if (plan.isStrip.length !== plan.columns.length)
      v.push(`${edge}: isStrip length ${plan.isStrip.length} != columns ${plan.columns.length}`);
    if (!finite(plan.chromePx) || plan.chromePx < 0)
      v.push(`${edge}: bad chromePx ${plan.chromePx}`);
    if (plan.expandedColumns.length > plan.columns.length)
      v.push(`${edge}: more expanded (${plan.expandedColumns.length}) than columns (${plan.columns.length})`);
    // expandedColumns must be exactly the non-strip columns.
    const expectExpanded = plan.columns.filter((_, i) => !plan.isStrip[i]).length;
    if (plan.expandedColumns.length !== expectExpanded)
      v.push(`${edge}: expandedColumns ${plan.expandedColumns.length} != non-strip ${expectExpanded}`);
    if (plan.hasExpanded !== plan.expandedColumns.length > 0)
      v.push(`${edge}: hasExpanded ${plan.hasExpanded} disagrees with expandedColumns`);
    // Derived widths must be finite and sane.
    const reserved = plannedReservedWidth(plan, widths[edge]);
    if (!finite(reserved) || reserved < 0)
      v.push(`${edge}: bad reserved width ${reserved}`);
    // Chrome (the widthRow's strips beside expanded columns) is only part of the
    // reserved width when the widthRow ITSELF has expanded columns. When the
    // widthRow is all strips but another band is expanded, the widthRow renders
    // as a full-width horizontal bar (no strip chrome) and reserved = regionWidth
    // -- which may legitimately be below that (now-irrelevant) chrome value.
    if (plan.hasExpanded && reserved + 0.001 < plan.chromePx)
      v.push(`${edge}: reserved ${reserved} < chrome ${plan.chromePx}`);
    const off = canvasFacingStripOffsetPx(plan, edge);
    if (!finite(off) || off < 0)
      v.push(`${edge}: bad strip offset ${off}`);
    // The canvas-facing strip offset is only meaningful when the widthRow has
    // expanded columns (it insets the resizer past leading strips). When the
    // widthRow is all strips, there is no resizer and offset is 0.
    if (plan.hasExpanded && off > reserved + 0.001)
      v.push(`${edge}: strip offset ${off} exceeds reserved ${reserved}`);
    // Per-band coherence: EVERY band must classify without throwing and with a
    // sensible strip count, not just the width-determining row. A band that is
    // wholly collapsed is a full-width strip band; a band with any expanded
    // column is a render row. Either way isColumnMinimized must be total.
    for (const band of region.rows) {
      const stripCount = band.columns.filter((c) =>
        isColumnMinimized(c, layout.groups),
      ).length;
      if (stripCount < 0 || stripCount > band.columns.length)
        v.push(`${edge}: band ${band.id} bad strip count ${stripCount}`);
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// Starting layouts (id-stable, since we mostly drive ops by querying live ids).
// ---------------------------------------------------------------------------
function startingLayouts(): { name: string; make: () => DockLayout }[] {
  return [
    {
      name: "single docked leaf",
      make: () => {
        const l = emptyLayout();
        l.groups = { a: grp("a", 2) };
        l.docked.left = toRegion(leaf("a"));
        return l;
      },
    },
    {
      name: "side-by-side row",
      make: () => {
        const l = emptyLayout();
        l.groups = { a: grp("a", 1), b: grp("b", 3), c: grp("c", 1) };
        l.docked.left = toRegion(rowS([leaf("a"), leaf("b"), leaf("c")]));
        return l;
      },
    },
    {
      name: "vertical stack",
      make: () => {
        const l = emptyLayout();
        l.groups = { a: grp("a", 1), b: grp("b", 1) };
        l.docked.left = toRegion(colS([leaf("a"), leaf("b")]));
        return l;
      },
    },
    {
      name: "nested both edges + floating",
      make: () => {
        const l = emptyLayout();
        l.groups = {
          a: grp("a", 2),
          b: grp("b", 1),
          c: grp("c", 1),
          d: grp("d", 4),
          e: grp("e", 1),
          f: grp("f", 1),
        };
        l.docked.left = toRegion(rowS([leaf("a"), colS([leaf("b"), leaf("c")])]));
        l.docked.right = toRegion(colS([leaf("d"), leaf("e")]));
        l.floating = [floatingWindow({ id: "wf", x: 50, y: 50, width: 280, stack: ["f"] })];
        return l;
      },
    },
    {
      // TWO row bands stacked vertically: a full-width band above a
      // side-by-side band. This is the multi-band shape the 4th level exists
      // for ("dock a band above ALL columns"). Starting here -- rather than
      // hoping random ops build it -- forces the multi-band render/width paths
      // (regionPlan's representative-row pick, per-band strip classification)
      // from step 0.
      name: "two row bands",
      make: () => {
        const l = emptyLayout();
        l.groups = { a: grp("a", 1), b: grp("b", 2), c: grp("c", 1), d: grp("d", 1) };
        // Band 1: one full-width column (a). Band 2: b beside a (c,d) stack.
        l.docked.left = toRegion(
          rows([row([leaf("a")]), row([leaf("b"), colS([leaf("c"), leaf("d")])])]),
        );
        return l;
      },
    },
    {
      // THREE bands, one of them fully minimized, plus a second edge -- the
      // worst-case multi-band geometry: a collapsed band that must render as a
      // fixed-height strip while sibling bands stay expanded, exercising the
      // band-height flex rule (loneBand/stripBand) and per-band minimize.
      name: "three bands w/ collapsed band + right edge",
      make: () => {
        const l = emptyLayout();
        l.groups = {
          a: grp("a", 1),
          b: grp("b", 1),
          c: grp("c", 1, true), // collapsed -> its band is a strip
          d: grp("d", 1),
          e: grp("e", 2),
        };
        l.docked.left = toRegion(
          rows([row([leaf("a"), leaf("b")]), row([leaf("c")]), row([leaf("d")])]),
        );
        l.docked.right = toRegion(rowS([leaf("e")]));
        return l;
      },
    },
    {
      name: "all floating, one multi-stack",
      make: () => {
        const l = emptyLayout();
        l.groups = { a: grp("a", 1), b: grp("b", 2), c: grp("c", 1) };
        l.floating = [
          floatingWindow({ id: "w1", x: 10, y: 10, width: 250, stack: ["a", "b"] }),
          floatingWindow({ id: "w2", x: 300, y: 40, width: 250, stack: ["c"] }),
        ];
        return l;
      },
    },
    {
      // Includes a dockable AREA (an inline tab group's backing group, referenced
      // only via `areas`) alongside a docked column + a float. Random ops then run
      // WITH an area present, exercising the area branches (detachInPlace /
      // removePaneInPlace area guards, the area-aware invariant exemptions) that
      // the area-less fixtures never reach.
      name: "area + docked + float",
      make: () => {
        const l = emptyLayout();
        l.groups = {
          area: grp("area", 2), // backs the area; referenced via l.areas only
          d: grp("d", 1),
          e: grp("e", 1),
          f: grp("f", 1),
        };
        l.docked.left = toRegion(colS([leaf("d"), leaf("e")]));
        l.floating = [
          floatingWindow({ id: "wf", x: 60, y: 60, width: 260, stack: ["f"] }),
        ];
        l.areas = { "area-1": { id: "area-1", group: "area" } };
        return l;
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Op driver. Each op is described so we can (a) apply it and (b) re-derive its
// arguments from the *current* layout (so args stay valid as structure changes),
// and (c) record a human-readable repro line.
// ---------------------------------------------------------------------------
type OpName =
  | "dockToEdge"
  | "dockToRegionEdge"
  | "dockBandAtIndex"
  | "dropOnDockedLeaf"
  | "insertTabsInto"
  | "mergeGroupsInto"
  | "floatGroup"
  | "floatColumn"
  | "tearOutPane"
  | "snapToWindowStack"
  | "reorderTab"
  | "toggleCollapsed"
  | "moveWindow"
  | "resizeWindow"
  | "resizeWindowHeight"
  | "bringToFront"
  | "setActiveTab"
  | "setNodeWeights"
  | "setRegionWidth"
  | "minimizeStack"
  | "expandStack";

interface AppliedOp {
  desc: string;
  apply: (l: DockLayout) => DockLayout;
}

function allGroupIds(l: DockLayout): GroupId[] {
  return Object.keys(l.groups);
}
/** Pick 1-3 distinct group ids (to exercise multi-group dragged stacks). */
function pickGroups(rng: Rng, groups: GroupId[]): GroupId[] {
  const n = Math.min(groups.length, int(rng, 1, 3));
  const pool = [...groups];
  const out: GroupId[] = [];
  for (let i = 0; i < n; i++) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}
function allDockedLeafTargets(
  l: DockLayout,
): { edge: DockEdge; nodeId: NodeId; group: GroupId }[] {
  const out: { edge: DockEdge; nodeId: NodeId; group: GroupId }[] = [];
  for (const edge of ["left", "right"] as DockEdge[])
    for (const lf of leaves(l.docked[edge]))
      out.push({ edge, nodeId: lf.id, group: lf.group });
  return out;
}

/** All floatable multi-leaf columns (>=2 leaves) across the docked edges, for
 * the floatColumn op (floats a whole column as one stacked window). */
function allPureColumnTargets(
  l: DockLayout,
): { edge: DockEdge; nodeId: NodeId }[] {
  const out: { edge: DockEdge; nodeId: NodeId }[] = [];
  for (const edge of ["left", "right"] as DockEdge[]) {
    const region = l.docked[edge];
    if (region === null) continue;
    for (const c of region.rows.flatMap((r) => r.columns))
      if (isMultiLeafColumn(c)) out.push({ edge, nodeId: c.id });
  }
  return out;
}

/** Choose a random op valid for the current layout; null if none applicable. */
function chooseOp(rng: Rng, l: DockLayout): AppliedOp | null {
  const groups = allGroupIds(l);
  if (groups.length === 0) return null;
  const edges: DockEdge[] = ["left", "right"];
  const regions: DropRegion[] = ["center", "top", "bottom", "left", "right"];
  const sides = ["top", "bottom", "left", "right"] as const;
  const ops: OpName[] = [
    "dockToEdge",
    "dockToRegionEdge",
    "dockBandAtIndex",
    "dropOnDockedLeaf",
    "insertTabsInto",
    "mergeGroupsInto",
    "floatGroup",
    "floatColumn",
    "tearOutPane",
    "snapToWindowStack",
    "reorderTab",
    "toggleCollapsed",
    "moveWindow",
    "resizeWindow",
    "resizeWindowHeight",
    "bringToFront",
    "setActiveTab",
    "setNodeWeights",
    "setRegionWidth",
    "minimizeStack",
    "expandStack",
  ];
  // Try ops in random order until one is applicable.
  const order = [...ops].sort(() => rng() - 0.5);
  for (const op of order) {
    const a = buildOp(rng, l, op, { groups, edges, regions, sides });
    if (a !== null) return a;
  }
  return null;
}

function buildOp(
  rng: Rng,
  l: DockLayout,
  op: OpName,
  ctx: {
    groups: GroupId[];
    edges: DockEdge[];
    regions: DropRegion[];
    sides: readonly ("top" | "bottom" | "left" | "right")[];
  },
): AppliedOp | null {
  const { groups, edges, regions, sides } = ctx;
  const g = () => pick(rng, groups);
  switch (op) {
    case "dockToEdge": {
      const gs = pickGroups(rng, groups);
      const edge = pick(rng, edges);
      return { desc: `dockToEdge([${gs}], ${edge})`, apply: (x) => dockToEdge(x, gs, edge) };
    }
    case "dockToRegionEdge": {
      const gs = pickGroups(rng, groups);
      const edge = pick(rng, edges);
      const side = pick(rng, sides);
      const useW = rng() < 0.5;
      const weights = useW
        ? { existing: int(rng, 1, 5), dragged: int(rng, 1, 5) }
        : undefined;
      return {
        desc: `dockToRegionEdge([${gs}], ${edge}, ${side}, ${JSON.stringify(weights)})`,
        apply: (x) => dockToRegionEdge(x, gs, edge, side, weights),
      };
    }
    case "dockBandAtIndex": {
      const gs = pickGroups(rng, groups);
      const edge = pick(rng, edges);
      const region = l.docked[edge];
      const maxIdx = region === null ? 0 : region.rows.length;
      const index = int(rng, 0, maxIdx + 1); // include an out-of-range value
      const weights =
        rng() < 0.5
          ? { existing: int(rng, 1, 5), dragged: int(rng, 1, 5) }
          : undefined;
      return {
        desc: `dockBandAtIndex([${gs}], ${edge}, ${index}, ${JSON.stringify(weights)})`,
        apply: (x) => dockBandAtIndex(x, gs, edge, index, weights),
      };
    }
    case "dropOnDockedLeaf": {
      const targets = allDockedLeafTargets(l);
      if (targets.length === 0) return null;
      const t = pick(rng, targets);
      const gs = pickGroups(rng, groups);
      const region = pick(rng, regions);
      // BUG #2 is FIXED: a non-center self-drop (dragged set includes the target
      // leaf's group) is now a safe no-op. We deliberately DO exercise this
      // shape to confirm it never loses a panel.
      const weights =
        rng() < 0.5
          ? { dragged: int(rng, 1, 5), target: int(rng, 1, 5) }
          : undefined;
      return {
        desc: `dropOnDockedLeaf([${gs}], ${t.edge}, ${t.nodeId}, ${region}, ${JSON.stringify(weights)})`,
        apply: (x) => dropOnDockedLeaf(x, gs, t.edge, t.nodeId, region, weights),
      };
    }
    case "insertTabsInto": {
      if (groups.length < 2) return null;
      const target = g();
      const srcs = pickGroups(rng, groups.filter((x) => x !== target));
      if (srcs.length === 0) return null;
      const idx = int(rng, -2, 6);
      return {
        desc: `insertTabsInto(${target}, [${srcs}], ${idx})`,
        apply: (x) => insertTabsInto(x, target, srcs, idx),
      };
    }
    case "mergeGroupsInto": {
      if (groups.length < 2) return null;
      const target = g();
      const srcs = pickGroups(rng, groups.filter((x) => x !== target));
      if (srcs.length === 0) return null;
      return {
        desc: `mergeGroupsInto(${target}, [${srcs}])`,
        apply: (x) => mergeGroupsInto(x, target, srcs),
      };
    }
    case "floatGroup": {
      const grp = g();
      return {
        desc: `floatGroup(${grp}, ...)`,
        apply: (x) => floatGroup(x, grp, int(rng, 0, 500), int(rng, 0, 500), int(rng, 220, 400)).layout,
      };
    }
    case "floatColumn": {
      const cols = allPureColumnTargets(l);
      if (cols.length === 0) return null;
      const c = pick(rng, cols);
      return {
        desc: `floatColumn(${c.edge}, ${c.nodeId}, ...)`,
        apply: (x) =>
          floatColumn(
            x,
            c.edge,
            c.nodeId,
            int(rng, 0, 500),
            int(rng, 0, 500),
            int(rng, 220, 400),
            int(rng, 120, 500),
          ).layout,
      };
    }
    case "tearOutPane": {
      const grp = g();
      const group = l.groups[grp];
      if (group === undefined) return null;
      const panel = pick(rng, group.paneIds);
      return {
        desc: `tearOutPane(${grp}, ${panel}, ...)`,
        apply: (x) => tearOutPane(x, grp, panel, int(rng, 0, 500), int(rng, 0, 500), 260).layout,
      };
    }
    case "snapToWindowStack": {
      if (l.floating.length === 0) return null;
      const w = pick(rng, l.floating);
      const gs = pickGroups(rng, groups);
      // BUG #1 is FIXED: snapping a window's entire stack back into itself is now
      // a safe no-op (the op re-finds the target after detach and aborts if it
      // was consumed). We deliberately DO exercise this shape now.
      const idx = rng() < 0.5 ? undefined : int(rng, -2, 6);
      return {
        desc: `snapToWindowStack([${gs}], ${w.id}, ${idx})`,
        apply: (x) => snapToWindowStack(x, gs, w.id, idx),
      };
    }
    case "reorderTab": {
      const grp = g();
      const group = l.groups[grp];
      if (group === undefined) return null;
      const panel = pick(rng, group.paneIds);
      const idx = int(rng, -2, group.paneIds.length + 2);
      return {
        desc: `reorderTab(${grp}, ${panel}, ${idx})`,
        apply: (x) => reorderTab(x, grp, panel, idx),
      };
    }
    case "toggleCollapsed": {
      const grp = g();
      return { desc: `toggleCollapsed(${grp})`, apply: (x) => toggleCollapsed(x, grp) };
    }
    case "moveWindow": {
      if (l.floating.length === 0) return null;
      const w = pick(rng, l.floating);
      return {
        desc: `moveWindow(${w.id}, ...)`,
        apply: (x) => moveWindow(x, w.id, int(rng, -100, 800), int(rng, -100, 800)),
      };
    }
    case "resizeWindow": {
      if (l.floating.length === 0) return null;
      const w = pick(rng, l.floating);
      const useX = rng() < 0.5;
      return {
        desc: `resizeWindow(${w.id}, ...)`,
        apply: (x) =>
          resizeWindow(x, w.id, int(rng, 220, 500), useX ? int(rng, 0, 400) : undefined),
      };
    }
    case "resizeWindowHeight": {
      if (l.floating.length === 0) return null;
      const w = pick(rng, l.floating);
      return {
        desc: `resizeWindowHeight(${w.id}, ...)`,
        apply: (x) => resizeWindowHeight(x, w.id, int(rng, 100, 700)),
      };
    }
    case "bringToFront": {
      if (l.floating.length === 0) return null;
      const w = pick(rng, l.floating);
      return { desc: `bringToFront(${w.id})`, apply: (x) => bringToFront(x, w.id) };
    }
    case "setActiveTab": {
      const grp = g();
      const group = l.groups[grp];
      if (group === undefined) return null;
      const panel = pick(rng, group.paneIds);
      return {
        desc: `setActiveTab(${grp}, ${panel})`,
        apply: (x) => setActiveTab(x, grp, panel),
      };
    }
    case "setNodeWeights": {
      // Pick a docked edge and randomize weights of a random subset of its
      // nodes (rows, columns, AND leaves) -- the multi-level resize write path.
      const edgesWithRegion = edges.filter((e) => l.docked[e] !== null);
      if (edgesWithRegion.length === 0) return null;
      const edge = pick(rng, edgesWithRegion);
      const region = l.docked[edge]!;
      const ids: NodeId[] = [];
      for (const r of region.rows) {
        ids.push(r.id);
        for (const c of r.columns) {
          ids.push(c.id);
          for (const lf of c.leaves) ids.push(lf.id);
        }
      }
      const weightsById: Record<NodeId, number> = {};
      for (const id of ids) if (rng() < 0.6) weightsById[id] = int(rng, 1, 6);
      return {
        desc: `setNodeWeights(${edge}, ${JSON.stringify(weightsById)})`,
        apply: (x) => setNodeWeights(x, edge, weightsById),
      };
    }
    case "setRegionWidth": {
      const edgesWithRegion = edges.filter((e) => l.docked[e] !== null);
      if (edgesWithRegion.length === 0) return null;
      const edge = pick(rng, edgesWithRegion);
      const px = int(rng, 40, 600);
      return {
        desc: `setRegionWidth(${edge}, ${px})`,
        apply: (x) => setRegionWidth(x, edge, px),
      };
    }
    case "minimizeStack": {
      const grp = g();
      const stack = stackGroupIdsOf(l, grp);
      return {
        desc: `minimizeStack([${stack}])`,
        apply: (x) => minimizeStack(x, stack),
      };
    }
    case "expandStack": {
      const grp = g();
      const stack = stackGroupIdsOf(l, grp);
      return {
        desc: `expandStack([${stack}])`,
        apply: (x) => expandStack(x, stack),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// The runner: applies a recorded op-builder sequence deterministically from a
// seed, checking invariants + input-immutability after every step. Returns the
// first failure (step index, op desc, violations) or null.
// ---------------------------------------------------------------------------
interface RunFailure {
  step: number;
  desc: string;
  violations: string[];
  mutatedInput: boolean;
  threw: string | null;
}

function runSequence(
  startMake: () => DockLayout,
  seed: number,
  steps: number,
  stopAt = Infinity,
): { failure: RunFailure | null; descs: string[] } {
  const rng = mulberry32(seed);
  let layout = startMake();
  const descs: string[] = [];
  // Panel-conservation baseline: no op should ever create or destroy a panel.
  const startPanels = JSON.stringify(allPanels(layout));
  // Sanity: the starting layout itself must be healthy (structurally AND
  // geometrically -- a multi-band fixture that can't be planned should fail
  // here, before any op runs).
  const startV = [...invariantViolations(layout), ...geometricViolations(layout)];
  if (startV.length > 0)
    return {
      failure: { step: -1, desc: "<start>", violations: startV, mutatedInput: false, threw: null },
      descs,
    };

  for (let i = 0; i < steps && i < stopAt; i++) {
    const op = chooseOp(rng, layout);
    if (op === null) break;
    descs.push(op.desc);
    const before = layout;
    const beforeSnapshot = structuredClone(before);
    let next: DockLayout;
    // Always null here: the throwing path returns from the catch below, so by
    // the time we build the failure object this op did not throw.
    const threw: string | null = null;
    try {
      next = op.apply(before);
    } catch (err) {
      return {
        failure: { step: i, desc: op.desc, violations: [], mutatedInput: false, threw: String(err) },
        descs,
      };
    }
    // Input immutability: the argument object must be unchanged.
    const mutatedInput = JSON.stringify(before) !== JSON.stringify(beforeSnapshot);
    // Mirror applyOp: the stack-uniform-collapse invariant holds POST-COMMIT,
    // and applyOp normalizes before committing. A raw op (e.g. toggleCollapsed
    // on one group of a stack) may transiently produce a mixed stack; the
    // production commit path always normalizes it away, so normalize `next`
    // (a fresh op output -- safe to mutate) before checking invariants.
    if (next !== before) normalizeStackCollapse(next);
    const violations = [...invariantViolations(next), ...geometricViolations(next)];
    // Panel conservation: the multiset of panel ids must be invariant.
    if (JSON.stringify(allPanels(next)) !== startPanels) {
      violations.push(
        `panel set changed: ${startPanels} -> ${JSON.stringify(allPanels(next))}`,
      );
    }
    if (violations.length > 0 || mutatedInput) {
      return { failure: { step: i, desc: op.desc, violations, mutatedInput, threw }, descs };
    }
    layout = next;
  }
  return { failure: null, descs };
}

// ---------------------------------------------------------------------------
// Tests: run many seeds across all starting layouts.
// ---------------------------------------------------------------------------
/** Build a randomized but VALID starting layout from a seed: N single-panel
 * (occasionally multi-panel) groups distributed across a random docked tree on
 * each edge plus some floating windows. Used to widen the starting-state space
 * beyond the hand-written fixtures. */
function randomStart(seed: number): DockLayout {
  const rng = mulberry32(seed);
  const l = emptyLayout();
  const total = int(rng, 3, 9);
  const names = Array.from({ length: total }, (_, i) => `g${i}`);
  for (const n of names) l.groups[n] = grp(n, int(rng, 1, 3));
  // Partition groups into: leftTree, rightTree, floating windows.
  const buckets: GroupId[][] = [[], [], []];
  for (const n of names) buckets[int(rng, 0, 2)].push(n);

  // Build a random VALID region in the fixed 4-level shape. The groups are
  // partitioned into 1-3 ROW BANDS (the 4th level: full-width stacked bands);
  // each band's groups are partitioned into columns; each column stacks 1-3
  // leaves. Generating multiple bands -- not just one -- means the randomized
  // starts exercise the multi-band render/width paths from the first step,
  // matching the hand-written multi-band fixtures.
  const buildColumns = (gs: GroupId[]): NonEmpty<DockColumn> => {
    const columns: DockColumn[] = [];
    let i = 0;
    while (i < gs.length) {
      const take = int(rng, 1, Math.min(3, gs.length - i));
      const slice = gs.slice(i, i + take);
      i += take;
      columns.push({
        id: nid(),
        weight: int(rng, 1, 4),
        leaves: slice.map((g) => ({
          id: nid(),
          group: g,
          weight: int(rng, 1, 4),
        })) as NonEmpty<DockLeaf>,
      });
    }
    return columns as NonEmpty<DockColumn>;
  };
  const buildTree = (gs: GroupId[]): DockRegion | null => {
    if (gs.length === 0) return null;
    // Split the groups into 1-3 contiguous bands.
    const bandCount = int(rng, 1, Math.min(3, gs.length));
    const bands: DockRow[] = [];
    let i = 0;
    for (let b = 0; b < bandCount; b++) {
      const remainingBands = bandCount - b;
      // Leave at least one group for each remaining band.
      const maxTake = gs.length - i - (remainingBands - 1);
      const take = b === bandCount - 1 ? gs.length - i : int(rng, 1, maxTake);
      const slice = gs.slice(i, i + take);
      i += take;
      bands.push({ id: nid(), weight: int(rng, 1, 4), columns: buildColumns(slice) });
    }
    return { rows: bands as NonEmpty<DockRow> };
  };

  l.docked.left = buildTree(buckets[0]);
  l.docked.right = buildTree(buckets[1]);
  // Floating: chunk the third bucket into 1-3-group windows.
  let wi = 0;
  let rest = buckets[2];
  while (rest.length > 0) {
    const take = int(rng, 1, Math.min(3, rest.length));
    l.floating.push(
      floatingWindow({
        id: `rw${wi++}`,
        x: int(rng, 0, 600),
        y: int(rng, 0, 600),
        width: int(rng, 220, 400),
        stack: rest.slice(0, take),
      }),
    );
    rest = rest.slice(take);
  }
  return l;
}

describe("layoutOps invariant fuzz", () => {
  const starts = startingLayouts();
  // Tuned so all five run well under the timeout while still exploring deeply
  // (5 layouts x 500 seeds x 80 steps = 200k op applications, each fully
  // invariant- + immutability-checked).
  const SEEDS = 800;
  const STEPS = 120;

  for (const start of starts) {
    it(`maintains invariants under random op sequences (${start.name})`, { timeout: 30000 }, () => {
      const failures: string[] = [];
      // Offset the seed band per starting layout so the five tests explore
      // disjoint regions of the seed space (wider net than overlapping bands).
      const seedBase = starts.indexOf(start) * 10000;
      for (let seed = seedBase + 1; seed <= seedBase + SEEDS; seed++) {
        const { failure, descs } = runSequence(start.make, seed, STEPS);
        if (failure !== null) {
          failures.push(
            `seed=${seed} step=${failure.step} op=${failure.desc}\n` +
              (failure.threw ? `  THREW: ${failure.threw}\n` : "") +
              (failure.mutatedInput ? `  MUTATED INPUT\n` : "") +
              failure.violations.map((x) => `  - ${x}`).join("\n") +
              `\n  sequence:\n    ${descs.join("\n    ")}`,
          );
          // Capture only the first few to keep output readable.
          if (failures.length >= 3) break;
        }
      }
      expect(failures, failures.join("\n\n")).toEqual([]);
    });
  }

  // Randomized starting states: each seed builds a fresh valid layout AND drives
  // a random op sequence on it. Widens the starting-state space well beyond the
  // hand-written fixtures.
  it("maintains invariants from RANDOMIZED starting layouts", { timeout: 30000 }, () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 800; seed++) {
      // The op sequence uses a derived seed so it differs from the layout seed.
      // (Seed transforms are arbitrary primes -- changing them explores fresh
      // territory; the suite has stayed clean across several such bands.)
      const { failure, descs } = runSequence(
        () => randomStart(seed * 3 + 5),
        seed * 11 + 29,
        STEPS,
      );
      if (failure !== null) {
        failures.push(
          `startSeed=${seed} step=${failure.step} op=${failure.desc}\n` +
            (failure.threw ? `  THREW: ${failure.threw}\n` : "") +
            (failure.mutatedInput ? `  MUTATED INPUT\n` : "") +
            failure.violations.map((x) => `  - ${x}`).join("\n") +
            `\n  sequence:\n    ${descs.join("\n    ")}`,
        );
        if (failures.length >= 3) break;
      }
    }
    expect(failures, failures.join("\n\n")).toEqual([]);
  });
});
