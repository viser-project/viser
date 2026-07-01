// A fully-minimized docked ROW BAND (among sibling bands) rendered as a short
// FULL-WIDTH horizontal bar -- a collapsed section header spanning the region
// width, with one labeled chip per group. Click a chip to expand the band to
// that tab; the bar's empty area expands the whole band. This is the band-level
// analog of VerticalMinimizedColumn (which renders a minimized COLUMN as a
// narrow vertical rail): a band is horizontal, so its collapsed form is too.
//
// A LONE minimized band keeps the full-height vertical rail (see SplitView):
// with nothing beside it the band fills the region, so the rail reads as the
// whole minimized region. This horizontal bar is only for a band that shares
// the region with expanded sibling bands, where a 36px-tall full-width strip is
// the natural collapsed look.

import { Box } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import React from "react";
import { useDock } from "./DockContext";
import { focusRing, gripBarBg } from "./DockStyles.css";
import { keyActivate } from "./gestures";
import { collectLeaves, expandStack } from "./layoutOps";
import { DockEdge, DockRow, MINIMIZED_STRIP_PX } from "./types";

export function HorizontalMinimizedBand({
  row,
  edge,
}: {
  row: DockRow;
  edge: DockEdge;
}) {
  const dock = useDock();
  // Every leaf in the band (across its columns), in render order. Each becomes a
  // chip that is ALSO a docked drop target (data-dock-leaf/-edge), so a
  // minimized band stays a drop target -- and the seam-extent math in hitTest,
  // which reads leaf rects, still sees the band.
  const leaves = row.columns.flatMap((c) => collectLeaves(c));
  const groupIds = leaves.map((l) => l.group);
  const expandAll = () => dock.api.apply((l) => expandStack(l, groupIds));
  return (
    <Box
      // The band box (SplitView) already sizes us to MINIMIZED_STRIP_PX tall via
      // flex-basis; fill it and lay the chips out horizontally. The empty area
      // is a grab/expand affordance for the whole band.
      data-dock-minimized-band={row.id}
      className={gripBarBg}
      onPointerDown={(event) => {
        // A press on the bar's empty area (not a chip) drags the FIRST column
        // out (matching the column rail's tear-out), or -- motionless -- expands
        // the whole band. Chips handle their own press (stopPropagation below).
        const first = row.columns[0];
        dock.startColumnDrag(event, edge, first.id, { onClick: expandAll });
      }}
      style={{
        width: "100%",
        height: MINIMIZED_STRIP_PX,
        minHeight: MINIMIZED_STRIP_PX,
        flexShrink: 0,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: "0.4em",
        paddingLeft: "0.4em",
        paddingRight: "0.4em",
        overflowX: "hidden",
        overflowY: "hidden",
        cursor: "grab",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {leaves.map(({ id: nodeId, group: groupId }) => {
        const g = dock.groups[groupId];
        if (g === undefined) return null;
        // One chip per group: its active tab's title + a + cap. Click expands
        // the band to that group/tab; a drag tears the group out (still
        // minimized) -- same gesture set as the vertical rail's cells. The chip
        // also carries data-dock-leaf/-edge so it is a DOCKED drop target (the
        // collapsed branch in hitTest gives it 5-way zones), keeping a minimized
        // band droppable just like the vertical rail's cells.
        const activeSpec = dock.panes[g.activeId];
        const title = activeSpec?.title ?? g.activeId;
        return (
          // Outer wrapper carries data-dock-leaf/-edge (the DOCKED drop target
          // collectTargets scans for; it reads data-dock-group from a
          // DESCENDANT, so the group marker must be nested, not on this element).
          <Box
            key={nodeId}
            data-dock-leaf={nodeId}
            data-dock-edge={edge}
            // The wrapper IS the drop target (collectTargets reads its rect), so
            // it fills the bar: chips tile the full width (flexGrow) and full
            // height, leaving NO dead strip that a drop would fall through -- the
            // whole visible bar is droppable, matching the vertical rail's
            // full-width cells. The chip's visual content stays compact inside.
            style={{
              flexGrow: 1,
              flexBasis: 0,
              minWidth: 0,
              height: "100%",
              display: "flex",
              alignItems: "center",
            }}
          >
            <Box
              data-dock-group={groupId}
              data-dock-collapsed="true"
              data-dock-tab={g.activeId}
              role="tab"
              aria-selected={false}
              tabIndex={0}
              className={focusRing}
              title={title}
              onPointerDown={(event) => {
                event.stopPropagation();
                // A drag moves the WHOLE group (a chip stands for its group,
                // like the rail cell's cap); a motionless click expands it.
                // NOT startCollapsedGroupPress: the chip carries data-dock-tab
                // on this same element (for hitTest's tab-insert rects), so
                // its closest("[data-dock-tab]") arbitration would route every
                // press to single-tab tear-out and the group branch would be
                // unreachable. Per-tab tear-out isn't offered from a chip --
                // the rail's per-tab rows are the granular affordance.
                dock.startGroupDrag(event, groupId, {
                  onClick: () => dock.toggleCollapsed(groupId),
                });
              }}
              onKeyDown={keyActivate(() => dock.toggleCollapsed(groupId))}
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: "0.3em",
                maxWidth: "12em",
                paddingLeft: "0.4em",
                paddingRight: "0.2em",
                height: "1.6em",
                borderRadius: "0.25em",
                backgroundColor: "var(--mantine-color-body)",
                cursor: "pointer",
                opacity: dock.draggingGroupId === groupId ? 0.4 : 1,
              }}
            >
              <Box
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "0.75em",
                }}
              >
                {title}
              </Box>
              <IconPlus size={11} style={{ flexShrink: 0, opacity: 0.7 }} />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
