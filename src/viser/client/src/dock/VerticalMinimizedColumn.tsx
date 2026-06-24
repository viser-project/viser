// A fully-minimized docked column rendered as a narrow vertical strip: one
// cell per leaf, with an upright icon and a rotated (book-spine) title.
// Click expands; drag floats the group (the same click-vs-drag gesture as the
// unmergeable header). Renders every fully-minimized docked column: stranded
// inside a row split or spanning a whole region root.

import { Box, Paper } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import React from "react";
import { useDock } from "./DockContext";
import { gripBarBg } from "./DockStyles.css";
import { HandleIconButton } from "./handles";
import { DockEdge, DockNode, NodeId, TabGroup } from "./types";
import { collectLeaves } from "./layoutOps";

export function VerticalMinimizedColumn({
  node,
  edge,
}: {
  node: DockNode;
  edge: DockEdge;
}) {
  const dock = useDock();
  const leaves = collectLeaves(node);
  return (
    <Paper
      radius={0}
      style={{
        flexGrow: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        backgroundColor: "var(--mantine-color-body)",
      }}
    >
      {leaves.map(({ id, group }, i) => {
        const g = dock.groups[group];
        if (g === undefined) return null;
        return (
          <React.Fragment key={id}>
            {i > 0 && (
              <Box
                style={{
                  height: 1,
                  flexShrink: 0,
                  backgroundColor: "var(--mantine-color-default-border)",
                  opacity: 0.5,
                }}
              />
            )}
            <VerticalMinimizedCell nodeId={id} edge={edge} group={g} />
          </React.Fragment>
        );
      })}
    </Paper>
  );
}

function VerticalMinimizedCell({
  nodeId,
  edge,
  group,
}: {
  nodeId: NodeId;
  edge: DockEdge;
  group: TabGroup;
}) {
  const dock = useDock();
  return (
    // data-dock-leaf/-edge on the cell so collectTargets offers it as a docked
    // target; hitTest's collapsed branch gives it the 5-way drop zones.
    <Box
      data-dock-leaf={nodeId}
      data-dock-edge={edge}
      style={{ flexGrow: 1, minHeight: 0, display: "flex", width: "100%" }}
    >
      <Box
        data-dock-group={group.id}
        data-dock-collapsed="true"
        onPointerDown={(event) => {
          // Which tab row was pressed (if any)? A no-motion click expands to
          // THAT tab; a press elsewhere (cap/empty area) just expands. A drag
          // tears the panel out; a drag from the + button tears it out expanded.
          const target = event.target as HTMLElement;
          const rowPane = target
            .closest("[data-dock-tab]")
            ?.getAttribute("data-dock-tab");
          dock.startGroupDrag(event, group.id, {
            onClick: () =>
              rowPane !== null && rowPane !== undefined
                ? dock.expandToTab(group.id, rowPane)
                : dock.toggleCollapsed(group.id),
            expandOnDrag: target.closest("[data-dock-minimize]") !== null,
          });
        }}
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
        {/* Gray cap holding just the expand button -- no grip pill: the +
        IS the handle here (drag-through: motion drags the panel, dragging
        from the + tears out the EXPANDED panel, a motionless click expands
        in place; data-dock-minimize keeps the e2e helpers working). */}
        <Box
          className={gripBarBg}
          style={{ flexShrink: 0, width: "100%" }}
        >
          <HandleIconButton
            attrs={{ "data-dock-minimize": "true" }}
            label="Expand panel"
            title="Expand"
            expanded={false}
            onActivate={() => dock.toggleCollapsed(group.id)}
            dragThrough
            // Static placement filling the cap (not bar-anchored).
            placement={{ width: "100%", height: "1.7em" }}
          >
            <IconPlus size={14} />
          </HandleIconButton>
        </Box>
        {/* One row PER TAB: upright icon + rotated (book-spine) label. Each row
        is its own click target (data-dock-tab) -- clicking expands the panel to
        that tab -- so a multi-tab minimized panel shows ALL its tabs instead of
        one arbitrary icon plus a confusing joined label. The whole cell remains
        draggable for tear-out (handled by the cell's onPointerDown above). */}
        {group.paneIds.map((paneId) => {
          const spec = dock.panes[paneId];
          const active = paneId === group.activeId;
          return (
            <Box
              key={paneId}
              data-dock-tab={paneId}
              role="tab"
              aria-selected={active}
              title={spec?.title ?? paneId}
              style={{
                flexShrink: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: "100%",
                paddingTop: "0.35em",
                paddingBottom: "0.6em",
                cursor: "pointer",
                // Active tab reads at full strength; others are dimmed chrome.
                color: active
                  ? "var(--mantine-primary-color-filled)"
                  : "var(--mantine-color-dimmed)",
                opacity: active ? 1 : 0.85,
              }}
            >
              {spec?.icon !== undefined && (
                // Icons don't read rotated -- keep them upright.
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
              {/* Book-spine orientation (top-to-bottom, rotated clockwise): the
              portable vertical-text form -- sideways-lr isn't Safari-supported. */}
              <Box
                style={{
                  writingMode: "vertical-rl",
                  textOrientation: "mixed",
                  fontSize: "0.85em",
                  fontWeight: active ? 600 : 500,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minHeight: 0,
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
}
