// Divider on a docked region's inner edge that resizes the whole region.

import { Box } from "@mantine/core";
import React from "react";
import { dragGesture } from "./gestures";
import { DockEdge } from "./types";

// How far the grab zone extends onto the CANVAS side of the region boundary.
const RESIZER_OUTSET_PX = 10;
// How far it extends INWARD over the panel, so a drag aimed at the visible
// region edge registers instead of falling through to the panel. Kept small (and
// below the grip bar, see `top`) so it doesn't shadow panel chrome.
const RESIZER_INSET_PX = 5;
// Top inset clearing the TALLEST chrome row (the unmergeable titleNode
// header is 2.75em ~= 44px), so the inward part of the straddle never covers
// the canvas-facing chevron/minimize toggle at a left panel's top corner --
// e.g. the docked main panel's header controls.
const GRIP_BAR_CLEARANCE_PX = 48;

export function RegionResizer({
  edge,
  makeOnResize,
  getStart,
  onDragEnd,
}: {
  edge: DockEdge;
  /** Called once per drag (at pointer down) so the handler can snapshot the
   * columns' start widths; returns the per-frame resize handler. */
  makeOnResize: () => (px: number) => void;
  getStart: () => number;
  /** Called once at release/cancel, AFTER the final width settles. */
  onDragEnd?: (cancelled: boolean) => void;
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
    const onResize = makeOnResize();
    let pending = startWidth;
    activeDrag.current = dragGesture({
      grip: event.currentTarget,
      pointerId: event.pointerId,
      update: (e) => {
        const delta = e.clientX - startX;
        pending = edge === "left" ? startWidth + delta : startWidth - delta;
      },
      flush: () => onResize(pending),
      onEnd: (cancelled) => {
        activeDrag.current = null;
        // Cancel (Escape): resolve back to the drag-start width; the snapshot
        // closure reproduces the original column widths from it.
        if (cancelled) onResize(startWidth);
        onDragEnd?.(cancelled);
      },
    });
  };
  return (
    <Box
      data-dock-region-resize={edge}
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        // Start BELOW the top cell's chrome row (which holds the
        // canvas-facing chevron + minimize toggle at a left panel's top
        // corner): the grab zone straddles the region boundary, so without
        // this top inset its inner few px would cover those buttons. The
        // tallest chrome row is the 2.75em unmergeable header;
        // GRIP_BAR_CLEARANCE_PX clears it with margin. Below it there is no
        // chrome at the boundary, so the grab straddles the full height.
        top: GRIP_BAR_CLEARANCE_PX,
        bottom: 0,
        // The canvas-facing edge of the region. The grab STRADDLES the
        // boundary -- a few px inside, the rest on the canvas side -- so a
        // drag aimed at the visible region edge registers (it previously sat
        // 12px ENTIRELY outside, so an edge-aimed drag fell on the panel and
        // did nothing). Overlay, so no layout impact.
        [edge === "left" ? "right" : "left"]: `${-RESIZER_OUTSET_PX}px`,
        width: `${RESIZER_OUTSET_PX + RESIZER_INSET_PX}px`,
        cursor: "ew-resize",
        zIndex: 15,
        touchAction: "none",
      }}
    />
  );
}
