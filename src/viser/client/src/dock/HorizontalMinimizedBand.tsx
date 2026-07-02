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
import {
  focusRing,
  gripBarBg,
  minimizedChip,
  minimizedChipText,
} from "./DockStyles.css";
import { keyActivate } from "./gestures";
import { collectLeaves, expandStack } from "./layoutOps";
import { DockEdge, DockRow, MINIMIZED_STRIP_PX, TabGroup } from "./types";

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
        // One chip per group (see MinimizedGroupChip below); the wrapper also
        // carries data-dock-leaf/-edge so it is a DOCKED drop target (the
        // collapsed branch in hitTest gives it 5-way zones), keeping a
        // minimized band droppable just like the vertical rail's cells.
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
            <MinimizedGroupChip group={g} />
          </Box>
        );
      })}
    </Box>
  );
}

/** ONE minimized group rendered as a compact horizontal chip: the active
 * tab's title + a "+" cap, in the shared minimized-chip look. Used by the
 * docked band's bar AND a minimized floating window's bar, so the two
 * horizontal surfaces are the same visual + gesture unit: a drag moves the
 * WHOLE group; a motionless click (or Enter/Space) expands it.
 *
 * NOT startCollapsedGroupPress: the chip carries data-dock-tab on its own
 * element (it IS the active tab's label, which keeps tab-based selectors and
 * a11y working), so that helper's closest("[data-dock-tab]") arbitration
 * would route every press to single-tab tear-out. Per-tab tear-out isn't
 * offered from a chip -- the vertical rail's per-tab rows are the granular
 * affordance. */
export function MinimizedGroupChip({ group }: { group: TabGroup }) {
  const dock = useDock();
  // A rendered chip's group is never empty, but the type says an empty
  // (area-backing) group has activeId null -- render nothing for it.
  if (group.activeId === null) return null;
  const activeSpec = dock.panes[group.activeId];
  const title = activeSpec?.title ?? group.activeId;
  return (
    <Box
      data-dock-group={group.id}
      data-dock-collapsed="true"
      // Marks this collapsed group as a horizontal CHIP (vs the vertical
      // rail cell). hitTest's collapsed branch reads this to offer merge
      // instead of the rail's Y-based per-row tab insertion, which assumes
      // vertically stacked spine rows.
      data-dock-chip="true"
      data-dock-tab={group.activeId}
      role="tab"
      aria-selected={false}
      tabIndex={0}
      className={`${focusRing} ${minimizedChip} ${minimizedChipText}`}
      title={title}
      onPointerDown={(event) => {
        event.stopPropagation();
        dock.startGroupDrag(event, group.id, {
          onClick: () => dock.toggleCollapsed(group.id),
        });
      }}
      onKeyDown={keyActivate(() => dock.toggleCollapsed(group.id))}
      // Shared minimized-chip look (minimizedChip/-Text classes); only layout
      // + drag-dim stay inline.
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: "0.3em",
        maxWidth: "12em",
        paddingLeft: "0.45em",
        paddingRight: "0.25em",
        height: "1.7em",
        opacity: dock.draggingGroupId === group.id ? 0.4 : 1,
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
      <IconPlus size={11} style={{ flexShrink: 0, opacity: 0.85 }} />
    </Box>
  );
}
