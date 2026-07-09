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
// Docked collapse is the RAIL, at exactly two scopes (D38/D32): the whole
// region (layout.regionCollapsed[edge] swaps the region for
// RegionMinimizedRail) or one column of a multi-column band (column.railed
// swaps that column for ColumnRail). Leaves are always expanded here --
// per-leaf collapse is unrepresentable, and bars are a floating-only form.

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
import { ColumnRail, RegionMinimizedRail } from "./VerticalMinimizedColumn";
import {
  DockColumn,
  DockEdge,
  DockLeaf,
  DockRegion,
  DockRow,
  isRegionCollapsedOn,
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

// A per-column parent handle's rendered height (StackHandleBar, 1em at the
// root font) -- part of every column's content height in a multi-column
// region (D27), so band floors must count it or a band's box comes up short
// and the next band's chrome paints over (and steals presses from) it.
const COLUMN_HANDLE_PX = 16;

// Height floor for a band whose every column is RAILED: rail spines scroll
// at any height, so the band needs only a usable grab height, not a per-leaf
// sum. Also the all-railed band's divider min-cell floor.
const ALL_RAILED_BAND_MIN_PX = 60;

/** A band is ALL-RAILED when every one of its columns is railed (D41). Such a
 * band sizes to its CONTENT height (its tallest rail spine), not a weighted
 * share -- so it leaves no dead gray below the spine icons and the EXPANDED
 * bands reclaim the freed height. A band with even ONE expanded column is NOT
 * all-railed: it keeps its weighted share (the expanded column fills it,
 * rails beside it are the healthy case). An empty band (no columns) is not
 * all-railed -- it has no rail content to size to. */
function isAllRailed(row: DockRow): boolean {
  return row.columns.length > 0 && row.columns.every((c) => c.railed === true);
}

/** A band's minimum rendered height: the tallest EXPANDED column's stack of
 * cells at their render floors (MIN_CELL_HEIGHT_PX each, plus dividers),
 * used as the band divider's per-band min-cell floor. RAILED columns don't
 * raise the floor -- their spine strips scroll/fit at any height -- so an
 * all-railed band floors at the fixed grab height. */
function bandMinPx(row: DockRow, withColumnHandle: boolean): number {
  const floors = row.columns
    .filter((col) => col.railed !== true)
    .map((col) =>
      col.leaves.reduce(
        (px, _lf, i) =>
          px + MIN_CELL_HEIGHT_PX + (i > 0 ? SPLIT_DIVIDER_PX : 0),
        withColumnHandle ? COLUMN_HANDLE_PX : 0,
      ),
    );
  return floors.length > 0 ? Math.max(...floors) : ALL_RAILED_BAND_MIN_PX;
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
  // D27: a region where every band has ONE column is a single visual
  // column -- the region-level parent handle covers it honestly. Any
  // multi-column band means independent visual columns: each carries its
  // own handle (rendered by RowView), and the region handle is suppressed.
  const columnHandles = !region.rows.every((rw) => rw.columns.length === 1);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const rows = region.rows;
  // D41: an ALL-RAILED band sizes to its CONTENT height (flexGrow 0 +
  // flexBasis auto) instead of a weighted share, so the dead gray below its
  // spine icons collapses. It is CAPPED at the region height (maxHeight
  // 100%) -- a genuinely huge rail scrolls via the rail Paper's own
  // overflowY:auto -- so content-sizing can NEVER squeeze a spine below its
  // content (flexShrink 0 + basis auto grows to fit; the cap only bites the
  // degenerate huge case). Grow normalization then runs over EXPANDED bands
  // only: their weights sum to 1 so the height an all-railed band DIDN'T
  // take is reclaimed by them, never stranded as dead area (edge case 16).
  // (A band with a mix of railed + expanded columns is NOT all-railed -- it
  // keeps its weighted share, the expanded column fills it.)
  const allRailedMask = rows.map((r) => isAllRailed(r));
  // Content-sizing an all-railed band only pays off when there is an EXPANDED
  // band to DONATE the freed height to (D41's win: kill the dead gray beside
  // expanded content). When EVERY band is all-railed there is nowhere to
  // donate: each band would content-size to its tallest spine and the region's
  // lower area sits empty while the bands come out ragged. In that case fall
  // back to the pre-D41 WEIGHTED shares so the bands fill the region uniformly.
  const regionHasExpandedBand = allRailedMask.some((m) => !m);
  // When at least one expanded band exists, all-railed bands content-size and
  // the grow total is over the EXPANDED bands only (they reclaim the freed
  // height). When the region is ALL rail bands, no band content-sizes -- every
  // band takes weight/total, so the total is over ALL bands.
  const bandWeightTotal = regionHasExpandedBand
    ? rows.reduce((s, r, i) => s + (allRailedMask[i] ? 0 : r.weight), 0) || 1
    : rows.reduce((s, r) => s + r.weight, 0) || 1;

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
        // An all-railed band content-sizes (D41) -- but ONLY when the region
        // has an expanded band to donate the freed height to. In an ALL-rails
        // region there is nowhere to donate, so even all-railed bands take a
        // weighted share and fill the region uniformly (Fix A). Every
        // non-all-railed band always takes its weighted share.
        const allRailed = allRailedMask[index];
        const contentSized = allRailed && regionHasExpandedBand;
        return (
          <React.Fragment key={row.id}>
            <Box
              className={collapseAnim}
              style={{
                // D41: a CONTENT-SIZED band (all-railed + an expanded sibling
                // to donate to) does not grow (0 share) and sizes to content
                // (basis auto, no shrink); it is capped at the region height so
                // a huge rail scrolls rather than overflows. Every other band
                // -- expanded/mixed, OR all-railed in an all-rails region (Fix
                // A) -- grows by its normalized weight.
                flexGrow: contentSized ? 0 : row.weight / bandWeightTotal,
                flexShrink: contentSized ? 0 : 1,
                flexBasis: contentSized ? "auto" : 0,
                maxHeight: contentSized ? "100%" : undefined,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
              }}
            >
              <RowView row={row} edge={edge} columnHandles={columnHandles} />
            </Box>
            {index < rows.length - 1 &&
              (() => {
                // D41/D24: a band divider is INERT beside a CONTENT-SIZED
                // band. That band's height is fixed by its content (flexGrow
                // 0), so there is nothing to trade on that side -- dragging
                // would only grow the band back into dead gray or squeeze its
                // spine (a cursor that no-ops lies). Mirrors "a width divider
                // goes inert beside a railed column". In an ALL-rails region no
                // band content-sizes (Fix A: they take weighted shares), so
                // their dividers DO resize like any weighted pair.
                const contentSizedAt = (i: number) =>
                  allRailedMask[i] && regionHasExpandedBand;
                const dividerResizable =
                  !contentSizedAt(index) && !contentSizedAt(index + 1);
                return (
                  <SplitDivider
                    dir="column"
                    resizable={dividerResizable}
                    containerRef={containerRef}
                    onResize={(deltaPx, containerPx) =>
                      resizeCells({
                        dock,
                        edge,
                        cells: rows,
                        collapsed: rows.map(() => false),
                        index,
                        deltaPx,
                        containerPx,
                        // Per-band floor: a band must fit its tallest
                        // expanded column's cells (50px each + dividers),
                        // or the leaves' own render floors overflow into
                        // the band below.
                        minCell: rows.map((band) =>
                          bandMinPx(band, columnHandles),
                        ),
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

  // Fix B: in a multi-column RAIL band, columns with unequal cell counts
  // content-size to different spine heights while every column BOX stretches
  // full-band-height (cross-axis stretch is correct). Left unchecked, the
  // vertical divider rule runs the full band height and visibly OVERSHOOTS
  // past the shorter neighbor's spine into its empty tail -- a border that
  // encloses the tail rather than divides content (violates P10). We measure
  // each railed column's spine CONTENT bottom and cap a rail-to-rail
  // divider's rule to the SHORTER neighbor's content, so the rule stops with
  // content and the empty tails read as plain column body.
  const [railContentPx, setRailContentPx] = React.useState<
    (number | null)[]
  >(() => columns.map(() => null));
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const measure = () => {
      const rootTopOf = (el: HTMLElement) =>
        el.getBoundingClientRect().top;
      const next = columns.map((column) => {
        if (column.railed !== true) return null;
        const root = container.querySelector<HTMLElement>(
          `[data-dock-rail-root="${column.id}"]`,
        );
        if (root === null) return null;
        // The spine content extent is measured relative to the RAIL ROOT's
        // own top (not the row container's) -- the divider rule that consumes
        // it is anchored at the band top, which is the rail root's top. The
        // rail Paper (children[1]) stretches full-band via flexGrow, so its
        // scrollHeight equals its box height when the short content fits; the
        // honest content bottom is the LAST spine cell's bottom (a
        // data-dock-leaf), plus the header bar above it.
        const rootTop = rootTopOf(root);
        const header = root.children[0] as HTMLElement | undefined;
        const headerPx = header?.getBoundingClientRect().height ?? 0;
        const cells = root.querySelectorAll<HTMLElement>("[data-dock-leaf]");
        const last = cells[cells.length - 1];
        const contentBottom =
          last === undefined
            ? headerPx
            : last.getBoundingClientRect().bottom - rootTop;
        return Math.max(headerPx, contentBottom);
      });
      setRailContentPx((prev) =>
        prev.length === next.length &&
        prev.every((v, i) => v === next[i])
          ? prev
          : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    container
      .querySelectorAll("[data-dock-rail-root]")
      .forEach((el) => ro.observe(el));
    return () => ro.disconnect();
    // Re-measure when the column set / rail state / cell counts change.
  }, [columns]);

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
        const railed = columnRailed[index];
        return (
          <React.Fragment key={column.id}>
            <Box
              data-dock-column={column.id}
              // D34: railing/expanding a column eases the wrapper's flex
              // width (basis 0 <-> the fixed 36px strip) -- same
              // presentation-only transition as cell collapse, suppressed
              // under an active divider drag.
              className={collapseAnim}
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
                  column-collapse chevron sits at its right end when the
                  band has sibling columns: it rails exactly this column. A
                  lone column of a single-column band in a MIXED region
                  keeps a pill-only handle -- railing it would strand dead
                  space across its full-width band. */}
                  {columnHandles && (
                    <StackHandleBar
                      attrs={{ "data-dock-column-handle": column.id }}
                      onPointerDown={(event) =>
                        dock.startColumnDrag(event, edge, column.id, {
                          // With a chevron present, a motionless bar click
                          // backs its action (P9's hit-area rule -- same as
                          // the region handle's bar), INCLUDING the focus
                          // handoff to the rail header's same-spot toggle:
                          // a pointer click routes here (the chevron is
                          // drag-through, T6), and focus must never fall to
                          // <body> (spec 4).
                          onClick:
                            columns.length >= 2
                              ? () => {
                                  dock.railColumn(edge, column.id, true);
                                  focusDockControl(
                                    `[data-dock-column-rail="${column.id}"] [data-dock-minimize-all]`,
                                  );
                                }
                              : undefined,
                        })
                      }
                      endControl={
                        columns.length >= 2 ? (
                          <ColumnCollapseChevron
                            edge={edge}
                            columnId={column.id}
                            onActivate={() =>
                              dock.railColumn(edge, column.id, true)
                            }
                          />
                        ) : undefined
                      }
                    />
                  )}
                  <Box style={{ flexGrow: 1, minHeight: 0, display: "flex" }}>
                    <ColumnView column={column} edge={edge} />
                  </Box>
                </>
              )}
            </Box>
            {index < columns.length - 1 &&
              (() => {
                // Fix B: cap the rule length to the SHORTER of two adjacent
                // RAIL columns' content bottoms so it never overshoots past
                // the short spine into its empty tail (P10). Only applies
                // between two railed columns; an expanded neighbor's divider
                // still runs full-height (its content fills the band).
                const bothRailed =
                  columnRailed[index] && columnRailed[index + 1];
                const leftPx = railContentPx[index];
                const rightPx = railContentPx[index + 1];
                const ruleExtentPx =
                  bothRailed && leftPx !== null && rightPx !== null
                    ? Math.min(leftPx, rightPx)
                    : undefined;
                return (
                  <SplitDivider
                    dir="row"
                    // A railed column is fixed-width chrome: the divider
                    // resizes only when an expanded column sits on both sides
                    // of it (D24: only RAILED columns go inert).
                    resizable={
                      expandedAtOrBefore[index] && expandedAfter[index]
                    }
                    ruleExtentPx={ruleExtentPx}
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
                );
              })()}
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

/** Shared cascade-resize commit for both levels (columns in a region row,
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
  /** Rendered px of ONE collapsed cell (36px rail strip / all-railed band
   * floor). Only read where the mask has collapsed cells. */
  collapsedPx?: number;
  index: number;
  deltaPx: number;
  containerPx: number;
  minCell: number | number[];
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
  ruleExtentPx,
  containerRef,
  onResize,
  onCancel,
}: {
  dir: "row" | "column";
  /** False when both sides of the divider are minimized strips: nothing can
   * resize, so it shows no resize cursor and ignores drags. */
  resizable: boolean;
  /** Fix B: cap the drawn rule's length (from the top) to this many px instead
   * of the full container extent -- used between two RAIL columns so the rule
   * stops at the shorter spine's content bottom and never overshoots into an
   * empty tail (P10). Undefined = full-length rule (the common case). */
  ruleExtentPx?: number;
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
        // A capped rule (Fix B) hugs the top so it stops at content; an
        // uncapped rule centers in the seam (its length is 100% either way).
        alignItems: ruleExtentPx !== undefined ? "flex-start" : "center",
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
      {/* Fix C: an INERT divider (beside a content-fixed all-rails band --
      resizable=false) must read as "no resize here", not as a live handle.
      A resizable rule is the full-length 1px seam at 0.5 opacity; an inert
      one is drawn dimmer (0.18) so the surface-contrast boundary does the
      dividing (P10: borders divide, never enclose) and users don't expect a
      handle where none exists. */}
      <Box
        data-dock-divider-rule=""
        style={{
          [isRow ? "width" : "height"]: "1px",
          // Fix B: a capped rule spans only the shorter neighbor's content
          // (px); otherwise it runs the full seam length.
          [isRow ? "height" : "width"]:
            ruleExtentPx !== undefined ? `${ruleExtentPx}px` : "100%",
          backgroundColor: "var(--mantine-color-default-border)",
          opacity: resizable ? 0.5 : 0.18,
        }}
      />
    </Box>
  );
}
