// Renderer for a docked region. The model is a FIXED three-level shape
// (D46: Region = Column[] = Leaf[]), so the renderer is too -- no recursion,
// no band layer:
//
//   SplitView     maps region.columns -> a horizontal flex row of columns,
//                 with draggable vertical dividers between them;
//   ColumnView    maps column.leaves  -> a vertical flex stack of leaves,
//                 with draggable horizontal dividers between stacked leaves.
//
// Docked collapse is the RAIL, per column (D28/D46): a railed column swaps
// for ColumnRail; a fully railed region is simply every column railed --
// the packed reading is derived (isRegionPackedOn, D44), not a separate
// rendering. Leaves are always expanded here -- per-leaf collapse is
// unrepresentable, and bars are a floating-only form.

import { Box, Paper } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { dragGesture, focusDockControl } from "./gestures";
import { collapseAnim } from "./DockStyles.css";
import {
  cascadeResize,
  expandedFlags,
  setNodeWeights,
} from "./layoutOps";
import { ColumnCollapseChevron, StackHandleBar } from "./handles";
import { TabGroupFrame } from "./TabGroupFrame";
import { ColumnRail } from "./VerticalMinimizedColumn";
import {
  DockColumn,
  DockEdge,
  DockLeaf,
  DockRegion,
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

/** Render a docked region (D46: columns only): a horizontal flex row of
 * columns with draggable vertical dividers between them. Each column is a
 * vertical stack of leaves (ColumnView) or, railed, a 36px spine strip
 * (ColumnRail). A fully railed region is just every column rendering its
 * strip -- the packed rail needs no special case (rails stay separate).
 * Memoized -- with a stable dock context, container re-renders of the
 * manager skip the whole docked region. */
export const SplitView = React.memo(function SplitView({
  region,
  edge,
  drawnWidthPx,
}: {
  region: DockRegion;
  edge: DockEdge;
  /** The region's committed rendered width (post canvas-guard scaling).
   * The columns lay out inside a box FIXED at this width while only the
   * region container's width eases (the drawer model): content never
   * reflows mid-transition, and no column moves when a sibling rails --
   * the one moving edge is the region's inner boundary. */
  drawnWidthPx: number;
}) {
  // D27: a single-column region is one visual column -- the region-level
  // parent handle covers it honestly (rendered by DockManager). Any second
  // column means independent visual columns: each carries its own handle
  // here, and the region handle is suppressed.
  const columnHandles = region.columns.length > 1;
  return (
    <RegionColumns
      region={region}
      edge={edge}
      columnHandles={columnHandles}
      drawnWidthPx={drawnWidthPx}
    />
  );
});

function RegionColumns({
  region,
  edge,
  columnHandles = false,
  drawnWidthPx,
}: {
  region: DockRegion;
  edge: DockEdge;
  /** Render a parent handle above each column (multi-column regions, D27). */
  columnHandles?: boolean;
  drawnWidthPx: number;
}) {
  const dock = useDock();
  const containerRef = React.useRef<HTMLDivElement>(null);
  // FLIP slide (D34 rev 2): columns render at their COMMITTED positions
  // instantly (the drawer pane is fixed-width, so there is no mid-ease
  // reflow) -- but a column whose SCREEN position changed (e.g. everything
  // inner of a newly railed outer sibling) would otherwise jump while the
  // container edge eases. Measure each column's previous screen x, start it
  // at a translateX of the difference, and transition the transform to 0 on
  // the same 160ms curve as the container's width ease -- every column
  // GLIDES from old slot to new; unmoved columns get delta 0 and stay
  // perfectly still. Presentation only (P4): the model committed before
  // this runs, reduced-motion and active divider drags skip it, and
  // nothing waits on the transition.
  const prevColumnX = React.useRef<Map<string, number>>(new Map());
  React.useLayoutEffect(() => {
    const root = containerRef.current;
    if (root === null) return;
    const els = Array.from(
      root.querySelectorAll<HTMLElement>(":scope > [data-dock-column]"),
    );
    const skip =
      root.closest("[data-dock-resizing]") !== null ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const next = new Map<string, number>();
    for (const el of els) {
      const id = el.getAttribute("data-dock-column");
      if (id === null) continue;
      // Interruption-friendly "first" position: the live rect includes any
      // in-flight transform, so a retargeted slide continues smoothly.
      const liveX = el.getBoundingClientRect().left;
      el.style.transition = "";
      el.style.transform = "";
      const naturalX = el.getBoundingClientRect().left;
      next.set(id, naturalX);
      const prev = prevColumnX.current.get(id) ?? liveX;
      const delta = prev - naturalX;
      if (skip || Math.abs(delta) < 0.5) continue;
      el.style.transform = `translateX(${delta}px)`;
      // Force the start position before arming the transition.
      void el.offsetWidth;
      el.style.transition = "transform 160ms ease";
      el.style.transform = "";
      el.addEventListener(
        "transitionend",
        () => {
          el.style.transition = "";
        },
        { once: true },
      );
    }
    prevColumnX.current = next;
  });
  const columns = region.columns;
  // Per-column rail mask: a RAILED column renders as a fixed 36px spine
  // strip (its width weight preserved for restore, P8) -- the one exception
  // to "columns always hold their width".
  const columnRailed = columns.map((c) => c.railed === true);
  const { atOrBefore: expandedAtOrBefore, after: expandedAfter } =
    expandedFlags(columnRailed);
  // Railed columns hold no flexible width, so EXPANDED columns' grow factors
  // normalize over expanded weights only -- a fractional grow sum would
  // strand the freed space as dead area (edge case 16).
  const colWeightTotal =
    columns.reduce((s, c, i) => s + (columnRailed[i] ? 0 : c.weight), 0) || 1;

  return (
    <Box
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: "row",
        // Drawer model (D34 rev): the columns lay out at the COMMITTED
        // region width immediately -- only the region container's width
        // eases, revealing/concealing this box from the inner side. Fixing
        // the width here (not 100%) is what keeps content from reflowing
        // and siblings from wobbling during the ease: flex resolves once,
        // to the final geometry.
        width: drawnWidthPx,
        flexShrink: 0,
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {columns.map((column, index) => {
        const railed = columnRailed[index];
        return (
          <React.Fragment key={column.id}>
            <Box
              data-dock-column={column.id}
              // Deliberately NOT animated (D34 rev): the wrapper renders at
              // its committed flex width instantly. The region container's
              // width ease is the ONE transition on this axis -- a second
              // ease here would race it and wobble sibling columns.
              style={{
                flexGrow: railed ? 0 : column.weight / colWeightTotal,
                flexShrink: railed ? 0 : 1,
                flexBasis: railed ? MINIMIZED_STRIP_PX : 0,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                // During the width ease the CONTENT already renders its
                // committed form; clip the reveal (same rule as bars) so
                // the transient never shows final-size icons floating in a
                // wide box -- that flash reads as "weirdly small icons".
                overflow: "hidden",
              }}
            >
              {railed ? (
                // Per-column rail: the column collapsed to its 36px spine
                // strip in place, rendered AT its final width inside the
                // easing wrapper (P1: the content is the committed result;
                // the wrapper only reveals it). Its own narrow header is
                // the parent handle while railed (a separate handle above
                // it would duplicate the signifier, P9).
                <Box
                  style={{
                    width: MINIMIZED_STRIP_PX,
                    flexShrink: 0,
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <ColumnRail column={column} edge={edge} />
                </Box>
              ) : (
                <>
                  {/* Per-column parent handle (D27): this visual column's
                  own drag handle -- floating it preserves the column as a
                  stacked window instead of flattening the whole region. The
                  column-collapse chevron sits at its right end and rails
                  exactly this column, siblings untouched (D46: no
                  accordion). */}
                  {columnHandles && (
                    <StackHandleBar
                      attrs={{ "data-dock-column-handle": column.id }}
                      onPointerDown={(event) =>
                        dock.startColumnDrag(event, edge, column.id, {
                          // A motionless bar click backs the chevron's
                          // action (P9's hit-area rule -- same as the
                          // region handle's bar), INCLUDING the focus
                          // handoff to the rail header's same-spot toggle:
                          // a pointer click routes here (the chevron is
                          // drag-through, T6), and focus must never fall to
                          // <body> (spec 4).
                          onClick: () => {
                            dock.railColumn(edge, column.id, true);
                            focusDockControl(
                              `[data-dock-column-rail="${column.id}"] [data-dock-minimize-all]`,
                            );
                          },
                        })
                      }
                      endControl={
                        <ColumnCollapseChevron
                          edge={edge}
                          columnId={column.id}
                          onActivate={() =>
                            dock.railColumn(edge, column.id, true)
                          }
                        />
                      }
                    />
                  )}
                  <Box style={{ flexGrow: 1, minHeight: 0, display: "flex" }}>
                    <ColumnView column={column} edge={edge} />
                  </Box>
                </>
              )}
            </Box>
            {index < columns.length - 1 && (
              <SplitDivider
                dir="row"
                // A railed column is fixed-width chrome: the divider
                // resizes only when an expanded column sits on both sides
                // of it (D24: only RAILED columns go inert). Its RULE always
                // runs the full region height either way -- a rail column's
                // body is full-height (empty tail included), so the boundary
                // between two columns is too.
                resizable={expandedAtOrBefore[index] && expandedAfter[index]}
                containerRef={containerRef}
                onResize={(deltaPx, containerPx) =>
                  resizeCells({
                    dock,
                    edge,
                    cells: columns,
                    collapsed: columnRailed,
                    collapsedPx: MINIMIZED_STRIP_PX,
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
                      Object.fromEntries(
                        columns.map((c) => [c.id, c.weight]),
                      ),
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
  const containerRef = React.useRef<HTMLDivElement>(null);
  const leaves = column.leaves;
  // D38: leaf-level collapse is unrepresentable (docked collapse is the
  // column/region rail, rendered elsewhere), so every leaf here is
  // expanded and every divider between them resizes.
  // Normalize grow factors (fractional sums strand free space).
  const leafWeightTotal = leaves.reduce((s, l) => s + l.weight, 0) || 1;

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
        return (
          <React.Fragment key={leaf.id}>
            <Box
              className={collapseAnim}
              style={{
                flexGrow: leaf.weight / leafWeightTotal,
                flexShrink: 1,
                flexBasis: 0,
                minWidth: 0,
                // Expanded cells never render below their own chrome
                // (spec 6): repeated same-target splits halve weights
                // geometrically, and without a floor the smallest cell
                // clips its grip bar + tab strip. Mirrors the floating
                // stack's MIN_STACK_CELL_PX floor (P7).
                minHeight: MIN_CELL_HEIGHT_PX,
                display: "flex",
                // Children render at their committed size the moment the
                // model changes; the wrapper's size catches up over the
                // transition, so clip the overhang.
                overflow: "hidden",
              }}
            >
              <DockLeafView leaf={leaf} edge={edge} />
            </Box>
            {index < leaves.length - 1 && (
              <SplitDivider
                dir="column"
                resizable
                containerRef={containerRef}
                onResize={(deltaPx, containerPx) =>
                  resizeCells({
                    dock,
                    edge,
                    cells: leaves,
                    collapsed: leaves.map(() => false),
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
                      Object.fromEntries(
                        leaves.map((lf) => [lf.id, lf.weight]),
                      ),
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

/** Shared cascade-resize commit for both levels (columns in a region,
 * leaves in a column stack). The math is axis-agnostic (cascadeResize works on
 * `number[]` weights), so the only per-axis input is the cell list, the
 * collapsed mask, the fixed chrome px a collapsed cell renders at, and the
 * min-cell floor. Collapsed (railed) cells are fixed-width chrome (D28/D38):
 * their STORED weight is preserved untouched for restore (P8), and their
 * rendered extent is subtracted from the container so the expanded cells'
 * new weights stay on the true px basis. */
function resizeCells(opts: {
  dock: ReturnType<typeof useDock>;
  edge: DockEdge;
  cells: readonly { id: string; weight: number }[];
  collapsed: boolean[];
  /** Rendered px of ONE collapsed cell (the 36px rail strip). Only read
   * where the mask has collapsed cells. */
  collapsedPx?: number;
  index: number;
  deltaPx: number;
  containerPx: number;
  minCell: number;
}): void {
  const { dock, edge, cells, collapsed, index, deltaPx, containerPx, minCell } =
    opts;
  const collapsedCount = collapsed.filter(Boolean).length;
  const next = cascadeResize({
    weights: cells.map((c) => c.weight),
    collapsed,
    containerPx: containerPx - collapsedCount * (opts.collapsedPx ?? 0),
    dividerIndex: index,
    deltaPx,
    minCell,
    // No per-cell cap -- a cell may grow as far as its siblings' mins allow.
    maxCell: Infinity,
  });
  if (next === null) return;
  const byId: Record<string, number> = {};
  cells.forEach((c, i) => {
    // Collapsed cells keep their stored weight (P8: preserved for restore;
    // they render at fixed chrome width regardless).
    if (!collapsed[i]) byId[c.id] = next[i];
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
  // D38: docked cells never render as bars -- a collapsed docked container
  // is the column/region RAIL (rendered by RowView/SplitView), so a leaf
  // that renders here is always the expanded frame. Docked leaves can be
  // resized narrower than the panel-content minimum, so their body shows a
  // persistent horizontal scrollbar pinned to the bottom.
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
      data-dock-divider={dir}
      data-dock-divider-resizable={resizable ? "true" : "false"}
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
      {/* Fix C: an INERT divider (rail-to-rail, resizable=false) must read as
      "no resize here", not as a live handle. Both rules run the FULL seam
      length -- the boundary between two cells spans their whole shared edge,
      empty tails included -- but the inert one is drawn dimmer so users don't
      expect a handle where none exists. */}
      <Box
        data-dock-divider-rule=""
        style={{
          [isRow ? "width" : "height"]: "1px",
          [isRow ? "height" : "width"]: "100%",
          backgroundColor: "var(--mantine-color-default-border)",
          opacity: resizable ? 0.5 : 0.18,
        }}
      />
    </Box>
  );
}
