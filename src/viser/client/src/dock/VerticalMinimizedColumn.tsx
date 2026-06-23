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
  const title = group.paneIds
    .map((p) => dock.panes[p]?.title ?? p)
    .join(" / ");
  const icon = dock.panes[group.activeId]?.icon;
  // The tab strip draws its rule on the side AWAY from the content; rotated
  // 90 degrees, that's the side facing the canvas (left for a right-docked
  // strip, right for a left-docked one).
  const ruleSide = edge === "right" ? "borderLeft" : "borderRight";
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
        title={title}
        onPointerDown={(event) =>
          dock.startGroupDrag(event, group.id, {
            onClick: () => dock.toggleCollapsed(group.id),
            // A drag that starts on the expand (+) button tears out the FULL
            // panel (expand-then-drag); from anywhere else the cell drags as
            // the minimized stub it shows.
            expandOnDrag:
              (event.target as HTMLElement).closest("[data-dock-minimize]") !==
              null,
          })
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
          // A hairline rule separating the strip from the canvas (the rotated
          // analog of the tab strip's bottom rule). 1px: a 2px rule reads as a
          // heavy bar on the narrow ~36px strip.
          [ruleSide]: "1px solid var(--mantine-color-default-border)",
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
        {/* Panel icon stays UPRIGHT (icons don't read rotated). */}
        {icon !== undefined && (
          <Box
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginTop: "0.3em",
              color: "var(--mantine-color-dimmed)",
            }}
          >
            {icon}
          </Box>
        )}
        {/* Book-spine orientation (top-to-bottom, rotated clockwise): the
        portable vertical-text form -- sideways-lr isn't supported in Safari.
        Dimmed like the strip's secondary chrome -- a minimized title is a
        wayfinding label, not content. */}
        <Box
          style={{
            writingMode: "vertical-rl",
            textOrientation: "mixed",
            fontSize: "0.85em",
            fontWeight: 500,
            marginTop: "0.45em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minHeight: 0,
            color: "var(--mantine-color-dimmed)",
            paddingBottom: "0.6em",
          }}
        >
          {title}
        </Box>
      </Box>
    </Box>
  );
}
