// Minimized vertical chrome (spec 3.3): the rail -- the ONE docked collapsed
// rendering (D38/D32), and the P13 exception that reclaims canvas width: so
// instead of "the header kept in place" it is the header rotated: gray cap
// on top (the header's leading edge), one spine row per tab (upright icon
// over rotated title, wayfinding-styled), hairline dividers between cells.
// One scope (D46): a railed column as a 36px strip in place. A fully
// railed region is just every column railed -- N side-by-side strips
// (rails never merge). The bar (MinimizedBar) is the floating analog.

import { Box, Paper } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { focusRing, gripBarBg, wayfindingText } from "./DockStyles.css";
import { focusPaneTabOrGroup, tabListKeyDown } from "./gestures";
import { ChromeDivider, GripPill, StackHandleBar } from "./handles";
import { startCollapsedGroupPress } from "./collapsedPress";
import { collectLeaves } from "./layoutOps";
import { GRIP_BAR_EM, DockColumn, DockEdge, NodeId, TabGroup } from "./types";

/** One railed column as a 36px spine strip in place (per-column rail,
 * D28/D46 -- the one docked collapsed rendering). The narrow
 * StackHandleBar on top is the column's parent handle while railed:
 * drag floats the column as one collapsed stacked window (order + height
 * ratios preserved; identity transfer, D38); click / `+` expands the
 * column (clears its one railed flag). Spine-row clicks expand the column
 * to that tab (expandToTab clears the flag at the op level). */
export function ColumnRail({
  column,
  edge,
}: {
  column: DockColumn;
  edge: DockEdge;
}) {
  const dock = useDock();
  const leaves = collectLeaves(column);
  // Expand the column: clears its one railed flag (D38) and reveals every
  // cell expanded. Focus then lands on the first revealed cell's active
  // tab (unmergeable fallback: header toggle / group element), never on
  // <body> (edge case 14) -- mirrors expandRegion.
  const expandColumn = () => {
    dock.railColumn(edge, column.id, false);
    const firstGroup = dock.groups[leaves[0]?.group ?? ""];
    if (firstGroup?.activeId != null)
      focusPaneTabOrGroup(firstGroup.activeId, firstGroup.id);
  };
  return (
    <Box
      // The rail's droppable CELL surface runs from below the header chrome
      // to the strip's bottom (D53: the `+`/chevron rows above the first
      // cell are controls, resolved at region level, never a cell claim).
      // The cells inside size to content, so DockManager's target scanner
      // extends the LAST cell's drop rect to this root's bottom
      // (data-dock-rail-root) -- the empty tail below the spine rows must
      // not be dead pixels -- and CLAMPS every cell to the strip's box, so
      // an overflowing (scrolling) spine can't bleed drop targets past it.
      data-dock-rail-root={column.id}
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <StackHandleBar
        attrs={{ "data-dock-column-rail": column.id }}
        onPointerDown={(event) =>
          dock.startColumnDrag(event, edge, column.id, {
            onClick: expandColumn,
          })
        }
        collapsed
        narrow
        onToggle={expandColumn}
        // Honest scope label: this expands the column (clears its railed
        // flag, D38) -- same wording rule as the region rail's header.
        toggleLabel="Expand column"
        toggleTooltip="Expand"
      />
      <Paper
        radius={0}
        style={{
          flexGrow: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflowX: "hidden",
          overflowY: "auto",
          backgroundColor: "var(--mantine-color-body)",
        }}
      >
        {leaves.map(({ id, group }, i) => {
          const g = dock.groups[group];
          if (g === undefined) return null;
          return (
            <React.Fragment key={id}>
              {i > 0 && <ChromeDivider />}
              <VerticalMinimizedCell
                nodeId={id}
                edge={edge}
                group={g}
                // Same signifier budget as the region rail (P9/D25): the
                // parent handle owns the ONE visible expand control; a lone
                // cell's cap/background is unmarked backing for it, while
                // with 2+ cells a background click stays inert.
                clickExpands={leaves.length === 1}
              />
            </React.Fragment>
          );
        })}
      </Paper>
    </Box>
  );
}

/** One group as a rail cell: gray cap (always a quiet grip pill -- the
 * rail's one + lives on the parent handle, D25), then one spine row per
 * tab. Used by the region rail (nodeId/edge feed the drop-target
 * wrapper). Gestures via startCollapsedGroupPress: row press tears out that
 * pane (still minimized) / row click expands the column to that tab; cap or
 * background press drags the whole group / click expands (lone cells).
 * Expansion goes through the ops' expandGroup/expandToTab, which clear the
 * containing column's railed flag. */
export function VerticalMinimizedCell({
  nodeId,
  edge,
  group,
  clickExpands = false,
}: {
  nodeId: NodeId;
  edge: DockEdge;
  group: TabGroup;
  /** Motionless click on the cap/background expands region + group. On only
   * when the cell is the rail's SOLE cell (unambiguous target). */
  clickExpands?: boolean;
}) {
  const dock = useDock();
  // Expand this cell: clear the containing column's railed flag (op-level;
  // the active tab stays). The rail only renders while the column is
  // railed, so expand is the only direction.
  const expandCell = () => {
    if (group.activeId !== null) dock.expandToTab(group.id, group.activeId);
  };
  const inner = (
    <Box
      data-dock-group={group.id}
      data-dock-collapsed="true"
      onPointerDown={(event) =>
        startCollapsedGroupPress(
          dock,
          event,
          group.id,
          clickExpands ? expandCell : undefined,
        )
      }
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        cursor: "grab",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        overflow: "hidden",
        opacity: dock.draggingGroupId === group.id ? 0.4 : 1,
      }}
    >
      {/* Gray cap: the rotated header's leading edge, always a quiet grip
      pill -- the rail's one + lives on the parent handle above (P9). */}
      <Box
        className={gripBarBg}
        style={{
          flexShrink: 0,
          width: "100%",
          height: `${GRIP_BAR_EM}em`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <GripPill width="0.9em" opacity={0.35} />
      </Box>
      {/* One spine row per tab: the header's tabs, rotated + wayfinding. */}
      <Box
        role="tablist"
        aria-orientation="vertical"
        style={{ width: "100%", marginTop: "0.55em", marginBottom: "0.55em" }}
      >
        {group.paneIds.map((paneId) => {
          const spec = dock.panes[paneId];
          const onKeyDown = tabListKeyDown({
            paneId,
            paneIds: group.paneIds,
            prevKey: "ArrowUp",
            nextKey: "ArrowDown",
            onActivate: (id) => {
              dock.expandToTab(group.id, id);
              // Unmergeable fallback (edge case 14): the expanded cell may
              // render no tab element to land on.
              focusPaneTabOrGroup(id, group.id);
            },
          });
          return (
            <Box
              key={paneId}
              data-dock-tab={paneId}
              role="tab"
              aria-selected={paneId === group.activeId}
              tabIndex={0}
              className={`${focusRing} ${wayfindingText}`}
              title={spec?.title ?? paneId}
              onKeyDown={onKeyDown}
              style={{
                flexShrink: 0,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: "100%",
                paddingTop: "0.45em",
                paddingBottom: "0.45em",
                cursor: "pointer",
              }}
            >
              {spec?.icon !== undefined && (
                <Box
                  style={{
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginBottom: "0.3em",
                  }}
                >
                  {spec.icon}
                </Box>
              )}
              {/* Book-spine title (vertical-rl): the run length is the box
              height, so cap it and ellipsize long titles. */}
              <Box
                style={{
                  writingMode: "vertical-rl",
                  textOrientation: "mixed",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minHeight: 0,
                  maxHeight: "14em",
                }}
              >
                {spec?.title ?? paneId}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
  // The wrapper carries data-dock-leaf/-edge and sizes to content. For a
  // column rail, DockManager's scanner extends the LAST cell's drop rect to
  // the rail root's bottom (data-dock-rail-root above) so the empty tail
  // tiles onto that cell's zones; the header run above the first cell stays
  // out of the cell surface (D53 -- it's controls, region-level).
  return (
    <Box
      data-dock-leaf={nodeId}
      data-dock-edge={edge}
      style={{
        flexGrow: 0,
        flexShrink: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        width: "100%",
      }}
    >
      {inner}
    </Box>
  );
}
