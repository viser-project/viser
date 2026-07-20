// Context shared between the DockManager and the panel/frame components it
// renders. Lets a tab group's handle or tab start a drag, switch tabs, and read
// the current drag state for styling -- without threading callbacks through the
// split tree by hand.

import React from "react";
import {
  NodeId,
  AreaId,
  DockEdge,
  DockLayout,
  GroupId,
  PaneId,
  PaneRegistry,
  TabGroup,
} from "./types";

/** Imperative layout API for code that drives panes from outside a pointer
 * gesture -- e.g. a sync layer adding/removing panes as server state changes.
 * All calls are routed through the manager's applyOp (so docked region widths
 * reconcile normally) and are stable across renders (safe in effect deps). */
export interface DockApi {
  /** Apply an arbitrary pure layout transform (compose ops from layoutOps). */
  apply: (fn: (layout: DockLayout) => DockLayout) => void;
  /** Replace the layout wholesale with one whose ids did not come from this
   * session (restore, test-probe injection). Seeds the fresh-id counter past
   * the incoming ids before applying. */
  replace: (layout: DockLayout) => void;
  /** Add a not-yet-placed pane to an area's tabs (creates the area if
   * needed). No-op if the pane is already placed anywhere. */
  addPaneToArea: (areaId: AreaId, paneId: PaneId, index?: number) => void;
  /** How many USER gestures have changed COLLAPSE-OR-PLACEMENT intent this
   * session -- container collapse flags and which container each group lives
   * in (see layoutOps.collapseIntentKey). Monotonic, read from a ref, so it
   * never re-renders anyone. A sync layer that must DEFER a collapse
   * application samples this when it queues and re-checks before it applies:
   * an advanced count means the user changed something the queued command
   * would contend with, and P6 says the user's arrangement stands until the
   * server re-asserts by SENDING. Geometry-only gestures (resize, move,
   * z-order) and tab activation deliberately do NOT count -- they cannot
   * conflict with a collapse axis, and counting them would discard
   * legitimate server commands. */
  getUserArrangementCount: () => number;
}

export interface DockContextValue {
  panes: PaneRegistry;
  /** Imperative pane lifecycle API (stable identity). */
  api: DockApi;
  /** The committed layout, for sync layers that need to observe where things
   * are (e.g. findGroupLocation to report a panel's dock side). Mutating it
   * does nothing -- use `api` to change the layout. */
  layout: DockLayout;
  /** All tab groups, so split leaves can resolve their group by id. */
  groups: Record<GroupId, TabGroup>;
  /** Nested dockable areas (areaId -> its tab group), so a `DockArea` placed in
   * a panel body can resolve its group by area id. */
  areas: Record<AreaId, { group: GroupId }>;
  /** Begin dragging an entire tab group (from its handle / tab-strip). A
   * no-motion press fires `onClick` if given (used by the unmergeable header,
   * which has no separate minimize button: clicking the label toggles minimize,
   * matching the live FloatingPanel handle). */
  startGroupDrag: (
    event: React.PointerEvent<HTMLElement>,
    groupId: GroupId,
    opts?: { onClick?: () => void },
  ) => void;
  /** Begin a press on the collapsed region rail's parent handle: a drag
   * floats the whole region as one window stack; a motionless click runs
   * `opts.onClick` (expand the region). */
  startRegionDrag: (
    event: React.PointerEvent<HTMLElement>,
    edge: DockEdge,
    opts?: { onClick?: () => void },
  ) => void;
  /** Begin a press on a tab: a click activates it, a drag tears the panel out
   * into its own floating window. */
  startTabDrag: (
    event: React.PointerEvent<HTMLElement>,
    groupId: GroupId,
    paneId: PaneId,
  ) => void;
  /** Begin a press on one tab row of a minimized docked stack: a drag tears out
   * just that pane into its own floating window (the rest of the stack stays
   * docked); a no-motion click expands the group to that tab. Unlike
   * startTabDrag this has no reorder phase -- a minimized strip is vertical and
   * its tabs are wayfinding rows, not a horizontal reorder strip. */
  startTabTearOut: (
    event: React.PointerEvent<HTMLElement>,
    groupId: GroupId,
    paneId: PaneId,
    opts?: { onClick?: () => void },
  ) => void;
  /** Drag the entire floating window (its whole snap-stack) by its header. A
   * no-motion press fires `opts.onClick` if given -- the minimized floating
   * stack's parent + handle uses this to expand-all on click while still
   * dragging the whole window on motion. */
  startWindowDrag: (
    event: React.PointerEvent<HTMLElement>,
    windowId: string,
    opts?: { onClick?: () => void },
  ) => void;
  activateTab: (groupId: GroupId, paneId: PaneId) => void;
  /** Select a tab AND expand the group if minimized -- clicking a tab to read it
   * should reveal its content, not just switch the (hidden) active tab. */
  expandToTab: (groupId: GroupId, paneId: PaneId) => void;
  /** Expand the container holding the group (D38: collapse is one flag per
   * container, so any bar's expand affordance reveals the whole window).
   * Optionally activates `toPaneId` on the pressed group first (a bar's
   * label click). */
  expandStackOf: (groupId: GroupId, toPaneId?: PaneId) => void;
  /** Toggle the collapse flag of the group's container (D38) -- driven only
   * from a single-group floating window's chrome (D32). */
  toggleCollapsed: (groupId: GroupId) => void;
  /** Collapse/expand a whole floating stack -- the window header's toggle
   * (D38's one flag, both directions). A USER commit like railColumn and
   * collapseRegion: routing it through `api.apply` would mark the gesture
   * PROGRAMMATIC, so ownership arbitration would never learn the user
   * collapsed the window and a stale server command could re-flip it (P6). */
  setStackCollapsed: (stack: GroupId[], collapsed: boolean) => void;
  /** Rail every column of a docked edge (the region chevron; the packed
   * reading is derived, D44/D46). Collapse-only: expansion is granular via
   * each strip's own header. A user commit (not runProgrammatic), so
   * ownership arbitration learns the user set the flags (P6). */
  collapseRegion: (edge: DockEdge) => void;
  /** Collapse/expand a docked column to/from its per-column rail -- the
   * column-collapse chevron and column-rail-header gesture. A user commit
   * like collapseRegion, for the same P6 reason. */
  railColumn: (edge: DockEdge, columnId: NodeId, on: boolean) => void;
  /** Drag one visual column out of a multi-column region as a stacked
   * window (D27) -- the per-column parent handle's gesture. A no-motion
   * press fires `opts.onClick` if given -- the railed column's rail header
   * uses this to expand the column on click while still dragging the whole
   * column on motion. */
  startColumnDrag: (
    event: React.PointerEvent<HTMLDivElement>,
    edge: DockEdge,
    columnId: NodeId,
    opts?: { onClick?: () => void },
  ) => void;
  /** Group currently being dragged, or null. Used to dim its origin. */
  draggingGroupId: GroupId | null;
  /** Tab currently being reordered within its strip, or null. The frame
   * lifts this tab visually (the manager drives its transform imperatively
   * during the drag). */
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
  /** Rendered region widths in px (regionWidth + strip/divider chrome): what
   * actually insets the canvas. Use this for screen-geometry consumers like
   * the notifications offset. */
  reservedWidth: { left: number; right: number };
  /** Dock-root size in px. With reservedWidth, gives the canvas bounds used to
   * resolve (possibly negative) float coordinates. */
  containerWidth: number;
  containerHeight: number;
}

export const DockMetricsContext = React.createContext<DockMetrics>({
  reservedWidth: { left: 0, right: 0 },
  containerWidth: 0,
  containerHeight: 0,
});
