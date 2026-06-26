// Shared scaffolding for the dock unit tests: tree/group builders, the compact
// layout constructor + shape descriptor used by the structural tests, and small
// utilities (synthetic DOMRect, seeded PRNG, group reference counting).

import {
  DockLayout,
  DockNode,
  FloatingWindow,
  GroupId,
  PaneId,
  TabGroup,
  emptyLayout,
  windowHeight,
} from "./types";

// ---------------------------------------------------------------------------
// Tree builders. Ids are deterministic and unique; the ops never depend on id
// format, only that ids are unique and stable across a call.
// ---------------------------------------------------------------------------
let nodeSeq = 0;
export function nid(): string {
  nodeSeq += 1;
  return `n${nodeSeq}`;
}

export function leaf(group: GroupId, weight = 1): DockNode {
  return { type: "leaf", id: nid(), group, weight };
}
export function row(children: DockNode[], weight = 1): DockNode {
  return { type: "split", id: nid(), dir: "row", weight, children };
}
export function col(children: DockNode[], weight = 1): DockNode {
  return { type: "split", id: nid(), dir: "column", weight, children };
}

// ---------------------------------------------------------------------------
// Group builders. `group("a", 2)` holds panes "a.0", "a.1".
// ---------------------------------------------------------------------------
export function group(id: string, panelCount = 1, collapsed?: boolean): TabGroup {
  const paneIds = Array.from({ length: panelCount }, (_, i) => `${id}.${i}`);
  return {
    id,
    paneIds,
    activeId: paneIds[0],
    ...(collapsed !== undefined ? { collapsed } : {}),
  };
}

/** Record of single-panel groups; pass [id, collapsed] to mark one collapsed. */
export function groupsRecord(
  ...specs: (string | [string, boolean?])[]
): Record<GroupId, TabGroup> {
  const out: Record<GroupId, TabGroup> = {};
  for (const s of specs) {
    const [id, collapsed] = typeof s === "string" ? [s, undefined] : s;
    out[id] = group(id, 1, collapsed);
  }
  return out;
}

/** Minimal layout with `tree` docked on the left (no groups registered). */
export function dockedLeft(tree: DockNode | null): DockLayout {
  return { groups: {}, docked: { left: tree, right: null }, floating: [] };
}

// ---------------------------------------------------------------------------
// Compact layout constructor for the structural tests. Group ids and panel ids
// are derived from `name` for readability: group "a" holds panel "a:0" (and
// "a:1", ... for multi-panel groups). Groups referenced anywhere are
// auto-registered as single-panel groups unless already present.
// ---------------------------------------------------------------------------
export function defGroup(
  layout: DockLayout,
  name: string,
  panelCount = 1,
): TabGroup {
  const paneIds: PaneId[] = Array.from(
    { length: panelCount },
    (_, i) => `${name}:${i}`,
  );
  const g: TabGroup = { id: name, paneIds, activeId: paneIds[0] };
  layout.groups[name] = g;
  return g;
}

/** THE single constructor for a FloatingWindow in tests. Every test builds
 * floating windows through this (never a raw object literal), so the window shape
 * lives in ONE place: a field change (e.g. a future tagged-union for height or
 * position) updates this factory, not ~100 literals. Sensible defaults keep call
 * sites terse; pass only what the test cares about. */
export function floatingWindow(opts: {
  id: string;
  stack: GroupId[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  stackWeights?: Record<GroupId, number>;
  anchor?: { x: number; y: number };
}): FloatingWindow {
  const w: FloatingWindow = {
    id: opts.id,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    width: opts.width ?? 300,
    height: windowHeight(opts.height),
    stack: [...opts.stack],
  };
  if (opts.stackWeights !== undefined) w.stackWeights = opts.stackWeights;
  if (opts.anchor !== undefined) w.anchor = opts.anchor;
  return w;
}

export function makeLayout(opts: {
  left?: DockNode | null;
  right?: DockNode | null;
  floating?: {
    id: string;
    stack: GroupId[];
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }[];
  groups?: Record<string, number>; // name -> panel count (for multi-panel)
}): DockLayout {
  const layout = emptyLayout();
  for (const [name, count] of Object.entries(opts.groups ?? {})) {
    defGroup(layout, name, count);
  }
  layout.docked.left = opts.left ?? null;
  layout.docked.right = opts.right ?? null;
  layout.floating = (opts.floating ?? []).map(floatingWindow);
  const ensure = (g: GroupId) => {
    if (layout.groups[g] === undefined) defGroup(layout, g, 1);
  };
  const walk = (node: DockNode | null) => {
    if (node === null) return;
    if (node.type === "leaf") ensure(node.group);
    else node.children.forEach(walk);
  };
  walk(layout.docked.left);
  walk(layout.docked.right);
  for (const w of layout.floating) w.stack.forEach(ensure);
  return layout;
}

// ---------------------------------------------------------------------------
// Shape description: a compact, id-free representation of a tree, so tests can
// `toEqual` against expected structure. Weights are included when asked.
// ---------------------------------------------------------------------------
export type Shape =
  | { leaf: GroupId; weight?: number }
  | { dir: "row" | "column"; children: Shape[]; weight?: number };

export function shapeOf(node: DockNode | null, withWeights = false): Shape | null {
  if (node === null) return null;
  if (node.type === "leaf") {
    return withWeights
      ? { leaf: node.group, weight: node.weight }
      : { leaf: node.group };
  }
  return withWeights
    ? {
        dir: node.dir,
        weight: node.weight,
        children: node.children.map((c) => shapeOf(c, true)!),
      }
    : { dir: node.dir, children: node.children.map((c) => shapeOf(c, false)!) };
}

/** Collect groups in tree order. */
export function groupsInTree(node: DockNode | null): GroupId[] {
  if (node === null) return [];
  if (node.type === "leaf") return [node.group];
  return node.children.flatMap(groupsInTree);
}

/** Count where a group is referenced across docked trees + floating stacks. */
export function refCount(l: DockLayout, gid: GroupId): number {
  let n = 0;
  const walk = (node: DockNode | null) => {
    if (node === null) return;
    if (node.type === "leaf") {
      if (node.group === gid) n++;
    } else node.children.forEach(walk);
  };
  walk(l.docked.left);
  walk(l.docked.right);
  for (const w of l.floating) n += w.stack.filter((g) => g === gid).length;
  return n;
}

// ---------------------------------------------------------------------------
// Synthetic DOMRect (Node has no DOM). Matches the read-only properties the
// hit-test module touches: left/top/right/bottom/width/height.
// ---------------------------------------------------------------------------
export function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) -- deterministic + reproducible.
// ---------------------------------------------------------------------------
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
