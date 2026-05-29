// @refresh reset

import { Box, Collapse, Divider, Paper, ScrollArea } from "@mantine/core";
import React from "react";
import { DockContext, DockSide } from "./DockContext";

// How close (in px) the pointer needs to get to a parent edge before we offer
// to dock to that edge.
const dockThreshold = 48;

// Bounds for user resizing of the panel width. The minimum matches the
// smallest preset control width ("small" = 16em), resolved against the panel's
// font size at resize time.
const minWidthEm = 16;
const maxWidthHardCapPx = 600;
// Keep at least this much of the parent visible next to the panel.
const resizeParentPad = 100;

const FloatingPanelContext = React.createContext<null | {
  wrapperRef: React.RefObject<HTMLDivElement>;
  expanded: boolean;
  width: string;
  maxHeight: number;
  toggleExpanded: () => void;
  dragHandler: (event: React.PointerEvent<HTMLDivElement>) => void;
  dragInfo: React.MutableRefObject<{
    dragging: boolean;
    startPosX: number;
    startPosY: number;
    startClientX: number;
    startClientY: number;
  }>;
}>(null);

/** A floating panel for displaying controls. */
export default function FloatingPanel({
  children,
  width,
}: {
  children: string | React.ReactNode;
  width: string;
}) {
  const panelWrapperRef = React.useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = React.useState(800);

  // Dock state and expand/collapse, shared with the canvas (which insets to
  // make room for us, but only while we're docked AND expanded).
  const { dock, setDock, expanded, toggleExpanded } =
    React.useContext(DockContext);
  // Edge currently being hovered during a drag; drives the drop-zone hint.
  const [dockHint, setDockHint] = React.useState<DockSide>(null);
  // Pending dock side captured during drag, applied on release. Held in a ref
  // so the (once-bound) drag-end listener reads the latest value.
  const pendingDock = React.useRef<DockSide>(null);

  // User-set width override (px). Null means "use the theme-provided width".
  const [widthOverride, setWidthOverride] = React.useState<number | null>(null);
  const effectiveWidth =
    widthOverride !== null ? `${widthOverride}px` : width;
  // Set while actively resizing, so the ResizeObserver below doesn't fight the
  // imperative position/width updates.
  const resizing = React.useRef(false);

  // Things to track for dragging.
  const dragInfo = React.useRef({
    dragging: false,
    startPosX: 0,
    startPosY: 0,
    startClientX: 0,
    startClientY: 0,
  });

  // Logic for "fixing" panel locations, which keeps the control panel within
  // the bounds of the parent div.
  //
  // For `unfixedOffset`, we use a negative sign to indicate that the panel is
  // positioned relative to the right/bottom bound of the parent.
  const unfixedOffset = React.useRef<{ x?: number; y?: number }>({});
  const computePanelOffset = (
    panelPosition: number,
    panelSize: number,
    parentSize: number,
  ) =>
    Math.abs(panelPosition + panelSize / 2.0) <
    Math.abs(panelPosition - parentSize + panelSize / 2.0)
      ? panelPosition
      : panelPosition - parentSize;

  const panelBoundaryPad = 15;
  function setPanelLocation(x: number, y: number) {
    const panel = panelWrapperRef.current;
    if (panel === null) return [x, y];

    const parent = panel.parentElement;
    if (parent === null) return [x, y];

    let newX = x;
    let newY = y;

    newX = Math.min(
      newX,
      parent.clientWidth - panel.clientWidth - panelBoundaryPad,
    );
    newX = Math.max(newX, panelBoundaryPad);
    newY = Math.min(
      newY,
      parent.clientHeight - panel.clientHeight - panelBoundaryPad,
    );
    newY = Math.max(newY, panelBoundaryPad);

    panel.style.top = `${newY.toString()}px`;
    panel.style.left = `${newX.toString()}px`;

    return [
      computePanelOffset(newX, panel.clientWidth, parent.clientWidth),
      computePanelOffset(newY, panel.clientHeight, parent.clientHeight),
    ];
  }

  // Apply the styles for the current dock state. We drive top/left/right/bottom
  // imperatively (rather than via the React style prop) so that the drag logic,
  // which mutates these directly, never fights with React's reconciliation.
  function applyDockLayout(side: DockSide) {
    const panel = panelWrapperRef.current;
    if (panel === null) return;
    if (side === null) {
      // Floating: clear the docked styles. Leave top/left alone so the panel
      // stays where the drag (or initial placement) put it.
      panel.style.height = "";
      panel.style.bottom = "";
      panel.style.right = "auto";
      panel.style.borderRadius = "";
    } else {
      // Docked: pin to the edge. Fill the height when expanded; when collapsed,
      // shrink to the handle (the canvas reclaims the column).
      panel.style.top = "0";
      panel.style.borderRadius = "0";
      if (expanded) {
        panel.style.bottom = "0";
        panel.style.height = "100%";
      } else {
        panel.style.bottom = "";
        panel.style.height = "";
      }
      if (side === "left") {
        panel.style.left = "0";
        panel.style.right = "auto";
      } else {
        panel.style.left = "auto";
        panel.style.right = "0";
      }
    }
  }

  // Initial placement (top-right corner) when floating.
  React.useLayoutEffect(() => {
    const panel = panelWrapperRef.current;
    if (panel === null) return;
    const parent = panel.parentElement;
    if (parent === null) return;
    if (dock.side === null && unfixedOffset.current.x === undefined) {
      setPanelLocation(
        parent.clientWidth - panel.clientWidth - panelBoundaryPad,
        panelBoundaryPad,
      );
    }
    applyDockLayout(dock.side);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock.side, expanded]);

  // Fix locations on resize.
  React.useEffect(() => {
    const panel = panelWrapperRef.current;
    if (panel === null) return;

    const parent = panel.parentElement;
    if (parent === null) return;

    const observer = new ResizeObserver(() => {
      const newMaxHeight = parent.clientHeight - panelBoundaryPad * 2;
      maxHeight !== newMaxHeight && setMaxHeight(newMaxHeight);

      // Don't reposition while the user is actively resizing the panel; the
      // resize handler is driving width (and, when floating, left) directly.
      if (resizing.current) return;

      // When docked, the panel is pinned via CSS; nothing to re-fix.
      if (dock.side !== null) {
        applyDockLayout(dock.side);
        return;
      }

      if (unfixedOffset.current.x === undefined)
        unfixedOffset.current.x = computePanelOffset(
          panel.offsetLeft,
          panel.clientWidth,
          parent.clientWidth,
        );
      if (unfixedOffset.current.y === undefined)
        unfixedOffset.current.y = computePanelOffset(
          panel.offsetTop,
          panel.clientHeight,
          parent.clientHeight,
        );

      let newX = unfixedOffset.current.x;
      let newY = unfixedOffset.current.y;
      while (newX < 0) newX += parent.clientWidth;
      while (newY < 0) newY += parent.clientHeight;
      setPanelLocation(newX, newY);
    });
    observer.observe(panel);
    observer.observe(parent);
    return () => {
      observer.disconnect();
    };
  });

  const dragHandler = (event: React.PointerEvent<HTMLDivElement>) => {
    // Ignore presses that bubble in from portaled children (e.g. the share
    // modal's overlay). React routes their pointer events through here even
    // though they're not in the handle's DOM, and capturing the pointer would
    // misroute the follow-up click back to the handle (collapsing the panel).
    if (!event.currentTarget.contains(event.target as Node)) return;
    // Don't start a drag (or capture the pointer) when the press lands on an
    // interactive child like a button -- pointer capture would otherwise
    // retarget the resulting click to the handle and break those controls.
    if ((event.target as HTMLElement).closest("button, a, input")) return;

    const state = dragInfo.current;
    const panel = panelWrapperRef.current;
    if (!panel) return;
    const parent = panel.parentElement;
    if (!parent) return;

    state.startClientX = event.clientX;
    state.startClientY = event.clientY;

    // Capture the pointer on the handle. This guarantees we keep receiving
    // pointermove/pointerup even when the cursor passes over (or releases on
    // top of) child buttons that stopPropagation, or leaves the window. The
    // follow-up click is also retargeted to the handle, so releasing over a
    // button doesn't accidentally trigger it.
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const pointerType = event.pointerType;
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // The pointer may already be gone; ignore.
    }

    // Remember whether we started docked. We only undock once the user
    // actually drags -- a click/tap (no motion) should toggle collapse, not
    // undock.
    const startedDockedSide = dock.side;
    let undocked = false;

    state.startPosX = panel.offsetLeft;
    state.startPosY = panel.offsetTop;
    pendingDock.current = null;

    function dragListener(event: PointerEvent) {
      const panel = panelWrapperRef.current;
      const parent = panel?.parentElement;
      if (!panel || !parent) return;

      // Minimum motion.
      const deltaX = event.clientX - state.startClientX;
      const deltaY = event.clientY - state.startClientY;
      if (Math.abs(deltaX) <= 3 && Math.abs(deltaY) <= 3) return;

      state.dragging = true;

      // First real motion while docked: undock in place by converting the
      // panel's current on-screen position into a floating position, then
      // continue dragging from there with no jump.
      if (startedDockedSide !== null && !undocked) {
        undocked = true;
        const panelRect = panel.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        unfixedOffset.current = {};
        setDock({ side: null, width: effectiveWidth });
        applyDockLayout(null);
        const newLeft = panelRect.left - parentRect.left;
        const newTop = panelRect.top - parentRect.top;
        panel.style.left = `${newLeft}px`;
        panel.style.top = `${newTop}px`;
        state.startPosX = newLeft;
        state.startPosY = newTop;
        state.startClientX = event.clientX;
        state.startClientY = event.clientY;
        return;
      }

      const newX = state.startPosX + deltaX;
      const newY = state.startPosY + deltaY;
      [unfixedOffset.current.x, unfixedOffset.current.y] = setPanelLocation(
        newX,
        newY,
      );

      // Offer to dock when the pointer is near a left/right edge of the parent.
      const parentRect = parent.getBoundingClientRect();
      let hint: DockSide = null;
      if (event.clientX - parentRect.left < dockThreshold) hint = "left";
      else if (parentRect.right - event.clientX < dockThreshold) hint = "right";
      if (hint !== pendingDock.current) {
        pendingDock.current = hint;
        setDockHint(hint);
      }
    }
    function endListener() {
      window.removeEventListener("pointermove", dragListener);
      window.removeEventListener("pointerup", endListener);
      window.removeEventListener("pointercancel", endListener);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Already released; ignore.
      }
      // For touch/pen, no click follows to reset this; do it here.
      if (pointerType !== "mouse") state.dragging = false;

      // Commit a pending dock, if any.
      const side = pendingDock.current;
      pendingDock.current = null;
      setDockHint(null);
      if (side !== null) {
        unfixedOffset.current = {};
        setDock({ side, width: effectiveWidth });
        applyDockLayout(side);
      }
    }
    window.addEventListener("pointermove", dragListener);
    window.addEventListener("pointerup", endListener);
    window.addEventListener("pointercancel", endListener);
  };

  // Edges that can be grabbed to resize: when floating, either side; when
  // docked, only the edge facing the canvas.
  const resizeSides: ("left" | "right")[] =
    dock.side === null ? ["left", "right"] : [dock.side === "left" ? "right" : "left"];
  const resizeHandler =
    (side: "left" | "right") => (event: React.PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      const panel = panelWrapperRef.current;
      if (!panel) return;
      const parent = panel.parentElement;
      if (!parent) return;

      const grip = event.currentTarget;
      const pointerId = event.pointerId;
      try {
        grip.setPointerCapture(pointerId);
      } catch {
        // Ignore.
      }

      resizing.current = true;
      const startX = event.clientX;
      const startWidth = panel.offsetWidth;
      // Right edge in parent coordinates; kept fixed when resizing a floating
      // panel from its left edge.
      const startRight = panel.offsetLeft + startWidth;
      // Only a floating panel grabbed from its left edge needs its position
      // moved; docked panels are anchored to an edge by CSS.
      const adjustLeft = dock.side === null && side === "left";

      function resizeMove(event: PointerEvent) {
        const panel = panelWrapperRef.current;
        const parent = panel?.parentElement;
        if (!panel || !parent) return;
        const delta = event.clientX - startX;
        const rawWidth =
          side === "right" ? startWidth + delta : startWidth - delta;
        const emPx = parseFloat(getComputedStyle(panel).fontSize) || 16;
        const minWidth = minWidthEm * emPx;
        const maxWidth = Math.max(
          minWidth,
          Math.min(maxWidthHardCapPx, parent.clientWidth - resizeParentPad),
        );
        const newWidth = Math.max(minWidth, Math.min(maxWidth, rawWidth));
        setWidthOverride(newWidth);
        if (adjustLeft) {
          panel.style.left = `${startRight - newWidth}px`;
        }
        if (dock.side !== null) {
          setDock({ side: dock.side, width: `${newWidth}px` });
        }
      }
      function resizeEnd() {
        window.removeEventListener("pointermove", resizeMove);
        window.removeEventListener("pointerup", resizeEnd);
        window.removeEventListener("pointercancel", resizeEnd);
        try {
          grip.releasePointerCapture(pointerId);
        } catch {
          // Ignore.
        }
        resizing.current = false;
        // Let the ResizeObserver re-derive the anchored offset from the new size.
        unfixedOffset.current = {};
      }
      window.addEventListener("pointermove", resizeMove);
      window.addEventListener("pointerup", resizeEnd);
      window.addEventListener("pointercancel", resizeEnd);
    };

  return (
    <FloatingPanelContext.Provider
      value={{
        wrapperRef: panelWrapperRef,
        expanded: expanded,
        width: effectiveWidth,
        maxHeight: maxHeight,
        toggleExpanded: toggleExpanded,
        dragHandler: dragHandler,
        dragInfo: dragInfo,
      }}
    >
      {/* Drop-zone hints, shown while dragging near an edge. */}
      <DropZoneHint side={dockHint} width={effectiveWidth} />
      <Paper
        radius="xs"
        shadow="0.1em 0 1em 0 rgba(0,0,0,0.1)"
        style={{
          boxSizing: "border-box",
          width: effectiveWidth,
          zIndex: 10,
          position: "absolute",
          margin: 0,
          "& .expandIcon": {
            transform: "rotate(0)",
          },
          overflow: "hidden",
        }}
        ref={panelWrapperRef}
      >
        {/* Invisible resize zones; the ew-resize cursor signals them. */}
        {resizeSides.map((side) => (
          <ResizeGrip key={side} side={side} onPointerDown={resizeHandler(side)} />
        ))}
        {children}
      </Paper>
    </FloatingPanelContext.Provider>
  );
}

/** Invisible draggable zone on one edge for resizing the panel width. There's
 * no visible affordance; the ew-resize cursor on hover is the only cue. */
function ResizeGrip({
  side,
  onPointerDown,
}: {
  side: "left" | "right";
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <Box
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [side]: 0,
        width: "0.5em",
        cursor: "ew-resize",
        zIndex: 11,
        touchAction: "none",
      }}
    />
  );
}

/** Translucent overlay shown at an edge while dragging, previewing where the
 * panel will dock. */
function DropZoneHint({ side, width }: { side: DockSide; width: string }) {
  if (side === null) return null;
  return (
    <Box
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [side]: 0,
        width: width,
        zIndex: 9,
        pointerEvents: "none",
        backgroundColor: "var(--mantine-primary-color-light)",
        opacity: 0.5,
        borderRadius: 0,
      }}
    />
  );
}

/** Handle object helps us hide, show, and drag our panel.*/
FloatingPanel.Handle = function FloatingPanelHandle({
  children,
}: {
  children: string | React.ReactNode;
}) {
  const panelContext = React.useContext(FloatingPanelContext)!;

  return (
    <>
      <Box
        style={{
          borderRadius: "0.2em 0.2em 0 0",
          lineHeight: "1.5em",
          cursor: "pointer",
          position: "relative",
          fontWeight: 400,
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          padding: "0 0.75em",
          height: "2.75em",
          // Prevent touch scrolling from hijacking handle drags.
          touchAction: "none",
        }}
        onClick={(event) => {
          // Ignore clicks that bubble up from portaled children (e.g. the
          // share modal's overlay). React routes their events through here
          // even though they're not in the handle's DOM subtree, which would
          // otherwise collapse the panel when the modal is dismissed.
          if (!event.currentTarget.contains(event.target as Node)) return;
          const state = panelContext.dragInfo.current;
          if (state.dragging) {
            state.dragging = false;
            return;
          }
          panelContext.toggleExpanded();
        }}
        onPointerDown={(event) => {
          panelContext.dragHandler(event);
        }}
      >
        {children}
      </Box>
    </>
  );
};
/** Contents of a panel. */
FloatingPanel.Contents = function FloatingPanelContents({
  children,
}: {
  children: string | React.ReactNode;
}) {
  const context = React.useContext(FloatingPanelContext)!;
  return (
    <Collapse in={context.expanded}>
      <Divider />
      <ScrollArea.Autosize mah={context.maxHeight}>
        <Box
          /* Prevent internals from getting too wide. Needs to match the
           * width of the wrapper element above. */
          style={{ width: context.width }}
        >
          {children}
        </Box>
      </ScrollArea.Autosize>
    </Collapse>
  );
};

/** Hides contents when floating panel is collapsed. */
FloatingPanel.HideWhenCollapsed = function FloatingPanelHideWhenCollapsed({
  children,
}: {
  children: React.ReactNode;
}) {
  const expanded = React.useContext(FloatingPanelContext)?.expanded ?? true;
  return expanded ? children : null;
};
