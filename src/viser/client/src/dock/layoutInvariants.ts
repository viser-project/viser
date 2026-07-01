// Structural invariants for a DockLayout. THE single definition of "what a valid
// layout is" -- imported by both the fuzz test (asserts after every random op
// sequence) and applyOp (asserts on every commit in dev). Keeping one source
// means a violation is caught the instant a gesture or op produces it, rather
// than surfacing later as duplicated/orphaned panes.
//
// Pure + allocation-light: returns a list of human-readable violation strings
// (empty == healthy). Never throws; the caller decides what to do with the list.

import {
  DockColumn,
  DockEdge,
  DockLayout,
  DockLeaf,
  GroupId,
  NodeId,
  PaneId,
} from "./types";

// The docked shape (Region -> Column -> Leaf, both NonEmpty) is now guaranteed
// by the TYPES, so the structural checks the old invariant ran (>=2 children,
// valid dir, no same-axis nesting, single-child splits) are gone -- they're
// unrepresentable. What remains are VALUE-level invariants the type can't
// express: NonEmpty (defensive, in case a cast slipped through), finite/positive
// weights, uniform-collapse per stack, and the reference/orphan/duplication
// checks that span the whole layout.

/** Every (docked) column across both edges (flattened over row bands), in
 * order. */
function columnsOf(layout: DockLayout): DockColumn[] {
  const out: DockColumn[] = [];
  for (const edge of ["left", "right"] as DockEdge[]) {
    const region = layout.docked[edge];
    if (region !== null)
      for (const row of region.rows) out.push(...row.columns);
  }
  return out;
}

/** Every (docked) leaf across both edges, in order. */
function leavesOf(layout: DockLayout): DockLeaf[] {
  return columnsOf(layout).flatMap((c) => c.leaves);
}

/** Every group id referenced anywhere -- docked leaves, floating stacks, AND
 * area backings -- WITH duplicates, so double-references are detectable. Area
 * groups count as referenced (each area's `group` is a real group that lives in
 * `groups` and must not be flagged as an orphan). */
function referencedGroupIds(layout: DockLayout): GroupId[] {
  const out: GroupId[] = [];
  for (const l of leavesOf(layout)) out.push(l.group);
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
 *  6. NonEmpty (defensive): every region has >=1 column, every column >=1 leaf.
 *  8. Finite positive weights.
 *  9. Floating windows: non-empty stacks, finite geometry, valid stackWeights
 *     (finite/positive, keyed only by groups in the window's stack).
 *  10/11. Unique node ids and floating window ids.
 *  12. `collapsed`, when present, is a boolean.
 *  13. Each area is keyed by its own id.
 *  14. Uniform-collapse per docked column / floating stack. */
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

  // 5. activeId ∈ paneIds for a non-empty group; null exactly when empty. Only
  // an area-backing group may be empty -- it persists as a "drop a panel here"
  // affordance even with no tabs (see ensureArea / addPaneToArea /
  // removePaneInPlace's area branch).
  const areaGroupIds = new Set(
    Object.values(layout.areas ?? {}).map((a) => a.group),
  );
  for (const [gid, group] of Object.entries(layout.groups)) {
    if (group.paneIds.length === 0) {
      if (!areaGroupIds.has(gid)) v.push(`group ${gid} has empty paneIds`);
      if (group.activeId !== null)
        v.push(`empty group ${gid} has non-null activeId ${group.activeId}`);
    } else if (
      group.activeId === null ||
      !group.paneIds.includes(group.activeId)
    )
      v.push(`group ${gid} activeId ${group.activeId} not in paneIds`);
  }

  // 6. NonEmpty (defensive): the types guarantee it, but a stray cast in an op
  // could in principle slip an empty array through, so we check the value too.
  for (const edge of ["left", "right"] as DockEdge[]) {
    const region = layout.docked[edge];
    if (region === null) continue;
    if (region.rows.length === 0) v.push(`region on ${edge} has no rows`);
    for (const row of region.rows) {
      if (row.columns.length === 0)
        v.push(`row ${row.id} on ${edge} has no columns`);
      for (const c of row.columns)
        if (c.leaves.length === 0)
          v.push(`column ${c.id} on ${edge} has no leaves`);
    }
  }

  // 8. Finite positive weights (columns and leaves).
  for (const c of columnsOf(layout)) {
    if (!Number.isFinite(c.weight) || c.weight <= 0)
      v.push(`column ${c.id} bad weight ${c.weight}`);
    for (const l of c.leaves)
      if (!Number.isFinite(l.weight) || l.weight <= 0)
        v.push(`leaf ${l.id} bad weight ${l.weight}`);
  }

  // 9. Floating windows: non-empty stacks + finite geometry + valid stackWeights
  // (finite, positive, and keyed only by groups actually in this window's stack).
  for (const w of layout.floating) {
    if (w.stack.length === 0) v.push(`floating window ${w.id} has empty stack`);
    if (
      !Number.isFinite(w.x) ||
      !Number.isFinite(w.y) ||
      !Number.isFinite(w.width)
    )
      v.push(`floating window ${w.id} bad geometry`);
    if (w.height.mode === "pinned" && !Number.isFinite(w.height.px))
      v.push(`floating window ${w.id} bad height`);
    if (w.stackWeights !== undefined) {
      const inStack = new Set(w.stack);
      for (const [gid, weight] of Object.entries(w.stackWeights)) {
        if (!Number.isFinite(weight) || weight <= 0)
          v.push(`floating window ${w.id} stackWeight[${gid}] bad ${weight}`);
        if (!inStack.has(gid))
          v.push(`floating window ${w.id} stackWeight[${gid}] not in stack`);
      }
    }
  }

  // 10/11. Unique node + window ids.
  const nodeIds: NodeId[] = [];
  for (const c of columnsOf(layout)) {
    nodeIds.push(c.id);
    for (const l of c.leaves) nodeIds.push(l.id);
  }
  if (new Set(nodeIds).size !== nodeIds.length)
    v.push(`duplicate node ids in docked regions`);
  const wids = layout.floating.map((w) => w.id);
  if (new Set(wids).size !== wids.length) v.push(`duplicate floating window ids`);

  // 12. collapsed is a boolean when present.
  for (const [gid, group] of Object.entries(layout.groups)) {
    if (group.collapsed !== undefined && typeof group.collapsed !== "boolean")
      v.push(`group ${gid} collapsed is not boolean`);
  }

  // (13 retired: areas no longer duplicate their key in an `id` field -- the
  // mismatch it policed is unrepresentable now.)

  // 14. A stack of 2+ groups is uniform-collapse: every member shares one
  // collapsed state (a lone group may differ). Enforced by
  // normalizeStackCollapseInPlace; checked here so any op that violates it is caught.
  const checkStackUniform = (gids: GroupId[], where: string): void => {
    if (gids.length < 2) return;
    const states = gids.map((g) => layout.groups[g]?.collapsed === true);
    if (states.some((s) => s !== states[0]))
      v.push(`stack ${where} has mixed collapsed states`);
  };
  for (const c of columnsOf(layout))
    checkStackUniform(c.leaves.map((l) => l.group), `column ${c.id}`);
  for (const w of layout.floating) checkStackUniform(w.stack, `window ${w.id}`);

  return v;
}
