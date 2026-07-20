// D#/P#/section citations refer to ./dock-ux-spec.md (the normative spec,
// in this directory).
// Top-level docking surface. Owns the layout model and its commit pipeline
// (applyOp -> width reconciliation -> invariant checks -> ownership
// attribution), renders the left/right docked regions and floating windows
// over a center area, and assembles the contexts the panel/frame components
// consume. The gesture machinery lives beside it and is composed here:
// dragController.ts runs every drag-and-drop gesture (moving, docking, tab
// tear-out, merging, snapping), regionResize.ts runs the region-width drag
// and the canvas-inset sync, and dropHint.ts paints the drop hint.

import { Box } from "@mantine/core";
import React from "react";
import {
  DockContext,
  DockContextValue,
  DockMetrics,
  DockMetricsContext,
} from "./DockContext";
import { clampCorner, useDragController } from "./dragController";
import { HINT_BASE_STYLE } from "./dropHint";
import { FloatingWindowView } from "./FloatingWindowView";
import { SplitView } from "./SplitView";
import { bumpFreshIdFloor, focusDockControl } from "./gestures";
import * as ops from "./layoutOps";
import { makeRegionResizeHandlers, useCanvasInsetSync } from "./regionResize";
import { RegionResizer } from "./RegionResizer";
import { RegionCollapseChevron, StackHandleBar } from "./handles";
import { canvasInsetAnim, regionWidthAnim } from "./DockStyles.css";
import { plannedReservedWidth, planRegion } from "./regionPlan";
import { reconcileRegionWidths } from "./widthReconciliation";
import { invariantViolations } from "./layoutInvariants";
import {
  clamp,
  DockEdge,
  DockLayout,
  FloatingWindow,
  GroupId,
  isRegionPackedOn,
  MIN_CANVAS_PX,
  NodeId,
  PaneId,
  PaneRegistry,
  pinnedPxOf,
  regionWidthsOf,
  WindowId,
  emptyLayout,
} from "./types";

/** The MIN_CANVAS_PX overflow guard: scale the two regions' RENDERED widths
 * proportionally when their sum would leave less than MIN_CANVAS_PX of scene.
 * Model widths are untouched (they restore when the viewport grows back).
 * ONE definition, consumed by both the render path and the DockMetrics memo,
 * so the metrics can never drift from what actually insets the canvas. */
function squeezeRendered(
  planned: { left: number; right: number },
  containerWidth: number,
): { left: number; right: number; active: boolean } {
  if (containerWidth <= 0) return { ...planned, active: false };
  const available = containerWidth - MIN_CANVAS_PX;
  const total = planned.left + planned.right;
  if (total <= available || total <= 0) return { ...planned, active: false };
  const scale = Math.max(0, available) / total;
  return {
    left: Math.floor(planned.left * scale),
    right: Math.floor(planned.right * scale),
    active: true,
  };
}

export function DockManager({
  initialLayout,
  panes,
  children,
  onLayoutChange,
  onCommit,
  onRegionResizeFrame,
}: {
  initialLayout: DockLayout;
  panes: PaneRegistry;
  /** Center content (e.g. the 3D canvas), inset by the docked regions. */
  children?: React.ReactNode;
  /** Observe every committed layout (e.g. for persistence or test probes). */
  onLayoutChange?: (layout: DockLayout) => void;
  /** Fired on every commit with the previous + next layout and whether the
   * change was PROGRAMMATIC (the sync layer's api.apply) vs a user gesture. Used
   * to flag panels the user has manually rearranged. */
  onCommit?: (
    prev: DockLayout,
    next: DockLayout,
    programmatic: boolean,
  ) => void;
  /** Called after each per-frame region-width resize is committed AND its new
   * inset has been flushed to the DOM. Lets the host (e.g. the 3D canvas)
   * synchronously react to the canvas's new size on the SAME tick instead of
   * waiting for a ResizeObserver -- see ControlPanelDock / syncCanvasSize. */
  onRegionResizeFrame?: (canvasWidth: number, canvasHeight: number) => void;
}) {
  const onRegionResizeFrameRef = React.useRef(onRegionResizeFrame);
  onRegionResizeFrameRef.current = onRegionResizeFrame;
  const [layout, setLayout] = React.useState(() => {
    // MIGRATION + RECONCILIATION chokepoint: convert legacy shapes
    // (pre-D46 bands, pre-D44 regionCollapsed, pre-#119 lone-column
    // weights), then reconcile against an empty prior -- the mount commit
    // was previously the ONE consumer-visible layout that never passed
    // reconcileRegionWidths, and a whole tier of downstream "is this
    // weight really px?" guards existed only for that window. Invariant
    // now: every consumer-visible layout has been reconciled (every
    // expanded weight is px >= the grab min). Clone first: reconcile
    // mutates, and the caller's object must stay untouched.
    const migrated = ops.migrateLegacyLayout(initialLayout);
    const draft =
      migrated === initialLayout ? structuredClone(initialLayout) : migrated;
    reconcileRegionWidths(emptyLayout(), draft);
    return draft;
  });
  const layoutRef = React.useRef(layout);
  layoutRef.current = layout;
  // Seed the fresh-id counter past any ids the initial layout brought with it
  // (a restored/persisted layout): the counter restarts at 0 each session, so
  // without this a new `node-3` would collide with a restored `node-3`
  // (duplicate-id invariant violation / groups-map clobber). Seeds from the
  // MIGRATED layout, never the raw prop: allLayoutIds walks the columns-only
  // shape (a legacy {rows} prop would throw), and the migrated tree's ids
  // are the ones that must not collide. useState's initializer runs exactly
  // once per mount.
  React.useState(() => bumpFreshIdFloor(ops.allLayoutIds(layoutRef.current)));
  const onLayoutChangeRef = React.useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;
  const onCommitRef = React.useRef(onCommit);
  onCommitRef.current = onCommit;
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
  // True only during a region-divider drag (per-frame width commits). Read by
  // the float re-clamp effect and the production invariant throttle.
  const regionResizeDraggingRef = React.useRef(false);
  // The persistent drop-hint element; the drag controller paints it
  // imperatively through dropHint.ts (state-driven hints would re-render the
  // whole dock subtree once per pointer move).
  const hintRef = React.useRef<HTMLDivElement>(null);

  const containerRef = React.useRef<HTMLDivElement>(null);
  // The window currently being dragged, if any. The container ResizeObserver
  // skips it: during a drag the CURSOR is the source of truth for that
  // window's position, and an anchor/pull write mid-drag would detach the
  // window from the cursor (the drop commits the final position anyway).
  const draggingWindowIdRef = React.useRef<WindowId | null>(null);
  // Set for the duration of a drag: lets the per-window ResizeObserver mark
  // the drag's cached target rects stale (a window growing mid-drag).
  const markDragTargetsStaleRef = React.useRef<(() => void) | null>(null);
  // Cleanup for an in-flight gesture, run if the manager unmounts mid-drag.
  const activeCleanup = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => activeCleanup.current?.(), []);

  // ONE region plan per edge per layout (fix: previously re-planned in the
  // render body AND the auto-grow effect AND metrics, several walks per frame
  // during a region resize). Shared by all three consumers below.
  const plans = React.useMemo(
    () => ({
      left: layout.docked.left !== null ? planRegion(layout.docked.left) : null,
      right:
        layout.docked.right !== null ? planRegion(layout.docked.right) : null,
    }),
    [layout],
  );

  // Apply a layout op, reconciling docked region widths (written into
  // next.regionWidth) so panes keep their pixel widths across structural
  // changes (see widthReconciliation.ts). The old auto-grow effect is gone:
  // the reconciler enforces the min-width floor on every commit, so a
  // too-narrow region is unrepresentable in committed state.
  // Commit a layout: the place layoutRef + React state are updated for every
  // STRUCTURAL change, so every such layout is invariant-checked (dev: every
  // commit; prod: rate-limited tripwire below). The one sanctioned bypass is
  // patchFloatPositions (position-only float patches, which can't change
  // structure). The fuzz test asserts the same invariants over random op
  // sequences.
  // >0 while a PROGRAMMATIC layout change is running (the sync layer's
  // api.apply, used to apply server placement). User gestures commit with this
  // at 0, so `commit` can tell a user rearrangement from a programmatic one --
  // which drives the "user touched this panel" flag for layout persistence.
  const programmaticDepth = React.useRef(0);
  // Count of commits made OUTSIDE runProgrammatic (i.e. user gestures). Read
  // through api.getUserCommitCount; see its doc in DockContext.
  const userCommitCount = React.useRef(0);
  // Production keeps a RATE-LIMITED invariant tripwire (dev checks EVERY
  // commit, including per-frame gesture commits): layouts are partly
  // SERVER-driven, so a malformed op sequence from server state can ship a
  // violated layout to real users -- whose symptoms (duplicate React keys,
  // silently vanished panes) are exactly the hard-to-diagnose kind. The check
  // is O(layout) on small trees; in production it runs at most every 250ms --
  // which naturally exempts ALL per-frame gesture paths (region/divider/window
  // resizes) while still catching a persisting violation on the next discrete
  // commit -- and stops entirely once the warn budget is spent.
  const invariantWarnBudget = React.useRef(5);
  const lastProdCheckMs = React.useRef(0);
  const commit = React.useCallback((next: DockLayout) => {
    let check = true;
    if (!import.meta.env.DEV) {
      const now = performance.now();
      check =
        invariantWarnBudget.current > 0 && now - lastProdCheckMs.current >= 250;
      if (check) lastProdCheckMs.current = now;
    }
    if (check) {
      // P14 holds by TYPES under D46 (one structure per picture) -- the
      // old canonicalViolations soft set is gone with the band layer.
      const violations = invariantViolations(next);
      if (violations.length > 0) {
        const msg =
          "[dock] layout invariant violation:\n" + violations.join("\n");
        if (import.meta.env.DEV) console.error(msg);
        else {
          invariantWarnBudget.current -= 1;
          console.warn(msg);
        }
      }
    }
    const prev = layoutRef.current;
    layoutRef.current = next;
    setLayout(next);
    const programmatic = programmaticDepth.current > 0;
    // Monotonic user-gesture counter (api.getUserCommitCount): lets a sync
    // layer tell whether the user rearranged anything between queuing a
    // deferred application and actually applying it.
    if (!programmatic) userCommitCount.current += 1;
    onCommitRef.current?.(prev, next, programmatic);
  }, []);

  const applyOp = React.useCallback(
    (next: DockLayout) => {
      if (next === layoutRef.current) return; // no-op op: nothing to commit.
      reconcileRegionWidths(layoutRef.current, next);
      commit(next);
    },
    [commit],
  );

  // Run `fn` with the programmatic flag raised, so commits it causes aren't
  // counted as user gestures.
  const runProgrammatic = React.useCallback((fn: () => void) => {
    programmaticDepth.current += 1;
    try {
      fn();
    } finally {
      programmaticDepth.current -= 1;
    }
  }, []);

  // The ONLY sanctioned bypass of the applyOp->commit pipeline: POSITION-ONLY
  // patches to floating windows (container-resize edge anchoring, server
  // re-anchoring, inset clamping). These run per resize tick, can't change
  // structure (no invariant/width-reconcile/onCommit needed), and must not
  // spuriously flip user-touched flags -- so they write React state directly.
  // `patch` returns null for "unchanged" or the window's new coordinates --
  // the position-only claim holds BY CONSTRUCTION (the patch cannot express a
  // stack/size/structure change). The updater is idempotent (StrictMode may
  // replay it), and the layoutRef sync inside keeps gesture closures reading
  // the fresh positions synchronously. Anything structural must go through
  // applyOp instead.
  const patchFloatPositions = React.useCallback(
    (patch: (w: FloatingWindow) => { x: number; y: number } | null) => {
      setLayout((cur) => {
        let changed = false;
        const floating = cur.floating.map((w) => {
          const pos = patch(w);
          if (pos === null || (pos.x === w.x && pos.y === w.y)) return w;
          changed = true;
          return { ...w, x: pos.x, y: pos.y };
        });
        if (!changed) return cur;
        const next = { ...cur, floating };
        layoutRef.current = next;
        return next;
      });
    },
    [],
  );

  // Imperative panel lifecycle API (exposed via context). Stable identity so
  // sync layers can list it in effect deps without re-running.
  const api = React.useMemo(
    () => ({
      apply: (fn: (l: DockLayout) => DockLayout) =>
        runProgrammatic(() => applyOp(fn(layoutRef.current))),
      /** Replace the layout WHOLESALE (restore, test-probe injection) --
       * unlike `apply`, the incoming ids didn't come from this session's
       * freshId, so the id counter is seeded past them first (same reason as
       * the initialLayout seeding above; a collision would violate the
       * unique-id invariant). Kept separate so the per-frame `apply` path
       * doesn't pay the scan. */
      replace: (layout: DockLayout) =>
        runProgrammatic(() => {
          // MIGRATION chokepoint (D44): injected layouts (restore, test
          // probes) may carry the legacy regionCollapsed store.
          // Unconditional clone at the injection boundary: downstream
          // reconciliation mutates the committed object in place, and the
          // caller's snapshot must never be rewritten under it (with the
          // clone-on-legacy-only form, ownership varied by data age).
          layout = ops.migrateLegacyLayout(structuredClone(layout));
          bumpFreshIdFloor(ops.allLayoutIds(layout));
          applyOp(layout);
        }),
      addPaneToArea: (areaId: string, paneId: PaneId, index?: number) =>
        runProgrammatic(() =>
          applyOp(ops.addPaneToArea(layoutRef.current, areaId, paneId, index)),
        ),
      getUserCommitCount: () => userCommitCount.current,
    }),
    [applyOp, runProgrammatic],
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
    // Reconciliation is internal, not a user gesture -- run it programmatic so
    // it can't spuriously mark surviving panels "user-touched" (a removed
    // panel's collapse can shift siblings' placement signatures).
    if (next !== current) runProgrammatic(() => applyOp(next));
  }, [panes, layout, applyOp, runProgrammatic]);

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
  const expandStackOf = React.useCallback(
    // D31: a stacked bar's expand affordances reveal the WHOLE stack (its
    // visual column), so collapse stays stack-scoped in both directions.
    // `toPaneId` (a bar's title click) activates that tab first.
    (groupId: GroupId, toPaneId?: PaneId) =>
      applyOp(
        ops.expandStackOf(
          toPaneId === undefined
            ? layoutRef.current
            : ops.setActiveTab(layoutRef.current, groupId, toPaneId),
          groupId,
        ),
      ),
    [applyOp],
  );
  // Rail every column (the packed reading is derived, D44/D46). The
  // expand direction has no region-scope affordance -- packed strips
  // expand granularly via their own headers.
  const collapseRegion = React.useCallback(
    (edge: DockEdge) => {
      applyOp(ops.railRegion(layoutRef.current, edge));
    },
    [applyOp],
  );
  const railColumn = React.useCallback(
    (edge: DockEdge, columnId: NodeId, on: boolean) => {
      // A USER op (like collapseRegion): ownership arbitration must learn
      // the user railed/expanded the column, or a stale server placement
      // could silently re-flip it (P6).
      applyOp(ops.setColumnRailed(layoutRef.current, edge, columnId, on));
    },
    [applyOp],
  );
  const toggleCollapsed = React.useCallback(
    (groupId: GroupId) => {
      // D38: the MODEL op resolves the group's CONTAINER and flips its one
      // flag (window collapsed / column railed / regionCollapsed). The UI's
      // CONTROLS are narrower still: the panel-level minimize renders only
      // on a single-group floating window (D32), and a bar's expand routes
      // through expandStackOf instead -- so this toggle is only ever driven
      // from single-group floating-window chrome.
      applyOp(ops.toggleCollapsed(layoutRef.current, groupId));
    },
    [applyOp],
  );

  // Every drag-and-drop gesture (window/group/column/region drags, tab
  // reorder + tear-out) lives in the drag controller; layout changes flow
  // back through applyOp/commit, and the two drag-state refs passed to
  // it let the resize observers below cooperate with an in-flight drag.
  const { stableGestures } = useDragController({
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
  });

  // Container height, for capping floating panes' scrolling bodies (matches
  // the original FloatingPanel, which capped its body to the parent height).
  const [containerHeight, setContainerHeight] = React.useState(0);
  // Container width, exposed via metrics so float coords (incl. negative
  // gap-from-right) can be resolved against the live canvas.
  const [containerWidth, setContainerWidth] = React.useState(0);
  // Ref mirrors so the region-resize drag closure reads the CURRENT container
  // size synchronously (it computes the canvas's new width from this minus the
  // freshly-committed insets). Height is mirrored too: a width drag doesn't
  // change it, but the BROWSER can mid-drag (OS window snap, devtools dock),
  // and a captured stale height would re-impose the drag-start canvas height
  // on the GL backbuffer every frame, fighting the host's own resize handling.
  const containerWidthRef = React.useRef(0);
  containerWidthRef.current = containerWidth;
  const containerHeightRef = React.useRef(0);
  containerHeightRef.current = containerHeight;
  // True only while a region-resize drag is committing a width this frame. The
  // drag owns float movement itself (pushFloatsAheadOfSeam, applied flush with
  // the seam), so the inset effect must NOT also re-clamp unanchored floats then
  // -- that re-clamp is for DISCRETE inset changes (dock/minimize/undock), where
  // nothing else moves an unanchored float out from under the new chrome.
  // (regionResizeDraggingRef is declared earlier, with the animation refs.)

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
      patchFloatPositions((w) => {
        if (w.id === draggingWindowIdRef.current) return null;
        // Server-anchored panels are repositioned by the resolve-effect below
        // (keyed on container size); skip them here so the two don't fight.
        if (w.anchor !== undefined) return null;
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
        return { x, y };
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
      ...stableGestures,
      activateTab,
      expandToTab,
      expandStackOf,
      toggleCollapsed,
      collapseRegion,
      railColumn,
      draggingGroupId,
      draggingTabId,
    }),
    [
      panes,
      api,
      layout,
      stableGestures,
      activateTab,
      expandToTab,
      expandStackOf,
      toggleCollapsed,
      collapseRegion,
      railColumn,
      draggingGroupId,
      draggingTabId,
    ],
  );
  const metrics: DockMetrics = React.useMemo(() => {
    const planned = {
      left:
        plans.left !== null
          ? plannedReservedWidth(plans.left, regionWidth.left)
          : 0,
      right:
        plans.right !== null
          ? plannedReservedWidth(plans.right, regionWidth.right)
          : 0,
    };
    // Metrics report the RENDERED widths -- the squeeze-scaled values that
    // actually inset the canvas (the DockMetrics doc contract) -- so
    // screen-geometry consumers (notification offsets, float-coordinate
    // resolution) aren't off by the squeeze delta on narrow viewports. The
    // same helper drives the render path below; they cannot drift.
    const rendered = squeezeRendered(planned, containerWidth);
    return {
      reservedWidth: { left: rendered.left, right: rendered.right },
      containerWidth,
      containerHeight,
    };
  }, [regionWidth, plans, containerWidth, containerHeight]);

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

  // Each docked region renders its FULL tree; railed columns render as
  // fixed 36px strips counted inside regionWidth by reconciliation (D40/
  // D46), so a packed region -- any column count -- reserves its true
  // 36 x N (the columns' restore widths live in their weights).
  const regionFor = (edge: DockEdge) => {
    const tree = layout.docked[edge];
    const plan = plans[edge];
    if (tree === null || plan === null)
      return {
        tree,
        reservedWidth: 0,
        resizable: false,
      };
    return {
      tree,
      // The rail is fixed-width chrome: nothing to resize when EVERY column
      // in the region is railed (pure rails reserve a fixed ~36px each -- a
      // resize cursor there would lie, D24). Any expanded column keeps the
      // region width-resizable.
      resizable: tree.columns.some((c) => c.railed !== true),
      // MODEL-based reserved width. The resizer's drag baseline reads THIS,
      // never the post-scaling rendered width below -- otherwise grabbing the
      // handle under the MIN_CANVAS_PX render-scale guard (or pressing
      // Escape, which re-commits the start width) would bake the
      // temporarily-scaled width into the model and break "widths restore
      // when the viewport grows".
      reservedWidth: plannedReservedWidth(plan, regionWidth[edge]),
    };
  };
  // Keyed by edge (not positional array indices, whose left/right meaning was
  // only implied by construction order).
  const regions: Record<DockEdge, ReturnType<typeof regionFor>> = {
    left: regionFor("left"),
    right: regionFor("right"),
  };
  // RENDERED widths, derived separately (the model record above is never
  // mutated): the overflow guard scales what's DRAWN when many panels dock on
  // a narrow viewport -- left + right reserved width would otherwise exceed
  // the container, overlapping the regions and fully occluding the canvas
  // (trapping the controls underneath). When the sum would leave less than
  // MIN_CANVAS_PX of scene, both rendered widths shrink proportionally so a
  // usable canvas strip always remains; model widths are untouched, so widths
  // restore when the viewport grows back. (containerWidth === 0 before first
  // measure -> skip.)
  // While the guard is actively scaling, drawn widths track containerWidth
  // per resize event -- easing a per-frame-tracking value is the same regime
  // as a drag (the anim classes' own rule), and with the drawer's pinned pane
  // a lagging container shows blank/clipped strips. Drop the width/inset
  // eases (and the column glide, via [data-dock-squeezing]) for the duration;
  // they return with the first unsqueezed render.
  const squeezed = squeezeRendered(
    {
      left: regions.left.reservedWidth,
      right: regions.right.reservedWidth,
    },
    containerWidth,
  );
  const renderedWidth: Record<DockEdge, number> = {
    left: squeezed.left,
    right: squeezed.right,
  };
  const squeezeActive = squeezed.active;
  const leftInset = renderedWidth.left;
  const rightInset = renderedWidth.right;
  // While the canvas inset eases after a discrete change, feed the wrapper's
  // live box to the host per animation frame (see useCanvasInsetSync).
  const canvasWrapRef = React.useRef<HTMLDivElement>(null);
  const insetKey = `${leftInset}:${rightInset}`;
  useCanvasInsetSync({
    insetKey,
    canvasWrapRef,
    containerRef,
    onRegionResizeFrameRef,
  });
  // Rendered region widths, for hit-testing during drags: drop zones and
  // their hints must align to what's on screen, not to the MODEL regionWidth
  // (which excludes the strips and preserves widths through minimization).
  reservedWidthRef.current = { left: leftInset, right: rightInset };

  // Read the live canvas bounds + measured float heights, for repositioning
  // floats when the canvas changes. (User floats are pushed out of a growing
  // region's path in the region-resize handler; server-anchored floats are
  // re-resolved by reanchorFloats below. Both use these bounds.)
  const readFloatBounds = React.useCallback(() => {
    const el = containerRef.current;
    if (el === null) return null;
    const rect = el.getBoundingClientRect();
    const heights = new Map<string, number>();
    el.querySelectorAll<HTMLElement>("[data-floating-window]").forEach(
      (winEl) => {
        const id = winEl.getAttribute("data-floating-window");
        if (id !== null) heights.set(id, winEl.offsetHeight);
      },
    );
    return {
      heights,
      bounds: {
        width: rect.width,
        height: rect.height,
        leftInset: reservedWidthRef.current.left,
        rightInset: reservedWidthRef.current.right,
      },
    };
  }, []);

  // Container/window resize: re-resolve SERVER-anchored floats against the new
  // bounds (so e.g. a top-right-anchored panel tracks the corner). User-placed
  // floats are left where the user put them.
  const reanchorFloats = React.useCallback(() => {
    // Bail before ANY DOM read when no float is server-anchored: this runs
    // per ResizeObserver tick during height resizes / content growth, and
    // readFloatBounds forces a layout (container rect + per-window
    // offsetHeight) that would otherwise be paid for nothing on the common
    // all-user-placed arrangement.
    if (layoutRef.current.floating.every((w) => w.anchor === undefined)) return;
    const m = readFloatBounds();
    if (m === null) return;
    patchFloatPositions((w) => {
      if (w.id === draggingWindowIdRef.current || w.anchor === undefined)
        return null;
      const winHeight = m.heights.get(w.id) ?? pinnedPxOf(w.height) ?? 0;
      return ops.resolveRequestedFloatPosition(
        w.anchor.x,
        w.anchor.y,
        w.width,
        winHeight,
        m.bounds,
      );
    });
  }, [readFloatBounds, patchFloatPositions]);

  // A DISCRETE inset change (dock / minimize / undock) that wasn't produced by a
  // region-resize drag: pull any UNANCHORED float whose horizontal span now
  // overhangs the docked chrome back fully onto the canvas, so its body -- and,
  // crucially, its resize handles -- can't sit over (and intercept the pointer
  // of) a docked region's strip. A region-resize DRAG is excluded: it moves
  // floats itself via pushFloatsAheadOfSeam (flush with the live seam), and
  // re-clamping mid-drag is exactly the float-yanking 4c3facf1 removed. Anchored
  // floats are handled by reanchorFloats; the dragged window is left alone.
  const clampUnanchoredFloatsToInsets = React.useCallback(() => {
    if (regionResizeDraggingRef.current) return;
    const m = readFloatBounds();
    if (m === null || m.bounds.width === 0) return;
    patchFloatPositions((w) => {
      if (w.id === draggingWindowIdRef.current || w.anchor !== undefined)
        return null;
      const maxX = Math.max(
        m.bounds.leftInset,
        m.bounds.width - m.bounds.rightInset - w.width,
      );
      return { x: clamp(w.x, m.bounds.leftInset, maxX), y: w.y };
    });
  }, [readFloatBounds, patchFloatPositions]);

  // Inset change (dock / minimize / undock): re-resolve SERVER-anchored floats
  // against the new bounds (so e.g. a top-right-anchored panel tracks the
  // corner) AND pull any unanchored float clear of the docked chrome -- but the
  // latter only for DISCRETE changes, never a region-resize drag (which moves
  // floats itself; see clampUnanchoredFloatsToInsets).
  React.useEffect(() => {
    reanchorFloats();
    clampUnanchoredFloatsToInsets();
  }, [leftInset, rightInset, reanchorFloats, clampUnanchoredFloatsToInsets]);

  // Container/window resize: re-resolve SERVER-anchored floats only. Unanchored
  // floats are edge-anchored + shrink-clamped by the container ResizeObserver
  // above; double-handling here would fight it.
  React.useEffect(() => {
    reanchorFloats();
  }, [containerWidth, containerHeight, reanchorFloats]);

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
    const observer = new ResizeObserver(() => {
      reanchorFloats();
      // Cached drag-target rects go stale when a window's rendered size
      // changes mid-drag (auto-height growth); see markTargetsStale.
      markDragTargetsStaleRef.current?.();
    });
    el.querySelectorAll("[data-floating-window]").forEach((winEl) =>
      observer.observe(winEl),
    );
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floatingWindowIds, reanchorFloats]);

  return (
    <DockContext.Provider value={contextValue}>
      <DockMetricsContext.Provider value={metrics}>
        <Box
          ref={containerRef}
          data-dock-root
          // While the canvas guard is actively scaling, ALL D34 motion is
          // suppressed (spec D34): the anim classes drop below, and the
          // column FLIP glide reads this attribute -- a railed strip beside
          // squeezing siblings shifts position per resize event, and arming
          // a fresh 160ms glide each event would rubber-band the resize.
          {...(squeezeActive ? { "data-dock-squeezing": "" } : {})}
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            overflow: "hidden",
          }}
        >
          {/* Center content, inset by docked regions. The inset ease
          (canvasInsetAnim) tracks the region containers' width ease, so a
          rail collapse/expand slides the canvas edge instead of snapping
          it; drags stay per-frame instant via [data-dock-resizing]. */}
          <Box
            ref={canvasWrapRef}
            className={squeezeActive ? undefined : canvasInsetAnim}
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
          {(["left", "right"] as DockEdge[]).map((edge) => {
            const { tree, resizable } = regions[edge];
            const drawnWidth = renderedWidth[edge];
            return (
              <React.Fragment key={edge}>
                {/* Canvas-facing shadow on a div BEHIND the panes (zIndex 1), so it
            only shows over the canvas, never on top of a panel. Carries the
            same D34 width ease as the region box so the shadow tracks it. */}
                {tree !== null && (
                  <Box
                    className={squeezeActive ? undefined : regionWidthAnim}
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      [edge]: 0,
                      width: drawnWidth,
                      zIndex: 1,
                      pointerEvents: "none",
                      boxShadow: "0 0 1em 0 rgba(0,0,0,0.1)",
                    }}
                  />
                )}
                {tree !== null && (
                  <Box
                    data-dock-region={edge}
                    // D34: rail collapse/expand eases the region container's
                    // width between committed values (presentation only; the
                    // canvas insets and drop math read the committed model).
                    className={squeezeActive ? undefined : regionWidthAnim}
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      [edge]: 0,
                      width: drawnWidth,
                      display: "flex",
                      flexDirection: "column",
                      backgroundColor: "var(--mantine-color-body)",
                      zIndex: 5,
                      // NO overflow:hidden here: the RegionResizer child
                      // straddles the container boundary by design (its
                      // outer grab strip lives over the canvas), and a
                      // clip would silently swallow its hit area. The
                      // drawer clip lives on the pane wrapper below.
                    }}
                  >
                    {/* Region PARENT handle (D26): the whole docked stack's
                handle -- one bar above everything it acts on. Pill drag
                floats the entire stack (the same gesture as the rail header
                it mirrors, P7); the region-collapse chevron sits at the
                right end, where the rail's + sits (P13), and a motionless
                bar click is its backing surface (P9). Cell chrome rows act
                on CELLS; this bar acts on the STACK (P12) -- the chevron
                previously sat on the top-right cell's row, reading as that
                panel's control while acting on the whole region. Not
                rendered while the region is COLLAPSED (the rail has its own
                parent handle -- the narrow header this bar mirrors; a second
                chevron above it would duplicate the signifier), and not
                rendered for a MULTI-COLUMN region (D27): there the handle
                would span two independent visual columns while its drag
                flattened them into one stack -- each column carries its own
                handle instead (SplitView), and no region-level collapse is
                offered because the rail is a single packed strip that would
                flatten columns the same way. */}
                    {!isRegionPackedOn(layoutRef.current, edge) &&
                      tree.columns.length === 1 && (
                        <StackHandleBar
                          attrs={{ "data-dock-region-handle": edge }}
                          onPointerDown={(event) =>
                            stableGestures.startRegionDrag(event, edge, {
                              onClick: () => {
                                collapseRegion(edge);
                                // POINTER-path focus handoff (spec 4: focus
                                // never falls to <body>): since T6 made the
                                // chevron drag-through, a real click routes
                                // through THIS backing, not the chevron's
                                // onActivate -- mirror its handoff to the
                                // rail header's same-spot + toggle.
                                focusDockControl(
                                  `[data-dock-region="${edge}"] [data-dock-minimize-all]`,
                                );
                              },
                            })
                          }
                          endControl={
                            <RegionCollapseChevron
                              edge={edge}
                              onActivate={() => collapseRegion(edge)}
                            />
                          }
                        />
                      )}
                    <Box
                      style={{
                        flexGrow: 1,
                        minHeight: 0,
                        display: "flex",
                        // Anchor the fixed-width pane to the OUTER screen
                        // edge: during the container's width ease every
                        // column keeps its screen position, and the only
                        // motion is the inner boundary sliding over the
                        // canvas (the user-adjudicated drawer look). The
                        // drawer clip lives HERE (not on the region
                        // container, whose resizer straddles the edge).
                        justifyContent:
                          edge === "right" ? "flex-end" : "flex-start",
                        overflow: "hidden",
                      }}
                    >
                      <SplitView
                        region={tree}
                        edge={edge}
                        drawnWidthPx={renderedWidth[edge]}
                      />
                    </Box>
                    {resizable && (
                      <RegionResizer
                        edge={edge}
                        // Model-based (unscaled) start: see regionFor's
                        // reservedWidth doc.
                        getStart={() => regions[edge].reservedWidth}
                        // Called once per drag; snapshots the drag-start
                        // widths and returns the per-frame + end handlers
                        // (see makeRegionResizeHandlers).
                        makeOnResize={() =>
                          makeRegionResizeHandlers(edge, {
                            layoutRef,
                            containerRef,
                            containerWidthRef,
                            containerHeightRef,
                            reservedWidthRef,
                            regionResizeDraggingRef,
                            draggingWindowIdRef,
                            onCommitRef,
                            onRegionResizeFrameRef,
                            applyOp,
                            runProgrammatic,
                          })
                        }
                      />
                    )}
                  </Box>
                )}
              </React.Fragment>
            );
          })}

          {/* Floating windows. The `floating` array order is the front-order
        (last = topmost), but we render in a STABLE order (by id) and drive
        stacking with z-index. That way raising a window (bringToFront reorders
        the array) only changes z-index -- it never moves the DOM node, which
        would otherwise eat an in-flight click on e.g. the minimize button. */}
          {layout.floating
            .map((win, frontOrder) => ({ win, frontOrder }))
            .sort((a, b) =>
              a.win.id < b.win.id ? -1 : a.win.id > b.win.id ? 1 : 0,
            )
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

          {/* Drop hint: a persistent element positioned imperatively by the
        drag controller (via dropHint.ts). Its style prop is a module
        constant, so React's style diff never touches the imperative
        mutations across re-renders. */}
          <div ref={hintRef} style={HINT_BASE_STYLE} />
        </Box>
      </DockMetricsContext.Provider>
    </DockContext.Provider>
  );
}
