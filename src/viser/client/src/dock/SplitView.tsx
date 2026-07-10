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

// How close (px) a band-seam drag must land to a rail band's content height
// to SNAP onto it -- the "exactly no dead gray" detent, mirroring the
// floating window's content-height detent (spec 6, Windows).
const BAND_CONTENT_DETENT_PX = 8;

/** A band is ALL-RAILED when every one of its columns is railed (D41). Such a
 * band SNAPS to its content height (its tallest rail spine) when it becomes
 * all-railed, and its seam carries a detent at that height -- but its height
 * is otherwise a plain weighted share the user may drag anywhere (bands have
 * no maximum height). A band with even ONE expanded column is NOT
 * all-railed: it takes its weighted share with no snap (the expanded column
 * fills it, rails beside it are the healthy case). An empty band (no
 * columns) is not all-railed -- it has no rail content to snap to. */
function isAllRailed(row: DockRow): boolean {
  return row.columns.length > 0 && row.columns.every((c) => c.railed === true);
}

/** Measured content height (px) of an all-railed band: the tallest rail
 * column's spine extent -- header bar plus the last spine cell's bottom. If
 * a squeezed spine is SCROLLING, the honest content is the scroll extent
 * (the last cell's rect sits scrolled out of place). Null when no rail root
 * is measurable (mid-transition). */
function measureRailBandContentPx(bandEl: HTMLElement): number | null {
  let max: number | null = null;
  bandEl
    .querySelectorAll<HTMLElement>("[data-dock-rail-root]")
    .forEach((root) => {
      const rootTop = root.getBoundingClientRect().top;
      const header = root.children[0] as HTMLElement | undefined;
      const headerPx = header?.getBoundingClientRect().height ?? 0;
      const paper = root.children[1] as HTMLElement | undefined;
      const cells = root.querySelectorAll<HTMLElement>("[data-dock-leaf]");
      const last = cells[cells.length - 1];
      let px: number;
      if (paper !== undefined && paper.scrollHeight > paper.clientHeight + 1) {
        px = headerPx + paper.scrollHeight;
      } else if (last !== undefined) {
        px = Math.max(headerPx, last.getBoundingClientRect().bottom - rootTop);
      } else {
        px = headerPx;
      }
      max = max === null ? px : Math.max(max, px);
    });
  return max;
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
  // D41 (revised twice): every band -- rail or expanded -- takes its
  // WEIGHTED share of the region, with NO maximum height (panels don't have
  // maximum heights). "No dead gray below the spine" is a DEFAULT, not a
  // wall: when a band BECOMES all-railed its weight snaps to its content
  // height (the layout effect below), and the seam drag carries a detent at
  // that height -- but the user may drag it anywhere, dead gray included;
  // that's their call, same as any oversized panel.
  const allRailedMask = rows.map((r) => isAllRailed(r));
  // The content snap only pays off when there is an EXPANDED band to DONATE
  // the freed height to (D41's win: kill the dead gray beside expanded
  // content). When EVERY band is all-railed there is nowhere to donate:
  // snapping would strand the region's lower area empty while the bands come
  // out ragged, so weighted shares fill the region uniformly (Fix A).
  const regionHasExpandedBand = allRailedMask.some((m) => !m);
  const bandWeightTotal = rows.reduce((s, r) => s + r.weight, 0) || 1;
  // SNAP-TO-CONTENT: when a band's rail structure changes -- it became
  // all-railed, or an all-railed band's cell count changed -- commit its
  // weight as its measured content height, so railing a band lands it at
  // "exactly no dead gray" by default. Mirrors the floating window's
  // auto/pinned height: a band PARKED at its snap default keeps TRACKING
  // its content (webfonts landing after the first measure, label renames --
  // anything that moves the spine's true height), while a band the user
  // has dragged away from the default is PINNED and never re-snapped.
  // Structural changes are keyed on a signature so user drags (weight-only
  // changes) never count as one; content drift is watched by a
  // ResizeObserver on the rail roots. Runs before paint (useLayoutEffect),
  // so a stale share is never painted.
  const snapKeysRef = React.useRef<Map<string, string>>(new Map());
  const lastSnapPxRef = React.useRef<Map<string, number>>(new Map());
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const snapPass = () => {
      const prevKeys = snapKeysRef.current;
      const nextKeys = new Map<string, string>();
      const lastSnap = lastSnapPxRef.current;
      const snapped: Record<string, number> = {};
      rows.forEach((row, i) => {
        // regionHasExpandedBand is part of the signature: when an expanded
        // band arrives in an all-rails region, the rail bands snap then
        // (the freed height finally has somewhere to go).
        const key = `${allRailedMask[i]}:${regionHasExpandedBand}:${row.columns
          .map((c) => c.leaves.length)
          .join(",")}`;
        nextKeys.set(row.id, key);
        if (!allRailedMask[i] || !regionHasExpandedBand) {
          lastSnap.delete(row.id);
          return;
        }
        const el = container.querySelector<HTMLElement>(
          `[data-dock-band="${row.id}"]`,
        );
        const contentPx = el === null ? null : measureRailBandContentPx(el);
        if (el === null || contentPx === null) return;
        if (prevKeys.get(row.id) !== key) {
          snapped[row.id] = contentPx; // structural change: snap
          return;
        }
        // Content drift while parked at the default: the last snap is
        // still what's rendered (within rounding), but the spine's true
        // content moved -- keep tracking it. A user-resized band's
        // rendered height sits away from its last snap, so it's pinned.
        const prevSnap = lastSnap.get(row.id);
        const rendered = el.getBoundingClientRect().height;
        if (
          prevSnap !== undefined &&
          Math.abs(rendered - prevSnap) <= 2 &&
          Math.abs(contentPx - prevSnap) > 1
        ) {
          snapped[row.id] = contentPx;
        }
      });
      snapKeysRef.current = nextKeys;
      if (Object.keys(snapped).length === 0) return;
      // Weights render as RATIOS, so the committed px must sum to the real
      // band area (container minus seams) or every band rescales and the
      // snapped band misses its content height. The unsnapped bands ABSORB
      // the height the snap frees: they split the remainder in proportion
      // to their currently rendered px.
      const areaPx =
        container.getBoundingClientRect().height -
        SPLIT_DIVIDER_PX * (rows.length - 1);
      const snappedTotal = Object.values(snapped).reduce((s, v) => s + v, 0);
      const otherRendered: Record<string, number> = {};
      rows.forEach((row) => {
        if (snapped[row.id] !== undefined) return;
        const el = container.querySelector<HTMLElement>(
          `[data-dock-band="${row.id}"]`,
        );
        otherRendered[row.id] =
          el?.getBoundingClientRect().height ?? row.weight;
      });
      const otherTotal = Object.values(otherRendered).reduce(
        (s, v) => s + v,
        0,
      );
      const remainder = areaPx - snappedTotal;
      // Degenerate: spine content alone exceeds the region (huge rail).
      // Skip the rescale -- raw px keep the ratios sane and the spine
      // scrolls.
      const scale =
        remainder > 0 && otherTotal > 0 ? remainder / otherTotal : 1;
      const byId: Record<string, number> = {};
      rows.forEach((row) => {
        byId[row.id] =
          snapped[row.id] !== undefined
            ? snapped[row.id]
            : otherRendered[row.id] * scale;
      });
      Object.entries(snapped).forEach(([id, px]) =>
        lastSnapPxRef.current.set(id, px),
      );
      dock.api.apply((l) => setNodeWeights(l, edge, byId));
    };
    let cancelled = false;
    snapPass();
    // Webfonts landing after the first measure is the dominant content
    // drift (vertical labels grow a few px, the spine outgrows its snap):
    // fonts.ready is a frame-independent signal for it, so the re-snap
    // fires even when the compositor is throttled and observer callbacks
    // (frame-paced) lag.
    if (document.fonts !== undefined && document.fonts.status !== "loaded") {
      document.fonts.ready.then(() => {
        if (!cancelled) snapPass();
      });
    }
    // Any other spine-cell resize between renders (label renames) re-runs
    // the pass. The CELLS are observed, not the rail roots: a root is
    // stretched to the band, so content growth inside a fixed band never
    // resizes it. The at-default guard above keeps this from ever fighting
    // a user's explicit size.
    const ro = new ResizeObserver(() => snapPass());
    container
      .querySelectorAll("[data-dock-rail-root] [data-dock-leaf]")
      .forEach((el) => ro.observe(el));
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  });
  // A band divider drag computes new weights from the bands' RENDERED px at
  // drag start, not their stored weights: a capped rail band renders at its
  // content, which can sit far below its weighted share, and a drag computed
  // from stored weights would burn through that invisible surplus before the
  // divider visibly moved. Snapshotted once per gesture (SplitDivider's
  // onDragStart); flushes recompute from the snapshot + total delta, so the
  // gesture stays idempotent.
  const bandPxAtDragStart = React.useRef<number[] | null>(null);
  // Per-band content height at drag start (all-railed bands only): the
  // seam detent's target (BAND_CONTENT_DETENT_PX).
  const bandContentPxAtDragStart = React.useRef<(number | null)[]>([]);
  const measureBandPx = () => {
    const container = containerRef.current;
    if (container === null) return;
    const els = rows.map((row) =>
      container.querySelector<HTMLElement>(`[data-dock-band="${row.id}"]`),
    );
    bandPxAtDragStart.current = els.map(
      (el) => el?.getBoundingClientRect().height ?? 0,
    );
    bandContentPxAtDragStart.current = els.map((el, i) =>
      el !== null && allRailedMask[i] ? measureRailBandContentPx(el) : null,
    );
  };

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
        return (
          <React.Fragment key={row.id}>
            <Box
              data-dock-band={row.id}
              className={collapseAnim}
              style={{
                // Every band sizes by its weighted share -- no maximum. An
                // all-railed band's "no dead gray" height is the snap
                // default + the seam detent (see the layout effect above),
                // never a cap.
                flexGrow: row.weight / bandWeightTotal,
                flexShrink: 1,
                flexBasis: 0,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
              }}
            >
              <RowView row={row} edge={edge} columnHandles={columnHandles} />
            </Box>
            {index < rows.length - 1 && (
              // Band dividers are ALWAYS live (D41 revised): a rail band's
              // height is a plain weighted share, so there is always height
              // to trade -- dragging into it squeezes it (the spine
              // scrolls), dragging away grows it freely, with a DETENT at
              // its content height so "exactly no dead gray" is trivial to
              // land on.
              <SplitDivider
                dir="column"
                resizable
                containerRef={containerRef}
                onDragStart={measureBandPx}
                onResize={(deltaPx, containerPx) => {
                  // Content detent: if this delta would land an adjacent
                  // all-railed band within BAND_CONTENT_DETENT_PX of its
                  // spine content, snap the delta so it lands exactly
                  // there. The band ABOVE the seam grows by +delta; the
                  // band BELOW shrinks by it.
                  const startPx = bandPxAtDragStart.current;
                  const contentPx = bandContentPxAtDragStart.current;
                  let d = deltaPx;
                  if (startPx !== null) {
                    const above = contentPx[index];
                    if (above !== null && above !== undefined) {
                      const target = above - startPx[index];
                      if (Math.abs(d - target) <= BAND_CONTENT_DETENT_PX)
                        d = target;
                    }
                    const below = contentPx[index + 1];
                    if (below !== null && below !== undefined) {
                      const target = startPx[index + 1] - below;
                      if (Math.abs(d - target) <= BAND_CONTENT_DETENT_PX)
                        d = target;
                    }
                  }
                  resizeCells({
                    dock,
                    edge,
                    // Rendered px stand in for the stored weights (see
                    // bandPxAtDragStart above) so the drag tracks what is
                    // on screen even when stored weights are on another
                    // scale.
                    cells: rows.map((r, i) => ({
                      id: r.id,
                      weight: bandPxAtDragStart.current?.[i] ?? r.weight,
                    })),
                    collapsed: rows.map(() => false),
                    index,
                    deltaPx: d,
                    containerPx,
                    // Per-band floor: a band must fit its tallest
                    // expanded column's cells (50px each + dividers),
                    // or the leaves' own render floors overflow into
                    // the band below.
                    minCell: rows.map((band) =>
                      bandMinPx(band, columnHandles),
                    ),
                  });
                }}
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
            )}
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
            {index < columns.length - 1 && (
              <SplitDivider
                dir="row"
                // A railed column is fixed-width chrome: the divider
                // resizes only when an expanded column sits on both sides
                // of it (D24: only RAILED columns go inert). Its RULE always
                // runs the full band height either way -- a rail column's
                // body is full-band (empty tail included), so the boundary
                // between two columns is full-band too.
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
  containerRef,
  onDragStart,
  onResize,
  onCancel,
}: {
  dir: "row" | "column";
  /** False when both sides of the divider are minimized strips: nothing can
   * resize, so it shows no resize cursor and ignores drags. */
  resizable: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
  /** Called once at gesture start (before any onResize flush), so the parent
   * can snapshot rendered geometry the resize math needs (band px). */
  onDragStart?: () => void;
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
    onDragStart?.();

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
