// Minimized HORIZONTAL chrome (spec 3.3 + 3.4): the band bar (a fully-
// minimized docked band among expanded siblings) and the per-group SEGMENT
// shared with the floating chip bar. Both are the P13 form -- the expanded
// header kept in place: grip-bar gray surface, grip pill, the tab labels as
// dimmed wayfinding rows, and the +/- toggle at the RIGHT end where the
// expanded header's `-` sits. A lone minimized band renders the vertical
// rail instead (see SplitView / spec 3.2): the bar is only for a band with
// expanded siblings, where a 36px strip is the natural collapsed form.

import { Box } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { focusRing, gripBarBg, wayfindingText } from "./DockStyles.css";
import { focusPaneTab, tabListKeyDown } from "./gestures";
import { startCollapsedGroupPress } from "./collapsedPress";
import { ChromeDivider, ChromeToggle, GripPill } from "./handles";
import { collectLeaves, expandStack } from "./layoutOps";
import { DockEdge, DockRow, MINIMIZED_STRIP_PX, TabGroup } from "./types";

/** Re-export under the legacy name used by FloatingWindowView. */
export function ChipDivider() {
  return <ChromeDivider vertical />;
}

export function HorizontalMinimizedBand({
  row,
  edge,
}: {
  row: DockRow;
  edge: DockEdge;
}) {
  const dock = useDock();
  // Every leaf in the band, in render order. Each becomes a segment that is
  // ALSO a docked drop target (data-dock-leaf/-edge), so the minimized band
  // stays droppable and hitTest's seam-extent math still sees it.
  const leaves = row.columns.flatMap((c) => collectLeaves(c));
  const groupIds = leaves.map((l) => l.group);
  const expandAll = () => dock.api.apply((l) => expandStack(l, groupIds));
  return (
    <Box
      data-dock-minimized-band={row.id}
      className={gripBarBg}
      onPointerDown={(event) =>
        // Background press: drag the WHOLE band as one stack (D2);
        // motionless click expands the whole band. Segments stopPropagation.
        dock.startBandDrag(event, edge, row.id, { onClick: expandAll })
      }
      style={{
        width: "100%",
        height: MINIMIZED_STRIP_PX,
        minHeight: MINIMIZED_STRIP_PX,
        flexShrink: 0,
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        overflow: "hidden",
        cursor: "grab",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {leaves.map(({ id: nodeId, group: groupId }, i) => {
        const g = dock.groups[groupId];
        if (g === undefined) return null;
        return (
          <React.Fragment key={nodeId}>
            {i > 0 && <ChromeDivider vertical />}
            {/* The wrapper carries data-dock-leaf/-edge: it IS the docked
            drop target (collectTargets reads its rect), tiling the bar so
            the whole visible surface is droppable. The group marker must be
            on a DESCENDANT (collectTargets scopes tabs by group element). */}
            <Box
              data-dock-leaf={nodeId}
              data-dock-edge={edge}
              style={{
                flexGrow: 1,
                flexBasis: 0,
                minWidth: 0,
                height: "100%",
                display: "flex",
                alignItems: "stretch",
              }}
            >
              <MinimizedGroupChip group={g} />
            </Box>
          </React.Fragment>
        );
      })}
    </Box>
  );
}

/** ONE minimized group as its header kept in place (P13/D10): grip pill,
 * one wayfinding label per tab (D9), a "+N" badge when labels overflow, and
 * -- where per-group expand is a real distinct action (band bar; single-group
 * floating bar) -- the ChromeToggle at the right end. Chip-bar segments in a
 * multi-group window render withToggle=false: uniform-collapse makes expand
 * window-level there, and the BAR's toggle owns that signifier (P9).
 *
 * Gestures (shared with the rail via startCollapsedGroupPress): a label
 * press tears out THAT pane, still minimized (single-pane groups float
 * wholesale, ids stable); any other press drags the whole group; motionless
 * clicks expand (label: to that tab; elsewhere: the group). */
export function MinimizedGroupChip({
  group,
  withToggle = true,
}: {
  group: TabGroup;
  withToggle?: boolean;
}) {
  const dock = useDock();
  const labelsRef = React.useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = React.useState(group.paneIds.length);
  // Overflow: count labels that fit fully. Hidden labels keep their layout
  // (visibility, not display) so measurement cannot oscillate.
  React.useEffect(() => {
    const el = labelsRef.current;
    if (el === null) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      let fit = 0;
      for (const child of Array.from(el.children)) {
        if (child.getBoundingClientRect().right <= box.right + 1) fit += 1;
        else break;
      }
      setVisibleCount(Math.max(1, fit));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [group.paneIds.length]);

  // The type allows an empty (area-backing) group with activeId null;
  // rendered chips never are, but render nothing rather than crash.
  if (group.activeId === null) return null;
  const hiddenCount = group.paneIds.length - visibleCount;
  const hiddenTitles = group.paneIds
    .slice(visibleCount)
    .map((id) => dock.panes[id]?.title ?? id)
    .join(", ");
  const expandGroup = () => dock.toggleCollapsed(group.id);
  return (
    <Box
      data-dock-group={group.id}
      data-dock-collapsed="true"
      // Horizontal CHIP marker: hitTest's collapsed branch uses X-based
      // label insertion + the D4 zone rules for it (vs the rail's Y-based).
      data-dock-chip="true"
      onPointerDown={(event) => {
        // Segments own their press; without this it would ALSO arm the
        // bar's band/window drag (P12: one press, one level).
        event.stopPropagation();
        startCollapsedGroupPress(dock, event, group.id, expandGroup);
      }}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        height: "100%",
        width: withToggle ? "100%" : undefined,
        minWidth: 0,
        cursor: "grab",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        opacity: dock.draggingGroupId === group.id ? 0.4 : 1,
      }}
    >
      {/* The header's grip pill, kept (P13): the drag signifier. */}
      <Box
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          paddingLeft: "0.5em",
          paddingRight: "0.15em",
        }}
      >
        <GripPill width="1.1em" opacity={0.5} />
      </Box>
      {/* One label per tab: the header's tabs, restyled to wayfinding. */}
      <Box
        ref={labelsRef}
        role="tablist"
        aria-orientation="horizontal"
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "stretch",
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        {group.paneIds.map((paneId, i) => {
          const spec = dock.panes[paneId];
          const title = spec?.title ?? paneId;
          const onKeyDown = tabListKeyDown({
            paneId,
            paneIds: group.paneIds,
            prevKey: "ArrowLeft",
            nextKey: "ArrowRight",
            onActivate: (id) => {
              dock.expandToTab(group.id, id);
              focusPaneTab(id);
            },
          });
          return (
            <Box
              key={paneId}
              data-dock-tab={paneId}
              role="tab"
              aria-selected={paneId === group.activeId}
              tabIndex={0}
              className={`${focusRing} ${wayfindingText}`}
              title={title}
              onKeyDown={onKeyDown}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.35em",
                minWidth: 0,
                flexShrink: 0,
                paddingLeft: "0.5em",
                paddingRight: "0.5em",
                cursor: "pointer",
                visibility: i < visibleCount ? undefined : "hidden",
              }}
            >
              {spec?.icon !== undefined && (
                <Box
                  style={{
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  {spec.icon}
                </Box>
              )}
              <Box
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "10em",
                }}
              >
                {title}
              </Box>
            </Box>
          );
        })}
      </Box>
      {/* D9 degradation: hidden labels collapse into a "+N" badge. */}
      {hiddenCount > 0 && (
        <Box
          title={hiddenTitles}
          className={wayfindingText}
          style={{
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            paddingRight: "0.5em",
            fontSize: "0.75em",
          }}
        >
          +{hiddenCount}
        </Box>
      )}
      {withToggle && (
        <>
          {/* Slack: part of the segment's group-drag surface. */}
          <Box style={{ flexGrow: 1 }} />
          <ChromeToggle
            expanded={false}
            label="Expand panel"
            onActivate={() => {
              const active = group.activeId;
              expandGroup();
              if (active !== null) focusPaneTab(active);
            }}
          />
        </>
      )}
    </Box>
  );
}
