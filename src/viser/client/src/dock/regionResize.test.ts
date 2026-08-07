// Region-resize gesture tests (makeRegionResizeHandlers), driven the way
// RegionResizer drives it: per-frame onFrame(reservedPx) calls, then -- on
// Escape -- a replayed onFrame(startWidth) followed by onEnd(true) (the
// resizer's cancel choreography).
//
// P2 / spec section 4 pin: "Escape ... restores the exact pre-gesture
// layout". pushFloatsAheadOfSeam is stateless and grow-only, so the cancel's
// width-restore frame cannot un-push floats the drag displaced -- and after a
// SHRINK, that restore frame is itself a grow that pushes floats the drag
// never touched. The handlers therefore snapshot pre-gesture float x
// positions and restore them on the cancelled onEnd.

import { describe, expect, it } from "vitest";
import { makeRegionResizeHandlers, RegionResizeDeps } from "./regionResize";
import { leaf, makeLayout } from "./testUtils";
import { DockLayout } from "./types";

function makeDeps(layout: DockLayout, startReserved: number) {
  const layoutRef = { current: layout };
  const reservedWidthRef = { current: { left: startReserved, right: 0 } };
  const deps: RegionResizeDeps = {
    layoutRef,
    containerRef: { current: null },
    containerWidthRef: { current: 1000 },
    containerHeightRef: { current: 800 },
    reservedWidthRef,
    regionResizeDraggingRef: { current: false },
    draggingWindowIdRef: { current: null },
    onCommitRef: { current: undefined },
    onRegionResizeFrameRef: { current: undefined },
    applyOp: (next) => {
      layoutRef.current = next;
    },
    runProgrammatic: (fn) => fn(),
  };
  return { deps, layoutRef, reservedWidthRef };
}

/** Drive one drag the way RegionResizer does: onFrame per pointer frame, with
 * the rendered reserved width (what DockManager's re-render feeds back into
 * reservedWidthRef) tracking each committed frame. */
function driveDrag(startReserved: number, layout: DockLayout) {
  const { deps, layoutRef, reservedWidthRef } = makeDeps(layout, startReserved);
  const handlers = makeRegionResizeHandlers("left", deps);
  const frame = (px: number) => {
    handlers.onFrame(px);
    reservedWidthRef.current.left = px;
  };
  const escape = () => {
    // RegionResizer's cancel choreography: replay the start width, then the
    // cancelled end.
    frame(startReserved);
    handlers.onEnd(true);
  };
  const release = () => handlers.onEnd(false);
  return { frame, escape, release, layoutRef };
}

describe("region resize Escape restores pre-gesture float positions (P2)", () => {
  it("grow pushes a float; Escape puts it back exactly", () => {
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w", stack: ["f"], x: 400, y: 120, width: 200 }],
    });
    const { frame, escape, layoutRef } = driveDrag(300, layout);
    frame(600); // grow: the seam sweeps past the float at x=400...
    expect(layoutRef.current.floating[0].x).toBe(600); // ...pushing it flush
    escape();
    const w = layoutRef.current.floating[0];
    expect(w.x).toBe(400); // exact pre-gesture position
    expect(w.y).toBe(120);
  });

  it("shrink-then-Escape leaves an untouched overlapping float unmoved", () => {
    // A float OVERLAPPING the region pre-gesture (x=200 under a 300px
    // region): the drag never touches it (pushes are grow-only and skip
    // already-overlapping floats), so Escape must leave it at x=200. The
    // cancel's width-restore frame (150 -> 300, a grow) would otherwise
    // push it flush to the restored seam.
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w", stack: ["f"], x: 200, y: 50, width: 150 }],
    });
    const { frame, escape, layoutRef } = driveDrag(300, layout);
    frame(150); // shrink: sweeps past nothing
    expect(layoutRef.current.floating[0].x).toBe(200);
    escape();
    expect(layoutRef.current.floating[0].x).toBe(200);
  });

  it("a real release (no cancel) keeps the pushed position", () => {
    const layout = makeLayout({
      left: leaf("a"),
      floating: [{ id: "w", stack: ["f"], x: 400, y: 120, width: 200 }],
    });
    const { frame, release, layoutRef } = driveDrag(300, layout);
    frame(600);
    release(); // real release: no restore frame, no snapshot restore
    expect(layoutRef.current.floating[0].x).toBe(600);
  });
});
