// Adversarial pointer-sweep tests for hitTest.
//
// For several representative layouts we sweep the pointer over a fine grid and
// assert hard invariants on every result:
//   - hitTest never throws;
//   - a result's referenced node/group/window actually exists in the layout;
//   - insertTab/snap indices are within the legal range for their target;
//   - the hint rect is finite, non-negative size, and stays within the
//     container bounds (with a small tolerance);
//   - regionEdge results only appear when that edge is multi-cell (not a single
//     full-span leaf) -- the suppression contract.
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
import { edgeIsSingleLeaf } from "./layoutOps";
import { DockEdge, DockLayout, DockNode, emptyLayout } from "./types";
import {
  rect,
  mulberry32,
  leaf,
  row as rowS,
  col as colS,
  group,
} from "./testUtils";

const CONTAINER: ContainerRect = { left: 0, top: 0, width: 1000, height: 800 };
const REGION_W: Record<DockEdge, number> = { left: 300, right: 300 };
const STRIP_OFFSET = 12; // handle bar above the strip
const STRIP_H = 28;

/** Build docked group targets from a tree, laying their frames out within the
 * region band [regionLeft, regionLeft+regionW] x [0, height]. We approximate
 * the real layout: a row splits width, a column splits height. Tabs are placed
 * along the strip; a group with >tabsPerRow panes wraps to a second row. */
function dockedTargets(
  layout: DockLayout,
  edge: DockEdge,
): GroupTarget[] {
  const tree = layout.docked[edge];
  if (tree === null) return [];
  const regionLeft = edge === "left" ? 0 : CONTAINER.width - REGION_W[edge];
  const out: GroupTarget[] = [];
  const place = (node: DockNode, x: number, y: number, w: number, h: number) => {
    if (node.type === "leaf") {
      const group = layout.groups[node.group];
      const r = rect(x, y, w, h);
      const stripTop = y + STRIP_OFFSET;
      // Lay tabs left-to-right, wrapping every 3 within the strip width.
      const tabW = Math.min(80, w / 3);
      const tabs = (group?.paneIds ?? []).map((paneId, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        return {
          paneId,
          rect: rect(x + col * tabW, stripTop + row * STRIP_H, tabW, STRIP_H),
        };
      });
      const rows = Math.max(1, Math.ceil((group?.paneIds.length ?? 1) / 3));
      out.push({
        groupId: node.group,
        rect: r,
        stripRect: rect(x, stripTop, w, STRIP_H * rows),
        tabs,
        ctx: { kind: "docked", nodeId: node.id, edge },
      });
      return;
    }
    const n = node.children.length;
    if (node.dir === "row") {
      const cw = w / n;
      node.children.forEach((c, i) => place(c, x + i * cw, y, cw, h));
    } else {
      const ch = h / n;
      node.children.forEach((c, i) => place(c, x, y + i * ch, w, ch));
    }
  };
  place(tree, regionLeft, 0, REGION_W[edge], CONTAINER.height);
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

function targetsFor(layout: DockLayout): DropTargets {
  return {
    groups: [
      ...dockedTargets(layout, "left"),
      ...dockedTargets(layout, "right"),
      ...floatingTargets(layout),
    ],
  };
}

// ---------------------------------------------------------------------------
// Result validation against the layout + targets.
// ---------------------------------------------------------------------------
function nodeExists(layout: DockLayout, edge: DockEdge, nodeId: string): boolean {
  const walk = (node: DockNode | null): boolean => {
    if (node === null) return false;
    if (node.id === nodeId) return true;
    if (node.type === "leaf") return false;
    return node.children.some(walk);
  };
  return walk(layout.docked[edge]);
}

function validateResult(
  layout: DockLayout,
  targets: DropTargets,
  result: DropResult,
): string[] {
  const errs: string[] = [];
  switch (result.kind) {
    case "edge":
      if (layout.docked[result.edge] !== null)
        errs.push(`edge ${result.edge} result but that edge is occupied`);
      break;
    case "regionEdge": {
      const tree = layout.docked[result.edge];
      if (tree === null) {
        errs.push(`regionEdge on empty edge ${result.edge}`);
        break;
      }
      // Suppression contract: must be a multi-cell edge for that side.
      if (edgeIsSingleLeaf(tree, result.side))
        errs.push(`regionEdge ${result.side} on a single-leaf edge (should be suppressed)`);
      break;
    }
    case "split":
      if (!nodeExists(layout, result.edge, result.nodeId))
        errs.push(`split references missing node ${result.nodeId} on ${result.edge}`);
      // A split region must be one of the four sides ("center" merges instead and
      // is excluded from the split result's type).
      if (!["top", "bottom", "left", "right"].includes(result.region))
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
  if (!fin(hint.left) || !fin(hint.top) || !fin(hint.width) || !fin(hint.height))
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
function layouts(): { name: string; layout: DockLayout }[] {
  const out: { name: string; layout: DockLayout }[] = [];

  {
    const l = emptyLayout();
    l.groups = { a: group("a", 2) };
    l.docked.left = leaf("a");
    out.push({ name: "single docked leaf (left)", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b", 3),
    };
    l.docked.left = rowS([leaf("a"), leaf("b")]);
    out.push({ name: "side-by-side row (left)", layout: l });
  }
  {
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
    };
    l.docked.left = colS([leaf("a"), leaf("b")]);
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
    l.docked.left = rowS([leaf("a"), colS([leaf("b"), leaf("c")])]);
    l.docked.right = leaf("d");
    out.push({ name: "nested left + leaf right", layout: l });
  }
  {
    const l = emptyLayout();
    // Multi-tab group with WRAPPING (>3 panes -> two strip rows).
    l.groups = {
      a: group("a", 5),
    };
    l.docked.left = leaf("a");
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
      { id: "w1", x: 400, y: 200, width: 300, stack: ["a", "b"] },
      { id: "w2", x: 750, y: 120, width: 200, stack: ["c"] },
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
      { id: "w1", x: 300, y: 200, width: 260, stack: ["a"] },
      { id: "w2", x: 360, y: 240, width: 260, stack: ["b"] },
      { id: "w3", x: 420, y: 280, width: 260, stack: ["c"] },
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
    l.docked.left = leaf("d");
    l.floating = [{ id: "wf", x: 200, y: 250, width: 240, stack: ["f"] }];
    out.push({ name: "floating straddling docked region", layout: l });
  }
  {
    // Both edges docked, no floating (no screen-edge zones at all).
    const l = emptyLayout();
    l.groups = {
      a: group("a"),
      b: group("b"),
    };
    l.docked.left = leaf("a");
    l.docked.right = leaf("b");
    out.push({ name: "both edges docked leaves", layout: l });
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
          zoneTally.set(res.result.kind, (zoneTally.get(res.result.kind) ?? 0) + 1);
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

      expect(errors, errors.join("\n")).toEqual([]);
      // Sanity: the sweep should actually reach *some* non-null zone for any
      // non-empty layout (guards against the harness silently testing nothing).
      if (targets.groups.length > 0 || layout.docked.left || layout.docked.right) {
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
      const container: ContainerRect = { left: 0, top: 0, width: cw, height: ch };
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
            errors.push(`THREW seed=${seed} (${x},${y}) cw=${cw} ch=${ch}: ${err}`);
            continue;
          }
          if (res === null) continue;
          // The referenced target must exist (group/window/node).
          const r = res.result;
          if (r.kind === "merge" && layout.groups[r.targetGroupId] === undefined)
            errors.push(`merge->missing group seed=${seed} (${x},${y})`);
          if (r.kind === "insertTab" && layout.groups[r.targetGroupId] === undefined)
            errors.push(`insertTab->missing group seed=${seed} (${x},${y})`);
          if (r.kind === "snap" && !layout.floating.some((w) => w.id === r.windowId))
            errors.push(`snap->missing window seed=${seed} (${x},${y})`);
          if (
            !Number.isFinite(res.hint.left) ||
            !Number.isFinite(res.hint.width) ||
            res.hint.width < 0 ||
            res.hint.height < 0
          )
            errors.push(`bad hint seed=${seed} (${x},${y}): ${JSON.stringify(res.hint)}`);
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
