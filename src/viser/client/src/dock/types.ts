// Data model for the docking library.
//
// The layout is intentionally serializable: it holds only ids, geometry, and
// structure -- never React nodes. Panel *content* lives in a separate registry
// (see PaneRegistry) keyed by panel id, so the same layout can be saved,
// restored, or driven from the server later without touching the render tree.
//
// Vocabulary:
// - Panel: a single titled pane of content. The atomic unit.
// - TabGroup: one or more panes shown as tabs in a shared frame. A group with
//   a single panel is just a plain panel (we hide the tab strip in that case).
// - DockNode: a binary/n-ary split tree describing the docked region on one
//   screen edge. Leaves point at a TabGroup; splits arrange children in a row
//   (side by side) or column (stacked) with per-child flex weights.
// - FloatingWindow: a free-positioned container holding a vertical stack of
//   TabGroups (a "snap group"). A stack of one is a normal floating panel.

import React from "react";

export type PaneId = string;
export type GroupId = string;
export type WindowId = string;
export type NodeId = string;
export type AreaId = string;

/** Minimum width of a panel's CONTENT, enforced on the inner body container
 * (TabGroupFrame's PanelBody) -- NOT on the region/window/column layout. When a
 * region is dragged narrower than this, the body keeps this width and the panel
 * scrolls horizontally instead of squeezing the content. The layout itself may
 * commit narrower than this, down to MIN_REGION_GRAB_PX. */
export const MIN_PANEL_WIDTH_PX = 220;

/** Minimum width a docked region / floating window / split column may be
 * resized to in the LAYOUT model. Small (the panel body, min MIN_PANEL_WIDTH_PX,
 * simply overflows with a horizontal scrollbar below this), but wide enough to
 * stay comfortably grabbable so a region dragged narrow can always be pulled
 * back wide -- and wide enough that the header chrome (status + action icons)
 * still reads. Kept above MINIMIZED_STRIP_PX so an expanded panel never renders
 * thinner than its own minimized strip. */
export const MIN_REGION_GRAB_PX = 96;

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

/** Minimum px of canvas kept visible between the left and right docked regions.
 * When the regions' summed reserved width would leave less than this (many
 * panels docked on a narrow viewport), the RENDERED region widths are scaled
 * down proportionally so they never overlap or fully occlude the scene. This is
 * a render-time cap only -- the MODEL region widths (regionWidth) are preserved,
 * so widths restore when the viewport grows back. */
export const MIN_CANVAS_PX = 120;

/** Minimum rendered height (px) of a pinned floating window: the floor a window
 * is kept at so it stays usable (its contents scroll) when the container is too
 * small for its pinned height. A window whose pinned height is below this is
 * left as-is (the floor never inflates a window above its pinned height). */
export const MIN_WINDOW_HEIGHT_PX = 100;

/** Clamp `v` into [lo, hi]. Shared by every place a size/position is bounded
 * (resize gestures, width reconciliation, hint geometry). */
export const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

/** Which screen edge a docked region is pinned to. Top/bottom are intentionally
 * unsupported: Viser GUI panes are vertical layouts, so only left/right make
 * sense for docking. */
export type DockEdge = "left" | "right";

/** The four relative positions for docking against an existing docked panel,
 * plus "center" for merging into its tab group. */
export type DropRegion = "center" | "top" | "bottom" | "left" | "right";

/** Content + metadata for a single panel. Kept out of the serializable layout;
 * supplied by the consumer via the panel registry. */
export interface PaneSpec {
  id: PaneId;
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

export type PaneRegistry = Record<PaneId, PaneSpec>;

/** A stack of panes shown as tabs. `activeId` must always be a member of
 * `paneIds`. */
export interface TabGroup {
  id: GroupId;
  paneIds: PaneId[];
  activeId: PaneId;
  /** When true, the group is minimized: only its handle + tab strip show, with
   * the contents hidden. In a stack of 2+ groups this is uniform across the
   * stack (enforced by normalizeStackCollapse); a lone group minimizes on its
   * own. */
  collapsed?: boolean;
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

/** A floating window's vertical sizing. `auto` tracks content (capped per
 * group); `pinned` is an explicit px height the user dragged to. A tagged union
 * (not `height?: number`) so "auto vs pinned" is an explicit, total state -- no
 * sentinel-undefined ambiguity, and "revert to auto" is a real transition rather
 * than a delete. */
export type WindowHeight = { mode: "auto" } | { mode: "pinned"; px: number };

/** Build a WindowHeight from an optional px: undefined -> auto, else pinned.
 * The ONE place this mapping lives (producers never open-code the union). */
export function windowHeight(px?: number): WindowHeight {
  return px === undefined ? { mode: "auto" } : { mode: "pinned", px };
}

/** The pinned px height, or undefined when the window auto-sizes. The ONE place
 * the union is destructured for reading (consumers never branch on `.mode`). */
export function pinnedPxOf(height: WindowHeight): number | undefined {
  return height.mode === "pinned" ? height.px : undefined;
}

/** A free-floating container. Holds a vertical stack of tab groups that move
 * together (the "snap group" from the spec). A single-group stack is an
 * ordinary floating panel. Position/size are parent-relative pixels. */
export interface FloatingWindow {
  id: WindowId;
  x: number;
  y: number;
  width: number;
  /** Vertical sizing: auto-track content, or a pinned px height. */
  height: WindowHeight;
  /** Tab groups stacked top to bottom. */
  stack: GroupId[];
  /** Per-group height weights for a multi-group stack (groupId -> flex weight),
   * used when the window has a pinned `height` so a draggable divider can
   * redistribute height between stacked groups. Missing/absent groups default to
   * weight 1 (equal). Keyed by group id (not index) so it survives stack
   * insert/remove without re-alignment; stale keys are harmless. */
  stackWeights?: Record<GroupId, number>;
  /** Server anchor for a server-placed panel: the canvas-relative coords the
   * window re-resolves to as the canvas + measured window size change (`x`/`y`
   * above are the resolved absolute position). A NEGATIVE component is a gap from
   * the FAR edge: x<0 is `|x|`px from the canvas right boundary, y<0 is `|y|`px
   * from the bottom (so top-right is {x:-15, y:15}).
   *
   * PRESENCE is the ownership tag: an anchored window re-resolves; a user drag /
   * resize clears `anchor` (the window becomes user-owned and its absolute x/y is
   * authoritative). Both coords live in ONE object so ownership can't be
   * half-set. See resolveRequestedFloatPosition. */
  anchor?: { x: number; y: number };
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
   * group is a fixed fixture: panes move in/out of it, but the group itself is
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
