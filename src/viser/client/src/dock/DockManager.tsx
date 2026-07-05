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
  bumpFreshIdFloor,
  grabbingCursor,
  motionExceedsThreshold,
  suppressTextSelection,
  tryCapture,
  tryRelease,
} from "./gestures";
import * as ops from "./layoutOps";
import { RegionResizer } from "./RegionResizer";
import { RegionCollapseChevron, StackHandleBar } from "./handles";
import { plannedReservedWidth, planRegion } from "./regionPlan";
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
  HANDLE_BTN_EM,
  assertNever,
  clamp,
  DockEdge,
  DockLayout,
  FloatingWindow,
  GroupId,
  isRegionCollapsedOn,
  MIN_CANVAS_PX,
  MIN_REGION_GRAB_PX,
  MINIMIZED_STRIP_PX,
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

/** As a docked region's edge sweeps inward during a resize (reserved width
 * `oldReserved` -> `newReserved`), push floats it sweeps PAST so they stay fully
 * on the canvas. The decision is purely local to this drag frame -- the seam's
 * before/after position -- no accumulated history:
 *   - The seam moved from `oldSeam` to `newSeam` (toward the canvas when growing).
 *   - A float whose canvas-facing edge was clear of `oldSeam` (fully on the
 *     canvas) but would be past `newSeam` (covered) is pushed flush to `newSeam`,
 *     keeping it fully on the canvas.
 *   - A float already past `oldSeam` (overlapping before this frame) is left
 *     alone -- the region just slides over it.
 *   - A receding seam (region shrinking) sweeps past nothing, so pushes nothing.
 *   - We never push a float's far edge off the opposite side of the canvas.
 * Returns the same layout reference when nothing moved. */
function pushFloatsAheadOfSeam(
  layout: DockLayout,
  edge: DockEdge,
  containerWidth: number,
  oldReserved: number,
  newReserved: number,
  draggingId: WindowId | null,
): DockLayout {
  if (newReserved <= oldReserved) return layout; // shrinking: sweeps past nothing
  let changed = false;
  const floating = layout.floating.map((w) => {
    if (w.id === draggingId) return w;
    let x = w.x;
    if (edge === "right") {
      const oldSeam = containerWidth - oldReserved;
      const newSeam = containerWidth - newReserved;
      // Was fully on the canvas (right edge clear of old seam) and the new seam
      // now covers that edge: push left to sit flush, but not off the left side.
      if (w.x + w.width <= oldSeam && w.x + w.width > newSeam)
        x = Math.max(0, newSeam - w.width);
    } else {
      const oldSeam = oldReserved;
      const newSeam = newReserved;
      // Was fully on the canvas (left edge clear of old seam) and the new seam
      // now covers it: push right to sit flush, but not off the right side.
      if (w.x >= oldSeam && w.x < newSeam)
        x = Math.min(newSeam, containerWidth - w.width);
    }
    if (x === w.x) return w;
    changed = true;
    return { ...w, x };
  });
  if (!changed) return layout;
  // Full clone, not `{ ...layout, floating }`: the result flows into applyOp
  // (via the region-resize frame), whose normalize/reconcile steps mutate
  // their input -- a shallow copy would alias groups/docked with the COMMITTED
  // layout and let those steps corrupt it.
  const next = ops.cloneLayout(layout);
  next.floating = floating;
  return next;
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

/** Validate a data-dock-edge attribute into the DockEdge union. A raw
 * `getAttribute(...) as DockEdge` would let a markup typo flow into
 * `layout.docked[edge]` as undefined and silently no-op every drop. */
const parseDockEdge = (raw: string | null): DockEdge | null =>
  raw === "left" || raw === "right" ? raw : null;

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
  const [layout, setLayout] = React.useState(initialLayout);
  const layoutRef = React.useRef(layout);
  layoutRef.current = layout;
  // Structure signature of the CURRENT committed layout (layoutRef.current),
  // cached so applyOp hashes only the INCOMING layout per commit instead of
  // both sides. `null` means "recompute lazily" -- the initial value, and what
  // the one commit path that bypasses applyOp with a possibly-different
  // structure (the drag Escape-restore) resets it to. patchFloatPositions is
  // position-only by construction, so it never invalidates the cache.
  const structureSigRef = React.useRef<string | null>(null);
  // Seed the fresh-id counter past any ids the initial layout brought with it
  // (a restored/persisted layout): the counter restarts at 0 each session, so
  // without this a new `node-3` would collide with a restored `node-3`
  // (duplicate-id invariant violation / groups-map clobber). useState's
  // initializer runs exactly once per mount.
  React.useState(() => bumpFreshIdFloor(ops.allLayoutIds(initialLayout)));
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
      left:
        layout.docked.left !== null ? planRegion(layout.docked.left) : null,
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
        invariantWarnBudget.current > 0 &&
        now - lastProdCheckMs.current >= 250;
      if (check) lastProdCheckMs.current = now;
    }
    if (check) {
      const violations = [
        ...invariantViolations(next),
        // Canonical band form (P14): applyOp normalizes structural commits,
        // so a violating commit means an op or a bypass produced a
        // non-canonical shape.
        ...ops.canonicalViolations(next),
      ];
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
    onCommitRef.current?.(prev, next, programmaticDepth.current > 0);
  }, []);

  const applyOp = React.useCallback(
    (next: DockLayout) => {
      if (next === layoutRef.current) return; // no-op op: nothing to commit.
      // Canonical band form (P14/D12/D13) on STRUCTURAL commits only: a pure
      // weight change (a resize mid-gesture) must never restructure the
      // layout under the user's pointer. The current layout's signature is
      // cached (structureSigRef), so only the incoming layout is hashed here.
      const nextSig = ops.structureSignature(next);
      const curSig =
        structureSigRef.current ?? ops.structureSignature(layoutRef.current);
      if (nextSig !== curSig) {
        ops.normalizeCanonicalBandsInPlace(next);
        // Canonicalization can restructure, so re-derive the committed
        // layout's signature rather than storing the pre-normalize one.
        structureSigRef.current = ops.structureSignature(next);
      } else {
        structureSigRef.current = nextSig;
      }
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
          bumpFreshIdFloor(ops.allLayoutIds(layout));
          applyOp(layout);
        }),
      addPaneToArea: (areaId: string, paneId: PaneId, index?: number) =>
        runProgrammatic(() =>
          applyOp(ops.addPaneToArea(layoutRef.current, areaId, paneId, index)),
        ),
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

  const containerRect = () =>
    containerRef.current?.getBoundingClientRect() ?? new DOMRect();

  // Container height, for capping floating panes' scrolling bodies (matches
  // the original FloatingPanel, which capped its body to the parent height).
  const [containerHeight, setContainerHeight] = React.useState(0);
  // Container width, exposed via metrics so float coords (incl. negative
  // gap-from-right) can be resolved against the live canvas.
  const [containerWidth, setContainerWidth] = React.useState(0);
  // Ref mirror so the region-resize drag closure reads the CURRENT container
  // width synchronously (it computes the canvas's new width from this minus the
  // freshly-committed insets). Height isn't mirrored: a width drag never changes
  // it, so the closure's captured `containerHeight` stays valid.
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

  // --- Drop-target hit testing -------------------------------------------
  //
  // THE data-attribute contract between the renderers and this scanner. The
  // attributes are a stringly, multi-file protocol -- two past bugs came from
  // a renderer and this scanner disagreeing about it -- so the rules live HERE,
  // next to the only reader:
  //
  //   data-dock-leaf=<nodeId> + data-dock-edge=<left|right>
  //     A docked drop target. The LEAF wrapper's rect IS the drop rect (the
  //     rail sizes the wrapper to the droppable surface; the group element
  //     inside may be a compact rail cell). Rendered by SplitView's
  //     DockLeafView and VerticalMinimizedColumn's rail cells (docked).
  //   data-dock-group=<groupId>
  //     The group's element: the leaf wrapper itself OR any descendant (both
  //     accepted). Scopes the strip/tab lookup; carries
  //     data-dock-collapsed="true" when minimized. Also rendered inside
  //     floating windows (scanned per-window, snap index from the MODEL stack)
  //     and areas (TabGroupFrame).
  //   data-dock-strip=<groupId> / data-dock-tab=<paneId>
  //     The tab strip and its tabs, DESCENDANTS of their group element; a tab
  //     whose nearest [data-dock-group] ancestor isn't the scanned group is
  //     skipped (nested areas don't leak tabs into the host).
  //   data-floating-window=<windowId>
  //     A floating window's root.
  //   data-dock-area=<areaId>
  //     A nested area's wrapper; its rect is the drop rect (inset via
  //     hitRect), its group comes from the LAYOUT (an empty area renders no
  //     group element but is still a target).
  //   data-dock-column / data-dock-header / data-dock-minimize /
  //   data-dock-griphandle
  //     Gesture/measurement hooks only; never drop targets.

  const collectTargets = (draggedWindowId: WindowId): DropTargets => {
    const container = containerRef.current;
    const targets: DropTargets = { groups: [] };
    if (container === null) return targets;

    // Collect the strip + tabs that belong to ONE group, scoped so a nested
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
      const tabs: { paneId: PaneId; rect: DOMRect }[] = [];
      scopeEl.querySelectorAll("[data-dock-tab]").forEach((t) => {
        // Skip tabs that belong to a nested group (their nearest group ancestor
        // isn't ours).
        if (t.closest("[data-dock-group]") !== scopeEl) return;
        // Skip overflow-hidden bar labels (visibility:hidden behind the +N
        // badge): an invisible element must not be an insertion target (P1).
        if (getComputedStyle(t).visibility === "hidden") return;
        const paneId = t.getAttribute("data-dock-tab");
        if (paneId !== null) tabs.push({ paneId, rect: t.getBoundingClientRect() });
      });
      return {
        groupId,
        rect: rectEl.getBoundingClientRect(),
        stripRect: stripEl?.getBoundingClientRect() ?? null,
        tabs,
        ctx,
        // Effectively-collapsed cells (own flag OR region rail, D21) need the
        // rotated collapsed-target zones -- see isGroupEffectivelyCollapsed.
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

    // Nested dockable areas, collected up front and keyed by HOST window
    // (null = hosted in a docked panel). Each area is pushed right AFTER its
    // host's group targets, so it beats its host (the area is visually inside
    // it) but NOT a different floating window stacked above the host --
    // targets stay strictly back-to-front (3.5). The area's group id comes
    // from the layout (not the DOM), so an EMPTY area -- which renders no
    // inner group/strip -- is still a valid drop target sized to its wrapper.
    const areasByHost = new Map<string | null, GroupTarget[]>();
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
      // below; areas are found by a container-wide scan, so filter here too.
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
      // Apply an inset only when the remaining band stays usefully large;
      // otherwise skip that inset entirely. Flooring the SIZE instead (the old
      // form) let the hit rect exceed the area's real rect for areas shorter/
      // narrower than the floor (24-40px), creating a phantom hit zone
      // OUTSIDE the visible area.
      const mxRaw = Math.min(AREA_HIT_INSET_PX, r.width * 0.28);
      const mbRaw = Math.min(AREA_HIT_INSET_PX, r.height * 0.28);
      const mx = r.width - 2 * mxRaw >= AREA_HIT_INSET_PX ? mxRaw : 0;
      const mb = r.height - mbRaw >= AREA_HIT_INSET_PX ? mbRaw : 0;
      t.hitRect = new DOMRect(r.left + mx, r.top, r.width - 2 * mx, r.height - mb);
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
      // The LEAF wrapper's box is the drop target: both minimized renderers
      // size the wrapper to the full droppable surface while the group element
      // inside may be a compact rail cell. The group element still scopes the
      // strip/tab lookup.
      const g = readGroup(groupEl, { kind: "docked", nodeId, edge }, leaf);
      if (g === null) return;
      // Clip to the column's scroll box: with overflowY auto a squeezed,
      // scrolled column reports leaf rects extending into neighboring bands,
      // and hitTest's last-match rule would pick the INVISIBLE scrolled-out
      // leaf over the visible one under the pointer (P1).
      const scrollEl = leaf.closest("[data-dock-scroll]");
      if (scrollEl !== null) {
        const sr = scrollEl.getBoundingClientRect();
        const top = Math.max(g.rect.top, sr.top);
        const bottom = Math.min(g.rect.bottom, sr.bottom);
        if (bottom - top < 8) return; // fully scrolled out: not a target
        const clipped = new DOMRect(
          g.rect.left,
          top,
          g.rect.width,
          bottom - top,
        );
        g.rect = clipped;
        g.hitRect = clipped;
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
      (targets.windows ??= []).push({
        windowId: win.id,
        rect: winEl.getBoundingClientRect(),
      });
      winEl.querySelectorAll("[data-dock-group]").forEach((groupEl) => {
        const gid = groupEl.getAttribute("data-dock-group");
        if (gid === null) return;
        // Snap index comes from the MODEL, not DOM enumeration: a nested
        // DockArea inside a panel's body also renders a [data-dock-group],
        // which would shift DOM-order indices past it (snap above/below then
        // lands at the wrong stack position). Groups not in the stack are
        // skipped here -- the area scan below collects them with area context.
        const index = win.stack.indexOf(gid);
        if (index === -1) return;
        // The group element's own rect is the drop rect -- a minimized cell's
        // element IS its full-width bar (D17), no wrapper needed.
        const g = readGroup(groupEl, {
          kind: "floating",
          windowId: win.id,
          index,
        });
        if (g !== null) {
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
    // A MINIMIZED cell has no content half to vacate: the "shrink to 50% + tint
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
    // Rects can also move WITHOUT a layout change: a scroll inside the
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
    // gate on the GEOMETRY properties collapseAnim eases: HandleIconButton's
    // color/background transitions end on every hover and would otherwise
    // spuriously invalidate the cache.
    const onTransitionEnd = (e: TransitionEvent) => {
      if (
        e.propertyName === "flex-grow" ||
        e.propertyName === "flex-basis" ||
        e.propertyName === "min-height"
      )
        markTargetsStale();
    };
    container.addEventListener("transitionend", onTransitionEnd, true);
    // A floating window can also RESIZE mid-drag with no layout change (an
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

    const apply = () => {
      raf = null;
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
        container.removeEventListener("scroll", markTargetsStale, true);
        window.removeEventListener("resize", markTargetsStale);
        container.removeEventListener("transitionend", onTransitionEnd, true);
        markDragTargetsStaleRef.current = null;
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
          // including region widths, which the snapshot carries. Restore via
          // commit (NOT applyOp): the snapshot already carries valid widths, so
          // "put the pre-drag layout back" restores geometry by construction --
          // the reconciler's content-matching would treat restored columns as
          // new and reset them to defaults. Bypassing applyOp also bypasses
          // the structure-signature cache, so invalidate it (recomputed
          // lazily on the next applyOp).
          if (restoreOnCancel !== undefined) {
            structureSigRef.current = null;
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
        // travel AS-IS (D16): dropping an expanded stack beside minimized
        // neighbors never infects it -- collapse changes only by user gesture
        // or server command.
        if (result.kind === "edge") {
          applyOp(ops.dockToEdge(base, stack, result.edge));
        } else if (result.kind === "regionEdge") {
          applyOp(ops.dockToRegionEdge(base, stack, result.edge, result.side));
        } else if (result.kind === "bandInsert") {
          applyOp(ops.dockBandAtIndex(base, stack, result.edge, result.index));
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
          // Merge into the target as-is: a MINIMIZED target stays minimized
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
          // Exhaustive: adding a DropResult kind is a compile error HERE (at
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

  // Width to float a docked item at. A MINIMIZED docked group/column renders as
  // a ~strip-narrow cell, so its measured rect width is a useless panel width;
  // float at the item's preserved EXPANDED width instead so it isn't
  // strip-narrow after expanding. That preserved width is:
  // - the COLUMN's own weight in a multi-column region (weights are pixels
  //   there, and every column -- minimized or not -- carries its width, D20);
  // - regionWidth for a lone column (its px always lives there).
  // Expanded items keep their measured width. Shared by startGroupDrag (single
  // tear-out) and startTabTearOut so neither re-introduces the bug. `groupId`
  // locates the item's column.
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
    const cols = ops.widthColumns(tree);
    const col = cols.find((c) => ops.collectLeafGroups(c).includes(groupId));
    // Trust the column weight only when the reconciler actually wrote px into
    // it (any real width clears the grab-min; an unreconciled weight is a bare
    // flex share like 1).
    if (
      cols.length > 1 &&
      col !== undefined &&
      col.weight >= ops.minRegionWidth()
    )
      return col.weight;
    return rw;
  };

  // Float width for tearing `groupId` (or one of its tabs) out of wherever it
  // lives: a docked group that is EFFECTIVELY collapsed (own minimize OR the
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

  // --- Context callbacks -------------------------------------------------

  const startWindowDrag: DockContextValue["startWindowDrag"] = (
    event,
    windowId,
    opts,
  ) => {
    if (layoutRef.current.floating.every((w) => w.id !== windowId)) return;
    // Press-time POINTER coordinates, but the window's CURRENT model position
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
        beginWindowDrag(
          windowId,
          null,
          e.pointerId,
          e.pointerType,
          grabX,
          grabY,
        );
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
            // Dragging a minimized panel moves it AS-IS (still minimized);
            // expanding is a click-only gesture. So no expand-on-drag here.
            beginWindowDrag(
              windowId,
              null,
              e.pointerId,
              e.pointerType,
              grabX,
              grabY,
            );
          },
          onClick,
        );
        return;
      }
    }
    armPress(event, (e) => {
      dragAfterCommit(e, () => {
        const rect = floatRectFor(`[data-dock-group="${groupId}"]`);
        // Effectively-collapsed docked cells float at their preserved
        // expanded width (see dockedFloatWidthForGroup).
        const floatWidth = dockedFloatWidthForGroup(groupId, rect.width);
        const wasRailedCell = ops.isRailedDockedCell(
          layoutRef.current,
          groupId,
        );
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
        // A cell dragged out of a railed region floats STILL minimized: only
        // its region's flag was set, so stamp the group's own flag (P2 --
        // the user was dragging a minimized bar, not a full panel).
        if (wasRailedCell) ops.stampCollapsedInPlace(res.layout, [groupId]);
        // applyOp reconciles region widths: undocking this column removes it
        // from the region's column set, so siblings keep their widths and the
        // region shrinks by the removed column's width. A minimized panel
        // floats out STILL minimized (it renders as a one-cell strip window) --
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
    }, onClick);
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
          // A RAILED column measures strip-narrow; float it at its preserved
          // expanded width instead (same policy as dockedFloatWidth: trust
          // the weight only when the reconciler wrote pixels into it).
          const floatWidth =
            wasRailed && column !== null && column.weight >= ops.minRegionWidth()
              ? column.weight
              : rect.width;
          const res = ops.floatColumn(
            layoutRef.current,
            edge,
            columnId,
            rect.x,
            rect.y,
            floatWidth,
          );
          if (res.windowId === null) return null;
          // Dragging a railed column out keeps its minimized look: the new
          // window's cells render as bars (P2), mirroring the region-rail
          // drag stamp -- the cells' own flags are usually false (the rail
          // is a view over the model).
          if (wasRailed) {
            const win = res.layout.floating.find((w) => w.id === res.windowId);
            if (win !== undefined)
              ops.stampCollapsedInPlace(res.layout, [...win.stack]);
          }
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
          const wasRailed = isRegionCollapsedOn(layoutRef.current, edge);
          const res = ops.floatRegion(
            layoutRef.current,
            edge,
            rect.x,
            rect.y,
            regionWidthsOf(layoutRef.current)[edge],
          );
          if (res.windowId === null) return null;
          // Dragging the RAIL out keeps its minimized look: the new window's
          // cells render as bars (P2), with the header's expand-all one click
          // away. Without this an all-expanded region would pop full-size.
          if (wasRailed) {
            const win = res.layout.floating.find((w) => w.id === res.windowId);
            if (win !== undefined)
              ops.stampCollapsedInPlace(res.layout, [...win.stack]);
          }
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
      const index = lastInsert;
      flushSync(() =>
        applyOp(ops.reorderTab(layoutRef.current, groupId, paneId, index)),
      );
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
        const wasRailedCell = ops.isRailedDockedCell(
          layoutRef.current,
          groupId,
        );
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
        // A tab torn out of a railed region floats STILL minimized (P2): the
        // source group's own flag may be false (region-flag collapse), so
        // stamp the torn group directly -- same guard as startTabTearOut.
        if (wasRailedCell && res.floatingGroupId !== null)
          ops.stampCollapsedInPlace(res.layout, [res.floatingGroupId]);
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

  // Tear ONE pane out of a minimized docked stack. The minimized strip shows
  // each tab as a row; dragging a row should float JUST that pane (leaving the
  // rest of the stack docked), while a motionless click expands the group to
  // that tab. Mirrors the docked tear path of startGroupDrag (armPress ->
  // dragAfterCommit, with the new window floated at the region's preserved
  // EXPANDED width so the result isn't a strip-narrow stub), but tears a single
  // pane via tearOutPane instead of floating the whole group. No reorder phase:
  // a vertical strip's rows aren't a horizontal reorder surface.
  const startTabTearOut: DockContextValue["startTabTearOut"] = (
    event,
    groupId,
    paneId,
  ) => {
    armPress(
      event,
      (e) => {
        dragAfterCommit(e, () => {
          const rect = floatRectFor(`[data-dock-group="${groupId}"]`);
          // Effectively-collapsed docked cells float at their preserved
          // expanded width (see dockedFloatWidthForGroup).
          const floatWidth = dockedFloatWidthForGroup(groupId, rect.width);
          const wasRailedCell = ops.isRailedDockedCell(
            layoutRef.current,
            groupId,
          );
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
          // A spine row torn out of the rail stays minimized (spec 4): the
          // source group's own flag may be false (region-flag collapse), so
          // stamp the torn group directly.
          if (wasRailedCell && res.floatingGroupId !== null)
            ops.stampCollapsedInPlace(res.layout, [res.floatingGroupId]);
          const newWindowId = res.windowId;
          // The torn pane floats AS-IS: a pane torn from a minimized strip stays
          // minimized (tearOutPane copies the source's collapsed flag). Dragging
          // never expands -- only the no-motion click below (expandToTab) does.
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
      () => expandToTab(groupId, paneId),
    );
  };

  // The gesture starters above are recreated each render (they close over
  // fresh props); expose STABLE wrappers so the memoized context value below
  // doesn't churn identity on every render.
  const gestureImpls = {
    startGroupDrag,
    startTabDrag,
    startTabTearOut,
    startWindowDrag,
    startRegionDrag,
  };
  const gestureRef = React.useRef(gestureImpls);
  gestureRef.current = gestureImpls;
  const stableGestures = React.useMemo(
    () =>
      ({
        startGroupDrag: (...args) =>
          gestureRef.current.startGroupDrag(...args),
        startTabDrag: (...args) => gestureRef.current.startTabDrag(...args),
        startTabTearOut: (...args) =>
          gestureRef.current.startTabTearOut(...args),
        startWindowDrag: (...args) =>
          gestureRef.current.startWindowDrag(...args),
        startRegionDrag: (...args) =>
          gestureRef.current.startRegionDrag(...args),
      }) satisfies Pick<
        DockContextValue,
        | "startGroupDrag"
        | "startTabDrag"
        | "startTabTearOut"
        | "startWindowDrag"
        | "startRegionDrag"
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
  const collapseRegion = React.useCallback(
    (edge: DockEdge, on: boolean) => {
      applyOp(ops.setRegionCollapsed(layoutRef.current, edge, on));
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
      // Per-CELL minimize everywhere (D16): any group toggles itself, whether
      // lone or in a 2+ stack. Bulk minimize/expand survives only as the
      // multi-group window header's toggle-all and the region rail.
      applyOp(ops.toggleCollapsed(layoutRef.current, groupId));
    },
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
      ...stableGestures,
      activateTab,
      expandToTab,
      toggleCollapsed,
      collapseRegion,
      railColumn,
      startColumnDrag,
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
      toggleCollapsed,
      collapseRegion,
      railColumn,
      startColumnDrag,
      draggingGroupId,
      draggingTabId,
    ],
  );
  const metrics: DockMetrics = React.useMemo(
    () => ({
      reservedWidth: {
        left:
          plans.left !== null
            ? plannedReservedWidth(
                plans.left,
                regionWidth.left,
                isRegionCollapsedOn(layout, "left"),
              )
            : 0,
        right:
          plans.right !== null
            ? plannedReservedWidth(
                plans.right,
                regionWidth.right,
                isRegionCollapsedOn(layout, "right"),
              )
            : 0,
      },
      containerWidth,
      containerHeight,
    }),
    [regionWidth, plans, layout, containerWidth, containerHeight],
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

  // Each docked region renders its FULL tree; a minimized cell is its 26px
  // bar in place (D20), so region width never depends on collapse states.
  // The one exception is the EXPLICIT region collapse (D21): the whole
  // region draws as the 36px rail while its model widths are preserved.
  const regionFor = (edge: DockEdge) => {
    const tree = layout.docked[edge];
    const plan = plans[edge];
    if (tree === null || plan === null)
      return {
        tree,
        reservedWidth: 0,
        resizable: false,
      };
    const collapsed = isRegionCollapsedOn(layout, edge);
    return {
      tree,
      // The rail is fixed-width chrome: nothing to resize while collapsed --
      // and likewise when every width-determining COLUMN is railed (each is
      // a fixed 36px strip).
      resizable: !collapsed && plan.columns.some((c) => c.railed !== true),
      // MODEL-based reserved width. The resizer's drag baseline reads THIS,
      // never the post-scaling rendered width below -- otherwise grabbing the
      // handle under the MIN_CANVAS_PX render-scale guard (or pressing
      // Escape, which re-commits the start width) would bake the
      // temporarily-scaled width into the model and break "widths restore
      // when the viewport grows".
      reservedWidth: plannedReservedWidth(plan, regionWidth[edge], collapsed),
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
  const renderedWidth: Record<DockEdge, number> = {
    left: regions.left.reservedWidth,
    right: regions.right.reservedWidth,
  };
  if (containerWidth > 0) {
    const available = containerWidth - MIN_CANVAS_PX;
    const total = renderedWidth.left + renderedWidth.right;
    if (total > available && total > 0) {
      const scale = Math.max(0, available) / total;
      renderedWidth.left = Math.floor(renderedWidth.left * scale);
      renderedWidth.right = Math.floor(renderedWidth.right * scale);
    }
  }
  const leftInset = renderedWidth.left;
  const rightInset = renderedWidth.right;
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
        {(["left", "right"] as DockEdge[]).map((edge) => {
          const { tree, resizable } = regions[edge];
          const drawnWidth = renderedWidth[edge];
          return (
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
                {!isRegionCollapsedOn(layoutRef.current, edge) &&
                  tree.rows.every((rw) => rw.columns.length === 1) && (
                <StackHandleBar
                  attrs={{ "data-dock-region-handle": edge }}
                  onPointerDown={(event) =>
                    startRegionDrag(event, edge, {
                      onClick: () => collapseRegion(edge, true),
                    })
                  }
                  endControl={
                    <RegionCollapseChevron
                      edge={edge}
                      onActivate={() => collapseRegion(edge, true)}
                      placement={{
                        position: "absolute",
                        right: 0,
                        top: 0,
                        width: `${HANDLE_BTN_EM}em`,
                        height: "100%",
                      }}
                    />
                  }
                />
                )}
                <Box style={{ flexGrow: 1, minHeight: 0, display: "flex" }}>
                  <SplitView region={tree} edge={edge} />
                </Box>
                {resizable && (
                <RegionResizer
                  edge={edge}
                  // Model-based (unscaled) start: see regionFor's
                  // reservedWidth doc.
                  getStart={() => regions[edge].reservedWidth}
                  // Called once per drag: snapshots the columns' start widths
                  // and limits (and the drag-start layout, which serves the
                  // end-commit), and returns the per-frame + end handlers.
                  // Widths are redistributed across ALL columns from their
                  // drag-start proportions, clamping each to its own min/max
                  // and handing the difference to columns that still have
                  // room -- so the region keeps resizing while any column can
                  // give or take.
                  makeOnResize={() => {
                    const layout0 = layoutRef.current;
                    const onEnd = (cancelled: boolean) => {
                      // Skip on cancel (Escape restored the start widths) and
                      // on a click without motion (no frame committed, layout
                      // unchanged). Otherwise fire ONE user-attributed commit
                      // spanning the whole drag: layout state is already
                      // final, this only informs the host's ownership diff.
                      if (cancelled || layout0 === layoutRef.current) return;
                      onCommitRef.current?.(layout0, layoutRef.current, false);
                    };
                    const tree0 = layout0.docked[edge];
                    if (tree0 === null) return { onFrame: () => {}, onEnd };
                    // Every EXPANDED width-determining column participates
                    // (D20: minimized cells are in-place bars holding their
                    // column's width). RAILED columns are excluded from the
                    // redistribution: they render at the fixed strip width
                    // and their weights are preserved for restore (P8), so
                    // their strip px rides with the divider chrome as fixed
                    // width instead. The plan is the same classification the
                    // render uses.
                    const plan = planRegion(tree0);
                    const cols = plan.columns.filter((c) => c.railed !== true);
                    const railedCols = plan.columns.filter(
                      (c) => c.railed === true,
                    );
                    const fixedPx =
                      plan.chromePx +
                      railedCols.length * MINIMIZED_STRIP_PX;
                    const railedWeightPx = railedCols.reduce(
                      (s, c) => s + c.weight,
                      0,
                    );
                    const startRegion = regionWidthsOf(layoutRef.current)[
                      edge
                    ];
                    // Weights are pixels for side-by-side columns (the
                    // reconciler wrote them); a single surfaced column's px
                    // is the regionWidth itself (its weight may be a height).
                    const init = plan.singleColumn
                      ? [startRegion]
                      : cols.map((c) => c.weight);
                    const mins = cols.map(() => ops.minRegionWidth());
                    // No per-column max: a region drag is bounded only by its
                    // columns' grab-mins (and the render-time canvas guard), not
                    // a fixed per-panel width -- matching the width reconciler
                    // and SplitView divider drags.
                    const maxs = cols.map(() => Infinity);
                    const ids = cols.map((c) => c.id);
                    const onFrame = (reservedPx: number) => {
                      // The grip reports the desired RESERVED width, which
                      // includes the fixed chrome (dividers + railed
                      // strips); subtract it to get the expanded columns'
                      // share.
                      let next = layoutRef.current;
                      const widths = ops.resizeRegionColumns(
                        init,
                        mins,
                        maxs,
                        reservedPx - fixedPx,
                      );
                      const expandedTotal = widths.reduce((a, b) => a + b, 0);
                      // Model regionWidth stays the ALL-EXPANDED sum: the
                      // railed columns' preserved pixel weights ride along
                      // untouched so expanding them restores their widths.
                      const total = expandedTotal + railedWeightPx;
                      // Only rewrite weights for genuinely side-by-side
                      // columns; a single surfaced column may be a vertical
                      // child whose weight is a HEIGHT (see applyOp). The
                      // total goes through the setRegionWidth op so the
                      // model stays the single source of truth for the
                      // width.
                      if (!plan.singleColumn) {
                        const byId: Record<string, number> = {};
                        ids.forEach((id, i) => {
                          byId[id] = widths[i];
                        });
                        next = ops.setNodeWeights(next, edge, byId);
                      }
                      // Push floats out of the way of THIS region's edge as it
                      // sweeps inward, using the before/after seam of this very
                      // drag frame -- no history needed. A float that was fully
                      // on the canvas (its edge clear of the OLD seam) and would
                      // now be covered (past the NEW seam) is pushed flush, so it
                      // stays fully on the canvas; one already overlapping (edge
                      // past the old seam) is left alone, and a receding seam
                      // pushes nothing.
                      next = pushFloatsAheadOfSeam(
                        next,
                        edge,
                        containerWidthRef.current,
                        reservedWidthRef.current[edge], // old reserved (pre-commit)
                        // New reserved: expanded cols + fixed chrome
                        // (dividers + railed strips).
                        expandedTotal + fixedPx,
                        draggingWindowIdRef.current,
                      );
                      // Flush the width commit so this render updates
                      // reservedWidthRef (the canvas wrapper's new insets) before
                      // we tell the host the canvas's new size. Mark the commit as
                      // drag-originated so the inset effect (which fires inside
                      // this flushSync) doesn't ALSO re-clamp unanchored floats --
                      // the drag already moved them flush with the seam.
                      regionResizeDraggingRef.current = true;
                      try {
                        // Per-frame commits stay PROGRAMMATIC even though the
                        // dirty-bit does track region width: running the
                        // user-gesture commit handler ~60x/s is wasted work,
                        // and an Escape-cancel must leave no user-attributed
                        // trace. The single user commit spanning the whole
                        // drag fires at release instead (see onEnd above).
                        flushSync(() =>
                          runProgrammatic(() =>
                            applyOp(ops.setRegionWidth(next, edge, total)),
                          ),
                        );
                      } finally {
                        regionResizeDraggingRef.current = false;
                      }
                      // Hand the host (the 3D canvas) the AUTHORITATIVE new
                      // canvas size we just produced -- containerWidth minus the
                      // freshly-committed insets -- so it resizes the GL
                      // backbuffer on THIS tick. We must NOT let the host read
                      // canvas.clientWidth instead: the new inset isn't reliably
                      // reflowed yet mid-drag, so a re-measure lags and the scene
                      // trails the divider (and only snaps on release).
                      const reserved = reservedWidthRef.current;
                      onRegionResizeFrameRef.current?.(
                        Math.max(0, containerWidthRef.current - reserved.left - reserved.right),
                        containerHeight,
                      );
                    };
                    return { onFrame, onEnd };
                  }}
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
