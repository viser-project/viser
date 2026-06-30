# Typed dock layout: enforce `Region → Column → Leaf` by construction

## Goal

Make the structural dock invariants **unrepresentable-when-violated** via the type
system, deleting the recurring bug classes from this session:

- leaf-only collapse checks that miss nested subtrees (`[A][B]/[C]` broke),
- `topLevel` threaded through render to decide handle/strip (stuck nested handle),
- regionPlan width vs. render disagreeing on "what are the columns",
- `isPureColumn` / `edgeIsSingleLeaf` / `widthColumns` shape-guessing helpers.

## Current model (the problem)

```ts
interface DockLeaf  { type: "leaf";  id; group; weight; }
interface DockSplit { type: "split"; id; dir: "row"|"column"; children: DockNode[]; weight; }
type DockNode = DockLeaf | DockSplit;        // docked[edge]: DockNode | null
```

Permits ANY shape: a leaf directly in a row, `row>col>row>col…`, single-child
splits. `normalizeTree` + runtime asserts try to keep it sane, but the type lets
every bad shape exist, so every consumer must defensively handle arms that
"shouldn't" occur — and periodically forgets one.

## Proposed model (flat, 3 fixed levels)

```ts
// A docked region on one edge = a ROW of columns. Each column = a STACK of leaves.
// One panel is Region[Column[Leaf]] -- a count of 1, not a special shape.

interface DockLeaf {
  id: NodeId;
  group: GroupId;
  weight: number;           // flex weight within its column (vertical)
}
interface DockColumn {
  id: NodeId;
  leaves: [DockLeaf, ...DockLeaf[]];   // NonEmpty: a column always has >=1 leaf
  weight: number;           // flex weight within the region row (horizontal)
}
interface DockRegion {
  columns: [DockColumn, ...DockColumn[]]; // NonEmpty when present
}
// docked[edge]: DockRegion | null   (null = empty edge)
```

What the TYPES now make impossible (was a runtime concern / bug source):
- a leaf directly in a row → `DockRegion.columns` is `DockColumn[]`, never leaves.
- deep nesting (`row>col>row…`) → no recursion in the type at all.
- the `dir` field → gone; level IS the axis (region=horizontal, column=vertical).
- `topLevel` flag → gone; the renderer is `region.columns.map(col => …)`, every
  column is structurally a column.
- `isPureColumn`, `edgeIsSingleLeaf`, `widthColumns`, `columnExtent`,
  `topColumns`, `treeFindNode`'s recursion → collapse to trivial accessors.

What types still CANNOT enforce (stays a thin runtime check in `commit`):
- NonEmpty leaks through `.filter`/`.slice` (re-assert after deriving lists).
- weights positive / finite.
- the uniform-collapse invariant (a 2+ column is all-min or all-expanded) —
  a cross-leaf value relationship, kept in `normalizeStackCollapse`.

## How the smells dissolve

| Bug this session | Cause | After |
|---|---|---|
| `[A][B]/[C]` height not reclaimed | leaf-only `collapsedInColumn` | `isColumnMinimized(col)` = `col.leaves.every(l => collapsed)`, one well-typed level; no subtree recursion to get wrong |
| stuck nested-column handle | handle gated on `topLevel` | every `DockColumn` renders a ColumnShell; "lone" is `region.columns.length === 1` (a count) |
| regionPlan width≠render | `widthColumns` guesses columns by descending widest child | columns ARE `region.columns`; plan and render iterate the same list |
| divider/cascade mis-accounting | leaf-only collapse map | `region.columns.map(isColumnMinimized)` / `column.leaves.map(collapsed)` |

## Migration surface (measured)

- `layoutOps.ts`: ~54 exported fns; the tree **constructors/mutators** that must
  maintain the shape are the migration core:
  `dockToEdge, dockToRegionEdge, dropOnDockedLeaf, insertTabsInto, removePane,
  tearOutPane, floatGroup/floatColumn (read), mergeGroupsInto, snapToWindowStack,
  reorderTab, setNodeWeights, setRegionWidth, resizeRegionColumns,
  normalizeStackCollapse, applyPanelPlacement`, plus helpers
  `treeRemoveGroup, normalizeTree, buildColumnSubtree, makeLeaf`.
  Pure READERS simplify or delete: `isPureColumn, edgeIsSingleLeaf, widthColumns,
  topColumns, columnExtent, collectLeaves, treeFindNode`.
- Consumers: `SplitView.tsx` (renderer — biggest simplification, `topLevel` gone),
  `regionPlan.ts`, `widthReconciliation.ts`, `VerticalMinimizedColumn.tsx`,
  `TabGroupFrame.tsx`, `layoutInvariants.ts`, `hitTest.ts` (drop-target geometry).
- `cascadeResize` is already axis-agnostic (`number[]` weights) → reused unchanged
  at BOTH the region-row and column-stack levels. Good sign the math survives.

## Plan (de-risked, compiler-driven)

**Step 0 — this doc + your sign-off on the type shape + the one behavior call below.**

**Step 1 — Flip the types, let the compiler enumerate the work.**
Change `types.ts` to the flat model. Every op/consumer that doesn't conform becomes
a TYPE ERROR. The compiler IS the worklist (no guessing which ops violate the
shape). Stub bodies as needed to get a clean error list first.

**Step 2 — Migrate ops to maintain the invariant.**
Constructors wrap correctly (a lone panel → `Region[Column[Leaf]]`); removers
re-wrap (drop empty columns, drop empty region → null). `normalizeTree` becomes
`normalizeRegion`: enforce non-empty + drop-empties + uniform-collapse, NOT
arbitrary flattening. Fix until `tsc` is clean.

**Step 3 — Collapse the renderer + regionPlan.**
`SplitView` → `RegionView`(map columns) → `ColumnView`(map leaves); delete
`topLevel`, the minimized-strip dispatch tangle, and the leaf-only checks.
regionPlan iterates `region.columns` directly.

**Step 4 — Thin the runtime invariant + run the fuzz test.**
`layoutInvariants` keeps only what types can't (NonEmpty after derivations,
weights, uniform-collapse). Existing dock fuzz + e2e are the safety net.

## The one behavior decision needed before Step 2

**Deep nesting becomes unrepresentable.** Today a user could (in principle, via
repeated dock-above/region-edge gestures) build `row>col>row>col…`. The flat
model caps depth at Region→Column→Leaf. Two options:
- (A) Gestures that would nest deeper instead **flatten into the 3-level model**
  (e.g. dock-above inside a column adds a leaf to that column; dock-beside adds a
  column). This is what users actually expect and what the UI mostly already does.
- (B) Forbid such gestures (reject the drop).

Recommend (A). Need to confirm no current, reachable, *used* gesture relies on
deeper nesting (measure during Step 1 via the fuzz test + e2e).

## Risk / rollback

- Risk lives entirely in Step 2 (ops maintaining shape). Mitigated: the compiler
  forces every site, the fuzz test exercises random op sequences against the new
  invariant, the e2e suite pins rendered geometry.
- Rollback: it's a type-and-ops refactor on an unpushed branch; revert the
  commits. No data/persistence format change (the dock layout is in-memory +
  reconstructed from server placement, not serialized to disk).
