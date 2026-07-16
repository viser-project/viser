// The docked-region width-resize pipeline. DockManager renders a RegionResizer
// per resizable region and delegates the drag to makeRegionResizeHandlers,
// which snapshots the columns' drag-start widths and returns the per-frame and
// release handlers: each frame redistributes widths across the expanded
// columns, pushes floating windows ahead of the sweeping seam, commits the new
// width through the manager's applyOp inside flushSync, and hands the host the
// authoritative new canvas size on the same tick. useCanvasInsetSync covers
// the non-drag case: while a discrete inset change eases, it feeds the canvas
// wrapper's live box to the same host callback each animation frame.
//
// This module owns the width math and the per-frame commit choreography only;
// layout state itself is still committed through the applyOp/runProgrammatic
// pipeline passed in from DockManager, and the single user-attributed commit
// spanning the whole drag fires through the manager's onCommit ref at release.

import React from "react";
import { flushSync } from "react-dom";
import * as ops from "./layoutOps";
import { planRegion } from "./regionPlan";
import { DockEdge, DockLayout, MINIMIZED_STRIP_PX, WindowId } from "./types";

/** As a docked region's edge sweeps inward during a resize (reserved width
 * `oldReserved` -> `newReserved`), push floats it sweeps past so they stay fully
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
  // their input -- a shallow copy would alias groups/docked with the committed
  // layout and let those steps corrupt it.
  const next = ops.cloneLayout(layout);
  next.floating = floating;
  return next;
}

/** Everything the resize handlers need from DockManager. Refs are passed as
 * refs (not snapshots) because the handlers run per drag frame and must read
 * the synchronous truth -- height included: a width drag never changes it,
 * but a concurrent browser resize can, and a stale snapshot would re-impose
 * the drag-start canvas height on the GL backbuffer each frame. */
export interface RegionResizeDeps {
  layoutRef: React.MutableRefObject<DockLayout>;
  containerRef: React.RefObject<HTMLDivElement>;
  containerWidthRef: React.MutableRefObject<number>;
  containerHeightRef: React.MutableRefObject<number>;
  /** Rendered region widths per edge (assigned by DockManager each render). */
  reservedWidthRef: React.MutableRefObject<{ left: number; right: number }>;
  /** True only while a frame's width commit is flushing, so the manager's
   * inset effect doesn't also re-clamp unanchored floats mid-drag. */
  regionResizeDraggingRef: React.MutableRefObject<boolean>;
  draggingWindowIdRef: React.MutableRefObject<WindowId | null>;
  onCommitRef: React.MutableRefObject<
    | ((prev: DockLayout, next: DockLayout, programmatic: boolean) => void)
    | undefined
  >;
  onRegionResizeFrameRef: React.MutableRefObject<
    ((canvasWidth: number, canvasHeight: number) => void) | undefined
  >;
  applyOp: (next: DockLayout) => void;
  runProgrammatic: (fn: () => void) => void;
}

/** Called once per drag (RegionResizer's makeOnResize): snapshots the columns'
 * start widths and limits (and the drag-start layout, which serves the
 * end-commit), and returns the per-frame + end handlers. Widths are
 * redistributed across all columns from their drag-start proportions, clamping
 * each to its own min/max and handing the difference to columns that still
 * have room -- so the region keeps resizing while any column can give or take. */
export function makeRegionResizeHandlers(
  edge: DockEdge,
  deps: RegionResizeDeps,
): {
  onFrame: (reservedPx: number) => void;
  onEnd: (cancelled: boolean) => void;
} {
  const {
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
  } = deps;
  const layout0 = layoutRef.current;
  // Per-frame width writes must land instantly: suppress the D34 width/flex
  // transitions under the whole dock for the drag's duration
  // (regionWidthAnim/collapseAnim read the [data-dock-resizing] ancestor), or
  // the region would ease-lag behind the cursor.
  containerRef.current?.setAttribute("data-dock-resizing", "");
  const onEnd = (cancelled: boolean) => {
    containerRef.current?.removeAttribute("data-dock-resizing");
    // Skip on cancel (Escape restored the start widths) and on a click without
    // motion (no frame committed, layout unchanged). Otherwise fire one
    // user-attributed commit spanning the whole drag: layout state is already
    // final, this only informs the host's ownership diff.
    if (cancelled || layout0 === layoutRef.current) return;
    onCommitRef.current?.(layout0, layoutRef.current, false);
  };
  const tree0 = layout0.docked[edge];
  if (tree0 === null) return { onFrame: () => {}, onEnd };
  // Every expanded width-determining column participates. Railed columns are
  // excluded from the redistribution: they render at the fixed strip width and
  // their weights are preserved for restore (P8), so their strip px rides with
  // the divider chrome as fixed width instead. The plan is the same
  // classification the render uses.
  const plan = planRegion(tree0);
  const cols = plan.columns.filter((c) => c.railed !== true);
  const railedCols = plan.columns.filter((c) => c.railed === true);
  const railedStripPx = railedCols.length * MINIMIZED_STRIP_PX;
  const fixedPx = plan.chromePx + railedStripPx;
  // Weights are pixels for every column, lone ones included (the reconciler
  // writes them on each commit).
  const init = cols.map((c) => c.weight);
  const mins = cols.map(() => ops.minRegionWidth());
  // No per-column max: a region drag is bounded only by its columns' grab-mins
  // (and the render-time canvas guard), not a fixed per-panel width --
  // matching the width reconciler and SplitView divider drags.
  const maxs = cols.map(() => Infinity);
  const ids = cols.map((c) => c.id);
  const onFrame = (reservedPx: number) => {
    // The grip reports the desired reserved width, which includes the fixed
    // chrome (dividers + railed strips); subtract it to get the expanded
    // columns' share.
    let next = layoutRef.current;
    const widths = ops.resizeRegionColumns(
      init,
      mins,
      maxs,
      reservedPx - fixedPx,
    );
    const expandedTotal = widths.reduce((a, b) => a + b, 0);
    // Model regionWidth = the region's rendered need (D40): the expanded
    // columns' px plus the fixed 36px strips. The railed columns' preserved
    // pixel weights ride along untouched so expanding them restores their
    // widths. (The resizer never exists with every column railed: it renders
    // only while `resizable`, and rail flips can't happen mid-gesture.)
    const total = expandedTotal + railedStripPx;
    const newReservedPx = expandedTotal + fixedPx;
    // Write the redistributed pixel widths into the column weights (every
    // expanded column, lone ones included -- weights are always reconciled
    // px). The total goes through the setRegionWidth op so the model stays
    // the single source of truth for the width.
    const byId: Record<string, number> = {};
    ids.forEach((id, i) => {
      byId[id] = widths[i];
    });
    // One draft for weights + regionWidth (commitRegionResize): the split
    // two-op form deep-cloned twice per pointer frame.
    next = ops.commitRegionResize(next, edge, byId, total);
    // Push floats out of the way of this region's edge as it sweeps inward,
    // using the before/after seam of this very drag frame -- no history
    // needed. A float that was fully on the canvas (its edge clear of the old
    // seam) and would now be covered (past the new seam) is pushed flush, so
    // it stays fully on the canvas; one already overlapping (edge past the old
    // seam) is left alone, and a receding seam pushes nothing.
    next = pushFloatsAheadOfSeam(
      next,
      edge,
      containerWidthRef.current,
      reservedWidthRef.current[edge], // old reserved (pre-commit)
      // New reserved: the new model width + divider chrome (rendered-need
      // semantic, D40).
      newReservedPx,
      draggingWindowIdRef.current,
    );
    // Flush the width commit so this render updates reservedWidthRef (the
    // canvas wrapper's new insets) before we tell the host the canvas's new
    // size. Mark the commit as drag-originated so the inset effect (which
    // fires inside this flushSync) doesn't also re-clamp unanchored floats --
    // the drag already moved them flush with the seam.
    regionResizeDraggingRef.current = true;
    try {
      // Per-frame commits stay programmatic even though the dirty-bit does
      // track region width: running the user-gesture commit handler ~60x/s is
      // wasted work, and an Escape-cancel must leave no user-attributed trace.
      // The single user commit spanning the whole drag fires at release
      // instead (see onEnd above).
      flushSync(() => runProgrammatic(() => applyOp(next)));
    } finally {
      regionResizeDraggingRef.current = false;
    }
    // Hand the host (the 3D canvas) the authoritative new canvas size we just
    // produced -- containerWidth minus the freshly-committed insets -- so it
    // resizes the GL backbuffer on this tick. We must not let the host read
    // canvas.clientWidth instead: the new inset isn't reliably reflowed yet
    // mid-drag, so a re-measure lags and the scene trails the divider (and
    // only snaps on release).
    const reserved = reservedWidthRef.current;
    onRegionResizeFrameRef.current?.(
      Math.max(0, containerWidthRef.current - reserved.left - reserved.right),
      containerHeightRef.current,
    );
  };
  return { onFrame, onEnd };
}

/** GL-backbuffer tracking for the inset ease: the host's 3D canvas resizes via
 * a debounced ResizeObserver, so a 160ms inset transition would render as one
 * late jump even though the wrapper slides (drags already bypass this with
 * per-frame onRegionResizeFrame calls). While an inset ease is plausibly
 * running, feed the wrapper's live box through the same hook each animation
 * frame; stops when the box holds still. Presentation only. */
export function useCanvasInsetSync({
  insetKey,
  canvasWrapRef,
  containerRef,
  onRegionResizeFrameRef,
}: {
  /** `${leftInset}:${rightInset}` -- the effect re-arms when either changes. */
  insetKey: string;
  canvasWrapRef: React.RefObject<HTMLDivElement>;
  containerRef: React.RefObject<HTMLDivElement>;
  onRegionResizeFrameRef: React.MutableRefObject<
    ((canvasWidth: number, canvasHeight: number) => void) | undefined
  >;
}): void {
  const armedOnceRef = React.useRef(false);
  React.useEffect(() => {
    const el = canvasWrapRef.current;
    if (el === null) return;
    if (containerRef.current?.hasAttribute("data-dock-resizing")) return;
    const isMountArm = !armedOnceRef.current;
    armedOnceRef.current = true;
    let raf = 0;
    // Seed from the CURRENT box: the loop then only notifies the host on a
    // real change. (A -1 seed fired one spurious GL resize + full scene
    // render per arm, mount included.)
    const seed = el.getBoundingClientRect();
    let last = { w: Math.round(seed.width), h: Math.round(seed.height) };
    let fired = false;
    let still = 0;
    const started = performance.now();
    const tick = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w !== last.w || h !== last.h) {
        last = { w, h };
        still = 0;
        fired = true;
        onRegionResizeFrameRef.current?.(w, h);
      } else {
        still += 1;
      }
      // Instant inset changes (squeeze guard / reduced motion) put the box
      // at its final size BEFORE the seed read -- no delta is ever
      // observed. Fire the final size once at settle so the GL backbuffer
      // doesn't wait out the host's debounced ResizeObserver; the mount
      // arm stays silent (nothing changed, R3F sized itself at init).
      const settled = still >= 2 || performance.now() - started >= 400;
      if (settled && !fired && !isMountArm)
        onRegionResizeFrameRef.current?.(last.w, last.h);
      // Two still frames after at least one change = the ease settled; the
      // 400ms cap is a stuck-transition backstop.
      if (still < 2 && performance.now() - started < 400)
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insetKey]);
}
