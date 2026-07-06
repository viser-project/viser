// Shared pointer-down arbitration for a COLLAPSED group's surface -- used by
// both minimized renderers (the region rail's cells and the in-place
// MinimizedBar) so the gesture lives in one place instead of copy-pasted.

import React from "react";
import type { DockContextValue } from "./DockContext";
import type { GroupId } from "./types";

/** Pressing a specific tab ROW tears out ONLY that pane; pressing elsewhere
 * (the cap / empty area) drags the whole group, still minimized, with `onClick`
 * (a no-motion click) toggling expand. Omit `onClick` for a cell whose expand is
 * owned by a parent stack handle (a stacked rail cell). `onTabClick(pane)`, if
 * given, replaces the tab row's default no-motion click (expand this group to
 * that tab) -- a stacked bar's title expands the WHOLE stack instead (D31). */
export function startCollapsedGroupPress(
  dock: DockContextValue,
  event: React.PointerEvent<HTMLElement>,
  groupId: GroupId,
  onClick?: () => void,
  onTabClick?: (paneId: string) => void,
): void {
  const pane = (event.target as HTMLElement)
    .closest("[data-dock-tab]")
    ?.getAttribute("data-dock-tab");
  if (pane !== null && pane !== undefined) {
    dock.startTabTearOut(
      event,
      groupId,
      pane,
      onTabClick ? { onClick: () => onTabClick(pane) } : undefined,
    );
    return;
  }
  dock.startGroupDrag(event, groupId, onClick ? { onClick } : undefined);
}
