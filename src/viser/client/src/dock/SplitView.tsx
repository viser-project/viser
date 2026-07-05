// Renderer for a docked region. The model is a FIXED four-level shape, so the
// renderer is too -- no recursion, no `topLevel` flag, no minimized-strip
// dispatch tangle:
//
//   SplitView    maps region.rows     -> a vertical flex column of bands;
//   RowView      maps row.columns     -> a horizontal flex row of columns,
//                with draggable vertical dividers between side-by-side columns;
//   ColumnView   maps column.leaves   -> a vertical flex stack of leaves, with
//                draggable horizontal dividers between stacked leaves.
//
// A minimized LEAF renders as its 26px bar IN PLACE (D20) -- there is no
// per-column strip form and no band-bar form. The one 36px vertical rail is
// the EXPLICIT region-collapse state (D21): layout.regionCollapsed[edge]
// swaps the whole region for RegionMinimizedRail.

import { Box, Paper } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { dragGesture } from "./gestures";
import { collapseAnim } from "./DockStyles.css";
import {
  cascadeResize,
  expandedFlags,
  isRowMinimized,
  setNodeWeights,
} from "./layoutOps";
import { StackHandleBar } from "./handles";
import { MinimizedBar } from "./MinimizedBar";
import { TabGroupFrame } from "./TabGroupFrame";
import { RegionMinimizedRail } from "./VerticalMinimizedColumn";
import {
  DockColumn,
  DockEdge,
  DockLeaf,
  DockRegion,
  DockRow,
  GroupId,
  isRegionCollapsedOn,
  MIN_REGION_GRAB_PX,
  MINIMIZED_BAR_PX,
  SPLIT_DIVIDER_PX,
  TabGroup,
} from "./types";

// Minimum height for a stacked (column) cell; row cells use the per-panel width.
const MIN_CELL_HEIGHT_PX = 50;

// Pointer grab width for a split divider. The divider only DRAWS a 1px rule (and
// reserves SPLIT_DIVIDER_PX of layout), but an invisible overlay widens the grab
// zone to this so it's comfortable to hit without thickening the seam.
const DIVIDER_GRAB_PX = 12;

/** A band's minimum rendered height: the tallest column's stack of cells at
 * their render floors -- 26px bars for collapsed leaves, MIN_CELL_HEIGHT_PX
 * for expanded ones -- plus 7px dividers between stacked leaves. Serves both
 * as the band divider's per-band min-cell floor and as a fully-minimized
 * band's NUMERIC flex-basis (auto would not animate; with every leaf
 * collapsed this is exactly the bar-stack height). */
function bandMinPx(row: DockRow, groups: Record<GroupId, TabGroup>): number {
  return Math.max(
    ...row.columns.map((col) =>
      col.leaves.reduce(
        (px, lf, i) =>
          px +
          (groups[lf.group]?.collapsed === true
            ? MINIMIZED_BAR_PX
            : MIN_CELL_HEIGHT_PX) +
          (i > 0 ? SPLIT_DIVIDER_PX : 0),
        0,
      ),
    ),
  );
}

/** Render a docked region: a VERTICAL stack of full-width row bands, with
 * horizontal dividers between them. Each band is a RowView (a horizontal row of
 * columns). The common single-band region is just one RowView filling the
 * height. Memoized -- with a stable dock context, region-width / container-
 * height re-renders of the manager skip the whole docked region. */
export const SplitView = React.memo(function SplitView({
  region,
  edge,
}: {
  region: DockRegion;
  edge: DockEdge;
}) {
  const dock = useDock();
  const groups = dock.groups;
  // D27: a region where every band has ONE column is a single visual
  // column -- the region-level parent handle covers it honestly. Any
  // multi-column band means independent visual columns: each carries its
  // own handle (rendered by RowView), and the region handle is suppressed.
  const columnHandles = !region.rows.every((rw) => rw.columns.length === 1);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const rows = region.rows;
  // Per-band collapsed mask, computed ONCE: the band map and every divider's
  // resizable check read it. A fully-minimized band (every cell a bar)
  // shrinks to its content -- the bars -- by ordinary flex (grow 0), so
  // expanded bands absorb the freed height (edge case 16).
  const bandMinimized = rows.map((r) => isRowMinimized(r, groups));
  const { atOrBefore: expandedAtOrBefore, after: expandedAfter } =
    expandedFlags(bandMinimized);
  // flex-grow semantics: when grow factors sum to <1, flexbox distributes
  // only that FRACTION of the free space (the rest strands as dead area).
  // D12's weight carving produces fractional band weights, so normalize:
  // expanded bands' grow factors always sum to 1. Minimized bands contribute
  // 0 (they hold no flexible height).
  const expandedWeightTotal =
    rows.reduce((s, r, i) => s + (bandMinimized[i] ? 0 : r.weight), 0) || 1;

  // EXPLICITLY collapsed region (D21): the 36px vertical rail, regardless of
  // the per-cell collapse states. Toggled by the region-collapse chevron;
  // expanding a panel from the rail clears the flag (see layoutOps).
  if (isRegionCollapsedOn(dock.layout, edge)) {
    return <RegionMinimizedRail region={region} edge={edge} />;
  }

  return (
    <Box
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {rows.map((row, index) => {
        // A fully-minimized band holds no flexible height: it sizes to its
        // content (its cells' 26px bars) so sibling bands absorb the freed
        // space. Bands ALWAYS render RowView (D20) -- a collapsed cell is a
        // bar in place, not a separate band-bar form.
        const minimized = bandMinimized[index];
        return (
          <React.Fragment key={row.id}>
            <Box
              className={collapseAnim}
              style={{
                flexGrow: minimized ? 0 : row.weight / expandedWeightTotal,
                flexShrink: minimized ? 0 : 1,
                // Numeric when minimized (the tallest column's bar stack),
                // not "auto": auto is not animatable, and the value is the
                // same -- bars are fixed 26px (+7px dividers).
                flexBasis: minimized ? bandMinPx(row, groups) : 0,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
              }}
            >
              <RowView
                row={row}
                edge={edge}
                columnHandles={columnHandles}
              />
            </Box>
            {index < rows.length - 1 &&
              (() => {
                // The band divider resizes only when a non-collapsed band sits
                // on both sides of it (see expandedFlags).
                return (
                  <SplitDivider
                    dir="column"
                    resizable={expandedAtOrBefore[index] && expandedAfter[index]}
                    containerRef={containerRef}
                    onResize={(deltaPx, containerPx) =>
                      resizeCells({
                        dock,
                        edge,
                        cells: rows,
                        collapsed: bandMinimized,
                        index,
                        deltaPx,
                        containerPx,
                        // Per-band floor: a band must fit its tallest
                        // column's cells (expanded 50px / bars 26px +
                        // dividers), or the leaves' own render floors
                        // overflow into the band below.
                        minCell: rows.map((band) => bandMinPx(band, groups)),
                      })
                    }
                    onCancel={() =>
                      dock.api.apply((l) =>
                        setNodeWeights(
                          l,
                          edge,
                          Object.fromEntries(rows.map((r) => [r.id, r.weight])),
                        ),
                      )
                    }
                  />
                );
              })()}
          </React.Fragment>
        );
      })}
    </Box>
  );
});

/** Render one row band: a HORIZONTAL row of columns with vertical dividers
 * between them. (This was the region renderer in the 3-level model; it now
 * renders a single band, with the region stacking bands above it.) */
function RowView({
  row,
  edge,
  columnHandles = false,
}: {
  row: DockRow;
  edge: DockEdge;
  /** Render a parent handle above each column (multi-column regions, D27). */
  columnHandles?: boolean;
}) {
  const dock = useDock();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const columns = row.columns;
  // Columns always hold their width (D20): a fully-minimized column shows its
  // bars at the top with empty space below -- honest geometry -- so every
  // column participates in the grow normalization and in resizes.
  const colWeightTotal = columns.reduce((s, c) => s + c.weight, 0) || 1;

  return (
    <Box
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: "row",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {columns.map((column, index) => {
        return (
          <React.Fragment key={column.id}>
            <Box
              data-dock-column={column.id}
              style={{
                flexGrow: column.weight / colWeightTotal,
                flexShrink: 1,
                flexBasis: 0,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              {/* Per-column parent handle (D27): this visual column's own
              drag handle -- floating it preserves the column as a stacked
              window instead of flattening the whole region. Pill only: no
              chevron, since the rail is a whole-edge form that would
              flatten columns (the region handle carries it when the
              region IS one column). */}
              {columnHandles && (
                <StackHandleBar
                  attrs={{ "data-dock-column-handle": column.id }}
                  onPointerDown={(event) =>
                    dock.startColumnDrag(event, edge, column.id)
                  }
                />
              )}
              <Box style={{ flexGrow: 1, minHeight: 0, display: "flex" }}>
                <ColumnView column={column} edge={edge} />
              </Box>
            </Box>
            {index < columns.length - 1 && (
              <SplitDivider
                dir="row"
                resizable
                containerRef={containerRef}
                onResize={(deltaPx, containerPx) =>
                  resizeCells({
                    dock,
                    edge,
                    cells: columns,
                    collapsed: columns.map(() => false),
                    index,
                    deltaPx,
                    containerPx,
                    minCell: MIN_REGION_GRAB_PX,
                  })
                }
                onCancel={() =>
                  dock.api.apply((l) =>
                    setNodeWeights(
                      l,
                      edge,
                      Object.fromEntries(columns.map((c) => [c.id, c.weight])),
                    ),
                  )
                }
              />
            )}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

/** Render an expanded column: a vertical stack of leaves with horizontal
 * dividers between them. */
function ColumnView({ column, edge }: { column: DockColumn; edge: DockEdge }) {
  const dock = useDock();
  const groups = dock.groups;
  const containerRef = React.useRef<HTMLDivElement>(null);
  const leaves = column.leaves;
  // Per-leaf collapsed mask, computed once: the leaf map, every divider's
  // resizable flags, and resizeCells all read it.
  const leafCollapsed = leaves.map((l) => groups[l.group]?.collapsed === true);
  const { atOrBefore: expandedAtOrBefore, after: expandedAfter } =
    expandedFlags(leafCollapsed);
  // Normalize grow factors (fractional sums strand free space).
  const expandedLeafWeightTotal =
    leaves.reduce((s, l, i) => s + (leafCollapsed[i] ? 0 : l.weight), 0) || 1;

  return (
    <Box
      ref={containerRef}
      data-dock-scroll
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        // With the leaves' render floors, a squeezed column (short viewport,
        // many cells) SCROLLS rather than pushing cells past the container
        // where their chrome becomes unreachable (P5) -- mirrors the
        // floating stack's overflow rule (P7). data-dock-scroll lets
        // collectTargets clip leaf rects to the visible box (P1: a
        // scrolled-out leaf must not be a drop target).
        overflowY: "auto",
        overflowX: "hidden",
      }}
    >
      {leaves.map((leaf, index) => {
        // A minimized leaf renders as its 26px bar in place (D20): fixed
        // basis, no grow/shrink, so its siblings absorb the freed height. Its
        // weight is preserved in the model and restored when expanded.
        const collapsed = leafCollapsed[index];
        return (
          <React.Fragment key={leaf.id}>
            <Box
              className={collapseAnim}
              style={{
                flexGrow: collapsed
                  ? 0
                  : leaf.weight / expandedLeafWeightTotal,
                flexShrink: collapsed ? 0 : 1,
                flexBasis: collapsed ? MINIMIZED_BAR_PX : 0,
                minWidth: 0,
                // Expanded cells never render below their own chrome
                // (spec 6): repeated same-target splits halve weights
                // geometrically, and without a floor the smallest cell
                // clips its grip bar + tab strip. Mirrors the floating
                // stack's MIN_STACK_CELL_PX floor (P7).
                minHeight: collapsed ? 0 : MIN_CELL_HEIGHT_PX,
                display: "flex",
                // Children render at their committed size the moment the
                // model changes; the wrapper's size catches up over the
                // transition, so clip the overhang.
                overflow: "hidden",
              }}
            >
              <DockLeafView leaf={leaf} edge={edge} />
            </Box>
            {index < leaves.length - 1 &&
              (() => {
                return (
                  <SplitDivider
                    dir="column"
                    resizable={expandedAtOrBefore[index] && expandedAfter[index]}
                    containerRef={containerRef}
                    onResize={(deltaPx, containerPx) =>
                      resizeCells({
                        dock,
                        edge,
                        cells: leaves,
                        collapsed: leafCollapsed,
                        index,
                        deltaPx,
                        containerPx,
                        minCell: MIN_CELL_HEIGHT_PX,
                      })
                    }
                    onCancel={() =>
                      dock.api.apply((l) =>
                        setNodeWeights(
                          l,
                          edge,
                          Object.fromEntries(leaves.map((lf) => [lf.id, lf.weight])),
                        ),
                      )
                    }
                  />
                );
              })()}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

/** Shared cascade-resize commit for both levels (columns in a region row,
 * leaves in a column stack). The math is axis-agnostic (cascadeResize works on
 * `number[]` weights), so the only per-axis input is the cell list, the
 * collapsed mask, and the min-cell floor. Collapsed cells aren't resized, but
 * their preserved weight is rescaled onto the same px basis as their resized
 * siblings -- or, on expand, a now-tiny flex-unit weight next to px-magnitude
 * siblings would collapse the cell to ~0. */
function resizeCells(opts: {
  dock: ReturnType<typeof useDock>;
  edge: DockEdge;
  cells: readonly { id: string; weight: number }[];
  collapsed: boolean[];
  index: number;
  deltaPx: number;
  containerPx: number;
  minCell: number | number[];
}): void {
  const { dock, edge, cells, collapsed, index, deltaPx, containerPx, minCell } =
    opts;
  const next = cascadeResize({
    weights: cells.map((c) => c.weight),
    collapsed,
    containerPx,
    dividerIndex: index,
    deltaPx,
    minCell,
    // No per-cell cap -- a cell may grow as far as its siblings' mins allow.
    maxCell: Infinity,
  });
  if (next === null) return;
  const totalAll = cells.reduce((s, c) => s + c.weight, 0) || 1;
  const byId: Record<string, number> = {};
  cells.forEach((c, i) => {
    byId[c.id] = collapsed[i]
      ? (c.weight / totalAll) * containerPx
      : next[i];
  });
  dock.api.apply((l) => setNodeWeights(l, edge, byId));
}

function DockLeafView({ leaf, edge }: { leaf: DockLeaf; edge: DockEdge }) {
  // No border (the top border in particular reads as ugly against the canvas);
  // panes are separated from the canvas by the region's shadow and from each
  // other by the split dividers.
  return (
    <Paper
      data-dock-leaf={leaf.id}
      data-dock-edge={edge}
      radius={0}
      style={{
        flexGrow: 1,
        minWidth: 0,
        minHeight: 0,
        // Column flex so the group inside controls its own HEIGHT via flexGrow
        // (a row parent would make flexGrow control width). This lets a docked
        // group's collapse animate as a smooth height change (TabGroupFrame puts
        // a flex transition on the group when filling).
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        backgroundColor: "var(--mantine-color-body)",
      }}
    >
      <DockLeafFrame groupId={leaf.group} />
    </Paper>
  );
}

// Resolve the leaf's group from the manager-provided groups map (via context)
// so leaves don't need the group prop-drilled through the tree.
function DockLeafFrame({ groupId }: { groupId: string }) {
  const group = useDock().groups[groupId];
  if (group === undefined) return null;
  // A minimized group is its bar, in place (D20). The leaf wrapper (Paper)
  // above still carries data-dock-leaf/-edge -- it is the drop target.
  if (group.collapsed === true) return <MinimizedBar group={group} />;
  // Docked leaves can be resized narrower than the panel-content minimum, so
  // their body shows a persistent horizontal scrollbar pinned to the bottom.
  return <TabGroupFrame group={group} stripDragsGroup persistentScrollbar />;
}

/** Draggable divider between two cells. Reports the pointer delta along the
 * split axis plus the container's size, so the parent can convert it into new
 * flex weights. */
function SplitDivider({
  dir,
  resizable,
  containerRef,
  onResize,
  onCancel,
}: {
  dir: "row" | "column";
  /** False when both sides of the divider are minimized strips: nothing can
   * resize, so it shows no resize cursor and ignores drags. */
  resizable: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
  onResize: (deltaPx: number, containerPx: number) => void;
  /** Revert whatever per-frame onResize calls applied (Escape mid-drag). */
  onCancel: () => void;
}) {
  const isRow = dir === "row";
  // Cancel the in-flight gesture if the divider unmounts mid-drag (its region
  // can be restructured by another client), so the window listeners can't fire
  // after unmount.
  const activeDrag = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => activeDrag.current?.(), []);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!resizable) return; // nothing to resize between minimized strips
    if (activeDrag.current !== null) return; // one drag per divider
    event.stopPropagation();
    const container = containerRef.current;
    if (container === null) return;
    const rect = container.getBoundingClientRect();
    const containerPx = isRow ? rect.width : rect.height;
    const start = isRow ? event.clientX : event.clientY;

    // Per-frame weight writes must land instantly: suppress the
    // minimize/expand transition (collapseAnim) under this container for
    // the drag's duration, or cells ease-lag behind the divider.
    container.setAttribute("data-dock-resizing", "");
    let latest = start;
    activeDrag.current = dragGesture({
      grip: event.currentTarget,
      pointerId: event.pointerId,
      update: (e) => {
        latest = isRow ? e.clientX : e.clientY;
      },
      flush: () => onResize(latest - start, containerPx),
      onEnd: (cancelled) => {
        activeDrag.current = null;
        container.removeAttribute("data-dock-resizing");
        if (cancelled) onCancel();
      },
    });
  };

  // Hit area wider than the divider's layout footprint: the outer box keeps its
  // SPLIT_DIVIDER_PX so the panels don't shift, while an absolutely-positioned
  // overlay extends the grab zone to ~DIVIDER_GRAB_PX (centered, overhanging the
  // adjacent panels' edges by a few px) -- only when resizable. The thin 1px rule
  // is still all that's drawn.
  const overhang = resizable
    ? Math.max(0, (DIVIDER_GRAB_PX - SPLIT_DIVIDER_PX) / 2)
    : 0;
  return (
    <Box
      onPointerDown={onPointerDown}
      style={{
        position: "relative",
        flexShrink: 0,
        [isRow ? "width" : "height"]: SPLIT_DIVIDER_PX,
        cursor: !resizable ? "default" : isRow ? "ew-resize" : "ns-resize",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        touchAction: "none",
        zIndex: 2,
      }}
    >
      {/* Invisible grab overlay (wider than the drawn rule), so the divider is
      easy to grab without thickening the seam. */}
      {resizable && (
        <Box
          style={{
            position: "absolute",
            [isRow ? "top" : "left"]: 0,
            [isRow ? "bottom" : "right"]: 0,
            [isRow ? "left" : "top"]: -overhang,
            [isRow ? "width" : "height"]: SPLIT_DIVIDER_PX + 2 * overhang,
          }}
        />
      )}
      <Box
        style={{
          [isRow ? "width" : "height"]: "1px",
          [isRow ? "height" : "width"]: "100%",
          backgroundColor: "var(--mantine-color-default-border)",
          opacity: 0.5,
        }}
      />
    </Box>
  );
}
