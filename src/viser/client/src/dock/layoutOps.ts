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
  DockEdge,
  DockLayout,
  DockNode,
  DockSplit,
  DropRegion,
  FloatingWindow,
  GroupId,
  GroupLocation,
  MIN_REGION_GRAB_PX,
  MIN_WINDOW_HEIGHT_PX,
  NodeId,
  PaneId,
  PaneRegistry,
  pinnedPxOf,
  regionWidthsOf,
  SPLIT_DIVIDER_PX,
  TabGroup,
  windowHeight,
  WindowId,
} from "./types";
import { freshId } from "./gestures";
import { GuiPanelMessage } from "../WebsocketMessages";

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

// ---------------------------------------------------------------------------
// Tree helpers (operate on cloned nodes; return new nodes).
// ---------------------------------------------------------------------------

/** Remove the leaf holding `groupId` from a tree, collapsing any split left
 * with a single child. Returns the new tree, or null if it became empty. */
function treeRemoveGroup(node: DockNode, groupId: GroupId): DockNode | null {
  if (node.type === "leaf") {
    return node.group === groupId ? null : node;
  }
  const children = node.children
    .map((child) => treeRemoveGroup(child, groupId))
    .filter((child): child is DockNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) {
    // Promote the sole survivor, but keep this split's weight so the region's
    // overall proportions don't jump.
    return { ...children[0], weight: node.weight };
  }
  return { ...node, children };
}

/** Find the leaf node holding `groupId`, returning its node id. */
function treeFindGroupNodeId(node: DockNode, groupId: GroupId): NodeId | null {
  if (node.type === "leaf") return node.group === groupId ? node.id : null;
  for (const child of node.children) {
    const found = treeFindGroupNodeId(child, groupId);
    if (found !== null) return found;
  }
  return null;
}

/** Replace the node with id `nodeId` by `replacement` everywhere in the tree. */
function treeReplaceNode(
  node: DockNode,
  nodeId: NodeId,
  replacement: DockNode,
): DockNode {
  if (node.id === nodeId) return replacement;
  if (node.type === "leaf") return node;
  return {
    ...node,
    children: node.children.map((child) =>
      treeReplaceNode(child, nodeId, replacement),
    ),
  };
}

/** Find any node (leaf or split) by node id. */
function treeFindNode(node: DockNode, nodeId: NodeId): DockNode | null {
  if (node.id === nodeId) return node;
  if (node.type === "leaf") return null;
  for (const child of node.children) {
    const found = treeFindNode(child, nodeId);
    if (found !== null) return found;
  }
  return null;
}

/** Find a leaf by node id. */
function treeFindLeaf(
  node: DockNode,
  nodeId: NodeId,
): Extract<DockNode, { type: "leaf" }> | null {
  if (node.type === "leaf") return node.id === nodeId ? node : null;
  for (const child of node.children) {
    const found = treeFindLeaf(child, nodeId);
    if (found !== null) return found;
  }
  return null;
}

/** Flatten nested splits that share their parent's direction, so dropping
 * repeatedly along one axis yields a flat row/column rather than a deep,
 * lopsided tree. */
function normalizeTree(node: DockNode): DockNode {
  if (node.type === "leaf") return node;
  const flattened: DockNode[] = [];
  for (const rawChild of node.children) {
    const child = normalizeTree(rawChild);
    if (child.type === "split" && child.dir === node.dir) {
      // Distribute the child split's weight across its grandchildren so their
      // relative proportions within the merged axis are preserved.
      const total = child.children.reduce((sum, c) => sum + c.weight, 0) || 1;
      for (const grandchild of child.children) {
        flattened.push({
          ...grandchild,
          weight: (grandchild.weight / total) * child.weight,
        });
      }
    } else {
      flattened.push(child);
    }
  }
  if (flattened.length === 1) return { ...flattened[0], weight: node.weight };
  return { ...node, children: flattened };
}

// ---------------------------------------------------------------------------
// Location lookup.
// ---------------------------------------------------------------------------

/** A column subtree is "minimized" when every panel in it is collapsed. Such a
 * column needs no real width -- only its handles show. */
export function isColumnMinimized(
  node: DockNode,
  groups: Record<GroupId, TabGroup>,
): boolean {
  if (node.type === "leaf") return groups[node.group]?.collapsed === true;
  return node.children.every((c) => isColumnMinimized(c, groups));
}

/** In-order group ids of every leaf in a subtree. */
export function collectLeafGroups(node: DockNode): GroupId[] {
  if (node.type === "leaf") return [node.group];
  return node.children.flatMap(collectLeafGroups);
}

/** In-order leaf nodes (id + group) of a subtree. */
export function collectLeaves(
  node: DockNode,
): { id: NodeId; group: GroupId }[] {
  if (node.type === "leaf") return [{ id: node.id, group: node.group }];
  return node.children.flatMap(collectLeaves);
}

/** The top-level horizontal columns of a region (the row split's children, or
 * the whole tree as a single column). */
export function topColumns(tree: DockNode): DockNode[] {
  return tree.type === "split" && tree.dir === "row" ? tree.children : [tree];
}

/** The horizontal columns that DETERMINE a region's width, for width
 * reconciliation. A row root's columns are its children (laid side by side). A
 * column root has no top-level horizontal columns -- its width comes from the
 * widest stacked child -- so we descend into the stacked child with the largest
 * horizontal extent (the nested row) and use ITS columns. A leaf is its own
 * single column. This is what lets a top/bottom dock (which wraps the region in
 * a column split) preserve the underlying side-by-side widths rather than
 * collapsing the whole stack to one column's worth (the LEAD 1 bug). */
export function widthColumns(tree: DockNode): DockNode[] {
  if (tree.type === "leaf" || tree.dir === "row") return topColumns(tree);
  // Column (stacked) root: the width-bearing child is the one with the most
  // side-by-side columns (a nested row of N leaves outranks a stacked leaf), so
  // we recurse into it to surface those columns.
  let widest = tree.children[0];
  let widestExtent = -Infinity;
  for (const child of tree.children) {
    const extent = columnExtent(child);
    if (extent > widestExtent) {
      widestExtent = extent;
      widest = child;
    }
  }
  return widthColumns(widest);
}

/** Number of side-by-side columns a node spans: leaf = 1, row = sum of its
 * children, column = max of its children. A pure ORDINAL comparator for
 * widthColumns (which stacked child is "widest") -- no pixels, no cap. */
function columnExtent(node: DockNode): number {
  if (node.type === "leaf") return 1;
  if (node.dir === "row")
    return node.children.reduce((s, c) => s + columnExtent(c), 0);
  return Math.max(...node.children.map(columnExtent));
}

/** Whether a region's given edge is a single full-span leaf. When true, a "span
 * the whole region" drop there would be identical to a per-panel split of that
 * one panel, so the region-edge zone should be suppressed as redundant. It's
 * only distinct when the edge spans multiple cells:
 * - top/bottom edge spans multiple cells when there are side-by-side columns;
 * - left/right edge spans multiple cells when there are stacked rows. */
export function edgeIsSingleLeaf(
  node: DockNode,
  side: "top" | "bottom" | "left" | "right",
): boolean {
  if (node.type === "leaf") return true;
  const vertical = side === "top" || side === "bottom";
  const first = side === "top" || side === "left";
  if (node.dir === "column") {
    // Stacked vertically: top/bottom descend into one child; left/right span all
    // the stacked rows.
    if (!vertical) return false;
    return edgeIsSingleLeaf(
      first ? node.children[0] : node.children[node.children.length - 1],
      side,
    );
  }
  // Row (side by side): left/right descend into one child; top/bottom span all
  // the columns.
  if (vertical) return false;
  return edgeIsSingleLeaf(
    first ? node.children[0] : node.children[node.children.length - 1],
    side,
  );
}

/** Minimum width a docked region may be resized to in the layout model. A leaf
 * floors at MIN_REGION_GRAB_PX (a tiny grabbable sliver, NOT the panel-content
 * minimum -- a too-narrow panel scrolls its body instead). Row splits sum their
 * children's minimums (plus dividers); column splits take the max (panes
 * stacked vertically share one width). */
export function minRegionWidth(
  node: DockNode,
  dividerPx = SPLIT_DIVIDER_PX,
): number {
  if (node.type === "leaf") return MIN_REGION_GRAB_PX;
  if (node.dir === "row") {
    return (
      node.children.reduce((sum, c) => sum + minRegionWidth(c, dividerPx), 0) +
      dividerPx * (node.children.length - 1)
    );
  }
  return Math.max(...node.children.map((c) => minRegionWidth(c, dividerPx)));
}

/** The area id whose tab group is `groupId`, or null. A group that backs a
 * nested dockable area is a fixed fixture (never floated/removed). */
export function areaForGroup(
  layout: DockLayout,
  groupId: GroupId,
): AreaId | null {
  for (const area of Object.values(layout.areas ?? {})) {
    if (area.group === groupId) return area.id;
  }
  return null;
}

/** Whether `groupId` backs a nested dockable area. */
export function isAreaGroup(layout: DockLayout, groupId: GroupId): boolean {
  return areaForGroup(layout, groupId) !== null;
}

/** A "pure column": a column split whose children are ALL leaves (2+). Only
 * pure columns get a float-the-whole-column handle: a column containing a
 * nested row has no crisp linearization into a vertical floating stack --
 * flattening would silently reorder side-by-side panes into a top-to-bottom
 * order that can't round-trip back. Keeping the affordance to pure columns
 * keeps the gesture's semantics obvious. */
export function isPureColumn(node: DockNode): node is DockSplit {
  return (
    node.type === "split" &&
    node.dir === "column" &&
    node.children.length >= 2 &&
    node.children.every((c) => c.type === "leaf")
  );
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
  minCell: number;
  maxCell: number;
}): number[] | null {
  const { weights, collapsed, containerPx, deltaPx, minCell, maxCell } = opts;
  const index = opts.dividerIndex;
  if (containerPx <= 0) return null;
  const total =
    weights.reduce((s, w, i) => (collapsed[i] ? s : s + w), 0) || 1;
  const next = weights.map((w, i) =>
    collapsed[i] ? 0 : (w / total) * containerPx,
  );
  const growIdx = deltaPx > 0 ? index : index + 1;
  if (collapsed[growIdx]) return null;
  if (deltaPx > 0) {
    let need = Math.min(deltaPx, maxCell - next[index]);
    const want = need;
    for (let j = index + 1; j < next.length && need > 0.5; j++) {
      if (collapsed[j]) continue;
      const give = Math.min(need, next[j] - minCell);
      if (give > 0) {
        next[j] -= give;
        need -= give;
      }
    }
    next[index] += want - need;
  } else if (deltaPx < 0) {
    let need = Math.min(-deltaPx, maxCell - next[index + 1]);
    const want = need;
    for (let j = index; j >= 0 && need > 0.5; j--) {
      if (collapsed[j]) continue;
      const give = Math.min(need, next[j] - minCell);
      if (give > 0) {
        next[j] -= give;
        need -= give;
      }
    }
    next[index + 1] += want - need;
  }
  return next;
}

export function findGroupLocation(
  layout: DockLayout,
  groupId: GroupId,
): GroupLocation | null {
  for (const edge of ["left", "right"] as DockEdge[]) {
    const tree = layout.docked[edge];
    if (tree === null) continue;
    const nodeId = treeFindGroupNodeId(tree, groupId);
    if (nodeId !== null) return { kind: "docked", edge, nodeId };
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

/** Remove a group from wherever it currently lives, mutating `draft` in place.
 * The group object itself stays in `draft.groups`; the caller re-inserts it
 * elsewhere (or deletes it). Empty splits and empty floating windows are
 * cleaned up. */
function detachInPlace(draft: DockLayout, groupId: GroupId): void {
  const loc = findGroupLocation(draft, groupId);
  if (loc === null) return;
  // The minimize-all restore tag belongs to the stack the group is LEAVING:
  // in its next home, "expand this stack" shouldn't resurrect state from the
  // old one (a relocated fully-minimized stack just expands everything).
  delete draft.groups[groupId]?.collapsedByParent;
  // An area group is a fixed fixture -- it is never moved or removed. Panels are
  // added to / torn out of it individually; the group itself stays put (this
  // should not be reached, since area groups are only ever drop TARGETS or the
  // source of a tearOutPane, never floated as a whole -- but guard anyway).
  if (loc.kind === "area") return;
  if (loc.kind === "docked") {
    const tree = draft.docked[loc.edge];
    draft.docked[loc.edge] =
      tree === null ? null : treeRemoveGroup(tree, groupId);
    const after = draft.docked[loc.edge];
    if (after !== null) draft.docked[loc.edge] = normalizeTree(after);
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

export function makeGroup(paneIds: PaneId[]): TabGroup {
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

function makeLeaf(groupId: GroupId, weight = 1): DockNode {
  return { type: "leaf", id: freshId("node"), group: groupId, weight };
}

/** Build a dock subtree from an ordered list of groups: a single leaf for one
 * group, or a vertical (column) split for several -- so a snapped floating
 * stack keeps its top-to-bottom arrangement when docked. */
function buildColumnSubtree(groupIds: GroupId[]): DockNode {
  if (groupIds.length === 1) return makeLeaf(groupIds[0]);
  return {
    type: "split",
    id: freshId("node"),
    dir: "column",
    weight: 1,
    children: groupIds.map((g) => makeLeaf(g)),
  };
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
  if (groupIds.length === 0) return layout;
  const draft = clone(layout);
  groupIds.forEach((g) => detachInPlace(draft, g));
  const subtree = buildColumnSubtree(groupIds);
  const existing = draft.docked[edge];
  if (existing === null) {
    draft.docked[edge] = subtree;
  } else {
    const children =
      edge === "left" ? [subtree, existing] : [existing, subtree];
    draft.docked[edge] = normalizeTree({
      type: "split",
      id: freshId("node"),
      dir: "row",
      weight: 1,
      children,
    });
  }
  return draft;
}

/** Dock a stack of groups as a full-span band across the whole region, on the
 * given outer side of everything already docked there. top/bottom wrap the
 * region's tree in a column split (full-width row); left/right wrap it in a row
 * split (full-height column). Optional weights preserve the existing content's
 * size (used by left/right, which grow the region rather than resizing). */
export function dockToRegionEdge(
  layout: DockLayout,
  groupIds: GroupId[],
  edge: DockEdge,
  side: "top" | "bottom" | "left" | "right",
  weights?: { existing: number; dragged: number },
): DockLayout {
  groupIds = withoutAreaGroups(layout, groupIds);
  if (groupIds.length === 0) return layout;
  const draft = clone(layout);
  groupIds.forEach((g) => detachInPlace(draft, g));
  const subtree = buildColumnSubtree(groupIds);
  const existing = draft.docked[edge];
  if (existing === null) {
    draft.docked[edge] = subtree;
    return draft;
  }
  const dir: "row" | "column" =
    side === "top" || side === "bottom" ? "column" : "row";
  const draggedFirst = side === "top" || side === "left";
  // Without explicit weights, start the new split 50/50. The existing subtree's
  // root weight is meaningful only in its OLD context: for a row-rooted region it
  // may be a leftover pixel value from horizontal width reconciliation, which
  // must NOT leak in as a vertical proportion here (a column split) -- otherwise
  // the freshly-docked panel (weight 1) collapses next to a sibling weighted in
  // the hundreds. (For row/left-right docks applyOp rewrites these to px anyway;
  // for column/top-bottom docks it can't, so equalizing here is what keeps the
  // new band at ~50% height.)
  const subtreeW =
    weights !== undefined ? { ...subtree, weight: weights.dragged } : { ...subtree, weight: 1 };
  const existingW =
    weights !== undefined ? { ...existing, weight: weights.existing } : { ...existing, weight: 1 };
  const children = draggedFirst
    ? [subtreeW, existingW]
    : [existingW, subtreeW];
  draft.docked[edge] = normalizeTree({
    type: "split",
    id: freshId("node"),
    dir,
    weight: 1,
    children,
  });
  return draft;
}

/** Drop a stack of groups onto an existing docked leaf. `center` merges every
 * dragged panel into the target's tabs; the four sides split the target's cell,
 * placing the dragged stack (kept together) on that side. */
export function dropOnDockedLeaf(
  layout: DockLayout,
  draggedGroupIds: GroupId[],
  edge: DockEdge,
  targetNodeId: NodeId,
  region: DropRegion,
  /** Optional child weights so callers can preserve absolute sizes (e.g. a
   * left/right split that grows the region keeps the existing panel's width). */
  weights?: { dragged: number; target: number },
): DockLayout {
  draggedGroupIds = withoutAreaGroups(layout, draggedGroupIds);
  if (draggedGroupIds.length === 0) return layout;
  const draft = clone(layout);
  const tree = draft.docked[edge];
  if (tree === null) return layout;
  const targetLeaf = treeFindLeaf(tree, targetNodeId);
  if (targetLeaf === null) return layout;

  if (region === "center") {
    return mergeGroupsInto(layout, targetLeaf.group, draggedGroupIds);
  }

  draggedGroupIds.forEach((g) => detachInPlace(draft, g));
  // Re-find the target leaf AFTER detach. If a dragged group shared this edge,
  // detaching it may have collapsed/removed the target node; if the target is
  // gone (a self-drop), abort rather than dropping the dragged groups into a
  // node that no longer exists (which would orphan them and lose the panes).
  const liveTree = draft.docked[edge];
  if (liveTree === null) return layout;
  const liveTarget = treeFindLeaf(liveTree, targetNodeId);
  if (liveTarget === null) return layout;

  const dw = weights?.dragged ?? 1;
  const tw = weights?.target ?? 1;
  const subtree: DockNode = { ...buildColumnSubtree(draggedGroupIds), weight: dw };
  const keptTarget: DockNode = { ...liveTarget, weight: tw };
  const dir: "row" | "column" =
    region === "left" || region === "right" ? "row" : "column";
  const draggedFirst = region === "left" || region === "top";
  const split: DockNode = {
    type: "split",
    id: freshId("node"),
    dir,
    weight: liveTarget.weight,
    children: draggedFirst ? [subtree, keptTarget] : [keptTarget, subtree],
  };
  draft.docked[edge] = normalizeTree(
    treeReplaceNode(liveTree, targetNodeId, split),
  );
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
  target.activeId = target.paneIds.includes(active)
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
  // An empty group's activeId is meaningless (rendering guards on
  // paneIds.length); it becomes real when the first panel is added.
  const group: TabGroup = { id: freshId("group"), paneIds: [], activeId: "" };
  draft.groups[group.id] = group;
  draft.areas = {
    ...(draft.areas ?? {}),
    [areaId]: { id: areaId, group: group.id },
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
  if (group.paneIds.length === 1 || !group.paneIds.includes(group.activeId)) {
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
 * stackWeights carrying the leaves' relative heights. Only PURE columns (all
 * children are leaves -- see isPureColumn) are floatable; anything else is a
 * no-op (windowId null), as is a missing node/edge. An unmergeable panel in
 * the column is safe by construction: each leaf group becomes its own stack
 * entry, so "alone in its group" is preserved. */
export function floatColumn(
  layout: DockLayout,
  edge: DockEdge,
  columnNodeId: NodeId,
  x: number,
  y: number,
  width: number,
  height?: number,
): { layout: DockLayout; windowId: WindowId | null } {
  const tree = layout.docked[edge];
  if (tree === null) return { layout, windowId: null };
  const node = treeFindNode(tree, columnNodeId);
  if (node === null || !isPureColumn(node)) return { layout, windowId: null };
  // Capture order + weights BEFORE detaching (detach restructures the tree).
  // Sequential detachInPlace (by GROUP id) is immune to that restructuring
  // and reuses the standard cleanup invariants (empty tree -> null edge,
  // weight-preserving promotion), unlike a bespoke subtree removal.
  const leaves = node.children as Extract<DockNode, { type: "leaf" }>[];
  const stack = leaves.map((l) => l.group);
  if (stack.some((g) => isAreaGroup(layout, g))) {
    return { layout, windowId: null };
  }
  const stackWeights: Record<GroupId, number> = {};
  leaves.forEach((l) => {
    stackWeights[l.group] = l.weight;
  });

  const draft = clone(layout);
  stack.forEach((g) => detachInPlace(draft, g));
  const win = makeFloatingWindow(x, y, width, stack, height, stackWeights);
  draft.floating.push(win);
  return { layout: draft, windowId: win.id };
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
  // Keep activeId valid when panes remain; if the area is now empty, leave the
  // (stale) activeId -- rendering guards on paneIds.length, so it's harmless.
  if (src.paneIds.length > 0 && src.activeId === paneId)
    src.activeId = src.paneIds[0];
  const newGroup = makeGroup([paneId]);
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

/** Set the flex weights of a split node's children (used by split resizers).
 * `weights` must match the child count; mismatches are ignored. */
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

/** Toggle a group's minimized (collapsed) state. */
export function toggleCollapsed(
  layout: DockLayout,
  groupId: GroupId,
): DockLayout {
  const draft = clone(layout);
  const group = draft.groups[groupId];
  if (group === undefined) return layout;
  group.collapsed = !group.collapsed;
  // The user took individual control; this group no longer belongs to the
  // last minimize-all (see minimizeStack/expandStack).
  delete group.collapsedByParent;
  return draft;
}

/** Expand a collapsed group (no-op when already expanded or unknown). Used
 * after dropping panes INTO a collapsed group: the drop would otherwise land
 * invisibly inside a minimized handle. */
export function expandGroup(layout: DockLayout, groupId: GroupId): DockLayout {
  if (layout.groups[groupId]?.collapsed !== true) return layout;
  const draft = clone(layout);
  draft.groups[groupId].collapsed = false;
  delete draft.groups[groupId].collapsedByParent;
  return draft;
}

/** Minimize every group of a stack (a floating window's stack or a docked
 * column's leaves) -- the stack handle's minimize-all button. Groups that
 * were EXPANDED right now are tagged `collapsedByParent`; groups that were
 * already minimized lose any stale tag. The matching expandStack then
 * restores exactly the min/max mix the user had before THIS click. */
export function minimizeStack(
  layout: DockLayout,
  groupIds: GroupId[],
): DockLayout {
  const needsWork = groupIds.some((gid) => {
    const group = layout.groups[gid];
    return (
      group !== undefined &&
      (group.collapsed !== true || group.collapsedByParent === true)
    );
  });
  if (!needsWork) return layout;
  const draft = clone(layout);
  for (const gid of groupIds) {
    const group = draft.groups[gid];
    if (group === undefined) continue;
    if (group.collapsed !== true) {
      group.collapsed = true;
      group.collapsedByParent = true;
    } else {
      delete group.collapsedByParent;
    }
  }
  return draft;
}

/** Expand a stack from its handle button. Groups tagged by the last
 * minimizeStack expand (restoring the pre-minimize mix); when nothing is
 * tagged (every group was minimized individually) ALL groups expand. */
export function expandStack(
  layout: DockLayout,
  groupIds: GroupId[],
): DockLayout {
  const present = groupIds
    .map((gid) => layout.groups[gid])
    .filter((g): g is TabGroup => g !== undefined);
  const tagged = present.filter((g) => g.collapsedByParent === true);
  const targets = tagged.length > 0 ? tagged : present;
  if (
    !targets.some(
      (g) => g.collapsed === true || g.collapsedByParent === true,
    )
  ) {
    return layout;
  }
  const draft = clone(layout);
  for (const target of targets) {
    const group = draft.groups[target.id];
    group.collapsed = false;
    delete group.collapsedByParent;
  }
  return draft;
}

/** Set node weights by node id (anywhere in a docked region's tree). Robust to
 * synthetic/partial subtrees: callers pass {nodeId: weight} for the nodes they
 * resized, and we write them onto the matching real nodes in the full tree. */
export function setNodeWeights(
  layout: DockLayout,
  edge: DockEdge,
  weightsById: Record<NodeId, number>,
): DockLayout {
  const tree = layout.docked[edge];
  if (tree === null) return layout;
  // Fast path for the per-frame resize hot path: when every target weight
  // already matches (the cursor paused), skip the full-layout clone entirely
  // and let applyOp's downstream see an unchanged layout.
  let changes = false;
  const scan = (node: DockNode): void => {
    const w = weightsById[node.id];
    if (w !== undefined && Number.isFinite(w) && w > 0 && node.weight !== w)
      changes = true;
    if (node.type === "split") node.children.forEach(scan);
  };
  scan(tree);
  if (!changes) return layout;
  const draft = clone(layout);
  const apply = (node: DockNode): void => {
    const w = weightsById[node.id];
    if (w !== undefined && Number.isFinite(w) && w > 0) node.weight = w;
    if (node.type === "split") node.children.forEach(apply);
  };
  apply(draft.docked[edge]!);
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

/** Server placement for a standalone panel. Aliased from the GENERATED wire type
 * (Python `GuiDockPlacement`) so the two can't drift -- a change to the Python
 * placement shape flows through `WebsocketMessages.ts` to here automatically. */
export type PanelPlacement = NonNullable<
  GuiPanelMessage["props"]["placement"]
>;
export type PanelPlacementPosition = PanelPlacement["position"];

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
 * the server added are appended (in server order); panes the server removed are
 * dropped; `activeId` is kept unless it was removed. Does NOT reorder existing
 * panes to match the server (the user may have reordered tabs locally). */
function reconcileMembershipInPlace(group: TabGroup, paneIds: PaneId[]): void {
  const wanted = new Set(paneIds);
  // Keep current panes that still exist (preserves user order), then append any
  // newly-added server panes not already present (in server order).
  const kept = group.paneIds.filter((p) => wanted.has(p));
  const added = paneIds.filter((p) => !group.paneIds.includes(p));
  group.paneIds = [...kept, ...added];
  if (group.paneIds.length > 0 && !group.paneIds.includes(group.activeId)) {
    group.activeId = group.paneIds[0];
  }
}

/** Ensure this panel's panes live together in a single group, returning that
 * group's id. Creates the group (initially unplaced) if the panes aren't placed
 * yet; if they're already grouped, reuses it and reconciles membership.
 * `startCollapsed` is a ONE-SHOT initial hint applied only when the group is
 * first created (the user owns the collapsed state thereafter). */
function ensurePanelGroup(
  draft: DockLayout,
  paneIds: PaneId[],
  startCollapsed: boolean,
): GroupId | null {
  if (paneIds.length === 0) return null;
  const groupId = panelGroupOf(draft, paneIds);
  if (groupId === null) {
    const group = makeGroup(paneIds);
    if (startCollapsed) group.collapsed = true;
    draft.groups[group.id] = group;
    return group.id;
  }
  // A placement command re-assembles the WHOLE panel into its home group. Any
  // pane the user dragged out into another group/window is MOVED back here via
  // the single move primitive (detach-then-insert), so a pane can't be left in
  // two places. reconcileMembershipInPlace then drops any panes no longer in the
  // panel and fixes order/activeId.
  for (const paneId of paneIds) movePaneInPlace(draft, paneId, groupId);
  reconcileMembershipInPlace(draft.groups[groupId], paneIds);
  return groupId;
}

/** Reconcile a standalone panel's group membership (tabs added/removed) WITHOUT
 * repositioning it. Used on tab-list changes so a user-moved panel isn't yanked
 * back to its server placement just because a tab was added. No-op until the
 * panel's group exists (placement creates it). */
export function reconcilePanelMembership(
  layout: DockLayout,
  paneIds: PaneId[],
): DockLayout {
  if (paneIds.length === 0) return layout;
  const groupId = panelGroupOf(layout, paneIds);
  if (groupId === null) return layout;
  const draft = clone(layout);
  reconcileMembershipInPlace(draft.groups[groupId], paneIds);
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

/** Apply a server `placement` to a standalone panel, (re)positioning it.
 *
 * `paneIds` are the panel's tabs (its container ids), `anchorGroupOf` maps an
 * anchor panel uuid to its current group id (the caller knows how to resolve
 * both standalone panels and the control panel). Idempotent-ish: re-applying
 * the same placement detaches and re-docks, which is a no-op in practice.
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
 * - `expandByDefault` (default true): one-shot initial collapsed hint, applied
 *   only when the panel's group is first created.
 * - `prevPosition`: the position from the LAST applied placement. When it equals
 *   the incoming position, this is a SIZE-ONLY re-placement (e.g. set_width
 *   re-sends the coalesced placement, whose `position` is unchanged) -- so a
 *   panel the user has locally moved (e.g. torn a docked panel out to a float)
 *   must NOT be relocated; only its size is applied. A genuine position CHANGE
 *   (dock_left after dock_right) still relocates. The float branch enforces this
 *   per-window via the `anchor` flag; edge/split have no per-panel ownership bit,
 *   so they compare positions instead.
 */
/** Whether two placement positions are the same (so a re-placement that only
 * changed width/height -- a set_width/set_height -- can be detected and left from
 * relocating the panel). */
function positionsEqual(
  a: PanelPlacement["position"] | undefined,
  b: PanelPlacement["position"],
): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (a.kind !== b.kind) return false;
  if (a.kind === "edge" && b.kind === "edge") return a.edge === b.edge;
  if (a.kind === "float" && b.kind === "float")
    return a.x === b.x && a.y === b.y;
  if (a.kind === "split" && b.kind === "split")
    return a.anchor_uuid === b.anchor_uuid && a.side === b.side;
  return false;
}

export function applyPanelPlacement(
  layout: DockLayout,
  paneIds: PaneId[],
  placement: PanelPlacement,
  anchorGroupOf: (uuid: string) => GroupId | null,
  opts: {
    floatIfUnplaced?: boolean;
    canvasBounds?: CanvasBounds;
    expandByDefault?: boolean;
    prevPosition?: PanelPlacement["position"];
  } = {},
): DockLayout {
  const floatIfUnplaced = opts.floatIfUnplaced ?? true;
  const bounds: CanvasBounds = opts.canvasBounds ?? {
    width: 0,
    height: 0,
    leftInset: 0,
    rightInset: 0,
  };
  const expandByDefault = opts.expandByDefault ?? true;
  if (paneIds.length === 0) return layout;
  let draft = clone(layout);
  const groupId = ensurePanelGroup(draft, paneIds, !expandByDefault);
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
      // Skip the re-dock when the group is ALREADY docked on this edge: a
      // size-only re-placement (set_width) re-runs this branch, and re-docking
      // would detach + recreate the leaf with a fresh node id -- which makes the
      // width reconciler treat it as a new column and reset its width to the
      // default, dropping the requested width (and needlessly reordering a
      // multi-panel region). Leaving it in place keeps the column id stable so
      // the size branch below applies the new width.
      const alreadyHere = loc?.kind === "docked" && loc.edge === position.edge;
      // Relocate only on a genuine position CHANGE. When the position is
      // unchanged (a size-only re-placement, e.g. set_width re-sending the
      // coalesced placement), leave the panel where it is -- so a panel the user
      // locally tore out to a float isn't yanked back to the server's edge; the
      // size branch below still resizes it in place.
      const positionChanged = !positionsEqual(opts.prevPosition, position);
      if (!alreadyHere && positionChanged)
        draft = dockToEdge(draft, [groupId], position.edge);
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
    } else if (!positionsEqual(opts.prevPosition, position)) {
      // split: dock above/below the anchor's docked leaf. Fall back to a right
      // edge dock when the anchor isn't docked (floating / not yet placed).
      // Guarded by a genuine position change, like the edge branch: a size-only
      // re-placement (set_width) must not re-split a panel the user has moved.
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
    }
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

  return draft;
}
