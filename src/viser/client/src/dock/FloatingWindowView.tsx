// Renders one free-floating window: a header handle (drags the whole window), a
// vertical stack of tab groups (the snap group), and edge resize grips (width
// on the sides, height on the bottom). Position is driven from layout state; the
// DockManager applies a transform during an active drag for smoothness.

import { Box, Paper } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { dragGesture, prefersReducedMotion } from "./gestures";
import {
  cappedWindowHeight,
  cascadeResize,
  expandStack,
  minimizeStack,
} from "./layoutOps";
import { StackHandleBar } from "./handles";
import { TabGroupFrame } from "./TabGroupFrame";
import {
  clamp,
  FloatingWindow,
  GroupId,
  MAX_PANEL_WIDTH_PX,
  MIN_REGION_GRAB_PX,
  MIN_WINDOW_HEIGHT_PX,
  TabGroup,
} from "./types";

// A width-resize always leaves this much canvas visible (the original
// FloatingPanel's resizeParentPad).
const RESIZE_KEEP_CANVAS_PX = 100;
const MIN_HEIGHT_PX = MIN_WINDOW_HEIGHT_PX;
// Minimum height for one group in a resizable snap-stack.
const MIN_STACK_CELL_PX = 60;

export const FloatingWindowView = React.memo(function FloatingWindowView({
  win,
  zIndex,
  containerHeight,
  onResize,
  onResizeHeight,
  onSetStackWeights,
  onFront,
}: {
  win: FloatingWindow;
  /** Paint order (front-order). Driven by z-index so raising a window never
   * reorders the DOM (which would eat in-flight clicks). */
  zIndex: number;
  /** Dock container height; auto-height windows cap their scrolling body to
   * it (like the original FloatingPanel capped its body to the parent). */
  containerHeight: number;
  /** width plus, for left-edge resizes, the new x (so the right edge stays).
   * All handlers are windowId-first and STABLE, so this component can be
   * memoized (a re-render of the manager with an unchanged window skips it). */
  onResize: (windowId: string, width: number, x?: number) => void;
  /** Set the window's pinned height in px, or `undefined` to revert it to
   * auto-height (tracks content). */
  onResizeHeight: (windowId: string, height: number | undefined, y?: number) => void;
  /** Merge per-group stack height weights (groupId -> weight). */
  onSetStackWeights: (windowId: string, weights: Record<GroupId, number>) => void;
  onFront: (windowId: string) => void;
}) {
  const dock = useDock();
  const multi = win.stack.length > 1;
  const paperRef = React.useRef<HTMLDivElement>(null);
  const stackRef = React.useRef<HTMLDivElement>(null);
  // A fully-minimized window shrinks to its handle(s); it ignores any fixed
  // height and offers no vertical resize (there's nothing to resize).
  const collapsed = win.stack.every(
    (id) => dock.groups[id]?.collapsed === true,
  );
  const fixedHeight = win.height !== undefined && !collapsed;
  const renderedHeight =
    win.height !== undefined
      ? cappedWindowHeight(win.height, containerHeight)
      : win.height;

  // Animate collapse/expand by FLIP-ing the window height: each render notes
  // the Paper's resting height; when the collapsed state flips we replay the
  // previous height and transition to the new one. ONLY for windows with a
  // pinned height (full-bleed / user-resized), whose body can't be measured by
  // a <Collapse>: auto-height windows let the body's own <Collapse> drive the
  // animation -- FLIP-ing those would measure the target before the Collapse
  // opens and pin the Paper at the still-collapsed height while the expanding
  // content spills out. Resizes update the baseline but don't animate.
  const prevHeightRef = React.useRef<number | null>(null);
  const prevCollapsedRef = React.useRef(collapsed);
  // Cancels the in-flight animation (clears inline styles + listener), if any.
  const flipCancelRef = React.useRef<(() => void) | null>(null);
  React.useLayoutEffect(() => {
    const p = paperRef.current;
    if (p === null) return;
    const flipped = prevCollapsedRef.current !== collapsed;
    prevCollapsedRef.current = collapsed;
    if (win.height === undefined) {
      flipCancelRef.current?.();
      prevHeightRef.current = null;
      return;
    }
    if (!flipped) {
      // Keep the resting baseline fresh (resizes, content changes) -- but not
      // while an animation is in flight, when the inline height would be
      // mistaken for the resting height. Expanded, the resting height IS the
      // pinned win.height (no layout read needed); collapsed (auto-sized to the
      // handles) it has to be measured.
      if (flipCancelRef.current === null)
        prevHeightRef.current = collapsed
          ? p.offsetHeight
          : (renderedHeight ?? null);
      return;
    }
    // If a previous flip is still animating, start the new transition from the
    // current ON-SCREEN height (so a mid-animation re-toggle reverses smoothly)
    // and cancel it so the resting target can be measured.
    const interruptedAt =
      flipCancelRef.current !== null ? p.getBoundingClientRect().height : null;
    flipCancelRef.current?.();
    const target = p.offsetHeight;
    const start = interruptedAt ?? prevHeightRef.current;
    prevHeightRef.current = target;
    if (start === null || Math.abs(start - target) < 1) return;
    if (prefersReducedMotion()) return;
    // ONE WRITER PER STYLE PROPERTY: React owns `height` (it renders the
    // pinned renderedHeight), so the animation drives min-height/max-height
    // -- properties React never writes on the Paper. Pinning both forces the
    // box through the transition in either direction, and clearing them on
    // cancel hands control back cleanly BY CONSTRUCTION: there is no React
    // style-cache entry for them to disagree with. (Animating `height` here
    // and "handing it back" by clearing the inline value left the window at
    // 0px: React's cache still held the old height, so it never re-wrote it.)
    p.style.transition = "none";
    p.style.minHeight = `${start}px`;
    p.style.maxHeight = `${start}px`;
    void p.offsetHeight; // force a reflow so the start height takes effect
    p.style.transition = "min-height 180ms ease, max-height 180ms ease";
    p.style.minHeight = `${target}px`;
    p.style.maxHeight = `${target}px`;
    const cancel = () => {
      flipCancelRef.current = null;
      p.style.transition = "";
      p.style.minHeight = "";
      p.style.maxHeight = "";
      p.removeEventListener("transitionend", onEnd);
    };
    const onEnd = (e: TransitionEvent) => {
      // Child transitions bubble; only our own animation ends the FLIP (both
      // pinned properties finish together -- listen for one of them).
      if (e.target === p && e.propertyName === "max-height") cancel();
    };
    flipCancelRef.current = cancel;
    p.addEventListener("transitionend", onEnd);
  });
  // Clear in-flight animation styles/listener if the window unmounts mid-flip.
  React.useEffect(() => () => flipCancelRef.current?.(), []);

  // Cancel an in-flight grip gesture if this window unmounts mid-resize (e.g.
  // another client docks it away), so its listeners can't fire afterwards. One
  // ref serves all grips: only one resize gesture may be active per window (a
  // second finger on another grip is ignored while one is running).
  const activeGrip = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => activeGrip.current?.(), []);

  // Container-relative width cap: like the original FloatingPanel, a resize
  // always leaves a sliver of canvas visible (it may never consume the whole
  // container), on top of the absolute MAX_PANEL_WIDTH_PX.
  const maxResizeWidth = () => {
    const containerW = paperRef.current?.parentElement?.clientWidth ?? Infinity;
    return Math.max(
      MIN_REGION_GRAB_PX,
      Math.min(MAX_PANEL_WIDTH_PX, containerW - RESIZE_KEEP_CANVAS_PX),
    );
  };

  const widthResizeHandler =
    (side: "left" | "right") =>
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (activeGrip.current !== null) return;
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = win.width;
      // Right edge in parent coords; held fixed when resizing from the left.
      const startRight = win.x + win.width;
      const maxW = maxResizeWidth();

      let pending = startWidth;
      let pendingX: number | undefined = undefined;
      activeGrip.current = dragGesture({
        grip: event.currentTarget,
        pointerId: event.pointerId,
        update: (e) => {
          const delta = e.clientX - startX;
          const raw = side === "right" ? startWidth + delta : startWidth - delta;
          pending = clamp(raw, MIN_REGION_GRAB_PX, maxW);
          // Left-edge resize: keep the right edge fixed by moving x.
          pendingX = side === "left" ? startRight - pending : undefined;
        },
        flush: () => onResize(win.id, pending, pendingX),
        onEnd: (cancelled) => {
          activeGrip.current = null;
          // Cancel (Escape) reverts the per-frame resizes to the start size.
          if (cancelled)
            onResize(
              win.id,
              startWidth,
              side === "left" ? startRight - startWidth : undefined,
            );
        },
      });
    };

  // Largest height the panel may take: the smaller of the container and the
  // natural content height (so it can't be dragged taller than its contents).
  // scrollHeight on each scroll viewport gives its full uncapped content; the
  // rest of the paper (strips, headers, dividers, borders) is chrome.
  // The window's NATURAL content height: what it would auto-size to. The paper
  // minus each scroll viewport's visible (client) height plus its full
  // (scroll) content -- i.e. chrome + uncapped content. Used as both the resize
  // FLOOR (a panel must be shrinkable back to its content, even when that's
  // below MIN_HEIGHT_PX) and the revert-to-auto threshold below.
  const measureContentHeight = () => {
    const paper = paperRef.current;
    if (paper === null) return MIN_HEIGHT_PX;
    let scrollSum = 0;
    let clientSum = 0;
    paper.querySelectorAll(".mantine-ScrollArea-viewport").forEach((v) => {
      scrollSum += (v as HTMLElement).scrollHeight;
      clientSum += (v as HTMLElement).clientHeight;
    });
    return paper.offsetHeight - clientSum + scrollSum;
  };

  const measureMaxHeight = () => {
    const paper = paperRef.current;
    const containerMax = (paper?.parentElement?.clientHeight ?? 2000) - 16;
    if (paper === null) return containerMax;
    return clamp(measureContentHeight(), MIN_HEIGHT_PX, containerMax);
  };

  // Px tolerance for "dragged back to the content height" -- absorbs sub-pixel
  // rounding and scrollbar width so the revert-to-auto reliably triggers.
  const AUTO_REVERT_EPSILON_PX = 4;

  // Start-of-gesture math shared by every vertical resize: top-side grips
  // hold the BOTTOM edge fixed by moving y with the height (the vertical
  // analog of a left-edge width resize), with the height additionally capped
  // at the start bottom so the top edge can't leave the container.
  const vResizeStart = (vside: "top" | "bottom") => {
    const startHeight = paperRef.current?.offsetHeight ?? win.height ?? 200;
    const startBottom = win.y + startHeight;
    const contentHeight = measureContentHeight();
    const maxHeight =
      vside === "top"
        ? Math.min(measureMaxHeight(), startBottom)
        : measureMaxHeight();
    // Floor at the content height when it's below MIN_HEIGHT_PX, so a short
    // panel (e.g. one button) can shrink back to its natural size rather than
    // being trapped at the 100px minimum.
    const minHeight = Math.min(MIN_HEIGHT_PX, contentHeight);
    return {
      startHeight,
      heightFrom: (dy: number) =>
        clamp(
          vside === "top" ? startHeight - dy : startHeight + dy,
          minHeight,
          maxHeight,
        ),
      yFor: (h: number) => (vside === "top" ? startBottom - h : undefined),
      // At/above the natural content height -> revert to auto (undefined) so the
      // window tracks its content again instead of pinning a height the user
      // can't escape. Otherwise pin the dragged height.
      heightToCommit: (h: number): number | undefined =>
        h >= contentHeight - AUTO_REVERT_EPSILON_PX ? undefined : h,
    };
  };

  const heightResizeHandler =
    (vside: "top" | "bottom") =>
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (activeGrip.current !== null) return;
      event.stopPropagation();
      const startY = event.clientY;
      const { startHeight, heightFrom, yFor, heightToCommit } =
        vResizeStart(vside);

      let pending = startHeight;
      activeGrip.current = dragGesture({
        grip: event.currentTarget,
        pointerId: event.pointerId,
        update: (e) => {
          pending = heightFrom(e.clientY - startY);
        },
        flush: () =>
          onResizeHeight(win.id, heightToCommit(pending), yFor(pending)),
        onEnd: (cancelled) => {
          activeGrip.current = null;
          if (cancelled)
            onResizeHeight(win.id, startHeight, yFor(startHeight));
        },
      });
    };

  // Corner grips: resize width AND height together. The grabbed corner moves;
  // the opposite edges stay fixed (left grab moves x, top grab moves y).
  const cornerResizeHandler =
    (side: "left" | "right", vside: "top" | "bottom" = "bottom") =>
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (activeGrip.current !== null) return;
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = win.width;
      const startRight = win.x + win.width;
      const { startHeight, heightFrom, yFor, heightToCommit } =
        vResizeStart(vside);
      const maxW = maxResizeWidth();

      let pendingW = startWidth;
      let pendingX: number | undefined = undefined;
      let pendingH = startHeight;
      activeGrip.current = dragGesture({
        grip: event.currentTarget,
        pointerId: event.pointerId,
        update: (e) => {
          const dx = e.clientX - startX;
          const raw = side === "right" ? startWidth + dx : startWidth - dx;
          pendingW = clamp(raw, MIN_REGION_GRAB_PX, maxW);
          pendingX = side === "left" ? startRight - pendingW : undefined;
          pendingH = heightFrom(e.clientY - startY);
        },
        flush: () => {
          onResize(win.id, pendingW, pendingX);
          onResizeHeight(win.id, heightToCommit(pendingH), yFor(pendingH));
        },
        onEnd: (cancelled) => {
          activeGrip.current = null;
          if (cancelled) {
            onResize(
              win.id,
              startWidth,
              side === "left" ? startRight - startWidth : undefined,
            );
            onResizeHeight(win.id, startHeight, yFor(startHeight));
          }
        },
      });
    };

  return (
    <Paper
      ref={paperRef}
      data-floating-window={win.id}
      // Matches the live FloatingPanel's subtle shadow exactly.
      shadow="0.1em 0 1em 0 rgba(0,0,0,0.1)"
      radius="sm"
      onPointerDownCapture={() => onFront(win.id)}
      style={{
        position: "absolute",
        left: win.x,
        top: win.y,
        width: win.width,
        height: collapsed ? undefined : renderedHeight,
        zIndex,
        overflow: "visible",
        boxSizing: "border-box",
        // When height is fixed, lay the stack out as a flex column so groups
        // share the height and scroll internally.
        ...(fixedHeight
          ? { display: "flex", flexDirection: "column" as const }
          : {}),
      }}
    >
      {/* Edge resize grips. */}
      <ResizeGrip edge="left" onPointerDown={widthResizeHandler("left")} />
      <ResizeGrip edge="right" onPointerDown={widthResizeHandler("right")} />
      {/* No vertical / corner resize when minimized -- nothing to resize. */}
      {!collapsed && (
        <>
          <ResizeGrip
            edge="bottom"
            onPointerDown={heightResizeHandler("bottom")}
          />
          <ResizeGrip edge="top" onPointerDown={heightResizeHandler("top")} />
          <ResizeGrip
            edge="bottom-left"
            onPointerDown={cornerResizeHandler("left")}
          />
          <ResizeGrip
            edge="bottom-right"
            onPointerDown={cornerResizeHandler("right")}
          />
          <ResizeGrip
            edge="top-left"
            onPointerDown={cornerResizeHandler("left", "top")}
          />
          <ResizeGrip
            edge="top-right"
            onPointerDown={cornerResizeHandler("right", "top")}
          />
        </>
      )}

      <Box
        style={{
          overflow: "hidden",
          borderRadius: "inherit",
          ...(fixedHeight
            ? {
                flexGrow: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column" as const,
              }
            : {}),
        }}
      >
        {/* For a multi-group stack, a window header drags the whole window; each
        group also keeps its own grip bar (which tears it out). A single group
        needs no header -- its own grip bar moves the window. The header's
        minimize-all button collapses every group at once (and restores the
        previous min/max mix on expand). */}
        {multi && (
          <StackHandleBar
            attrs={{ "data-floating-handle": win.id }}
            onPointerDown={(event) => dock.startWindowDrag(event, win.id)}
            collapsed={collapsed}
            onToggle={() =>
              dock.api.apply((l) =>
                collapsed
                  ? expandStack(l, win.stack)
                  : minimizeStack(l, win.stack),
              )
            }
          />
        )}

        <Box
          ref={stackRef}
          style={
            fixedHeight
              ? {
                  flexGrow: 1,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                }
              : {}
          }
        >
          {win.stack.map((groupId, index) => {
            const group = dock.groups[groupId];
            if (group === undefined) return null;
            const collapsedCell = group.collapsed === true;
            const weight = win.stackWeights?.[groupId] ?? 1;
            const groupNode = (
              <TabGroupFrame
                group={group}
                // Fixed-height windows: groups fill and share the height (the
                // wrapper carries the per-group weight). Auto-height: size to
                // content, capped to the dock container's height (minus a
                // margin) like the original FloatingPanel -- falling back to a
                // fixed cap before the first container measure.
                fill={fixedHeight}
                maxContentHeight={
                  multi
                    ? 320
                    : containerHeight > 0
                      ? Math.max(200, containerHeight - 30)
                      : 600
                }
                stripDragsGroup
              />
            );
            return (
              <React.Fragment key={groupId}>
                {index > 0 && (
                  // Draggable: redistribute height between the stacked groups
                  // (same cascade as docked column splits). On an auto-height
                  // window the first drag pins the current height so there is a
                  // total to divide.
                  <FloatingStackDivider
                    stackRef={stackRef}
                    dividerIndex={index - 1}
                    stack={win.stack}
                    groups={dock.groups}
                    weightOf={(g) => win.stackWeights?.[g] ?? 1}
                    onSetWeights={(weights) => onSetStackWeights(win.id, weights)}
                    isFixed={fixedHeight}
                    pinHeight={() => {
                      const p = paperRef.current;
                      if (p) onResizeHeight(win.id, p.offsetHeight);
                    }}
                  />
                )}
                {fixedHeight ? (
                  <Box
                    style={{
                      flexGrow: collapsedCell ? 0 : weight,
                      flexShrink: collapsedCell ? 0 : 1,
                      flexBasis: collapsedCell ? "auto" : 0,
                      minHeight: 0,
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    {groupNode}
                  </Box>
                ) : (
                  groupNode
                )}
              </React.Fragment>
            );
          })}
        </Box>
      </Box>
    </Paper>
  );
});

/** Draggable divider between two groups in a fixed-height floating snap-stack.
 * Redistributes height between the stacked groups using the same cascade as
 * docked column splits, writing per-group weights (by id). */
function FloatingStackDivider({
  stackRef,
  dividerIndex,
  stack,
  groups,
  weightOf,
  onSetWeights,
  isFixed,
  pinHeight,
}: {
  stackRef: React.RefObject<HTMLDivElement>;
  dividerIndex: number;
  stack: GroupId[];
  groups: Record<GroupId, TabGroup>;
  weightOf: (g: GroupId) => number;
  onSetWeights: (weights: Record<GroupId, number>) => void;
  /** Whether the window already has a fixed height (so weights apply directly).
   * If false, the first drag pins the current rendered height. */
  isFixed: boolean;
  pinHeight: () => void;
}) {
  const { setResizing } = useDock();
  // Cancel the in-flight gesture if the divider unmounts mid-drag (the stack
  // can be restructured by another client), so the window listeners can't fire
  // after unmount and the shared `resizing` flag can't stick true.
  const activeDrag = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => activeDrag.current?.(), []);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (activeDrag.current !== null) return; // one drag per divider
    event.stopPropagation();
    const container = stackRef.current;
    if (container === null) return;
    const containerPx = container.getBoundingClientRect().height;
    // Auto-height window: pin the current height so there's a total to divide
    // (re-renders to fixed-height with weighted cells). Capturing happens after,
    // on the persistent grip element.
    if (!isFixed) pinHeight();
    setResizing(true);
    const start = event.clientY;
    let latest = start;
    // Drag-start weights so a cancel (Escape) can put them back.
    const startWeights: Record<string, number> = {};
    stack.forEach((g) => {
      startWeights[g] = weightOf(g);
    });
    activeDrag.current = dragGesture({
      grip: event.currentTarget,
      pointerId: event.pointerId,
      update: (e) => {
        latest = e.clientY;
      },
      flush: () => {
        const collapsed = stack.map((g) => groups[g]?.collapsed === true);
        const next = cascadeResize({
          weights: stack.map((g) => weightOf(g)),
          collapsed,
          containerPx,
          dividerIndex,
          deltaPx: latest - start,
          minCell: MIN_STACK_CELL_PX,
          maxCell: Infinity,
        });
        if (next === null) return;
        const wmap: Record<string, number> = {};
        stack.forEach((g, i) => {
          if (!collapsed[i]) wmap[g] = next[i];
        });
        onSetWeights(wmap);
      },
      onEnd: (cancelled) => {
        activeDrag.current = null;
        setResizing(false);
        if (cancelled) onSetWeights(startWeights);
      },
    });
  };
  return (
    <Box
      data-floating-divider={dividerIndex}
      onPointerDown={onPointerDown}
      style={{
        flexShrink: 0,
        height: "7px",
        cursor: "ns-resize",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        touchAction: "none",
        zIndex: 2,
      }}
    >
      <Box
        style={{
          height: "1px",
          width: "100%",
          backgroundColor: "var(--mantine-color-default-border)",
          opacity: 0.5,
        }}
      />
    </Box>
  );
}

function ResizeGrip({
  edge,
  onPointerDown,
}: {
  edge:
    | "left"
    | "right"
    | "top"
    | "bottom"
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right";
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  // Corners win over edges (higher z) so the diagonal cursor + combined resize
  // take priority where they overlap.
  const corner = edge.includes("-");
  const position: React.CSSProperties = corner
    ? {
        [edge.startsWith("top") ? "top" : "bottom"]: "-3px",
        [edge.endsWith("left") ? "left" : "right"]: "-3px",
        width: "14px",
        height: "14px",
      }
    : edge === "bottom" || edge === "top"
      ? { left: 0, right: 0, [edge]: "-3px", height: "8px" }
      : { top: 0, bottom: 0, [edge]: "-3px", width: "8px" };
  const cursor = corner
    ? edge === "bottom-left" || edge === "top-right"
      ? "nesw-resize"
      : "nwse-resize"
    : edge === "bottom" || edge === "top"
      ? "ns-resize"
      : "ew-resize";
  return (
    <Box
      data-dock-resize={edge}
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        ...position,
        cursor,
        zIndex: corner ? 13 : 12,
        touchAction: "none",
      }}
    />
  );
}
