// D#/P#/section citations refer to ./dock-ux-spec.md (the normative spec,
// in this directory).
// Pure transformations over DockLayout.
//
// Every exported op takes a layout and returns a *new* layout, leaving the
// input untouched. The layout is plain serializable data (no React nodes), so
// we deep-clone and mutate the copy -- simpler and less error-prone than
// threading immutable updates through the split tree, and cheap because
// layouts are small.

import {
  AreaId,
  clamp,
  DockColumn,
  DockEdge,
  DockLayout,
  DockLeaf,
  DockRegion,
  DropRegion,
  FloatingWindow,
  GroupId,
  GroupLocation,
  isRegionFullyRailed,
  mapNonEmpty,
  MIN_REGION_GRAB_PX,
  MIN_WINDOW_HEIGHT_PX,
  MINIMIZED_STRIP_PX,
  NodeId,
  NonEmpty,
  PANEL_PAD_PX,
  PaneId,
  PaneRegistry,
  pinnedPxOf,
  regionWidthsOf,
  TabGroup,
  windowHeight,
  WindowId,
  withInserted,
} from "./types";
import { freshId } from "./gestures";

// NonEmpty leaks through `.filter`/`.slice` (they return a plain T[]), so after
// deriving a columns/leaves list we re-assert non-emptiness in one place before
// assigning it back to a NonEmpty field. The "what to do when it is empty"
// decision -- drop the column, or null the region -- is made explicitly at each
// removal site (the type can't make that call for us).
function asNonEmpty<T>(xs: T[]): NonEmpty<T> | null {
  return xs.length > 0 ? (xs as NonEmpty<T>) : null;
}

// A typed recursive deep-clone, ~10x faster than structuredClone for the
// layout's plain JSON-ish shape (objects/arrays/numbers/strings/booleans --
// no Dates/Maps/Sets/functions/RegExp, guaranteed by DockLayout being the
// serialization contract). Copies only present own-enumerable keys, so an
// absent optional field (height, regionWidth, stackWeights, collapsed, ...)
// stays absent rather than materializing as `undefined` -- the same
// absent-vs-undefined semantics structuredClone preserves and that width
// reconciliation / persistence rely on.
const clone = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return (value as unknown[]).map(clone) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key in value as Record<string, unknown>) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        out[key] = clone((value as Record<string, unknown>)[key]);
      }
    }
    return out as T;
  }
  return value;
};

/** Public deep-clone of a layout, for the rare caller outside the ops that must
 * hand a modified layout to applyOp: applyOp's normalize/reconcile steps
 * mutate their input in place, so a shallow `{ ...layout, field }` copy would
 * alias groups/docked with the committed layout and let those steps corrupt it
 * (Escape-restore snapshots, onCommit diffing). */
export const cloneLayout = (layout: DockLayout): DockLayout => clone(layout);

/** Every id in a layout (groups, nodes, windows, areas). Used to seed the
 * fresh-id counter past a restored layout's ids. */
export function* allLayoutIds(layout: DockLayout): Iterable<string> {
  yield* Object.keys(layout.groups);
  for (const edge of ["left", "right"] as DockEdge[]) {
    const region = layout.docked[edge];
    if (region === null) continue;
    for (const column of region.columns) {
      yield column.id;
      for (const l of column.leaves) yield l.id;
    }
  }
  for (const w of layout.floating) yield w.id;
  yield* Object.keys(layout.areas ?? {});
}

// ---------------------------------------------------------------------------
// Flat-model accessors + structural helpers.
//
// The docked shape is fixed at three levels (D46: Region = side-by-side
// columns; Column = stack of leaves; Leaf = one tab group), so what used to
// be recursive tree walks are trivial array lookups. Removal helpers
// maintain the invariant by re-wrapping: drop an emptied column from the
// region, null an emptied region.
// ---------------------------------------------------------------------------

/** Locate the leaf holding `groupId` within a region. Null when the region is
 * empty or doesn't hold the group. */
function findGroupInRegion(
  region: DockRegion | null,
  groupId: GroupId,
): { column: DockColumn; leaf: DockLeaf } | null {
  if (region === null) return null;
  for (const column of region.columns) {
    for (const leaf of column.leaves) {
      if (leaf.group === groupId) return { column, leaf };
    }
  }
  return null;
}

/** Remove the leaf holding `groupId` from a region. Drops the leaf from its
 * column; drops the column if it emptied; returns null if the whole region
 * emptied. Weights are preserved on the survivors so the region's proportions
 * don't jump. */
function regionRemoveGroup(
  region: DockRegion,
  groupId: GroupId,
): DockRegion | null {
  const columns: DockColumn[] = [];
  for (const column of region.columns) {
    const leaves = column.leaves.filter((l) => l.group !== groupId);
    if (leaves.length === column.leaves.length) {
      columns.push(column); // untouched
      continue;
    }
    const ne = asNonEmpty(leaves);
    if (ne !== null) columns.push({ ...column, leaves: ne });
    // else: column's last leaf removed -> drop the column.
  }
  const cne = asNonEmpty(columns);
  return cne === null ? null : { columns: cne };
}

/** Find a column by its node id within a region. */
function findColumn(
  region: DockRegion | null,
  nodeId: NodeId,
): { column: DockColumn } | null {
  if (region === null) return null;
  const column = region.columns.find((c) => c.id === nodeId);
  return column === undefined ? null : { column };
}

/** Find a leaf by its node id within a region, with its enclosing column. */
function findLeaf(
  region: DockRegion | null,
  nodeId: NodeId,
): { column: DockColumn; leaf: DockLeaf } | null {
  if (region === null) return null;
  for (const column of region.columns) {
    const leaf = column.leaves.find((l) => l.id === nodeId);
    if (leaf !== undefined) return { column, leaf };
  }
  return null;
}

/** Address a column by node id (for code resolving a column the user drags).
 * Returns the column or null. */
export function findColumnById(
  region: DockRegion | null,
  nodeId: NodeId,
): DockColumn | null {
  return findColumn(region, nodeId)?.column ?? null;
}

/** Region-relative index of the column holding leaf `nodeId`: columnInsert
 * seams are column indices (D55), and this is THE side-drop/side-band seam
 * derivation (hitTest's side bands and dropOnDockedLeaf's side arm both use
 * it). -1 when the node isn't in the region; callers clamp to seam 0. */
export function columnIndexOf(
  region: DockRegion | null,
  nodeId: NodeId,
): number {
  if (region === null) return -1;
  return region.columns.findIndex((c) => c.leaves.some((l) => l.id === nodeId));
}

// ---------------------------------------------------------------------------
// Collapse / minimization.
// ---------------------------------------------------------------------------

/** A docked column is "minimized" exactly when its container flag is set
 * (D38): it renders as the 36px rail in place. Leaf-level collapse is
 * unrepresentable, so this is purely the column's own `railed` flag. */
export function isColumnMinimized(column: DockColumn): boolean {
  return column.railed === true;
}

/** True when the column with id `nodeId` (in either docked region) renders
 * collapsed -- its railed flag, the one docked collapse store (D44: the
 * packed region rail is derived from these same flags). Used to skip the
 * shrink-the-leaf split preview over a minimized target (nothing to
 * vacate). False if the column isn't found. */
export function nodeAllMinimized(layout: DockLayout, nodeId: NodeId): boolean {
  for (const edge of ["left", "right"] as const) {
    const region = layout.docked[edge];
    const found = findColumn(region, nodeId);
    if (found !== null) return isColumnMinimized(found.column);
    // A leaf id may also be passed (a single-leaf column dropped beside): the
    // enclosing column's container state decides.
    const leaf = findLeaf(region, nodeId);
    if (leaf !== null) return isColumnMinimized(leaf.column);
  }
  return false;
}

/** True when a floating window is minimized: its one container flag (D38).
 * (Name kept from the per-group era so call sites read unchanged; "all
 * minimized" and "minimized" are the same thing now.) */
export function windowAllMinimized(
  layout: DockLayout,
  windowId: WindowId,
): boolean {
  const win = layout.floating.find((w) => w.id === windowId);
  return win !== undefined && win.collapsed === true;
}

/** In-order group ids of every leaf in a column. */
export function collectLeafGroups(column: DockColumn): GroupId[] {
  return column.leaves.map((l) => l.group);
}

/** In-order leaf nodes (id + group) of a column. */
export function collectLeaves(
  column: DockColumn,
): { id: NodeId; group: GroupId }[] {
  return column.leaves.map((l) => ({ id: l.id, group: l.group }));
}

/** Whether a region's given edge is a single leaf -- so a "dock beside/above
 * everything" drop there would be identical to a per-panel split of that one
 * panel, and the region-edge zone is suppressed as redundant. Distinct only
 * when the edge spans multiple cells -- i.e. unless the region is exactly one
 * column holding one leaf (D46: with columns full-height, every side reduces
 * to that same condition). */
export function edgeIsSingleLeaf(region: DockRegion): boolean {
  return region.columns.length === 1 && region.columns[0].leaves.length === 1;
}

/** Minimum width a single docked column may be resized to in the layout model:
 * MIN_REGION_GRAB_PX -- a tiny grabbable sliver, not the pane-content minimum
 * (a too-narrow panel scrolls its body instead). A constant (leaves stacked in
 * a column share one width), named so a future per-column minimum has one home. */
export function minRegionWidth(): number {
  return MIN_REGION_GRAB_PX;
}

/** The area id whose tab group is `groupId`, or null. A group that backs a
 * nested dockable area is a fixed fixture (never floated/removed). */
export function areaForGroup(
  layout: DockLayout,
  groupId: GroupId,
): AreaId | null {
  for (const [areaId, area] of Object.entries(layout.areas ?? {})) {
    if (area.group === groupId) return areaId;
  }
  return null;
}

/** Whether `groupId` backs a nested dockable area. */
export function isAreaGroup(layout: DockLayout, groupId: GroupId): boolean {
  return areaForGroup(layout, groupId) !== null;
}

/** A column with 2+ stacked leaves -- the case where "float the whole column"
 * is a distinct gesture from "float a single panel" (a 1-leaf column is its
 * single panel). Every column is trivially linearizable top-to-bottom, so
 * this is just a leaf-count check. */
export function isMultiLeafColumn(column: DockColumn): boolean {
  return column.leaves.length >= 2;
}

/** Distribute a region's total width across its side-by-side columns for a
 * region-edge resize. Every column scales proportionally from its drag-start
 * width; columns that would cross a min/max limit are clamped there, and the
 * difference is redistributed among the still-unclamped columns (iterated,
 * since redistribution can push more columns to a limit). The region can
 * therefore keep resizing while any column has room, instead of locking up as
 * soon as one column hits a limit. `targetTotal` is clamped to
 * [sum(mins), sum(maxs)]; the result sums to the clamped target. */
export function resizeRegionColumns(
  initialWidths: number[],
  minWidths: number[],
  maxWidths: number[],
  targetTotal: number,
): number[] {
  const n = initialWidths.length;
  if (n === 0) return [];
  const sumMin = minWidths.reduce((a, b) => a + b, 0);
  const sumMax = maxWidths.reduce((a, b) => a + b, 0);
  const target = clamp(targetTotal, sumMin, sumMax);
  // Share weights for proportional scaling/redistribution; a zero-width
  // column still gets an equal-ish share so it can't divide by zero.
  const share = initialWidths.map((w) => (w > 0 ? w : 1));
  const shareTotal = share.reduce((a, b) => a + b, 0);
  const widths = share.map((s) => (s / shareTotal) * target);
  const frozen: boolean[] = new Array(n).fill(false);
  for (let pass = 0; pass < n; pass++) {
    let correction = 0; // width still to hand out (+) or take back (-).
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue;
      const clamped = clamp(widths[i], minWidths[i], maxWidths[i]);
      if (clamped !== widths[i]) {
        correction += widths[i] - clamped;
        widths[i] = clamped;
        frozen[i] = true;
      }
    }
    if (correction === 0) break;
    const freeShare = share.reduce((s, w, i) => s + (frozen[i] ? 0 : w), 0);
    if (freeShare === 0) break; // all clamped; leftover handled below.
    for (let i = 0; i < n; i++) {
      if (!frozen[i]) widths[i] += (correction * share[i]) / freeShare;
    }
  }
  // Mixed finite bounds can strand a leftover: freezing above is permanent,
  // so a pass that clamps columns in OPPOSITE directions (some up to a min,
  // some down to a max) can end with every column frozen while the sum is
  // off target -- even though a column frozen at its min still has room to
  // grow. Hand the leftover to the columns with room in the needed
  // direction, proportional to that room; the target is inside
  // [sumMin, sumMax], so enough room always exists. Capping each column's
  // take at its room means no re-clamping is needed. (Unreachable in the
  // production regime -- all callers pass Infinity maxes, where the loop
  // above already lands on target -- but the contract holds for any caller.)
  for (let pass = 0; pass < n; pass++) {
    const leftover = target - widths.reduce((a, b) => a + b, 0);
    if (Math.abs(leftover) < 1e-6) break;
    const room = widths.map((w, i) =>
      leftover > 0 ? maxWidths[i] - w : w - minWidths[i],
    );
    const roomTotal = room.reduce((s, r) => s + Math.max(r, 0), 0);
    if (roomTotal <= 0) break;
    const take = Math.min(Math.abs(leftover), roomTotal);
    for (let i = 0; i < n; i++) {
      if (room[i] > 0)
        widths[i] += Math.sign(leftover) * ((take * room[i]) / roomTotal);
    }
  }
  return widths;
}

/** Pure cascading-divider resize, shared by docked column/leaf splits and
 * floating snap-stacks. Dragging the boundary between cell `dividerIndex` and
 * `dividerIndex+1` grows the drag-side cell and shrinks the other side in order
 * (when a neighbor hits `minCell` the next sibling gives space -- the boundary
 * "pushes" through), conserving the total. Collapsed cells are excluded (they
 * render at a fixed handle size and keep their weight). Returns the new per-cell
 * pixel sizes (collapsed cells -> 0), or null when the drag is a no-op (zero
 * container, or growing a collapsed cell). The caller maps live cells back to
 * weights and leaves collapsed cells' weights untouched. */
export function cascadeResize(opts: {
  weights: number[];
  collapsed: boolean[];
  containerPx: number;
  dividerIndex: number;
  deltaPx: number;
  /** Shared per-cell minimum px floor. */
  minCell: number;
  maxCell: number;
}): number[] | null {
  const { weights, collapsed, containerPx, deltaPx, maxCell } = opts;
  const index = opts.dividerIndex;
  const minCell = opts.minCell;
  if (containerPx <= 0) return null;
  const total = weights.reduce((s, w, i) => (collapsed[i] ? s : s + w), 0) || 1;
  const next = weights.map((w, i) =>
    collapsed[i] ? 0 : (w / total) * containerPx,
  );
  // The grower is the nearest expanded cell in the grow direction: a fixed
  // 26px bar adjacent to the seam is skipped rather than dead-ending the
  // drag (a resize cursor that no-ops in one direction lies -- hit-box loop
  // finding). Null only when no expanded cell exists on that side.
  let growIdx = deltaPx > 0 ? index : index + 1;
  const step = deltaPx > 0 ? -1 : 1;
  while (growIdx >= 0 && growIdx < weights.length && collapsed[growIdx]) {
    growIdx += step;
  }
  if (growIdx < 0 || growIdx >= weights.length) return null;
  if (deltaPx !== 0) {
    // Cells on the shrink side of the seam give space in order, nearest
    // first, each floored at minCell; the grower receives whatever was
    // actually given. Grow (deltaPx > 0) walks forward from past the seam;
    // shrink walks backward from the seam -- the same rule mirrored.
    const start = deltaPx > 0 ? index + 1 : index;
    const dir = deltaPx > 0 ? 1 : -1;
    let need = Math.min(Math.abs(deltaPx), maxCell - next[growIdx]);
    const want = need;
    for (let j = start; j >= 0 && j < next.length && need > 0.5; j += dir) {
      if (collapsed[j]) continue;
      const give = Math.min(need, next[j] - minCell);
      if (give > 0) {
        next[j] -= give;
        need -= give;
      }
    }
    next[growIdx] += want - need;
  }
  return next;
}

/** Per-divider resizable lookups over a per-cell minimized mask, computed once
 * as running prefix/suffix flags (instead of a slice().some() scan per
 * divider): `atOrBefore[i]` = some expanded cell at index <= i; `after[i]` =
 * some expanded cell at index > i. Divider i resizes iff both hold. Shared by
 * SplitView's column/leaf dividers and FloatingWindowView's stack dividers. */
export function expandedFlags(minimized: boolean[]): {
  atOrBefore: boolean[];
  after: boolean[];
} {
  const n = minimized.length;
  const atOrBefore = new Array<boolean>(n);
  const after = new Array<boolean>(n);
  let acc = false;
  for (let i = 0; i < n; i++) {
    acc = acc || !minimized[i];
    atOrBefore[i] = acc;
  }
  acc = false;
  for (let i = n - 1; i >= 0; i--) {
    after[i] = acc;
    acc = acc || !minimized[i];
  }
  return { atOrBefore, after };
}

export function findGroupLocation(
  layout: DockLayout,
  groupId: GroupId,
): GroupLocation | null {
  for (const edge of ["left", "right"] as DockEdge[]) {
    // A docked group is exactly one leaf; report that leaf's node id so callers
    // (split-against-anchor, drag-the-cell) can address it.
    const found = findGroupInRegion(layout.docked[edge], groupId);
    if (found !== null) return { kind: "docked", edge, nodeId: found.leaf.id };
  }
  for (const win of layout.floating) {
    if (win.stack.includes(groupId)) {
      return { kind: "floating", windowId: win.id };
    }
  }
  const areaId = areaForGroup(layout, groupId);
  if (areaId !== null) return { kind: "area", areaId };
  return null;
}

/** True when a group reads as collapsed -- derived purely from its container
 * (D38): the floating window's `collapsed` flag, or (docked) its containing
 * column's railed flag. Groups carry no collapse state of their own. */
export function isGroupEffectivelyCollapsed(
  layout: DockLayout,
  groupId: GroupId,
): boolean {
  const win = layout.floating.find((w) => w.stack.includes(groupId));
  if (win !== undefined) return win.collapsed === true;
  return isRailedDockedCell(layout, groupId);
}

/** True when a group is docked and reads as collapsed there (its containing
 * column's railed flag, D38) -- i.e. the drag paths' "was this a railed
 * cell" pre-op check, done in one region walk (the walk also yields the
 * containing column, which the location kinds alone don't). Non-docked
 * groups are always false. */
export function isRailedDockedCell(
  layout: DockLayout,
  groupId: GroupId,
): boolean {
  for (const edge of ["left", "right"] as DockEdge[]) {
    const found = findGroupInRegion(layout.docked[edge], groupId);
    if (found === null) continue;
    return found.column.railed === true;
  }
  return false;
}

/** The group ids that share a stack with `groupId` (including itself): a
 * floating window's whole stack, or the leaf groups of the docked column that
 * contains the group. A lone group (its own window, or the sole leaf of its
 * column) returns just `[groupId]`. Test/fuzz-harness scaffolding (the fuzz
 * invariants walk stacks with it); production chrome uses isStackedGroup. */
export function stackGroupIdsOf(
  layout: DockLayout,
  groupId: GroupId,
): GroupId[] {
  const win = layout.floating.find((w) => w.stack.includes(groupId));
  if (win !== undefined)
    return win.stack.length >= 2 ? [...win.stack] : [groupId];
  // Docked: the column holding this group's leaf is the stack.
  for (const edge of ["left", "right"] as DockEdge[]) {
    const found = findGroupInRegion(layout.docked[edge], groupId);
    if (found === null) continue;
    return found.column.leaves.length >= 2
      ? collectLeafGroups(found.column)
      : [groupId];
  }
  return [groupId];
}

/** D32 gate: is this group the sole group of a floating window? Only there
 * does the panel-level collapse control (the grip bar's `-` / the
 * unmergeable header's compact toggle, plus their backing clicks) render:
 * when scopes coincide the largest coinciding scope owns collapse, so a
 * docked panel -- lone or stacked -- never carries one (docked collapse is
 * uniformly the chevron -> rail). */
export function isSoleFloatingGroup(
  layout: DockLayout,
  groupId: GroupId,
): boolean {
  const win = layout.floating.find((w) => w.stack.includes(groupId));
  return win !== undefined && win.stack.length === 1;
}

export function isStackedGroup(layout: DockLayout, groupId: GroupId): boolean {
  const win = layout.floating.find((w) => w.stack.includes(groupId));
  if (win !== undefined) return win.stack.length >= 2;
  for (const edge of ["left", "right"] as DockEdge[]) {
    const found = findGroupInRegion(layout.docked[edge], groupId);
    if (found !== null) return found.column.leaves.length >= 2;
  }
  return false;
}

/** Remove a group from wherever it currently lives, mutating `draft` in place.
 * The group object itself stays in `draft.groups`; the caller re-inserts it
 * elsewhere (or deletes it). An emptied column is dropped from its region, an
 * emptied region becomes null, and an emptied floating window is removed -- so
 * the flat invariant holds by construction after every detach. */
function detachInPlace(draft: DockLayout, groupId: GroupId): void {
  const loc = findGroupLocation(draft, groupId);
  if (loc === null) return;
  // An area group is a fixed fixture -- it is never moved or removed. Panes are
  // added to / torn out of it individually; the group itself stays put (this
  // should not be reached, since area groups are only ever drop targets or the
  // source of a tearOutPane, never floated as a whole -- but guard anyway).
  if (loc.kind === "area") return;
  if (loc.kind === "docked") {
    const region = draft.docked[loc.edge];
    const res = region === null ? null : regionRemoveGroup(region, groupId);
    draft.docked[loc.edge] = res;
    // No stale-flag hazard on an emptied edge (D44): the rail is derived
    // from column flags, which leave with their columns.
  } else {
    const win = draft.floating.find((w) => w.id === loc.windowId);
    if (win === undefined) return;
    win.stack = win.stack.filter((g) => g !== groupId);
    if (win.stackWeights !== undefined) delete win.stackWeights[groupId];
    if (win.stack.length === 0) {
      draft.floating = draft.floating.filter((w) => w.id !== loc.windowId);
    }
  }
}

/** Drop any area-backing groups from a dragged set: an area's group is a fixed
 * fixture (detachInPlace is a no-op for it), so docking/snapping it would
 * reference it from a second place while it stays in its area -- a duplicated
 * group. Not reachable from the UI today (drag stacks never contain area
 * groups), but guarded like insertTabsInto. */
function withoutAreaGroups(layout: DockLayout, groupIds: GroupId[]): GroupId[] {
  return groupIds.filter((g) => !isAreaGroup(layout, g));
}

// ---------------------------------------------------------------------------
// Group, leaf, and column construction.
// ---------------------------------------------------------------------------

/** Build a fresh TabGroup. NonEmpty by type: `makeGroup([])` would have
 * produced `activeId: undefined` silently typed as a real PaneId -- an invalid
 * group flowing anywhere. (The one legal empty group, an area's backing group,
 * is built inline by ensureArea with an explicit `activeId: null`.) */
export function makeGroup(paneIds: NonEmpty<PaneId>): TabGroup {
  return {
    id: freshId("group"),
    paneIds: [...paneIds],
    activeId: paneIds[0],
  };
}

/** Whether a pane is flagged unmergeable in the registry. */
export function isPaneUnmergeable(
  panes: PaneRegistry,
  paneId: PaneId,
): boolean {
  return panes[paneId]?.unmergeable === true;
}

/** Whether a group holds an unmergeable pane. Unmergeable panes always live
 * alone, so any pane in the group being unmergeable marks the whole group. */
export function isGroupUnmergeable(
  layout: DockLayout,
  panes: PaneRegistry,
  groupId: GroupId,
): boolean {
  const group = layout.groups[groupId];
  if (group === undefined) return false;
  return group.paneIds.some((p) => isPaneUnmergeable(panes, p));
}

function makeLeaf(groupId: GroupId, weight = 1): DockLeaf {
  return { id: freshId("node"), group: groupId, weight };
}

/** Build a DockColumn from an ordered list of groups (>=1): the groups become
 * the column's stacked leaves (top to bottom), so a snapped floating stack keeps
 * its vertical arrangement when docked. The column's own weight defaults to 1
 * (its horizontal share in the region); callers override it when preserving a
 * sibling's width. `leafWeights` (per-group height shares -- a floated stack's
 * preserved stackWeights) carry a 70/30 split back into the docked column;
 * absent entries default to 1. A lone group is a column of one leaf -- a count
 * of one, not a special shape. */
function buildColumn(
  groupIds: NonEmpty<GroupId>,
  weight = 1,
  leafWeights?: Record<GroupId, number>,
): DockColumn {
  return {
    id: freshId("node"),
    weight,
    leaves: mapNonEmpty(groupIds, (g) => makeLeaf(g, leafWeights?.[g] ?? 1)),
  };
}

/** Detach every group in `groupIds` from the draft, returning the preserved
 * per-group height shares of the floating window that held all of them (its
 * whole stack being docked; `heights` undefined when the groups aren't
 * coming from one window) plus whether the source container was collapsed --
 * transfers are identity (D38): docking a collapsed container rails/collapses
 * the landing scope, so the callers need the source container's state after
 * the container itself is gone. The source may be a floating window (every
 * user drag-dock path -- drags float first) or a docked railed cell:
 * server-driven docked->docked moves (applyPanelPlacement edge/split) never
 * float in between, and their collapse must carry the same way the float
 * path's does. Capture-then-detach lives in ONE helper because the order is
 * load-bearing: detachInPlace deletes each departing group's stackWeights
 * entry as it leaves, so the weights must be copied out first -- this is the
 * inverse of floatColumn, which wrote them, and it's what lets a floated
 * 70/30 stack dock back at 70/30. */
function detachAllPreservingStackWeights(
  draft: DockLayout,
  groupIds: NonEmpty<GroupId>,
): { heights: Record<GroupId, number> | undefined; sourceCollapsed: boolean } {
  const win = draft.floating.find((w) =>
    groupIds.every((g) => w.stack.includes(g)),
  );
  const heights =
    win?.stackWeights === undefined ? undefined : { ...win.stackWeights };
  const sourceCollapsed =
    win !== undefined
      ? win.collapsed === true
      : groupIds.every((g) => isRailedDockedCell(draft, g));
  groupIds.forEach((g) => detachInPlace(draft, g));
  return { heights, sourceCollapsed };
}

/** A single-column region holding `column` (D46: Region = Column[]). */
function regionOf(column: DockColumn): DockRegion {
  return { columns: [column] };
}

// ---------------------------------------------------------------------------
// Docking ops.
// ---------------------------------------------------------------------------

/** Dock a stack of groups to a screen edge as a new column at the outermost
 * position (far left for "left", far right for "right"). Multiple groups (a
 * snapped floating stack) dock together, keeping their vertical arrangement.
 * Delegates to dockToRegionEdge with side === edge: inserting on the region's
 * own edge side IS the outermost insert. */
export function dockToEdge(
  layout: DockLayout,
  groupIds: GroupId[],
  edge: DockEdge,
): DockLayout {
  return dockToRegionEdge(layout, groupIds, edge, edge);
}

/** Dock a stack of groups as a new full-height column at the region's outer
 * or inner side (D46: columns are the only horizontal partition; top/bottom
 * full-width band inserts are unrepresentable -- vertical arrangement is
 * leaf stacking within a column, via dropOnDockedLeaf). Optional weights
 * preserve the existing content's size (the new column grows the region
 * rather than resizing what's there). Delegates to insertColumnAt (D55):
 * the region's own side IS seam 0 / seam N. */
export function dockToRegionEdge(
  layout: DockLayout,
  groupIds: GroupId[],
  edge: DockEdge,
  side: "left" | "right",
  weights?: { existing: number; dragged: number },
): DockLayout {
  const region = layout.docked[edge];
  const index =
    side === "left" ? 0 : region === null ? 0 : region.columns.length;
  return insertColumnAt(layout, groupIds, edge, index, weights);
}

/** Insert a stack of groups as a NEW FULL-HEIGHT COLUMN at seam `index`
 * (0..N inclusive) of `edge`'s region -- THE canonical op for every
 * full-height column insertion (D55): region-edge docking (seam 0/N, via
 * dockToRegionEdge), per-panel side bands and divider-gap drops (interior
 * seams, via dropOnDockedLeaf's left/right arm and the hit-test's
 * columnInsert result), and rail side slivers all land here, so "adjacent
 * zones on one seam are one drop" is structural rather than an audited
 * equivalence (P9). An empty edge creates the region (the index is moot: a
 * region of one). Optional `weights` rescales the existing columns vs the
 * newcomer (dockToRegionEdge's contract); without it the newcomer's weight
 * is a placeholder 1 -- applyOp's width reconciliation rewrites new-column
 * weights to real pixels (D3/D40) on every commit, so pre-reconcile weights
 * are transient on every consumer-visible path.
 *
 * Index bookkeeping: detaching a same-region dragged group can remove or
 * shift columns, so a pre-detach index may go stale. The seam is captured
 * as the set of column IDS to its left before detach and re-derived as the
 * count of those that SURVIVE -- which also clamps by construction (the
 * count can never exceed the live column count). Re-inserting a column's
 * own groups at its own seam is the identity (no fresh-id churn -- the
 * BUG #3 sole-leaf no-op, generalized to any column). */
export function insertColumnAt(
  layout: DockLayout,
  groupIds: GroupId[],
  edge: DockEdge,
  index: number,
  weights?: { existing: number; dragged: number },
): DockLayout {
  groupIds = withoutAreaGroups(layout, groupIds);
  const ne = asNonEmpty(groupIds);
  if (ne === null) return layout;
  const before = layout.docked[edge];
  if (before !== null) {
    // Self-insert identity: the dragged set IS an existing column, dropped
    // at one of its own two seams. Detach+rebuild would only churn node ids.
    const p = before.columns.findIndex(
      (c) =>
        c.leaves.length === ne.length &&
        c.leaves.every((l, i) => l.group === ne[i]),
    );
    if (p >= 0 && (index === p || index === p + 1)) return layout;
  }
  // The seam, captured as the column ids left of it (clamped into range) so
  // it survives the detach below.
  const leftNeighborIds = new Set(
    (before?.columns ?? []).slice(0, Math.max(0, index)).map((c) => c.id),
  );
  const draft = clone(layout);
  const { heights: stackHeights, sourceCollapsed } =
    detachAllPreservingStackWeights(draft, ne);
  const existing = draft.docked[edge];
  if (existing === null) {
    const first = buildColumn(ne, 1, stackHeights);
    // Identity transfer (D38/D44): a collapsed window docked onto an empty
    // edge lands as a railed column (a packed region of one, derived).
    if (sourceCollapsed) first.railed = true;
    draft.docked[edge] = regionOf(first);
    return draft;
  }
  // A new full-height column at the seam -- a plain columns insert (D46: a
  // vertical stack is one multi-leaf column).
  const dw = weights?.dragged ?? 1;
  const column = buildColumn(ne, dw, stackHeights);
  // Identity transfer (D38): a collapsed window docked beside content lands
  // as a railed column.
  if (sourceCollapsed) column.railed = true;
  if (weights !== undefined) {
    const total = existing.columns.reduce((sum, c) => sum + c.weight, 0) || 1;
    existing.columns.forEach((c) => {
      c.weight = (c.weight / total) * weights.existing;
    });
  }
  // Re-derive the seam: the surviving left-neighbor count.
  const at = existing.columns.filter((c) => leftNeighborIds.has(c.id)).length;
  existing.columns = withInserted(existing.columns, at, column);
  return draft;
}

/** Drop a stack of groups onto an existing docked leaf. `center` merges every
 * dragged pane into the target's tabs. The key semantic:
 * - top/bottom insert the dragged leaf(s) into the target leaf's column, just
 *   above/below the target (a column gains a leaf);
 * - left/right insert a new column beside the target leaf's column (the region
 *   gains a column).
 * This is what keeps every gesture inside the fixed 3-level shape. */
export function dropOnDockedLeaf(
  layout: DockLayout,
  draggedGroupIds: GroupId[],
  edge: DockEdge,
  targetNodeId: NodeId,
  region: DropRegion,
): DockLayout {
  draggedGroupIds = withoutAreaGroups(layout, draggedGroupIds);
  const ne = asNonEmpty(draggedGroupIds);
  if (ne === null) return layout;
  const existingRegion = layout.docked[edge];
  const target = findLeaf(existingRegion, targetNodeId);
  if (target === null) return layout;

  if (region === "center") {
    return mergeGroupsInto(layout, target.leaf.group, ne);
  }

  if (region === "left" || region === "right") {
    // A side drop is a full-height column insert at the seam beside the
    // target's COLUMN (D46: columns are the region's only horizontal
    // partition, so a "beside just this cell" landing is unrepresentable).
    // Delegated to the ONE canonical column-insert op (D55): the seam index
    // derives from the target column's position, and insertColumnAt
    // re-anchors it across the detach (a same-region drag can shift or
    // remove columns) and preserves a railed target's P8 restore weight by
    // construction -- it never touches existing columns' weights.
    const ci = columnIndexOf(existingRegion, targetNodeId);
    return insertColumnAt(layout, ne, edge, region === "left" ? ci : ci + 1);
  }

  const draft = clone(layout);
  // (Collapse transfer doesn't apply here: a top/bottom drop joins the
  // target's column, and the receiving container's state wins -- no flag
  // travels. Side drops carry it inside insertColumnAt.)
  const { heights: stackHeights } = detachAllPreservingStackWeights(draft, ne);
  // Re-find the target leaf after detach. If a dragged group shared this edge,
  // detaching it may have dropped the target's column; if the target is gone (a
  // self-drop), abort rather than orphaning the dragged groups.
  const liveRegion = draft.docked[edge];
  const live = findLeaf(liveRegion, targetNodeId);
  if (liveRegion === null || live === null) return layout;

  const targetColumn = live.column; // a reference into the cloned draft

  const li = targetColumn.leaves.findIndex((l) => l.id === targetNodeId);

  // top / bottom: insert the dragged leaf(s) into the target's column,
  // above/below it. Sibling weights may be on any scale (divider drags
  // write px values), so new-vs-target defaults derive from the target's
  // current weight: the dragged stack as a whole takes half (the hint's
  // 50/50 promise, scale-invariant); each leaf's share of that half
  // follows the floated stack's preserved height ratios (P8 round-trip --
  // the same rule insertColumnAt's buildColumn applies to side drops).
  const half = live.leaf.weight / 2;
  targetColumn.leaves[li] = { ...live.leaf, weight: half };
  const shareOf = (g: GroupId) => stackHeights?.[g] ?? 1;
  const totalShares = ne.reduce((s2, g) => s2 + shareOf(g), 0) || 1;
  const banded = mapNonEmpty(ne, (g) =>
    makeLeaf(g, (half * shareOf(g)) / totalShares),
  );
  const at = region === "top" ? li : li + 1;
  targetColumn.leaves = withInserted(targetColumn.leaves, at, ...banded);
  return draft;
}

/** Insert every pane from `sourceGroupIds` into `targetGroupId`'s tab strip at
 * `index`, dropping the now-empty source groups. The last inserted group's
 * active tab becomes active. */
export function insertTabsInto(
  layout: DockLayout,
  targetGroupId: GroupId,
  sourceGroupIds: GroupId[],
  index: number,
): DockLayout {
  // Like the other ops: an area's backing group is never a source (consuming it
  // would delete it from layout.groups while layout.areas still points at it).
  sourceGroupIds = withoutAreaGroups(layout, sourceGroupIds);
  const draft = clone(layout);
  const target = draft.groups[targetGroupId];
  if (target === undefined) return layout;
  const incoming: PaneId[] = [];
  let active = target.activeId;
  for (const sourceId of sourceGroupIds) {
    if (sourceId === targetGroupId) continue;
    const source = draft.groups[sourceId];
    if (source === undefined) continue;
    detachInPlace(draft, sourceId);
    incoming.push(...source.paneIds);
    active = source.activeId;
    delete draft.groups[sourceId];
  }
  if (incoming.length === 0) return layout;
  const i = clampIndex(index, target.paneIds.length);
  target.paneIds = [
    ...target.paneIds.slice(0, i),
    ...incoming,
    ...target.paneIds.slice(i),
  ];
  // Guard against a source carrying a stale/empty activeId (e.g. an emptied
  // group consumed mid-merge): the active tab must be one of the result's tabs.
  target.activeId =
    active !== null && target.paneIds.includes(active)
      ? active
      : target.paneIds[0];
  return draft;
}

/** Merge per-group height weights into a floating window's stack (groupId ->
 * weight). Used by the draggable divider between stacked floating groups; only
 * meaningful for a fixed-height window. Rejects non-finite / non-positive. */
export function setStackWeights(
  layout: DockLayout,
  windowId: WindowId,
  weights: Record<GroupId, number>,
): DockLayout {
  const draft = clone(layout);
  const win = draft.floating.find((w) => w.id === windowId);
  if (win === undefined) return layout;
  const next = { ...(win.stackWeights ?? {}) };
  for (const [g, w] of Object.entries(weights)) {
    if (Number.isFinite(w) && w > 0) next[g] = w;
  }
  win.stackWeights = next;
  return draft;
}

/** Cap a pinned window height to the container (so it stays usable -- contents
 * scroll -- when the browser shrinks below the saved height). In a tiny
 * container the cap is floored at MIN_WINDOW_HEIGHT_PX to keep the window
 * usable, but that floor is itself capped at the pinned height: we never render
 * a window taller than it was pinned to, so a small panel in a tiny container
 * shrinks rather than overhanging. Independent of position: moving never
 * resizes. `containerHeight <= 0` (unmeasured) returns the pinned height. */
export function cappedWindowHeight(
  pinnedHeight: number,
  containerHeight: number,
): number {
  if (containerHeight <= 0) return pinnedHeight;
  const floor = Math.min(MIN_WINDOW_HEIGHT_PX, pinnedHeight);
  return Math.min(pinnedHeight, Math.max(floor, containerHeight - 8));
}

/** Set a floating window's explicit height (px), switching it from auto-height
 * to fixed-height with its contents scrolling -- or pass `undefined` to clear
 * the pin and return it to auto-height (the window tracks its content again).
 * Reverting to auto is the user's escape hatch from a fixed height (e.g.
 * dragging the bottom grip back down to the natural content height). */
export function resizeWindowHeight(
  layout: DockLayout,
  windowId: WindowId,
  height: number | undefined,
  /** New top edge, for resizes that grab the top grips (the bottom edge stays
   * fixed by moving y as the height changes -- the vertical analog of
   * resizeWindow's `x`). */
  y?: number,
): DockLayout {
  const draft = clone(layout);
  const win = draft.floating.find((w) => w.id === windowId);
  if (win === undefined) return layout;
  win.height = windowHeight(height);
  if (y !== undefined) win.y = y;
  return draft;
}

/** Mark a (draft) window user-owned by dropping its server anchor, so it stops
 * re-anchoring to the canvas edges. The single home for "a user gesture took
 * manual control" -- every gesture op that commits a user-chosen geometry (move,
 * resize, snap) calls this, so a new gesture can't silently forget to un-anchor.
 * Mutates in place; the caller owns the draft. */
function markWindowUserOwned(win: FloatingWindow): void {
  delete win.anchor;
}

/** Release a window's server anchor so it stops re-anchoring on canvas changes
 * -- it becomes a plainly user-owned float at its current absolute position.
 * Called when a user gesture (drag, any resize grip) takes manual control of the
 * window. No-op if it had none. */
export function releaseAnchor(
  layout: DockLayout,
  windowId: WindowId,
): DockLayout {
  const win = layout.floating.find((w) => w.id === windowId);
  if (win === undefined || win.anchor === undefined) return layout;
  const draft = clone(layout);
  markWindowUserOwned(draft.floating.find((x) => x.id === windowId)!);
  return draft;
}

/** Append every pane from `sourceGroupIds` to `targetGroupId`'s tab strip. */
export function mergeGroupsInto(
  layout: DockLayout,
  targetGroupId: GroupId,
  sourceGroupIds: GroupId[],
): DockLayout {
  const end = layout.groups[targetGroupId]?.paneIds.length ?? 0;
  return insertTabsInto(layout, targetGroupId, sourceGroupIds, end);
}

// ---------------------------------------------------------------------------
// Pane lifecycle ops.
//
// Panes can appear and disappear at runtime (e.g. driven by server state).
// These ops add a not-yet-placed pane to the layout and remove a pane from
// wherever the user has since moved it, collapsing whatever empties out. They
// are deliberately idempotent: adding a pane that's already placed and
// removing one that isn't are both no-ops, so a sync layer can re-run them.
// ---------------------------------------------------------------------------

/** The group currently holding `paneId`, or null when the pane isn't placed
 * anywhere in the layout. */
export function findPaneGroup(
  layout: DockLayout,
  paneId: PaneId,
): GroupId | null {
  for (const group of Object.values(layout.groups)) {
    if (group.paneIds.includes(paneId)) return group.id;
  }
  return null;
}

/** Ensure `areaId` exists, creating an empty backing group for it if needed.
 * Returns the input unchanged when the area is already registered. */
export function ensureArea(layout: DockLayout, areaId: AreaId): DockLayout {
  const existing = layout.areas?.[areaId];
  if (existing !== undefined && layout.groups[existing.group] !== undefined) {
    return layout;
  }
  const draft = clone(layout);
  // An empty group has no active tab (activeId null, the only legal empty
  // state); it becomes real when the first pane is added.
  const group: TabGroup = { id: freshId("group"), paneIds: [], activeId: null };
  draft.groups[group.id] = group;
  draft.areas = {
    ...(draft.areas ?? {}),
    [areaId]: { group: group.id },
  };
  return draft;
}

/** Add a pane to an area's tabs at `index` (default: append), creating the
 * area if needed. No-op when the pane is already placed anywhere in the
 * layout -- the user may have dragged it out of the area, and re-adding it
 * would duplicate it; callers that really want to move it back should
 * removePane first. */
export function addPaneToArea(
  layout: DockLayout,
  areaId: AreaId,
  paneId: PaneId,
  index?: number,
): DockLayout {
  if (findPaneGroup(layout, paneId) !== null) return layout;
  const draft = clone(ensureArea(layout, areaId));
  const group = draft.groups[draft.areas![areaId].group];
  const i = clampIndex(index, group.paneIds.length);
  group.paneIds.splice(i, 0, paneId);
  // (A just-emptied group had activeId null -- invariant #5 -- so the
  // "first pane added" case is covered by the null check.)
  if (group.activeId === null || !group.paneIds.includes(group.activeId)) {
    group.activeId = paneId;
  }
  return draft;
}

/** Add a not-yet-placed pane as its own floating window. No-op when the pane
 * is already placed. Returns the new window's id (null on no-op). */
export function addFloatingPane(
  layout: DockLayout,
  paneId: PaneId,
  x: number,
  y: number,
  width: number,
  height?: number,
): { layout: DockLayout; windowId: WindowId | null } {
  if (findPaneGroup(layout, paneId) !== null) {
    return { layout, windowId: null };
  }
  const draft = clone(layout);
  const group = makeGroup([paneId]);
  draft.groups[group.id] = group;
  const win = makeFloatingWindow(x, y, width, [group.id], height);
  draft.floating.push(win);
  return { layout: draft, windowId: win.id };
}

/** Remove a pane from wherever it currently lives (the user may have moved it
 * far from where it was added). A non-area group left empty is detached and
 * deleted -- its window or docked cell collapses like a tear-out would; an
 * area's backing group persists empty as a drop affordance. No-op when the
 * pane isn't placed. */
export function removePane(layout: DockLayout, paneId: PaneId): DockLayout {
  if (findPaneGroup(layout, paneId) === null) return layout;
  const draft = clone(layout);
  removePaneInPlace(draft, paneId);
  return draft;
}

/** In-place pane removal (the body of removePane; the caller owns the draft).
 * Drops `paneId` from its group, collapsing an emptied non-area group's window
 * or docked cell. No-op if the pane isn't placed. */
function removePaneInPlace(draft: DockLayout, paneId: PaneId): void {
  const groupId = findPaneGroup(draft, paneId);
  if (groupId === null) return;
  const group = draft.groups[groupId];
  group.paneIds = group.paneIds.filter((p) => p !== paneId);
  if (group.paneIds.length === 0) {
    if (!isAreaGroup(draft, groupId)) {
      detachInPlace(draft, groupId);
      delete draft.groups[groupId];
    } else {
      // An emptied area group persists (drop affordance) with no active tab.
      group.activeId = null;
    }
    return;
  }
  if (group.activeId === paneId) group.activeId = group.paneIds[0];
}

/** Move `paneId` into `destGroupId` at `index` (append if omitted), in place.
 * Detaches the pane from wherever it currently lives first (collapsing any group
 * it empties), so a pane can never end up in two groups -- the single primitive
 * for relocating a pane. No-op if it's already in dest. The caller owns the
 * draft and must ensure `destGroupId` exists. */
function movePaneInPlace(
  draft: DockLayout,
  paneId: PaneId,
  destGroupId: GroupId,
  index?: number,
): void {
  if (findPaneGroup(draft, paneId) === destGroupId) return;
  removePaneInPlace(draft, paneId); // detach first -> no duplication possible
  const dest = draft.groups[destGroupId];
  if (dest === undefined) return;
  dest.paneIds.splice(clampIndex(index, dest.paneIds.length), 0, paneId);
  if (dest.paneIds.length === 1) dest.activeId = paneId;
}

/** Reorder an area's tabs to match `order` (e.g. a server-driven tab list).
 * Panes the user dragged out of the area aren't touched; panes in the area
 * but not in `order` (shouldn't happen) keep their position at the end. No-op
 * when the area doesn't exist or the order already matches. */
export function setAreaTabOrder(
  layout: DockLayout,
  areaId: AreaId,
  order: PaneId[],
): DockLayout {
  const area = layout.areas?.[areaId];
  if (area === undefined) return layout;
  const group = layout.groups[area.group];
  if (group === undefined) return layout;
  const present = new Set(group.paneIds);
  const next = [
    ...order.filter((p) => present.has(p)),
    ...group.paneIds.filter((p) => !order.includes(p)),
  ];
  if (next.every((p, i) => p === group.paneIds[i])) return layout;
  const draft = clone(layout);
  draft.groups[area.group].paneIds = next;
  return draft;
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined) return length;
  return Math.max(0, Math.min(length, index));
}

// ---------------------------------------------------------------------------
// Floating ops.
// ---------------------------------------------------------------------------

/** Build a FloatingWindow with a fresh id. Omitted height means the window
 * auto-sizes to content. */
function makeFloatingWindow(
  x: number,
  y: number,
  width: number,
  stack: GroupId[],
  height?: number,
  stackWeights?: Record<GroupId, number>,
): FloatingWindow {
  return {
    id: freshId("window"),
    x,
    y,
    width,
    height: windowHeight(height),
    stack,
    ...(stackWeights !== undefined ? { stackWeights } : {}),
  };
}

/** Move a group into a new floating window at the given parent-relative
 * position. Used when undocking, or when dragging a group out to float.
 * Returns the new window id so a drag can grab it immediately. No-op (null
 * windowId) for an area's backing group -- it's a fixed fixture, and floating
 * it would reference it from a second place while it stays in its area. */
export function floatGroup(
  layout: DockLayout,
  groupId: GroupId,
  x: number,
  y: number,
  width: number,
  /** Optional explicit height. Pass when the floated content needs a definite
   * height (e.g. a full-bleed nested area that fills its panel); otherwise the
   * window auto-sizes to content. */
  height?: number,
): { layout: DockLayout; windowId: WindowId | null } {
  // No-op on an unknown group id (a concurrent removePane can race a drag
  // start): floating it would push a window whose stack references a
  // nonexistent group -- a dangling ref (invariant #3) reported as success.
  if (layout.groups[groupId] === undefined) return { layout, windowId: null };
  if (isAreaGroup(layout, groupId)) return { layout, windowId: null };
  // Identity transfer (D38): a group floated out of a collapsed container
  // (a railed column / collapsed window) is born collapsed -- the new
  // window inherits the source container's state (P2: the user was
  // dragging a bar or rail cell, not a full panel).
  const sourceCollapsed = isGroupEffectivelyCollapsed(layout, groupId);
  const draft = clone(layout);
  detachInPlace(draft, groupId);
  const win = makeFloatingWindow(x, y, width, [groupId], height);
  if (sourceCollapsed) win.collapsed = true;
  draft.floating.push(win);
  return { layout: draft, windowId: win.id };
}

/** Float an entire docked column as one stacked window: the column's leaf
 * groups become the window's stack (top-to-bottom order preserved), with
 * stackWeights carrying the leaves' relative heights. Every column is trivially
 * linearizable in the flat model (its leaves top-to-bottom), so the only no-ops
 * are a missing column/edge or a column that backs a dockable area. */
export function floatColumn(
  layout: DockLayout,
  edge: DockEdge,
  columnNodeId: NodeId,
  x: number,
  y: number,
  width: number,
  height?: number,
): { layout: DockLayout; windowId: WindowId | null } {
  const found = findColumn(layout.docked[edge], columnNodeId);
  if (found === null) return { layout, windowId: null };
  const column = found.column;
  // Capture order + weights before detaching (detach restructures the region).
  // Sequential detachInPlace (by group id) reuses the standard cleanup
  // invariants (empty region -> null edge, drop emptied columns).
  const stack = column.leaves.map((l) => l.group);
  if (stack.some((g) => isAreaGroup(layout, g))) {
    return { layout, windowId: null };
  }
  const stackWeights: Record<GroupId, number> = {};
  column.leaves.forEach((l) => {
    stackWeights[l.group] = l.weight;
  });
  // Identity transfer (D38/D44): floating a railed column yields a
  // collapsed window (the column flag is the one docked store).
  const sourceCollapsed = column.railed === true;

  const draft = clone(layout);
  stack.forEach((g) => detachInPlace(draft, g));
  const win = makeFloatingWindow(x, y, width, stack, height, stackWeights);
  if (sourceCollapsed) win.collapsed = true;
  draft.floating.push(win);
  return { layout: draft, windowId: win.id };
}

/** Float an entire region as one window: every leaf across every column
 * (columns left-to-right, leaves top-to-bottom), with heights carried from
 * each leaf's share of its column. Used by the region parent handle -- the
 * region-level analog of floatColumn. */
export function floatRegion(
  layout: DockLayout,
  edge: DockEdge,
  x: number,
  y: number,
  width: number,
): { layout: DockLayout; windowId: WindowId | null } {
  const region = layout.docked[edge];
  if (region === null) return { layout, windowId: null };
  const stack: GroupId[] = [];
  const stackWeights: Record<GroupId, number> = {};
  for (const column of region.columns) {
    const total = column.leaves.reduce((s, l) => s + l.weight, 0) || 1;
    for (const lf of column.leaves) {
      stack.push(lf.group);
      stackWeights[lf.group] = lf.weight / total;
    }
  }
  if (stack.some((g) => isAreaGroup(layout, g))) {
    return { layout, windowId: null };
  }
  // Identity transfer (D38/D44): floating a fully railed region yields a
  // collapsed window (the column flags leave with their columns; the window
  // flag is their floating rendering).
  const sourceCollapsed = isRegionFullyRailed(region);
  const draft = clone(layout);
  stack.forEach((g) => detachInPlace(draft, g));
  const win = makeFloatingWindow(x, y, width, stack, undefined, stackWeights);
  if (sourceCollapsed) win.collapsed = true;
  draft.floating.push(win);
  return { layout: draft, windowId: win.id };
}

/** Pull a single pane out of its group into a new floating window. If the
 * pane was the only one in its group, the whole group floats instead (no new
 * group is created). Returns the new layout and the id of the group that ended
 * up floating, so the caller can immediately drive its drag. */
export function tearOutPane(
  layout: DockLayout,
  groupId: GroupId,
  paneId: PaneId,
  x: number,
  y: number,
  width: number,
): {
  layout: DockLayout;
  windowId: WindowId | null;
  floatingGroupId: GroupId | null;
} {
  const group = layout.groups[groupId];
  // No-op when the group doesn't exist (a concurrent server removePane can
  // delete it under a just-started drag -- floating a ghost id would commit a
  // window whose stack references a nonexistent group, invariant #3) or when
  // the pane isn't actually in this group: tearing out a pane the group
  // doesn't hold would otherwise conjure it -- the split branch below wraps
  // `paneId` in a fresh group regardless, so an absent paneId materializes a
  // phantom pane and breaks conservation. The pane must already live here for
  // there to be anything to tear out.
  if (group === undefined || !group.paneIds.includes(paneId)) {
    return { layout, windowId: null, floatingGroupId: null };
  }
  // An area group is a fixed fixture: never float it as a whole, even when it
  // holds a single pane. Always split the torn pane into its own new group and
  // leave the area group in place (it may end up empty -- it persists as a drop
  // affordance). A normal group with <=1 pane floats wholesale as before.
  const area = isAreaGroup(layout, groupId);
  if (!area && group.paneIds.length <= 1) {
    const res = floatGroup(layout, groupId, x, y, width);
    // Non-area by the check above, so floatGroup always created a window.
    return {
      layout: res.layout,
      windowId: res.windowId!,
      floatingGroupId: groupId,
    };
  }
  // Identity transfer (D38): a pane torn out of a collapsed container (a
  // collapsed window's bar label, a rail spine row) floats as a collapsed
  // window -- born collapsed; expanding is a click-only gesture. Same rule
  // as the wholesale-float branch above (floatGroup inherits it there).
  const sourceCollapsed = isGroupEffectivelyCollapsed(layout, groupId);
  const draft = clone(layout);
  const src = draft.groups[groupId];
  src.paneIds = src.paneIds.filter((p) => p !== paneId);
  // Keep activeId valid when panes remain; an emptied area goes to null (the
  // one legal empty-group state -- no stale sentinel).
  if (src.paneIds.length === 0) src.activeId = null;
  else if (src.activeId === paneId) src.activeId = src.paneIds[0];
  const newGroup = makeGroup([paneId]);
  draft.groups[newGroup.id] = newGroup;
  const win = makeFloatingWindow(x, y, width, [newGroup.id]);
  if (sourceCollapsed) win.collapsed = true;
  draft.floating.push(win);
  return { layout: draft, windowId: win.id, floatingGroupId: newGroup.id };
}

/** Set a floating window's position (parent-relative px). */
export function moveWindow(
  layout: DockLayout,
  windowId: WindowId,
  x: number,
  y: number,
): DockLayout {
  const draft = clone(layout);
  const win = draft.floating.find((w) => w.id === windowId);
  if (win === undefined) return layout;
  win.x = x;
  win.y = y;
  // A user-positioned window is absolute: drop any server-requested coords so it
  // isn't re-resolved (snapped back) when the canvas changes.
  markWindowUserOwned(win);
  return draft;
}

/** Set a floating window's width (px), optionally moving its left edge too.
 * Pass `x` for a left-edge resize so the right edge stays put. */
export function resizeWindow(
  layout: DockLayout,
  windowId: WindowId,
  width: number,
  x?: number,
): DockLayout {
  const draft = clone(layout);
  const win = draft.floating.find((w) => w.id === windowId);
  if (win === undefined) return layout;
  // Floor at the grab-min so a server set_width(0)/negative can't produce a
  // zero- or ungrabbable-width window (the interactive drag path clamps too).
  // No max here -- like docked regions, float width is otherwise uncapped.
  win.width = Math.max(MIN_REGION_GRAB_PX, width);
  if (x !== undefined) win.x = x;
  return draft;
}

/** Insert `groupIds` into `targetWindowId`'s vertical stack at `index` (the
 * "snap into another floating panel" gesture). Omitting `index` appends. A
 * multi-group dragged stack snaps in as a whole, preserving order. */
export function snapToWindowStack(
  layout: DockLayout,
  groupIds: GroupId[],
  targetWindowId: WindowId,
  index?: number,
): DockLayout {
  groupIds = withoutAreaGroups(layout, groupIds);
  const ne = asNonEmpty(groupIds);
  if (ne === null) return layout;
  const draft = clone(layout);
  // Capture the dragged window's explicit height before detaching (detach
  // removes the now-empty source window, discarding its height). If the target
  // auto-sizes, adopt the dragged window's height so a height the user set on the
  // panel being snapped in isn't silently reset.
  const sourceHeight = layout.floating.find((w) =>
    groupIds.some((g) => w.stack.includes(g)),
  )?.height;
  // Detach first (preserving the source stack's height shares); the dragged
  // set may be (part of) the target window's stack.
  const { heights: sourceShares } = detachAllPreservingStackWeights(draft, ne);
  // Re-find the target after detach: if the dragged groups were its entire
  // stack, the window is now gone -- abort rather than splice into a stale
  // object (which would orphan the groups and lose the panes).
  const target = draft.floating.find((w) => w.id === targetWindowId);
  if (target === undefined) return layout;
  // Seed the inserted groups' stack weights ON THE TARGET'S SCALE. Sibling
  // weights may be on any scale (a divider drag writes px values), so a
  // missing entry -- which renders as flex weight 1 -- would make the
  // snapped-in panel a sliver next to px-scale siblings. Each inserted group
  // gets the target's mean weight, with the source stack's preserved ratios
  // kept among the inserted groups themselves (same derive-from-target rule
  // as dropOnDockedLeaf).
  const existing = target.stack.map((g) => target.stackWeights?.[g] ?? 1);
  const meanTarget =
    existing.reduce((a, b) => a + b, 0) / Math.max(1, existing.length) || 1;
  const shareOf = (g: GroupId) => sourceShares?.[g] ?? 1;
  const meanShare =
    groupIds.reduce((s, g) => s + shareOf(g), 0) / groupIds.length || 1;
  const nextWeights = { ...(target.stackWeights ?? {}) };
  for (const g of groupIds)
    nextWeights[g] = (meanTarget * shareOf(g)) / meanShare;
  target.stackWeights = nextWeights;
  const i = clampIndex(index, target.stack.length);
  target.stack.splice(i, 0, ...groupIds);
  // Copy (don't alias) the source's height object: sourceHeight is read from the
  // original layout, so assigning it directly would share a reference between the
  // committed draft and the prior (immutable) state.
  if (target.height.mode === "auto" && sourceHeight?.mode === "pinned")
    target.height = { ...sourceHeight };
  // The user reshaped this window by snapping content into it -> it's now
  // user-owned; drop any server-requested coords so it isn't re-anchored against
  // its (now larger) size on the next canvas change.
  markWindowUserOwned(target);
  return draft;
}

/** Raise a floating window to the top of the paint order. */
export function bringToFront(
  layout: DockLayout,
  windowId: WindowId,
): DockLayout {
  const idx = layout.floating.findIndex((w) => w.id === windowId);
  if (idx === -1 || idx === layout.floating.length - 1) return layout;
  const draft = clone(layout);
  const [win] = draft.floating.splice(idx, 1);
  draft.floating.push(win);
  return draft;
}

/** Move `paneId` to `insertIndex` within its group's tab order. Returns the
 * input layout unchanged (same reference) when the order wouldn't change, so
 * callers can skip the re-render on no-op drag frames. */
export function reorderTab(
  layout: DockLayout,
  groupId: GroupId,
  paneId: PaneId,
  insertIndex: number,
): DockLayout {
  const group = layout.groups[groupId];
  if (group === undefined || !group.paneIds.includes(paneId)) return layout;
  const without = group.paneIds.filter((p) => p !== paneId);
  const clamped = clampIndex(insertIndex, without.length);
  without.splice(clamped, 0, paneId);
  const unchanged =
    without.length === group.paneIds.length &&
    without.every((p, i) => p === group.paneIds[i]);
  if (unchanged) return layout;
  const draft = clone(layout);
  draft.groups[groupId].paneIds = without;
  return draft;
}

/** Toggle the collapse state of the container holding `groupId` (D38):
 * collapse is one boolean per container, so the toggle resolves the group's
 * container and flips its flag -- a floating window's `collapsed`, or (for
 * docked groups) the containing column's railed flag (the one docked store,
 * D44/D46). The expand direction shares expandGroup's path
 * (expandGroupInPlace), which clears every container flag over the group. */
export function toggleCollapsed(
  layout: DockLayout,
  groupId: GroupId,
): DockLayout {
  if (layout.groups[groupId] === undefined) return layout;
  if (isGroupEffectivelyCollapsed(layout, groupId)) {
    const draft = clone(layout);
    return expandGroupInPlace(draft, groupId) ? draft : layout;
  }
  return collapseContainerOf(layout, groupId);
}

/** In-place core of "collapse the group's container" (the mirror of
 * expandGroupInPlace): floating -> the window's flag; docked -> the
 * containing column's railed flag (the one docked store, D46; for a sole
 * docked panel this is the packed region). Returns whether anything
 * changed. Shared by the UI toggle path and the server placement path
 * (D47) so the flag resolution cannot drift between them. */
function collapseContainerOfInPlace(
  draft: DockLayout,
  groupId: GroupId,
): boolean {
  const loc = findGroupLocation(draft, groupId);
  if (loc === null || loc.kind === "area") return false;
  if (loc.kind === "floating") {
    const win = draft.floating.find((w) => w.id === loc.windowId);
    if (win === undefined || win.collapsed === true) return false;
    win.collapsed = true;
    return true;
  }
  const found = findGroupInRegion(draft.docked[loc.edge], groupId);
  if (found === null || found.column.railed === true) return false;
  found.column.railed = true;
  return true;
}

/** Immutable wrapper over collapseContainerOfInPlace: same-reference
 * return when nothing changed (already collapsed / no collapsible
 * container). */
function collapseContainerOf(layout: DockLayout, groupId: GroupId): DockLayout {
  const draft = clone(layout);
  return collapseContainerOfInPlace(draft, groupId) ? draft : layout;
}

/** Rail every column of an edge's region (D44/D46): the region chevron's
 * op. The packed region rail is the derived result -- side-by-side 36px
 * strips, width reclaimed by the canvas. No-op on an empty or already
 * fully railed edge. */
export function railRegion(layout: DockLayout, edge: DockEdge): DockLayout {
  const region = layout.docked[edge];
  if (region === null || isRegionFullyRailed(region)) return layout;
  const draft = clone(layout);
  for (const column of draft.docked[edge]!.columns) column.railed = true;
  return draft;
}

/** The one entry point for legacy persisted layouts (both injection/restore
 * chokepoints call this): detects pre-D46 band shapes, the pre-D44
 * regionCollapsed flag, and the pre-always-px lone-column weight form, and
 * -- only when something is legacy -- clones and runs the migrations in
 * their required order (rows first: the flag applies to the migrated
 * columns; the lone-width adoption last: the earlier migrations can
 * produce the single-column shape it reads). Returns the input untouched
 * when the layout is current-format, so modern layouts pay cheap property
 * checks. */
export function migrateLegacyLayout(layout: DockLayout): DockLayout {
  const legacy =
    layout.regionCollapsed !== undefined ||
    (["left", "right"] as DockEdge[]).some(
      (e) =>
        layout.docked[e] !== null &&
        (layout.docked[e] as { rows?: unknown }).rows !== undefined,
    );
  if (!legacy) return layout;
  const migrated = structuredClone(layout);
  migrateRowsToColumnsInPlace(migrated);
  migrateRegionCollapsedInPlace(migrated);
  return migrated;
}
// (Pre-always-px lone-column WEIGHTS need no migration leg: both
// chokepoints reconcile, and reconciliation's new-column carry adopts a
// legacy regionWidth into the weight -- expanded and railed alike.)

/** Migration (D46): regions persisted before the columns-only model carry
 * the legacy `{rows: [...]}` band shape. Convert each region in place:
 * every band's columns concatenate left-to-right in band order --
 * multi-column bands map 1:1; consecutive single-column bands' columns
 * line up side by side (their old vertical stacking has no cross-column
 * expression, so each becomes its own column; a plain stack that was one
 * multi-leaf column already maps exactly). Weights carry over as-is;
 * reconciliation re-establishes px on the first commit. Also strips the
 * legacy per-band level from any nested literals. No-op for current
 * layouts. */
export function migrateRowsToColumnsInPlace(layout: DockLayout): void {
  for (const edge of ["left", "right"] as DockEdge[]) {
    const region = layout.docked[edge] as
      | (DockRegion & {
          rows?: { columns: DockColumn[]; weight: number }[];
        })
      | null;
    if (region === null || region.rows === undefined) continue;
    const bands = region.rows;
    // The band-era canonical form (D12) stored every expanded plain stack
    // as consecutive single-column bands -- so that shape's faithful D46
    // picture is one multi-leaf column (a stack), not side-by-side
    // columns. Band weights were the stack's height shares; carry them
    // onto the leaves (rescaled within each band so multi-leaf bands keep
    // their internal ratios). The column rails only when every band was
    // railed (partial stack collapse is unrepresentable, D38).
    const allSingle = bands.every((b) => b.columns.length === 1);
    if (allSingle && bands.length > 0) {
      const leaves: DockLeaf[] = bands.flatMap((b) => {
        const col = b.columns[0];
        const innerTotal = col.leaves.reduce((s, l) => s + l.weight, 0) || 1;
        return col.leaves.map((l) => ({
          ...l,
          weight: (b.weight * l.weight) / innerTotal,
        }));
      });
      const ne = asNonEmpty(leaves);
      if (ne !== null) {
        region.columns = [
          {
            id: bands[0].columns[0].id,
            weight: 1,
            leaves: ne,
            ...(bands.every((b) => b.columns[0].railed === true)
              ? { railed: true as const }
              : {}),
          },
        ];
      }
    } else {
      // Mixed/multi-column bands have no faithful D46 shape ([A] over
      // [B][C] is unrepresentable): best-effort fallback, columns
      // left-to-right in band order. Their px weights came from unrelated
      // per-band scales -- rescale the expanded ones so the region's
      // remembered width survives (leaving them raw let the first
      // sameSet reconciliation pin regionWidth to a nonsense sum).
      const columns = bands.flatMap((band) => band.columns);
      const rw = layout.regionWidth?.[edge];
      const railedPx =
        columns.filter((c) => c.railed === true).length * MINIMIZED_STRIP_PX;
      const expanded = columns.filter((c) => c.railed !== true);
      const expandedSum = expanded.reduce((s, c) => s + c.weight, 0);
      if (rw !== undefined && rw > railedPx && expandedSum > 0) {
        const scale = (rw - railedPx) / expandedSum;
        expanded.forEach((c) => {
          c.weight *= scale;
        });
      }
      const ne = asNonEmpty(columns);
      if (ne !== null) region.columns = ne;
    }
    delete region.rows;
    if (region.columns === undefined) layout.docked[edge] = null;
  }
}

/** Migration (D44): layouts persisted before the region-collapse store was
 * unified into per-column rails may still carry `regionCollapsed`. Convert
 * a set flag into railed flags on every column of that edge and drop the
 * field -- called at the injection/restore chokepoints (api.replace,
 * persistence load, test probes). Runs after migrateRowsToColumnsInPlace
 * (the flag applies to the migrated columns). */
export function migrateRegionCollapsedInPlace(layout: DockLayout): void {
  const legacy = layout.regionCollapsed;
  if (legacy === undefined) return;
  for (const edge of ["left", "right"] as DockEdge[]) {
    const region = layout.docked[edge];
    if (legacy[edge] !== true || region === null) continue;
    for (const column of region.columns) column.railed = true;
  }
  delete layout.regionCollapsed;
}

/** Set a column's railed flag: while set, the column renders as a 36px spine
 * strip in place; its width weight is preserved for restore (P8). The one
 * docked collapse store (D44/D46) -- the column-collapse chevron's op.
 * Setting or clearing on a missing column is a no-op, as is a value that
 * already matches.
 *
 * Any column may rail (D46: columns are the region's only partition, so a
 * lone rail beside expanded siblings is legal committed geometry and the op
 * needs no gate). Railing NEVER touches siblings (no accordion -- D43 was
 * retired by D46, so P3 has no exceptions). Scope routing (window flag vs
 * column flag) is the caller's job: collapseContainerOf picks the store;
 * this op sets exactly the flag it is named for. */
export function setColumnRailed(
  layout: DockLayout,
  edge: DockEdge,
  columnId: NodeId,
  on: boolean,
): DockLayout {
  const found = findColumn(layout.docked[edge], columnId);
  if (found === null || (found.column.railed === true) === on) return layout;
  const draft = clone(layout);
  const column = findColumn(draft.docked[edge], columnId)!.column;
  if (on) column.railed = true;
  else delete column.railed;
  return draft;
}

/** Clear the railed flag of the docked column holding `groupId` (if any), in
 * place -- the docked expand path (the one docked collapse store): expanding
 * a panel from a rail must reveal it (P5/P6), so every expand path routes
 * through this via expandGroupInPlace. Granular by design: only the
 * containing column expands (a packed region's other rails stay railed --
 * user-adjudicated). Returns whether a flag was actually cleared. */
function clearColumnRailedForGroupInPlace(
  draft: DockLayout,
  groupId: GroupId,
): boolean {
  for (const edge of ["left", "right"] as DockEdge[]) {
    const found = findGroupInRegion(draft.docked[edge], groupId);
    if (found === null) continue;
    if (found.column.railed !== true) return false;
    delete found.column.railed;
    return true;
  }
  return false;
}

/** Clear the `collapsed` flag of the floating window holding `groupId` (if
 * any), in place -- the floating mirror of the docked clear above: every
 * expand path routes through this via expandGroupInPlace, so a bar's expand
 * affordances all clear the window's one flag (D38). Returns whether a flag
 * was actually cleared. */
function clearWindowCollapsedForGroupInPlace(
  draft: DockLayout,
  groupId: GroupId,
): boolean {
  const win = draft.floating.find((w) => w.stack.includes(groupId));
  if (win === undefined || win.collapsed !== true) return false;
  delete win.collapsed;
  return true;
}

/** Expand `groupId`'s container in place (D38): clear its floating window's
 * collapsed flag or its containing column's railed flag. Shared by
 * expandGroup and toggleCollapsed's expand direction, so every expand path
 * (toggle, expand-to-tab, bar/rail expand) reveals the panel. Returns
 * whether anything changed. */
function expandGroupInPlace(draft: DockLayout, groupId: GroupId): boolean {
  let changed = false;
  if (clearWindowCollapsedForGroupInPlace(draft, groupId)) changed = true;
  if (clearColumnRailedForGroupInPlace(draft, groupId)) changed = true;
  return changed;
}

/** Expand the container holding `groupId` (D38): clears the floating
 * window's / containing column's collapse flag, whichever applies. No-op
 * when nothing is collapsed over the group (or the group is unknown). */
export function expandGroup(layout: DockLayout, groupId: GroupId): DockLayout {
  if (layout.groups[groupId] === undefined) return layout;
  const draft = clone(layout);
  return expandGroupInPlace(draft, groupId) ? draft : layout;
}

/** Minimize a whole stack -- the stack handle's minimize toggle. Under D38
 * this is just "collapse the container of the stack's groups": the caller
 * passes a window's stack or a docked column's leaf groups, and the shared
 * container resolution sets that one flag. No-op when already collapsed. */
export function minimizeStack(
  layout: DockLayout,
  groupIds: GroupId[],
): DockLayout {
  const first = groupIds[0];
  if (first === undefined || layout.groups[first] === undefined) return layout;
  if (isGroupEffectivelyCollapsed(layout, first)) return layout;
  return collapseContainerOf(layout, first);
}

/** Expand a whole stack -- the inverse of minimizeStack: clears the
 * container's one flag (D38). */
export function expandStack(
  layout: DockLayout,
  groupIds: GroupId[],
): DockLayout {
  const first = groupIds[0];
  if (first === undefined) return layout;
  return expandGroup(layout, first);
}

/** Expand the whole stack containing `groupId`. Under D38 this is exactly
 * expandGroup -- collapse lives on the container, so clearing its one flag
 * reveals the whole stack. Kept as its own export because chrome
 * distinguishes "expand the stack I'm in" (a stacked bar's affordances) from
 * per-panel expands at call sites. No-op (same reference) when nothing
 * changes. */
export function expandStackOf(
  layout: DockLayout,
  groupId: GroupId,
): DockLayout {
  // The docked stack scope is the containing column (D46), which is what
  // expandGroup's container clear targets; floating routes there too.
  return expandGroup(layout, groupId);
}

/** Per-frame region-resize commit: write the drag's redistributed column
 * px AND the region's rendered-need width in ONE draft (the split
 * setNodeWeights -> setRegionWidth sequence deep-cloned twice per pointer
 * frame, and the second op's redistribution was an identity pass over
 * just-written weights). Same fast path as setNodeWeights: no clone when
 * the cursor paused. */
export function commitRegionResize(
  layout: DockLayout,
  edge: DockEdge,
  weightsById: Record<NodeId, number>,
  totalPx: number,
): DockLayout {
  const next = setNodeWeights(layout, edge, weightsById);
  if (next === layout && regionWidthsOf(layout)[edge] === totalPx)
    return layout;
  // setNodeWeights cloned (or nothing changed but the width did -- clone
  // now); either way regionWidth is written on OUR draft, no second clone.
  const draft = next === layout ? clone(layout) : next;
  draft.regionWidth = { ...regionWidthsOf(draft), [edge]: totalPx };
  return draft;
}

/** Set node weights by node id (a leaf's or a column's) within a docked region.
 * Callers pass {nodeId: weight} for the nodes they resized -- a region-row drag
 * targets columns, a column-stack drag targets leaves -- and we write them onto
 * the matching real nodes. */
export function setNodeWeights(
  layout: DockLayout,
  edge: DockEdge,
  weightsById: Record<NodeId, number>,
): DockLayout {
  const region = layout.docked[edge];
  if (region === null) return layout;
  const wantsChange = (id: NodeId, current: number): boolean => {
    const w = weightsById[id];
    return w !== undefined && Number.isFinite(w) && w > 0 && current !== w;
  };
  // Fast path for the per-frame resize hot path: when every target weight
  // already matches (the cursor paused), skip the clone entirely. Targets
  // can be columns (region drag) or leaves (column-stack drag).
  let changes = false;
  for (const column of region.columns) {
    if (wantsChange(column.id, column.weight)) changes = true;
    for (const leaf of column.leaves)
      if (wantsChange(leaf.id, leaf.weight)) changes = true;
  }
  if (!changes) return layout;
  const draft = clone(layout);
  const set = (id: NodeId): number | undefined => {
    const w = weightsById[id];
    return w !== undefined && Number.isFinite(w) && w > 0 ? w : undefined;
  };
  for (const column of draft.docked[edge]!.columns) {
    const cw = set(column.id);
    if (cw !== undefined) column.weight = cw;
    for (const leaf of column.leaves) {
      const lw = set(leaf.id);
      if (lw !== undefined) leaf.weight = lw;
    }
  }
  return draft;
}

/** Set an edge's region width (px) directly -- the region resizer's and the
 * server set_width's write path. The value becomes the carry-over base for
 * width reconciliation on commit (which still enforces its min/max
 * invariants).
 *
 * D40: regionWidth is the width row's rendered need whenever that row holds
 * an expanded column, so a bare width write must land in the expanded
 * width-row weights too -- otherwise reconciliation would re-derive the old
 * sum and snap the width straight back. The redistribution mirrors the
 * region resizer's (proportional from current widths, clamped per column):
 * railed columns keep their P8 restore weights untouched (they render the
 * fixed 36px strip), and the committed width is what the weights actually
 * absorbed -- for EVERY expanded column, a lone one included (weights are
 * always reconciled px). A fully-railed region carries the width as the
 * region's content need until reconciliation pins it back to the rails'
 * pack width. */
export function setRegionWidth(
  layout: DockLayout,
  edge: DockEdge,
  px: number,
): DockLayout {
  if (!Number.isFinite(px) || regionWidthsOf(layout)[edge] === px)
    return layout;
  const draft = clone(layout);
  const region = draft.docked[edge];
  if (region !== null) {
    const cols = region.columns;
    const expanded = cols.filter((c) => c.railed !== true);
    const railedPx = (cols.length - expanded.length) * MINIMIZED_STRIP_PX;
    const expandedSum = expanded.reduce((s, c) => s + c.weight, 0);
    // Weights already at the target and at/above their floor (the
    // region-resize drag distributes clamped px per frame before
    // committing through here): skip the redundant redistribution -- it
    // would be an identity rewrite. The floor check keeps the op's
    // postcondition caller-independent (a caller with matching total but
    // a sub-min column still gets the clamp).
    const alreadyDistributed =
      Math.abs(expandedSum - (px - railedPx)) < 0.5 &&
      expanded.every((c) => c.weight >= minRegionWidth());
    if (expanded.length > 0) {
      if (alreadyDistributed) {
        px = railedPx + expandedSum;
      } else {
        const widths = resizeRegionColumns(
          expanded.map((c) => c.weight),
          expanded.map(() => minRegionWidth()),
          expanded.map(() => Infinity),
          px - railedPx,
        );
        expanded.forEach((c, i) => {
          c.weight = widths[i];
        });
        px = railedPx + widths.reduce((a, b) => a + b, 0);
      }
    } else if (cols.length > 0) {
      // Fully railed: the width can't render now (rails pack at the fixed
      // strip width), so land the px in the columns' P8 restore weights --
      // expanding later restores at the commanded width, and a late joiner
      // replaying width-then-collapse converges to the same state (§8 replay
      // parity). Without this the command is silently discarded: commit-time
      // reconciliation re-pins regionWidth to the rails' pack width.
      const widths = resizeRegionColumns(
        cols.map((c) => c.weight),
        cols.map(() => minRegionWidth()),
        cols.map(() => Infinity),
        px,
      );
      cols.forEach((c, i) => {
        c.weight = widths[i];
      });
      px = railedPx;
    }
  }
  draft.regionWidth = { ...regionWidthsOf(layout), [edge]: px };
  return draft;
}

/** Activate a tab within a group. */
export function setActiveTab(
  layout: DockLayout,
  groupId: GroupId,
  paneId: PaneId,
): DockLayout {
  const draft = clone(layout);
  const group = draft.groups[groupId];
  if (group === undefined || !group.paneIds.includes(paneId)) return layout;
  group.activeId = paneId;
  return draft;
}

// ---------------------------------------------------------------------------
// Standalone panels (server-authored placement).
//
// A standalone panel (from Python `server.gui.add_panel()`) is a tab group that
// lives as its own top-level dock group rather than nested in the control panel.
// The server sends a coalesced `placement` describing where it should go; the
// ops below seed and re-apply that placement. After the initial placement the
// user may drag the panel anywhere -- a later server placement command
// repositions it again (imperative, not continuous sync).
// ---------------------------------------------------------------------------

/** A panel's requested position, structurally identical to the wire shape
 * (EdgePlacement | SplitPlacement | FloatPlacement in _messages.py /
 * GuiSetPanelPositionMessage). Defined here rather than imported from
 * WebsocketMessages so the dock library keeps no dependency on the viser wire
 * protocol (the sync layer's message payloads are structurally compatible and
 * flow in without conversion). */
export type PanelPosition =
  | { kind: "edge"; edge: DockEdge }
  | { kind: "split"; anchor_uuid: string; side: "above" | "below" }
  | { kind: "float"; x: number | null; y: number | null };

/** The placement state the dock applies to a panel: a per-axis bundle the
 * caller assembles from the client-owned placement store. Each axis is
 * independent and applied only when present -- a set_width carries no
 * position, so applying width can never re-dock a panel.
 *
 * Width/height are tri-state: a number applies that size, `undefined` means
 * the axis is absent / gated off ("don't touch"), and `null` is a fresh CLEAR
 * -- the server's width/height `None`, reverting the override to its default
 * (auto height; default/theme width). Position and collapsed have no clear
 * form on the wire, so for them `null` simply means "absent". */
export interface PanelPlacement {
  position: PanelPosition | null;
  width?: number | null;
  height?: number | null;
  collapsed: boolean | null;
}

/** Default float geometry when the server leaves x/y/size unspecified: the
 * top-left corner of the canvas (inset by the same PANEL_PAD_PX pad the
 * control panel floats with). `float()` with no coords lands here. */
const DEFAULT_FLOAT_X = PANEL_PAD_PX;
const DEFAULT_FLOAT_Y = PANEL_PAD_PX;
const DEFAULT_FLOAT_WIDTH = 300;

/** The canvas geometry needed to resolve a (possibly negative) requested float
 * position into an absolute, parent-relative window position. */
export interface CanvasBounds {
  /** Full dock-root width / height in px. */
  width: number;
  height: number;
  /** Docked-region insets (the canvas is the area between them). */
  leftInset: number;
  rightInset: number;
}

/** Resolve a server-requested float coordinate pair (canvas-relative, possibly
 * negative) into an absolute parent-relative window position, given the window's
 * rendered size and the canvas bounds. Semantics:
 * - x >= 0: `leftInset + x` (x px from the canvas left boundary).
 * - x <  0: right edge `|x|`px from the canvas right boundary, i.e.
 *   `(width - rightInset) - winWidth + x`.
 * - y >= 0: `y` (from the top).
 * - y <  0: bottom edge `|y|`px from the bottom, i.e. `height - winHeight + y`.
 * When the canvas is measured (width/height > 0), the result is clamped to keep
 * the window's top-left within it (a window larger than the canvas pins to the
 * canvas left/top). When the canvas isn't measured yet (width/height 0, e.g. a
 * first apply before layout), a negative coord can't be resolved against a
 * missing far edge, so it falls back to the canvas-left/top (positive raw values
 * pass through unclamped); the post-render effect re-resolves once measured. */
export function resolveRequestedFloatPosition(
  anchorX: number,
  anchorY: number,
  winWidth: number,
  winHeight: number,
  bounds: CanvasBounds,
): { x: number; y: number } {
  const canvasRight = bounds.width - bounds.rightInset;
  // A negative coord is a gap from the far edge -- but that needs a measured
  // canvas. When unmeasured (width/height 0, e.g. the first apply before
  // layout), fall back to the near edge (left/top) so the window isn't placed
  // off-screen; the post-render effect re-resolves once the canvas is measured.
  let x: number;
  if (anchorX < 0) {
    x = bounds.width > 0 ? canvasRight - winWidth + anchorX : bounds.leftInset;
  } else {
    x = bounds.leftInset + anchorX;
  }
  let y: number;
  if (anchorY < 0) {
    y = bounds.height > 0 ? bounds.height - winHeight + anchorY : 0;
  } else {
    y = anchorY;
  }
  // Clamp against a measured canvas (a too-big window pins to the near edge); an
  // unmeasured canvas can't clamp meaningfully.
  if (bounds.width > 0) {
    x = clamp(
      x,
      bounds.leftInset,
      Math.max(bounds.leftInset, canvasRight - winWidth),
    );
  }
  if (bounds.height > 0) {
    y = clamp(y, 0, Math.max(0, bounds.height - winHeight));
  }
  return { x, y };
}

/** Find the group whose paneIds are exactly this panel's panes (the standalone
 * panel's own group), or null if its panes aren't yet grouped together. We key
 * off the first pane: a standalone panel always owns its panes, so whatever
 * group holds the first pane is the panel's group. */
function panelGroupOf(layout: DockLayout, paneIds: PaneId[]): GroupId | null {
  if (paneIds.length === 0) return null;
  return findPaneGroup(layout, paneIds[0]);
}

/** Reconcile a panel group's membership against the server's pane list, in
 * place, preserving the user's existing tab order for panes that remain. Panes
 * the server added are appended (in server order); panes in `removedPaneIds`
 * (tabs the server explicitly removed from this panel) are dropped; `activeId`
 * is kept unless it was removed. Does not reorder existing panes to match the
 * server (the user may have reordered tabs locally), and does not drop panes it
 * doesn't recognize: the group may also hold foreign panes the user merged in
 * from another panel, and filtering to the server's list would silently orphan
 * them (they'd render nowhere until reconnect). */
function reconcileMembershipInPlace(
  draft: DockLayout,
  group: TabGroup,
  paneIds: PaneId[],
  removedPaneIds: ReadonlySet<PaneId>,
): void {
  const wanted = new Set(paneIds);
  // Keep current panes that are still wanted or weren't explicitly removed
  // (preserves user order + foreign merges), then append newly-added server
  // panes not placed ANYWHERE yet (in server order). The placed check matters:
  // a pane the user dragged OUT of this panel lives in another group, and
  // appending it here would duplicate it into two groups (invariant #4) --
  // membership reconciliation deliberately never relocates user-moved panes
  // (that is applyMembership's job, via the detach-first move primitive).
  const kept = group.paneIds.filter(
    (p) => wanted.has(p) || !removedPaneIds.has(p),
  );
  const added = paneIds.filter(
    (p) => !group.paneIds.includes(p) && findPaneGroup(draft, p) === null,
  );
  group.paneIds = [...kept, ...added];
  if (
    group.paneIds.length > 0 &&
    (group.activeId === null || !group.paneIds.includes(group.activeId))
  ) {
    group.activeId = group.paneIds[0];
  }
}

/** Ensure this panel's panes live together in a single group, returning that
 * group's id. Creates the group (expanded) if the panes aren't placed yet; if
 * they're already grouped, reuses it and reconciles membership. */
function ensurePanelGroup(
  draft: DockLayout,
  paneIds: PaneId[],
): GroupId | null {
  const nePaneIds = asNonEmpty(paneIds);
  if (nePaneIds === null) return null;
  let groupId = panelGroupOf(draft, paneIds);
  if (groupId === null) {
    const group = makeGroup(nePaneIds);
    draft.groups[group.id] = group;
    groupId = group.id;
  } else {
    applyMembership(draft, groupId, paneIds);
  }
  return groupId;
}

/** Re-assemble a panel's panes into its existing group and reconcile its
 * membership in place (the reuse branch of ensurePanelGroup). */
function applyMembership(
  draft: DockLayout,
  groupId: GroupId,
  paneIds: PaneId[],
): void {
  // A placement command re-assembles the whole panel into its home group. Any
  // pane the user dragged out into another group/window is moved back here via
  // the single move primitive (detach-then-insert), so a pane can't be left in
  // two places. reconcileMembershipInPlace then fixes order/activeId. A
  // placement command knows nothing about tab removals (that's the membership
  // reconcile's job), so it passes an empty removed set -- and foreign panes
  // the user merged in ride along with the relocated group.
  for (const paneId of paneIds) movePaneInPlace(draft, paneId, groupId);
  reconcileMembershipInPlace(draft, draft.groups[groupId], paneIds, new Set());
}

/** Reconcile a standalone panel's group membership (tabs added/removed) without
 * repositioning it. Used on tab-list changes so a user-moved panel isn't yanked
 * back to its server placement just because a tab was added. `removedPaneIds`
 * are the tabs the server removed since the last reconcile -- only those are
 * dropped from the group (a foreign pane the user merged in stays). No-op until
 * the panel's group exists (placement creates it). */
export function reconcilePanelMembership(
  layout: DockLayout,
  paneIds: PaneId[],
  removedPaneIds: readonly PaneId[],
): DockLayout {
  if (paneIds.length === 0) return layout;
  const groupId = panelGroupOf(layout, paneIds);
  if (groupId === null) return layout;
  const draft = clone(layout);
  reconcileMembershipInPlace(
    draft,
    draft.groups[groupId],
    paneIds,
    new Set(removedPaneIds),
  );
  return draft;
}

/** Resolve an anchor panel uuid to its current docked leaf, so a split can be
 * placed against it. Returns null when the anchor isn't docked (e.g. floating,
 * or not yet placed) -- the caller falls back to a plain edge dock. */
function resolveAnchorLeaf(
  layout: DockLayout,
  anchorGroupId: GroupId,
): { edge: DockEdge; nodeId: NodeId } | null {
  const loc = findGroupLocation(layout, anchorGroupId);
  if (loc === null || loc.kind !== "docked") return null;
  return { edge: loc.edge, nodeId: loc.nodeId };
}

/** Apply the client-owned `placement` bundle to a panel, (re)positioning it.
 *
 * `paneIds` are the panel's tabs (its container ids), `anchorGroupOf` maps an
 * anchor panel uuid to its current group id (the caller knows how to resolve
 * both standalone panels and the control panel).
 *
 * Each field of `placement` is the latest value the server wrote, and is always
 * applied when present -- there is no before/after gating. Because the
 * write-only commands are independent (a set_width carries no position), applying
 * any single field can never re-dock a panel: a position re-docks/re-floats only
 * when `position != null`, and that only happens when the server actually sent a
 * position command. A present width/height may also be a CLEAR (null; see the
 * PanelPlacement tri-state note). The caller's per-command dedup
 * (appliedPlacementKey) keeps an unrelated re-render from re-applying the same
 * bundle.
 *
 * Options:
 * - `floatIfUnplaced` (default true): when the placement has no position AND the
 *   panel isn't placed yet, float it at the default so a bare `add_panel()` is
 *   visible. Pass false for the control panel, which is placed separately.
 * - `canvasBounds`: canvas size + docked insets, used to resolve a float's
 *   (possibly negative) requested coords into an absolute position. Server float
 *   coords are canvas-relative (and negatives are gaps from the far edge); the
 *   requested values are also stashed on the window so the position re-resolves
 *   as the canvas changes (see resolveRequestedFloatPosition + the DockManager
 *   effect). Defaults to a zero-inset canvas if omitted.
 */
export function applyPanelPlacement(
  layout: DockLayout,
  paneIds: PaneId[],
  placement: PanelPlacement,
  anchorGroupOf: (uuid: string) => GroupId | null,
  opts: {
    floatIfUnplaced?: boolean;
    canvasBounds?: CanvasBounds;
  } = {},
): DockLayout {
  const floatIfUnplaced = opts.floatIfUnplaced ?? true;
  const bounds: CanvasBounds = opts.canvasBounds ?? {
    width: 0,
    height: 0,
    leftInset: 0,
    rightInset: 0,
  };
  if (paneIds.length === 0) return layout;
  // Whether the panel already had a group before this op (used by the orphan
  // guard at the end: a group we created must not outlive the op unattached).
  const groupExistedBefore = panelGroupOf(layout, paneIds) !== null;
  let draft = clone(layout);
  const groupId = ensurePanelGroup(draft, paneIds);
  if (groupId === null) return layout;

  // Float a group at the given requested coords: record them on the window (so
  // the position re-resolves on canvas changes) and set an initial absolute
  // position from the current bounds + window size.
  //
  // If the group is already the sole occupant of a floating window, reuse that
  // window (preserving its id and z-order, and touching only the size axes
  // present in this bundle). A fresh float (group docked or unplaced) makes a
  // new window as before. Note size-only bundles never reach this function --
  // a no-position bundle only floats a still-UNPLACED group (see the
  // floatIfUnplaced branch below) -- so every call here carries an explicit
  // position command, and the position always applies (§8/D52: a fresh command
  // applies to touched and untouched panels alike; protecting a user-dragged
  // window from STALE positions is the gate's job, not this function's).
  const floatAtRequested = (reqX: number, reqY: number): void => {
    const loc = findGroupLocation(draft, groupId);
    const reusable =
      loc?.kind === "floating"
        ? draft.floating.find((w) => w.id === loc.windowId)
        : undefined;
    let win: FloatingWindow | undefined;
    // Reuse only a solo window (this group is its whole stack) -- a multi-group
    // stack must keep its other groups, so re-float into a fresh window.
    if (reusable !== undefined && reusable.stack.length === 1) {
      win = reusable;
      // Per-axis contract (§8): a position-only float() must not disturb the
      // size axes. Only axes PRESENT in this bundle touch the reused window --
      // an absent/gated-off width or height leaves the user's size alone. A
      // fresh height CLEAR (null) returns the window to auto-height.
      if (placement.width != null) win.width = placement.width;
      if (placement.height !== undefined)
        win.height = windowHeight(placement.height ?? undefined);
    } else {
      const result = floatGroup(
        draft,
        groupId,
        reqX,
        reqY,
        placement.width ?? DEFAULT_FLOAT_WIDTH,
        placement.height ?? undefined,
      );
      draft = result.layout;
      if (result.windowId === null) return;
      win = draft.floating.find((w) => w.id === result.windowId);
      if (win === undefined) return;
    }
    // A position command means "float HERE": always (re)anchor and resolve
    // against the live canvas, including for a window the user has dragged
    // (its anchor was cleared) -- the gate already decided this command is
    // fresh, and a fresh float(x, y) applies unconditionally (§8/D52).
    win.anchor = { x: reqX, y: reqY };
    const resolved = resolveRequestedFloatPosition(
      reqX,
      reqY,
      win.width,
      pinnedPxOf(win.height) ?? 0,
      bounds,
    );
    win.x = resolved.x;
    win.y = resolved.y;
  };

  const position = placement.position;
  if (position === null) {
    // No explicit position. If the panel isn't placed anywhere yet, float it at
    // the default so a freshly-created `add_panel()` (no placement verb called)
    // is still visible rather than an orphaned group rendered nowhere. A panel
    // the user already moved is left alone. `floatIfUnplaced` is opt-in so the
    // control panel (placed separately by ControlPanelDockSync) isn't affected.
    if (floatIfUnplaced && findGroupLocation(draft, groupId) === null) {
      floatAtRequested(DEFAULT_FLOAT_X, DEFAULT_FLOAT_Y);
    }
  } else {
    if (position.kind === "edge") {
      const loc = findGroupLocation(draft, groupId);
      // Always dock to the requested edge (a position command means "dock here").
      // Skip only the redundant re-dock when the group is already docked on this
      // edge: re-docking would detach + recreate the leaf with a fresh node id,
      // which makes the width reconciler treat it as a new column and reset its
      // width to the default (and needlessly reorder a multi-panel region).
      // Leaving it in place keeps the column id stable.
      const alreadyHere = loc?.kind === "docked" && loc.edge === position.edge;
      if (!alreadyHere) draft = dockToEdge(draft, [groupId], position.edge);
    } else if (position.kind === "float") {
      // Canvas-relative coords; negatives are gaps from the far edge. Resolved
      // against the live canvas + window size (and re-resolved on canvas changes
      // via the stored anchor).
      floatAtRequested(
        position.x ?? DEFAULT_FLOAT_X,
        position.y ?? DEFAULT_FLOAT_Y,
      );
    } else if (position.kind === "split") {
      // Split: dock above/below the anchor's docked leaf. Fall back to a right
      // edge dock when the anchor isn't docked (floating / not yet placed).
      const anchorGroupId = anchorGroupOf(position.anchor_uuid);
      const leaf =
        anchorGroupId === null ? null : resolveAnchorLeaf(draft, anchorGroupId);
      if (leaf === null) {
        // The dock model can only split against a docked anchor; the anchor here
        // is floating, not yet placed, or gone. Surface it (a silent fallback
        // reads as "dock_above/below did nothing sensible") and fall back to a
        // right-edge dock so the panel is at least visible.
        console.warn(
          `[viser] dock_above/dock_below: anchor "${position.anchor_uuid}" is not ` +
            `docked, so the panel can't split against it. Falling back to the ` +
            `right edge. Dock the anchor first (only docked panels are valid ` +
            `split anchors).`,
        );
        draft = dockToEdge(draft, [groupId], "right");
      } else {
        const region: DropRegion = position.side === "above" ? "top" : "bottom";
        draft = dropOnDockedLeaf(
          draft,
          [groupId],
          leaf.edge,
          leaf.nodeId,
          region,
        );
      }
    } else {
      // Compile-time exhaustiveness over the wire union (a new placement kind
      // must be handled here, not silently routed into the last branch) -- but
      // wire data from a newer server can genuinely carry an unknown kind at
      // runtime, so warn and leave the panel where it is instead of throwing.
      const _exhaustive: never = position;
      console.warn(
        `[viser] Unknown panel position kind; ignoring placement:`,
        _exhaustive,
      );
    }
  }

  // Size: width is region width when docked / window width when floating; height
  // only applies to a floating window. Neither op relocates the group, so one
  // location lookup serves both. A height CLEAR (null) reverts a pinned window
  // to auto-height; a width clear is a dock-level no-op (there is no stored
  // "default width" here -- the control panel's theme-default width is applied
  // by ControlPanelDock's own width effect).
  if (placement.width != null || placement.height !== undefined) {
    const loc = findGroupLocation(draft, groupId);
    if (loc?.kind === "docked" && placement.width != null) {
      draft = setRegionWidth(draft, loc.edge, placement.width);
    } else if (loc?.kind === "floating") {
      if (placement.width != null) {
        draft = resizeWindow(draft, loc.windowId, placement.width);
      }
      if (placement.height !== undefined) {
        draft = resizeWindowHeight(
          draft,
          loc.windowId,
          placement.height ?? undefined,
        );
      }
    }
  }

  // An orphan group must be uncommittable from this op: if nothing above
  // attached the group we created (no position + floatIfUnplaced disabled, or
  // an unknown wire position kind), committing the draft would violate the
  // no-orphans invariant -- and worse, findPaneGroup would report the panel
  // "placed" off the orphan, wedging callers' dedup with a panel rendered
  // nowhere. No attach + freshly-created group => the whole op is a no-op.
  if (!groupExistedBefore && findGroupLocation(draft, groupId) === null)
    return layout;

  // Collapsed axis (D47), applied after position so it acts on the panel's
  // final container: a collapse rails the destination column / collapses
  // the destination window (never the departing one), and an expand routes
  // through expandGroupInPlace, which also clears the destination's rail
  // flags (a server expand is always visible, never hidden behind a rail).
  // Collapse is container state (D38): panels stacked with this one ride
  // along, exactly like the on-screen minimize control.
  if (placement.collapsed === true) {
    collapseContainerOfInPlace(draft, groupId);
  } else if (placement.collapsed === false) {
    expandGroupInPlace(draft, groupId);
  }

  return draft;
}
