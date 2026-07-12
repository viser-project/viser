// Data model for the docking library.
//
// The layout is intentionally serializable: it holds only ids, geometry, and
// structure -- never React nodes. Pane *content* lives in a separate registry
// (see PaneRegistry) keyed by pane id, so the same layout can be saved,
// restored, or driven from the server later without touching the render tree.
//
// Vocabulary (see also spec section 2):
// - Pane: the atomic client unit of content (PaneId/PaneSpec). A pane's
//   presentation in a strip is a "tab"; "panel" is the user-facing container
//   (a tab group presented as a panel; Python PanelHandle).
// - TabGroup: one or more panes shown as tabs in a shared frame. A group with
//   a single pane presents as a plain panel (the tab strip is hidden).
// - Docked region: a fixed three-level shape per screen edge -- DockRegion
//   (columns side by side) -> DockColumn (leaves stacked) -> DockLeaf (one
//   tab group). See the DockRegion docs below.
// - FloatingWindow: a free-positioned container holding a vertical stack of
//   TabGroups (a "snap group"). A stack of one is a normal floating panel.

import React from "react";

/** "Flavored" id types: a phantom optional tag makes the five id kinds
 * mutually unassignable (passing a GroupId where a NodeId is expected is a
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

/** Minimum width of a pane's content, enforced on the inner body container
 * (TabGroupFrame's PanelBody) -- not on the region/window/column layout. When a
 * region is dragged narrower than this, the body keeps this width and the panel
 * scrolls horizontally instead of squeezing the content. The layout itself may
 * commit narrower than this, down to MIN_REGION_GRAB_PX. */
export const MIN_PANEL_WIDTH_PX = 220;

/** Minimum width a docked region / floating window / split column may be
 * resized to in the layout model. Small (the panel body, min MIN_PANEL_WIDTH_PX,
 * simply overflows with a horizontal scrollbar below this), but wide enough to
 * stay comfortably grabbable so a region dragged narrow can always be pulled
 * back wide -- and wide enough that the header chrome (status + action icons)
 * still reads. Kept above MINIMIZED_STRIP_PX so an expanded panel never renders
 * thinner than its own minimized strip. */
export const MIN_REGION_GRAB_PX = 96;

/** Width (px) of the vertical rail a collapsed (railed) column draws (D21).
 * In px (not em) because the rail is the column's reserved width while
 * collapsed: the drawn-width math uses this constant directly, so the
 * rendered width must match it exactly. */
export const MINIMIZED_STRIP_PX = 36;
/** Height of a minimized cell's in-place bar (the one minimized form, D20):
 * grip-bar scale -- the bar reads as "the panel collapsed to its handle"
 * (P13/D14) -- while clearing the P11 20px clickable floor. The 36px
 * MINIMIZED_STRIP_PX above remains the vertical rail's width. */
export const MINIMIZED_BAR_PX = 26;
// A face-bearing bar (a lone pane with a minimizedFace -- the main panel's
// connection-status bar) renders at the unmergeable titleNode header's own
// height: minimizing removes the content but never moves or shrinks the
// label row (D19). The rendered height is FACE_BAR_EM in the
// bar's own font context so it tracks the header exactly.
export const FACE_BAR_HEIGHT_EM = 2.75;
export const FACE_BAR_EM = `${FACE_BAR_HEIGHT_EM}em`;

/** Horizontal padding (em) of the unmergeable titleNode header -- and, by
 * D33's exact constancy, of its face bar: the label row keeps identical x
 * offsets and the compact toggle keeps the same right inset across the
 * minimize/expand round-trip. One constant so the two surfaces cannot
 * drift. */
export const HEADER_PAD_EM = 0.75;

/** Height (em) of a stack handle bar (floating window header, docked parent
 * handle, rail header). Shared with collapsedWindowHeightCss so a collapsed
 * window's computed height agrees with the rendered chrome. */
export const STACK_HANDLE_EM = 1;
// The grip bar's height -- also the rail cell cap's height, so the second
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

/** Rendered height of a group's minimized bar for style use (height /
 * flex-basis): the header's em height for a face bar, the compact px bar
 * otherwise. Same font context as the header, so constancy is exact. */
export function minimizedBarBasis(
  group: TabGroup | undefined,
  panes: Record<string, PaneSpec>,
): number | string {
  return hasMinimizedFace(group, panes) ? FACE_BAR_EM : MINIMIZED_BAR_PX;
}

/** A collapsed floating window's rendered height as a CSS calc() (D34): the
 * window header (multi-group only) plus each cell's bar plus the dividers
 * between them. Every term is deterministic chrome -- bars are fixed
 * MINIMIZED_BAR_PX / FACE_BAR_EM, dividers SPLIT_DIVIDER_PX -- so the
 * collapse transition gets an honest numeric endpoint without measuring the
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
 * panels docked on a narrow viewport), the rendered region widths are scaled
 * down proportionally so they never overlap or fully occlude the scene. This is
 * a render-time cap only -- the model region widths (regionWidth) are preserved,
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

/** Content + metadata for a single pane. Kept out of the serializable layout;
 * supplied by the consumer via the pane registry. */
export interface PaneSpec {
  id: PaneId;
  title: string;
  /** Optional small icon shown before the title in tab strips. */
  icon?: React.ReactNode;
  /** Optional custom header content, used in place of the plain `title` text
   * when this pane renders as a full-width header (i.e. when `unmergeable`).
   * Lets a pane show a richer title bar -- e.g. a connection-status label with
   * action icons -- matching the live control panel's handle. The header is
   * still a drag handle, so interactive children should stopPropagation on
   * pointerdown. */
  titleNode?: React.ReactNode;
  /** When true, the pane body is rendered with no padding so its content sits
   * flush to the panel edges (e.g. a pane whose entire body is a nested
   * dockable area). Default false (the usual comfortable body padding). */
  fullBleed?: boolean;
  /** When true, keep the scrolling body wrapper but drop its default padding --
   * for content that manages its own spacing (e.g. the control panel's
   * generated GUI). Unlike `fullBleed`, the body still scrolls/auto-sizes. */
  unpadded?: boolean;
  /** Optional custom face for this pane's minimized bar (D19), rendered in
   * place of the default icon+title when the pane's group holds only this
   * pane. The bar's gestures (drag, click-to-expand, keyboard) are unchanged;
   * the face is presentation only. E.g. the control panel's connection-status
   * row -- same identity minimized as expanded. */
  minimizedFace?: React.ReactNode;
  /** Renders the pane body. A function (not a node) so content is only built
   * for the active tab and re-evaluated on demand. */
  render: () => React.ReactNode;
  /** When true, this pane may be minimized but never merged into another
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
   * exactly when the group is empty -- which only an area's backing group can
   * be (it persists empty as a drop affordance). `null` (rather than an `""`
   * sentinel that type-checks as a real PaneId) forces every consumer to
   * handle the empty case explicitly. */
  activeId: PaneId | null;
  // NOTE(D38): there is deliberately no `collapsed` field. Collapse is one
  // state at stack scope, stored per container (FloatingWindow.collapsed,
  // DockColumn.railed) -- a partially collapsed stack is unrepresentable by
  // construction. Groups don't collapse; the thing that holds them does.
}

/** Non-empty array: at least one element. Lets the type system guarantee a
 * column always has a leaf and a region always has a column. Array methods
 * (`.filter`/`.slice`/`.map`) return plain `T[]`; use the audited helpers below
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

/** The docked layout has a FIXED three-level shape (D46: columns only),
 * enforced by these types rather than by runtime normalization:
 *
 *   DockRegion  =  a row of columns      (side by side, vertical dividers)
 *     DockColumn  =  a stack of leaves   (top to bottom, horizontal dividers)
 *       DockLeaf    =  one tab group
 *
 * A single docked panel is `Region[Column[Leaf]]` -- counts of one, not a
 * special shape. There is no arbitrary nesting and no `dir` field: the level is
 * the axis. Each dock gesture is a single-level insert:
 *   - dock beside the region or a column -> add a Column to the Region
 *   - dock above/below a panel           -> add a Leaf to that Column
 * This makes the bad shapes (`[A]` over `[B][C]`, arbitrary nesting)
 * unrepresentable, so the renderer and ops never defend against them. */
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
  /** Flex weight relative to sibling columns within the region
   * (horizontal). */
  weight: number;
  /** Per-column rail (D28): when true, this column renders as a 36px spine
   * strip in place (its leaves as rail cells) while its width weight is
   * preserved for restore (P8/D40). The one docked collapse store (D44/D46);
   * the packed region reading is derived (isRegionPackedOn). Set by the
   * column-collapse chevron and by identity transfers (a collapsed window
   * docks as a railed column); cleared by every expand path. */
  railed?: boolean;
}

export interface DockRegion {
  /** Columns side by side, left to right; always at least one (an empty
   * region is `null`). Each column is an independent vertical stack of
   * leaves -- the only vertical arrangement (D46: full-width bands are
   * unrepresentable; a region is columns-of-stacks, so a railed column's
   * freed width always has siblings or the canvas to reflow to). */
  columns: NonEmpty<DockColumn>;
}

/** A floating window's vertical sizing. `auto` tracks content (capped per
 * group); `pinned` is an explicit px height the user dragged to. A tagged union
 * (not `height?: number`) so "auto vs pinned" is an explicit, total state -- no
 * sentinel-undefined ambiguity, and "revert to auto" is a real transition rather
 * than a delete. */
export type WindowHeight = { mode: "auto" } | { mode: "pinned"; px: number };

/** Build a WindowHeight from an optional px: undefined -> auto, else pinned.
 * The one place this mapping lives (producers never open-code the union). */
export function windowHeight(px?: number): WindowHeight {
  return px === undefined ? { mode: "auto" } : { mode: "pinned", px };
}

/** The pinned px height, or undefined when the window auto-sizes. The one place
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
   * bar for a lone main-panel window). One of the two container collapse
   * stores (with DockColumn.railed, D38/D44); the
   * `-` / window-header toggle flips it; every bar's expand affordance
   * clears it. Transfers are identity: docking a collapsed window rails the
   * landing scope, floating a railed scope sets this flag. */
  collapsed?: boolean;
  /** Per-group height weights for a multi-group stack (groupId -> flex weight),
   * used when the window has a pinned `height` so a draggable divider can
   * redistribute height between stacked groups. Missing groups default to
   * weight 1 (equal). Keyed by group id (not index) so it survives stack
   * insert/remove without re-alignment. Keys must belong to the window's stack
   * (invariant #8): detachInPlace deletes a departing group's entry, and the
   * docking ops read the weights back into leaf weights -- a stale key would
   * leak a dead group's height into the next occupant. */
  stackWeights?: Record<GroupId, number>;
  /** Server anchor for a server-placed panel: the canvas-relative coords the
   * window re-resolves to as the canvas + measured window size change (`x`/`y`
   * above are the resolved absolute position). A negative component is a gap from
   * the far edge: x<0 is `|x|`px from the canvas right boundary, y<0 is `|y|`px
   * from the bottom (so top-right is {x:-15, y:15}).
   *
   * Presence is the ownership tag: an anchored window re-resolves; a user drag /
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
  /** Legacy (D44): the old per-edge region-collapse store; never written
   * anymore (the packed-region reading is derived via isRegionPackedOn). It
   * survives in the type only so persisted snapshots and old test literals
   * still parse; `migrateRegionCollapsedInPlace` (layoutOps) converts a set
   * flag into per-column railed flags at the injection/restore chokepoints
   * and deletes it. */
  regionCollapsed?: Record<DockEdge, boolean>;
  /** Docked region widths in px per edge: the width-determining columns'
   * summed pixels (dividers render on top -- see regionPlan; collapse states
   * never move width, D20).
   * The single source of truth for region width. It travels with the layout
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
  floating: [],
  areas: {},
});

/** Whether every column of `region` is railed (D44/D46): the fully packed
 * form -- side-by-side 36px strips, width reclaimed by the canvas. False
 * for null (an empty edge has nothing railed). */
export const isRegionFullyRailed = (region: DockRegion | null): boolean =>
  region !== null && region.columns.every((c) => c.railed === true);

/** The derived region-rail predicate (D44/D46): the edge is fully packed
 * iff its region exists and every column is railed -- the state the region
 * chevron (rail-all) produces and per-column chevrons can compose. Under
 * the columns-only model (D46) this is exactly isRegionFullyRailed; the
 * name survives because chrome and tests key on the "packed" concept. */
export const isRegionPackedOn = (layout: DockLayout, edge: DockEdge): boolean =>
  isRegionFullyRailed(layout.docked[edge]);

/** The layout's region widths with defaults filled in (the one place the
 * missing-field fallback lives). */
export const regionWidthsOf = (
  layout: DockLayout,
): Record<DockEdge, number> => ({
  left: layout.regionWidth?.left ?? DEFAULT_REGION_PX,
  right: layout.regionWidth?.right ?? DEFAULT_REGION_PX,
});
