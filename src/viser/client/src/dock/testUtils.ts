// Shared scaffolding for the dock unit tests: tree/group builders, the compact
// layout constructor + shape descriptor used by the structural tests, and small
// utilities (synthetic DOMRect, seeded PRNG, group reference counting).

import {
  DockColumn,
  DockLayout,
  DockLeaf,
  DockRegion,
  DockRow,
  FloatingWindow,
  GroupId,
  NodeId,
  NonEmpty,
  PaneId,
  TabGroup,
  emptyLayout,
  windowHeight,
} from "./types";

/** All columns of a region, flattened across its row bands. */
function regionColumns(region: DockRegion): DockColumn[] {
  return region.rows.flatMap((r) => r.columns);
}

// ---------------------------------------------------------------------------
// Tree builders. The docked model is a fixed 3-level shape (Region = row of
// columns; Column = stack of leaves; Leaf = one group), so the builders mirror
// it: leaf() -> a leaf, col() -> a column of leaves, row() -> a region of
// columns. For terseness a bare leaf or a bare col() is also a valid region (a
// region of one column / one leaf), so `dockedLeft(leaf("a"))` and
// `dockedLeft(col([leaf("a"), leaf("b")]))` both work -- they're coerced to a
// DockRegion by toRegion(). Ids are deterministic + unique.
// ---------------------------------------------------------------------------
let nodeSeq = 0;
export function nid(): string {
  nodeSeq += 1;
  return `n${nodeSeq}`;
}

/** A builder spec: a tree of leaves/columns/rows/regions that toRegion()
 * flattens into the fixed 4-level DockRegion shape (Region = column of rows;
 * Row = row of columns; Column = stack of leaves). */
export type TreeSpec =
  | { kind: "leaf"; leaf: DockLeaf }
  | { kind: "col"; column: DockColumn }
  | { kind: "row"; row: DockRow }
  | { kind: "region"; rows: NonEmpty<DockRow> };

export function leaf(group: GroupId, weight = 1): TreeSpec {
  return { kind: "leaf", leaf: { id: nid(), group, weight } };
}

/** A column = a vertical stack of leaves. Children must be leaves (the model has
 * no column-in-column nesting). */
export function col(children: TreeSpec[], weight = 1): TreeSpec {
  const leaves = children.map((c) => {
    if (c.kind !== "leaf")
      throw new Error("col() children must be leaf() (no nesting in the flat model)");
    return c.leaf;
  });
  return {
    kind: "col",
    column: { id: nid(), weight, leaves: leaves as NonEmpty<DockLeaf> },
  };
}

/** A row band = side-by-side columns. Each child becomes a column: a leaf()
 * child is a one-leaf column, a col() child is its column. */
export function row(children: TreeSpec[], weight = 1): TreeSpec {
  const columns = children.map((c) => specToColumn(c));
  return {
    kind: "row",
    row: { id: nid(), weight, columns: columns as NonEmpty<DockColumn> },
  };
}

/** A region = vertically stacked row bands (the 4th level). Each child becomes a
 * row band: a row() child is its row, anything else is wrapped in a one-column
 * row. */
export function rows(children: TreeSpec[]): TreeSpec {
  const bands = children.map((c) => specToRow(c));
  return { kind: "region", rows: bands as NonEmpty<DockRow> };
}

/** Coerce a spec into a single column (a leaf becomes a one-leaf column). */
function specToColumn(spec: TreeSpec): DockColumn {
  if (spec.kind === "leaf")
    return { id: nid(), weight: spec.leaf.weight, leaves: [spec.leaf] };
  if (spec.kind === "col") return spec.column;
  throw new Error("a column cannot contain a row/region (deeper than the model)");
}

/** Coerce a spec into a single row band (a leaf/col becomes a one-column row). */
function specToRow(spec: TreeSpec): DockRow {
  if (spec.kind === "row") return spec.row;
  if (spec.kind === "region")
    throw new Error("a row cannot nest a region (deeper than the model)");
  return { id: nid(), weight: 1, columns: [specToColumn(spec)] };
}

/** Coerce a spec into a DockRegion: a leaf/col/row is a single-band region; a
 * region spec is itself. */
export function toRegion(spec: TreeSpec | null): DockRegion | null {
  if (spec === null) return null;
  if (spec.kind === "region") return { rows: spec.rows };
  return { rows: [specToRow(spec)] };
}

/** A leaf spec's leaf id (the node id a docked drop target / split addresses). */
export function leafIdOf(spec: TreeSpec): NodeId {
  if (spec.kind !== "leaf") throw new Error("leafIdOf expects a leaf() spec");
  return spec.leaf.id;
}

/** A column id for a col() spec, or the (one-leaf) column id for a leaf() spec
 * wrapped as a column. The node id floatColumn / a column handle addresses. */
export function columnIdOf(spec: TreeSpec): NodeId {
  return specToColumn(spec).id;
}

/** The leaf ids of a spec, in order (a row's columns' leaves flattened). */
export function leafIdsOf(spec: TreeSpec): NodeId[] {
  const region = toRegion(spec)!;
  return regionColumns(region).flatMap((c) => c.leaves.map((l) => l.id));
}

// ---------------------------------------------------------------------------
// Group builders. `group("a", 2)` holds panes "a.0", "a.1".
// ---------------------------------------------------------------------------
export function group(id: string, panelCount = 1): TabGroup {
  const paneIds = Array.from({ length: panelCount }, (_, i) => `${id}.${i}`);
  return { id, paneIds, activeId: paneIds[0] };
}

/** Record of single-panel groups. (No collapse form: groups carry no collapse
 * state under D38 -- seed container flags on windows/columns/regions.) */
export function groupsRecord(...ids: string[]): Record<GroupId, TabGroup> {
  const out: Record<GroupId, TabGroup> = {};
  for (const id of ids) out[id] = group(id, 1);
  return out;
}

/** Minimal layout with `tree` docked on the left (no groups registered). */
export function dockedLeft(tree: TreeSpec | null): DockLayout {
  return {
    groups: {},
    docked: { left: toRegion(tree), right: null },
    regionCollapsed: { left: false, right: false },
    floating: [],
  };
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
  /** The window's ONE collapse flag (D38). */
  collapsed?: boolean;
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
  if (opts.collapsed !== undefined) w.collapsed = opts.collapsed;
  return w;
}

export function makeLayout(opts: {
  left?: TreeSpec | null;
  right?: TreeSpec | null;
  floating?: {
    id: string;
    stack: GroupId[];
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    collapsed?: boolean;
  }[];
  groups?: Record<string, number>; // name -> panel count (for multi-panel)
}): DockLayout {
  const layout = emptyLayout();
  for (const [name, count] of Object.entries(opts.groups ?? {})) {
    defGroup(layout, name, count);
  }
  layout.docked.left = toRegion(opts.left ?? null);
  layout.docked.right = toRegion(opts.right ?? null);
  layout.floating = (opts.floating ?? []).map(floatingWindow);
  const ensure = (g: GroupId) => {
    if (layout.groups[g] === undefined) defGroup(layout, g, 1);
  };
  const walk = (region: DockRegion | null) => {
    if (region === null) return;
    for (const column of regionColumns(region))
      for (const l of column.leaves) ensure(l.group);
  };
  walk(layout.docked.left);
  walk(layout.docked.right);
  for (const w of layout.floating) w.stack.forEach(ensure);
  return layout;
}

// ---------------------------------------------------------------------------
// Shape description: a compact, id-free representation of a docked region, so
// tests can `toEqual` against expected structure. The flat region is rendered
// back into the old {dir,children}/{leaf} shape (a region of one column is just
// that column; a column of one leaf is just that leaf) so equivalent layouts
// read the same as before the migration. Weights are included when asked.
// ---------------------------------------------------------------------------
export type Shape =
  | { leaf: GroupId; weight?: number }
  | { dir: "row" | "column"; children: Shape[]; weight?: number };

function leafShape(l: DockLeaf, withWeights: boolean): Shape {
  return withWeights ? { leaf: l.group, weight: l.weight } : { leaf: l.group };
}

function columnShape(c: DockColumn, withWeights: boolean): Shape {
  if (c.leaves.length === 1) {
    // A one-leaf column reads as a bare leaf, but carries the COLUMN's weight
    // (its horizontal share) when weights are requested.
    const base = leafShape(c.leaves[0], withWeights);
    return withWeights ? { ...base, weight: c.weight } : base;
  }
  return withWeights
    ? {
        dir: "column",
        weight: c.weight,
        children: c.leaves.map((l) => leafShape(l, true)),
      }
    : { dir: "column", children: c.leaves.map((l) => leafShape(l, false)) };
}

/** A row band rendered to the legacy shape: a one-column row reads as that
 * column; a multi-column row reads as a {dir:"row",children}. */
function rowShape(r: DockRow, withWeights: boolean): Shape {
  if (r.columns.length === 1) {
    const base = columnShape(r.columns[0], withWeights);
    return withWeights ? { ...base, weight: r.weight } : base;
  }
  return withWeights
    ? {
        dir: "row",
        weight: r.weight,
        children: r.columns.map((c) => columnShape(c, true)),
      }
    : { dir: "row", children: r.columns.map((c) => columnShape(c, false)) };
}

export function shapeOf(
  region: DockRegion | null,
  withWeights = false,
): Shape | null {
  if (region === null) return null;
  // A single row band reads as that band (so the common side-by-side region
  // renders exactly like the pre-4-level shape). Multiple bands stack as an
  // outer {dir:"column"} of rows.
  if (region.rows.length === 1) return rowShape(region.rows[0], withWeights);
  return withWeights
    ? {
        dir: "column",
        weight: 1,
        children: region.rows.map((r) => rowShape(r, true)),
      }
    : { dir: "column", children: region.rows.map((r) => rowShape(r, false)) };
}

/** Collect groups in region order (rows top-to-bottom, columns left-to-right,
 * leaves top-to-bottom). */
export function groupsInTree(region: DockRegion | null): GroupId[] {
  if (region === null) return [];
  return regionColumns(region).flatMap((c) => c.leaves.map((l) => l.group));
}

/** Count where a group is referenced across docked regions + floating stacks. */
export function refCount(l: DockLayout, gid: GroupId): number {
  let n = 0;
  for (const region of [l.docked.left, l.docked.right]) {
    if (region === null) continue;
    for (const column of regionColumns(region))
      for (const leaf of column.leaves) if (leaf.group === gid) n++;
  }
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
