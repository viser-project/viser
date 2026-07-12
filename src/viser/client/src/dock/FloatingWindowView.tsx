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
import { StackHandleBar } from "./handles";
import { TabGroupFrame } from "./TabGroupFrame";
import { collapseAnim, windowCollapseAnim } from "./DockStyles.css";
import { MinimizedBar } from "./MinimizedBar";
import {
  collapsedWindowHeightCss,
  clamp,
  FloatingWindow,
  GroupId,
  MIN_REGION_GRAB_PX,
  MIN_WINDOW_HEIGHT_PX,
  SPLIT_DIVIDER_PX,
  pinnedPxOf,
} from "./types";

// A width-resize always leaves this much canvas visible (the original
// FloatingPanel's resizeParentPad).
const RESIZE_KEEP_CANVAS_PX = 100;
const MIN_HEIGHT_PX = MIN_WINDOW_HEIGHT_PX;
// Minimum height for one group in a resizable snap-stack.
const MIN_STACK_CELL_PX = 50;
// The stack divider's invisible grab overlay overhangs its 7px layout seam on
// each side, widening the grab zone to ~12px (P11 zone floor is 8px; the
// docked analog grabs ~12px) without thickening the drawn seam: (12 - 7) / 2.
const DIVIDER_OVERHANG_PX = 2.5;

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
  onResizeHeight: (
    windowId: string,
    height: number | undefined,
    y?: number,
  ) => void;
  /** Merge per-group stack height weights (groupId -> weight). */
  onSetStackWeights: (
    windowId: string,
    weights: Record<GroupId, number>,
  ) => void;
  onFront: (windowId: string) => void;
}) {
  const dock = useDock();
  const multi = win.stack.length > 1;
  const paperRef = React.useRef<HTMLDivElement>(null);
  const stackRef = React.useRef<HTMLDivElement>(null);
  // A collapsed window shrinks to its stack of bars; it ignores any fixed
  // height and offers no vertical resize (there's nothing to resize).
  const collapsed = windowAllMinimized(dock.layout, win.id);
  // The window's ONE collapse toggle (D38): the header's right-end control
  // (multi-group windows; a single-group window's grip bar toggle sets the
  // same flag). Plain collapse/expand of the window -- the old "minimize
  // all / expand all" pair is simply this toggle.
  const toggleWindowCollapsed = () =>
    dock.api.apply((l) =>
      collapsed ? expandStack(l, win.stack) : minimizeStack(l, win.stack),
    );
  // The pinned px height, or undefined when the window auto-sizes to content.
  // flex-grow sums < 1 distribute only that FRACTION of free space;
  // stackWeights from floatRegion carving are fractional, so
  // normalize (see SplitView's grow-normalization note).
  const stackWeightTotal =
    win.stack.reduce((s2, g) => s2 + (win.stackWeights?.[g] ?? 1), 0) || 1;
  const pinnedPx = pinnedPxOf(win.height);
  const fixedHeight = pinnedPx !== undefined && !collapsed;
  const renderedHeight =
    pinnedPx !== undefined
      ? cappedWindowHeight(pinnedPx, containerHeight)
      : undefined;
  // The collapsed window's height as a deterministic calc() (header + bars +
  // dividers) rather than `auto`: it gives the D34 height transition an
  // honest numeric endpoint, so collapsing a PINNED window eases px -> calc
  // and expanding eases back. (An AUTO-height window's expanded height is
  // `auto`, which CSS cannot interpolate -- that direction snaps; see the
  // windowCollapseAnim note.)
  const collapsedHeight = collapsed
    ? collapsedWindowHeightCss(
        win.stack.map((g) => dock.groups[g]),
        dock.panes,
      )
    : undefined;

  // D34 for AUTO-height windows ONLY: CSS cannot interpolate height to
  // `auto`, so a collapse/expand of an unpinned window snapped. Ease it
  // with a Web Animations API height animation (el.animate old px -> new
  // px) instead of a style-channel FLIP: the script animation composites
  // ABOVE the style attribute, so React re-renders rewriting the Paper's
  // style prop cannot wipe the in-flight motion (the old FLIP needed a
  // target token re-asserted every render), and it outranks the class's
  // CSS height transition, so windowCollapseAnim cannot collide with it.
  // The Animation object's own finish/cancel callbacks replace the old
  // transition-event forensics (bubbled-event filtering, transitioncancel
  // guards, getAnimations probing). Presentation only (P4): the model
  // committed first, and the callbacks do cosmetic cleanup only. Reduced
  // motion and an active grip drag (the paper's own [data-dock-resizing])
  // skip it; a rapid re-toggle cancels the held Animation and retargets
  // from the live mid-ease rect.
  //
  // PINNED windows must NOT get the script animation: both of their
  // committed endpoints are already numeric (px <-> the bars' calc()), so
  // windowCollapseAnim eases the commit natively -- a WAAPI animation
  // armed on top would outrank and freeze that transition. Skipping
  // pinned windows keeps their native ease exactly as before.
  const prevPaperH = React.useRef<number | null>(null);
  // The in-flight auto-height Animation (plus its target px, the honest
  // "where did it settle" fallback for the moment between the animation
  // finishing and its finish event delivering), held so the next toggle
  // can cancel it and retarget. The handle IS the flip: no id token
  // needed, because canceling it can't be confused with anyone else's
  // events.
  const heightAnim = React.useRef<{ anim: Animation; toPx: number } | null>(
    null,
  );
  React.useLayoutEffect(() => {
    const el = paperRef.current;
    if (el === null) return;
    // Pinned windows: the class transition eases px <-> calc natively
    // (see the block comment above). Drop any auto-height animation a
    // same-commit pin interrupted, so nothing outranks that transition.
    if (pinnedPx !== undefined) {
      if (heightAnim.current !== null) {
        const held = heightAnim.current;
        heightAnim.current = null;
        held.anim.cancel();
        el.style.overflow = "";
      }
      return;
    }
    // Retarget from where the window VISUALLY is: while the previous
    // animation runs, the rect reads its mid-ease height (the animation
    // composites into layout). If it already finished but its finish
    // event hasn't delivered yet (so the cleanup below hasn't refreshed
    // the recording), the window sits at that animation's own target. In
    // every other case the rect already shows the NEW committed height,
    // so use the per-render recording below instead.
    const held = heightAnim.current;
    const from =
      held === null
        ? prevPaperH.current
        : held.anim.playState === "running"
          ? el.getBoundingClientRect().height
          : held.toPx;
    if (held !== null) {
      heightAnim.current = null;
      held.anim.cancel();
      el.style.overflow = "";
    }
    const skip =
      el.hasAttribute("data-dock-resizing") ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (from === null || skip) return;
    // Measure the committed endpoint with the class transition
    // neutralized: a same-commit un-pin + collapse rewrites the height
    // px -> the bars' calc() -- BOTH numeric, so windowCollapseAnim
    // starts transitioning at the commit and a plain read here would
    // return the transition's t~0 value (the OLD height) instead of the
    // committed one. transition:none cancels it -- correctly: the window
    // is auto now, so its motion belongs to the script animation.
    el.style.transition = "none";
    const to = el.offsetHeight;
    el.style.transition = "";
    if (Math.abs(from - to) < 0.5) return;
    // Clip while the ease is in flight: an EXPAND eases the paper up
    // around already-mounted full-size content, which would poke out of
    // the small mid-anim box (Paper's steady-state overflow is visible
    // for the grips). The keyframes carry the clip on engines with
    // discrete-property animation (unwipeable, like the height); the
    // inline write covers older ones, with the recorder effect below
    // re-asserting it if a re-render strips it (cosmetic-only insurance).
    el.style.overflow = "hidden";
    const anim = el.animate(
      [
        { height: `${from}px`, overflow: "hidden" },
        { height: `${to}px`, overflow: "hidden" },
      ],
      { duration: 160, easing: "ease" },
    );
    heightAnim.current = { anim, toPx: to };
    anim.onfinish = () => {
      if (heightAnim.current?.anim !== anim) return; // superseded; not ours
      heightAnim.current = null;
      el.style.overflow = "";
      // The animation moved the height WITHOUT a render, so the per-render
      // recorder below never saw the settled value. Refresh it here, or
      // the NEXT toggle reads the pre-flip height as `from`, concludes
      // from == to, and skips its ease -- which is exactly why expanding
      // right after a settled minimize (or vice versa) snapped when
      // nothing else re-rendered the window in between.
      prevPaperH.current = el.getBoundingClientRect().height;
    };
    anim.oncancel = () => {
      // Reachable only outside the toggle path (that path nulls the ref
      // BEFORE canceling, and the guard makes this a no-op): e.g. the
      // browser canceling animations on a display change.
      if (heightAnim.current?.anim !== anim) return;
      heightAnim.current = null;
      el.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);
  React.useLayoutEffect(() => {
    const el = paperRef.current;
    // Old-engine insurance for the clip (see the keyframes note above):
    // a re-render rewrote the style prop, which can strip the inline
    // overflow; the height itself needs no such help (WAAPI outranks the
    // style attribute).
    if (el !== null && heightAnim.current !== null)
      el.style.overflow = "hidden";
    // Live height (mid-ease included -- the animated height shows in the
    // rect) so an interrupted toggle continues from where the window
    // visually is. Pinned windows skip the read (the WAAPI arm never
    // consumes it for them -- their class transition eases natively) but
    // KEEP the last recorded value: a single commit that both un-pins and
    // toggles collapse then eases from a slightly stale height instead of
    // snapping.
    if (!(pinnedPx !== undefined && heightAnim.current === null))
      prevPaperH.current = el?.getBoundingClientRect().height ?? null;
  });

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
    (side: "left" | "right") => (event: React.PointerEvent<HTMLDivElement>) => {
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
          const raw =
            side === "right" ? startWidth + delta : startWidth - delta;
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
      const content = v.querySelector<HTMLElement>(
        ".mantine-ScrollArea-content",
      );
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
    // being trapped at the 50px minimum.
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
      // Per-frame height writes must track the cursor 1:1: suppress the D34
      // height ease (windowCollapseAnim) on this window for the drag.
      paperRef.current?.setAttribute("data-dock-resizing", "");
      const startY = event.clientY;
      const {
        startHeight,
        heightFrom,
        snappedToContent,
        yFor,
        heightToCommit,
      } = vResizeStart(vside);

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
          paperRef.current?.removeAttribute("data-dock-resizing");
          setSnappedToContent(false);
          if (cancelled) onResizeHeight(win.id, startHeight, yFor(startHeight));
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
      // Corner drags also write height per frame: suppress the D34 ease.
      paperRef.current?.setAttribute("data-dock-resizing", "");
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = win.width;
      const startRight = win.x + win.width;
      const {
        startHeight,
        heightFrom,
        snappedToContent,
        yFor,
        heightToCommit,
      } = vResizeStart(vside);
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
          paperRef.current?.removeAttribute("data-dock-resizing");
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
      className={windowCollapseAnim}
      style={{
        position: "absolute",
        left: win.x,
        top: win.y,
        // A collapsed window is the same stack of cells, all rendered as
        // 26px bars (D17) at full win.width -- the width is part of the
        // window's identity (P8); no fit-content jump. Its height is the
        // bars' computed sum (numeric, so the collapse can ease -- D34).
        width: win.width,
        height: collapsed ? collapsedHeight : renderedHeight,
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
        <>
          {/* For a multi-group stack, a window header drags the whole window; each
        group also keeps its own grip bar (which tears it out). A single group
        needs no header -- its own grip bar moves the window. The header's
        right-end toggle flips the window's ONE collapse flag (D38); it is
        the collapsed window's ONLY expand signifier (T4 -> D25: the bars
        below carry no individual +, staying unmarked backing). Rendered
        even when the whole stack is bars (D17): a collapsed window is the
        same stack of cells, just all 26px. A motionless press toggles (via
        the drag-starter's onClick, since the +/- is dragThrough); motion
        drags. */}
          {multi && (
            <StackHandleBar
              attrs={{ "data-floating-handle": win.id }}
              onPointerDown={(event) =>
                dock.startWindowDrag(event, win.id, {
                  onClick: toggleWindowCollapsed,
                })
              }
              collapsed={collapsed}
              onToggle={toggleWindowCollapsed}
            />
          )}

          <Box
            ref={stackRef}
            style={{
              // Collapsed multi-group window: rule off the window header from
              // the first bar -- every other bar boundary draws a divider, and
              // an unmarked header/bar seam reads as one surface (user
              // report: "there should be a horizontal line above the
              // Stats/Notes row").
              ...(collapsed && multi
                ? {
                    // Same recipe as the bar-to-bar divider rules (1px
                    // default-border at half opacity), so all the window's
                    // horizontal lines read as one family.
                    borderTop:
                      "1px solid color-mix(in srgb, var(--mantine-color-default-border) 50%, transparent)",
                  }
                : {}),
              ...(fixedHeight
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
                : {}),
            }}
          >
            {win.stack.map((groupId, index) => {
              const group = dock.groups[groupId];
              if (group === undefined) return null;
              const weight = win.stackWeights?.[groupId] ?? 1;
              // D38: the window's ONE flag decides every cell's rendering --
              // a collapsed window renders every cell as its bar (a
              // single-group window = one bar; face bar for a face pane).
              // The bar's right-end + renders only when the bar IS the whole
              // window (T4 -> D25: a multi-group window's expand signifier
              // is its header's toggle alone).
              const groupNode = collapsed ? (
                <MinimizedBar group={group} expandControl={!multi} />
              ) : (
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
                      paperRef={paperRef}
                      dividerIndex={index - 1}
                      stack={win.stack}
                      // D38: an expanded window is all expanded cells (every
                      // divider trades); a collapsed one is all bars (none do).
                      resizable={!collapsed}
                      weightOf={(g) => win.stackWeights?.[g] ?? 1}
                      onSetWeights={(weights) =>
                        onSetStackWeights(win.id, weights)
                      }
                      isFixed={fixedHeight}
                      setWindowHeight={(px) => onResizeHeight(win.id, px)}
                    />
                  )}
                  {fixedHeight ? (
                    // Expanded pinned window only (fixedHeight is false while
                    // collapsed): cells share the pinned height by weight.
                    <Box
                      className={collapseAnim}
                      style={{
                        flexGrow: weight / stackWeightTotal,
                        flexShrink: 1,
                        flexBasis: 0,
                        // Never shrink below a cell's header: minHeight:0 let an
                        // over-short window collapse a cell under its header,
                        // clipping it and overlapping the next cell. Floor at the
                        // min stack-cell height; the stack scrolls when the sum
                        // exceeds the window.
                        minHeight: MIN_STACK_CELL_PX,
                        display: "flex",
                        flexDirection: "column",
                        // Clip: children render committed-size instantly, the
                        // wrapper eases (see collapseAnim).
                        overflow: "hidden",
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
      </Box>
    </Paper>
  );
});

/** Draggable divider between two groups in a fixed-height floating snap-stack.
 * Redistributes height between the stacked groups using the same cascade as
 * docked column splits, writing per-group weights (by id). */
function FloatingStackDivider({
  stackRef,
  paperRef,
  dividerIndex,
  stack,
  resizable,
  weightOf,
  onSetWeights,
  isFixed,
  setWindowHeight,
}: {
  stackRef: React.RefObject<HTMLDivElement>;
  paperRef: React.RefObject<HTMLDivElement>;
  dividerIndex: number;
  stack: GroupId[];
  /** False while the window is collapsed (all bars, D38): nothing to trade,
   * so no resize cursor, no armed gesture, and no pin side effect. */
  resizable: boolean;
  weightOf: (g: GroupId) => number;
  onSetWeights: (weights: Record<GroupId, number>) => void;
  /** Whether the window already has a fixed height (so weights apply directly).
   * If false, the drag pins the current rendered height -- seeded with the
   * cells' RENDERED px (same rule as docked divider drags), so entering
   * pinned mode reproduces the exact on-screen layout and a motionless
   * click cannot move anything. */
  isFixed: boolean;
  /** Pin (px) or restore auto (undefined) -- the window height writer. */
  setWindowHeight: (px: number | undefined) => void;
}) {
  // Cancel the in-flight gesture if the divider unmounts mid-drag (the stack
  // can be restructured by another client), so the window listeners can't fire
  // after unmount and the shared `resizing` flag can't stick true.
  const activeDrag = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => activeDrag.current?.(), []);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizable) return;
    if (event.button !== 0) return;
    if (activeDrag.current !== null) return; // one drag per divider
    event.stopPropagation();
    const container = stackRef.current;
    if (container === null) return;
    const containerPx = container.getBoundingClientRect().height;
    // Suppress the minimize/expand transition under this stack for the
    // drag's duration (per-frame weight writes must land instantly). The
    // paper carries it too, so the window-height ease (windowCollapseAnim
    // + the auto-height FLIP) stays out of per-frame height writes.
    container.setAttribute("data-dock-resizing", "");
    paperRef.current?.setAttribute("data-dock-resizing", "");
    const paperStartH = paperRef.current?.offsetHeight ?? containerPx;
    const wasFixed = isFixed;
    // Snapshot the cells' RENDERED heights BEFORE any mode change: these
    // seed the pinned-mode weights, so flipping an auto window to fixed
    // reproduces the exact on-screen layout (the old path seeded stored
    // flex shares -- often 1:1 -- and the stack visibly JUMPED on a plain
    // pointerdown; P2: a motionless click never moves).
    const renderedPx: Record<string, number> = {};
    stack.forEach((g) => {
      const cellEl = container.querySelector<HTMLElement>(
        `[data-dock-group="${CSS.escape(g)}"]`,
      );
      renderedPx[g] = cellEl?.offsetHeight ?? containerPx / stack.length;
    });
    // Drag-start weights so a cancel (or motionless click) restores them.
    const startWeights: Record<string, number> = {};
    stack.forEach((g) => {
      startWeights[g] = weightOf(g);
    });
    if (!wasFixed) {
      setWindowHeight(paperStartH);
      onSetWeights(renderedPx);
    }
    const start = event.clientY;
    let latest = start;
    // Push-through budget (user-adjudicated): dragging DOWN past the point
    // where every cell below the divider sits at its minimum keeps going by
    // GROWING the window -- the excess lands on the cell above the divider.
    // Budget from the drag-start snapshot so it's stable across frames.
    const startPx = wasFixed
      ? stack.map((g) => startWeights[g])
      : stack.map((g) => renderedPx[g]);
    const belowCapacity = startPx
      .slice(dividerIndex + 1)
      .reduce((s, px) => s + Math.max(0, px - MIN_STACK_CELL_PX), 0);
    const maxPaperH = () => {
      const parent = paperRef.current?.parentElement;
      if (!parent || paperRef.current === null) return Infinity;
      const y = paperRef.current.offsetTop;
      return Math.max(paperStartH, parent.clientHeight - y);
    };
    activeDrag.current = dragGesture({
      grip: event.currentTarget,
      pointerId: event.pointerId,
      update: (e) => {
        latest = e.clientY;
      },
      flush: () => {
        // D38: dividers only exist on an EXPANDED window (a collapsed one is
        // all bars and none of its seams are resizable), so the mask is
        // uniformly false.
        const collapsed = stack.map(() => false);
        const totalDelta = latest - start;
        // Split the downward delta into the zero-sum part (traded with the
        // cells below) and the push-through part (window growth).
        const extra =
          totalDelta > 0
            ? Math.min(
                Math.max(0, totalDelta - belowCapacity),
                maxPaperH() - paperStartH,
              )
            : 0;
        const next = cascadeResize({
          weights: startPx.slice(),
          collapsed,
          containerPx,
          dividerIndex,
          deltaPx: totalDelta - extra,
          minCell: MIN_STACK_CELL_PX,
          maxCell: Infinity,
        });
        if (next === null) return;
        if (extra > 0) next[dividerIndex] += extra;
        const wmap: Record<string, number> = {};
        stack.forEach((g, i) => {
          if (!collapsed[i]) wmap[g] = next[i];
        });
        onSetWeights(wmap);
        setWindowHeight(paperStartH + extra);
      },
      onEnd: (cancelled) => {
        activeDrag.current = null;
        // The captured element, not stackRef.current: the ref can re-point
        // to a new node mid-drag, stranding the attribute on the old one.
        container.removeAttribute("data-dock-resizing");
        paperRef.current?.removeAttribute("data-dock-resizing");
        const moved = Math.abs(latest - start) > 3;
        if (cancelled || !moved) {
          // Escape OR a motionless click: full restore -- weights AND the
          // height mode (an auto window a click briefly pinned reverts to
          // auto; P2: layout, sizes, and modes return to pre-gesture
          // values).
          onSetWeights(startWeights);
          setWindowHeight(wasFixed ? paperStartH : undefined);
        }
      },
    });
  };
  return (
    <Box
      data-floating-divider={dividerIndex}
      onPointerDown={onPointerDown}
      style={{
        position: "relative",
        flexShrink: 0,
        height: SPLIT_DIVIDER_PX,
        // Splitter cursor: this divider trades height between two stacked
        // cells (window edge grips keep ns-resize).
        cursor: resizable ? "row-resize" : "default",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        touchAction: "none",
        zIndex: 2,
      }}
    >
      {resizable && (
        <Box
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: -DIVIDER_OVERHANG_PX,
            height: SPLIT_DIVIDER_PX + 2 * DIVIDER_OVERHANG_PX,
          }}
        />
      )}
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
