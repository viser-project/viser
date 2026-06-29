// A nested "dockable area": a flat tab group embedded in a panel's body.
//
// Unlike the old standalone version (which used native HTML5 drag-and-drop and
// its own local state), this is a FIRST-CLASS participant in the dock model: its
// tab group lives in the shared layout, so dropping panes in, reordering tabs,
// tearing a panel out (to float, or to merge with the host/parent panel), and
// dropping a whole snapped stack (which collapses into a series of tabs) all
// reuse the exact same layout ops, hit-testing, and pointer-drag controller as
// everything else -- there is no difference between "standard" and "nested"
// panes.
//
// Placement: put <DockArea areaId="..."/> in a panel's render(). The area's
// group and its initial panes are seeded in the layout (layout.areas + a
// TabGroup in layout.groups). The DockManager registers this container as a drop
// target by its `data-dock-area` attribute.

import { Box, Text } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { TabGroupFrame } from "./TabGroupFrame";

export function DockArea({
  areaId,
  minHeight = 120,
  fill = false,
}: {
  areaId: string;
  /** Minimum height so an empty area still presents a comfortable drop zone. */
  minHeight?: number | string;
  /** Fill the host's available height (e.g. when the area is a panel's entire
   * body). Otherwise the area sizes to content. */
  fill?: boolean;
}) {
  const dock = useDock();
  const area = dock.areas[areaId];
  const group = area ? dock.groups[area.group] : undefined;

  return (
    <Box
      data-dock-area={areaId}
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        overflow: "hidden",
        // Fill via flexGrow only (NOT height:100%): in a definite-height parent
        // (docked leaf, fixed-height window) flexGrow fills it; in an
        // indefinite/auto-height parent (a freshly-undocked floating window)
        // height:100% would resolve to 0 and collapse the area, whereas flexGrow
        // with no free space simply sizes to content.
        ...(fill
          ? { flexGrow: 1, minHeight: 0 }
          : { minHeight, borderRadius: 4 }),
      }}
    >
      {group === undefined || group.paneIds.length === 0 ? (
        <Box
          style={{
            flexGrow: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1em",
            minHeight,
            // No dotted outline; an empty area reads as a droppable slot via a
            // faint solid tint instead. The active drop highlight is drawn by the
            // shared DropHintView (a "merge" highlight) during a drag.
            backgroundColor: "var(--mantine-color-default-hover)",
            borderRadius: 4,
          }}
        >
          <Text size="xs" c="dimmed" ta="center">
            Drop a panel here
          </Text>
        </Box>
      ) : (
        <TabGroupFrame
          group={group}
          fill={fill}
          stripDragsGroup={false}
          // A filling nested area lives in a docked leaf / fixed-height window,
          // where the body can be squeezed below its content minimum -- match the
          // rest of the docked UI with a persistent overflow scrollbar (not the
          // hover-reveal default that only fits content-sized floating bodies).
          persistentScrollbar={fill}
        />
      )}
    </Box>
  );
}
