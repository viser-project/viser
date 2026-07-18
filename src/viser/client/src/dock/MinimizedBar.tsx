// The bar: the collapsed FLOATING rendering, per cell (D20/D38). A collapsed
// window (`window.collapsed`) draws each group of its stack as its handle
// kept in place (P13/D33): the group's tab labels, dimmed -- all that fit,
// in order, overflow collapsing to a "+N" badge for the remainder (D36) --
// then slack, then (single-group windows only, T4/D25) the `+` at the right
// end, exactly where the expanded handle's `-` sat. Bars sit on the panel's
// body surface (a bar is the panel, sleeping, D19) with no pill (D18). Since
// D32 the bar is a floating-only surface: docked collapse renders as the
// rail (VerticalMinimizedColumn), never as in-place bars.

import { Box } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { focusRing, wayfindingText } from "./DockStyles.css";
import { focusPaneTabOrGroup, tabListKeyDown } from "./gestures";
import { startCollapsedGroupPress } from "./collapsedPress";
import { ChromeToggle } from "./handles";
import { HEADER_PAD_EM, minimizedBarBasis, TabGroup } from "./types";

// Fallback width estimate (px) for the "+N" badge before it has rendered:
// the first measurement pass runs while the badge may not exist yet, so a
// conservative reserve keeps the label fit stable across the second pass.
const BADGE_ESTIMATE_PX = 40;

/** One cell of a collapsed floating window, drawn as its handle (P13/D36).
 *
 * Every tab label carries data-dock-tab: tab-based selectors, keyboard
 * activation (the bar is a tablist of its visible labels, Left/Right
 * traversal), and hitTest's per-label insertion rects all key off it;
 * labels hidden behind the +N badge are visibility:hidden, which the
 * target scanner skips (an invisible label must not be an insertion
 * target, P1). Gestures via startCollapsedGroupPress: a label press tears
 * out that pane (born collapsed, D38; single-pane groups float wholesale,
 * ids stable); any other press drags the whole group; motionless clicks
 * expand. Expanding is ONE flag (D38): every affordance here -- label
 * click, background click, the `+` -- clears the window's `collapsed`, so
 * any bar's expand reveals the whole window by construction.
 *
 * `expandControl`: T4 resolved to D25's budget -- a multi-group collapsed
 * window renders its `+` only on the window header (the scope's handle);
 * its bars stay unmarked backing (clicks/Enter still expand). The
 * single-group window's bar keeps the control: it is the window's only
 * chrome, and the `+` sits at the `-`'s exact form and inset (P13/D33).
 *
 * A single-pane group whose pane provides `minimizedFace` renders the face
 * instead of the labels (D19), at the unmergeable header's exact geometry
 * (D33): same 2.75em height, same HEADER_PAD_EM side padding, same compact
 * toggle at the same right inset -- minimizing never moves, shrinks, or
 * re-spaces the label row. */
export function MinimizedBar({
  group,
  expandControl,
}: {
  group: TabGroup;
  /** Render the right-end `+` (single-group windows only, see above). */
  expandControl: boolean;
}) {
  const dock = useDock();
  const rowRef = React.useRef<HTMLDivElement>(null);
  const badgeRef = React.useRef<HTMLDivElement>(null);
  // How many leading labels fit (D36). Starts optimistic (all) and is
  // reconciled against measured widths before paint (useLayoutEffect).
  const [visibleCount, setVisibleCount] = React.useState(group.paneIds.length);
  const paneKey = group.paneIds.join("\u0000");

  // Measure label fit: natural label widths (flexShrink 0, nowrap) against
  // the label row's width. When they all fit, no badge; otherwise the badge
  // is reserved and the visible prefix shrinks until it fits (min 1 -- the
  // first label may still ellipsize via its own maxWidth). Re-runs on bar
  // resize (ResizeObserver) and after its own state change, so the second
  // pass measures the REAL badge width; both passes run pre-paint.
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const recompute = () => {
      const labels = Array.from(
        row.querySelectorAll<HTMLElement>("[data-dock-tab]"),
      );
      if (labels.length === 0) return;
      const widths = labels.map((l) => l.offsetWidth);
      const rowW = row.clientWidth;
      const total = widths.reduce((a, b) => a + b, 0);
      let next = labels.length;
      if (total > rowW) {
        const badgeW = badgeRef.current?.offsetWidth ?? BADGE_ESTIMATE_PX;
        const avail = Math.max(0, rowW - badgeW);
        let sum = 0;
        next = 0;
        for (const w of widths) {
          if (sum + w > avail) break;
          sum += w;
          next += 1;
        }
        next = Math.max(1, next);
      }
      setVisibleCount((prev) => (prev === next ? prev : next));
    };
    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(row);
    return () => observer.disconnect();
  }, [paneKey, visibleCount]);

  // The type allows an empty (area-backing) group with activeId null;
  // rendered bars never are, but render nothing rather than crash.
  if (group.activeId === null) return null;
  const activeId = group.activeId;
  const visibleIds = group.paneIds.slice(0, visibleCount);
  const hiddenIds = group.paneIds.slice(visibleCount);
  const hiddenTitles = hiddenIds
    .map((id) => dock.panes[id]?.title ?? id)
    .join(", ");
  // Expand is the window's ONE flag (D38): expandStackOf clears it (with an
  // optional activate-first for label clicks).
  const expandWindow = () => dock.expandStackOf(group.id);
  const expandToTab = (paneId: string) => dock.expandStackOf(group.id, paneId);
  // Pane-provided minimized face (D19): single-pane groups only (a multi-tab
  // bar must name its tabs).
  const face =
    group.paneIds.length === 1
      ? dock.panes[group.paneIds[0]]?.minimizedFace
      : undefined;
  return (
    <Box
      data-dock-group={group.id}
      data-dock-collapsed="true"
      // Horizontal bar marker: hitTest's collapsed branch uses X-based
      // label insertion + floating snap bands for it (vs the rail's
      // Y-based rows). Floating-only since D32.
      data-dock-bar="true"
      // The bar is a tablist of its visible labels (D36).
      role="tablist"
      aria-orientation="horizontal"
      onPointerDown={(event) => {
        // The bar owns its press; without this it would also arm an
        // enclosing surface's drag (P12: one press, one level).
        event.stopPropagation();
        startCollapsedGroupPress(
          dock,
          event,
          group.id,
          expandWindow,
          // A label's motionless click expands the window to that tab.
          (pane) => expandToTab(pane),
        );
      }}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        // Face bars keep the expanded header's own height (D19/D33): the
        // label row neither moves nor shrinks on minimize. Others use the
        // compact bar height.
        height: minimizedBarBasis(group, dock.panes),
        // D33 exact constancy: a face bar reproduces the header's side
        // padding and line-height, so the face's x/y offsets and the
        // compact toggle's right inset are identical in both states.
        padding: face !== undefined ? `0 ${HEADER_PAD_EM}em` : undefined,
        lineHeight: face !== undefined ? "1.5em" : undefined,
        // The panel's own surface, not chrome gray: a bar is the panel,
        // sleeping (user-directed; body color tracks light/dark scheme).
        backgroundColor: "var(--mantine-color-body)",
        flexShrink: 0,
        width: "100%",
        minWidth: 0,
        overflow: "hidden",
        cursor: "grab",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        opacity: dock.draggingGroupId === group.id ? 0.4 : 1,
      }}
    >
      {face !== undefined ? (
        // The face fills the label area exactly like the header's titleNode
        // box (D33): grow, centered, no extra padding of its own.
        <Box
          data-dock-tab={activeId}
          role="tab"
          aria-selected
          tabIndex={0}
          className={focusRing}
          onKeyDown={tabListKeyDown({
            paneId: activeId,
            paneIds: [activeId],
            prevKey: "ArrowLeft",
            nextKey: "ArrowRight",
            onActivate: (id) => {
              expandToTab(id);
              // A face bar backs an unmergeable panel, whose expanded form
              // renders no [data-dock-tab]: fall back to its header toggle
              // (edge case 14).
              focusPaneTabOrGroup(id, group.id);
            },
          })}
          style={{
            display: "flex",
            alignItems: "center",
            flexGrow: 1,
            minWidth: 0,
            cursor: "pointer",
          }}
        >
          {face}
        </Box>
      ) : (
        // The label row (D36): every tab label in order, visible while it
        // fits; the remainder goes visibility:hidden (still measured, never
        // a drop target) behind the +N badge. The row's empty space is the
        // bar's group-drag surface (the whole bar is the handle, D18).
        <Box
          ref={rowRef}
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "stretch",
            flexGrow: 1,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          {visibleIds.map((paneId) => (
            <BarLabel
              key={paneId}
              paneId={paneId}
              group={group}
              visibleIds={visibleIds}
              expandToTab={expandToTab}
            />
          ))}
          {hiddenIds.length > 0 && (
            // "+N": only the remainder (D36), named on hover.
            <Box
              ref={badgeRef}
              title={hiddenTitles}
              className={wayfindingText}
              style={{
                display: "flex",
                alignItems: "center",
                flexShrink: 0,
                padding: "0 0.5em",
                fontSize: "0.75em",
              }}
            >
              +{hiddenIds.length}
            </Box>
          )}
          {hiddenIds.map((paneId) => (
            <BarLabel
              key={paneId}
              paneId={paneId}
              group={group}
              visibleIds={visibleIds}
              expandToTab={expandToTab}
              hidden
            />
          ))}
        </Box>
      )}
      {/* Right-end expand toggle: single-group windows only (T4 -> D25's
      one-signifier budget; a multi-group window's + is its header's). The
      compact form on face bars matches the expanded header's toggle at the
      same inset (D33); the full-size form matches the grip bar's -. */}
      {expandControl && (
        <ChromeToggle
          expanded={false}
          label="Expand panel"
          onActivate={() => {
            expandWindow();
            // Unmergeable fallback (edge case 14): a face bar's expanded
            // form has no tab element -- focus the header's toggle instead
            // of dropping to <body>.
            focusPaneTabOrGroup(activeId, group.id);
          }}
          compact={face !== undefined}
        />
      )}
    </Box>
  );
}

/** One tab label on a bar (D36): dimmed wayfinding text, the active tab
 * mildly emphasized (weight + opacity -- the literal cousin of the expanded
 * tab strip's styling, minus the accent underline: nothing is shown, P3).
 * Hidden labels (behind the +N badge) keep their layout slot for
 * measurement but are invisible, unfocusable, and skipped by the drop
 * scanner. */
function BarLabel({
  paneId,
  group,
  visibleIds,
  expandToTab,
  hidden = false,
}: {
  paneId: string;
  group: TabGroup;
  visibleIds: string[];
  expandToTab: (paneId: string) => void;
  hidden?: boolean;
}) {
  const dock = useDock();
  const spec = dock.panes[paneId];
  const title = spec?.title ?? paneId;
  const active = paneId === group.activeId;
  return (
    <Box
      data-dock-tab={paneId}
      role="tab"
      aria-selected={active}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : 0}
      className={`${focusRing} ${wayfindingText}`}
      title={title}
      onKeyDown={tabListKeyDown({
        paneId,
        paneIds: visibleIds,
        prevKey: "ArrowLeft",
        nextKey: "ArrowRight",
        onActivate: (id) => {
          expandToTab(id);
          focusPaneTabOrGroup(id, group.id);
        },
      })}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.35em",
        flexShrink: 0,
        // Same side padding as an expanded tab (TabGroupFrame's strip):
        // P13/D33 exactness -- the label row keeps identical x offsets
        // across the minimize round-trip (the visual audit measured a 4px
        // drift at 0.6em).
        padding: "0 0.9em",
        cursor: "pointer",
        visibility: hidden ? "hidden" : undefined,
        fontWeight: active ? 600 : undefined,
        opacity: active ? 1 : 0.7,
      }}
    >
      {spec?.icon !== undefined && (
        <Box style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {spec.icon}
        </Box>
      )}
      <Box
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: "12em",
        }}
      >
        {title}
      </Box>
    </Box>
  );
}
