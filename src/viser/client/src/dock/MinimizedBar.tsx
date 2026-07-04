// THE one minimized horizontal form (D20): a group collapsed to its handle,
// rendered IN PLACE wherever the group lives -- a docked cell, a zipped grid
// cell, or a floating stack cell. It is the P13 form -- the expanded header
// kept in place: grip-bar gray surface, ONE dimmed wayfinding title (the
// active tab's, with a "+N" badge for the rest -- D14), and the +/- toggle at
// the RIGHT end where the expanded header's `-` sits. The whole bar is a drag
// handle (D18: no pill -- a pill inside a surface that IS a handle would be a
// redundant signifier). The only other minimized form is the vertical region
// rail (VerticalMinimizedColumn.tsx), an explicit region-collapse state (D21).

import { Box } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { focusRing, gripBarBg, wayfindingText } from "./DockStyles.css";
import { focusDockControl, focusPaneTab, keyActivate } from "./gestures";
import { startCollapsedGroupPress } from "./collapsedPress";
import { ChromeToggle, RegionCollapseChevron } from "./handles";
import { regionChevronEdge } from "./layoutOps";
import { MINIMIZED_BAR_PX, TabGroup } from "./types";

/** ONE minimized group as its header kept in place (P13/D14/D20).
 *
 * The title carries data-dock-tab (the active tab): it keeps tab-based
 * selectors, keyboard activation (Enter/Space expands to it), and hitTest's
 * single label rect working. Gestures via startCollapsedGroupPress: a
 * title press tears out the active pane (single-pane groups float
 * wholesale, ids stable); any other press drags the whole group;
 * motionless clicks expand. The right-end ChromeToggle expands THIS group
 * (per-cell expand, D16 -- distinct per bar, so P9-legal).
 *
 * A SINGLE-pane group whose pane provides `minimizedFace` renders the face
 * instead of the default icon+title (D19); the face still sits inside the
 * data-dock-tab element so gestures and keyboard behavior are unchanged. */
export function MinimizedBar({ group }: { group: TabGroup }) {
  const dock = useDock();
  // The type allows an empty (area-backing) group with activeId null;
  // rendered bars never are, but render nothing rather than crash.
  if (group.activeId === null) return null;
  const activeId = group.activeId;
  const spec = dock.panes[activeId];
  const title = spec?.title ?? activeId;
  const hiddenCount = group.paneIds.length - 1;
  const otherTitles = group.paneIds
    .filter((id) => id !== activeId)
    .map((id) => dock.panes[id]?.title ?? id)
    .join(", ");
  const expandGroup = () => dock.toggleCollapsed(group.id);
  // Region-collapse chevron (D21): the bar hosts it when this group is the
  // top-right cell of a docked, non-collapsed region (same slot as the
  // expanded grip bar's -- P13 position constancy).
  const chevronEdge = regionChevronEdge(dock.layout, group.id);
  // Pane-provided minimized face (D19): single-pane groups only (a multi-tab
  // bar must name its active tab and badge the rest).
  const face =
    group.paneIds.length === 1 ? spec?.minimizedFace : undefined;
  return (
    <Box
      data-dock-group={group.id}
      data-dock-collapsed="true"
      // Horizontal BAR marker: hitTest's collapsed branch uses X-based
      // label insertion + the D4 zone rules for it (vs the rail's Y-based).
      data-dock-chip="true"
      // The single title below is a role="tab"; the bar is its (one-tab)
      // tablist so the pattern stays valid for screen readers.
      role="tablist"
      aria-orientation="horizontal"
      className={gripBarBg}
      onPointerDown={(event) => {
        // The bar owns its press; without this it would ALSO arm an
        // enclosing surface's drag (P12: one press, one level).
        event.stopPropagation();
        startCollapsedGroupPress(dock, event, group.id, expandGroup);
      }}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        height: MINIMIZED_BAR_PX,
        flexShrink: 0,
        width: "100%",
        minWidth: 0,
        overflow: "hidden",
        cursor: "grab",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        opacity: dock.draggingGroupId === group.id ? 0.4 : 1,
      }}
    >
      {/* The single wayfinding title (D14): the active tab's identity --
      or the pane's custom minimized face (D19). */}
      <Box
        data-dock-tab={activeId}
        role="tab"
        aria-selected
        tabIndex={0}
        // A custom face keeps its own colors (D19: same identity as the
        // expanded header); the default icon+title is dimmed wayfinding.
        className={
          face !== undefined ? focusRing : `${focusRing} ${wayfindingText}`
        }
        title={face !== undefined ? undefined : title}
        onKeyDown={keyActivate(() => {
          dock.expandToTab(group.id, activeId);
          focusPaneTab(activeId);
        })}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.35em",
          minWidth: 0,
          paddingLeft: "0.6em",
          paddingRight: "0.5em",
          cursor: "pointer",
          position: "relative",
        }}
      >
        {face !== undefined ? (
          face
        ) : (
          <>
            {spec?.icon !== undefined && (
              <Box
                style={{ flexShrink: 0, display: "flex", alignItems: "center" }}
              >
                {spec.icon}
              </Box>
            )}
            <Box
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "12em",
              }}
            >
              {title}
            </Box>
          </>
        )}
      </Box>
      {/* "+N": the group's other tabs, named on hover (D14 badge). */}
      {hiddenCount > 0 && (
        <Box
          title={otherTitles}
          className={wayfindingText}
          style={{
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            paddingRight: "0.5em",
            fontSize: "0.75em",
          }}
        >
          +{hiddenCount}
        </Box>
      )}
      {/* The slack is the bar's group-drag surface (the whole bar is the
      handle, D18); the toggle sits at the right end, where the expanded
      header's `-` sat (P13: spatially stable). */}
      <Box style={{ flexGrow: 1 }} />
      {chevronEdge !== null && (
        <RegionCollapseChevron
          edge={chevronEdge}
          onActivate={() => {
            dock.collapseRegion(chevronEdge, true);
            // The chevron unmounts with the bar; hand focus to the rail
            // header (spec 4 / edge case 14 -- same as the grip-bar path).
            focusDockControl(
              `[data-dock-region-rail="${chevronEdge}"] [data-dock-minimize-all]`,
            );
          }}
        />
      )}
      <ChromeToggle
        expanded={false}
        label="Expand panel"
        onActivate={() => {
          expandGroup();
          focusPaneTab(activeId);
        }}
      />
    </Box>
  );
}
