// Renders one free-floating window: a header handle (drags the whole window), a
// vertical stack of tab groups (the snap group), and edge resize grips (width
// on the sides, height on the bottom). Position is driven from layout state; the
// DockManager applies a transform during an active drag for smoothness.

import { Box, Paper } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { dragGesture } from "./gestures";
import {
  cappedWindowHeight,
  cascadeResize,
  expandStack,
  minimizeStack,
  windowAllMinimized,
} from "./layoutOps";
import { gripBarBg } from "./DockStyles.css";
import { ChromeToggle, GripPill, StackHandleBar } from "./handles";
import { TabGroupFrame } from "./TabGroupFrame";
import { ChipDivider, MinimizedGroupChip } from "./HorizontalMinimizedBand";
import {
  clamp,
  FloatingWindow,
  GroupId,
  MIN_REGION_GRAB_PX,
  MIN_WINDOW_HEIGHT_PX,
  MINIMIZED_BAR_PX,
  pinnedPxOf,
  TabGroup,
} from "./types";

// A width-resize always leaves this much canvas visible (the original
// FloatingPanel's resizeParentPad).
const RESIZE_KEEP_CANVAS_PX = 100;
const MIN_HEIGHT_PX = MIN_WINDOW_HEIGHT_PX;
// Minimum height for one group in a resizable snap-stack.
const MIN_STACK_CELL_PX = 50;

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
  const collapsed = windowAllMinimized(dock.layout, win.id);
  // Minimize-all / expand-all for the whole stack (a stack is uniform-collapse).
  // Shared by the expanded header and the minimized-strip parent handle.
  const toggleAll = () =>
    dock.api.apply((l) =>
      collapsed ? expandStack(l, win.stack) : minimizeStack(l, win.stack),
    );
  // The pinned px height, or undefined when the window auto-sizes to content.
  // flex-grow sums < 1 distribute only that FRACTION of free space;
  // stackWeights from floatRegion/floatBand carving are fractional, so
  // normalize (see SplitView's band note).
  const stackWeightTotal =
    win.stack.reduce((s2, g) => s2 + (win.stackWeights?.[g] ?? 1), 0) || 1;
  const pinnedPx = pinnedPxOf(win.height);
  const fixedHeight = pinnedPx !== undefined && !collapsed;
  const renderedHeight =
    pinnedPx !== undefined
      ? cappedWindowHeight(pinnedPx, containerHeight)
      : undefined;

  // Cancel an in-flight grip gesture if this window unmounts mid-resize (e.g.
  // another client docks it away), so its listeners can't fire afterwards. One
  // ref serves all grips: only one resize gesture may be active per window (a
  // second finger on another grip is ignored while one is running).
  const activeGrip = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => activeGrip.current?.(), []);
  // True while a height resize is magnetized to the content-height detent (the
  // "revert to auto" position). Drives the bottom-edge highlight so the snap is
  // visible. Reset when the gesture ends.
  const [snappedToContent, setSnappedToContent] = React.useState(false);

  // Container-relative width cap: like the original FloatingPanel, a resize
  // always leaves a sliver of canvas visible (it may never consume the whole
  // container). There is no absolute max width -- the only ceiling is the
  // container minus a canvas sliver.
  const maxResizeWidth = () => {
    const containerW = paperRef.current?.parentElement?.clientWidth ?? Infinity;
    return Math.max(MIN_REGION_GRAB_PX, containerW - RESIZE_KEEP_CANVAS_PX);
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

  // The window's NATURAL content height: what it would auto-size to, INVARIANT
  // of the current window height. For each scroll viewport, the chrome around it
  // (paper - viewport client) plus the viewport's CONTENT wrapper height. We use
  // the `.mantine-ScrollArea-content` wrapper's offsetHeight, NOT the viewport's
  // scrollHeight: when the window is TALLER than its content the viewport
  // stretches and scrollHeight collapses to clientHeight (== the window height),
  // so scrollHeight would wrongly report "content == current height" and the
  // revert-to-auto detent would fire everywhere. The content wrapper keeps its
  // true height regardless. Used as the resize FLOOR and the detent target.
  const measureContentHeight = () => {
    const paper = paperRef.current;
    if (paper === null) return MIN_HEIGHT_PX;
    let contentSum = 0;
    let clientSum = 0;
    paper.querySelectorAll(".mantine-ScrollArea-viewport").forEach((v) => {
      const content = v.querySelector<HTMLElement>(".mantine-ScrollArea-content");
      contentSum += content?.offsetHeight ?? (v as HTMLElement).scrollHeight;
      clientSum += (v as HTMLElement).clientHeight;
    });
    return paper.offsetHeight - clientSum + contentSum;
  };

  // The resize ceiling is the CONTAINER edge only -- never the content height.
  // A window (single panel OR stack) can be dragged taller than its content;
  // the extra space is empty for a lone panel and shared by weight in a stack,
  // exactly like a docked panel filling its region. (Previously content height
  // was the max, so a freshly-floated stack snapped SMALLER when grown.)
  const measureMaxHeight = () => {
    const paper = paperRef.current;
    return (paper?.parentElement?.clientHeight ?? 2000) - 16;
  };

  // Magnetic detent at the natural content height: dragging the edge within this
  // band of the content height snaps it exactly there, which is the single
  // "revert to auto" position (the window then tracks its content again). The
  // grip highlights while snapped so the snap is discoverable.
  const CONTENT_SNAP_BAND_PX = 12;

  // Start-of-gesture math shared by every vertical resize: top-side grips
  // hold the BOTTOM edge fixed by moving y with the height (the vertical
  // analog of a left-edge width resize), with the height additionally capped
  // at the start bottom so the top edge can't leave the container.
  const vResizeStart = (vside: "top" | "bottom") => {
    const startHeight = paperRef.current?.offsetHeight ?? pinnedPx ?? 200;
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
    // The content-height detent only exists when content fits the resize range
    // (it can be outside it for a top grip whose bottom edge is fixed, or when
    // content is below the min floor).
    const contentReachable =
      contentHeight >= minHeight && contentHeight <= maxHeight;
    // True when `h` landed in the detent (so it equals content height).
    const snappedToContent = (h: number) =>
      contentReachable && Math.abs(h - contentHeight) < 0.5;
    return {
      startHeight,
      heightFrom: (dy: number) => {
        const raw = clamp(
          vside === "top" ? startHeight - dy : startHeight + dy,
          minHeight,
          maxHeight,
        );
        // Magnetize to the content height when within the snap band.
        return contentReachable &&
          Math.abs(raw - contentHeight) <= CONTENT_SNAP_BAND_PX
          ? contentHeight
          : raw;
      },
      snappedToContent,
      yFor: (h: number) => (vside === "top" ? startBottom - h : undefined),
      // Snapped to the content detent -> revert to auto (undefined) so the
      // window tracks its content again. Any other height pins (taller =
      // empty/weight-shared space; shorter = the body scrolls).
      heightToCommit: (h: number): number | undefined =>
        snappedToContent(h) ? undefined : h,
    };
  };

  const heightResizeHandler =
    (vside: "top" | "bottom") =>
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (activeGrip.current !== null) return;
      event.stopPropagation();
      const startY = event.clientY;
      const { startHeight, heightFrom, snappedToContent, yFor, heightToCommit } =
        vResizeStart(vside);

      let pending = startHeight;
      activeGrip.current = dragGesture({
        grip: event.currentTarget,
        pointerId: event.pointerId,
        update: (e) => {
          pending = heightFrom(e.clientY - startY);
          setSnappedToContent(snappedToContent(pending));
        },
        flush: () =>
          onResizeHeight(win.id, heightToCommit(pending), yFor(pending)),
        onEnd: (cancelled) => {
          activeGrip.current = null;
          setSnappedToContent(false);
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
      const { startHeight, heightFrom, snappedToContent, yFor, heightToCommit } =
        vResizeStart(vside);
      const maxW = maxResizeWidth();

      let pendingW = startWidth;
      let pendingX: number | undefined = undefined;
      let pendingH = startHeight;
      // Suppress the width-ease while dragging the corner (width tracks 1:1).
      activeGrip.current = dragGesture({
        grip: event.currentTarget,
        pointerId: event.pointerId,
        update: (e) => {
          const dx = e.clientX - startX;
          const raw = side === "right" ? startWidth + dx : startWidth - dx;
          pendingW = clamp(raw, MIN_REGION_GRAB_PX, maxW);
          pendingX = side === "left" ? startRight - pendingW : undefined;
          pendingH = heightFrom(e.clientY - startY);
          setSnappedToContent(snappedToContent(pendingH));
        },
        flush: () => {
          onResize(win.id, pendingW, pendingX);
          onResizeHeight(win.id, heightToCommit(pendingH), yFor(pendingH));
        },
        onEnd: (cancelled) => {
          activeGrip.current = null;
          setSnappedToContent(false);
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
        // A fully-minimized window renders as a compact horizontal CHIP BAR
        // (the same look as a minimized docked band) sized to its chips.
        // win.width is preserved in the model for restore on expand.
        // P13/D10: the minimized bar keeps the window's width -- the width
        // is part of the window's identity (P8); no fit-content jump.
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
      {/* Edge resize grips. None when minimized -- the strip is fixed-size
      chrome, nothing to resize VERTICALLY -- but width stays resizable
      (D15): the minimized bar keeps win.width (P8), and that width is
      user-adjustable in either state. */}
      <ResizeGrip edge="left" onPointerDown={widthResizeHandler("left")} />
      <ResizeGrip edge="right" onPointerDown={widthResizeHandler("right")} />
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

      {/* Snap cue: while a height resize is magnetized to the content-height
      detent (the "revert to auto" position), highlight the bottom edge so the
      snap is visible -- the window is back to hugging its content. */}
      {snappedToContent && (
        <Box
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 2,
            backgroundColor: "var(--mantine-primary-color-filled)",
            zIndex: 14,
            pointerEvents: "none",
          }}
        />
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
        {collapsed ? (
          // Fully-minimized FLOATING window: the window's header row kept in
          // place (P13) at full win.width -- grip pill (window-drag
          // signifier), group label runs with dividers, background slack,
          // and ONE ChromeToggle at the right end (P9: uniform-collapse
          // makes any expand window-level). Presses on the bar (and drag-
          // through on the toggle) drag the window; motionless clicks
          // expand every group.
          <Box
            className={gripBarBg}
            onPointerDown={(event) =>
              dock.startWindowDrag(event, win.id, { onClick: toggleAll })
            }
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "stretch",
              height: MINIMIZED_BAR_PX,
              cursor: "grab",
              touchAction: "none",
              userSelect: "none",
              WebkitUserSelect: "none",
            }}
          >

            {win.stack.map((groupId, i) => {
              const group = dock.groups[groupId];
              if (group === undefined) return null;
              return (
                <React.Fragment key={groupId}>
                  {i > 0 && <ChipDivider />}
                  {/* data-dock-chip-cell: the group's DROP rect spans the
                  full bar height (no dead strips above/below labels). */}
                  <Box
                    data-dock-chip-cell="true"
                    style={{
                      height: "100%",
                      display: "flex",
                      alignItems: "stretch",
                      minWidth: 0,
                    }}
                  >
                    <MinimizedGroupChip group={group} withToggle={false} />
                  </Box>
                </React.Fragment>
              );
            })}
            {/* WINDOW-scope pill, centered in the free run like the
            expanded StackHandleBar's centered pill (P13: no position jump)
            and STRONGER than any per-group pill, ranking the drag scopes. */}
            <Box style={{ flexGrow: 1 }} />
            <Box
              data-dock-window-pill={win.id}
              style={{ display: "flex", alignItems: "center", flexShrink: 0 }}
            >
              <GripPill width="2.2em" opacity={0.65} strong />
            </Box>
            <Box style={{ flexGrow: 1 }} />
            <ChromeToggle
              expanded={false}
              label="Expand panels"
              onActivate={toggleAll}
            />
          </Box>
        ) : (
        <>
        {/* For a multi-group stack, a window header drags the whole window; each
        group also keeps its own grip bar (which tears it out). A single group
        needs no header -- its own grip bar moves the window. The header's
        minimize-all button collapses every group at once (and restores the
        previous min/max mix on expand). A motionless press toggles (via the
        drag-starter's onClick, since the + is dragThrough); motion drags. */}
        {multi && (
          <StackHandleBar
            attrs={{ "data-floating-handle": win.id }}
            onPointerDown={(event) =>
              dock.startWindowDrag(event, win.id, { onClick: toggleAll })
            }
            collapsed={collapsed}
            onToggle={toggleAll}
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
                  // If the pinned height is too short to fit every cell at its
                  // min-content (e.g. a 3-panel stack squeezed very short), the
                  // stack SCROLLS rather than letting cells collapse below their
                  // headers and overlap each other.
                  overflowY: "auto",
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
                      flexGrow: collapsedCell ? 0 : weight / stackWeightTotal,
                      flexShrink: collapsedCell ? 0 : 1,
                      flexBasis: collapsedCell ? "auto" : 0,
                      // Never shrink below a cell's header: minHeight:0 let an
                      // over-short window collapse a cell under its header,
                      // clipping it and overlapping the next cell. Floor at the
                      // min stack-cell height; the stack scrolls when the sum
                      // exceeds the window.
                      minHeight: collapsedCell ? 0 : MIN_STACK_CELL_PX,
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
        </>
        )}
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
  // Grab areas are absolute overlays (no layout impact), biased OUTWARD past the
  // window edge so they're easy to hit without eating into content near the
  // border: edges ~12px (7 outside + 5 inside), corners ~18px. Corners win over
  // edges (higher z) where they overlap.
  const corner = edge.includes("-");
  const position: React.CSSProperties = corner
    ? {
        [edge.startsWith("top") ? "top" : "bottom"]: "-7px",
        [edge.endsWith("left") ? "left" : "right"]: "-7px",
        width: "18px",
        height: "18px",
      }
    : edge === "bottom" || edge === "top"
      ? { left: 0, right: 0, [edge]: "-7px", height: "12px" }
      : { top: 0, bottom: 0, [edge]: "-7px", width: "12px" };
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
