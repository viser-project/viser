// Renderer for a docked region. The model is a FIXED three-level shape, so the
// renderer is too -- no recursion, no `topLevel` flag, no minimized-strip
// dispatch tangle:
//
//   RegionView   maps region.columns  -> a horizontal flex row of columns,
//                with draggable vertical dividers between side-by-side columns;
//   ColumnShell  wraps EVERY column with its float-the-column handle above the
//                body (so a minimized column always keeps a way to expand);
//   ColumnView   maps column.leaves    -> a vertical flex stack of leaves, with
//                draggable horizontal dividers between stacked leaves.
//
// A fully-minimized column renders ColumnShell + VerticalMinimizedColumn (the
// narrow strip); an expanded one renders the stacked leaves. These are NATURAL
// consequences of the shape now, not special cases bolted on.

import { Box, Paper } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { dragGesture } from "./gestures";
import {
  cascadeResize,
  collectLeafGroups,
  expandStack,
  isColumnMinimized,
  isRowMinimized,
  minimizeStack,
  setNodeWeights,
} from "./layoutOps";
import { StackHandleBar } from "./handles";
import { HorizontalMinimizedBand } from "./HorizontalMinimizedBand";
import { TabGroupFrame } from "./TabGroupFrame";
import { VerticalMinimizedColumn } from "./VerticalMinimizedColumn";
import {
  DockColumn,
  DockEdge,
  DockLeaf,
  DockRegion,
  DockRow,
  MIN_REGION_GRAB_PX,
  MINIMIZED_STRIP_PX,
  SPLIT_DIVIDER_PX,
} from "./types";

// Minimum height for a stacked (column) cell; row cells use the per-panel width.
const MIN_CELL_HEIGHT_PX = 50;

// Pointer grab width for a split divider. The divider only DRAWS a 1px rule (and
// reserves SPLIT_DIVIDER_PX of layout), but an invisible overlay widens the grab
// zone to this so it's comfortable to hit without thickening the seam.
const DIVIDER_GRAB_PX = 12;

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
  const containerRef = React.useRef<HTMLDivElement>(null);
  const rows = region.rows;
  // Per-band collapsed mask, computed ONCE: the band map, the strip decision,
  // and every divider's resizable check all read it (instead of re-walking each
  // band's leaves via isRowMinimized 1-3x per render). regionHasExpanded is
  // "some band not minimized" -- when the WHOLE region is minimized it collapses
  // to the compact vertical rail (the "collapsed region" affordance) rather than
  // a stack of full-width horizontal bars squeezed into strip width; the
  // horizontal bar is only for a band minimized BESIDE expanded sibling bands.
  // (regionHasExpanded == regionPlan's anyBandExpanded == !isRegionMinimized; it
  // is recomputed here from the mask we already need, not threaded from the plan,
  // which is widthRow-shaped -- see regionPlan.RegionPlan.anyBandExpanded.)
  const bandMinimized = rows.map((r) => isRowMinimized(r, groups));
  const regionHasExpanded = bandMinimized.some((m) => !m);

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
        // A fully-minimized band (every column minimized) shrinks to a fixed
        // strip HEIGHT so the other bands reclaim the space -- NOT to 0, which
        // would make the strip overflow its (zero-height) box and slip behind
        // the full-height region wrapper, stranding its expand button. A LONE
        // minimized band still fills the region height (a full-height vertical
        // rail), matching the column rule where a lone strip fills the width.
        // A band is a fixed-height horizontal STRIP only when it's collapsed AND
        // some OTHER band is expanded (so the region is at content width). A lone
        // collapsed band, or an all-collapsed region, instead fills its share of
        // height and renders the vertical rail (compact collapsed region),
        // avoiding squished 36x36 bars when the region has no width.
        // (regionHasExpanded already implies !loneBand here: a lone collapsed
        // band is the whole region minimized, so regionHasExpanded is false.)
        const stripBand = bandMinimized[index] && regionHasExpanded;
        return (
          <React.Fragment key={row.id}>
            <Box
              style={{
                flexGrow: stripBand ? 0 : row.weight,
                flexShrink: stripBand ? 0 : 1,
                flexBasis: stripBand ? MINIMIZED_STRIP_PX : 0,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
              }}
            >
              {/* A collapsed band among siblings renders as a full-width
              horizontal bar (the band-level analog of the column rail); a lone
              band -- or an expanded one -- renders its columns normally. */}
              {stripBand ? (
                <HorizontalMinimizedBand row={row} edge={edge} />
              ) : (
                <RowView row={row} edge={edge} />
              )}
            </Box>
            {index < rows.length - 1 &&
              (() => {
                // The band divider resizes only when a non-collapsed band sits
                // on both sides of it (reusing the per-band collapsed mask).
                const topResizable = bandMinimized
                  .slice(0, index + 1)
                  .some((m) => !m);
                const botResizable = bandMinimized
                  .slice(index + 1)
                  .some((m) => !m);
                return (
                  <SplitDivider
                    dir="column"
                    resizable={topResizable && botResizable}
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
                        minCell: MIN_CELL_HEIGHT_PX,
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
function RowView({ row, edge }: { row: DockRow; edge: DockEdge }) {
  const dock = useDock();
  const groups = dock.groups;
  const containerRef = React.useRef<HTMLDivElement>(null);
  const columns = row.columns;

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
        // A fully-minimized column shrinks to a compact strip width instead of
        // holding a full-width empty box. Its weight is preserved for restore.
        const collapsedInRow = isColumnMinimized(column, groups);
        return (
          <React.Fragment key={column.id}>
            <Box
              style={{
                flexGrow: collapsedInRow ? 0 : column.weight,
                flexShrink: collapsedInRow ? 0 : 1,
                flexBasis: collapsedInRow ? MINIMIZED_STRIP_PX : 0,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
              }}
            >
              <ColumnShell column={column} edge={edge} />
            </Box>
            {index < columns.length - 1 &&
              (() => {
                const isCollapsed = (c: DockColumn) =>
                  isColumnMinimized(c, groups);
                const leftResizable = columns
                  .slice(0, index + 1)
                  .some((c) => !isCollapsed(c));
                const rightResizable = columns
                  .slice(index + 1)
                  .some((c) => !isCollapsed(c));
                return (
                  <SplitDivider
                    dir="row"
                    resizable={leftResizable && rightResizable}
                    containerRef={containerRef}
                    onResize={(deltaPx, containerPx) =>
                      resizeCells({
                        dock,
                        edge,
                        cells: columns,
                        collapsed: columns.map(isCollapsed),
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
                );
              })()}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

/** Every column's chrome: the float-the-column handle above its body. The body
 * is the stacked leaves when expanded, or the narrow VerticalMinimizedColumn
 * strip when fully minimized. EVERY column gets this shell (no `topLevel` gate),
 * so a minimized column -- at any position -- always keeps an expand handle. */
function ColumnShell({ column, edge }: { column: DockColumn; edge: DockEdge }) {
  const groups = useDock().groups;
  const minimized = isColumnMinimized(column, groups);
  return (
    <Box
      data-dock-column={column.id}
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {/* The float-the-whole-column handle is only meaningful for a 2+ stack: a
      single-leaf column's own grip bar already drags it and toggles its
      minimize, so a column handle there would be redundant chrome. */}
      {column.leaves.length >= 2 && (
        <ColumnHandle column={column} edge={edge} />
      )}
      <Box style={{ flexGrow: 1, minHeight: 0, minWidth: 0, display: "flex" }}>
        {minimized ? (
          <VerticalMinimizedColumn column={column} edge={edge} />
        ) : (
          <ColumnView column={column} edge={edge} />
        )}
      </Box>
    </Box>
  );
}

/** Slim header at the top of a column: dragging it floats the WHOLE column as
 * one stacked window, then drags it. Mirrors the floating multi-stack window
 * header (FloatingWindowView), including the minimize-all button (which
 * collapses the column to a vertical strip; the handle's + or the cells expand
 * panes back out). */
function ColumnHandle({ column, edge }: { column: DockColumn; edge: DockEdge }) {
  const dock = useDock();
  const groupIds = collectLeafGroups(column);
  const minimized = isColumnMinimized(column, dock.groups);
  const toggle = () =>
    dock.api.apply((l) =>
      minimized ? expandStack(l, groupIds) : minimizeStack(l, groupIds),
    );
  return (
    <StackHandleBar
      attrs={{ "data-dock-column-handle": column.id }}
      // A motionless press toggles minimize-all (the + button is dragThrough,
      // so its press arms this gesture); motion drags the whole column out.
      onPointerDown={(event) =>
        dock.startColumnDrag(event, edge, column.id, { onClick: toggle })
      }
      collapsed={minimized}
      // A fully-minimized column renders as a ~36px strip: no room for the pill,
      // the button fills the bar instead.
      narrow={minimized}
      onToggle={toggle}
    />
  );
}

/** Render an expanded column: a vertical stack of leaves with horizontal
 * dividers between them. */
function ColumnView({ column, edge }: { column: DockColumn; edge: DockEdge }) {
  const dock = useDock();
  const groups = dock.groups;
  const containerRef = React.useRef<HTMLDivElement>(null);
  const leaves = column.leaves;

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
      {leaves.map((leaf, index) => {
        // A fully-minimized leaf collapses to just its handle (content height ->
        // 0) so its siblings expand to fill. Its weight is preserved in the
        // model and restored when expanded.
        const collapsed = groups[leaf.group]?.collapsed === true;
        return (
          <React.Fragment key={leaf.id}>
            <Box
              style={{
                flexGrow: collapsed ? 0 : leaf.weight,
                flexShrink: collapsed ? 0 : 1,
                flexBasis: collapsed ? "auto" : 0,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
              }}
            >
              <DockLeafView leaf={leaf} edge={edge} />
            </Box>
            {index < leaves.length - 1 &&
              (() => {
                const leftResizable = leaves
                  .slice(0, index + 1)
                  .some((l) => groups[l.group]?.collapsed !== true);
                const rightResizable = leaves
                  .slice(index + 1)
                  .some((l) => groups[l.group]?.collapsed !== true);
                return (
                  <SplitDivider
                    dir="column"
                    resizable={leftResizable && rightResizable}
                    containerRef={containerRef}
                    onResize={(deltaPx, containerPx) =>
                      resizeCells({
                        dock,
                        edge,
                        cells: leaves,
                        collapsed: leaves.map(
                          (l) => groups[l.group]?.collapsed === true,
                        ),
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
  minCell: number;
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
