// Renders one tab group: a tab strip plus the active panel's contents. Used
// both for docked leaves and for the groups stacked inside a floating window.

import { Box, ScrollArea } from "@mantine/core";
import { IconMinus, IconPlus } from "@tabler/icons-react";
import React from "react";
import { useDock } from "./DockContext";
import { isStackedGroup } from "./layoutOps";
import {
  dockBodyScroll,
  focusRing,
  gripBarBg,
  headerRule,
  headerRuleTop,
} from "./DockStyles.css";
import { focusDockControl, tabListKeyDown } from "./gestures";
import { ChromeToggle, GripPill, HandleIconButton } from "./handles";
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

// Font scale for the tab strip (and the plain-title unmergeable header, which
// mirrors the tab look). Also the em basis to divide by when converting a
const STRIP_FONT_EM = 0.85;

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
    opts?: { onClick?: () => void },
  ) => void;
}) {
  return (
    <Box
      data-dock-griphandle
      className={gripBarBg}
      onPointerDown={(event) => {
        // A motionless tap toggles minimize/expand (the +/- is a redundant
        // explicit cue for the same action -- every group minimizes
        // individually, D16). A real drag moves the panel AS-IS (expanding is
        // click-only).
        startDrag(event, { onClick: onToggle });
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
      {/* Minimize / expand button: drag-through (see GripBar doc). Every
      group has one (per-cell minimize, D16) -- the multi-group window
      header's toggle-ALL is a distinct action with its own signifier. */}
      <HandleIconButton
        attrs={{ "data-dock-minimize": "true" }}
        label={collapsed ? "Expand panel" : "Minimize panel"}
        title={collapsed ? "Expand" : "Minimize"}
        expanded={!collapsed}
        onActivate={onToggle}
        dragThrough
      >
        {collapsed ? <IconPlus size={12} /> : <IconMinus size={12} />}
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
  // The active pane's spec, resolved ONCE. `group.activeId` is null exactly
  // when the group is empty (only an area's backing group), which renders
  // chrome only -- every consumer below handles the undefined.
  const activePane =
    group.activeId === null ? undefined : panes[group.activeId];
  const dimmed = dock.draggingGroupId === group.id;
  const collapsed = group.collapsed ?? false;
  // An unmergeable group always holds a single panel and renders its label as a
  // full-width header (never a tab); nothing can be merged into it.
  const unmergeable = group.paneIds.some(
    (p) => panes[p]?.unmergeable === true,
  );
  // A STACKED titleNode header (the main panel's connection-status bar sitting
  // below another panel in a 2+ stack, docked OR floating) gets a thin top rule
  // so it reads as separated from the panel above. Not needed when LONE (nothing
  // above it).
  const stacked = isStackedGroup(dock.layout, group.id);
  // Keyboard/Click minimize unmounts this frame for the in-place bar; focus
  // hands off to the bar's toggle (the same-spot + that undoes it).
  const toggleAndFocusBar = () => {
    const wasExpanded = !collapsed;
    dock.toggleCollapsed(group.id);
    if (wasExpanded)
      focusDockControl(
        `[data-dock-group="${CSS.escape(group.id)}"] [data-dock-minimize]`,
      );
  };

  // Tablist keyboard pattern: ArrowLeft/Right activate the neighbor tab and
  // move focus with it; Enter/Space activate the focused tab.
  const tabKeyDown = (paneId: string) =>
    tabListKeyDown({
      paneId,
      paneIds: group.paneIds,
      prevKey: "ArrowLeft",
      nextKey: "ArrowRight",
      onActivate: (id) => dock.activateTab(group.id, id),
      onMove: (id) => dock.activateTab(group.id, id),
    });

  const stripRef = React.useRef<HTMLDivElement>(null);

  // The panel body, by context:
  // - Floating (non-fill, content-sized): hidden (not unmounted) when
  //   collapsed, so the window auto-resizes to just its chrome and pane state
  //   survives minimize.
  // - Docked (fill): the leaf fills its region via flex; when collapsed the
  //   group shrinks to its handle + strip and the body is hidden.
  const body = (
    <PanelBody
      panel={activePane}
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
    // Floating auto-height: hide (not unmount) the body when collapsed, so
    // pane component state survives minimize -- same semantics the animated
    // <Collapse> had, minus the height tween.
    <Box style={{ display: collapsed ? "none" : undefined }}>{body}</Box>
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
        // strip. We rely on flexGrow alone (not height:100%) so the height
        // isn't pinned.
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
      }}
    >
      {/* Move-handle grip bar (with a minimize/expand button), above the tabs. */}
      {/* The gray grip bar is shown for ordinary groups. An UNMERGEABLE panel
      has no separate grip: its full-width header IS the handle, and clicking it
      (no drag) toggles minimize -- matching the live FloatingPanel. */}
      {stripDragsGroup && !unmergeable && (
        <GripBar
          collapsed={collapsed}
          onToggle={toggleAndFocusBar}
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
            activePane?.titleNode
              ? undefined
              : (activePane?.title ?? group.activeId ?? "")
          }
          // The 1px BOTTOM rule separates the header from the content below, so
          // only show it when EXPANDED -- a collapsed panel is header-only, and
          // the rule would read as a stray border on its bottom edge. A 1px TOP
          // rule (same gray) is added when docked+stacked to separate it from
          // the panel above.
          className={
            activePane?.titleNode
              ? [!collapsed && headerRule, stacked && headerRuleTop]
                  .filter(Boolean)
                  .join(" ") || undefined
              : undefined
          }
          onPointerDown={(event) => {
            if (!stripDragsGroup) return;
            // Click-to-minimize: minimize is per-GROUP now (D16), so a tap on
            // the header toggles just this panel -- stacked or not.
            dock.startGroupDrag(event, group.id, {
              onClick: toggleAndFocusBar,
            });
          }}
          data-dock-unmergeable-header={group.id}
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
            ...(activePane?.titleNode
              ? {
                  height: "2.75em",
                  lineHeight: "1.5em",
                  padding: "0 0.75em",
                  fontWeight: 400,
                  // The top rule (docked+stacked) is the headerRuleTop class.
                }
              : {
                  height: TAB_ROW_EM,
                  padding: "0 0.9em",
                  fontSize: `${STRIP_FONT_EM}em`,
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
          {activePane?.titleNode ? (
            <Box
              style={{
                display: "flex",
                alignItems: "center",
                flexGrow: 1,
                minWidth: 0,
              }}
            >
              {activePane?.titleNode}
            </Box>
          ) : (
            // Ellipsis on a non-flex child (see the tab-strip note below).
            <span
              style={{
                minWidth: 0,
                flexGrow: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {activePane?.title ?? group.activeId ?? ""}
            </span>
          )}
          {/* The header's ONE visible minimize signifier (P9: the whole
          header toggles on click, but an action with zero icons is
          undiscoverable). Rendered for BOTH title forms -- a plain-title
          unmergeable panel otherwise reproduces the same zero-signifier
          defect. Same right-end +/- as every other chrome row (P13);
          panel-provided action icons sit just left of it. */}
          <ChromeToggle
            expanded={!collapsed}
            label={collapsed ? "Expand panel" : "Minimize panel"}
            onActivate={toggleAndFocusBar}
          />
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
            fontSize: `${STRIP_FONT_EM}em`,
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
