// Context shared between the DockManager and the panel/frame components it
// renders. Lets a tab group's handle or tab start a drag, switch tabs, and read
// the current drag state for styling -- without threading callbacks through the
// split tree by hand.

import React from "react";
import {
  AreaId,
  DockEdge,
  DockLayout,
  GroupId,
  NodeId,
  PaneId,
  PaneRegistry,
  TabGroup,
} from "./types";

/** Imperative layout API for code that drives panes from OUTSIDE a pointer
 * gesture -- e.g. a sync layer adding/removing panes as server state changes.
 * All calls are routed through the manager's applyOp (so docked region widths
 * reconcile normally) and are stable across renders (safe in effect deps). */
export interface DockApi {
  /** Apply an arbitrary pure layout transform (compose ops from layoutOps). */
  apply: (fn: (layout: DockLayout) => DockLayout) => void;
  /** Add a not-yet-placed panel to an area's tabs (creates the area if
   * needed). No-op if the panel is already placed anywhere. */
  addPaneToArea: (areaId: AreaId, paneId: PaneId, index?: number) => void;
}

export interface DockContextValue {
  panes: PaneRegistry;
  /** Imperative panel lifecycle API (stable identity). */
  api: DockApi;
  /** The committed layout, for sync layers that need to OBSERVE where things
   * are (e.g. findGroupLocation to report a panel's dock side). Mutating it
   * does nothing -- use `api` to change the layout. */
  layout: DockLayout;
  /** All tab groups, so split leaves can resolve their group by id. */
  groups: Record<GroupId, TabGroup>;
  /** Nested dockable areas (areaId -> its tab group), so a `DockArea` placed in
   * a panel body can resolve its group by area id. */
  areas: Record<AreaId, { id: AreaId; group: GroupId }>;
  /** Begin dragging an entire tab group (from its handle / tab-strip). A
   * no-motion press fires `onClick` if given (used by the unmergeable header,
   * which has no separate minimize button: clicking the label toggles minimize,
   * matching the live FloatingPanel handle). */
  startGroupDrag: (
    event: React.PointerEvent<HTMLElement>,
    groupId: GroupId,
    opts?: {
      onClick?: () => void;
      /** Expand a collapsed group when the press becomes a DRAG (motion past
       * the threshold). Used when the drag starts on an expand (+) button:
       * dragging it should tear out the full panel, not a minimized stub. */
      expandOnDrag?: boolean;
    },
  ) => void;
  /** Begin dragging a whole top-level docked column by its slim handle: floats
   * the column as one stacked window, then drags it. */
  startColumnDrag: (
    event: React.PointerEvent<HTMLElement>,
    edge: DockEdge,
    columnNodeId: NodeId,
  ) => void;
  /** Begin a press on a tab: a click activates it, a drag tears the panel out
   * into its own floating window. */
  startTabDrag: (
    event: React.PointerEvent<HTMLElement>,
    groupId: GroupId,
    paneId: PaneId,
  ) => void;
  /** Drag the entire floating window (its whole snap-stack) by its header. */
  startWindowDrag: (
    event: React.PointerEvent<HTMLElement>,
    windowId: string,
  ) => void;
  activateTab: (groupId: GroupId, paneId: PaneId) => void;
  /** Toggle a group's minimized state (tap on its handle). */
  toggleCollapsed: (groupId: GroupId) => void;
  /** True while a split divider is being dragged. The column collapse/expand
   * CSS transition is suppressed during a resize so panes track the cursor 1:1
   * instead of easing behind it. */
  resizing: boolean;
  /** Set the `resizing` flag (called by SplitDivider on pointer down/up). */
  setResizing: (value: boolean) => void;
  /** Group currently being dragged, or null. Used to dim its origin. */
  draggingGroupId: GroupId | null;
  /** Tab currently being reordered within its strip, or null. The frame lifts
   * this tab and skips FLIP for it (the manager drives it imperatively). */
  draggingTabId: PaneId | null;
}

export const DockContext = React.createContext<DockContextValue | null>(null);

export function useDock(): DockContextValue {
  const ctx = React.useContext(DockContext);
  if (ctx === null) {
    throw new Error("useDock must be used within a DockManager");
  }
  return ctx;
}

/** High-churn geometry, split out of DockContext so per-frame resize updates
 * don't invalidate the (memoized) main context and re-render every panel.
 * Consumed only by observers that genuinely track these values (e.g. the
 * control panel's dock-state reporter). */
export interface DockMetrics {
  /** RENDERED region widths in px (regionWidth + strip/divider chrome): what
   * actually insets the canvas. Use this for screen-geometry consumers like
   * the notifications offset. */
  reservedWidth: { left: number; right: number };
}

export const DockMetricsContext = React.createContext<DockMetrics>({
  reservedWidth: { left: 0, right: 0 },
});
