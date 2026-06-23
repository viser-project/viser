// Structural invariants for a DockLayout. THE single definition of "what a valid
// layout is" -- imported by both the fuzz test (asserts after every random op
// sequence) and applyOp (asserts on every commit in dev). Keeping one source
// means a violation is caught the instant a gesture or op produces it, rather
// than surfacing later as duplicated/orphaned panes.
//
// Pure + allocation-light: returns a list of human-readable violation strings
// (empty == healthy). Never throws; the caller decides what to do with the list.

import {
  DockEdge,
  DockLayout,
  DockNode,
  GroupId,
  NodeId,
  PaneId,
} from "./types";

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

function splits(node: DockNode | null): Extract<DockNode, { type: "split" }>[] {
  return [...walkNodes(node)].filter(
    (n): n is Extract<DockNode, { type: "split" }> => n.type === "split",
  );
}

/** Every group id referenced anywhere -- docked leaves, floating stacks, AND
 * area backings -- WITH duplicates, so double-references are detectable. Area
 * groups count as referenced (each area's `group` is a real group that lives in
 * `groups` and must not be flagged as an orphan). */
function referencedGroupIds(layout: DockLayout): GroupId[] {
  const out: GroupId[] = [];
  for (const edge of ["left", "right"] as DockEdge[])
    for (const l of leaves(layout.docked[edge])) out.push(l.group);
  for (const w of layout.floating) out.push(...w.stack);
  for (const a of Object.values(layout.areas ?? {})) out.push(a.group);
  return out;
}

/** Check every structural invariant a DockLayout must satisfy. Returns the list
 * of violations (empty == valid). The invariants:
 *  1. No group referenced more than once (no group in two locations).
 *  2. No orphan groups (every group in `groups` is referenced).
 *  3. No dangling references (every reference resolves to a group).
 *  4. No pane in two groups (the duplication class).
 *  5. activeId is a member; paneIds non-empty.
 *  6/7. Splits have >=2 children, valid dir, no same-axis nesting.
 *  8. Finite positive weights.
 *  9. Floating windows have non-empty stacks + finite geometry.
 *  10/11. Unique node ids and floating window ids.
 *  12. `collapsed`, when present, is a boolean. */
export function invariantViolations(layout: DockLayout): string[] {
  const v: string[] = [];
  const refs = referencedGroupIds(layout);
  const refSet = new Set(refs);
  const groupIds = Object.keys(layout.groups);

  // 1. No double-references.
  const seen = new Map<GroupId, number>();
  for (const g of refs) seen.set(g, (seen.get(g) ?? 0) + 1);
  for (const [g, n] of seen) if (n > 1) v.push(`group ${g} referenced ${n}x`);

  // 2. No orphans.
  for (const g of groupIds)
    if (!refSet.has(g))
      v.push(`group ${g} is an orphan (in groups, unreferenced)`);

  // 3. No dangling references.
  for (const g of refs)
    if (layout.groups[g] === undefined)
      v.push(`reference to missing group ${g}`);

  // 4. No paneId in two groups.
  const owner = new Map<PaneId, GroupId>();
  for (const [gid, group] of Object.entries(layout.groups)) {
    for (const p of group.paneIds) {
      if (owner.has(p)) v.push(`pane ${p} in both ${owner.get(p)} and ${gid}`);
      owner.set(p, gid);
    }
  }

  // 5. activeId valid; paneIds non-empty.
  for (const [gid, group] of Object.entries(layout.groups)) {
    if (group.paneIds.length === 0) v.push(`group ${gid} has empty paneIds`);
    else if (!group.paneIds.includes(group.activeId))
      v.push(`group ${gid} activeId ${group.activeId} not in paneIds`);
  }

  // 6/7. Splits well-formed and flattened.
  for (const edge of ["left", "right"] as DockEdge[]) {
    for (const s of splits(layout.docked[edge])) {
      if (s.children.length < 2)
        v.push(`split ${s.id} on ${edge} has ${s.children.length} children`);
      if (s.dir !== "row" && s.dir !== "column")
        v.push(`split ${s.id} bad dir ${s.dir}`);
      for (const c of s.children)
        if (c.type === "split" && c.dir === s.dir)
          v.push(`unflattened same-axis nesting under ${s.id} on ${edge}`);
    }
  }

  // 8. Finite positive weights.
  for (const edge of ["left", "right"] as DockEdge[])
    for (const n of walkNodes(layout.docked[edge]))
      if (!Number.isFinite(n.weight) || n.weight <= 0)
        v.push(`node ${n.id} on ${edge} bad weight ${n.weight}`);

  // 9. Floating windows: non-empty stacks + finite geometry.
  for (const w of layout.floating) {
    if (w.stack.length === 0) v.push(`floating window ${w.id} has empty stack`);
    if (
      !Number.isFinite(w.x) ||
      !Number.isFinite(w.y) ||
      !Number.isFinite(w.width)
    )
      v.push(`floating window ${w.id} bad geometry`);
    if (w.height !== undefined && !Number.isFinite(w.height))
      v.push(`floating window ${w.id} bad height`);
  }

  // 10/11. Unique node + window ids.
  const nodeIds: NodeId[] = [];
  for (const edge of ["left", "right"] as DockEdge[])
    for (const n of walkNodes(layout.docked[edge])) nodeIds.push(n.id);
  if (new Set(nodeIds).size !== nodeIds.length)
    v.push(`duplicate node ids in docked trees`);
  const wids = layout.floating.map((w) => w.id);
  if (new Set(wids).size !== wids.length) v.push(`duplicate floating window ids`);

  // 12. collapsed boolean.
  for (const [gid, group] of Object.entries(layout.groups))
    if (group.collapsed !== undefined && typeof group.collapsed !== "boolean")
      v.push(`group ${gid} collapsed is not boolean`);

  return v;
}
