// D#/P#/section citations refer to ./dock-ux-spec.md (the normative spec,
// in this directory).
// The window-drag controller: every dock gesture that moves panels -- dragging
// a floating window, floating a docked group/column/region, tearing out a tab,
// reordering tabs -- is armed and run from here. DockManager composes this
// hook and exposes the returned gesture starters through DockContext; layout
// changes flow back out exclusively through the applyOp/commit pipeline the
// manager passes in.
//
// Drag model: every drag is normalized to "dragging a floating window". A drag
// that starts on a docked group or a tab first floats/tears that group into a
// new window (via flushSync, so the window DOM exists immediately), then drags
// it. Movement is applied as a CSS transform on the window element so the
// per-move setState (for the drop hint) doesn't clobber it. On release we
// either apply a docking op for the hovered drop target, or commit the final
// floating position.
//
// This module owns drag arbitration (press vs. click vs. tear-out), drop-target
// collection from the rendered DOM, the stale-rect cache that keeps those
// targets honest mid-drag, and the imperative feedback during a drag (drop
// hint, leaf split preview, window transform, tab glue). It never commits
// layout state itself except through the injected applyOp/commit callbacks.

import React from "react";
import { flushSync } from "react-dom";
import { DockContextValue } from "./DockContext";
import { paintDropHint } from "./dropHint";
import {
  bindPointerGesture,
  grabbingCursor,
  motionExceedsThreshold,
  suppressTextSelection,
  tryCapture,
  tryRelease,
} from "./gestures";
import {
  DropHint,
  DropResult,
  DropTargets,
  GroupContext,
  GroupTarget,
  hitTest,
  tabInsertion,
} from "./hitTest";
import * as ops from "./layoutOps";
import {
  assertNever,
  clamp,
  DEFAULT_REGION_PX,
  DockEdge,
  DockLayout,
  GroupId,
  MIN_REGION_GRAB_PX,
  NodeId,
  PaneId,
  PaneRegistry,
  regionWidthsOf,
  WindowId,
} from "./types";

// Keep at least this much of a floating window's top-left corner on-screen so
// its handle stays reachable (panes may otherwise overflow off-screen).
const KEEP_VISIBLE_PX = 40;

/** Clamp a floating window's top-left corner so the handle stays reachable. The
 * corner stays within the container (no off-top/left), but the window body may
 * extend past the right/bottom edges. */
export function clampCorner(
  x: number,
  y: number,
  containerW: number,
  containerH: number,
): [number, number] {
  return [
    clamp(x, 0, containerW - KEEP_VISIBLE_PX),
    clamp(y, 0, containerH - KEEP_VISIBLE_PX),
  ];
}

// How far past a tab strip's edge the pointer must travel before a tab reorder
// becomes a tear-out into a floating window.
const TAB_TEAR_PX = 30;
// A nested area's hit rect is inset by up to this much on its left/right/bottom
// so a frame around a full-bleed area falls through to the host panel's zones.
const AREA_HIT_INSET_PX = 40;
// Areas with a smaller rendered rect than this are skipped as drop targets:
// a minimized host collapses its area to ~0px, and offering that would put a
// phantom target over the host's own handle. Kept well below the smallest
// legitimate area (an empty "drop a panel here" placeholder is ~40px tall --
// it must stay droppable), and well above the collapsed case (~0px).
const AREA_MIN_TARGET_PX = 24;

/** Validate a data-dock-edge attribute into the DockEdge union. A raw
 * `getAttribute(...) as DockEdge` would let a markup typo flow into
 * `layout.docked[edge]` as undefined and silently no-op every drop. */
const parseDockEdge = (raw: string | null): DockEdge | null =>
  raw === "left" || raw === "right" ? raw : null;

/** What the controller needs from DockManager. Mutable state is passed as
 * refs, never as snapshots: gesture closures outlive the render they were
 * created in and must read the synchronous truth (layoutRef, the rendered
 * reserved widths) at event time. */
export interface DragControllerDeps {
  panes: PaneRegistry;
  /** The dock root; drop-target scans and container-coordinate math use it. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The persistent drop-hint element (see dropHint.ts). */
  hintRef: React.RefObject<HTMLDivElement | null>;
  layoutRef: React.MutableRefObject<DockLayout>;
  /** Rendered region widths per edge (DockManager assigns them each render);
   * hit testing aligns drop zones to what's on screen, not the model width. */
  reservedWidthRef: React.MutableRefObject<{ left: number; right: number }>;
  /** Cleanup for an in-flight gesture; DockManager runs it if the manager
   * unmounts mid-drag. */
  activeCleanup: React.MutableRefObject<(() => void) | null>;
  /** The window currently being dragged, if any. DockManager's resize/anchor
   * paths skip it (the cursor is the source of truth for its position
   * mid-drag); this controller sets it for each drag's duration. */
  draggingWindowIdRef: React.MutableRefObject<WindowId | null>;
  /** Set for the duration of a drag: lets DockManager's per-window
   * ResizeObserver mark the drag's cached target rects stale (a window
   * growing mid-drag). */
  markDragTargetsStaleRef: React.MutableRefObject<(() => void) | null>;
  /** Structural commits (invariant-checked, width-reconciled). */
  applyOp: (next: DockLayout) => void;
  /** Direct commit, for the Escape-cancel restore path only: the snapshot
   * already carries valid widths, so it must bypass width reconciliation. */
  commit: (next: DockLayout) => void;
  /** Select a tab and expand its group (the no-motion click on a tab). */
  expandToTab: (groupId: GroupId, paneId: PaneId) => void;
  setDraggingGroupId: React.Dispatch<React.SetStateAction<GroupId | null>>;
  setDraggingTabId: React.Dispatch<React.SetStateAction<PaneId | null>>;
}

/** The drag controller. Called once per DockManager render (the gesture
 * starters close over fresh props, exactly as they did inline); the returned
 * `stableGestures` object is memoized once and dispatches through a ref, so
 * the context value doesn't churn identity on every render. */
export function useDragController(deps: DragControllerDeps) {
  const {
    panes,
    containerRef,
    hintRef,
    layoutRef,
    reservedWidthRef,
    activeCleanup,
    draggingWindowIdRef,
    markDragTargetsStaleRef,
    applyOp,
    commit,
    expandToTab,
    setDraggingGroupId,
    setDraggingTabId,
  } = deps;

  const showHint = (hint: DropHint | null) =>
    paintDropHint(hintRef.current, hint);

  const containerRect = () =>
    containerRef.current?.getBoundingClientRect() ?? new DOMRect();

  // --- Drop-target hit testing -------------------------------------------
  //
  // The data-attribute contract between the renderers and this scanner. The
  // attributes are a stringly, multi-file protocol -- two past bugs came from
  // a renderer and this scanner disagreeing about it -- so the rules live here,
  // next to the only reader:
  //
  //   data-dock-leaf=<nodeId> + data-dock-edge=<left|right>
  //     A docked drop target. The leaf wrapper's rect is the drop rect,
  //     except inside a column rail (below): rail cell wrappers size to
  //     content, so the scanner extends the LAST cell's rect to the strip's
  //     bottom (the header run above the first cell is controls, D53).
  //     Rendered by SplitView's DockLeafView and VerticalMinimizedColumn's
  //     rail cells (docked).
  //   data-dock-rail-root=<columnId>
  //     A ColumnRail's root: the full 36px strip (region-tall -- rails hold
  //     width, not height). The scanner tiles its box onto the cells BELOW
  //     the header chrome (last cell claims the empty tail below the spine
  //     rows; interior cells keep their own boxes). The header run -- the
  //     `+` handle bar and chevron rows above the first cell -- is controls,
  //     not a drop surface (D53).
  //   data-dock-group=<groupId>
  //     The group's element: the leaf wrapper itself or any descendant (both
  //     accepted). Scopes the strip/tab lookup; carries
  //     data-dock-collapsed="true" when minimized. Also rendered inside
  //     floating windows (scanned per-window, snap index from the model stack)
  //     and areas (TabGroupFrame).
  //   data-dock-strip=<groupId> / data-dock-tab=<paneId>
  //     The tab strip and its tabs, descendants of their group element; a tab
  //     whose nearest [data-dock-group] ancestor isn't the scanned group is
  //     skipped (nested areas don't leak tabs into the host).
  //   data-floating-window=<windowId>
  //     A floating window's root.
  //   data-dock-area=<areaId>
  //     A nested area's wrapper; its rect is the drop rect (inset via
  //     hitRect), its group comes from the layout (an empty area renders no
  //     group element but is still a target).
  //   data-dock-column / data-dock-header / data-dock-minimize /
  //   data-dock-griphandle
  //     Gesture/measurement hooks only; never drop targets.

  const collectTargets = (draggedWindowId: WindowId): DropTargets => {
    const container = containerRef.current;
    const targets: DropTargets = { groups: [] };
    if (container === null) return targets;

    // Collect the strip + tabs that belong to one group, scoped so a nested
    // group (e.g. a DockArea inside this panel's body) doesn't leak its strip or
    // tabs into this target. `rectEl` is the element whose box defines the
    // target's hit rect (a docked leaf's wrapper, the group element itself, or
    // an area's wrapper).
    const buildTarget = (
      rectEl: Element,
      scopeEl: Element,
      groupId: GroupId,
      ctx: GroupContext,
    ): GroupTarget => {
      const stripEl = scopeEl.querySelector(`[data-dock-strip="${groupId}"]`);
      const tabs: { paneId: PaneId; rect: DOMRect; index: number }[] = [];
      // The model's pane order; a tab's index comes from HERE, not from its
      // position in the collected array, which omits invisible and clipped
      // tabs (an omission would otherwise shift every later tab's insertion
      // index by one).
      const paneOrder = layoutRef.current.groups[groupId]?.paneIds ?? [];
      scopeEl.querySelectorAll("[data-dock-tab]").forEach((t) => {
        // Skip tabs that belong to a nested group (their nearest group ancestor
        // isn't ours).
        if (t.closest("[data-dock-group]") !== scopeEl) return;
        // Skip overflow-hidden bar labels (visibility:hidden behind the +N
        // badge): an invisible element must not be an insertion target (P1).
        if (getComputedStyle(t).visibility === "hidden") return;
        const paneId = t.getAttribute("data-dock-tab");
        if (paneId === null) return;
        const index = paneOrder.indexOf(paneId);
        tabs.push({
          paneId,
          rect: t.getBoundingClientRect(),
          // A tab whose pane isn't in the model (mid-commit DOM) keeps its
          // DOM position -- the old behavior, and harmless: the op guards
          // its own bounds.
          index: index === -1 ? tabs.length : index,
        });
      });
      return {
        groupId,
        rect: rectEl.getBoundingClientRect(),
        stripRect: stripEl?.getBoundingClientRect() ?? null,
        tabs,
        ctx,
        // Container-collapsed cells (window flag / column rail / region
        // rail, D38) need the collapsed-target zones -- see
        // isGroupEffectivelyCollapsed.
        collapsed: ops.isGroupEffectivelyCollapsed(layoutRef.current, groupId),
        bar: scopeEl.getAttribute("data-dock-bar") === "true",
        unmergeable: ops.isGroupUnmergeable(layoutRef.current, panes, groupId),
      };
    };
    // `rectEl` overrides the element whose box is the drop rect (defaults to
    // the group element itself).
    const readGroup = (
      el: Element,
      ctx: GroupContext,
      rectEl: Element = el,
    ): GroupTarget | null => {
      const groupId = el.getAttribute("data-dock-group");
      if (groupId === null) return null;
      return buildTarget(rectEl, el, groupId, ctx);
    };

    // Visual clip for floating-derived rects: the dock root is
    // overflow:hidden, so any part of a floating window past a container
    // edge is invisible (clampCorner keeps only the top-left corner
    // reachable -- the body may legally overflow right/bottom, e.g. an
    // auto-height window taller than the container). An invisible sliver
    // must not be a drop surface, and zones/hints must compute from what is
    // on screen (P1) -- the floating analog of the docked scroll clip
    // below. Targets whose visible remnant is sub-8px are dropped entirely
    // (P11: a zone that can't hold 8px is removed, not shrunk).
    const cbox = container.getBoundingClientRect();
    const clipRect = (
      r: DOMRect,
      box: DOMRect,
      min: number,
    ): DOMRect | null => {
      const left = Math.max(r.left, box.left);
      const top = Math.max(r.top, box.top);
      const right = Math.min(r.right, box.right);
      const bottom = Math.min(r.bottom, box.bottom);
      if (right - left < min || bottom - top < min) return null;
      return new DOMRect(left, top, right - left, bottom - top);
    };
    const clipToContainer = (r: DOMRect): DOMRect | null =>
      clipRect(r, cbox, 8);
    /** Clip a target's strip + tab rects to the box its cell is actually
     * visible in, dropping tabs with nothing left. Zones and hints are then
     * computed from painted pixels only: without this, an insertion line for
     * a tab straddling the container edge (or scrolled out of its column)
     * paints outside the dock, and a fully-hidden tab can still be the
     * nearest insertion target. Tabs carry explicit model indices, so
     * dropping them keeps insertion positions correct. A sub-1px sliver is
     * treated as gone (tabs are hit by nearest-distance, not containment, so
     * unlike the 8px zone floor there is no minimum useful size). */
    const clipChromeTo = (t: GroupTarget, box: DOMRect): void => {
      if (t.stripRect !== null) {
        // A strip clipped to nothing keeps a DEGENERATE boundary at the top
        // of the visible box rather than becoming null. hitTest reads
        // `clientY < strip.top` as "above the strip -> split above this
        // cell"; with a null strip that whole branch is skipped and the
        // pointer falls through to the content rules, so a scrolled-out
        // cell's parent-handle band silently became a MERGE target ("add a
        // tab here") instead of the honest split (P1). Zero height, so it
        // never claims a tab-insert row of its own.
        t.stripRect =
          clipRect(t.stripRect, box, 1) ??
          new DOMRect(t.rect.left, box.top, t.rect.width, 0);
      }
      t.tabs = t.tabs.flatMap((tab) => {
        const rect = clipRect(tab.rect, box, 1);
        return rect === null ? [] : [{ ...tab, rect }];
      });
    };

    // Nested dockable areas, collected up front and keyed by host window
    // (null = hosted in a docked panel). Each area is pushed right after its
    // host's group targets, so it beats its host (the area is visually inside
    // it) but not a different floating window stacked above the host --
    // targets stay strictly back-to-front (3.5). The area's group id comes
    // from the layout (not the DOM), so an empty area -- which renders no
    // inner group/strip -- is still a valid drop target sized to its wrapper.
    const areasByHost = new Map<string | null, GroupTarget[]>();
    const areas = layoutRef.current.areas ?? {};
    container.querySelectorAll("[data-dock-area]").forEach((areaEl) => {
      const areaId = areaEl.getAttribute("data-dock-area");
      if (areaId === null) return;
      const area = areas[areaId];
      if (area === undefined) return;
      if (layoutRef.current.groups[area.group] === undefined) return;
      // Never offer an area that lives inside the dragged window: dropping the
      // window into its own nested area would make the host a child of itself
      // (a containment cycle). Floating windows already skip the dragged one
      // below; areas are found by a container-wide scan, so filter here too.
      if (
        areaEl.closest(`[data-floating-window="${draggedWindowId}"]`) !== null
      )
        return;
      // Skip an area whose host panel is minimized: its wrapper collapses to
      // (near) zero height, and flooring that into a hit band would put a
      // phantom "drop into area" target on top of the host's own handle/zones.
      // Clipped to the container first: an area inside a window that
      // overflows the container bottom must only claim its visible part.
      const areaRect = clipToContainer(areaEl.getBoundingClientRect());
      if (
        areaRect === null ||
        areaRect.height < AREA_MIN_TARGET_PX ||
        areaRect.width < AREA_MIN_TARGET_PX
      )
        return;
      const innerGroupEl = areaEl.querySelector(
        `[data-dock-group="${area.group}"]`,
      );
      const t = buildTarget(areaEl, innerGroupEl ?? areaEl, area.group, {
        kind: "area",
        areaId,
      });
      t.rect = areaRect;
      clipChromeTo(t, areaRect);
      // Inset the area's hit rect on the left/right/bottom (not the top, which
      // holds its tab strip) so a frame around it falls through to the host
      // panel's own edge zones -- otherwise a full-bleed area (one that fills its
      // whole panel) would shadow the host everywhere, leaving no way to dock
      // beside/below it. `rect` stays full so the merge hint is still full-width;
      // only `hitRect` (used for hit detection) is inset.
      const r = t.rect;
      // Apply an inset only when the remaining band stays usefully large;
      // otherwise skip that inset entirely. Flooring the size instead (the old
      // form) let the hit rect exceed the area's real rect for areas shorter/
      // narrower than the floor (24-40px), creating a phantom hit zone
      // outside the visible area.
      const mxRaw = Math.min(AREA_HIT_INSET_PX, r.width * 0.28);
      const mbRaw = Math.min(AREA_HIT_INSET_PX, r.height * 0.28);
      const mx = r.width - 2 * mxRaw >= AREA_HIT_INSET_PX ? mxRaw : 0;
      const mb = r.height - mbRaw >= AREA_HIT_INSET_PX ? mbRaw : 0;
      t.hitRect = new DOMRect(
        r.left + mx,
        r.top,
        r.width - 2 * mx,
        r.height - mb,
      );
      const hostWinId =
        areaEl
          .closest("[data-floating-window]")
          ?.getAttribute("data-floating-window") ?? null;
      const list = areasByHost.get(hostWinId) ?? [];
      list.push(t);
      areasByHost.set(hostWinId, list);
    });
    container.querySelectorAll("[data-dock-leaf]").forEach((leaf) => {
      const nodeId = leaf.getAttribute("data-dock-leaf");
      const edge = parseDockEdge(leaf.getAttribute("data-dock-edge"));
      const groupEl = leaf.matches("[data-dock-group]")
        ? leaf
        : leaf.querySelector("[data-dock-group]");
      if (nodeId === null || edge === null || groupEl === null) return;
      // The leaf wrapper's box is the drop target; the group element inside
      // (possibly a compact rail cell) scopes the strip/tab lookup.
      const g = readGroup(groupEl, { kind: "docked", nodeId, edge }, leaf);
      if (g === null) return;
      // Column rail cells size to content, but the rail's droppable surface
      // runs to the strip's BOTTOM: the last cell's rect extends to the rail
      // root's bottom (the empty tail -> that cell's stack-below zone + side
      // slivers). The header run ABOVE the first cell is deliberately NOT a
      // cell drop surface (D53, user-adjudicated, reversing the pre-D53
      // rule): the `+` handle bar and chevron rows are interactive CONTROLS,
      // and a "stack above <first panel>" zone claiming their pixels read as
      // the controls being drop targets -- so the first cell's rect starts
      // where the cell actually starts and the top split line draws at the
      // honest landing seam below the chrome. The header pixels resolve at
      // REGION level instead: §5.1 side bands where they reach (dock a
      // column BESIDE the rail), float-at-pointer past them -- never through
      // the controls into the cell. hitTest's collapsed branch anchors the
      // stack-below hint at the spine content's true bottom, not the
      // extended rect's.
      //
      // And clamp every cell to the rail root box (stability pass 2026-07):
      // the rail's spine Paper scrolls (overflowY auto), so an overflowing
      // spine's cell rects would otherwise bleed past the strip's box,
      // leaving phantom drop targets where nothing renders. Cells fully
      // below the root box are dropped as targets entirely.
      const railRoot = leaf.closest("[data-dock-rail-root]");
      if (railRoot !== null) {
        const rr = railRoot.getBoundingClientRect();
        const cells = railRoot.querySelectorAll("[data-dock-leaf]");
        const top = Math.max(g.rect.top, rr.top);
        const bottom =
          cells[cells.length - 1] === leaf
            ? rr.bottom
            : Math.min(g.rect.bottom, rr.bottom);
        if (bottom - top < 8) return; // fully overflowed/scrolled out.
        // Spine rows clip to the rail's VISIBLE box before the last cell's
        // tail extension below, so a scrolled-out row is never the nearest
        // vertical insertion target and its line never paints outside the
        // rail (the rotated analog of the expanded strip's clip).
        clipChromeTo(
          g,
          clipRect(g.rect, rr, 1) ??
            new DOMRect(g.rect.left, rr.top, g.rect.width, 0),
        );
        if (top !== g.rect.top || bottom !== g.rect.bottom) {
          g.rect = new DOMRect(g.rect.left, top, g.rect.width, bottom - top);
        }
      } else {
        // Expanded columns. Two boxes matter here and they are NOT the same:
        // the cell's visible content (clipped to the column's scroll box) and
        // the parent-handle run ABOVE that scroll box, which the first cell
        // also claims (P5: region-owned chrome must not be a no-drop hole --
        // the old top region band died with D46; a pointer there resolves to
        // "split above the first cell", honest per P1).
        const columnEl = leaf.closest("[data-dock-column]");
        const isFirstCell =
          columnEl !== null &&
          columnEl.querySelectorAll("[data-dock-leaf]")[0] === leaf;
        // Content box: with overflowY auto a squeezed, scrolled column
        // reports leaf rects extending past its visible box, and hitTest's
        // last-match rule would pick the invisible scrolled-out leaf over
        // the visible one under the pointer (P1). (Rail cells never sit in
        // a [data-dock-scroll]; their clamp is the rail-root branch above.)
        const scrollEl = leaf.closest("[data-dock-scroll]");
        let top = g.rect.top;
        let bottom = g.rect.bottom;
        let contentBox: DOMRect = g.rect;
        if (scrollEl !== null) {
          const sr = scrollEl.getBoundingClientRect();
          top = Math.max(top, sr.top);
          bottom = Math.min(bottom, sr.bottom);
          if (bottom - top < 8) {
            // Nothing of the cell's content is visible. For any cell but the
            // first that means "not a target". The FIRST cell still owns the
            // handle band above the scroll box, which never scrolls -- and no
            // other cell can claim it (they aren't the first child), so
            // dropping the target here would re-open the P5 hole for a column
            // scrolled past its first cell.
            if (!isFirstCell) return;
            // Zero-height content box AT THE SCROLL BOX'S TOP: the band the
            // cell keeps runs from the column top down to here, so this is
            // where its (scrolled-away) strip logically begins -- and
            // clipChromeTo anchors the degenerate strip boundary to it, which
            // is what makes the band read as "above the strip" (split above)
            // rather than falling through to the content rules (merge).
            contentBox = new DOMRect(g.rect.left, sr.top, g.rect.width, 0);
            top = sr.top;
            bottom = sr.top;
          } else {
            contentBox = new DOMRect(
              g.rect.left,
              top,
              g.rect.width,
              bottom - top,
            );
          }
        }
        // Extend the first cell up over the parent-handle run. Ordered AFTER
        // the scroll clip, which clamps to the scroll box and would otherwise
        // undo this deliberate extension (the handle sits ABOVE that box).
        if (isFirstCell) {
          const cr = columnEl.getBoundingClientRect();
          if (cr.top < top) {
            // Remember where the cell really starts: the split-above LANDS
            // below the column's handle bar, so the hint line must draw at
            // this seam even though the hit zone covers the chrome (P5 vs
            // P1 -- the zone is generous, the line is honest).
            g.contentTop = top;
            top = cr.top;
          }
        }
        if (bottom - top < 8) return; // no usable band (P11)
        g.rect = new DOMRect(g.rect.left, top, g.rect.width, bottom - top);
        // One hit surface: keep hitRect in lockstep with the final rect
        // (the clip used to write both; the extension must be part of the
        // hittable box or the handle band still misses).
        g.hitRect = g.rect;
        // Strip/tabs live in the CONTENT box, never the handle band: a
        // scrolled-out strip must not offer tab insertions, and a partly
        // scrolled one only where it paints.
        clipChromeTo(g, contentBox);
      }
      targets.groups.push(g);
    });
    // Docked-hosted areas beat their (docked) hosts but sit below all floats.
    for (const t of areasByHost.get(null) ?? []) targets.groups.push(t);
    // Iterate floating windows in front-order (array order = z), not DOM order
    // (which is stable/by-id), so targets are ordered back-to-front and hitTest
    // can pick the topmost (last) match over overlapping windows.
    layoutRef.current.floating.forEach((win) => {
      if (win.id === draggedWindowId) return;
      const winEl = container.querySelector(
        `[data-floating-window="${win.id}"]`,
      );
      if (winEl === null) return;
      // The window's full paper rect: the owning-window mask in hitTest
      // covers chrome slivers (header, dividers) that no cell rect claims.
      // Clipped to the container -- ownership is by VISIBLE paper (3.5/P1).
      const winRect = clipToContainer(winEl.getBoundingClientRect());
      if (winRect === null) return;
      (targets.windows ??= []).push({
        windowId: win.id,
        rect: winRect,
      });
      winEl.querySelectorAll("[data-dock-group]").forEach((groupEl) => {
        const gid = groupEl.getAttribute("data-dock-group");
        if (gid === null) return;
        // Snap index comes from the model, not DOM enumeration: a nested
        // DockArea inside a panel's body also renders a [data-dock-group],
        // which would shift DOM-order indices past it (snap above/below then
        // lands at the wrong stack position). Groups not in the stack are
        // skipped here -- the area scan below collects them with area context.
        const index = win.stack.indexOf(gid);
        if (index === -1) return;
        // The group element's own rect is the drop rect -- a minimized cell's
        // element is its full-width bar (D17), no wrapper needed.
        const g = readGroup(groupEl, {
          kind: "floating",
          windowId: win.id,
          index,
        });
        if (g !== null) {
          // Clip the cell to the container's visible box (same rule as the
          // window mask above): an auto-height window taller than the
          // container renders its tail past the bottom edge, and an
          // unclipped rect would put the merge/snap zones on CONTENT
          // height instead of visual height -- with the snap-below band
          // and its hint line painted off-screen. A cell whose visible
          // remnant is sub-8px is not a target at all.
          // Clip to the container AND, for a fixed-height window whose stack
          // is too short for its cells, to that stack's scroll viewport: a
          // cell scrolled under the window header renders nothing, so it must
          // not stay a drop target (P1) -- the floating analog of the docked
          // column's scroll clip.
          const stackScrollEl = groupEl.closest("[data-dock-scroll]");
          const cellRect =
            stackScrollEl === null
              ? clipToContainer(g.rect)
              : clipToContainer(g.rect) === null
                ? null
                : clipRect(
                    clipToContainer(g.rect)!,
                    stackScrollEl.getBoundingClientRect(),
                    8,
                  );
          if (cellRect === null) return;
          g.rect = cellRect;
          clipChromeTo(g, cellRect);
          g.winId = win.id;
          targets.groups.push(g);
        }
      });
      // This window's nested areas, right after its cells: the area wins over
      // its host but stays below any window stacked in front.
      for (const t of areasByHost.get(win.id) ?? []) {
        t.winId = win.id;
        targets.groups.push(t);
      }
    });
    return targets;
  };

  // --- Split preview ------------------------------------------------------
  // Top/bottom splits make vertical room by actually shrinking the target
  // leaf's height (its contents just scroll -- no distortion). Column
  // inserts (side intent, D55) don't change widths at all (the region grows
  // on drop and the new panel brings its own width), so no leaf is touched
  // -- only the seam line is shown. Hit-testing uses rects cached at drag
  // start, so the live height change here doesn't move the drop zones.
  const previewLeaf = React.useRef<HTMLElement | null>(null);
  // The wrapper's inline background before the preview tinted it. The wrapper
  // can be a React-managed element with its own inline backgroundColor (when
  // the region is a single leaf, the leaf's parent is the reserved region
  // container) -- clearing to "" on reset would wipe that style, and React's
  // style diff never re-writes an unchanged value, leaving the region
  // permanently transparent. Restore the saved value instead.
  const previewWrapperBg = React.useRef<string>("");
  const resetLeafPreview = () => {
    const el = previewLeaf.current;
    if (el === null) return;
    el.style.height = "";
    el.style.alignSelf = "";
    // Restore the wrapper's pre-tint background (see applyLeafPreview).
    const wrapper = el.parentElement;
    if (wrapper !== null)
      wrapper.style.backgroundColor = previewWrapperBg.current;
    previewLeaf.current = null;
  };
  const applyLeafPreview = (nodeId: NodeId, region: "top" | "bottom") => {
    // (Side intent is a columnInsert, not a split -- it never reaches here;
    // column inserts show only the seam line, no leaf change.)
    // A minimized cell has no content half to vacate: the "shrink to 50% + tint
    // the freed half" preview would just flood the narrow strip (region-tall) in
    // blue. The thin split line already shows where the new cell lands, so skip
    // the leaf preview for a collapsed target. Read collapse from the model (not
    // a DOM marker) -- the layout is the source of truth.
    if (ops.nodeAllMinimized(layoutRef.current, nodeId)) {
      resetLeafPreview();
      return;
    }
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-dock-leaf="${nodeId}"]`,
    );
    if (el == null) {
      resetLeafPreview();
      return;
    }
    if (previewLeaf.current !== null && previewLeaf.current !== el) {
      resetLeafPreview();
    }
    el.style.height = "50%";
    // Keep the leaf in the half the new panel won't take.
    el.style.alignSelf = region === "top" ? "flex-end" : "flex-start";
    // Tint the vacated half so the gap reads as a drop hint (the opaque leaf
    // Paper covers its own half; the wrapper's tint shows through the other).
    const wrapper = el.parentElement;
    if (wrapper !== null) {
      if (previewLeaf.current !== el) {
        // First application to this leaf: remember the wrapper's own value.
        previewWrapperBg.current = wrapper.style.backgroundColor;
      }
      wrapper.style.backgroundColor = "var(--mantine-primary-color-light)";
    }
    previewLeaf.current = el;
  };

  // --- Window drag (shared by every drag path) ----------------------------

  const beginWindowDrag = (
    windowId: WindowId,
    groupIdForDim: GroupId | null,
    pointerId: number,
    grabX: number,
    grabY: number,
    /** Pre-drag layout for drags that commit an op up front (float a group/
     * column, tear out a tab): a cancel (Escape) restores it, so the panel
     * docks back where it came from instead of stranding as a floater.
     * Deliberately a whole-layout snapshot, not an inverse op: cancelling
     * also discards any external layout changes that landed mid-drag, which
     * is acceptable for a sub-second gesture and far simpler than rebasing. */
    restoreOnCancel?: DockLayout,
  ) => {
    const container = containerRef.current;
    const el0 = container?.querySelector<HTMLElement>(
      `[data-floating-window="${windowId}"]`,
    );
    if (container == null || el0 == null) return;
    let el: HTMLElement = el0;

    setDraggingGroupId(groupIdForDim);
    draggingWindowIdRef.current = windowId;
    const restoreCursor = grabbingCursor();
    let crect = container.getBoundingClientRect();
    let targets = collectTargets(windowId);
    // The layout the targets were collected against. A mid-drag layout change
    // (e.g. a server update adding/removing panes) invalidates the cached
    // rects and may recreate the dragged window's DOM node; both are
    // re-resolved lazily in apply() so drops land on what's actually on screen.
    let targetsLayout = layoutRef.current;
    // Rects can also move without a layout change: a scroll inside the
    // container (a tall minimized rail wheel-scrolled mid-drag) or a viewport
    // resize shifts targets while the model is untouched. Mark the cache
    // stale and re-read live geometry on the next frame. Capture phase:
    // scroll events don't bubble.
    let targetsStale = false;
    const markTargetsStale = () => {
      targetsStale = true;
    };
    container.addEventListener("scroll", markTargetsStale, true);
    window.addEventListener("resize", markTargetsStale);
    // Minimize/expand transitions (collapseAnim) ease cell geometry for
    // ~160ms after a commit; cached rects read mid-ease go stale when the
    // transition settles. Capture phase: fires for every descendant -- so
    // gate on the geometry properties collapseAnim eases: HandleIconButton's
    // color/background transitions end on every hover and would otherwise
    // spuriously invalidate the cache.
    const onTransitionEnd = (e: TransitionEvent) => {
      // The D34 transitions' eased properties: cell flex (collapseAnim),
      // the region container's width (regionWidthAnim), a floating
      // window's collapse height (windowCollapseAnim), and the column
      // FLIP glide (transform).
      if (
        e.propertyName === "flex-grow" ||
        e.propertyName === "flex-basis" ||
        e.propertyName === "min-height" ||
        e.propertyName === "width" ||
        e.propertyName === "height" ||
        e.propertyName === "transform"
      )
        markTargetsStale();
    };
    container.addEventListener("transitionend", onTransitionEnd, true);
    // A floating window can also resize mid-drag with no layout change (an
    // auto-height window whose content grows from a server update). The
    // per-window ResizeObserver reports through this ref.
    markDragTargetsStaleRef.current = markTargetsStale;
    // The dragged stack is fixed for the whole drag; if it holds an unmergeable
    // panel, hitTest suppresses merge/insertTab results (and their hints).
    const draggingUnmergeable = (
      layoutRef.current.floating.find((w) => w.id === windowId)?.stack ?? []
    ).some((gid) => ops.isGroupUnmergeable(layoutRef.current, panes, gid));
    let restingLeft = el.offsetLeft;
    let restingTop = el.offsetTop;

    let latest: PointerEvent | null = null;
    let raf: number | null = null;
    let lastResult: DropResult | null = null;
    let finalX = restingLeft;
    let finalY = restingTop;
    // Set by teardown. A queued rAF callback can outlive the gesture (the
    // browser already scheduled it), and a post-teardown apply() would
    // repaint the hint / leaf preview / transform against the post-drop
    // layout with every listener detached -- nothing left to ever hide them
    // (the user-visible stuck blue hint bar). The end handler cancels the
    // pending frame explicitly too; this flag is the structural backstop
    // that makes the whole stray-frame class inert regardless of path.
    let ended = false;

    const apply = () => {
      raf = null;
      if (ended) return;
      const e = latest;
      if (e === null) return;
      if (layoutRef.current !== targetsLayout || targetsStale) {
        targetsStale = false;
        targetsLayout = layoutRef.current;
        targets = collectTargets(windowId);
        crect = container.getBoundingClientRect();
        if (!el.isConnected) {
          // Reconciliation recreated the window's DOM node mid-drag; without
          // re-resolving, the per-frame transform would land on the detached
          // node and the window would snap back to rest until release.
          el =
            container.querySelector<HTMLElement>(
              `[data-floating-window="${windowId}"]`,
            ) ?? el;
          // Re-apply the drag styling the original node got at drag start
          // (teardown resets these on whatever `el` points at then): without
          // this the recreated window rides undimmed for the rest of the
          // drag, occluding the drop target beneath it.
          el.style.willChange = "transform";
          el.style.opacity = "0.6";
        }
        // A mid-drag layout change may have moved the dragged window's
        // resting position (e.g. a server update). The transform is relative
        // to rest, so re-baseline against the freshly rendered offsets --
        // otherwise the window rides at a stale offset from the cursor for
        // the remainder of the drag. (offsetLeft/Top ignore the transform.)
        restingLeft = el.offsetLeft;
        restingTop = el.offsetTop;
      }
      // Off-screen panes are allowed (the body may overflow the right/bottom),
      // but we keep the top-left corner within the container so the handle is
      // always reachable.
      const desiredLeft = e.clientX - crect.left - grabX;
      const desiredTop = e.clientY - crect.top - grabY;
      [finalX, finalY] = clampCorner(
        desiredLeft,
        desiredTop,
        crect.width,
        crect.height,
      );
      el.style.transform = `translate(${finalX - restingLeft}px, ${finalY - restingTop}px)`;
      const hit = hitTest(
        layoutRef.current,
        // Rendered reserved widths (not the model regionWidth): drop zones
        // must align to what's on screen when columns are overlaid as a rail.
        reservedWidthRef.current,
        crect,
        targets,
        e.clientX,
        e.clientY,
        { draggingUnmergeable },
      );
      lastResult = hit?.result ?? null;
      showHint(hit?.hint ?? null);
      // Preview a split by shrinking the target leaf (top/bottom only); clear
      // otherwise.
      if (hit?.result.kind === "split") {
        applyLeafPreview(hit.result.nodeId, hit.result.region);
      } else {
        resetLeafPreview();
      }
    };

    const detach = bindPointerGesture(
      (e) => {
        latest = e;
        if (raf === null) raf = requestAnimationFrame(apply);
      },
      (_endEvent, cancelled) => {
        // A cancelled pointer (Escape, browser-stolen touch) aborts: no dock,
        // no move -- clearing the transform snaps the window back to where the
        // drag started. Only a real pointerup commits. Flush the pending
        // frame first (the drop must use the final pointer position) --
        // CANCELLING the queued rAF before the manual apply(): apply() nulls
        // the local handle, so cancelling after would be a no-op and the
        // browser-scheduled callback would fire once more AFTER teardown,
        // repainting the hint with nobody left to hide it (the stuck-hint
        // regression this ordering fixes).
        if (raf !== null) {
          cancelAnimationFrame(raf);
          raf = null;
          if (!cancelled) apply();
        }
        teardown();
        if (cancelled) {
          // A deferred-float drag already committed its float op; put the
          // pre-drag layout back so Escape really means "never mind" --
          // including region widths, which the snapshot carries. Restore via
          // commit (not applyOp): the snapshot already carries valid widths, so
          // "put the pre-drag layout back" restores geometry by construction --
          // the reconciler's content-matching would treat restored columns as
          // new and reset them to defaults.
          if (restoreOnCancel !== undefined) {
            commit(restoreOnCancel);
          }
          return;
        }

        const result = lastResult;
        const base = layoutRef.current;
        // The whole dragged stack docks together (a snapped multi-group window
        // keeps all its panes, not just the top one). Unmergeable policy is
        // hitTest's: it never returns merge/insertTab for an unmergeable drag.
        const stack = base.floating.find((w) => w.id === windowId)?.stack ?? [];
        if (result === null || stack.length === 0) {
          applyOp(ops.moveWindow(base, windowId, finalX, finalY));
          return;
        }
        // Widths are reconciled centrally in applyOp, so these just apply the
        // structural op (no per-path region-width juggling). Collapse states
        // travel as-is (D16): dropping an expanded stack beside minimized
        // neighbors never infects it -- collapse changes only by user gesture
        // or server command.
        if (result.kind === "edge") {
          applyOp(ops.dockToEdge(base, stack, result.edge));
        } else if (result.kind === "columnInsert") {
          // The canonical full-height column insert (D55): region-edge
          // bands, panel/rail side bands, and divider gaps all arrive here
          // with one seam index.
          applyOp(ops.insertColumnAt(base, stack, result.edge, result.index));
        } else if (result.kind === "split") {
          applyOp(
            ops.dropOnDockedLeaf(
              base,
              stack,
              result.edge,
              result.nodeId,
              result.region,
            ),
          );
        } else if (result.kind === "merge") {
          // Merge into the target as-is: a minimized target stays minimized
          // (the dropped panel becomes another tab in the collapsed group),
          // matching the user's mental model that organizing minimized panels
          // never expands them. The new tab is reachable via the strip's tabs.
          applyOp(ops.mergeGroupsInto(base, result.targetGroupId, stack));
        } else if (result.kind === "insertTab") {
          applyOp(
            ops.insertTabsInto(base, result.targetGroupId, stack, result.index),
          );
        } else if (result.kind === "snap") {
          applyOp(
            ops.snapToWindowStack(base, stack, result.windowId, result.index),
          );
        } else {
          // Exhaustive: adding a DropResult kind is a compile error here (at
          // the dispatch), not a runtime mis-route into the last branch.
          assertNever(result);
        }
      },
      // Ignore other pointers so a second finger can't drive/commit this drag.
      pointerId,
    );
    el.style.willChange = "transform";
    // Dim the dragged window so the drop target underneath stays visible.
    el.style.opacity = "0.6";
    // Suppress text selection anywhere while dragging over content.
    const restoreSelect = suppressTextSelection();
    tryCapture(el, pointerId);
    // ONE teardown for both exit paths -- the end handler above and an
    // unmount mid-drag (activeCleanup). The paths previously diverged and the
    // unmount path leaked the window `resize` listener (a window-lifetime
    // listener retaining the whole drag closure: targets, container, layout)
    // plus the container capture listeners, the stale-marking ref, and the
    // dragged element's transform.
    const teardown = () => {
      ended = true; // make any browser-scheduled stray apply() inert
      detach();
      container.removeEventListener("scroll", markTargetsStale, true);
      window.removeEventListener("resize", markTargetsStale);
      container.removeEventListener("transitionend", onTransitionEnd, true);
      markDragTargetsStaleRef.current = null;
      activeCleanup.current = null;
      if (raf !== null) cancelAnimationFrame(raf);
      tryRelease(el, pointerId);
      el.style.transform = "";
      el.style.willChange = "";
      el.style.opacity = "";
      restoreSelect();
      restoreCursor();
      showHint(null);
      setDraggingGroupId(null);
      draggingWindowIdRef.current = null;
      resetLeafPreview();
    };
    activeCleanup.current = teardown;
  };

  /** Run a drag whose gesture commits layout ops up front (float a group or
   * column, tear out a tab, expand-then-drag). Pairs the commit with its
   * Escape-restore snapshot by construction: the snapshot is taken here,
   * before `commit` runs, so no call site can commit without one. `commit`
   * applies its ops (flushed where the new window's DOM must exist) and
   * returns the drag parameters, or null to abort (nothing committed). */
  const dragAfterCommit = (
    e: PointerEvent,
    commit: () => {
      windowId: WindowId;
      groupIdForDim: GroupId | null;
      grabX: number;
      grabY: number;
    } | null,
  ) => {
    const before = layoutRef.current;
    const params = commit();
    if (params === null) return;
    beginWindowDrag(
      params.windowId,
      params.groupIdForDim,
      e.pointerId,
      params.grabX,
      params.grabY,
      before,
    );
  };

  // --- Deferred drags (float/tear, then drag the new window) --------------

  /** Arm a press: wait for motion past threshold (-> onDrag) or a release with
   * no motion (-> onClick). */
  const armPress = (
    event: React.PointerEvent<HTMLElement>,
    onDrag: (e: PointerEvent) => void,
    onClick?: () => void,
  ) => {
    // Only the primary button starts a gesture. A right/middle press would
    // otherwise arm a drag whose pointerup is swallowed by the context menu,
    // leaving the panel stuck "dragging" until the next move.
    if (event.button !== 0) return;
    // One gesture at a time (same guard as RegionResizer): a second touch
    // point arming a press while a drag is in flight would clobber the shared
    // singletons (activeCleanup, draggingWindowIdRef, the hint element, the
    // saved body cursor -- ending A then B left the cursor stuck "grabbing").
    if (activeCleanup.current !== null) return;
    // Ignore presses that bubble in from portaled children (a share modal's
    // overlay, a tooltip label): React portals bubble through the React tree,
    // so without this DOM-containment check a click inside an open modal
    // would arm a drag / click-toggle on the handle underneath.
    if (!event.currentTarget.contains(event.target as Node)) return;
    // Suppress text selection from the press, not from the drag threshold: the
    // browser anchors a selection on the initial mousedown, so suppressing only
    // once motion exceeds 3px would still let a drag highlight page text.
    const restoreSelect = suppressTextSelection();
    const startX = event.clientX;
    const startY = event.clientY;
    let triggered = false;
    const detach = bindPointerGesture(
      (e) => {
        if (triggered) return;
        if (!motionExceedsThreshold([startX, startY], [e.clientX, e.clientY]))
          return;
        triggered = true;
        detach();
        activeCleanup.current = null;
        // The drag handler re-suppresses for its own (longer) lifetime.
        restoreSelect();
        onDrag(e);
      },
      (_e, cancelled) => {
        detach();
        activeCleanup.current = null;
        restoreSelect();
        // Only a real release is a click -- a cancelled pointer (touch grabbed
        // by the browser for scrolling, palm rejection, etc.) must not activate.
        if (!triggered && !cancelled) onClick?.();
      },
      // Ignore other pointers so a second finger can't trigger/cancel this press.
      event.pointerId,
    );
    activeCleanup.current = () => {
      detach();
      restoreSelect();
    };
  };

  const floatRectFor = (selector: string) => {
    const container = containerRef.current;
    const el = container?.querySelector<HTMLElement>(selector);
    const crect = containerRect();
    if (el == null) {
      return { x: 40, y: 40, width: DEFAULT_REGION_PX, height: undefined };
    }
    const r = el.getBoundingClientRect();
    return {
      x: r.left - crect.left,
      y: r.top - crect.top,
      width: Math.max(r.width, MIN_REGION_GRAB_PX),
      // Rendered height -- used to give an undocked panel a definite height when
      // it needs one (e.g. a full-bleed nested area, which collapses to 0 in an
      // auto-height window). Clamped so a region-tall panel doesn't float huge.
      height: clamp(r.height, 120, 560),
    };
  };

  // Width to float a docked item at. A minimized docked group/column renders as
  // a ~strip-narrow cell, so its measured rect width is a useless panel width;
  // float at the item's preserved expanded width instead so it isn't
  // strip-narrow after expanding. That preserved width is the column's own
  // weight: weights are always reconciled pixels (lone columns included), and
  // a railed column's weight is its P8 restore width (D40). Expanded items
  // keep their measured width. Shared by startGroupDrag (single tear-out) and
  // startTabTearOut so neither re-introduces the bug. `groupId` locates the
  // item's column.
  const dockedFloatWidth = (
    edge: DockEdge,
    collapsed: boolean,
    measuredWidth: number,
    groupId?: GroupId,
  ): number => {
    if (!collapsed) return measuredWidth;
    const layout = layoutRef.current;
    const rw = regionWidthsOf(layout)[edge];
    const tree = layout.docked[edge];
    if (tree === null || groupId === undefined) return rw;
    const cols = tree.columns;
    const col = cols.find((c) => ops.collectLeafGroups(c).includes(groupId));
    // Weights are always reconciled px (every consumer-visible layout has
    // passed reconcileRegionWidths -- the mount chokepoint reconciles too),
    // so the weight IS the restore width. regionWidth only covers the
    // group-not-found edge; it is NOT a width memory (a packed region
    // reserves just its 36px strips there).
    if (col !== undefined) return col.weight;
    return rw;
  };

  // Float width for tearing `groupId` (or one of its tabs) out of wherever it
  // lives: a docked group that is effectively collapsed (own minimize or the
  // region's explicit D21 collapse -- rail cells measure ~36px either way)
  // floats at its preserved expanded width via dockedFloatWidth; everything
  // else floats at its measured width.
  const dockedFloatWidthForGroup = (
    groupId: GroupId,
    measuredWidth: number,
  ): number => {
    const layout = layoutRef.current;
    const loc = ops.findGroupLocation(layout, groupId);
    return loc?.kind === "docked" &&
      ops.isGroupEffectivelyCollapsed(layout, groupId)
      ? dockedFloatWidth(loc.edge, true, measuredWidth, groupId)
      : measuredWidth;
  };

  // The grab offset = where in the dragged window the cursor pressed (so the
  // window tracks the cursor 1:1). `originX/originY` is the source's top-left in
  // container coords. When `winId` is given, clamp the offset into that floated
  // window's actual rendered box: a tear-out source can be much bigger than the
  // resulting window -- a region-tall minimized strip or docked column floats
  // into a short window, so a press near the source's bottom would otherwise
  // leave a large cursor-to-window gap. A small margin keeps the grab off the
  // very edge. Call without `winId` when the source IS the window (offset from
  // its own model coords needs no clamp).
  const grabOffset = (
    e: { clientX: number; clientY: number },
    originX: number,
    originY: number,
    winId?: WindowId,
  ): { grabX: number; grabY: number } => {
    const crect = containerRect();
    const rawX = e.clientX - crect.left - originX;
    const rawY = e.clientY - crect.top - originY;
    const winRect =
      winId === undefined
        ? undefined
        : containerRef.current
            ?.querySelector<HTMLElement>(`[data-floating-window="${winId}"]`)
            ?.getBoundingClientRect();
    if (winRect === undefined) return { grabX: rawX, grabY: rawY };
    return {
      grabX: clamp(rawX, 0, Math.max(0, winRect.width - 8)),
      grabY: clamp(rawY, 0, Math.max(0, winRect.height - 8)),
    };
  };

  // --- Context callbacks ---------------------------------------------------

  const startWindowDrag: DockContextValue["startWindowDrag"] = (
    event,
    windowId,
    opts,
  ) => {
    if (layoutRef.current.floating.every((w) => w.id !== windowId)) return;
    // Press-time pointer coordinates, but the window's current model position
    // at drag start: the window may move between press and the drag threshold
    // (container-resize anchoring), and offsets frozen against the press-time
    // position would teleport it back on the first drag frame.
    const pressX = event.clientX;
    const pressY = event.clientY;
    armPress(
      event,
      (e) => {
        const win = layoutRef.current.floating.find((w) => w.id === windowId);
        if (win === undefined) return;
        const { grabX, grabY } = grabOffset(
          { clientX: pressX, clientY: pressY },
          win.x,
          win.y,
        );
        beginWindowDrag(windowId, null, e.pointerId, grabX, grabY);
      },
      opts?.onClick,
    );
  };

  const startGroupDrag: DockContextValue["startGroupDrag"] = (
    event,
    groupId,
    opts,
  ) => {
    // A no-motion press drags nothing but fires opts.onClick (the unmergeable
    // header uses this to toggle minimize on click, like the live FloatingPanel).
    const onClick = opts?.onClick;
    const loc = ops.findGroupLocation(layoutRef.current, groupId);
    // A group alone in its floating window just moves that window on drag --
    // the same gesture as dragging the window itself. (Dragging a minimized
    // panel moves it as-is, still minimized; expanding is a click-only
    // gesture, so no expand-on-drag here.)
    if (loc?.kind === "floating") {
      const win0 = layoutRef.current.floating.find(
        (w) => w.id === loc.windowId,
      );
      if (win0 !== undefined && win0.stack.length === 1) {
        startWindowDrag(event, win0.id, opts);
        return;
      }
    }
    armPress(
      event,
      (e) => {
        dragAfterCommit(e, () => {
          const rect = floatRectFor(`[data-dock-group="${groupId}"]`);
          // Effectively-collapsed docked cells float at their preserved
          // expanded width (see dockedFloatWidthForGroup).
          const floatWidth = dockedFloatWidthForGroup(groupId, rect.width);
          // A panel whose body is a full-bleed nested area needs a definite
          // height to fill (it collapses to 0 in an auto-height window). Give
          // the undocked window the panel's current rendered height in that
          // case; ordinary panes keep auto-height (content-sized) as before.
          const needsHeight = (
            layoutRef.current.groups[groupId]?.paneIds ?? []
          ).some((p) => panes[p]?.fullBleed === true);
          const res = ops.floatGroup(
            layoutRef.current,
            groupId,
            rect.x,
            rect.y,
            floatWidth,
            needsHeight ? rect.height : undefined,
          );
          // Null only for an area's backing group, which no UI surface offers a
          // group-drag for; bail rather than drag a window that doesn't exist.
          if (res.windowId === null) return null;
          // A cell dragged out of a railed region floats still minimized:
          // floatGroup inherits the source container's collapse state onto the
          // new window (identity transfer, D38).
          // applyOp reconciles region widths: undocking this column removes it
          // from the region's column set, so siblings keep their widths and the
          // region shrinks by the removed column's width. A minimized panel
          // floats out still minimized (it renders as a one-cell strip window) --
          // expanding is click-only, never a side effect of dragging.
          flushSync(() => applyOp(res.layout));
          // Clamp the grab into the floated window: the source (a region-tall
          // minimized strip / docked column) can be far bigger than the result.
          return {
            windowId: res.windowId,
            groupIdForDim: groupId,
            ...grabOffset(e, rect.x, rect.y, res.windowId),
          };
        });
      },
      onClick,
    );
  };

  const startColumnDrag: DockContextValue["startColumnDrag"] = (
    event,
    edge,
    columnId,
    opts,
  ) => {
    armPress(
      event,
      (e) => {
        dragAfterCommit(e, () => {
          const rect = floatRectFor(`[data-dock-column="${columnId}"]`);
          const column = ops.findColumnById(
            layoutRef.current.docked[edge],
            columnId,
          );
          const wasRailed = column?.railed === true;
          // A railed column measures strip-narrow; float it at its preserved
          // expanded width instead -- dockedFloatWidth's policy exactly: the
          // column weight (always reconciled px, its P8 restore width when
          // railed -- lone columns included).
          const floatWidth = dockedFloatWidth(
            edge,
            wasRailed,
            rect.width,
            column?.leaves[0]?.group,
          );
          const res = ops.floatColumn(
            layoutRef.current,
            edge,
            columnId,
            rect.x,
            rect.y,
            floatWidth,
          );
          if (res.windowId === null) return null;
          // Dragging a railed column out keeps its minimized look: floatColumn
          // inherits the rail state onto the new window's own flag (identity
          // transfer, D38), so its cells render as bars.
          flushSync(() => applyOp(res.layout));
          return {
            windowId: res.windowId,
            groupIdForDim: null,
            ...grabOffset(e, rect.x, rect.y, res.windowId),
          };
        });
      },
      opts?.onClick,
    );
  };

  const startRegionDrag: DockContextValue["startRegionDrag"] = (
    event,
    edge,
    opts,
  ) => {
    armPress(
      event,
      (e) => {
        dragAfterCommit(e, () => {
          const rect = floatRectFor(`[data-dock-region="${edge}"]`);
          const res = ops.floatRegion(
            layoutRef.current,
            edge,
            rect.x,
            rect.y,
            regionWidthsOf(layoutRef.current)[edge],
          );
          if (res.windowId === null) return null;
          // Dragging the rail out keeps its minimized look: floatRegion
          // inherits the region-rail state onto the new window's own flag
          // (identity transfer, D38), so its cells render as bars with the
          // header's expand one click away.
          flushSync(() => applyOp(res.layout));
          return {
            windowId: res.windowId,
            groupIdForDim: null,
            ...grabOffset(e, rect.x, rect.y, res.windowId),
          };
        });
      },
      opts?.onClick,
    );
  };

  const startTabDrag: DockContextValue["startTabDrag"] = (
    event,
    groupId,
    paneId,
  ) => {
    const stripEl = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-dock-strip]",
    );

    let raf: number | null = null;
    let latest: PointerEvent | null = null;
    let detach: (() => void) | null = null;
    let reordering = false;
    // Insertion index shown by the line and committed on drop.
    let lastInsert: number | null = null;
    // Accumulated translateX on the dragged tab (so it follows the cursor).
    let tabTx = 0;
    const draggedTabEl = () =>
      stripEl?.querySelector<HTMLElement>(`[data-dock-tab="${paneId}"]`) ??
      null;

    // Set when the reorder phase arms; restores page-wide text selection and
    // the grabbing cursor.
    let restoreSelect: (() => void) | null = null;
    let restoreCursor: (() => void) | null = null;
    const teardown = () => {
      detach?.();
      detach = null;
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      activeCleanup.current = null;
      restoreSelect?.();
      restoreSelect = null;
      restoreCursor?.();
      restoreCursor = null;
      showHint(null);
    };
    // Used when the gesture is abandoned without committing (tear-out, unmount):
    // snap the dragged tab back and clear drag state immediately.
    const cleanup = () => {
      teardown();
      const tabEl = draggedTabEl();
      if (tabEl !== null) {
        tabEl.style.transform = "";
      }
      if (reordering) setDraggingTabId(null);
    };
    // Pointer-up while reordering: commit the reorder to the line's index, then
    // glide the dragged tab from the cursor into its new slot. With no resolved
    // insertion (hint hidden) the release is a no-op: the tab just snaps back.
    const commitReorder = () => {
      teardown();
      if (!reordering) return;
      if (lastInsert !== null) {
        const index = lastInsert;
        flushSync(() =>
          applyOp(ops.reorderTab(layoutRef.current, groupId, paneId, index)),
        );
      }
      const tabEl = draggedTabEl();
      if (tabEl !== null) {
        tabEl.style.transform = "";
      }
      setDraggingTabId(null);
    };

    const tearOut = (e: PointerEvent) => {
      cleanup();
      dragAfterCommit(e, () => {
        const src = floatRectFor(`[data-dock-group="${groupId}"]`);
        const res = ops.tearOutPane(
          layoutRef.current,
          groupId,
          paneId,
          src.x,
          src.y,
          src.width,
        );
        // No-op tear-out (pane not in the group): nothing floated, nothing to
        // reposition.
        if (res.windowId === null) return null;
        // A tab torn out of a collapsed container floats still minimized:
        // tearOutPane births the window collapsed (identity transfer, D38).
        const newWindowId = res.windowId;
        flushSync(() => applyOp(res.layout));

        // Anchor the new window so the cursor lands on its tab strip. Unlike
        // a group drag (which floats on the first 3px of motion), a tear-out
        // only triggers after the pointer has left the strip, so we can't
        // reuse the accumulated offset -- re-measure the new window's strip
        // and reposition.
        const crect = containerRect();
        const winEl = containerRef.current?.querySelector<HTMLElement>(
          `[data-floating-window="${newWindowId}"]`,
        );
        let grabX = 40;
        let grabY = 18;
        if (winEl != null) {
          const winRect = winEl.getBoundingClientRect();
          grabX = Math.min(40, winRect.width / 2);
          const stripEl2 =
            winEl.querySelector<HTMLElement>("[data-dock-strip]");
          if (stripEl2 != null) {
            const sRect = stripEl2.getBoundingClientRect();
            grabY = sRect.top - winRect.top + sRect.height / 2;
          } else {
            // Strip not found (defensive): anchor within the window's actual
            // height rather than a fixed 18px that may overshoot a short
            // window.
            grabY = Math.min(18, winRect.height / 2);
          }
        }
        const newX = e.clientX - crect.left - grabX;
        const newY = e.clientY - crect.top - grabY;
        flushSync(() =>
          applyOp(ops.moveWindow(layoutRef.current, newWindowId, newX, newY)),
        );
        return {
          windowId: newWindowId,
          groupIdForDim: res.floatingGroupId,
          grabX,
          grabY,
        };
      });
    };

    const apply = () => {
      raf = null;
      const e = latest;
      if (e === null) return;
      // Leaving the strip vertically tears the tab out into a floating window.
      // The strip's rect is measured LIVE each frame (like the tab rects
      // below): a mid-drag layout commit or scroll can shift the strip, and a
      // pointerdown-time snapshot would tear out with the pointer visually
      // still on the strip (or keep reordering after it left). A detached
      // strip reads all-zeros and falls into tear-out -- the sane response to
      // the group vanishing under the drag.
      const stripRect = stripEl?.getBoundingClientRect() ?? null;
      if (
        stripEl === null ||
        stripRect === null ||
        e.clientY > stripRect.bottom + TAB_TEAR_PX ||
        e.clientY < stripRect.top - TAB_TEAR_PX
      ) {
        tearOut(e);
        return;
      }
      // Reorder within the strip. The dragged tab follows the cursor
      // immediately (imperative transform); the other tabs stay put and an
      // insertion line shows where it will land (same affordance as a tab
      // merge). The reorder is committed on drop.
      if (!reordering) {
        reordering = true;
        setDraggingTabId(paneId);
      }
      // Nearest-tab insertion among the other tabs (2D, so it's correct when
      // the strip wraps onto multiple rows). The line is anchored to the matched
      // tab's own row.
      const others: { rect: DOMRect }[] = [];
      stripEl.querySelectorAll<HTMLElement>("[data-dock-tab]").forEach((t) => {
        if (t.getAttribute("data-dock-tab") !== paneId)
          others.push({ rect: t.getBoundingClientRect() });
      });
      const ins = tabInsertion(others, e.clientX, e.clientY);
      const crect = containerRect();
      if (ins !== null) {
        lastInsert = ins.index;
        showHint({
          left: ins.lineLeft - crect.left - 1,
          top: ins.lineTop - crect.top,
          width: 2,
          height: ins.lineHeight,
          variant: "line",
        });
      } else {
        // No insertion resolved (no other tabs to measure -- e.g. a mid-drag
        // layout change removed them). The hint is hidden, so a release must
        // be a no-op (P1: a hidden hint means no drop), not a silent reorder
        // to index 0.
        lastInsert = null;
        showHint(null);
      }

      // Glue the dragged tab to the cursor. Self-correcting: strip the current
      // transform from the measured center to recover the resting center, then
      // re-solve for the translate that centers it on the pointer.
      const tabEl = draggedTabEl();
      if (tabEl !== null) {
        const r = tabEl.getBoundingClientRect();
        const restCenter = r.left + r.width / 2 - tabTx;
        tabTx = e.clientX - restCenter;
        tabEl.style.transform = `translateX(${tabTx}px)`;
      }
    };

    armPress(
      event,
      (e0) => {
        // A single-tab strip has nothing to reorder: grabbing the tab should
        // immediately move the panel itself. A group alone in its floating
        // window just drags that window (like its grip would); anything else
        // tears out right away instead of arming the reorder state machine.
        const group = layoutRef.current.groups[groupId];
        if ((group?.paneIds.length ?? 0) <= 1) {
          const loc = ops.findGroupLocation(layoutRef.current, groupId);
          if (loc?.kind === "floating") {
            const win = layoutRef.current.floating.find(
              (w) => w.id === loc.windowId,
            );
            if (win !== undefined && win.stack.length === 1) {
              const crect = containerRect();
              beginWindowDrag(
                win.id,
                groupId,
                e0.pointerId,
                e0.clientX - crect.left - win.x,
                e0.clientY - crect.top - win.y,
              );
              return;
            }
          }
          tearOut(e0);
          return;
        }
        // Keep selection suppressed through the reorder phase (armPress's
        // suppression ends when it hands off to this drag handler).
        restoreSelect = suppressTextSelection();
        restoreCursor = grabbingCursor();
        latest = e0;
        detach = bindPointerGesture(
          (e) => {
            latest = e;
            if (raf === null) raf = requestAnimationFrame(apply);
          },
          // Pointer-up commits the reorder to the line's index; a cancelled
          // pointer (Escape, browser-stolen touch) abandons it and snaps the
          // dragged tab back to its original slot.
          (_endEvent, cancelled) => (cancelled ? cleanup() : commitReorder()),
          e0.pointerId, // ignore other fingers during the reorder/tear.
        );
        activeCleanup.current = cleanup;
        raf = requestAnimationFrame(apply);
      },
      // No-motion click: select the tab AND expand the group if it's minimized
      // (clicking a tab to read it should reveal its content).
      () => expandToTab(groupId, paneId),
    );
  };

  // Tear one pane out of a minimized docked stack. The minimized strip shows
  // each tab as a row; dragging a row should float just that pane (leaving the
  // rest of the stack docked), while a motionless click expands the group to
  // that tab. Mirrors the docked tear path of startGroupDrag (armPress ->
  // dragAfterCommit, with the new window floated at the region's preserved
  // expanded width so the result isn't a strip-narrow stub), but tears a single
  // pane via tearOutPane instead of floating the whole group. No reorder phase:
  // a vertical strip's rows aren't a horizontal reorder surface.
  const startTabTearOut: DockContextValue["startTabTearOut"] = (
    event,
    groupId,
    paneId,
    opts,
  ) => {
    armPress(
      event,
      (e) => {
        dragAfterCommit(e, () => {
          const rect = floatRectFor(`[data-dock-group="${groupId}"]`);
          // Effectively-collapsed docked cells float at their preserved
          // expanded width (see dockedFloatWidthForGroup).
          const floatWidth = dockedFloatWidthForGroup(groupId, rect.width);
          const res = ops.tearOutPane(
            layoutRef.current,
            groupId,
            paneId,
            rect.x,
            rect.y,
            floatWidth,
          );
          // No-op (pane not in the group / area group): nothing floated.
          if (res.windowId === null) return null;
          const newWindowId = res.windowId;
          // The torn pane floats as-is: a spine row torn out of the rail
          // stays minimized -- tearOutPane births the window collapsed
          // (identity transfer, D38). Dragging never expands -- only the
          // no-motion click below (expandToTab) does.
          flushSync(() => applyOp(res.layout));
          // Clamp the grab into the freshly-floated window (the source strip is
          // region-tall; the result is a short window).
          return {
            windowId: newWindowId,
            groupIdForDim: res.floatingGroupId,
            ...grabOffset(e, rect.x, rect.y, newWindowId),
          };
        });
      },
      // No-motion click: expand the group to this tab (reveal its content).
      // A caller override (a stacked bar's title, which expands the whole
      // stack, D31) replaces the default.
      opts?.onClick ?? (() => expandToTab(groupId, paneId)),
    );
  };

  // The gesture starters above are recreated each render (they close over
  // fresh props); expose stable wrappers so the memoized context value in
  // DockManager doesn't churn identity on every render.
  const gestureImpls = {
    startGroupDrag,
    startTabDrag,
    startTabTearOut,
    startWindowDrag,
    startRegionDrag,
    startColumnDrag,
  };
  const gestureRef = React.useRef(gestureImpls);
  gestureRef.current = gestureImpls;
  const stableGestures = React.useMemo(
    () =>
      ({
        startGroupDrag: (...args) => gestureRef.current.startGroupDrag(...args),
        startTabDrag: (...args) => gestureRef.current.startTabDrag(...args),
        startTabTearOut: (...args) =>
          gestureRef.current.startTabTearOut(...args),
        startWindowDrag: (...args) =>
          gestureRef.current.startWindowDrag(...args),
        startRegionDrag: (...args) =>
          gestureRef.current.startRegionDrag(...args),
        startColumnDrag: (...args) =>
          gestureRef.current.startColumnDrag(...args),
      }) satisfies Pick<
        DockContextValue,
        | "startGroupDrag"
        | "startTabDrag"
        | "startTabTearOut"
        | "startWindowDrag"
        | "startRegionDrag"
        | "startColumnDrag"
      >,
    [],
  );

  return {
    /** Stable ref-dispatch wrappers (identity never changes): the context
     * value spreads these, and DockManager's own region handle bar calls
     * through them too -- per-render identities in the context deps voided
     * the memo (every render re-rendered every consumer). */
    stableGestures,
  };
}
