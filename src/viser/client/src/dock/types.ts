// Data model for the docking library.
//
// The layout is intentionally serializable: it holds only ids, geometry, and
// structure -- never React nodes. Panel *content* lives in a separate registry
// (see PanelRegistry) keyed by panel id, so the same layout can be saved,
// restored, or driven from the server later without touching the render tree.
//
// Vocabulary:
// - Panel: a single titled pane of content. The atomic unit.
// - TabGroup: one or more panels shown as tabs in a shared frame. A group with
//   a single panel is just a plain panel (we hide the tab strip in that case).
// - DockNode: a binary/n-ary split tree describing the docked region on one
//   screen edge. Leaves point at a TabGroup; splits arrange children in a row
//   (side by side) or column (stacked) with per-child flex weights.
// - FloatingWindow: a free-positioned container holding a vertical stack of
//   TabGroups (a "snap group"). A stack of one is a normal floating panel.

import React from "react";

export type PanelId = string;
export type GroupId = string;
export type WindowId = string;
export type NodeId = string;
export type AreaId = string;

/** Minimum width of a panel, enforced everywhere a panel's width is set or
 * previewed: floating windows, docked regions, and drop-zone hints. */
export const MIN_PANEL_WIDTH_PX = 220;

/** Maximum width of a *single* panel. Region/window caps are derived per-panel
 * from this (e.g. a two-column region can be up to 2x this), never applied to
 * the summed width of several panels. */
export const MAX_PANEL_WIDTH_PX = 600;

/** Width (px) of the narrow vertical strip used for every fully-minimized
 * docked column. In px (not em) because minimized strips participate in the
 * region-width MODEL: totals and resize math add this constant directly, so
 * the rendered width must match it exactly. */
export const MINIMIZED_STRIP_PX = 36;

/** Rendered width (px) of the divider between a region's side-by-side
 * columns. Participates in the region-width model the same way strips do:
 * the rendered region is the expanded columns' regionWidth plus these fixed
 * chrome widths, so resize math stays 1:1 with the cursor. */
export const SPLIT_DIVIDER_PX = 7;

/** Width (px) a docked region starts at (and that a newly docked column gets)
 * before the user resizes it. */
export const DEFAULT_REGION_PX = 300;

/** Clamp `v` into [lo, hi]. Shared by every place a size/position is bounded
 * (resize gestures, width reconciliation, hint geometry). */
export const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

/** Which screen edge a docked region is pinned to. Top/bottom are intentionally
 * unsupported: Viser GUI panels are vertical layouts, so only left/right make
 * sense for docking. */
export type DockEdge = "left" | "right";

/** The four relative positions for docking against an existing docked panel,
 * plus "center" for merging into its tab group. */
export type DropRegion = "center" | "top" | "bottom" | "left" | "right";

/** Content + metadata for a single panel. Kept out of the serializable layout;
 * supplied by the consumer via the panel registry. */
export interface PanelSpec {
  id: PanelId;
  title: string;
  /** Optional small icon shown before the title in tab strips. */
  icon?: React.ReactNode;
  /** Optional custom header content, used in place of the plain `title` text
   * when this panel renders as a full-width header (i.e. when `unmergeable`).
   * Lets a panel show a richer title bar -- e.g. a connection-status label with
   * action icons -- matching the live control panel's handle. The header is
   * still a drag handle, so interactive children should stopPropagation on
   * pointerdown. */
  titleNode?: React.ReactNode;
  /** When true, the panel body is rendered with NO padding so its content sits
   * flush to the panel edges (e.g. a panel whose entire body is a nested
   * dockable area). Default false (the usual comfortable body padding). */
  fullBleed?: boolean;
  /** When true, keep the scrolling body wrapper but drop its default padding --
   * for content that manages its own spacing (e.g. the control panel's
   * generated GUI). Unlike `fullBleed`, the body still scrolls/auto-sizes. */
  unpadded?: boolean;
  /** Renders the panel body. A function (not a node) so content is only built
   * for the active tab and re-evaluated on demand. */
  render: () => React.ReactNode;
  /** When true, this panel may be minimized but never merged into another
   * group's tab strip (and nothing can be merged into it). Its label is shown
   * as a full-width header rather than a tab. An unmergeable panel always lives
   * alone in its group. */
  unmergeable?: boolean;
}

export type PanelRegistry = Record<PanelId, PanelSpec>;

/** A stack of panels shown as tabs. `activeId` must always be a member of
 * `panelIds`. */
export interface TabGroup {
  id: GroupId;
  panelIds: PanelId[];
  activeId: PanelId;
  /** When true, the group is minimized: only its handle + tab strip show, with
   * the contents hidden. */
  collapsed?: boolean;
  /** Set by minimizeStack on groups that were EXPANDED when the user clicked
   * the stack handle's minimize-all button. expandStack expands exactly the
   * tagged groups, so a mixed min/max arrangement round-trips through a
   * parent minimize/expand. Cleared whenever the user takes individual
   * control of the group (toggleCollapsed / expandGroup). */
  collapsedByParent?: boolean;
}

interface DockNodeBase {
  id: NodeId;
  /** Flex weight relative to siblings within the same split. Ignored for the
   * root node. */
  weight: number;
}

/** A leaf in the docked split tree: a single tab group. */
export interface DockLeaf extends DockNodeBase {
  type: "leaf";
  group: GroupId;
}

/** An internal split: children laid out along one axis.
 * - "row": children side by side (a vertical divider between them).
 * - "column": children stacked top to bottom (a horizontal divider). */
export interface DockSplit extends DockNodeBase {
  type: "split";
  dir: "row" | "column";
  children: DockNode[];
}

export type DockNode = DockLeaf | DockSplit;

/** A free-floating container. Holds a vertical stack of tab groups that move
 * together (the "snap group" from the spec). A single-group stack is an
 * ordinary floating panel. Position/size are parent-relative pixels. */
export interface FloatingWindow {
  id: WindowId;
  x: number;
  y: number;
  width: number;
  /** Explicit height in px once the user vertically resizes; otherwise the
   * window auto-sizes to its content (capped per group). */
  height?: number;
  /** Tab groups stacked top to bottom. */
  stack: GroupId[];
  /** Per-group height weights for a multi-group stack (groupId -> flex weight),
   * used when the window has an explicit `height` so a draggable divider can
   * redistribute height between stacked groups. Missing/absent groups default to
   * weight 1 (equal). Keyed by group id (not index) so it survives stack
   * insert/remove without re-alignment; stale keys are harmless. */
  stackWeights?: Record<GroupId, number>;
}

/** The complete, serializable layout. */
export interface DockLayout {
  /** All tab groups, keyed by id. Referenced from docked trees and floating
   * stacks. A group is "owned" by exactly one location at a time. */
  groups: Record<GroupId, TabGroup>;
  /** Docked region pinned to each edge, or null when that edge is empty. */
  docked: Record<DockEdge, DockNode | null>;
  /** Docked region widths in px per edge: the EXPANDED width-columns' summed
   * pixels (minimized strips and dividers render on top -- see regionPlan).
   * THE single source of truth for region width. It travels with the layout
   * through every op (clones carry it) and is rewritten only by width
   * reconciliation in applyOp -- so snapshot/restore, persistence, and undo
   * preserve widths by construction. Kept while an edge is empty or fully
   * minimized so the width survives for restore.
   *
   * Optional so layout literals (e.g. in tests) stay terse; a missing value
   * reads as DEFAULT_REGION_PX per edge (see regionWidthsOf). */
  regionWidth?: Record<DockEdge, number>;
  /** Floating windows, painted in array order (last = topmost). */
  floating: FloatingWindow[];
  /** Nested dockable areas, keyed by id. Each is a flat tab group embedded in a
   * panel's body (rendered there by `DockArea`); the area's `group` is a normal
   * TabGroup in `groups`. Areas are first-class drop targets and tab sources --
   * they reuse the same drop/reorder/tear ops as everything else. An area's
   * group is a fixed fixture: panels move in/out of it, but the group itself is
   * never floated or removed (it persists empty as a drop affordance).
   *
   * Optional so existing layout literals (e.g. in tests) stay valid; treat a
   * missing value as no areas. */
  areas?: Record<AreaId, { id: AreaId; group: GroupId }>;
}

/** A reference to where a tab group currently lives. Used by drag/drop and
 * layout ops to locate and detach groups. */
export type GroupLocation =
  | { kind: "docked"; edge: DockEdge; nodeId: NodeId }
  | { kind: "floating"; windowId: WindowId }
  | { kind: "area"; areaId: AreaId };

export const emptyLayout = (): DockLayout => ({
  groups: {},
  docked: { left: null, right: null },
  floating: [],
  areas: {},
});

/** The layout's region widths with defaults filled in (the one place the
 * missing-field fallback lives). */
export const regionWidthsOf = (
  layout: DockLayout,
): Record<DockEdge, number> => ({
  left: layout.regionWidth?.left ?? DEFAULT_REGION_PX,
  right: layout.regionWidth?.right ?? DEFAULT_REGION_PX,
});
