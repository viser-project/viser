// Minimized VERTICAL chrome (spec 3.2): the rail -- the P13 exception that
// reclaims canvas WIDTH, so instead of "the header kept in place" it is the
// header ROTATED: gray cap on top (the header's leading edge), one spine row
// per tab (upright icon over rotated title, wayfinding-styled), hairline
// dividers between cells. Renders the EXPLICITLY collapsed region (D21:
// layout.regionCollapsed[edge]) as ONE packed rail -- the only 36px form
// left; per-cell minimize renders in-place bars instead (MinimizedBar).

import { Box, Paper } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { focusRing, gripBarBg, wayfindingText } from "./DockStyles.css";
import { focusPaneTab, tabListKeyDown } from "./gestures";
import { ChromeDivider, GripPill, StackHandleBar } from "./handles";
import { startCollapsedGroupPress } from "./collapsedPress";
import { collectLeaves } from "./layoutOps";
import { DockEdge, DockRegion, NodeId, TabGroup } from "./types";

/** The COLLAPSED region as ONE packed rail (spec 3.2 / D21): every leaf
 * across every band, contiguous, so the canvas gets the region's width back
 * with no dead gaps. Band structure and per-cell collapse states stay in the
 * MODEL; expanding the region restores them. The narrow StackHandleBar on
 * top is the rail's parent handle: drag floats the WHOLE region as one
 * window; click / `+` EXPANDS THE REGION (clears regionCollapsed -- cells
 * keep their own collapse states). Spine-row clicks expand the region AND
 * that panel to that tab (expandToTab clears the flag at the op level). */
export function RegionMinimizedRail({
  region,
  edge,
}: {
  region: DockRegion;
  edge: DockEdge;
}) {
  const dock = useDock();
  const leaves = region.rows.flatMap((r) =>
    r.columns.flatMap((c) => collectLeaves(c)),
  );
  // Expand the REGION: clears only the D21 flag -- cells keep their own
  // collapse states (a minimized cell comes back as an in-place bar). Focus
  // then lands on the first revealed cell's active tab, never on <body>
  // (spec 4 / edge case 14; the tab may be an expanded strip's tab or a
  // bar's title -- both carry data-dock-tab).
  const expandRegion = () => {
    dock.collapseRegion(edge, false);
    const firstGroup = dock.groups[leaves[0]?.group ?? ""];
    if (firstGroup?.activeId != null) focusPaneTab(firstGroup.activeId);
  };
  return (
    <Box
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
        attrs={{ "data-dock-region-rail": edge }}
        onPointerDown={(event) =>
          dock.startRegionDrag(event, edge, { onClick: expandRegion })
        }
        collapsed
        narrow
        onToggle={expandRegion}
        // Honest label: this expands the panel AREA (clears the region flag);
        // cells keep their own minimize states, so "Expand all panes" (the
        // floating window header's accurate wording) would lie here.
        toggleLabel="Expand panel area"
        toggleTitle="Expand"
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
                // The parent handle owns the rail's ONE visible expand
                // signifier (P9) -- every cell cap is a quiet pill. But with a
                // SINGLE cell the cap/background is unmarked surface backing
                // that same action (P9's hit-area rule), so a motionless
                // click there still expands; with 2+ cells a background
                // click stays inert (which cell would it mean?).
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
 * rail's ONE + lives on the parent handle, D25), then one spine row per
 * tab. Used by the region rail (nodeId/edge feed the drop-target
 * wrapper). Gestures via startCollapsedGroupPress: row press tears out that pane
 * (still minimized) / row click expands the region to that tab; cap or
 * background press drags the whole group / click expands (lone cells).
 * Expansion goes through the ops' expandGroup/expandToTab, which ALSO clear
 * the region-collapse flag (D21) -- a rail cell may back an expanded-state
 * group whose region is simply collapsed. */
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
  // Expand this cell: un-collapse the group AND its region (op-level; the
  // active tab stays). The rail only renders while the region is collapsed,
  // so expand is the only direction.
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
      pill -- the rail's ONE + lives on the parent handle above (P9). */}
      <Box
        className={gripBarBg}
        style={{
          flexShrink: 0,
          width: "100%",
          height: "1em",
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
              focusPaneTab(id);
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
  // The wrapper carries data-dock-leaf/-edge and sizes to CONTENT --
  // the rect must equal the visible strip or hitTest gets region-tall zones.
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
