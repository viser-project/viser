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

/** "Flavored" id types: a phantom optional tag makes the five id kinds
 * mutually UNassignable (passing a GroupId where a NodeId is expected is a
 * compile error -- exactly the argument-swap bug class of stringly-typed ids)
 * while plain string literals and wire/DOM strings still flow in without
 * casts (the tag is optional, so `string` remains assignable to every id).
 * Deliberately a flavor, not a hard brand: ids genuinely originate as strings
 * (server uuids, data-* attributes, test literals), so a required brand would
 * just scatter as-casts over every boundary. */
declare const idFlavor: unique symbol;
type Flavor<K extends string> = string & { readonly [idFlavor]?: K };

export type PaneId = Flavor<"PaneId">;
export type GroupId = Flavor<"GroupId">;
export type WindowId = Flavor<"WindowId">;
export type NodeId = Flavor<"NodeId">;
export type AreaId = Flavor<"AreaId">;

/** Exhaustiveness backstop for switches/if-chains over tagged unions: the
 * compiler errors here when a new variant isn't handled; at runtime (only
 * reachable on data that lies about its type) it throws. */
export function assertNever(x: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(x)}`);
}

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

/** Width (px) of the vertical RAIL an EXPLICITLY collapsed region draws
 * (D21). In px (not em) because the rail is the region's reserved width while
 * collapsed: the drawn-width math uses this constant directly, so the
 * rendered width must match it exactly. */
export const MINIMIZED_STRIP_PX = 36;
/** Height of a minimized cell's in-place BAR (the ONE minimized form, D20):
 * grip-bar scale -- the bar reads as "the panel collapsed to its handle"
 * (P13/D14) -- while clearing the P11 20px clickable floor. The 36px
 * MINIMIZED_STRIP_PX above remains the vertical RAIL's width. */
export const MINIMIZED_BAR_PX = 26;
// A FACE-bearing bar (a lone pane with a minimizedFace -- the main panel's
// connection-status bar) renders at the unmergeable titleNode header's own
// height: minimizing removes the content but never moves or shrinks the
// label row (D19, restored). The RENDERED height is FACE_BAR_EM in the
// bar's own font context so it tracks the header exactly; FACE_BAR_PX is
// the px estimate (2.75em at Mantine's ~14.8px body font) used only where
// layout math needs a number (band floors).
export const FACE_BAR_HEIGHT_EM = 2.75;
export const FACE_BAR_EM = `${FACE_BAR_HEIGHT_EM}em`;
export const FACE_BAR_PX = 41;

/** Horizontal padding (em) of the unmergeable titleNode header -- and, by
 * D33's EXACT constancy, of its face bar: the label row keeps identical x
 * offsets and the compact toggle keeps the same right inset across the
 * minimize/expand round-trip. One constant so the two surfaces cannot
 * drift. */
export const HEADER_PAD_EM = 0.75;

/** Height (em) of a stack handle bar (floating window header, docked parent
 * handle, rail header). Shared with collapsedWindowHeightCss so a collapsed
 * window's computed height agrees with the rendered chrome. */
export const STACK_HANDLE_EM = 1;
// The grip bar's height -- ALSO the rail cell cap's height, so the second
// chrome row aligns across a railed column and its expanded neighbor (the
// cap is the grip bar's counterpart in the rail rendering).
export const GRIP_BAR_EM = 0.9;

/** Does this group's bar carry a pane-provided face (lone pane only)? */
export function hasMinimizedFace(
  group: TabGroup | undefined,
  panes: Record<string, PaneSpec>,
): boolean {
  return (
    group !== undefined &&
    group.paneIds.length === 1 &&
    panes[group.paneIds[0]]?.minimizedFace !== undefined
  );
}

/** Rendered height of a group's minimized bar for STYLE use (height /
 * flex-basis): the header's em height for a face bar, the compact px bar
 * otherwise. Same font context as the header, so constancy is exact. */
export function minimizedBarBasis(
  group: TabGroup | undefined,
  panes: Record<string, PaneSpec>,
): number | string {
  return hasMinimizedFace(group, panes) ? FACE_BAR_EM : MINIMIZED_BAR_PX;
}

/** Bar height as a NUMBER for layout math (band floors); px estimate for
 * face bars. Keep in sync with minimizedBarBasis. */
export function minimizedBarPx(
  group: TabGroup | undefined,
  panes: Record<string, PaneSpec>,
): number {
  return hasMinimizedFace(group, panes) ? FACE_BAR_PX : MINIMIZED_BAR_PX;
}

/** A collapsed floating window's rendered height as a CSS calc() (D34): the
 * window header (multi-group only) plus each cell's bar plus the dividers
 * between them. Every term is deterministic chrome -- bars are fixed
 * MINIMIZED_BAR_PX / FACE_BAR_EM, dividers SPLIT_DIVIDER_PX -- so the
 * collapse transition gets an HONEST numeric endpoint without measuring the
 * DOM. Em terms stay em (they resolve in the window's own font context, so
 * face bars track the header exactly); px terms stay px. */
export function collapsedWindowHeightCss(
  stackGroups: (TabGroup | undefined)[],
  panes: Record<string, PaneSpec>,
): string {
  let em = stackGroups.length > 1 ? STACK_HANDLE_EM : 0;
  let px = Math.max(0, stackGroups.length - 1) * SPLIT_DIVIDER_PX;
  for (const g of stackGroups) {
    if (hasMinimizedFace(g, panes)) em += FACE_BAR_HEIGHT_EM;
    else px += MINIMIZED_BAR_PX;
  }
  return `calc(${em}em + ${px}px)`;
}
/** Width/height (em) of the square handle icon buttons (+/- toggles, the
 * region chevron's clearance). One constant so offsets that must clear a
 * button derive from the size they are dodging. */
export const HANDLE_BTN_EM = 1.7;

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
export const MIN_WINDOW_HEIGHT_PX = 50;

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
  /** Optional custom face for this pane's minimized BAR (D19), rendered in
   * place of the default icon+title when the pane's group holds ONLY this
   * pane. The bar's gestures (drag, click-to-expand, keyboard) are unchanged;
   * the face is presentation only. E.g. the control panel's connection-status
   * row -- same identity minimized as expanded. */
  minimizedFace?: React.ReactNode;
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

/** A stack of panes shown as tabs. */
export interface TabGroup {
  id: GroupId;
  paneIds: PaneId[];
  /** The active tab: always a member of `paneIds` (invariant #5), and `null`
   * exactly when the group is EMPTY -- which only an area's backing group can
   * be (it persists empty as a drop affordance). Previously an empty group
   * carried an `""` sentinel that type-checked as a real PaneId and leaked
   * into title fallbacks; `null` forces every consumer to handle the empty
   * case explicitly. */
  activeId: PaneId | null;
  // NOTE(D38): there is deliberately NO `collapsed` field. Collapse is ONE
  // state at STACK scope, stored per container (FloatingWindow.collapsed,
  // DockColumn.railed, DockLayout.regionCollapsed) -- a partially collapsed
  // stack is unrepresentable by construction. Groups don't collapse; the
  // thing that holds them does.
}

/** Non-empty array: at least one element. Lets the type system guarantee a
 * column always has a leaf and a region always has a column. Array methods
 * (`.filter`/`.slice`/`.map`) return plain `T[]`; use the AUDITED helpers below
 * (mapNonEmpty / withInserted / layoutOps' asNonEmpty) instead of sprinkling
 * `as NonEmpty` casts -- each helper is non-empty by construction, so the one
 * cast lives next to its proof. */
export type NonEmpty<T> = [T, ...T[]];

/** `.map` over a NonEmpty: same length, so non-empty by construction. */
export const mapNonEmpty = <T, U>(
  xs: NonEmpty<T>,
  f: (x: T, i: number) => U,
): NonEmpty<U> => xs.map(f) as NonEmpty<U>;

/** `xs` with `items` (>=1) spliced in at `index`: gains elements, so non-empty
 * by construction even when `xs` is plain (possibly empty). */
export const withInserted = <T>(
  xs: readonly T[],
  index: number,
  ...items: NonEmpty<T>
): NonEmpty<T> =>
  [...xs.slice(0, index), ...items, ...xs.slice(index)] as NonEmpty<T>;

/** The docked layout has a FIXED four-level shape, enforced by these types
 * rather than by runtime normalization:
 *
 *   DockRegion  =  a COLUMN of rows      (full-width bands, top to bottom)
 *     DockRow     =  a ROW of columns    (side by side, vertical dividers)
 *       DockColumn  =  a STACK of leaves (top to bottom, horizontal dividers)
 *         DockLeaf    =  one tab group
 *
 * A single docked panel is `Region[Row[Column[Leaf]]]` -- counts of one, not a
 * special shape. There is NO arbitrary nesting and NO `dir` field: the LEVEL is
 * the axis. Each dock gesture is a single-level insert:
 *   - dock ABOVE/BELOW the whole region  -> add a Row band (spans every column)
 *   - dock BESIDE within a band          -> add a Column to that Row
 *   - dock ABOVE/BELOW a panel           -> add a Leaf to that Column
 * This makes the bad shapes (a leaf directly in a row, `row>col>row...` nesting)
 * unrepresentable, so the renderer and ops never defend against them, while the
 * standard "band above everything" affordance stays expressible. */
export interface DockLeaf {
  id: NodeId;
  group: GroupId;
  /** Flex weight relative to sibling leaves within the column (vertical). */
  weight: number;
}

export interface DockColumn {
  id: NodeId;
  /** Stacked top to bottom; always at least one. */
  leaves: NonEmpty<DockLeaf>;
  /** Flex weight relative to sibling columns within the row (horizontal). */
  weight: number;
  /** Per-COLUMN rail: when true, this column renders as a 36px spine strip in
   * place (its leaves as rail cells) while its width weight is preserved for
   * restore (P8). Only meaningful for columns in multi-column bands -- the
   * whole-region rail (regionCollapsed, D21) remains the single-column-region
   * form. Set by the column-collapse chevron and by ops that dock a new
   * column beside a region-railed region (the old content stays railed, the
   * newcomer lands expanded); cleared by every expand path. */
  railed?: boolean;
}

export interface DockRow {
  id: NodeId;
  /** Columns side by side; always at least one. */
  columns: NonEmpty<DockColumn>;
  /** Flex weight relative to sibling rows within the region (vertical). */
  weight: number;
}

export interface DockRegion {
  /** Full-width row bands stacked top to bottom; always at least one (an empty
   * region is `null`). The common side-by-side case is a region with one row. */
  rows: NonEmpty<DockRow>;
}

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
  /** The window's ONE collapse flag (D38): while true, the whole window is
   * minimized and renders as its stack of 26px bars at full `width` (a face
   * bar for a lone main-panel window). One of the three container collapse
   * stores (with DockColumn.railed and DockLayout.regionCollapsed) -- the
   * `-` / window-header toggle flips it; every bar's expand affordance
   * clears it. Transfers are identity: docking a collapsed window rails the
   * landing scope, floating a railed scope sets this flag. */
  collapsed?: boolean;
  /** Per-group height weights for a multi-group stack (groupId -> flex weight),
   * used when the window has a pinned `height` so a draggable divider can
   * redistribute height between stacked groups. Missing groups default to
   * weight 1 (equal). Keyed by group id (not index) so it survives stack
   * insert/remove without re-alignment. Keys MUST belong to the window's stack
   * (invariant #9): detachInPlace deletes a departing group's entry, and the
   * docking ops read the weights back into leaf weights -- a stale key would
   * leak a dead group's height into the next occupant. */
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
  docked: Record<DockEdge, DockRegion | null>;
  /** EXPLICIT per-edge region collapse (D21): true renders the edge's whole
   * region as the 36px vertical rail, regardless of per-cell collapse states.
   * Toggled only by the region-collapse chevron / rail header (and cleared by
   * expanding a panel from the rail or floating the region) -- never flips
   * emergently from cell minimize states. NEVER set while the edge is empty:
   * detachInPlace clears it at the one chokepoint when an edge empties (and
   * floatRegion clears its own path), so a stale flag can't ambush the next
   * region docked there with a surprise rail (invariant #14). */
  regionCollapsed: Record<DockEdge, boolean>;
  /** Docked region widths in px per edge: the width-determining columns'
   * summed pixels (dividers render on top -- see regionPlan; collapse states
   * never move width, D20).
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
  areas?: Record<AreaId, { group: GroupId }>;
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
  regionCollapsed: { left: false, right: false },
  floating: [],
  areas: {},
});

/** An edge's explicit region-collapse flag (D21), tolerant of layouts that
 * predate the field (persisted snapshots, test-probe injections): a missing
 * record reads as expanded. The ONE place the fallback lives. */
export const isRegionCollapsedOn = (
  layout: DockLayout,
  edge: DockEdge,
): boolean =>
  (layout.regionCollapsed as Record<DockEdge, boolean> | undefined)?.[edge] ===
  true;

/** The layout's region widths with defaults filled in (the one place the
 * missing-field fallback lives). */
export const regionWidthsOf = (
  layout: DockLayout,
): Record<DockEdge, number> => ({
  left: layout.regionWidth?.left ?? DEFAULT_REGION_PX,
  right: layout.regionWidth?.right ?? DEFAULT_REGION_PX,
});
