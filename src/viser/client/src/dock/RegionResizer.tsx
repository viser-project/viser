// Divider on a docked region's inner edge that resizes the whole region.

import { Box } from "@mantine/core";
import React from "react";
import { dragGesture } from "./gestures";
import { DockEdge } from "./types";

// How far the grab zone extends onto the canvas side of the region boundary.
const RESIZER_OUTSET_PX = 10;
// How far it extends inward over the panel, so a drag aimed at the visible
// region edge registers instead of falling through to the panel. Kept small (and
// below the grip bar, see `top`) so it doesn't shadow panel chrome.
const RESIZER_INSET_PX = 5;
// Top inset clearing the tallest chrome row (the unmergeable titleNode
// header is 2.75em ~= 44px), so the inward part of the straddle never covers
// the canvas-facing chevron/minimize toggle at a left panel's top corner --
// e.g. the docked main panel's header controls.
const GRIP_BAR_CLEARANCE_PX = 48;

export function RegionResizer({
  edge,
  makeOnResize,
  getStart,
}: {
  edge: DockEdge;
  /** Called once per drag (at pointer down) so the handlers can snapshot the
   * columns' start widths (and the drag-start layout); returns the per-frame
   * resize handler plus the release/cancel handler (called after the final
   * width settles). */
  makeOnResize: () => {
    onFrame: (px: number) => void;
    onEnd: (cancelled: boolean) => void;
  };
  getStart: () => number;
}) {
  // Cancel the in-flight gesture if the resizer unmounts mid-drag (e.g. the
  // region empties), so its window listeners can't fire after unmount.
  const activeDrag = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => activeDrag.current?.(), []);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (activeDrag.current !== null) return; // one drag per resizer
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = getStart();
    const handlers = makeOnResize();
    let pending = startWidth;
    activeDrag.current = dragGesture({
      grip: event.currentTarget,
      pointerId: event.pointerId,
      update: (e) => {
        const delta = e.clientX - startX;
        pending = edge === "left" ? startWidth + delta : startWidth - delta;
      },
      flush: () => handlers.onFrame(pending),
      onEnd: (cancelled) => {
        activeDrag.current = null;
        // Cancel (Escape): resolve back to the drag-start width; the snapshot
        // closure reproduces the original column widths from it.
        if (cancelled) handlers.onFrame(startWidth);
        handlers.onEnd(cancelled);
      },
    });
  };
  // The grab straddles the region boundary as two strips sharing one
  // handler. The outer (canvas-side) strip can never overlap panel chrome,
  // so it runs the full height -- a drag aimed at the visible boundary line
  // registers even beside the top cell's header. Only the inner strip (the
  // few px over the panel) starts below GRIP_BAR_CLEARANCE_PX, clearing the
  // tallest chrome row (the 2.75em unmergeable header), whose canvas-corner
  // chevron/toggle it would otherwise cover. The wrapper keeps the full
  // straddle footprint (e2e drags target its bbox center) but is
  // pointer-inert; only the strips take the press. Overlays, no layout
  // impact.
  const shared: React.CSSProperties = {
    position: "absolute",
    pointerEvents: "auto",
    cursor: "ew-resize",
    touchAction: "none",
  };
  return (
    <Box
      data-dock-region-resize={edge}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [edge === "left" ? "right" : "left"]: `${-RESIZER_OUTSET_PX}px`,
        width: `${RESIZER_OUTSET_PX + RESIZER_INSET_PX}px`,
        zIndex: 15,
        pointerEvents: "none",
      }}
    >
      {/* Outer strip: canvas side of the boundary (the side away from the
      region), full height. */}
      <Box
        onPointerDown={onPointerDown}
        style={{
          ...shared,
          top: 0,
          bottom: 0,
          [edge === "left" ? "right" : "left"]: 0,
          width: `${RESIZER_OUTSET_PX}px`,
        }}
      />
      {/* Inner strip: over the panel, below the top chrome row. */}
      <Box
        onPointerDown={onPointerDown}
        style={{
          ...shared,
          top: GRIP_BAR_CLEARANCE_PX,
          bottom: 0,
          [edge === "left" ? "left" : "right"]: 0,
          width: `${RESIZER_INSET_PX}px`,
        }}
      />
    </Box>
  );
}
