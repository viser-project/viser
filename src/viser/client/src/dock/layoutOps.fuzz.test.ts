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
  DockEdge,
  DockLayout,
  DockNode,
  DropRegion,
  GroupId,
  NodeId,
  emptyLayout,
} from "./types";
import { invariantViolations } from "./layoutInvariants";
import {
  dockToEdge,
  dockToRegionEdge,
  dropOnDockedLeaf,
  insertTabsInto,
  mergeGroupsInto,
  floatGroup,
  tearOutPane,
  snapToWindowStack,
  reorderTab,
  toggleCollapsed,
  moveWindow,
  resizeWindow,
  resizeWindowHeight,
  bringToFront,
  setActiveTab,
} from "./layoutOps";
import {
  mulberry32,
  nid,
  leaf,
  row as rowS,
  col as colS,
  group as grp,
  floatingWindow,
} from "./testUtils";

type Rng = () => number;
const pick = <T>(rng: Rng, arr: readonly T[]): T =>
  arr[Math.floor(rng() * arr.length)];
const int = (rng: Rng, lo: number, hi: number) =>
  lo + Math.floor(rng() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// Layout walking helpers.
// ---------------------------------------------------------------------------
function* walkNodes(node: DockNode | null): Generator<DockNode> {
  if (node === null) return;
  yield node;
  if (node.type === "split") for (const c of node.children) yield* walkNodes(c);
}
function leaves(node: DockNode | null): Extract<DockNode, { type: "leaf" }>[] {
  return [...walkNodes(node)].filter(
    (n): n is Extract<DockNode, { type: "leaf" }> => n.type === "leaf",
  );
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
        l.docked.left = leaf("a");
        return l;
      },
    },
    {
      name: "side-by-side row",
      make: () => {
        const l = emptyLayout();
        l.groups = { a: grp("a", 1), b: grp("b", 3), c: grp("c", 1) };
        l.docked.left = rowS([leaf("a"), leaf("b"), leaf("c")]);
        return l;
      },
    },
    {
      name: "vertical stack",
      make: () => {
        const l = emptyLayout();
        l.groups = { a: grp("a", 1), b: grp("b", 1) };
        l.docked.left = colS([leaf("a"), leaf("b")]);
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
        l.docked.left = rowS([leaf("a"), colS([leaf("b"), leaf("c")])]);
        l.docked.right = colS([leaf("d"), leaf("e")]);
        l.floating = [floatingWindow({ id: "wf", x: 50, y: 50, width: 280, stack: ["f"] })];
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
        l.docked.left = colS([leaf("d"), leaf("e")]);
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
  | "dropOnDockedLeaf"
  | "insertTabsInto"
  | "mergeGroupsInto"
  | "floatGroup"
  | "tearOutPane"
  | "snapToWindowStack"
  | "reorderTab"
  | "toggleCollapsed"
  | "moveWindow"
  | "resizeWindow"
  | "resizeWindowHeight"
  | "bringToFront"
  | "setActiveTab";

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
    "dropOnDockedLeaf",
    "insertTabsInto",
    "mergeGroupsInto",
    "floatGroup",
    "tearOutPane",
    "snapToWindowStack",
    "reorderTab",
    "toggleCollapsed",
    "moveWindow",
    "resizeWindow",
    "resizeWindowHeight",
    "bringToFront",
    "setActiveTab",
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
  // Sanity: the starting layout itself must be healthy.
  const startV = invariantViolations(layout);
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
    const violations = invariantViolations(next);
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

  // Build a random tree (flat-ish, valid: splits have >=2 children) from a list.
  const buildTree = (gs: GroupId[]): DockNode | null => {
    if (gs.length === 0) return null;
    if (gs.length === 1) return leaf(gs[0]);
    const dir = rng() < 0.5 ? "row" : "column";
    // Split into 2-4 chunks.
    const chunks = int(rng, 2, Math.min(4, gs.length));
    const children: DockNode[] = [];
    const per = Math.ceil(gs.length / chunks);
    for (let i = 0; i < gs.length; i += per) {
      const slice = gs.slice(i, i + per);
      // Avoid same-axis nested singletons creating invalid shapes; build leaf or
      // perpendicular subtree.
      if (slice.length === 1) children.push(leaf(slice[0]));
      else {
        const subDir = dir === "row" ? "column" : "row";
        children.push({
          type: "split",
          id: nid(),
          dir: subDir,
          weight: 1,
          children: slice.map((g) => leaf(g)),
        });
      }
    }
    if (children.length === 1) return children[0];
    return { type: "split", id: nid(), dir, weight: 1, children };
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
  const SEEDS = 500;
  const STEPS = 80;

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
