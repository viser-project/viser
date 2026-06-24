// Renders one tab group: a tab strip plus the active panel's contents. Used
// both for docked leaves and for the groups stacked inside a floating window.

import { Box, Collapse, ScrollArea } from "@mantine/core";
import { IconMinus, IconPlus } from "@tabler/icons-react";
import React from "react";
import { useDock } from "./DockContext";
import {
  dockBodyScroll,
  focusRing,
  gripBarBg,
  headerRule,
} from "./DockStyles.css";
import { keyActivate, prefersReducedMotion } from "./gestures";
import { GripPill, HandleIconButton } from "./handles";
import { PaneSpec, TabGroup } from "./types";

// The active panel's BODY, memoized so it is rebuilt/reconciled only when its
// OWN inputs change -- not on every unrelated dock op. A tab switch or a
// dock/undock elsewhere busts the dock context, so every TabGroupFrame
// re-renders; without this, each one would re-invoke `panel.render()` and
// re-reconcile the whole ScrollArea/Box wrapper chain. The memo holds because
// panel specs are referentially STABLE across layout ops (the registry keys
// content by id -- see ControlPanelDock), so an unrelated op leaves
// (panel, fill, maxContentHeight) untouched and React skips the subtree. The
// live content inside still updates via its own state subscriptions.
const PanelBody = React.memo(function PanelBody({
  panel,
  fill,
  maxContentHeight,
  persistentScrollbar,
}: {
  panel: PaneSpec | undefined;
  fill: boolean;
  maxContentHeight?: number;
  /** When true (docked leaves), the fill-height ScrollArea shows its scrollbars
   * whenever content overflows (`type="auto"`) -- so the horizontal bar that
   * appears when the panel is squeezed below its content minimum stays visible
   * at the panel bottom. Floating windows leave this false to keep Mantine's
   * default hover-reveal bars. */
  persistentScrollbar?: boolean;
}) {
  if (panel?.fullBleed === true) {
    // Full-bleed: render the content directly with no padding and no ScrollArea
    // wrapper -- the content (e.g. a nested DockArea) fills the body and manages
    // its own scrolling. (Wrapping a fill-height child in ScrollArea.Autosize,
    // which sizes to content, would collapse it to 0 height.)
    return (
      <Box
        style={{
          width: "100%",
          ...(fill
            ? {
                flexGrow: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column" as const,
              }
            : {}),
        }}
      >
        {panel.render()}
      </Box>
    );
  }
  const inner = (
    <Box
      style={{
        padding: panel?.unpadded === true ? undefined : "0.6em 0.75em",
        width: "100%",
      }}
    >
      {panel?.render() ?? null}
    </Box>
  );
  // Fill (docked leaves, and fixed-height floating windows): a plain ScrollArea
  // that FILLS the panel's height, so the horizontal scrollbar (shown when the
  // body is narrower than its content minimum) pins to the BOTTOM of the panel
  // rather than floating just under short content. The flex parent (flexGrow:1,
  // minHeight:0) gives it the definite height it needs to scroll. Docked leaves
  // pass persistentScrollbar so the bar stays visible; floating windows keep the
  // default hover-reveal.
  // Non-fill (auto-height floating): ScrollArea.Autosize so the window sizes to
  // its content up to the maxContentHeight cap (a fill ScrollArea has no height).
  return fill ? (
    <ScrollArea
      type={persistentScrollbar === true ? "auto" : "hover"}
      className={dockBodyScroll}
      style={{ flexGrow: 1, minHeight: 0, width: "100%" }}
    >
      {inner}
    </ScrollArea>
  ) : (
    <ScrollArea.Autosize
      mah={maxContentHeight}
      className={dockBodyScroll}
      style={{ width: "100%" }}
    >
      {inner}
    </ScrollArea.Autosize>
  );
});

// Tab handle height, also the band height for the strip's repeating bottom-rule
// gradient. In em relative to the strip's own font-size so the two stay aligned.
const TAB_ROW_EM = "2.4em";
// Minimize/expand animation duration (ms). Matches Mantine's <Collapse> default
// feel and the FloatingPanel transitions in the original control panel.
const COLLAPSE_MS = 200;

/** Slim handle bar above the tab strip (docked or floating). The bar itself is
 * a drag handle (centered grip line + grab cursor); a button on the right
 * minimizes/expands the group. The button is drag-THROUGH: pressing it and
 * moving drags the panel like the bar would (a drag from the EXPAND button
 * tears out the full panel), while a motionless release toggles. */
function GripBar({
  collapsed,
  onToggle,
  startDrag,
}: {
  collapsed: boolean;
  onToggle: () => void;
  startDrag: (
    event: React.PointerEvent<HTMLDivElement>,
    opts?: { onClick?: () => void; expandOnDrag?: boolean },
  ) => void;
}) {
  return (
    <Box
      data-dock-griphandle
      className={gripBarBg}
      onPointerDown={(event) => {
        // Presses that start ON the button get a motionless-click toggle (the
        // bar itself deliberately has none -- see
        // test_handle_tap_does_not_minimize); a drag from the + also expands.
        const fromButton =
          (event.target as HTMLElement).closest("[data-dock-minimize]") !==
          null;
        startDrag(
          event,
          fromButton
            ? { onClick: onToggle, expandOnDrag: collapsed }
            : undefined,
        );
      }}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        height: "0.9em",
        // Light gray fill marks the handle (one step lighter than the border
        // gray -- see gripBarBg) and separates it from the tabs.
        cursor: "grab",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {/* Drag affordance. */}
      <GripPill />
      {/* Minimize / expand button: drag-through (see GripBar doc). */}
      <HandleIconButton
        attrs={{ "data-dock-minimize": "true" }}
        label={collapsed ? "Expand panel" : "Minimize panel"}
        title={collapsed ? "Expand" : "Minimize"}
        expanded={!collapsed}
        onActivate={onToggle}
        dragThrough
      >
        {collapsed ? <IconPlus size={14} /> : <IconMinus size={14} />}
      </HandleIconButton>
    </Box>
  );
}

export function TabGroupFrame({
  group,
  /** When true the frame fills its container's height (docked leaves); when
   * false it sizes to content with an internal scroll cap (floating). */
  fill = true,
  /** Cap on the contents' height when not filling (floating windows pass the
   * container-derived cap). Omitted -> uncapped: the body grows with its
   * content and any scrolling is the HOST's job (e.g. a nested dockable area
   * inside a panel grows with its active tab; the panel scrolls). */
  maxContentHeight,
  /** Controls whether the tab strip itself acts as a move handle (docked) vs.
   * deferring to the window header (floating, multi-group stacks). */
  stripDragsGroup = true,
  /** Docked leaves set this so the body's fill-height scrollbars stay visible
   * whenever content overflows (the persistent horizontal bar at the panel
   * bottom); floating windows leave it off for hover-reveal bars. */
  persistentScrollbar = false,
}: {
  group: TabGroup;
  fill?: boolean;
  maxContentHeight?: number;
  stripDragsGroup?: boolean;
  persistentScrollbar?: boolean;
}) {
  const dock = useDock();
  const { panes } = dock;
  const dimmed = dock.draggingGroupId === group.id;
  const collapsed = group.collapsed ?? false;
  // An unmergeable group always holds a single panel and renders its label as a
  // full-width header (never a tab); nothing can be merged into it.
  const unmergeable = group.paneIds.some(
    (p) => panes[p]?.unmergeable === true,
  );

  // FLIP animation: when the tab order changes, each tab slides from its old
  // slot to its new one. We record each tab's offsetLeft and play the inverted
  // delta. The actively dragged tab is skipped -- the manager drives it
  // imperatively to follow the cursor.
  //
  // Gated on the ORDER (and drag state), not run every render: the effect
  // reads offsetLeft for every tab, a forced-layout read that would otherwise
  // run across every strip on every unrelated dock re-render. The recorded
  // baselines can go stale if the strip is resized between reorders -- worst
  // case the next reorder animates from a slightly-off start, which beats
  // paying layout reads per render.
  // Tablist keyboard pattern: ArrowLeft/Right activate the neighbor tab and
  // move focus with it; Enter/Space activate the focused tab.
  const tabKeyDown =
    (paneId: string) => (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        const i = group.paneIds.indexOf(paneId);
        const next = group.paneIds[event.key === "ArrowLeft" ? i - 1 : i + 1];
        if (next !== undefined) {
          dock.activateTab(group.id, next);
          event.currentTarget.parentElement
            ?.querySelector<HTMLElement>(
              `[data-dock-tab="${CSS.escape(next)}"]`,
            )
            ?.focus();
        }
        return;
      }
      keyActivate(() => dock.activateTab(group.id, paneId))(event);
    };

  const stripRef = React.useRef<HTMLDivElement>(null);
  const prevLefts = React.useRef<Map<string, number>>(new Map());
  const orderKey = group.paneIds.join("\n");
  React.useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip === null) return;
    strip.querySelectorAll<HTMLElement>("[data-dock-tab]").forEach((tab) => {
      const id = tab.getAttribute("data-dock-tab");
      if (id === null) return;
      const left = tab.offsetLeft;
      const prev = prevLefts.current.get(id);
      prevLefts.current.set(id, left);
      if (id === dock.draggingTabId) return; // driven imperatively.
      if (prev === undefined || prev === left) return;
      if (prefersReducedMotion()) return;
      tab.style.transition = "none";
      tab.style.transform = `translateX(${prev - left}px)`;
      requestAnimationFrame(() => {
        tab.style.transition = "transform 160ms ease";
        tab.style.transform = "";
      });
    });
  }, [orderKey, dock.draggingTabId]);

  // The panel body. Two animation strategies, by context:
  // - Floating (non-fill, content-sized): wrap in Mantine <Collapse>, which
  //   measures the content and animates its intrinsic height open/closed -- the
  //   window then auto-resizes around it. This is the original FloatingPanel
  //   feel and works cleanly when nothing else pins the height.
  // - Docked (fill): the leaf fills its region via flex, so an intrinsic-height
  //   Collapse would fight the flex sizing. Instead we render the body plainly
  //   and let the leaf's flex-grow transition (see the outer Box / DockLeafView
  //   column Paper) animate the height; when collapsed we just hide the body.
  const body = (
    <PanelBody
      panel={panes[group.activeId]}
      fill={fill}
      maxContentHeight={maxContentHeight}
      persistentScrollbar={persistentScrollbar}
    />
  );
  const contents = fill ? (
    // Docked: the body stays mounted and fills the group's flexible area
    // (flex-grow 1, flex-basis 0, overflow hidden). The COLLAPSE animation lives
    // on the group Box's flex-grow (1 -> 0), which shrinks the whole group to its
    // handle + strip; this wrapper just clips the body as that happens.
    <Box
      style={{
        flexGrow: 1,
        flexBasis: 0,
        minHeight: 0,
        width: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {body}
    </Box>
  ) : (
    <Collapse
      in={!collapsed}
      transitionDuration={prefersReducedMotion() ? 0 : COLLAPSE_MS}
    >
      {body}
    </Collapse>
  );

  return (
    <Box
      data-dock-group={group.id}
      data-dock-collapsed={collapsed ? "true" : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        // Fill the docked leaf via flexGrow (the leaf's Paper is a flex box). A
        // collapsed group never fills -- it shrinks to just its handle + tab
        // strip. We rely on flexGrow alone (not height:100%) so the height isn't
        // pinned, letting the content's <Collapse> drive the shrink/grow; the
        // flex transition then animates the leaf resizing in step.
        width: "100%",
        // A collapsed group sizes to its handle + strip (flexBasis auto, no
        // grow/shrink) so it stays visible in a fill container instead of
        // collapsing to 0; an expanded fill group grows to fill (flexBasis 0).
        flexGrow: collapsed ? 0 : fill ? 1 : undefined,
        flexShrink: collapsed ? 0 : fill ? 1 : undefined,
        flexBasis: collapsed ? "auto" : fill ? 0 : undefined,
        minWidth: 0,
        minHeight: 0,
        opacity: dimmed ? 0.4 : 1,
        transition:
          fill && !prefersReducedMotion()
            ? "flex-grow 200ms ease, flex-basis 200ms ease"
            : undefined,
      }}
    >
      {/* Move-handle grip bar (with a minimize/expand button), above the tabs. */}
      {/* The gray grip bar is shown for ordinary groups. An UNMERGEABLE panel
      has no separate grip: its full-width header IS the handle, and clicking it
      (no drag) toggles minimize -- matching the live FloatingPanel. */}
      {stripDragsGroup && !unmergeable && (
        <GripBar
          collapsed={collapsed}
          onToggle={() => dock.toggleCollapsed(group.id)}
          startDrag={(event, opts) =>
            dock.startGroupDrag(event, group.id, opts)
          }
        />
      )}

      {unmergeable ? (
        // Unmergeable: a full-width label header (not a tab strip), which is both
        // the move handle (drag to relocate) and the minimize toggle (click, no
        // drag -- like FloatingPanel). A panel may supply a custom `titleNode`
        // (e.g. a connection-status bar) instead of the plain title text; then
        // the header doesn't impose the primary-color/bold title styling.
        <Box
          ref={stripRef}
          data-dock-strip={group.id}
          data-dock-header={group.id}
          // Full label on hover -- the plain-title header ellipsizes. (With a
          // custom titleNode the panel renders its own content; no tooltip.)
          title={
            panes[group.activeId]?.titleNode
              ? undefined
              : (panes[group.activeId]?.title ?? group.activeId)
          }
          className={panes[group.activeId]?.titleNode ? headerRule : undefined}
          onPointerDown={(event) => {
            if (stripDragsGroup)
              dock.startGroupDrag(event, group.id, {
                onClick: () => dock.toggleCollapsed(group.id),
              });
          }}
          style={{
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            overflow: "hidden",
            // With a custom titleNode (e.g. the connection-status bar), match the
            // live FloatingPanel handle EXACTLY: 2.75em tall, 1.5em line-height,
            // default font size, weight 400, 0.75em side padding, and just a
            // subtle 1px bottom divider (the headerRule class -- Divider's
            // gray-3/dark-4, NOT default-border; no thick primary rule, no tab
            // gradient). The plain-title case keeps the compact bold look + rule.
            ...(panes[group.activeId]?.titleNode
              ? {
                  height: "2.75em",
                  lineHeight: "1.5em",
                  padding: "0 0.75em",
                  fontWeight: 400,
                }
              : {
                  height: TAB_ROW_EM,
                  padding: "0 0.9em",
                  fontSize: "0.85em",
                  fontWeight: 600,
                  color: "var(--mantine-primary-color-filled)",
                  boxShadow: "inset 0 -2px 0 0 var(--mantine-primary-color-filled)",
                  backgroundImage:
                    "linear-gradient(to top, var(--mantine-color-default-border) 2px, transparent 2px)",
                  backgroundSize: `100% ${TAB_ROW_EM}`,
                }),
            cursor: stripDragsGroup ? "grab" : "default",
            touchAction: "none",
            userSelect: "none",
            WebkitUserSelect: "none",
          }}
        >
          {panes[group.activeId]?.titleNode ? (
            <Box style={{ display: "flex", alignItems: "center", width: "100%" }}>
              {panes[group.activeId]?.titleNode}
            </Box>
          ) : (
            // Ellipsis on a non-flex child (see the tab-strip note below).
            <span
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {panes[group.activeId]?.title ?? group.activeId}
            </span>
          )}
        </Box>
      ) : (
        /* Tab strip. Bordered "original Viser" style: a thick rule below each
        tab (the gray grip bar above separates the group instead of a rule). The
        thick rule is drawn as a repeating background gradient -- a 2px line at
        the bottom of each TAB_ROW_EM-tall band -- so it spans the full width of
        *every* wrapped row with no filler elements. The active tab paints its
        own segment in the primary color via an inset bottom shadow. font-size is
        set on the strip (not per-tab) so the tab height and the gradient band
        share an em basis. The empty strip area is also a move handle. */
        <Box
          ref={stripRef}
          data-dock-strip={group.id}
          role="tablist"
          onPointerDown={(event) => {
            // Only the strip background (not a tab button) starts a group drag.
            if ((event.target as HTMLElement).closest("[data-dock-tab]")) return;
            if (stripDragsGroup) dock.startGroupDrag(event, group.id);
          }}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "stretch",
            flexShrink: 0,
            fontSize: "0.85em",
            backgroundImage:
              "linear-gradient(to top, var(--mantine-color-default-border) 2px, transparent 2px)",
            backgroundSize: `100% ${TAB_ROW_EM}`,
            cursor: stripDragsGroup ? "grab" : "default",
            touchAction: "none",
            userSelect: "none",
            WebkitUserSelect: "none",
            overflow: "hidden",
          }}
        >
          {group.paneIds.map((paneId) => {
            const active = paneId === group.activeId;
            const dragging = paneId === dock.draggingTabId;
            const spec = panes[paneId];
            return (
              <Box
                key={paneId}
                data-dock-tab={paneId}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                className={focusRing}
                // Full label on hover -- tabs ellipsize at maxWidth.
                title={spec?.title ?? paneId}
                onKeyDown={tabKeyDown(paneId)}
                onPointerDown={(event) =>
                  dock.startTabDrag(event, group.id, paneId)
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  boxSizing: "border-box",
                  height: TAB_ROW_EM,
                  padding: "0 0.9em",
                  maxWidth: "14em",
                  fontWeight: active ? 600 : 500,
                  overflow: "hidden",
                  cursor: "pointer",
                  userSelect: "none",
                  touchAction: "none",
                  position: dragging ? "relative" : undefined,
                  zIndex: dragging ? 5 : undefined,
                  backgroundColor: dragging
                    ? "var(--mantine-primary-color-light)"
                    : "transparent",
                  color: active
                    ? "var(--mantine-primary-color-filled)"
                    : "var(--mantine-color-text)",
                  opacity: active || dragging ? 1 : 0.65,
                  // Active tab: colored thick bottom border over the default rule.
                  boxShadow: active
                    ? "inset 0 -2px 0 0 var(--mantine-primary-color-filled)"
                    : "none",
                }}
              >
                {spec?.icon !== undefined && (
                  <Box
                    style={{
                      display: "flex",
                      alignItems: "center",
                      marginRight: "0.5em",
                      flexShrink: 0,
                    }}
                  >
                    {spec.icon}
                  </Box>
                )}
                {/* Ellipsis must live on a NON-flex (block) element, not the flex
                    tab Box -- text-overflow is ignored on a flex container, so a
                    raw text child would hard-clip with no "...". minWidth:0 lets
                    this item shrink below its content width inside the flex row. */}
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {spec?.title ?? paneId}
                </span>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Active panel contents, animated open/closed by the minimize toggle. */}
      {contents}
    </Box>
  );
}
