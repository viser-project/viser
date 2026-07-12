// Structural invariants for a DockLayout: the single definition of "what a
// valid layout is" -- imported by both the fuzz test (asserts after every
// random op sequence) and applyOp (asserts on every commit in dev). Keeping
// one source means a violation is caught the instant a gesture or op produces
// it, rather than surfacing later as duplicated/orphaned panes.
//
// Pure + allocation-light: returns a list of human-readable violation strings
// (empty == healthy). Never throws; the caller decides what to do with the list.

import {
  DockColumn,
  DockEdge,
  DockLayout,
  DockLeaf,
  GroupId,
  MINIMIZED_STRIP_PX,
  NodeId,
  PaneId,
} from "./types";

// The docked shape (Region -> Column -> Leaf, both NonEmpty) is guaranteed by
// the types, so no structural shape checks run here -- bad shapes are
// unrepresentable. What remains are value-level invariants the type can't
// express: NonEmpty (defensive, in case a cast slipped through), finite/positive
// weights, and the reference/orphan/duplication checks that span the whole
// layout.

/** Every (docked) column across both edges, in order. */
function columnsOf(layout: DockLayout): DockColumn[] {
  const out: DockColumn[] = [];
  for (const edge of ["left", "right"] as DockEdge[]) {
    const region = layout.docked[edge];
    if (region !== null) out.push(...region.columns);
  }
  return out;
}

/** Every (docked) leaf across both edges, in order. */
function leavesOf(layout: DockLayout): DockLeaf[] {
  return columnsOf(layout).flatMap((c) => c.leaves);
}

/** Every group id referenced anywhere -- docked leaves, floating stacks, and
 * area backings -- with duplicates, so double-references are detectable. Area
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
 *  7. Finite positive weights.
 *  8. Floating windows: non-empty stacks, finite geometry, valid stackWeights
 *     (finite/positive, keyed only by groups in the window's stack).
 *  9. Unique node ids and floating window ids.
 *  10. Container collapse flags (window `collapsed` / column `railed`, D38)
 *      are booleans when present; groups carry no collapse flag.
 *  11. No un-migrated legacy `regionCollapsed` field (D44): the injection and
 *      restore chokepoints run migrateRegionCollapsedInPlace.
 *  12. regionWidth (when present) is the rendered content need (D40/D46),
 *      any column count: a region with an expanded column pins it to
 *      sum(railed ? 36 : weight); fully railed pins to 36 x columns.
 *  (Numbering is contiguous since the 2026-07 cleanup; the spec-referenced
 *  old #16 is now #12.) */
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
  // an area-backing group may be empty -- it persists as a "drop a pane here"
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
    if (region.columns.length === 0) v.push(`region on ${edge} has no columns`);
    for (const c of region.columns)
      if (c.leaves.length === 0)
        v.push(`column ${c.id} on ${edge} has no leaves`);
  }

  // 7. Finite positive weights (columns and leaves).
  for (const c of columnsOf(layout)) {
    if (!Number.isFinite(c.weight) || c.weight <= 0)
      v.push(`column ${c.id} bad weight ${c.weight}`);
    for (const l of c.leaves)
      if (!Number.isFinite(l.weight) || l.weight <= 0)
        v.push(`leaf ${l.id} bad weight ${l.weight}`);
  }

  // 8. Floating windows: non-empty stacks + finite geometry + valid stackWeights
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

  // 9. Unique node + window ids.
  const nodeIds: NodeId[] = [];
  for (const c of columnsOf(layout)) {
    nodeIds.push(c.id);
    for (const l of c.leaves) nodeIds.push(l.id);
  }
  if (new Set(nodeIds).size !== nodeIds.length)
    v.push(`duplicate node ids in docked regions`);
  const wids = layout.floating.map((w) => w.id);
  if (new Set(wids).size !== wids.length)
    v.push(`duplicate floating window ids`);

  // 10. Container collapse flags (D38) are booleans when present, and no
  // group carries one (group-level collapse is unrepresentable -- a stray
  // wire/persisted `collapsed` on a group would silently resurrect the
  // pre-D38 model).
  for (const w of layout.floating) {
    if (w.collapsed !== undefined && typeof w.collapsed !== "boolean")
      v.push(`floating window ${w.id} collapsed is not boolean`);
  }
  for (const c of columnsOf(layout)) {
    if (c.railed !== undefined && typeof c.railed !== "boolean")
      v.push(`column ${c.id} railed is not boolean`);
  }
  for (const [gid, group] of Object.entries(layout.groups)) {
    if ((group as { collapsed?: unknown }).collapsed !== undefined)
      v.push(`group ${gid} carries a group-level collapsed flag (D38)`);
  }

  // 11. No un-migrated legacy regionCollapsed field (D44): the packed region
  // rail is derived (isRegionPackedOn: every column railed), so this store is
  // never written -- a committed layout still carrying it means an
  // injection/restore path skipped migrateRegionCollapsedInPlace.
  if (layout.regionCollapsed !== undefined)
    v.push(
      "layout carries the legacy regionCollapsed store (D44: run " +
        "migrateRegionCollapsedInPlace at the injection/restore chokepoint)",
    );

  // 12. Region width matches the rendered-need semantic (D40): whenever a
  // region holds an expanded column, regionWidth[edge] is the sum over its
  // columns of (railed ? 36 : weight) -- width reconciliation maintains it
  // on every commit, so a drift means an op wrote weights or regionWidth
  // without going through (or agreeing with) the reconciler. A fully railed
  // region must hold exactly its rails' pack width. ANY column count:
  // column weights are always reconciled pixels, lone columns included (the
  // old single-column carve-out -- weight as an unreconciled flex share,
  // regionWidth as the width memory -- was retired by the always-px weights
  // migration; migrateLegacyLayout adopts persisted carve-out layouts).
  // Gated on the field's presence: a layout without `regionWidth` has never
  // been reconciled (test literals mid-construction), so its weights may
  // still be flex shares with no px basis to check against.
  const RW_TOL = 1.5;
  if (layout.regionWidth !== undefined) {
    for (const edge of ["left", "right"] as DockEdge[]) {
      const region = layout.docked[edge];
      if (region === null) continue;
      const cols = region.columns;
      const rw = layout.regionWidth[edge];
      const railsPx = cols.length * MINIMIZED_STRIP_PX;
      if (cols.some((c) => c.railed !== true)) {
        const need = cols.reduce(
          (s, c) => s + (c.railed === true ? MINIMIZED_STRIP_PX : c.weight),
          0,
        );
        if (Math.abs(rw - need) > RW_TOL)
          v.push(`regionWidth.${edge} ${rw} != rendered need ${need} (D40)`);
      } else if (Math.abs(rw - railsPx) > RW_TOL) {
        // Fully railed: the rails are the content (D46).
        v.push(
          `regionWidth.${edge} ${rw} != all-railed pack width ${railsPx} (D40)`,
        );
      }
    }
  }

  return v;
}
