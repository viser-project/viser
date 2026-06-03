// @refresh reset

import { Box, Collapse, Divider, Paper, ScrollArea } from "@mantine/core";
import React from "react";
import { DockContext, DockSide } from "./DockContext";
import { motionExceedsThreshold } from "../dragUtils";

/** Bind a pointer gesture's move/end/cancel listeners on `window` and return a
 * detach function. Both the drag and resize gestures capture the pointer on an
 * element but listen on `window` so the gesture survives the cursor leaving it;
 * they share this move + (up/cancel -> end) wiring. */
function bindPointerGesture(
  onMove: (event: PointerEvent) => void,
  onEnd: () => void,
): () => void {
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd);
  window.addEventListener("pointercancel", onEnd);
  return () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);
  };
}

// How close (in px) the pointer needs to get to a parent edge before we offer
// to dock to that edge. A generous zone makes docking easy to trigger -- you
// don't have to drag all the way into the edge.
const dockThreshold = 64;

// Bounds for user resizing of the panel width. The minimum matches the
// smallest preset control width ("small" = 16em), resolved against the panel's
// font size at resize time.
const minWidthEm = 16;
const maxWidthHardCapPx = 600;
// Keep at least this much of the parent visible next to the panel.
const resizeParentPad = 100;
// Invisible resize grip at each edge. It straddles the panel border, sitting
// mostly *outside* the panel so it doesn't overlap the scrollbar (which stays
// at the panel's inner edge) -- you grab just at/past the edge to resize.
const resizeGripWidth = "0.7em";
// How far the grip pokes past the panel edge (must be <= resizeGripWidth). The
// small remainder stays inside, so grabbing right on the border still works.
const resizeGripOutset = "0.55em";

const FloatingPanelContext = React.createContext<null | {
  wrapperRef: React.RefObject<HTMLDivElement>;
  expanded: boolean;
  width: string;
  maxHeight: number;
  toggleExpanded: () => void;
  dragHandler: (event: React.PointerEvent<HTMLDivElement>) => void;
  dragInfo: React.MutableRefObject<{ dragging: boolean }>;
}>(null);

/** A floating panel for displaying controls. */
export default function FloatingPanel({
  children,
  width,
}: {
  children: React.ReactNode;
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
  const effectiveWidth = widthOverride !== null ? `${widthOverride}px` : width;
  // Set while actively resizing, so the ResizeObserver below doesn't fight the
  // imperative position/width updates.
  const resizing = React.useRef(false);

  // Whether a drag is in progress -- read by the handle's onClick to tell a
  // drag-release from a click (toggle). Drag start coordinates live as locals
  // inside the gesture closure below, not here.
  const dragInfo = React.useRef({ dragging: false });

  // Teardown for an in-flight drag/resize gesture. Gestures normally clean up
  // their window listeners and animation frame on pointerup/cancel; this is the
  // safety net for the panel unmounting mid-gesture (e.g. the client
  // disconnects while dragging), so those side effects don't outlive it.
  const activeGestureCleanup = React.useRef<(() => void) | null>(null);
  React.useEffect(
    () => () => {
      activeGestureCleanup.current?.();
    },
    [],
  );

  // The dock state lives in App (it insets the canvas) but is only ever set by
  // this panel. When the floating layout is swapped out -- control_layout
  // changes to sidebar/collapsible, the mobile breakpoint trips, or the client
  // disconnects -- this component unmounts; release the dock so the canvas stops
  // reserving space for a panel that's no longer there (otherwise a left/right
  // inset gap is left behind). Doing it here, keyed on this panel's own
  // lifecycle, covers every one of those cases without App having to know which
  // layout ControlPanel chose. useLayoutEffect (not useEffect) so the reset is
  // committed in the same frame as the unmount -- otherwise there's a one-frame
  // flash where the new layout is painted but the canvas is still inset.
  // `setDock` is a stable state setter, so an empty dep list is correct.
  React.useLayoutEffect(
    () => () => {
      setDock({ side: null, width });
    },
    [],
  );

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
      setMaxHeight((prev) => (prev !== newMaxHeight ? newMaxHeight : prev));

      // Don't reposition while the user is actively resizing or dragging the
      // panel; those handlers drive width/left/top directly (the drag via a
      // transform), and repositioning here would fight them and jitter.
      if (resizing.current) return;
      if (dragInfo.current.dragging) return;

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
    // Re-bind only when the dock state changes (the callback closes over
    // `dock.side` and, via applyDockLayout, `expanded`); `setMaxHeight`'s
    // functional updater keeps it independent of the latest `maxHeight`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock.side, expanded]);

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

    // Pointer position and panel offset at the start of the gesture. Mutated on
    // undock (the panel jumps to a floating position and the drag re-bases from
    // there); `let` so the applyMove closure sees those updates.
    let startClientX = event.clientX;
    let startClientY = event.clientY;

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

    let startPosX = panel.offsetLeft;
    let startPosY = panel.offsetTop;
    pendingDock.current = null;

    // Cache geometry that doesn't change during a drag. Reading layout
    // (clientWidth / getBoundingClientRect) on every pointermove forces a
    // synchronous reflow and is the main source of drag jank, so we snapshot
    // it once and refresh only on undock (which resizes the panel). `let` for
    // that refresh.
    let parentW = parent.clientWidth;
    let parentH = parent.clientHeight;
    let panelW = panel.clientWidth;
    let panelH = panel.clientHeight;
    let parentRect = parent.getBoundingClientRect();

    // Last clamped position (parent-relative px), baked into left/top on
    // release. `moved` tracks whether we actually repositioned the panel, so a
    // click (or a docked panel that was never dragged) doesn't clobber its
    // resting styles.
    let lastX = startPosX;
    let lastY = startPosY;
    let moved = false;

    // Pointer events can fire several times per frame (and are coalesced); we
    // stash the latest and apply at most once per animation frame, driving the
    // position with a GPU-composited transform (no per-frame layout).
    let latestEvent: PointerEvent | null = null;
    let rafId: number | null = null;

    function applyMove() {
      rafId = null;
      const event = latestEvent;
      const panel = panelWrapperRef.current;
      const parent = panel?.parentElement;
      if (!event || !panel || !parent) return;

      const deltaX = event.clientX - startClientX;
      const deltaY = event.clientY - startClientY;
      if (
        !motionExceedsThreshold(
          [startClientX, startClientY],
          [event.clientX, event.clientY],
        )
      )
        return;

      state.dragging = true;

      // First real motion while docked: undock in place by converting the
      // panel's current on-screen position into a floating position, then
      // continue dragging from there with no jump.
      if (startedDockedSide !== null && !undocked) {
        undocked = true;
        const panelRect = panel.getBoundingClientRect();
        parentRect = parent.getBoundingClientRect();
        setDock({ side: null, width: effectiveWidth });
        applyDockLayout(null);
        const newLeft = panelRect.left - parentRect.left;
        const newTop = panelRect.top - parentRect.top;
        panel.style.left = `${newLeft}px`;
        panel.style.top = `${newTop}px`;
        panel.style.transform = "";
        // The panel's size changes once it stops filling the docked column;
        // refresh the cached geometry so clamping stays correct.
        parentW = parent.clientWidth;
        parentH = parent.clientHeight;
        panelW = panel.clientWidth;
        panelH = panel.clientHeight;
        // Record the floating offset now. The setDock(null) above re-renders and
        // fires the placement layout effect, which resets an *unplaced* panel
        // (unfixedOffset.x === undefined) to the top-right corner -- that's what
        // made an undock-from-left jump across the screen. Seeding the offset
        // marks the panel as already placed so the effect leaves it put.
        unfixedOffset.current = {
          x: computePanelOffset(newLeft, panelW, parentW),
          y: computePanelOffset(newTop, panelH, parentH),
        };
        startPosX = newLeft;
        startPosY = newTop;
        startClientX = event.clientX;
        startClientY = event.clientY;
        lastX = newLeft;
        lastY = newTop;
        return;
      }

      // Clamp the new position to keep the panel within the parent's bounds.
      lastX = Math.max(
        panelBoundaryPad,
        Math.min(startPosX + deltaX, parentW - panelW - panelBoundaryPad),
      );
      lastY = Math.max(
        panelBoundaryPad,
        Math.min(startPosY + deltaY, parentH - panelH - panelBoundaryPad),
      );
      moved = true;
      panel.style.transform = `translate3d(${lastX - startPosX}px, ${
        lastY - startPosY
      }px, 0)`;
      unfixedOffset.current.x = computePanelOffset(lastX, panelW, parentW);
      unfixedOffset.current.y = computePanelOffset(lastY, panelH, parentH);

      // Offer to dock when the pointer is near a left/right edge of the parent
      // AND has moved toward that edge relative to where the drag started.
      // Measuring against the initial click (deltaX) rather than the previous
      // frame means a panel that begins near an edge won't offer to dock there
      // unless the user actually pushes that way -- e.g. the default top-right
      // placement won't dock right just because you start dragging it left.
      let hint: DockSide = null;
      if (event.clientX - parentRect.left < dockThreshold) {
        if (deltaX < 0) hint = "left";
      } else if (parentRect.right - event.clientX < dockThreshold) {
        if (deltaX > 0) hint = "right";
      }
      if (hint !== pendingDock.current) {
        pendingDock.current = hint;
        setDockHint(hint);
      }
    }

    function dragListener(event: PointerEvent) {
      latestEvent = event;
      if (rafId === null) rafId = requestAnimationFrame(applyMove);
    }
    function endListener() {
      detach();
      activeGestureCleanup.current = null;
      if (rafId !== null) {
        // Flush the latest pointer position so the panel lands exactly where it
        // was released, then drop the pending frame.
        cancelAnimationFrame(rafId);
        rafId = null;
        applyMove();
      }
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Already released; ignore.
      }
      // For touch/pen, no click follows to reset this; do it here.
      if (pointerType !== "mouse") state.dragging = false;

      // Bake the drag transform back into left/top and clear it, so the resting
      // panel is a plain offset again (what the ResizeObserver and dock layout
      // expect). Only when we actually moved and aren't about to dock --
      // otherwise leave the docked/initial styles untouched.
      const panel = panelWrapperRef.current;
      if (panel !== null) {
        panel.style.transform = "";
        panel.style.willChange = "";
        if (moved && pendingDock.current === null) {
          panel.style.left = `${lastX}px`;
          panel.style.top = `${lastY}px`;
        }
      }

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
    // Promote to its own layer up front so the first frame is already smooth.
    panel.style.willChange = "transform";
    const detach = bindPointerGesture(dragListener, endListener);
    activeGestureCleanup.current = () => {
      detach();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  };

  // Edges that can be grabbed to resize: when floating, either side; when
  // docked, only the edge facing the canvas.
  const resizeSides: ("left" | "right")[] =
    dock.side === null
      ? ["left", "right"]
      : [dock.side === "left" ? "right" : "left"];
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
      const startParentW = parent.clientWidth;
      // Right edge in parent coordinates; kept pinned when resizing a floating
      // panel from its left edge.
      const startRight = panel.offsetLeft + startWidth;
      // Font size is fixed for the gesture; resolve em -> px once (reading it
      // each move would force a style recalc).
      const emPx = parseFloat(getComputedStyle(panel).fontSize) || 16;
      // Only a floating panel grabbed from its left edge needs special
      // handling; docked panels are anchored to an edge by CSS, and a
      // right-edge grip already keeps the left edge fixed.
      const adjustLeft = dock.side === null && side === "left";
      let lastWidth = startWidth;

      // For a left-edge floating resize, pin the panel by its right edge for the
      // duration of the gesture. The width lands via React state (so the
      // contents reflow) a frame after any imperative `left` update would, so
      // driving `left` directly desyncs the two and jitters the right edge.
      // Anchoring `right` keeps that edge fixed no matter when the width lands;
      // the left edge then simply follows the width.
      if (adjustLeft) {
        panel.style.right = `${startParentW - startRight}px`;
        panel.style.left = "auto";
      }

      // Width updates go through React state (so the contents reflow), which
      // would re-render per pointermove. Coalesce to one update per frame, same
      // as the drag path -- this also caps the docked-resize setDock() calls
      // that re-render the canvas inset.
      let pendingWidth: number | null = null;
      let rafId: number | null = null;
      function flushWidth() {
        rafId = null;
        if (pendingWidth === null) return;
        setWidthOverride(pendingWidth);
        if (dock.side !== null) {
          setDock({ side: dock.side, width: `${pendingWidth}px` });
        }
      }
      function resizeMove(event: PointerEvent) {
        const panel = panelWrapperRef.current;
        const parent = panel?.parentElement;
        if (!panel || !parent) return;
        const delta = event.clientX - startX;
        const rawWidth =
          side === "right" ? startWidth + delta : startWidth - delta;
        const minWidth = minWidthEm * emPx;
        const maxWidth = Math.max(
          minWidth,
          Math.min(maxWidthHardCapPx, parent.clientWidth - resizeParentPad),
        );
        const newWidth = Math.max(minWidth, Math.min(maxWidth, rawWidth));
        lastWidth = newWidth;
        pendingWidth = newWidth;
        if (rafId === null) rafId = requestAnimationFrame(flushWidth);
      }
      function resizeEnd() {
        detach();
        activeGestureCleanup.current = null;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        flushWidth(); // Commit the final width.
        try {
          grip.releasePointerCapture(pointerId);
        } catch {
          // Ignore.
        }
        // Convert the right-edge anchor back to a left offset so dragging and
        // the ResizeObserver (which read offsetLeft) keep working. Derived from
        // the final width so it doesn't depend on React having flushed.
        const panel = panelWrapperRef.current;
        if (adjustLeft && panel !== null) {
          panel.style.left = `${startRight - lastWidth}px`;
          panel.style.right = "auto";
        }
        resizing.current = false;
        // Let the ResizeObserver re-derive the anchored offset from the new size.
        unfixedOffset.current = {};
      }
      const detach = bindPointerGesture(resizeMove, resizeEnd);
      activeGestureCleanup.current = () => {
        detach();
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
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
        data-testid="floating-panel"
        data-dock-side={dock.side ?? "none"}
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
          // `visible` (not `hidden`) so the resize grips can poke past the panel
          // edge; the inner wrapper below clips the actual content to the radius.
          overflow: "visible",
        }}
        ref={panelWrapperRef}
      >
        {/* Invisible resize zones; the ew-resize cursor signals them. They
        straddle the panel edge, so they live outside the clipping wrapper. */}
        {resizeSides.map((side) => (
          <ResizeGrip
            key={side}
            side={side}
            onPointerDown={resizeHandler(side)}
          />
        ))}
        {/* Clips content to the panel's (possibly docked -> square) radius,
        which the Paper used to do before it had to let the grips overflow. */}
        <Box style={{ overflow: "hidden", borderRadius: "inherit" }}>
          {children}
        </Box>
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
      data-testid={`floating-panel-resize-${side}`}
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        // Straddle the border, biased outside the panel, so the grip clears the
        // scrollbar (which sits just inside) while staying easy to grab.
        [side]: `-${resizeGripOutset}`,
        width: resizeGripWidth,
        cursor: "ew-resize",
        zIndex: 12,
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
        opacity: 0.7,
        borderRadius: 0,
      }}
    />
  );
}

/** Handle object helps us hide, show, and drag our panel.*/
FloatingPanel.Handle = function FloatingPanelHandle({
  children,
}: {
  children: React.ReactNode;
}) {
  const panelContext = React.useContext(FloatingPanelContext)!;

  return (
    <Box
      data-testid="floating-panel-handle"
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
  );
};
/** Contents of a panel. */
FloatingPanel.Contents = function FloatingPanelContents({
  children,
}: {
  children: React.ReactNode;
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
