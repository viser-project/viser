// Top-level docking surface. Owns the layout, renders the left/right docked
// regions and floating windows over a center area, and runs the drag-and-drop
// controller that powers moving, docking, tab tear-out, merging, and snapping.
//
// Drag model: every drag is normalized to "dragging a floating window". A drag
// that starts on a docked group or a tab first floats/tears that group into a
// new window (via flushSync, so the window DOM exists immediately), then drags
// it. Movement is applied as a CSS transform on the window element so the
// per-move setState (for the drop hint) doesn't clobber it. On release we
// either apply a docking op for the hovered drop target, or commit the final
// floating position.

import { Box } from "@mantine/core";
import React from "react";
import { flushSync } from "react-dom";
import {
  DockContext,
  DockContextValue,
  DockMetrics,
  DockMetricsContext,
} from "./DockContext";
import { FloatingWindowView } from "./FloatingWindowView";
import { SplitView } from "./SplitView";
import {
  bindPointerGesture,
  grabbingCursor,
  motionExceedsThreshold,
  prefersReducedMotion,
  suppressTextSelection,
  tryCapture,
  tryRelease,
} from "./gestures";
import * as ops from "./layoutOps";
import { RegionResizer } from "./RegionResizer";
import {
  canvasFacingStripOffsetPx,
  plannedReservedWidth,
  planRegion,
} from "./regionPlan";
import { reconcileRegionWidths } from "./widthReconciliation";
import { invariantViolations } from "./layoutInvariants";
import {
  DEFAULT_REGION_PX,
  DropHint,
  DropResult,
  DropTargets,
  GroupContext,
  GroupTarget,
  hitTest,
  tabInsertion,
} from "./hitTest";
import {
  clamp,
  DockEdge,
  DockLayout,
  GroupId,
  MIN_CANVAS_PX,
  MIN_REGION_GRAB_PX,
  NodeId,
  PaneId,
  PaneRegistry,
  pinnedPxOf,
  regionWidthsOf,
  WindowId,
} from "./types";

// Keep at least this much of a floating window's top-left corner on-screen so
// its handle stays reachable (panes may otherwise overflow off-screen).
const KEEP_VISIBLE_PX = 40;

/** Clamp a floating window's top-left corner so the handle stays reachable. The
 * corner stays within the container (no off-top/left), but the window body may
 * extend past the right/bottom edges. */
function clampCorner(
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
// A nested area's HIT rect is inset by up to this much on its left/right/bottom
// so a frame around a full-bleed area falls through to the HOST panel's zones.
const AREA_HIT_INSET_PX = 40;
// Areas with a smaller rendered rect than this are skipped as drop targets:
// a MINIMIZED host collapses its area to ~0px, and offering that would put a
// phantom target over the host's own handle. Kept well below the smallest
// legitimate area (an empty "drop a panel here" placeholder is ~40px tall --
// it must stay droppable), and well above the collapsed case (~0px).
const AREA_MIN_TARGET_PX = 24;

export function DockManager({
  initialLayout,
  panes,
  children,
  onLayoutChange,
  onRegionResizeFrame,
}: {
  initialLayout: DockLayout;
  panes: PaneRegistry;
  /** Center content (e.g. the 3D canvas), inset by the docked regions. */
  children?: React.ReactNode;
  /** Observe every committed layout (e.g. for persistence or test probes). */
  onLayoutChange?: (layout: DockLayout) => void;
  /** Called after each per-frame region-width resize is committed AND its new
   * inset has been flushed to the DOM. Lets the host (e.g. the 3D canvas)
   * synchronously react to the canvas's new size on the SAME tick instead of
   * waiting for a ResizeObserver -- see ControlPanelDock / syncCanvasSize. */
  onRegionResizeFrame?: () => void;
}) {
  const onRegionResizeFrameRef = React.useRef(onRegionResizeFrame);
  onRegionResizeFrameRef.current = onRegionResizeFrame;
  const [layout, setLayout] = React.useState(initialLayout);
  const layoutRef = React.useRef(layout);
  layoutRef.current = layout;
  const onLayoutChangeRef = React.useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;
  React.useEffect(() => {
    onLayoutChangeRef.current?.(layout);
  }, [layout]);

  // Region widths are part of the layout MODEL (DockLayout.regionWidth, the
  // single source of truth -- see widthReconciliation.ts); this is just the
  // defaults-filled view of it. Gesture closures read the synchronous truth
  // via regionWidthsOf(layoutRef.current).
  const regionWidth = React.useMemo(() => regionWidthsOf(layout), [layout]);
  // Rendered region widths per edge (assigned after the region plans below).
  const reservedWidthRef = React.useRef({ left: 0, right: 0 });
  const [draggingGroupId, setDraggingGroupId] = React.useState<GroupId | null>(
    null,
  );
  const [draggingTabId, setDraggingTabId] = React.useState<PaneId | null>(null);
  const [resizing, setResizing] = React.useState(false);

  // Drop hint, driven IMPERATIVELY (style mutations on a persistent element)
  // rather than via state: the hint updates on every pointer move during a
  // drag, and routing that through setState would re-render the entire dock
  // subtree -- all panes and their contents -- once per frame. With the hint
  // (and the window transform, tab glue, and leaf preview, which were already
  // imperative) off the React path, a drag does no React work per move at all.
  const hintRef = React.useRef<HTMLDivElement>(null);
  const showHint = (hint: DropHint | null) => {
    const el = hintRef.current;
    if (el === null) return;
    if (hint === null) {
      el.style.display = "none";
      el.removeAttribute("data-dock-hint");
      return;
    }
    const variant = HINT_VARIANT_STYLES[hint.variant];
    el.style.display = "block";
    el.style.left = `${hint.left}px`;
    el.style.top = `${hint.top}px`;
    el.style.width = `${hint.width}px`;
    el.style.height = `${hint.height}px`;
    el.style.backgroundColor = variant.backgroundColor;
    el.style.borderRadius = variant.borderRadius;
    el.style.opacity = variant.opacity;
    el.setAttribute("data-dock-hint", hint.variant);
  };

  const containerRef = React.useRef<HTMLDivElement>(null);
  // The window currently being dragged, if any. The container ResizeObserver
  // skips it: during a drag the CURSOR is the source of truth for that
  // window's position, and an anchor/pull write mid-drag would detach the
  // window from the cursor (the drop commits the final position anyway).
  const draggingWindowIdRef = React.useRef<WindowId | null>(null);
  // Cleanup for an in-flight gesture, run if the manager unmounts mid-drag.
  const activeCleanup = React.useRef<(() => void) | null>(null);
  // Pending tab-reorder "settle" timer, so it can be cancelled on unmount.
  const settleTimer = React.useRef<number | undefined>(undefined);
  React.useEffect(
    () => () => {
      activeCleanup.current?.();
      if (settleTimer.current !== undefined) clearTimeout(settleTimer.current);
    },
    [],
  );

  // ONE region plan per edge per layout (fix: previously re-planned in the
  // render body AND the auto-grow effect AND metrics, several walks per frame
  // during a region resize). Shared by all three consumers below.
  const plans = React.useMemo(
    () => ({
      left:
        layout.docked.left !== null
          ? planRegion(layout.docked.left, layout.groups)
          : null,
      right:
        layout.docked.right !== null
          ? planRegion(layout.docked.right, layout.groups)
          : null,
    }),
    [layout],
  );

  // Apply a layout op, reconciling docked region widths (written into
  // next.regionWidth) so panes keep their pixel widths across structural
  // changes (see widthReconciliation.ts). The old auto-grow effect is gone:
  // the reconciler enforces the min-width floor on every commit, so a
  // too-narrow region is unrepresentable in committed state.
  // Commit a layout: the ONE place layoutRef + React state are updated, so EVERY
  // committed layout is structurally checked in dev. The invariant check (one
  // location per group, one group per pane, ...) is stripped from production
  // builds; the fuzz test asserts the same function over random op sequences.
  const commit = React.useCallback((next: DockLayout) => {
    if (import.meta.env.DEV) {
      const violations = invariantViolations(next);
      if (violations.length > 0)
        console.error(
          "[dock] layout invariant violation:\n" + violations.join("\n"),
        );
    }
    layoutRef.current = next;
    setLayout(next);
  }, []);

  const applyOp = React.useCallback(
    (next: DockLayout) => {
      if (next === layoutRef.current) return; // no-op op: nothing to commit.
      reconcileRegionWidths(layoutRef.current, next);
      commit(next);
    },
    [commit],
  );

  // Restore a previously COMMITTED layout exactly (Escape after a drag that
  // committed an op up front). No reconciliation: the snapshot already
  // carries valid widths -- regionWidth lives in the layout, so "put the
  // pre-drag layout back" restores geometry by construction, where the
  // reconciler's content-matching would treat restored columns as new and
  // reset them to defaults.
  const restoreLayout = React.useCallback(
    (snapshot: DockLayout) => commit(snapshot),
    [commit],
  );

  // Imperative panel lifecycle API (exposed via context). Stable identity so
  // sync layers can list it in effect deps without re-running.
  const api = React.useMemo(
    () => ({
      apply: (fn: (l: DockLayout) => DockLayout) =>
        applyOp(fn(layoutRef.current)),
      addPaneToArea: (areaId: string, paneId: PaneId, index?: number) =>
        applyOp(ops.addPaneToArea(layoutRef.current, areaId, paneId, index)),
    }),
    [applyOp],
  );

  // Registry reconciliation: a panel whose spec disappears from `panes` (e.g.
  // removed server-side after the user dragged it out of its area) is removed
  // from wherever it lives in the layout, collapsing emptied windows/cells.
  React.useEffect(() => {
    const current = layoutRef.current;
    let next = current;
    for (const group of Object.values(current.groups)) {
      for (const p of group.paneIds) {
        if (panes[p] === undefined) next = ops.removePane(next, p);
      }
    }
    if (next !== current) applyOp(next);
  }, [panes, layout, applyOp]);

  const containerRect = () =>
    containerRef.current?.getBoundingClientRect() ?? new DOMRect();

  // Container height, for capping floating panes' scrolling bodies (matches
  // the original FloatingPanel, which capped its body to the parent height).
  const [containerHeight, setContainerHeight] = React.useState(0);
  // Container width, exposed via metrics so float coords (incl. negative
  // gap-from-right) can be resolved against the live canvas.
  const [containerWidth, setContainerWidth] = React.useState(0);

  // Keep floating windows sensibly placed when the container resizes. Each
  // axis anchors to the NEARER container edge (matching the original
  // FloatingPanel): a window whose center sits in the right/bottom half keeps
  // its distance to that edge, so e.g. a top-right control panel stays in the
  // top-right corner when the browser window grows. Afterwards the top-left
  // corner is clamped on-screen so the handle stays reachable.
  const prevContainerSize = React.useRef<{ w: number; h: number } | null>(null);
  React.useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setContainerHeight(rect.height);
      setContainerWidth(rect.width);
      const prevSize = prevContainerSize.current;
      prevContainerSize.current = { w: rect.width, h: rect.height };
      const deltaW = prevSize === null ? 0 : rect.width - prevSize.w;
      const deltaH = prevSize === null ? 0 : rect.height - prevSize.h;
      // Rendered heights, for vertical anchoring of auto-height windows.
      const heights = new Map<string, number>();
      el.querySelectorAll<HTMLElement>("[data-floating-window]").forEach(
        (winEl) => {
          const id = winEl.getAttribute("data-floating-window");
          if (id !== null) heights.set(id, winEl.offsetHeight);
        },
      );
      setLayout((prev) => {
        let changed = false;
        const floating = prev.floating.map((w) => {
          if (w.id === draggingWindowIdRef.current) return w;
          // Server-anchored panels are repositioned by the resolve-effect below
          // (keyed on container size); skip them here so the two don't fight.
          if (w.anchor !== undefined) return w;
          let x = w.x;
          let y = w.y;
          // Dragged windows: anchor to the nearer edge (operate on the RENDERED
          // height the map just measured; the model height is only a fallback
          // for a window with no DOM yet).
          const wh = heights.get(w.id) ?? pinnedPxOf(w.height) ?? 0;
          if (prevSize !== null && (deltaW !== 0 || deltaH !== 0)) {
            if (w.x + w.width / 2 > prevSize.w / 2) x += deltaW;
            if (w.y + wh / 2 > prevSize.h / 2) y += deltaH;
            // A container SHRINK pulls windows fully on-screen when they fit
            // (overhang from a drag is the user's choice; losing the far edge
            // -- and its minimize/resize controls -- to a browser resize
            // isn't). A window larger than the container pins to the
            // top/left. Per axis, shrink only: a width-only resize must not
            // yank a bottom-overhanging window upward, and a GROW loses
            // nothing, so it must not cancel deliberate overhang either. NOT
            // applied on the observer's initial fire, which would
            // second-guess deliberate placement.
            if (deltaW < 0) x = Math.min(x, Math.max(0, rect.width - w.width));
            if (deltaH < 0 && wh > 0)
              y = Math.min(y, Math.max(0, rect.height - wh));
          }
          [x, y] = clampCorner(x, y, rect.width, rect.height);
          if (x === w.x && y === w.y) return w;
          changed = true;
          return { ...w, x, y };
        });
        if (!changed) return prev;
        const next = { ...prev, floating };
        layoutRef.current = next;
        return next;
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // --- Drop-target hit testing -------------------------------------------

  const collectTargets = (draggedWindowId: WindowId): DropTargets => {
    const container = containerRef.current;
    const targets: DropTargets = { groups: [] };
    if (container === null) return targets;

    // Tabs animate to new slots with a transient FLIP `transform: translate(...)`
    // (see TabGroupFrame). Collecting targets right after a tear-out's flushSync
    // would otherwise capture those mid-animation positions -- making the strip
    // look like it still has the just-removed tab's geometry. Measure each tab at
    // its RESTING layout box by subtracting its own transform translation.
    const restingRect = (el: Element): DOMRect => {
      const rect = el.getBoundingClientRect();
      const tf = getComputedStyle(el).transform;
      if (tf === "none" || tf === "") return rect;
      // matrix(a,b,c,d,tx,ty) / matrix3d(...) -- the translate is the last two
      // (2D) or 13th/14th (3D) values.
      const nums = tf
        .slice(tf.indexOf("(") + 1, tf.lastIndexOf(")"))
        .split(",")
        .map((n) => parseFloat(n));
      const tx = nums.length === 6 ? nums[4] : nums.length === 16 ? nums[12] : 0;
      const ty = nums.length === 6 ? nums[5] : nums.length === 16 ? nums[13] : 0;
      if (tx === 0 && ty === 0) return rect;
      return new DOMRect(
        rect.left - tx,
        rect.top - ty,
        rect.width,
        rect.height,
      );
    };

    // Collect the strip + tabs that belong to ONE group, scoped so a nested
    // group (e.g. a DockArea inside this panel's body) doesn't leak its strip or
    // tabs into this target. `rectEl` is the element whose box defines the
    // target's hit rect (the group element itself, or an area's wrapper).
    const buildTarget = (
      rectEl: Element,
      scopeEl: Element,
      groupId: GroupId,
      ctx: GroupContext,
    ): GroupTarget => {
      const stripEl = scopeEl.querySelector(`[data-dock-strip="${groupId}"]`);
      const tabs: { paneId: PaneId; rect: DOMRect }[] = [];
      scopeEl.querySelectorAll("[data-dock-tab]").forEach((t) => {
        // Skip tabs that belong to a nested group (their nearest group ancestor
        // isn't ours).
        if (t.closest("[data-dock-group]") !== scopeEl) return;
        const paneId = t.getAttribute("data-dock-tab");
        if (paneId !== null) tabs.push({ paneId, rect: restingRect(t) });
      });
      return {
        groupId,
        rect: rectEl.getBoundingClientRect(),
        stripRect: stripEl?.getBoundingClientRect() ?? null,
        tabs,
        ctx,
        collapsed: layoutRef.current.groups[groupId]?.collapsed === true,
        unmergeable: ops.isGroupUnmergeable(layoutRef.current, panes, groupId),
      };
    };
    const readGroup = (el: Element, ctx: GroupContext): GroupTarget | null => {
      const groupId = el.getAttribute("data-dock-group");
      if (groupId === null) return null;
      return buildTarget(el, el, groupId, ctx);
    };

    container.querySelectorAll("[data-dock-leaf]").forEach((leaf) => {
      const nodeId = leaf.getAttribute("data-dock-leaf");
      const edge = leaf.getAttribute("data-dock-edge") as DockEdge | null;
      const groupEl = leaf.querySelector("[data-dock-group]");
      if (nodeId === null || edge === null || groupEl === null) return;
      const g = readGroup(groupEl, { kind: "docked", nodeId, edge });
      if (g !== null) targets.groups.push(g);
    });
    // Iterate floating windows in front-order (array order = z), not DOM order
    // (which is stable/by-id), so targets are ordered back-to-front and hitTest
    // can pick the topmost (last) match over overlapping windows.
    layoutRef.current.floating.forEach((win) => {
      if (win.id === draggedWindowId) return;
      const winEl = container.querySelector(
        `[data-floating-window="${win.id}"]`,
      );
      if (winEl === null) return;
      winEl.querySelectorAll("[data-dock-group]").forEach((groupEl, index) => {
        const g = readGroup(groupEl, {
          kind: "floating",
          windowId: win.id,
          index,
        });
        if (g !== null) targets.groups.push(g);
      });
    });
    // Nested dockable areas. Pushed LAST so that when an area sits inside a
    // docked/floating panel's body, hovering it makes the area (the topmost
    // match) win over its host. The area's group id comes from the layout (not
    // the DOM), so an EMPTY area -- which renders no inner group/strip -- is
    // still a valid drop target sized to its wrapper.
    const areas = layoutRef.current.areas ?? {};
    container.querySelectorAll("[data-dock-area]").forEach((areaEl) => {
      const areaId = areaEl.getAttribute("data-dock-area");
      if (areaId === null) return;
      const area = areas[areaId];
      if (area === undefined) return;
      if (layoutRef.current.groups[area.group] === undefined) return;
      // Never offer an area that lives INSIDE the dragged window: dropping the
      // window into its own nested area would make the host a child of itself
      // (a containment cycle). Floating windows already skip the dragged one
      // above; areas are found by a container-wide scan, so filter here too.
      if (
        areaEl.closest(`[data-floating-window="${draggedWindowId}"]`) !== null
      )
        return;
      // Skip an area whose host panel is minimized: its wrapper collapses to
      // (near) zero height, and flooring that into a hit band would put a
      // phantom "drop into area" target on top of the host's own handle/zones.
      const areaRect = areaEl.getBoundingClientRect();
      if (
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
      // Inset the area's HIT rect on the left/right/bottom (not the top, which
      // holds its tab strip) so a frame around it falls through to the HOST
      // panel's own edge zones -- otherwise a full-bleed area (one that fills its
      // whole panel) would shadow the host everywhere, leaving no way to dock
      // beside/below it. `rect` stays full so the merge HINT is still full-width;
      // only `hitRect` (used for hit detection) is inset.
      const r = t.rect;
      const mx = Math.min(AREA_HIT_INSET_PX, r.width * 0.28);
      const mb = Math.min(AREA_HIT_INSET_PX, r.height * 0.28);
      t.hitRect = new DOMRect(
        r.left + mx,
        r.top,
        Math.max(AREA_HIT_INSET_PX, r.width - 2 * mx),
        Math.max(AREA_HIT_INSET_PX, r.height - mb),
      );
      targets.groups.push(t);
    });
    return targets;
  };

  // --- Split preview --------------------------------------------------------
  // Top/bottom splits make vertical room by actually shrinking the target
  // leaf's height (its contents just scroll -- no distortion). Left/right
  // splits don't change widths at all (the region grows on drop and the new
  // panel brings its own width), so the leaf is left untouched -- only the
  // ghost is shown. Hit-testing uses rects cached at drag start, so the live
  // height change here doesn't move the drop zones.
  const previewLeaf = React.useRef<HTMLElement | null>(null);
  // The wrapper's inline background BEFORE the preview tinted it. The wrapper
  // can be a React-managed element with its own inline backgroundColor (when
  // the region is a single leaf, the leaf's parent IS the reserved region
  // container) -- clearing to "" on reset would wipe that style, and React's
  // style diff never re-writes an unchanged value, leaving the region
  // permanently transparent. Restore the saved value instead.
  const previewWrapperBg = React.useRef<string>("");
  const resetLeafPreview = () => {
    const el = previewLeaf.current;
    if (el === null) return;
    el.style.height = "";
    el.style.alignSelf = "";
    el.style.transition = "";
    // Restore the wrapper's pre-tint background (see applyLeafPreview).
    const wrapper = el.parentElement;
    if (wrapper !== null)
      wrapper.style.backgroundColor = previewWrapperBg.current;
    previewLeaf.current = null;
  };
  const applyLeafPreview = (
    nodeId: NodeId,
    region: "top" | "bottom" | "left" | "right",
  ) => {
    // Left/right: no leaf change (ghost only).
    if (region === "left" || region === "right") {
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
    el.style.transition = prefersReducedMotion() ? "none" : "height 120ms ease";
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

  // --- Window drag (shared by every drag path) ---------------------------

  const beginWindowDrag = (
    windowId: WindowId,
    groupIdForDim: GroupId | null,
    pointerId: number,
    pointerType: string,
    grabX: number,
    grabY: number,
    /** Pre-drag layout for drags that COMMIT an op up front (float a group/
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
    // rects AND may recreate the dragged window's DOM node; both are
    // re-resolved lazily in apply() so drops land on what's actually on screen.
    let targetsLayout = layoutRef.current;
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

    const apply = () => {
      raf = null;
      const e = latest;
      if (e === null) return;
      if (layoutRef.current !== targetsLayout) {
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
        }
        // A mid-drag layout change may have moved the dragged window's
        // RESTING position (e.g. a server update). The transform is relative
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
      [finalX, finalY] = clampCorner(desiredLeft, desiredTop, crect.width, crect.height);
      el.style.transform = `translate(${finalX - restingLeft}px, ${finalY - restingTop}px)`;
      const hit = hitTest(
        layoutRef.current,
        // Rendered reserved widths (NOT the model regionWidth): drop zones
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
        // A cancelled pointer (Escape, browser-stolen touch) ABORTS: no dock,
        // no move -- clearing the transform snaps the window back to where the
        // drag started. Only a real pointerup commits.
        detach();
        activeCleanup.current = null;
        if (raf !== null) {
          cancelAnimationFrame(raf);
          if (!cancelled) apply();
        }
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
        if (cancelled) {
          // A deferred-float drag already committed its float op; put the
          // pre-drag layout back so Escape really means "never mind" --
          // including region widths, which the snapshot carries.
          if (restoreOnCancel !== undefined) restoreLayout(restoreOnCancel);
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
        // structural op (no per-path region-width juggling).
        if (result.kind === "edge") {
          applyOp(ops.dockToEdge(base, stack, result.edge));
        } else if (result.kind === "regionEdge") {
          applyOp(ops.dockToRegionEdge(base, stack, result.edge, result.side));
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
          // Expanding a collapsed target makes the drop visible -- merging
          // into a minimized handle would silently hide the dropped panel.
          applyOp(
            ops.expandGroup(
              ops.mergeGroupsInto(base, result.targetGroupId, stack),
              result.targetGroupId,
            ),
          );
        } else if (result.kind === "insertTab") {
          applyOp(
            ops.expandGroup(
              ops.insertTabsInto(
                base,
                result.targetGroupId,
                stack,
                result.index,
              ),
              result.targetGroupId,
            ),
          );
        } else {
          applyOp(
            ops.snapToWindowStack(base, stack, result.windowId, result.index),
          );
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
    activeCleanup.current = () => {
      detach();
      el.style.opacity = "";
      restoreSelect();
      restoreCursor();
      draggingWindowIdRef.current = null;
      if (raf !== null) cancelAnimationFrame(raf);
    };
  };

  /** Run a drag whose gesture COMMITS layout ops up front (float a group or
   * column, tear out a tab, expand-then-drag). Pairs the commit with its
   * Escape-restore snapshot BY CONSTRUCTION: the snapshot is taken here,
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
      e.pointerType,
      params.grabX,
      params.grabY,
      before,
    );
  };

  // --- Deferred drags (float/tear, then drag the new window) -------------

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
    // Ignore presses that bubble in from PORTALED children (a share modal's
    // overlay, a tooltip label): React portals bubble through the REACT tree,
    // so without this DOM-containment check a click inside an open modal
    // would arm a drag / click-toggle on the handle underneath.
    if (!event.currentTarget.contains(event.target as Node)) return;
    // Finalize any pending tab-reorder settle so its delayed setDraggingTabId
    // doesn't fire in the middle of this new gesture (which would un-mark a tab
    // mid-drag and let FLIP fight the manager's imperative transform).
    if (settleTimer.current !== undefined) {
      clearTimeout(settleTimer.current);
      settleTimer.current = undefined;
      setDraggingTabId(null);
    }
    // Suppress text selection from the PRESS, not from the drag threshold: the
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
        // Only a real release is a click -- a CANCELLED pointer (touch grabbed
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

  // --- Context callbacks -------------------------------------------------

  const startWindowDrag: DockContextValue["startWindowDrag"] = (
    event,
    windowId,
  ) => {
    if (layoutRef.current.floating.every((w) => w.id !== windowId)) return;
    // Press-time POINTER coordinates, but the window's CURRENT model position
    // at drag start: the window may move between press and the drag threshold
    // (container-resize anchoring), and offsets frozen against the press-time
    // position would teleport it back on the first drag frame.
    const pressX = event.clientX;
    const pressY = event.clientY;
    armPress(event, (e) => {
      const win = layoutRef.current.floating.find((w) => w.id === windowId);
      if (win === undefined) return;
      const { grabX, grabY } = grabOffset(
        { clientX: pressX, clientY: pressY },
        win.x,
        win.y,
      );
      beginWindowDrag(windowId, null, e.pointerId, e.pointerType, grabX, grabY);
    });
  };

  const startGroupDrag: DockContextValue["startGroupDrag"] = (
    event,
    groupId,
    opts,
  ) => {
    // A no-motion press drags nothing but fires opts.onClick (the unmergeable
    // header uses this to toggle minimize on click, like the live FloatingPanel).
    const onClick = opts?.onClick;
    const expandOnDrag = opts?.expandOnDrag === true;
    const loc = ops.findGroupLocation(layoutRef.current, groupId);
    // A group alone in its floating window just moves that window on drag.
    if (loc?.kind === "floating") {
      const win0 = layoutRef.current.floating.find(
        (w) => w.id === loc.windowId,
      );
      if (win0 !== undefined && win0.stack.length === 1) {
        const windowId = win0.id;
        // Press-time pointer, drag-start model position (see startWindowDrag).
        const pressX = event.clientX;
        const pressY = event.clientY;
        armPress(
          event,
          (e) => {
            const win = layoutRef.current.floating.find(
              (w) => w.id === windowId,
            );
            if (win === undefined) return;
            const { grabX, grabY } = grabOffset(
              { clientX: pressX, clientY: pressY },
              win.x,
              win.y,
            );
            if (expandOnDrag) {
              // A drag from the expand (+) button tears out the FULL panel:
              // expand first (flushed so the window height renders), then
              // drag. The expand is an up-front COMMIT, so it goes through
              // dragAfterCommit and Escape restores the minimized state.
              dragAfterCommit(e, () => {
                flushSync(() =>
                  applyOp(ops.expandGroup(layoutRef.current, groupId)),
                );
                return { windowId, groupIdForDim: null, grabX, grabY };
              });
            } else {
              beginWindowDrag(
                windowId,
                null,
                e.pointerId,
                e.pointerType,
                grabX,
                grabY,
              );
            }
          },
          onClick,
        );
        return;
      }
    }
    armPress(event, (e) => {
      dragAfterCommit(e, () => {
        const rect = floatRectFor(`[data-dock-group="${groupId}"]`);
        // A MINIMIZED docked group renders as a ~strip-narrow cell, so its
        // measured width is meaningless as a panel width. Float it at the
        // region's preserved EXPANDED width instead (regionWidth survives
        // minimization for exactly this kind of restore) -- otherwise tearing
        // out a minimized panel produces a ~96px-wide window that stays narrow
        // after expand. Expanded groups keep their measured width.
        const loc = ops.findGroupLocation(layoutRef.current, groupId);
        const collapsed =
          layoutRef.current.groups[groupId]?.collapsed === true;
        const floatWidth =
          collapsed && loc?.kind === "docked"
            ? regionWidthsOf(layoutRef.current)[loc.edge]
            : rect.width;
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
        // applyOp reconciles region widths: undocking this column removes it
        // from the region's column set, so siblings keep their widths and the
        // region shrinks by the removed column's width. A drag from the
        // expand (+) button floats the panel EXPANDED -- dragging it should
        // produce a full panel, not a minimized stub.
        flushSync(() =>
          applyOp(
            expandOnDrag ? ops.expandGroup(res.layout, groupId) : res.layout,
          ),
        );
        // Clamp the grab into the floated window: the source (a region-tall
        // minimized strip / docked column) can be far bigger than the result.
        return {
          windowId: res.windowId,
          groupIdForDim: groupId,
          ...grabOffset(e, rect.x, rect.y, res.windowId),
        };
      });
    }, onClick);
  };

  const startColumnDrag: DockContextValue["startColumnDrag"] = (
    event,
    edge,
    columnNodeId,
  ) => {
    armPress(event, (e) => {
      dragAfterCommit(e, () => {
        // Measure the COLUMN wrapper (not the 1em handle): floatRectFor clamps
        // width/height into sane floating ranges, same as a group undock.
        const rect = floatRectFor(`[data-dock-column="${columnNodeId}"]`);
        const res = ops.floatColumn(
          layoutRef.current,
          edge,
          columnNodeId,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
        );
        // Null when the column was restructured under us or isn't a pure
        // column anymore; just don't drag.
        if (res.windowId === null) return null;
        // applyOp reconciles region widths: removing this column from the
        // edge's column set lets survivors keep their px and shrinks the
        // region.
        flushSync(() => applyOp(res.layout));
        return {
          // No single origin group to dim; the whole column left the tree.
          windowId: res.windowId,
          groupIdForDim: null,
          // Clamp into the floated window: a region-tall column floats into a
          // height-capped window, so a low grab would otherwise gap (same fix as
          // the group undock above).
          ...grabOffset(e, rect.x, rect.y, res.windowId),
        };
      });
    });
  };

  const startTabDrag: DockContextValue["startTabDrag"] = (
    event,
    groupId,
    paneId,
  ) => {
    const stripEl = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-dock-strip]",
    );
    const stripRect = stripEl?.getBoundingClientRect() ?? null;

    let raf: number | null = null;
    let latest: PointerEvent | null = null;
    let detach: (() => void) | null = null;
    let reordering = false;
    // Insertion index shown by the line and committed on drop.
    let lastInsert: number | null = null;
    // Accumulated translateX on the dragged tab (so it follows the cursor).
    let tabTx = 0;
    const draggedTabEl = () =>
      stripEl?.querySelector<HTMLElement>(`[data-dock-tab="${paneId}"]`) ?? null;

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
        tabEl.style.transition = "";
        tabEl.style.transform = "";
      }
      if (reordering) setDraggingTabId(null);
    };
    // Pointer-up while reordering: commit the reorder to the line's index, then
    // glide the dragged tab from the cursor into its new slot.
    const commitReorder = () => {
      teardown();
      if (!reordering) return;
      if (lastInsert === null) {
        setDraggingTabId(null);
        return;
      }
      const cursorX = latest?.clientX ?? 0;
      const index = lastInsert;
      flushSync(() =>
        applyOp(ops.reorderTab(layoutRef.current, groupId, paneId, index)),
      );
      const tabEl = draggedTabEl();
      if (tabEl !== null && prefersReducedMotion()) {
        tabEl.style.transition = "";
        tabEl.style.transform = "";
      } else if (tabEl !== null) {
        // Re-anchor at the cursor (no jump when the slot moves), then ease in.
        const rect = tabEl.getBoundingClientRect();
        const restCenter = rect.left + rect.width / 2 - tabTx;
        tabEl.style.transition = "none";
        tabEl.style.transform = `translateX(${cursorX - restCenter}px)`;
        requestAnimationFrame(() => {
          tabEl.style.transition = "transform 160ms ease";
          tabEl.style.transform = "";
        });
      }
      // Keep draggingTabId set through the settle so FLIP leaves this tab to
      // us -- except under reduced motion, where there's no glide to protect.
      if (prefersReducedMotion()) {
        setDraggingTabId(null);
      } else {
        settleTimer.current = window.setTimeout(
          () => setDraggingTabId(null),
          180,
        );
      }
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
        lastInsert = 0;
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
        tabEl.style.transition = "none";
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
                e0.pointerType,
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
          // Pointer-up commits the reorder to the line's index; a CANCELLED
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

  // The gesture starters above are recreated each render (they close over
  // fresh props); expose STABLE wrappers so the memoized context value below
  // doesn't churn identity on every render.
  const gestureImpls = {
    startGroupDrag,
    startTabDrag,
    startWindowDrag,
    startColumnDrag,
  };
  const gestureRef = React.useRef(gestureImpls);
  gestureRef.current = gestureImpls;
  const stableGestures = React.useMemo(
    () =>
      ({
        startGroupDrag: (...args) =>
          gestureRef.current.startGroupDrag(...args),
        startTabDrag: (...args) => gestureRef.current.startTabDrag(...args),
        startWindowDrag: (...args) =>
          gestureRef.current.startWindowDrag(...args),
        startColumnDrag: (...args) =>
          gestureRef.current.startColumnDrag(...args),
      }) satisfies Pick<
        DockContextValue,
        | "startGroupDrag"
        | "startTabDrag"
        | "startWindowDrag"
        | "startColumnDrag"
      >,
    [],
  );
  const activateTab = React.useCallback(
    (groupId: GroupId, paneId: PaneId) =>
      applyOp(ops.setActiveTab(layoutRef.current, groupId, paneId)),
    [applyOp],
  );
  const expandToTab = React.useCallback(
    (groupId: GroupId, paneId: PaneId) =>
      applyOp(
        ops.expandGroup(
          ops.setActiveTab(layoutRef.current, groupId, paneId),
          groupId,
        ),
      ),
    [applyOp],
  );
  const toggleCollapsed = React.useCallback(
    (groupId: GroupId) =>
      applyOp(ops.toggleCollapsed(layoutRef.current, groupId)),
    [applyOp],
  );
  // Memoized so renders driven by HIGH-CHURN state (region widths during a
  // resize drag, container height during a browser resize -- which live in
  // DockMetricsContext instead) don't invalidate every context consumer: with
  // a stable context, memoized children skip re-rendering entirely.
  const contextValue: DockContextValue = React.useMemo(
    () => ({
      panes,
      api,
      layout,
      groups: layout.groups,
      areas: layout.areas ?? {},
      resizing,
      setResizing,
      ...stableGestures,
      activateTab,
      expandToTab,
      toggleCollapsed,
      draggingGroupId,
      draggingTabId,
    }),
    [
      panes,
      api,
      layout,
      resizing,
      stableGestures,
      activateTab,
      expandToTab,
      toggleCollapsed,
      draggingGroupId,
      draggingTabId,
    ],
  );
  const metrics: DockMetrics = React.useMemo(
    () => ({
      reservedWidth: {
        left:
          plans.left !== null
            ? plannedReservedWidth(plans.left, regionWidth.left)
            : 0,
        right:
          plans.right !== null
            ? plannedReservedWidth(plans.right, regionWidth.right)
            : 0,
      },
      containerWidth,
      containerHeight,
    }),
    [regionWidth, plans, containerWidth, containerHeight],
  );

  // Stable per-window handlers (windowId-first) so FloatingWindowView can be
  // memoized -- inline per-window closures would break the memo every render.
  // A user resize gesture (any grip) takes manual control: release the window's
  // server anchor so it stops re-resolving against the canvas edges (otherwise a
  // right/bottom-anchored panel would grow away from the cursor as the resolve
  // re-pins its far edge). Server-driven set_width/set_height go through
  // applyPanelPlacement, not these handlers, so they keep the anchor.
  const onWindowResize = React.useCallback(
    (windowId: WindowId, width: number, x?: number) =>
      applyOp(
        ops.resizeWindow(
          ops.releaseAnchor(layoutRef.current, windowId),
          windowId,
          width,
          x,
        ),
      ),
    [applyOp],
  );
  const onWindowResizeHeight = React.useCallback(
    (windowId: WindowId, height: number | undefined, y?: number) =>
      applyOp(
        ops.resizeWindowHeight(
          ops.releaseAnchor(layoutRef.current, windowId),
          windowId,
          height,
          y,
        ),
      ),
    [applyOp],
  );
  const onWindowSetStackWeights = React.useCallback(
    (windowId: WindowId, weights: Record<GroupId, number>) =>
      applyOp(ops.setStackWeights(layoutRef.current, windowId, weights)),
    [applyOp],
  );
  const onWindowFront = React.useCallback(
    (windowId: WindowId) =>
      applyOp(ops.bringToFront(layoutRef.current, windowId)),
    [applyOp],
  );

  // Each docked region renders its FULL tree: fully-minimized columns are
  // fixed-width vertical strips that inset the canvas like any other column.
  // All width accounting (which columns are strips, how much fixed chrome
  // sits on top of regionWidth) comes from ONE classification: planRegion.
  const regions = (["left", "right"] as DockEdge[]).map((edge) => {
    const tree = layout.docked[edge];
    const plan = plans[edge];
    if (tree === null || plan === null)
      return {
        edge,
        tree,
        reservedWidth: 0,
        hasExpanded: false,
        resizerStripOffset: 0,
      };
    return {
      edge,
      tree,
      hasExpanded: plan.hasExpanded,
      reservedWidth: plannedReservedWidth(plan, regionWidth[edge]),
      // Inset the resize handle past any canvas-facing minimized strips so it
      // lands on the first expanded panel's boundary, not the strip's far side.
      resizerStripOffset: canvasFacingStripOffsetPx(plan, edge),
    };
  });
  // Render-time overflow guard: many panels docked on a narrow viewport can make
  // left + right reserved width exceed the container, overlapping the regions and
  // fully occluding the canvas (trapping the controls underneath). When the sum
  // would leave less than MIN_CANVAS_PX of scene, scale BOTH regions down
  // proportionally so a usable canvas strip always remains. Model widths are
  // untouched -- this only shrinks what's rendered; widths restore when the
  // viewport grows back. (containerWidth === 0 before first measure -> skip.)
  if (containerWidth > 0) {
    const available = containerWidth - MIN_CANVAS_PX;
    const total = regions[0].reservedWidth + regions[1].reservedWidth;
    if (total > available && total > 0) {
      const scale = Math.max(0, available) / total;
      regions[0].reservedWidth = Math.floor(regions[0].reservedWidth * scale);
      regions[1].reservedWidth = Math.floor(regions[1].reservedWidth * scale);
    }
  }
  const leftInset = regions[0].reservedWidth;
  const rightInset = regions[1].reservedWidth;
  // Rendered region widths, for hit-testing during drags: drop zones and
  // their hints must align to what's on screen, not to the MODEL regionWidth
  // (which excludes the strips and preserves widths through minimization).
  reservedWidthRef.current = { left: leftInset, right: rightInset };

  // Keep floating windows positioned correctly as the canvas changes (docked
  // insets grow/shrink, or the container resizes):
  // - Server-anchored panels (those carrying an `anchor`) RE-RESOLVE
  //   their canvas-relative anchor against the live canvas + measured window
  //   size -- this is what makes negative coords (gap-from-far-edge, e.g.
  //   top-right `x:-15`) track the edge, and what places auto-height panels with
  //   a negative y once their height is known.
  // - Other (user-dragged) windows are CLAMPED inward so a growing docked region
  //   pushes a float it would otherwise cover; a float comfortably inside is left
  //   alone, so undocking/dragging isn't second-guessed.
  // Fires on every inset/size change, including each frame of an interactive
  // region resize -- safe because it only touches `floating`, not docked widths.
  // Re-resolve requested-coord windows + clamp dragged ones. Idempotent: given
  // the same canvas + measured sizes it produces the same positions, so it never
  // loops. Reads measured heights so a negative y (gap-from-bottom) on an
  // auto-height panel lands correctly once the panel has rendered.
  // Re-resolve requested-coord windows (always) and optionally clamp dragged
  // ones. `clampDragged` is set ONLY for inset changes: a growing docked region
  // PUSHES a covered float inward (the requested behavior). On a plain container
  // resize or a window-size change we must NOT clamp dragged floats -- the
  // container ResizeObserver already anchors them and preserves deliberate
  // overhang (clampCorner); double-clamping here would yank an overhanging
  // user float fully inside on every resize.
  const resolveFloatingPositions = React.useCallback((clampDragged: boolean) => {
    const el = containerRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const heights = new Map<string, number>();
    el.querySelectorAll<HTMLElement>("[data-floating-window]").forEach(
      (winEl) => {
        const id = winEl.getAttribute("data-floating-window");
        if (id !== null) heights.set(id, winEl.offsetHeight);
      },
    );
    const bounds = {
      width: rect.width,
      height: rect.height,
      leftInset: reservedWidthRef.current.left,
      rightInset: reservedWidthRef.current.right,
    };
    setLayout((cur) => {
      let changed = false;
      const floating = cur.floating.map((w) => {
        if (w.id === draggingWindowIdRef.current) return w;
        const winHeight = heights.get(w.id) ?? pinnedPxOf(w.height) ?? 0;
        let x: number;
        let y: number;
        if (w.anchor !== undefined) {
          // Server-anchored: re-resolve the (possibly negative) anchor.
          ({ x, y } = ops.resolveRequestedFloatPosition(
            w.anchor.x,
            w.anchor.y,
            w.width,
            winHeight,
            bounds,
          ));
        } else if (clampDragged) {
          // User-dragged, inset grew: push inward so the chrome doesn't cover it.
          const maxX = Math.max(
            bounds.leftInset,
            rect.width - bounds.rightInset - w.width,
          );
          x = Math.min(Math.max(w.x, bounds.leftInset), maxX);
          y = w.y;
        } else {
          return w;
        }
        if (x === w.x && y === w.y) return w;
        changed = true;
        return { ...w, x, y };
      });
      if (!changed) return cur;
      const next = { ...cur, floating };
      layoutRef.current = next;
      return next;
    });
  }, []);

  // Inset change (docking): re-resolve requested + push dragged floats inward.
  React.useEffect(() => {
    resolveFloatingPositions(true);
  }, [leftInset, rightInset, resolveFloatingPositions]);

  // Container resize: re-resolve requested floats only (the container
  // ResizeObserver handles dragged-float anchoring + overhang).
  React.useEffect(() => {
    resolveFloatingPositions(false);
  }, [containerWidth, containerHeight, resolveFloatingPositions]);

  // A floating window's RENDERED size changing (e.g. an auto-height panel
  // finishing its first layout, or content growing) re-resolves requested floats
  // so a negative y uses the real height. Observe the windows directly.
  //
  // Keyed on the SET of window ids (not `layout.floating`, which is a fresh array
  // on every layout commit): otherwise the observer would disconnect/reconnect on
  // every frame of any drag (each per-frame commit clones the layout), firing an
  // extra resolve each frame. We only need to re-attach when windows are
  // added/removed.
  const floatingWindowIds = layout.floating
    .map((w) => w.id)
    .sort()
    .join("\n");
  React.useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const observer = new ResizeObserver(() => resolveFloatingPositions(false));
    el.querySelectorAll("[data-floating-window]").forEach((winEl) =>
      observer.observe(winEl),
    );
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floatingWindowIds, resolveFloatingPositions]);

  return (
    <DockContext.Provider value={contextValue}>
      <DockMetricsContext.Provider value={metrics}>
      <Box
        ref={containerRef}
        data-dock-root
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}
      >
        {/* Center content, inset by docked regions. */}
        <Box
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: leftInset,
            right: rightInset,
          }}
        >
          {children}
        </Box>

        {/* Docked regions: every column insets the canvas, with fully-minimized
        columns rendering as fixed-width vertical strips. */}
        {regions.map(
          ({ edge, tree, hasExpanded, reservedWidth, resizerStripOffset }) => (
          <React.Fragment key={edge}>
            {/* Canvas-facing shadow on a div BEHIND the panes (zIndex 1), so it
            only shows over the canvas, never on top of a panel. */}
            {tree !== null && (
              <Box
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  [edge]: 0,
                  width: reservedWidth,
                  zIndex: 1,
                  pointerEvents: "none",
                  boxShadow: "0 0 1em 0 rgba(0,0,0,0.1)",
                }}
              />
            )}
            {tree !== null && (
              <Box
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  [edge]: 0,
                  width: reservedWidth,
                  display: "flex",
                  backgroundColor: "var(--mantine-color-body)",
                  zIndex: 5,
                }}
              >
                <SplitView node={tree} edge={edge} topLevel />
                {hasExpanded && (
                <RegionResizer
                  edge={edge}
                  stripOffset={resizerStripOffset}
                  getStart={() => reservedWidth}
                  // Called once per drag: snapshots the columns' start widths
                  // and limits, and returns the per-frame handler. Widths are
                  // redistributed across ALL columns from their drag-start
                  // proportions, clamping each to its own min/max and handing
                  // the difference to columns that still have room -- so the
                  // region keeps resizing while any column can give or take.
                  makeOnResize={() => {
                    const layout0 = layoutRef.current;
                    const tree0 = layout0.docked[edge];
                    if (tree0 === null) return () => {};
                    // Only EXPANDED columns participate: minimized strips are
                    // fixed-width chrome that the drag passes through, so the
                    // cursor moves 1:1 with the expanded panes. The plan is
                    // the same classification the render uses.
                    const plan = planRegion(tree0, layout0.groups);
                    const cols = plan.expandedColumns;
                    if (cols.length === 0) return () => {};
                    const startRegion = regionWidthsOf(layoutRef.current)[
                      edge
                    ];
                    // Weights are pixels for side-by-side columns (the
                    // reconciler wrote them); a single surfaced column's px
                    // is the regionWidth itself (its weight may be a height).
                    const init = plan.singleColumn
                      ? [startRegion]
                      : cols.map((c) => c.weight);
                    const mins = cols.map((c) => ops.minRegionWidth(c));
                    // No per-column max: a region drag is bounded only by its
                    // columns' grab-mins (and the render-time canvas guard), not
                    // a fixed per-panel width -- matching the width reconciler
                    // and SplitView divider drags.
                    const maxs = cols.map(() => Infinity);
                    const ids = cols.map((c) => c.id);
                    return (reservedPx: number) => {
                      // The grip reports the desired RESERVED width, which
                      // includes the fixed chrome; subtract it to get the
                      // expanded columns' share.
                      const widths = ops.resizeRegionColumns(
                        init,
                        mins,
                        maxs,
                        reservedPx - plan.chromePx,
                      );
                      const total = widths.reduce((a, b) => a + b, 0);
                      // Only rewrite weights for genuinely side-by-side
                      // columns; a single surfaced column may be a vertical
                      // child whose weight is a HEIGHT (see applyOp). The
                      // total goes through the setRegionWidth op so the model
                      // stays the single source of truth for the width.
                      let next = layoutRef.current;
                      if (!plan.singleColumn) {
                        const byId: Record<string, number> = {};
                        ids.forEach((id, i) => {
                          byId[id] = widths[i];
                        });
                        next = ops.setNodeWeights(next, edge, byId);
                      }
                      // Flush the width commit so the canvas wrapper's new
                      // inset is in the DOM before the host reads it. The host
                      // (the 3D canvas) then resizes its GL backbuffer to the
                      // new CSS box on THIS tick, so the rendered scene tracks
                      // the divider instead of trailing R3F's async
                      // ResizeObserver by a frame on a fast drag.
                      flushSync(() =>
                        applyOp(ops.setRegionWidth(next, edge, total)),
                      );
                      onRegionResizeFrameRef.current?.();
                    };
                  }}
                />
                )}
              </Box>
            )}
          </React.Fragment>
        ))}

        {/* Floating windows. The `floating` array order is the front-order
        (last = topmost), but we render in a STABLE order (by id) and drive
        stacking with z-index. That way raising a window (bringToFront reorders
        the array) only changes z-index -- it never moves the DOM node, which
        would otherwise eat an in-flight click on e.g. the minimize button. */}
        {layout.floating
          .map((win, frontOrder) => ({ win, frontOrder }))
          .sort((a, b) => (a.win.id < b.win.id ? -1 : a.win.id > b.win.id ? 1 : 0))
          .map(({ win, frontOrder }) => (
            <FloatingWindowView
              key={win.id}
              win={win}
              zIndex={10 + frontOrder}
              containerHeight={containerHeight}
              onResize={onWindowResize}
              onResizeHeight={onWindowResizeHeight}
              onSetStackWeights={onWindowSetStackWeights}
              onFront={onWindowFront}
            />
          ))}

        {/* Drop hint: a persistent element positioned imperatively by
        showHint. Its style prop is a module constant, so React's style diff
        never touches the imperative mutations across re-renders. */}
        <div ref={hintRef} style={HINT_BASE_STYLE} />
      </Box>
      </DockMetricsContext.Provider>
    </DockContext.Provider>
  );
}

// Base style for the imperative drop-hint element (see showHint). The hint per
// variant: a tinted highlight (tab merge), a solid zone (edge dock), or a thin
// insertion bar (split / tab-position / stack drops).
const HINT_BASE_STYLE: React.CSSProperties = {
  position: "absolute",
  display: "none",
  pointerEvents: "none",
  zIndex: 1000,
  boxSizing: "border-box",
};
const HINT_VARIANT_STYLES: Record<
  DropHint["variant"],
  { backgroundColor: string; borderRadius: string; opacity: string }
> = {
  merge: {
    backgroundColor: "var(--mantine-primary-color-light)",
    borderRadius: "6px",
    opacity: "0.75",
  },
  fill: {
    backgroundColor: "var(--mantine-primary-color-light)",
    borderRadius: "0",
    opacity: "0.8",
  },
  line: {
    backgroundColor: "var(--mantine-primary-color-filled)",
    borderRadius: "0",
    opacity: "1",
  },
};
