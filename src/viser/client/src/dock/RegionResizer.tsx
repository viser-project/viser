// Divider on a docked region's inner edge that resizes the whole region.

import { Box } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { dragGesture } from "./gestures";
import { DockEdge } from "./types";

export function RegionResizer({
  edge,
  makeOnResize,
  getStart,
  stripOffset = 0,
}: {
  edge: DockEdge;
  /** Called once per drag (at pointer down) so the handler can snapshot the
   * columns' start widths; returns the per-frame resize handler. */
  makeOnResize: () => (px: number) => void;
  getStart: () => number;
  /** Inset (px) from the region's canvas-facing edge, to skip past leading
   * minimized strips so the handle sits on the first expanded panel's boundary
   * (`[strip]│[panel]`) rather than the strip's far side. */
  stripOffset?: number;
}) {
  const { setResizing } = useDock();
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
    // Mark resizing so the region-width transition is suppressed -- a resize
    // started right after a minimize must track the cursor, not ease.
    setResizing(true);
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
        setResizing(false);
        // Cancel (Escape): resolve back to the drag-start width; the snapshot
        // closure reproduces the original column widths from it.
        if (cancelled) onResize(startWidth);
      },
    });
  };
  return (
    <Box
      data-dock-region-resize={edge}
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        // The canvas-facing edge of the region, pushed inward past any leading
        // minimized strips so the handle is on the resized panel's boundary. The
        // ~12px grab area sits ENTIRELY on the canvas side of the boundary (12px
        // out, 0 in) so it never overlaps the panel's own chrome -- notably a
        // LEFT-docked panel's minimize button, which hugs the panel's right edge
        // right at this boundary. Overlay, so no layout impact.
        [edge === "left" ? "right" : "left"]: `${stripOffset - 12}px`,
        width: "12px",
        cursor: "ew-resize",
        zIndex: 15,
        touchAction: "none",
      }}
    />
  );
}
