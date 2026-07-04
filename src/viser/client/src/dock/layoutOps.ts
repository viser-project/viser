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
  DockRow,
  DropRegion,
  FloatingWindow,
  GroupId,
  GroupLocation,
  isRegionCollapsedOn,
  mapNonEmpty,
  MIN_REGION_GRAB_PX,
  MIN_WINDOW_HEIGHT_PX,
  NodeId,
  NonEmpty,
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
// deriving a columns/leaves list we re-assert non-emptiness in ONE place before
// assigning it back to a NonEmpty field. The "what to do when it IS empty"
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

/** Public deep-clone of a layout, for the rare caller OUTSIDE the ops that must
 * hand a modified layout to applyOp: applyOp's normalize/reconcile steps
 * mutate their input in place, so a shallow `{ ...layout, field }` copy would
 * alias groups/docked with the COMMITTED layout and let those steps corrupt it
 * (Escape-restore snapshots, onCommit diffing). */
export const cloneLayout = (layout: DockLayout): DockLayout => clone(layout);

/** Every id in a layout (groups, nodes, windows, areas). Used to seed the
 * fresh-id counter past a restored layout's ids. */
export function* allLayoutIds(layout: DockLayout): Iterable<string> {
  yield* Object.keys(layout.groups);
  for (const edge of ["left", "right"] as DockEdge[]) {
    const region = layout.docked[edge];
    if (region === null) continue;
    for (const row of region.rows) {
      yield row.id;
      for (const column of row.columns) {
        yield column.id;
        for (const l of column.leaves) yield l.id;
      }
    }
  }
  for (const w of layout.floating) yield w.id;
  yield* Object.keys(layout.areas ?? {});
}

// ---------------------------------------------------------------------------
// Flat-model accessors + structural helpers.
//
// The docked shape is fixed at FOUR levels (Region = column of rows; Row = row
// of columns; Column = stack of leaves; Leaf = one tab group), so what used to
// be recursive tree walks are trivial array lookups. Removal helpers maintain
// the invariant by re-wrapping: drop an emptied column from its row, drop an
// emptied row from the region, null an emptied region.
// ---------------------------------------------------------------------------

/** Every column in a region, flattened across its rows, in render order
 * (row-major: top band's columns first). The common building block for code
 * that doesn't care which band a column is in. */
export function allColumns(region: DockRegion): DockColumn[] {
  return region.rows.flatMap((r) => r.columns);
}

/** Locate the leaf holding `groupId` within a region. Null when the region is
 * empty or doesn't hold the group. */
function findGroupInRegion(
  region: DockRegion | null,
  groupId: GroupId,
): { column: DockColumn; leaf: DockLeaf } | null {
  if (region === null) return null;
  for (const column of allColumns(region)) {
    for (const leaf of column.leaves) {
      if (leaf.group === groupId) return { column, leaf };
    }
  }
  return null;
}

/** Remove the leaf holding `groupId` from a region. Drops the leaf from its
 * column; drops the column if it emptied; drops the row if IT emptied; returns
 * null if the whole region emptied. Weights are preserved on the survivors so
 * the region's proportions don't jump. */
function regionRemoveGroup(
  region: DockRegion,
  groupId: GroupId,
): DockRegion | null {
  const rows: DockRow[] = [];
  for (const row of region.rows) {
    const columns: DockColumn[] = [];
    let columnChanged = false;
    for (const column of row.columns) {
      const leaves = column.leaves.filter((l) => l.group !== groupId);
      if (leaves.length === column.leaves.length) {
        columns.push(column); // untouched
        continue;
      }
      columnChanged = true; // this column lost a leaf (or emptied)
      const ne = asNonEmpty(leaves);
      if (ne !== null) columns.push({ ...column, leaves: ne });
      // else: column's last leaf removed -> drop the column.
    }
    const cne = asNonEmpty(columns);
    // Reuse the original row only when NOTHING inside changed -- a row with the
    // same column COUNT can still have lost a leaf from inside a column.
    if (cne !== null) rows.push(!columnChanged ? row : { ...row, columns: cne });
    // else: row's last column removed -> drop the row.
  }
  const rne = asNonEmpty(rows);
  return rne === null ? null : { rows: rne };
}

/** Find a column by its node id within a region, with its enclosing row. */
function findColumn(
  region: DockRegion | null,
  nodeId: NodeId,
): { row: DockRow; column: DockColumn } | null {
  if (region === null) return null;
  for (const row of region.rows) {
    const column = row.columns.find((c) => c.id === nodeId);
    if (column !== undefined) return { row, column };
  }
  return null;
}

/** Find a leaf by its node id within a region, with its enclosing column/row. */
function findLeaf(
  region: DockRegion | null,
  nodeId: NodeId,
): { row: DockRow; column: DockColumn; leaf: DockLeaf } | null {
  if (region === null) return null;
  for (const row of region.rows) {
    for (const column of row.columns) {
      const leaf = column.leaves.find((l) => l.id === nodeId);
      if (leaf !== undefined) return { row, column, leaf };
    }
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

// ---------------------------------------------------------------------------
// Collapse / minimization.
// ---------------------------------------------------------------------------

/** A column is "minimized" when EVERY leaf in it is collapsed -- then it needs
 * no real width and renders as a narrow vertical strip. (One well-typed level;
 * no subtree recursion to get wrong -- this is what fixed the `[A][B]/[C]`
 * height-reclaim bug.) */
export function isColumnMinimized(
  column: DockColumn,
  groups: Record<GroupId, TabGroup>,
): boolean {
  return column.leaves.every((l) => groups[l.group]?.collapsed === true);
}

/** A row is "minimized" when every one of its columns is minimized. */
export function isRowMinimized(
  row: DockRow,
  groups: Record<GroupId, TabGroup>,
): boolean {
  return row.columns.every((c) => isColumnMinimized(c, groups));
}

/** True when the column with id `nodeId` (in either docked region) is fully
 * minimized -- used to skip the shrink-the-leaf split PREVIEW over a
 * minimized target (nothing to vacate). False if the column isn't found. */
export function nodeAllMinimized(layout: DockLayout, nodeId: NodeId): boolean {
  for (const edge of ["left", "right"] as const) {
    const region = layout.docked[edge];
    const found = findColumn(region, nodeId);
    if (found !== null) return isColumnMinimized(found.column, layout.groups);
    // A leaf id may also be passed (a single-leaf column dropped beside): treat
    // a fully-minimized enclosing column as minimized.
    const leaf = findLeaf(region, nodeId);
    if (leaf !== null) return isColumnMinimized(leaf.column, layout.groups);
  }
  return false;
}

/** True when every group in a floating window's stack is minimized. */
export function windowAllMinimized(
  layout: DockLayout,
  windowId: WindowId,
): boolean {
  const win = layout.floating.find((w) => w.id === windowId);
  return (
    win !== undefined &&
    win.stack.length > 0 &&
    win.stack.every((g) => layout.groups[g]?.collapsed === true)
  );
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

/** The row band that DETERMINES a region's horizontal width: the one with the
 * most side-by-side columns. A full-width band spans all columns, so the band
 * with the most columns dictates the region's width; narrower bands ride along.
 * (Ties -> the first such band.) */
export function widthRow(region: DockRegion): DockRow {
  let widest = region.rows[0];
  for (const row of region.rows)
    if (row.columns.length > widest.columns.length) widest = row;
  return widest;
}

/** The width-determining columns of a region: the widest row band's columns.
 * Width reconciliation and region-width math run over these (they all share the
 * region's horizontal extent). */
export function widthColumns(region: DockRegion): NonEmpty<DockColumn> {
  return widthRow(region).columns;
}

/** Whether a region's given edge is a single full-span leaf -- so a "span the
 * whole region" drop there would be identical to a per-panel split of that one
 * panel, and the region-edge zone is suppressed as redundant. Distinct only when
 * the edge spans multiple cells:
 * - top/bottom span multiple cells when the region has 2+ row bands, OR the edge
 *   band itself has side-by-side columns;
 * - left/right span multiple cells when the region has 2+ rows, OR the touched
 *   column stacks 2+ leaves. */
export function edgeIsSingleLeaf(
  region: DockRegion,
  side: "top" | "bottom" | "left" | "right",
): boolean {
  const vertical = side === "top" || side === "bottom";
  if (vertical) {
    // Top/bottom add a row band; redundant only when the region is a single
    // single-column row whose column is itself a single leaf.
    if (region.rows.length !== 1) return false;
    const row = region.rows[0];
    return row.columns.length === 1 && row.columns[0].leaves.length === 1;
  }
  // Left/right span every row band; redundant only when there's one row whose
  // outermost column is a single leaf.
  if (region.rows.length !== 1) return false;
  const row = region.rows[0];
  const column =
    side === "left" ? row.columns[0] : row.columns[row.columns.length - 1];
  return column.leaves.length === 1;
}

/** Minimum width a single docked column may be resized to in the layout model:
 * MIN_REGION_GRAB_PX -- a tiny grabbable sliver, NOT the panel-content minimum
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
 * is a distinct gesture from "float a single panel" (a 1-leaf column IS its
 * single panel). With the flat model every column is trivially linearizable
 * top-to-bottom, so the old "pure column" caveat (a column might hold a nested
 * row that can't round-trip) is gone: this is just a leaf-count check. */
export function isMultiLeafColumn(column: DockColumn): boolean {
  return column.leaves.length >= 2;
}

/** Distribute a region's total width across its side-by-side columns for a
 * region-edge resize. Every column scales proportionally from its DRAG-START
 * width; columns that would cross a min/max limit are clamped there, and the
 * difference is redistributed among the still-unclamped columns (iterated,
 * since redistribution can push more columns to a limit). The region can
 * therefore keep resizing while ANY column has room, instead of locking up as
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
    if (freeShare === 0) break; // all clamped; target within bounds => done.
    for (let i = 0; i < n; i++) {
      if (!frozen[i]) widths[i] += (correction * share[i]) / freeShare;
    }
  }
  return widths;
}

/** Pure cascading-divider resize, shared by docked column/row splits and
 * floating snap-stacks. Dragging the boundary between cell `dividerIndex` and
 * `dividerIndex+1` grows the drag-side cell and shrinks the other side IN ORDER
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
  /** Per-cell minimum px, or one shared floor. Band dividers pass per-band
   * minimums (a band holding N stacked leaves needs N cells' worth of
   * height, not one) so a drag can't squeeze a multi-leaf band below its
   * own content and force cross-band overlap. */
  minCell: number | number[];
  maxCell: number;
}): number[] | null {
  const { weights, collapsed, containerPx, deltaPx, maxCell } = opts;
  const index = opts.dividerIndex;
  const minOf = (i: number): number =>
    Array.isArray(opts.minCell) ? (opts.minCell[i] ?? 0) : opts.minCell;
  if (containerPx <= 0) return null;
  const total =
    weights.reduce((s, w, i) => (collapsed[i] ? s : s + w), 0) || 1;
  const next = weights.map((w, i) =>
    collapsed[i] ? 0 : (w / total) * containerPx,
  );
  // The grower is the nearest EXPANDED cell in the grow direction: a fixed
  // 26px bar adjacent to the seam is skipped rather than dead-ending the
  // drag (a resize cursor that no-ops in one direction lies -- hit-box loop
  // finding). Null only when no expanded cell exists on that side.
  let growIdx = deltaPx > 0 ? index : index + 1;
  const step = deltaPx > 0 ? -1 : 1;
  while (growIdx >= 0 && growIdx < weights.length && collapsed[growIdx]) {
    growIdx += step;
  }
  if (growIdx < 0 || growIdx >= weights.length) return null;
  if (deltaPx > 0) {
    let need = Math.min(deltaPx, maxCell - next[growIdx]);
    const want = need;
    for (let j = index + 1; j < next.length && need > 0.5; j++) {
      if (collapsed[j]) continue;
      const give = Math.min(need, next[j] - minOf(j));
      if (give > 0) {
        next[j] -= give;
        need -= give;
      }
    }
    next[growIdx] += want - need;
  } else if (deltaPx < 0) {
    let need = Math.min(-deltaPx, maxCell - next[growIdx]);
    const want = need;
    for (let j = index; j >= 0 && need > 0.5; j--) {
      if (collapsed[j]) continue;
      const give = Math.min(need, next[j] - minOf(j));
      if (give > 0) {
        next[j] -= give;
        need -= give;
      }
    }
    next[growIdx] += want - need;
  }
  return next;
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

/** True when a group READS as collapsed: its own collapsed flag is set, OR it
 * is docked on an edge whose whole region is explicitly collapsed to the rail
 * (D21) -- rail cells render as compact strips regardless of their own
 * per-cell collapse state. */
export function isGroupEffectivelyCollapsed(
  layout: DockLayout,
  groupId: GroupId,
): boolean {
  if (layout.groups[groupId]?.collapsed === true) return true;
  const loc = findGroupLocation(layout, groupId);
  return loc?.kind === "docked" && isRegionCollapsedOn(layout, loc.edge);
}

/** The group ids that share a STACK with `groupId` (including itself): a
 * floating window's whole stack, or the leaf groups of the docked COLUMN that
 * contains the group. A LONE group (its own window, or the sole leaf of its
 * column) returns just `[groupId]`. Used by chrome that styles a group
 * differently when stacked (e.g. the unmergeable header's top rule). */
export function stackGroupIdsOf(
  layout: DockLayout,
  groupId: GroupId,
): GroupId[] {
  const win = layout.floating.find((w) => w.stack.includes(groupId));
  if (win !== undefined) return win.stack.length >= 2 ? [...win.stack] : [groupId];
  // Docked: the column holding this group's leaf IS the stack.
  for (const edge of ["left", "right"] as DockEdge[]) {
    const found = findGroupInRegion(layout.docked[edge], groupId);
    if (found === null) continue;
    return found.column.leaves.length >= 2
      ? collectLeafGroups(found.column)
      : [groupId];
  }
  return [groupId];
}

/** True when `groupId` shares a stack with at least one OTHER group (a 2+
 * floating stack or a 2+-leaf docked column) -- the boolean companion to
 * stackGroupIdsOf for chrome that only needs the yes/no, without building
 * the id array. */
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
  // An area group is a fixed fixture -- it is never moved or removed. Panels are
  // added to / torn out of it individually; the group itself stays put (this
  // should not be reached, since area groups are only ever drop TARGETS or the
  // source of a tearOutPane, never floated as a whole -- but guard anyway).
  if (loc.kind === "area") return;
  if (loc.kind === "docked") {
    const region = draft.docked[loc.edge];
    const res = region === null ? null : regionRemoveGroup(region, groupId);
    draft.docked[loc.edge] = res;
    // An EMPTIED edge sheds its explicit-collapse flag here, at the one
    // chokepoint every removal path routes through -- otherwise a stale
    // regionCollapsed would ambush the NEXT region docked on this edge with
    // a surprise rail (floatRegion guards the same hazard on its own path).
    if (res === null && isRegionCollapsedOn(draft, loc.edge)) {
      draft.regionCollapsed = withRegionCollapsed(draft, loc.edge, false);
    }
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
 * REFERENCE it from a second place while it stays in its area -- a duplicated
 * group. Not reachable from the UI today (drag stacks never contain area
 * groups), but guarded like insertTabsInto. */
function withoutAreaGroups(layout: DockLayout, groupIds: GroupId[]): GroupId[] {
  return groupIds.filter((g) => !isAreaGroup(layout, g));
}

// ---------------------------------------------------------------------------
// Group + panel construction.
// ---------------------------------------------------------------------------

/** Build a fresh TabGroup. NonEmpty by type: `makeGroup([])` would have
 * produced `activeId: undefined` silently typed as a real PaneId -- an invalid
 * group flowing anywhere. (The one legal EMPTY group, an area's backing group,
 * is built inline by ensureArea with an explicit `activeId: null`.) */
export function makeGroup(paneIds: NonEmpty<PaneId>): TabGroup {
  return {
    id: freshId("group"),
    paneIds: [...paneIds],
    activeId: paneIds[0],
  };
}

/** Whether a panel is flagged unmergeable in the registry. */
export function isPaneUnmergeable(
  panes: PaneRegistry,
  paneId: PaneId,
): boolean {
  return panes[paneId]?.unmergeable === true;
}

/** Whether a group holds an unmergeable panel. Unmergeable panes always live
 * alone, so any panel in the group being unmergeable marks the whole group. */
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
 * sibling's width. `leafWeights` (per-group HEIGHT shares -- a floated stack's
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
 * per-group height shares of the floating window that held ALL of them (its
 * whole stack being docked), or undefined when the groups aren't coming from
 * one window. Capture-then-detach lives in ONE helper because the ORDER is
 * load-bearing: detachInPlace deletes each departing group's stackWeights
 * entry as it leaves, so the weights must be copied out first -- this is the
 * inverse of floatColumn, which wrote them, and it's what lets a floated
 * 70/30 stack dock back at 70/30. */
function detachAllPreservingStackWeights(
  draft: DockLayout,
  groupIds: NonEmpty<GroupId>,
): Record<GroupId, number> | undefined {
  const win = draft.floating.find((w) =>
    groupIds.every((g) => w.stack.includes(g)),
  );
  const weights =
    win?.stackWeights === undefined ? undefined : { ...win.stackWeights };
  groupIds.forEach((g) => detachInPlace(draft, g));
  return weights;
}

/** A row of one column. */
function buildRow(column: DockColumn, weight = 1): DockRow {
  return { id: freshId("node"), weight, columns: [column] };
}

/** A single-row, single-column region holding `column` -- the wrap that turns
 * "a column" into "a docked region" (Region[Row[Column]]). */
function regionOf(column: DockColumn): DockRegion {
  return { rows: [buildRow(column)] };
}

// ---------------------------------------------------------------------------
// Docking ops.
// ---------------------------------------------------------------------------

/** Dock a stack of groups to a screen edge as a new column at the outermost
 * position (far left for "left", far right for "right"). Multiple groups (a
 * snapped floating stack) dock together, keeping their vertical arrangement. */
export function dockToEdge(
  layout: DockLayout,
  groupIds: GroupId[],
  edge: DockEdge,
): DockLayout {
  groupIds = withoutAreaGroups(layout, groupIds);
  const ne = asNonEmpty(groupIds);
  if (ne === null) return layout;
  const draft = clone(layout);
  const stackHeights = detachAllPreservingStackWeights(draft, ne);
  const column = buildColumn(ne, 1, stackHeights);
  const existing = draft.docked[edge];
  if (existing === null) {
    draft.docked[edge] = regionOf(column);
  } else {
    // Add the new column at the OUTERMOST position (far left for "left", far
    // right for "right") of the FIRST row band. The common region is a single
    // row, so this is just the row gaining a column; with multiple bands the
    // new column joins the top band (a group lives in exactly one leaf, so it
    // can't span every band).
    const firstRow = existing.rows[0];
    const columns: NonEmpty<DockColumn> =
      edge === "left"
        ? [column, ...firstRow.columns]
        : [...firstRow.columns, column];
    draft.docked[edge] = {
      rows: mapNonEmpty(existing.rows, (row, i) =>
        i === 0 ? { ...row, columns } : row,
      ),
    };
  }
  return draft;
}

/** Dock a stack of groups as a band on the given outer side of everything
 * already docked in the region. With the 4-level model each side is a clean
 * single-level insert:
 * - top/bottom add a new full-width ROW band spanning every column, at the
 *   region's top/bottom (the standard "band above/below everything" affordance);
 * - left/right add a new full-height COLUMN at the region's outer/inner side.
 * Optional weights preserve the existing content's size (the new band/column
 * grows the region rather than resizing what's there). */
export function dockToRegionEdge(
  layout: DockLayout,
  groupIds: GroupId[],
  edge: DockEdge,
  side: "top" | "bottom" | "left" | "right",
  weights?: { existing: number; dragged: number },
): DockLayout {
  groupIds = withoutAreaGroups(layout, groupIds);
  const ne = asNonEmpty(groupIds);
  if (ne === null) return layout;
  const draft = clone(layout);
  const stackHeights = detachAllPreservingStackWeights(draft, ne);
  const existing = draft.docked[edge];
  if (existing === null) {
    draft.docked[edge] = regionOf(buildColumn(ne, 1, stackHeights));
    return draft;
  }
  if (side === "top" || side === "bottom") {
    // A new full-width ROW band spanning all columns, at the region's outer top
    // or bottom -- a band insert at index 0 (top) or rows.length (bottom). The
    // band-insert mechanics (index, weight rescale) live in insertBandAtIndex;
    // the outer top/bottom are just its boundary cases.
    const index = side === "top" ? 0 : existing.rows.length;
    return insertBandAtIndex(draft, ne, edge, index, weights, stackHeights);
  }
  // left / right: a new full-height column beside EVERYTHING. A multi-band
  // region of single-column bands (the canonical stack, D12) can only host
  // a full-height neighbor as the NESTED form: zip the bands into one
  // multi-leaf column (leaf weights scaled by band weights, so on-screen
  // heights don't move) and put the new column beside it -- [new | col(...)].
  // Regions with a multi-column band can't be zipped (rows can't nest);
  // there the new column joins the FIRST band, and hitTest draws the hint
  // first-band-tall to match (P1).
  const dw = weights?.dragged ?? 1;
  const column = buildColumn(ne, dw, stackHeights);
  const zippable =
    existing.rows.length > 1 &&
    existing.rows.every((r) => r.columns.length === 1);
  if (zippable) {
    const leaves = existing.rows.flatMap((r) => {
      const only = r.columns[0];
      const total = only.leaves.reduce((sum, l) => sum + l.weight, 0) || 1;
      return only.leaves.map((l) => ({
        ...l,
        weight: (l.weight / total) * r.weight,
      }));
    });
    const zipLeaves = asNonEmpty(leaves);
    if (zipLeaves !== null) {
      const zipped: DockColumn = {
        id: existing.rows[0].columns[0].id,
        weight: weights?.existing ?? existing.rows[0].columns[0].weight,
        leaves: zipLeaves,
      };
      const columns: NonEmpty<DockColumn> =
        side === "left" ? [column, zipped] : [zipped, column];
      draft.docked[edge] = {
        rows: [
          {
            id: existing.rows[0].id,
            weight: existing.rows.reduce((s, r) => s + r.weight, 0),
            columns,
          },
        ],
      };
      return draft;
    }
  }
  const firstRow = existing.rows[0];
  if (weights !== undefined) {
    const total = firstRow.columns.reduce((s, c) => s + c.weight, 0) || 1;
    firstRow.columns.forEach((c) => {
      c.weight = (c.weight / total) * weights.existing;
    });
  }
  const columns: NonEmpty<DockColumn> =
    side === "left"
      ? [column, ...firstRow.columns]
      : [...firstRow.columns, column];
  draft.docked[edge] = {
    rows: mapNonEmpty(existing.rows, (row, i) =>
      i === 0 ? { ...row, columns } : row,
    ),
  };
  return draft;
}

/** Insert a new full-width ROW band (a one-column row of the dragged groups) at
 * row `index` of an edge's existing region, mutating `draft` in place. `index`
 * 0 docks above every band; `rows.length` docks below; an interior index docks
 * BETWEEN two existing bands (the gap a cross-band seam drop targets). The
 * dragged groups must already be detached from `draft`. With explicit weights
 * the existing bands collectively take `existing` (proportionally rescaled) and
 * the new band `dragged`; without, the new band gets weight 1 alongside the
 * existing bands' weights (left untouched). Returns `draft`.
 *
 * THE single place a band is created at an index -- dockToRegionEdge top/bottom
 * call it directly (already detached), and dockBandAtIndex (the public
 * detach-then-insert wrapper the bandInsert drop routes through) calls it too, so
 * the rescale and clamp logic lives once. */
function insertBandAtIndex(
  draft: DockLayout,
  groupIds: NonEmpty<GroupId>,
  edge: DockEdge,
  index: number,
  weights?: { existing: number; dragged: number },
  leafWeights?: Record<GroupId, number>,
): DockLayout {
  const existing = draft.docked[edge];
  if (existing === null) {
    // No region yet: the band IS the region (index is irrelevant).
    draft.docked[edge] = regionOf(buildColumn(groupIds, 1, leafWeights));
    return draft;
  }
  // Default weight: the MEAN of the existing bands' weights, so the new
  // band takes an equal share regardless of the scale the existing weights
  // are on (after a band-divider resize they are px-scale; a literal 1
  // would render the new band ~0px tall).
  const meanW =
    existing.rows.reduce((s, r) => s + r.weight, 0) / existing.rows.length;
  const draggedW = weights?.dragged ?? meanW;
  const band = buildRow(buildColumn(groupIds, 1, leafWeights), draggedW);
  if (weights !== undefined) {
    const total = existing.rows.reduce((s, r) => s + r.weight, 0) || 1;
    existing.rows.forEach((r) => {
      r.weight = (r.weight / total) * weights.existing;
    });
  }
  const at = clamp(index, 0, existing.rows.length);
  draft.docked[edge] = { rows: withInserted(existing.rows, at, band) };
  return draft;
}

/** Dock a stack of groups as a new full-width band at row `index` of an edge.
 * The public entry: detaches the dragged groups first (so a self-drop / move
 * across the same edge stays conservative), then inserts the band. Index is
 * clamped to [0, rows.length]; docking onto an empty edge creates the region. */
export function dockBandAtIndex(
  layout: DockLayout,
  groupIds: GroupId[],
  edge: DockEdge,
  index: number,
  weights?: { existing: number; dragged: number },
): DockLayout {
  groupIds = withoutAreaGroups(layout, groupIds);
  const ne = asNonEmpty(groupIds);
  if (ne === null) return layout;
  const draft = clone(layout);
  const stackHeights = detachAllPreservingStackWeights(draft, ne);
  // Detaching dragged groups that shared this edge can drop bands, shifting the
  // target index. Re-clamp against the post-detach region so the band still
  // lands in range (the caller's index was computed against the pre-detach
  // layout; an exact "between THESE two bands" can shift, but it stays valid).
  const after = draft.docked[edge];
  const max = after === null ? 0 : after.rows.length;
  return insertBandAtIndex(
    draft,
    ne,
    edge,
    clamp(index, 0, max),
    weights,
    stackHeights,
  );
}

/** Drop a stack of groups onto an existing docked leaf. `center` merges every
 * dragged panel into the target's tabs. The flattening KEY SEMANTIC:
 * - top/bottom insert the dragged leaf(s) INTO the target leaf's COLUMN, just
 *   above/below the target (a column gains a leaf);
 * - left/right insert a new COLUMN beside the target leaf's column (the region
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

  const draft = clone(layout);
  const stackHeights = detachAllPreservingStackWeights(draft, ne);
  // Re-find the target leaf AFTER detach. If a dragged group shared this edge,
  // detaching it may have dropped the target's column; if the target is gone (a
  // self-drop), abort rather than orphaning the dragged groups.
  const liveRegion = draft.docked[edge];
  const live = findLeaf(liveRegion, targetNodeId);
  if (liveRegion === null || live === null) return layout;

  const targetColumn = live.column; // a reference into the cloned draft
  const targetRow = live.row;

  const li = targetColumn.leaves.findIndex((l) => l.id === targetNodeId);

  // Sibling weights may be on any scale (divider drags write px values), so
  // new-vs-target defaults derive from the TARGET's current weight: each side
  // takes half, which is scale-invariant and matches the hint's 50/50 promise.
  if (region === "top" || region === "bottom") {
    // Insert the dragged leaf(s) into the target's column, above/below it.
    // The dragged STACK as a whole takes half the target's weight (the
    // hint's 50/50 promise); each leaf's share of that half follows the
    // floated stack's preserved height ratios (P8 round-trip -- same rule as
    // the left/right branch's buildColumn).
    const dw = live.leaf.weight / 2;
    const tw = live.leaf.weight / 2;
    targetColumn.leaves[li] = { ...live.leaf, weight: tw };
    const shareOf = (g: GroupId) => stackHeights?.[g] ?? 1;
    const totalShares = ne.reduce((s2, g) => s2 + shareOf(g), 0) || 1;
    const banded = mapNonEmpty(ne, (g) =>
      makeLeaf(g, (dw * shareOf(g)) / totalShares),
    );
    const at = region === "top" ? li : li + 1;
    targetColumn.leaves = withInserted(targetColumn.leaves, at, ...banded);
    return draft;
  }

  // left / right: dock beside the TARGET CELL. When the target's column is
  // its band's ONLY column and stacks multiple leaves, the band SPLITS so the
  // new panel lands beside just that cell -- keeping the hint's promise (the
  // insertion line is drawn at the cell's height) literally: leaves above and
  // below the target keep their own full-width bands, and the target's leaf
  // shares a new band with the dropped column. With sibling columns in the
  // band the flat Region->Row->Column->Leaf model cannot nest a row inside a
  // column, so the new column spans the whole band beside the target's column
  // instead (and the hint spans the band to match).
  const dw = targetColumn.weight / 2;
  const tw = targetColumn.weight / 2;
  const newColumn = buildColumn(ne, dw, stackHeights);
  if (targetRow.columns.length === 1 && targetColumn.leaves.length > 1) {
    const above = targetColumn.leaves.slice(0, li);
    const below = targetColumn.leaves.slice(li + 1);
    // Carve the original band's weight by the leaves' height shares, so the
    // on-screen heights don't jump at the split.
    const total = targetColumn.leaves.reduce((s, l) => s + l.weight, 0) || 1;
    const share = (leaves: DockLeaf[]) =>
      (targetRow.weight * leaves.reduce((s, l) => s + l.weight, 0)) / total;
    const bandOf = (leaves: DockLeaf[]): DockRow | null => {
      const ls = asNonEmpty(leaves);
      return ls === null
        ? null
        : buildRow({ id: freshId("node"), weight: 1, leaves: ls }, share(leaves));
    };
    // The target's own column keeps its id (and with it its reconciled width).
    const targetCol: DockColumn = {
      ...targetColumn,
      weight: tw,
      leaves: [{ ...live.leaf, weight: 1 }],
    };
    const middle: DockRow = {
      id: targetRow.id,
      weight: share([live.leaf]),
      columns:
        region === "left" ? [newColumn, targetCol] : [targetCol, newColumn],
    };
    const aboveBand = bandOf(above);
    const belowBand = bandOf(below);
    // Replace the original band with its 1-3 successors, in place. The result
    // always contains `middle`, so it is non-empty by construction.
    const ri = liveRegion.rows.findIndex((rw) => rw.id === targetRow.id);
    const rows = asNonEmpty([
      ...liveRegion.rows.slice(0, ri),
      ...(aboveBand === null ? [] : [aboveBand]),
      middle,
      ...(belowBand === null ? [] : [belowBand]),
      ...liveRegion.rows.slice(ri + 1),
    ]);
    if (rows === null) return layout; // unreachable: `middle` is always present
    liveRegion.rows = rows;
    return draft;
  }
  // A new column beside the target's column, within the SAME row band. The
  // target column keeps `tw`; the new column takes `dw` (its leaves keep a
  // floated stack's preserved height shares).
  targetColumn.weight = tw;
  const ci = targetRow.columns.findIndex((c) => c.id === targetColumn.id);
  const at = region === "left" ? ci : ci + 1;
  targetRow.columns = withInserted(targetRow.columns, at, newColumn);
  return draft;
}

/** Insert every panel from `sourceGroupIds` into `targetGroupId`'s tab strip at
 * `index`, dropping the now-empty source groups. The last inserted group's
 * active tab becomes active. */
export function insertTabsInto(
  layout: DockLayout,
  targetGroupId: GroupId,
  sourceGroupIds: GroupId[],
  index: number,
): DockLayout {
  // Like the other ops: an area's backing group is never a SOURCE (consuming it
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
  const i = Math.max(0, Math.min(target.paneIds.length, index));
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
 * a window TALLER than it was pinned to, so a small panel in a tiny container
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
 * to fixed-height with its contents scrolling -- OR pass `undefined` to clear
 * the pin and RETURN it to auto-height (the window tracks its content again).
 * Reverting to auto is the user's escape hatch from a fixed height (e.g.
 * dragging the bottom grip back down to the natural content height). */
export function resizeWindowHeight(
  layout: DockLayout,
  windowId: WindowId,
  height: number | undefined,
  /** New top edge, for resizes that grab the TOP grips (the bottom edge stays
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
 * Called when a USER gesture (drag, any resize grip) takes manual control of the
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

/** Append every panel from `sourceGroupIds` to `targetGroupId`'s tab strip. */
export function mergeGroupsInto(
  layout: DockLayout,
  targetGroupId: GroupId,
  sourceGroupIds: GroupId[],
): DockLayout {
  const end = layout.groups[targetGroupId]?.paneIds.length ?? 0;
  return insertTabsInto(layout, targetGroupId, sourceGroupIds, end);
}

// ---------------------------------------------------------------------------
// Panel lifecycle ops.
//
// Panels can appear and disappear at runtime (e.g. driven by server state).
// These ops add a not-yet-placed panel to the layout and remove a panel from
// wherever the user has since moved it, collapsing whatever empties out. They
// are deliberately idempotent: adding a panel that's already placed and
// removing one that isn't are both no-ops, so a sync layer can re-run them.
// ---------------------------------------------------------------------------

/** The group currently holding `paneId`, or null when the panel isn't placed
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
  // state); it becomes real when the first panel is added.
  const group: TabGroup = { id: freshId("group"), paneIds: [], activeId: null };
  draft.groups[group.id] = group;
  draft.areas = {
    ...(draft.areas ?? {}),
    [areaId]: { group: group.id },
  };
  return draft;
}

/** Add a panel to an area's tabs at `index` (default: append), creating the
 * area if needed. No-op when the panel is already placed ANYWHERE in the
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

/** Add a not-yet-placed panel as its own floating window. No-op when the panel
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

/** Remove a panel from wherever it currently lives (the user may have moved it
 * far from where it was added). A non-area group left empty is detached and
 * deleted -- its window or docked cell collapses like a tear-out would; an
 * area's backing group persists empty as a drop affordance. No-op when the
 * panel isn't placed. */
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
 * Detaches the pane from wherever it currently lives FIRST (collapsing any group
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
  const i = index === undefined ? dest.paneIds.length : index;
  dest.paneIds.splice(Math.max(0, Math.min(dest.paneIds.length, i)), 0, paneId);
  if (dest.paneIds.length === 1) dest.activeId = paneId;
}

/** Reorder an area's tabs to match `order` (e.g. a server-driven tab list).
 * Panels the user dragged OUT of the area aren't touched; panes in the area
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
  if (isAreaGroup(layout, groupId)) return { layout, windowId: null };
  const draft = clone(layout);
  detachInPlace(draft, groupId);
  const win = makeFloatingWindow(x, y, width, [groupId], height);
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
  // Capture order + weights BEFORE detaching (detach restructures the region).
  // Sequential detachInPlace (by GROUP id) reuses the standard cleanup
  // invariants (empty region -> null edge, drop emptied columns).
  const stack = column.leaves.map((l) => l.group);
  if (stack.some((g) => isAreaGroup(layout, g))) {
    return { layout, windowId: null };
  }
  const stackWeights: Record<GroupId, number> = {};
  column.leaves.forEach((l) => {
    stackWeights[l.group] = l.weight;
  });

  const draft = clone(layout);
  stack.forEach((g) => detachInPlace(draft, g));
  const win = makeFloatingWindow(x, y, width, stack, height, stackWeights);
  draft.floating.push(win);
  return { layout: draft, windowId: win.id };
}

/** Float an ENTIRE REGION as one window: every leaf across every band
 * (bands top-to-bottom, columns left-to-right, leaves top-to-bottom), with
 * heights carried from band weights x leaf shares. Used by the all-minimized
 * region rail's parent handle -- the region-level analog of floatColumn. */
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
  for (const band of region.rows) {
    for (const column of band.columns) {
      const total = column.leaves.reduce((s, l) => s + l.weight, 0) || 1;
      for (const lf of column.leaves) {
        stack.push(lf.group);
        stackWeights[lf.group] = (band.weight * lf.weight) / total;
      }
    }
  }
  if (stack.some((g) => isAreaGroup(layout, g))) {
    return { layout, windowId: null };
  }
  const draft = clone(layout);
  stack.forEach((g) => detachInPlace(draft, g));
  // The region is gone; its explicit collapse flag (D21) must not survive to
  // ambush the NEXT region docked on this edge with a surprise rail.
  draft.regionCollapsed = withRegionCollapsed(draft, edge, false);
  const win = makeFloatingWindow(x, y, width, stack, undefined, stackWeights);
  draft.floating.push(win);
  return { layout: draft, windowId: win.id };
}

/** The docked edge whose region-collapse chevron THIS group's chrome row
 * hosts, or null. The chevron renders INLINE in the region's top-right
 * cell's chrome row, just inboard of that cell's -/+ toggle (spec 3.3): a
 * positioned overlay cannot know how far panel-provided header content
 * (action icons, custom titleNodes) extends, so the row itself hosts it.
 * No chevron while the region is collapsed -- the rail's own header is the
 * expand affordance. */
export function regionChevronEdge(
  layout: DockLayout,
  groupId: GroupId,
): DockEdge | null {
  for (const edge of ["left", "right"] as DockEdge[]) {
    const tree = layout.docked[edge];
    if (tree === null || isRegionCollapsedOn(layout, edge)) continue;
    const band = tree.rows[0];
    const column = band.columns[band.columns.length - 1];
    if (column.leaves[0].group === groupId) return edge;
  }
  return null;
}

/** Stamp `collapsed: true` onto groups of a NOT-YET-COMMITTED result draft.
 * Drag-commit companion (P2: drags never change what the user sees): a cell
 * dragged out of a RAILED region is only effectively collapsed -- its own
 * flag is usually false -- so floating it as-is would pop a full-size window
 * mid-drag. The caller stamps the floated group(s) so the window renders as
 * the minimized bar the user was dragging. Server float commands do NOT do
 * this: for them position and collapse are independent axes (P6). */
export function stampCollapsedInPlace(
  draft: DockLayout,
  groupIds: GroupId[],
): void {
  for (const g of groupIds) {
    const group = draft.groups[g];
    if (group !== undefined) group.collapsed = true;
  }
}

/** Pull a single panel out of its group into a new floating window. If the
 * panel was the only one in its group, the whole group floats instead (no new
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
  // No-op when the pane isn't actually in this group: tearing out a pane the
  // group doesn't hold would otherwise CONJURE it -- the split branch below
  // wraps `paneId` in a fresh group regardless, so an absent (or undefined)
  // paneId materializes a phantom panel and breaks conservation. The pane must
  // already live here for there to be anything to tear out.
  if (group !== undefined && !group.paneIds.includes(paneId)) {
    return { layout, windowId: null, floatingGroupId: null };
  }
  // An area group is a fixed fixture: never float it as a whole, even when it
  // holds a single panel. Always split the torn panel into its OWN new group and
  // leave the area group in place (it may end up empty -- it persists as a drop
  // affordance). A normal group with <=1 panel floats wholesale as before.
  const area = isAreaGroup(layout, groupId);
  if (group === undefined || (!area && group.paneIds.length <= 1)) {
    const res = floatGroup(layout, groupId, x, y, width);
    // Non-area by the check above, so floatGroup always created a window.
    return {
      layout: res.layout,
      windowId: res.windowId!,
      floatingGroupId: groupId,
    };
  }
  const draft = clone(layout);
  const src = draft.groups[groupId];
  src.paneIds = src.paneIds.filter((p) => p !== paneId);
  // Keep activeId valid when panes remain; an emptied area goes to null (the
  // one legal empty-group state -- no stale sentinel).
  if (src.paneIds.length === 0) src.activeId = null;
  else if (src.activeId === paneId) src.activeId = src.paneIds[0];
  const newGroup = makeGroup([paneId]);
  // The torn pane inherits the source's minimized state: dragging a tab out of
  // a minimized strip floats it STILL minimized (expanding is a click-only
  // gesture). Same as the 1-pane wholesale-float branch above, which floats the
  // source group with its collapsed flag intact.
  if (src.collapsed === true) newGroup.collapsed = true;
  draft.groups[newGroup.id] = newGroup;
  const win = makeFloatingWindow(x, y, width, [newGroup.id]);
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
  if (groupIds.length === 0) return layout;
  const draft = clone(layout);
  // Capture the dragged window's explicit height BEFORE detaching (detach
  // removes the now-empty source window, discarding its height). If the target
  // auto-sizes, adopt the dragged window's height so a height the user set on the
  // panel being snapped in isn't silently reset.
  const sourceHeight = layout.floating.find((w) =>
    groupIds.some((g) => w.stack.includes(g)),
  )?.height;
  // Detach first; the dragged set may BE (part of) the target window's stack.
  groupIds.forEach((g) => detachInPlace(draft, g));
  // Re-find the target after detach: if the dragged groups were its entire
  // stack, the window is now gone -- abort rather than splice into a stale
  // object (which would orphan the groups and lose the panes).
  const target = draft.floating.find((w) => w.id === targetWindowId);
  if (target === undefined) return layout;
  const i =
    index === undefined
      ? target.stack.length
      : Math.max(0, Math.min(target.stack.length, index));
  target.stack.splice(i, 0, ...groupIds);
  // Copy (don't alias) the source's height object: sourceHeight is read from the
  // ORIGINAL layout, so assigning it directly would share a reference between the
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
  const clamped = Math.max(0, Math.min(without.length, insertIndex));
  without.splice(clamped, 0, paneId);
  const unchanged =
    without.length === group.paneIds.length &&
    without.every((p, i) => p === group.paneIds[i]);
  if (unchanged) return layout;
  const draft = clone(layout);
  draft.groups[groupId].paneIds = without;
  return draft;
}

/** Toggle a group's minimized (collapsed) state. Per-cell (D16): any group --
 * lone or stacked -- toggles individually; mixed stacks are legal. The expand
 * direction shares expandGroup's path (expandGroupInPlace), which also clears
 * the group's region-collapse flag (D21): any user expand reveals the panel. */
export function toggleCollapsed(
  layout: DockLayout,
  groupId: GroupId,
): DockLayout {
  const group = layout.groups[groupId];
  if (group === undefined) return layout;
  const draft = clone(layout);
  if (group.collapsed === true) expandGroupInPlace(draft, groupId);
  else draft.groups[groupId].collapsed = true;
  return draft;
}

/** An edge's region-collapse record with defaults filled in (tolerates
 * layouts predating the field -- persisted snapshots, test literals). */
function regionCollapsedOf(layout: DockLayout): Record<DockEdge, boolean> {
  return {
    left: isRegionCollapsedOn(layout, "left"),
    right: isRegionCollapsedOn(layout, "right"),
  };
}

/** The layout's region-collapse record with `edge` set to `value` -- the one
 * way any mutation writes `regionCollapsed`. */
function withRegionCollapsed(
  layout: DockLayout,
  edge: DockEdge,
  value: boolean,
): Record<DockEdge, boolean> {
  return { ...regionCollapsedOf(layout), [edge]: value };
}

/** Set an edge's EXPLICIT region-collapse flag (D21). Collapsing an edge with
 * no region is a no-op (there is nothing to rail); clearing is always legal.
 * Per-cell collapse states are untouched -- the rail is a view over them. */
export function setRegionCollapsed(
  layout: DockLayout,
  edge: DockEdge,
  collapsed: boolean,
): DockLayout {
  if (collapsed && layout.docked[edge] === null) return layout;
  if (isRegionCollapsedOn(layout, edge) === collapsed) return layout;
  const draft = clone(layout);
  draft.regionCollapsed = withRegionCollapsed(layout, edge, collapsed);
  return draft;
}

/** Clear the region-collapse flag for the edge holding `groupId` (if docked),
 * in place. Every op that EXPANDS a panel routes through this: expanding a
 * panel from the rail must reveal it, which means un-collapsing its region
 * (D21) -- otherwise the "expanded" panel would stay hidden behind the rail.
 * Returns whether the flag was actually cleared. */
function clearRegionCollapsedForGroupInPlace(
  draft: DockLayout,
  groupId: GroupId,
): boolean {
  const loc = findGroupLocation(draft, groupId);
  if (loc?.kind !== "docked" || !isRegionCollapsedOn(draft, loc.edge))
    return false;
  draft.regionCollapsed = withRegionCollapsed(draft, loc.edge, false);
  return true;
}

/** Expand `groupId` in place: clear its own collapsed flag and its region's
 * collapse flag (D21). Shared by expandGroup and toggleCollapsed's expand
 * direction. Returns whether anything changed. */
function expandGroupInPlace(draft: DockLayout, groupId: GroupId): boolean {
  let changed = false;
  const group = draft.groups[groupId];
  if (group?.collapsed === true) {
    group.collapsed = false;
    changed = true;
  }
  if (clearRegionCollapsedForGroupInPlace(draft, groupId)) changed = true;
  return changed;
}

/** Expand a collapsed group. ALSO clears its region's collapse flag (D21):
 * expanding from the rail reveals the panel. No-op when the group is already
 * expanded AND its region isn't collapsed (or the group is unknown). */
export function expandGroup(layout: DockLayout, groupId: GroupId): DockLayout {
  if (layout.groups[groupId] === undefined) return layout;
  const draft = clone(layout);
  return expandGroupInPlace(draft, groupId) ? draft : layout;
}

/** Minimize a whole stack (a floating window's stack or a docked column's
 * leaves) -- the stack handle's minimize-all button. Bulk convenience only
 * (D16): collapses every listed group; per-cell states stay legal otherwise. */
export function minimizeStack(
  layout: DockLayout,
  groupIds: GroupId[],
): DockLayout {
  if (groupIds.every((gid) => layout.groups[gid]?.collapsed === true))
    return layout;
  const draft = clone(layout);
  for (const gid of groupIds) {
    const group = draft.groups[gid];
    if (group !== undefined) group.collapsed = true;
  }
  return draft;
}

/** Expand a whole stack -- the inverse of minimizeStack. */
export function expandStack(
  layout: DockLayout,
  groupIds: GroupId[],
): DockLayout {
  if (groupIds.every((gid) => layout.groups[gid]?.collapsed !== true))
    return layout;
  const draft = clone(layout);
  for (const gid of groupIds) {
    const group = draft.groups[gid];
    if (group !== undefined) group.collapsed = false;
  }
  return draft;
}

/** Structural fingerprint of a layout: the arrangement of ids and group
 * membership across docked trees and floating stacks, EXCLUDING weights and
 * collapse flags. Two layouts with equal signatures differ only in sizes /
 * collapse -- the distinction canonicalization (below) keys on: pure weight
 * commits (resizes) must never restructure mid-gesture (P14/D13). */
export function structureSignature(layout: DockLayout): string {
  const region = (r: DockRegion | null): string =>
    r === null
      ? "-"
      : r.rows
          .map((rw) =>
            rw.columns
              .map(
                (c) =>
                  `${c.id}:${c.leaves.map((l) => `${l.id}/${l.group}`).join(",")}`,
              )
              .join("|"),
          )
          .join(";");
  return [
    region(layout.docked.left),
    region(layout.docked.right),
    layout.floating.map((w) => `${w.id}:${w.stack.join(",")}`).join(";"),
  ].join("##");
}

// D13 zip tolerance: adjacent bands' column boundaries must align within
// this many pixels of each other to be considered the same partition.
const ZIP_TOLERANCE_PX = 2;

/** Canonical band form (spec P14: one structure per picture), run to
 * fixpoint at STRUCTURAL commits:
 *
 *  - D12: full-width vertical stacking is expressed as BANDS. A multi-leaf
 *    column may exist only when its band has sibling columns; a lone
 *    multi-leaf column splits into consecutive bands (band weights carved
 *    by leaf height shares, so nothing moves on screen). Plain docked
 *    stacks thereby minimize independently (no uniform-collapse coupling).
 *
 *  - D13: adjacent bands with the SAME multi-column partition (fractional
 *    widths equal within ~2px of the region width) zip-merge into one band
 *    of stacked columns -- one seam, one set of handles, instead of double
 *    chrome for an aligned grid.
 *
 * The two rules cannot cycle: D12 touches only lone-column bands, D13 only
 * multi-column ones. Id stability: splits keep the original band/column id
 * on the FIRST fragment and all leaf ids; zips keep the UPPER band's ids.
 * Returns true when anything changed. */
export function normalizeCanonicalBandsInPlace(layout: DockLayout): boolean {
  let changed = false;
  for (const edge of ["left", "right"] as DockEdge[]) {
    const region = layout.docked[edge];
    if (region === null) continue;
    const regionW = Math.max(1, regionWidthsOf(layout)[edge]);

    const fractions = (band: DockRow): number[] => {
      const total = band.columns.reduce((s, c) => s + c.weight, 0) || 1;
      return band.columns.map((c) => c.weight / total);
    };
    const canZip = (a: DockRow, b: DockRow): boolean => {
      if (a.columns.length < 2 || a.columns.length !== b.columns.length)
        return false;
      const fa = fractions(a);
      const fb = fractions(b);
      return fa.every(
        (f, i) => Math.abs(f - fb[i]) * regionW <= ZIP_TOLERANCE_PX,
      );
    };
    // Rescale a band's leaf weights so each column's leaves sum to the
    // band's weight -- zipped columns then stack in on-screen proportion.
    const scaled = (band: DockRow, column: DockColumn): DockLeaf[] => {
      const total = column.leaves.reduce((s, l) => s + l.weight, 0) || 1;
      return column.leaves.map((l) => ({
        ...l,
        weight: (l.weight / total) * band.weight,
      }));
    };
    const zip = (a: DockRow, b: DockRow): DockRow => ({
      id: a.id,
      weight: a.weight + b.weight,
      columns: mapNonEmpty(a.columns, (ca, i) => {
        const cb = b.columns[i];
        const leaves = asNonEmpty([...scaled(a, ca), ...scaled(b, cb)]);
        // Both inputs are NonEmpty; the concat cannot be empty.
        return leaves === null ? ca : { ...ca, leaves };
      }),
    });

    let rows: DockRow[] = [...region.rows];
    let dirty = true;
    while (dirty) {
      dirty = false;
      // D12: split lone multi-leaf columns into bands.
      const split: DockRow[] = [];
      for (const band of rows) {
        const only = band.columns.length === 1 ? band.columns[0] : null;
        if (only !== null && only.leaves.length > 1) {
          const total = only.leaves.reduce((s, l) => s + l.weight, 0) || 1;
          only.leaves.forEach((lf, i) => {
            split.push({
              id: i === 0 ? band.id : freshId("node"),
              weight: (band.weight * lf.weight) / total,
              columns: [
                {
                  id: i === 0 ? only.id : freshId("node"),
                  weight: only.weight,
                  leaves: [{ ...lf, weight: 1 }],
                },
              ],
            });
          });
          dirty = true;
          changed = true;
        } else {
          split.push(band);
        }
      }
      rows = split;
      // D13: zip-merge aligned multi-column neighbors.
      for (let i = 0; i + 1 < rows.length; ) {
        if (canZip(rows[i], rows[i + 1])) {
          rows.splice(i, 2, zip(rows[i], rows[i + 1]));
          dirty = true;
          changed = true;
        } else {
          i += 1;
        }
      }
    }
    const ne = asNonEmpty(rows);
    if (ne !== null) region.rows = ne;
  }
  return changed;
}

/** Canonical-form violations, for the dev assert + fuzz harness. Only the
 * D12 half is an INVARIANT: no committed layout may hold a lone multi-leaf
 * column (nothing but a structural op can create one, and structural
 * commits normalize). The D13 half is deliberately NOT asserted -- a user
 * resize may align two bands into a zip-able pair, which is legal at rest
 * and merges at the next structural commit. */
export function canonicalViolations(layout: DockLayout): string[] {
  const out: string[] = [];
  for (const edge of ["left", "right"] as DockEdge[]) {
    const region = layout.docked[edge];
    if (region === null) continue;
    for (const band of region.rows) {
      if (band.columns.length === 1 && band.columns[0].leaves.length > 1)
        out.push(
          `band ${band.id} on ${edge} is a lone multi-leaf column (D12)`,
        );
    }
  }
  return out;
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
  // already matches (the cursor paused), skip the clone entirely. Targets can be
  // rows (region-band drag), columns (row drag), or leaves (column-stack drag).
  let changes = false;
  for (const row of region.rows) {
    if (wantsChange(row.id, row.weight)) changes = true;
    for (const column of row.columns) {
      if (wantsChange(column.id, column.weight)) changes = true;
      for (const leaf of column.leaves)
        if (wantsChange(leaf.id, leaf.weight)) changes = true;
    }
  }
  if (!changes) return layout;
  const draft = clone(layout);
  const set = (id: NodeId): number | undefined => {
    const w = weightsById[id];
    return w !== undefined && Number.isFinite(w) && w > 0 ? w : undefined;
  };
  for (const row of draft.docked[edge]!.rows) {
    const rw = set(row.id);
    if (rw !== undefined) row.weight = rw;
    for (const column of row.columns) {
      const cw = set(column.id);
      if (cw !== undefined) column.weight = cw;
      for (const leaf of column.leaves) {
        const lw = set(leaf.id);
        if (lw !== undefined) leaf.weight = lw;
      }
    }
  }
  return draft;
}

/** Set an edge's region width (px) directly -- the region resizer's write
 * path. The value becomes the carry-over base for width reconciliation on
 * commit (which still enforces its min/max invariants). */
export function setRegionWidth(
  layout: DockLayout,
  edge: DockEdge,
  px: number,
): DockLayout {
  if (!Number.isFinite(px) || regionWidthsOf(layout)[edge] === px)
    return layout;
  const draft = clone(layout);
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
// lives as its OWN top-level dock group rather than nested in the control panel.
// The server sends a coalesced `placement` describing where it should go; the
// ops below seed and re-apply that placement. After the initial placement the
// user may drag the panel anywhere -- a later server placement command
// repositions it again (imperative, not continuous sync).
// ---------------------------------------------------------------------------

/** A panel's requested position, structurally identical to the wire shape
 * (EdgePlacement | SplitPlacement | FloatPlacement in _messages.py /
 * GuiSetPanelPositionMessage). Defined HERE rather than imported from
 * WebsocketMessages so the dock library keeps no dependency on the viser wire
 * protocol (the sync layer's message payloads are structurally compatible and
 * flow in without conversion). */
export type PanelPosition =
  | { kind: "edge"; edge: DockEdge }
  | { kind: "split"; anchor_uuid: string; side: "above" | "below" }
  | { kind: "float"; x: number | null; y: number | null };

/** The placement state the dock applies to a panel: a per-axis bundle the
 * caller assembles from the client-owned placement store. Each field is the
 * latest value the server wrote (or null when never set / gated off). Each
 * axis is independent and applied only when non-null -- a set_width carries no
 * position, so applying width can never re-dock a panel. */
export interface PanelPlacement {
  position: PanelPosition | null;
  width: number | null;
  height: number | null;
  collapsed: boolean | null;
}

/** Default float geometry when the server leaves x/y/size unspecified: the
 * top-left corner of the canvas (inset by the same 15px pad the control panel
 * floats with). `float()` with no coords lands here. */
const DEFAULT_FLOAT_X = 15;
const DEFAULT_FLOAT_Y = 15;
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
 * - x >= 0: `leftInset + x` (x px from the canvas LEFT boundary).
 * - x <  0: right edge `|x|`px from the canvas RIGHT boundary, i.e.
 *   `(width - rightInset) - winWidth + x`.
 * - y >= 0: `y` (from the top).
 * - y <  0: bottom edge `|y|`px from the bottom, i.e. `height - winHeight + y`.
 * When the canvas is measured (width/height > 0), the result is clamped to keep
 * the window's top-left within it (a window larger than the canvas pins to the
 * canvas left/top). When the canvas isn't measured yet (width/height 0, e.g. a
 * first apply before layout), a NEGATIVE coord can't be resolved against a
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
  // A negative coord is a gap from the FAR edge -- but that needs a measured
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
    x = clamp(x, bounds.leftInset, Math.max(bounds.leftInset, canvasRight - winWidth));
  }
  if (bounds.height > 0) {
    y = clamp(y, 0, Math.max(0, bounds.height - winHeight));
  }
  return { x, y };
}

/** Find the group whose paneIds are exactly this panel's panes (the standalone
 * panel's own group), or null if its panes aren't yet grouped together. We key
 * off the FIRST pane: a standalone panel always owns its panes, so whatever
 * group holds the first pane is the panel's group. */
function panelGroupOf(layout: DockLayout, paneIds: PaneId[]): GroupId | null {
  if (paneIds.length === 0) return null;
  return findPaneGroup(layout, paneIds[0]);
}

/** Reconcile a panel group's membership against the server's pane list, IN
 * PLACE, preserving the user's existing tab order for panes that remain. Panes
 * the server added are appended (in server order); panes in `removedPaneIds`
 * (tabs the server explicitly removed from THIS panel) are dropped; `activeId`
 * is kept unless it was removed. Does NOT reorder existing panes to match the
 * server (the user may have reordered tabs locally), and does NOT drop panes it
 * doesn't recognize: the group may also hold FOREIGN panes the user merged in
 * from another panel, and filtering to the server's list would silently orphan
 * them (they'd render nowhere until reconnect). */
function reconcileMembershipInPlace(
  group: TabGroup,
  paneIds: PaneId[],
  removedPaneIds: ReadonlySet<PaneId>,
): void {
  const wanted = new Set(paneIds);
  // Keep current panes that are still wanted or weren't explicitly removed
  // (preserves user order + foreign merges), then append newly-added server
  // panes not already present (in server order).
  const kept = group.paneIds.filter(
    (p) => wanted.has(p) || !removedPaneIds.has(p),
  );
  const added = paneIds.filter((p) => !group.paneIds.includes(p));
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
 * they're already grouped, reuses it and reconciles membership. `collapsed` is
 * the latest server-written value (or null when never set): true collapses the
 * group, false expands it, null leaves it as-is -- a plainly applied field, no
 * one-shot/prev gating. */
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
  // A placement command re-assembles the WHOLE panel into its home group. Any
  // pane the user dragged out into another group/window is MOVED back here via
  // the single move primitive (detach-then-insert), so a pane can't be left in
  // two places. reconcileMembershipInPlace then fixes order/activeId. A
  // placement command knows nothing about tab REMOVALS (that's the membership
  // reconcile's job), so it passes an empty removed set -- and foreign panes
  // the user merged in ride along with the relocated group.
  for (const paneId of paneIds) movePaneInPlace(draft, paneId, groupId);
  reconcileMembershipInPlace(draft.groups[groupId], paneIds, new Set());
}

/** Reconcile a standalone panel's group membership (tabs added/removed) WITHOUT
 * repositioning it. Used on tab-list changes so a user-moved panel isn't yanked
 * back to its server placement just because a tab was added. `removedPaneIds`
 * are the tabs the server removed since the last reconcile -- ONLY those are
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
 * Each field of `placement` is the latest value the server wrote, and is ALWAYS
 * applied when present -- there is no before/after gating. Because the four
 * write-only commands are independent (a set_width carries no position), applying
 * any single field can never re-dock a panel: a position re-docks/re-floats only
 * when `position != null`, and that only happens when the server actually sent a
 * position command. The caller's per-command dedup (appliedPlacementKey) keeps an
 * unrelated re-render from re-applying the same bundle.
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
  // Whether the panel already HAD a group before this op (used by the orphan
  // guard at the end: a group we created must not outlive the op unattached).
  const groupExistedBefore = panelGroupOf(layout, paneIds) !== null;
  let draft = clone(layout);
  const groupId = ensurePanelGroup(draft, paneIds);
  if (groupId === null) return layout;

  // Float a group at the given REQUESTED coords: record them on the window (so
  // the position re-resolves on canvas changes) and set an initial absolute
  // position from the current bounds + window size.
  //
  // If the group is ALREADY the sole occupant of a floating window, reuse that
  // window (preserving its id, z-order, and -- when the user has taken manual
  // control of its position via a drag, i.e. anchor was cleared -- its current
  // position). This is what makes a later size-only re-placement (set_width /
  // set_height) update the size without recreating the window or yanking a
  // user-dragged panel back to its server anchor. A fresh float (group docked or
  // unplaced) makes a new window as before.
  const floatAtRequested = (
    reqX: number,
    reqY: number,
    width: number,
    height: number | undefined,
  ): void => {
    const loc = findGroupLocation(draft, groupId);
    const reusable =
      loc?.kind === "floating"
        ? draft.floating.find((w) => w.id === loc.windowId)
        : undefined;
    let win: FloatingWindow | undefined;
    // Reuse only a SOLO window (this group is its whole stack) -- a multi-group
    // stack must keep its other groups, so re-float into a fresh window.
    if (reusable !== undefined && reusable.stack.length === 1) {
      win = reusable;
      win.width = width;
      win.height = windowHeight(height);
    } else {
      const result = floatGroup(draft, groupId, reqX, reqY, width, height);
      draft = result.layout;
      if (result.windowId === null) return;
      win = draft.floating.find((w) => w.id === result.windowId);
      if (win === undefined) return;
    }
    // A user-dragged window (anchor cleared) keeps its position on a size-only
    // re-placement; otherwise (re)anchor and resolve against the live canvas.
    const userOwnsPosition = win === reusable && win.anchor === undefined;
    if (!userOwnsPosition) {
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
    }
  };

  const position = placement.position;
  if (position === null) {
    // No explicit position. If the panel isn't placed anywhere yet, float it at
    // the default so a freshly-created `add_panel()` (no placement verb called)
    // is still VISIBLE rather than an orphaned group rendered nowhere. A panel
    // the user already moved is left alone. `floatIfUnplaced` is opt-in so the
    // control panel (placed separately by ControlPanelDockSync) isn't affected.
    if (floatIfUnplaced && findGroupLocation(draft, groupId) === null) {
      floatAtRequested(
        DEFAULT_FLOAT_X,
        DEFAULT_FLOAT_Y,
        placement.width ?? DEFAULT_FLOAT_WIDTH,
        placement.height ?? undefined,
      );
    }
  } else {
    if (position.kind === "edge") {
      const loc = findGroupLocation(draft, groupId);
      // ALWAYS dock to the requested edge (a position command means "dock here").
      // Skip only the redundant re-dock when the group is ALREADY docked on this
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
        placement.width ?? DEFAULT_FLOAT_WIDTH,
        placement.height ?? undefined,
      );
    } else if (position.kind === "split") {
      // split: dock above/below the anchor's docked leaf. Fall back to a right
      // edge dock when the anchor isn't docked (floating / not yet placed).
      const anchorGroupId = anchorGroupOf(position.anchor_uuid);
      const leaf =
        anchorGroupId === null
          ? null
          : resolveAnchorLeaf(draft, anchorGroupId);
      if (leaf === null) {
        // The dock model can only split against a DOCKED anchor; the anchor here
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
        draft = dropOnDockedLeaf(draft, [groupId], leaf.edge, leaf.nodeId, region);
      }
    } else {
      // Compile-time exhaustiveness over the wire union (a new placement kind
      // must be handled here, not silently routed into the last branch) -- but
      // WIRE data from a newer server can genuinely carry an unknown kind at
      // runtime, so warn and leave the panel where it is instead of throwing.
      const _exhaustive: never = position;
      console.warn(
        `[viser] Unknown panel position kind; ignoring placement:`,
        _exhaustive,
      );
    }
  }

  // Collapsed axis -- applied AFTER position, so an expand sees the group's
  // FINAL location: expanding routes through expandGroupInPlace, which also
  // clears the (destination) region's collapse flag (spec 7 / P6: a server
  // expand is always visible, never hidden behind the rail). Applied before
  // position, it would clear the DEPARTING region's rail -- un-railing a
  // rail the user explicitly set, for a panel that then leaves it -- and a
  // dock-into-railed-region bundle would land invisible.
  if (placement.collapsed === true) {
    const g = draft.groups[groupId];
    if (g !== undefined) g.collapsed = true;
  } else if (placement.collapsed === false) {
    expandGroupInPlace(draft, groupId);
  }

  // Size: width is region width when docked / window width when floating; height
  // only applies to a floating window. Neither op relocates the group, so one
  // location lookup serves both.
  if (placement.width !== null || placement.height !== null) {
    const loc = findGroupLocation(draft, groupId);
    if (loc?.kind === "docked" && placement.width !== null) {
      draft = setRegionWidth(draft, loc.edge, placement.width);
    } else if (loc?.kind === "floating") {
      if (placement.width !== null) {
        draft = resizeWindow(draft, loc.windowId, placement.width);
      }
      if (placement.height !== null) {
        draft = resizeWindowHeight(draft, loc.windowId, placement.height);
      }
    }
  }

  // An ORPHAN group must be uncommittable from this op: if nothing above
  // attached the group we created (no position + floatIfUnplaced disabled, or
  // an unknown wire position kind), committing the draft would violate the
  // no-orphans invariant -- and worse, findPaneGroup would report the panel
  // "placed" off the orphan, wedging callers' dedup with a panel rendered
  // nowhere. No attach + freshly-created group => the whole op is a no-op.
  if (
    !groupExistedBefore &&
    findGroupLocation(draft, groupId) === null
  )
    return layout;

  return draft;
}
