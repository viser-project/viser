// Shared pointer-down arbitration for a COLLAPSED group's drop target -- used by
// both minimized renderers (the vertical column rail's cells and the horizontal
// band's chips) so the gesture lives in one place instead of being copy-pasted.

import React from "react";
import type { DockContextValue } from "./DockContext";
import type { GroupId } from "./types";

/** Pressing a specific tab ROW tears out ONLY that pane; pressing elsewhere
 * (the cap / empty area) drags the whole group, still minimized, with `onClick`
 * (a no-motion click) toggling expand. Omit `onClick` for a cell whose expand is
 * owned by a parent stack handle (a stacked rail cell). */
export function startCollapsedGroupPress(
  dock: DockContextValue,
  event: React.PointerEvent<HTMLElement>,
  groupId: GroupId,
  onClick?: () => void,
): void {
  const pane = (event.target as HTMLElement)
    .closest("[data-dock-tab]")
    ?.getAttribute("data-dock-tab");
  if (pane !== null && pane !== undefined) {
    dock.startTabTearOut(event, groupId, pane);
    return;
  }
  dock.startGroupDrag(event, groupId, onClick ? { onClick } : undefined);
}
