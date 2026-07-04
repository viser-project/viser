// A fully-minimized docked ROW BAND (among sibling bands) rendered as a short
// FULL-WIDTH horizontal bar -- a collapsed section header spanning the region
// width, with one labeled segment per group. Click a segment to expand the
// band to that tab; the bar's empty area expands the whole band. This is the
// band-level analog of VerticalMinimizedColumn (which renders a minimized
// COLUMN as a narrow vertical rail): a band is horizontal, so its collapsed
// form is too -- and it borrows the rail's aesthetic wholesale (body-colored
// surface, gray + cap, dimmed spine-style labels, hairline dividers), just
// rotated 90 degrees.
//
// A LONE minimized band keeps the full-height vertical rail (see SplitView):
// with nothing beside it the band fills the region, so the rail reads as the
// whole minimized region. This horizontal bar is only for a band that shares
// the region with expanded sibling bands, where a 36px-tall full-width strip is
// the natural collapsed look.

import { Box } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import React from "react";
import { useDock } from "./DockContext";
import { focusRing, gripBarBg } from "./DockStyles.css";
import { focusPaneTab, tabListKeyDown } from "./gestures";
import { startCollapsedGroupPress } from "./collapsedPress";
import { HandleIconButton } from "./handles";
import { collectLeaves, expandStack } from "./layoutOps";
import { DockEdge, DockRow, MINIMIZED_STRIP_PX, TabGroup } from "./types";

/** Hairline between minimized segments -- the horizontal counterpart of the
 * vertical rail's divider between stacked cells. */
export function ChipDivider() {
  return (
    <Box
      style={{
        width: 1,
        alignSelf: "stretch",
        flexShrink: 0,
        backgroundColor: "var(--mantine-color-default-border)",
        opacity: 0.5,
      }}
    />
  );
}

export function HorizontalMinimizedBand({
  row,
  edge,
}: {
  row: DockRow;
  edge: DockEdge;
}) {
  const dock = useDock();
  // Every leaf in the band (across its columns), in render order. Each becomes
  // a segment that is ALSO a docked drop target (data-dock-leaf/-edge), so a
  // minimized band stays a drop target -- and the seam-extent math in hitTest,
  // which reads leaf rects, still sees the band.
  const leaves = row.columns.flatMap((c) => collectLeaves(c));
  const groupIds = leaves.map((l) => l.group);
  const expandAll = () => dock.api.apply((l) => expandStack(l, groupIds));
  return (
    <Box
      // The band box (SplitView) already sizes us to MINIMIZED_STRIP_PX tall via
      // flex-basis; fill it and lay the segments out horizontally. The empty
      // area is a grab/expand affordance for the whole band.
      data-dock-minimized-band={row.id}
      onPointerDown={(event) => {
        // A press on the bar's background (not a segment) drags the WHOLE
        // band out as one stack (spec D2), or -- motionless -- expands the
        // whole band. Segments handle their own press (their container
        // handles it; the press never reaches here).
        dock.startBandDrag(event, edge, row.id, { onClick: expandAll });
      }}
      className={gripBarBg}
      style={{
        width: "100%",
        height: MINIMIZED_STRIP_PX,
        minHeight: MINIMIZED_STRIP_PX,
        flexShrink: 0,
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        overflowX: "hidden",
        overflowY: "hidden",
        cursor: "grab",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {leaves.map(({ id: nodeId, group: groupId }, i) => {
        const g = dock.groups[groupId];
        if (g === undefined) return null;
        // One segment per group (see MinimizedGroupChip below); the wrapper
        // also carries data-dock-leaf/-edge so it is a DOCKED drop target (the
        // collapsed branch in hitTest gives it 5-way zones), keeping a
        // minimized band droppable just like the vertical rail's cells.
        return (
          // Outer wrapper carries data-dock-leaf/-edge (the DOCKED drop target
          // collectTargets scans for; it reads data-dock-group from a
          // DESCENDANT, so the group marker must be nested, not on this
          // element).
          <React.Fragment key={nodeId}>
            {i > 0 && <ChipDivider />}
            <Box
              data-dock-leaf={nodeId}
              data-dock-edge={edge}
              // The wrapper IS the drop target (collectTargets reads its rect),
              // so it tiles the bar: full height and an equal share of the
              // width, leaving NO dead strip that a drop would fall through --
              // the whole visible bar is droppable, matching the vertical
              // rail's full-width cells. The segment's visual content stays
              // compact inside.
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

/** ONE minimized group rendered as its HEADER kept in place (spec P13/D10):
 * one dimmed icon+title LABEL PER TAB laid out from the left (literal
 * cousins of the expanded tab strip), and -- where per-group expand is a
 * real, distinct action (band-bar segments) -- the `+` toggle at the
 * segment's RIGHT end, exactly where the expanded grip bar's `-` sat, so
 * the minimize/expand toggle is spatially stable. Chip-bar segments render
 * withToggle=false: the WINDOW owns expand there (P9) via the bar's own
 * right-end `+`.
 *
 * Gestures (shared with the rail via startCollapsedGroupPress): pressing a
 * label tears out THAT pane (still minimized; single-pane groups move the
 * whole group instead, keeping ids stable); pressing the background (or
 * dragging through the `+`) drags the whole group; a motionless click on a
 * label expands to that tab, on the background/`+` expands the group.
 * Labels that don't fit are hidden behind a "+N" badge (visibility:hidden
 * keeps their geometry stable so the overflow measurement can't feed back
 * into itself). */
export function MinimizedGroupChip({
  group,
  withToggle = true,
}: {
  group: TabGroup;
  /** False on chip-bar segments: uniform-collapse makes any expand there a
   * WINDOW-level action, and the bar's right-end `+` owns that signifier
   * (P9) -- segments render labels only. */
  withToggle?: boolean;
}) {
  const dock = useDock();
  const labelsRef = React.useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = React.useState(group.paneIds.length);
  // Overflow measurement: how many labels fit fully inside the labels box.
  // Hidden labels keep their layout (visibility, not display), so measuring
  // is stable across re-renders and can't oscillate.
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

  // A rendered chip's group is never empty, but the type says an empty
  // (area-backing) group has activeId null -- render nothing for it.
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
      // Marks this collapsed group as a horizontal CHIP (vs the vertical
      // rail cell): hitTest's collapsed branch uses X-based label insertion
      // and the D4 zone rules for it.
      data-dock-chip="true"
      onPointerDown={(event) => {
        // Segments own their press: without this the press ALSO bubbles to
        // the bar's whole-band drag (D2) and two gestures fight.
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
      {/* One label per tab (the rail's spine rows, horizontal). */}
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
              className={focusRing}
              title={title}
              onKeyDown={onKeyDown}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.35em",
                minWidth: 0,
                flexShrink: 0,
                paddingLeft: "0.55em",
                paddingRight: "0.7em",
                color: "var(--mantine-color-dimmed)",
                opacity: 0.85,
                fontWeight: 500,
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
                  fontSize: "0.85em",
                  maxWidth: "10em",
                }}
              >
                {title}
              </Box>
            </Box>
          );
        })}
      </Box>
      {/* Overflow badge: the D9 degradation when labels don't fit. */}
      {hiddenCount > 0 && (
        <Box
          title={hiddenTitles}
          style={{
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            paddingRight: "0.5em",
            color: "var(--mantine-color-dimmed)",
            opacity: 0.85,
            fontWeight: 500,
            fontSize: "0.75em",
          }}
        >
          +{hiddenCount}
        </Box>
      )}
      {withToggle && (
        <>
          {/* Background slack between labels and the toggle: part of the
          segment's group-drag surface. */}
          <Box style={{ flexGrow: 1 }} />
          {/* The P13 toggle: `+` at the segment's RIGHT end, where the
          expanded grip bar's `-` sits. Drag-through: a press flows to the
          segment's group drag; a motionless click (via the drag-starter's
          onClick) or Enter/Space expands. */}
          <HandleIconButton
            attrs={{ "data-dock-minimize": "true" }}
            label="Expand panel"
            title="Expand"
            expanded={false}
            dragThrough
            onActivate={() => {
              const active = group.activeId;
              expandGroup();
              if (active !== null) focusPaneTab(active);
            }}
            placement={{ width: "1.7em", height: "100%", flexShrink: 0 }}
          >
            <IconPlus size={12} />
          </HandleIconButton>
        </>
      )}
    </Box>
  );
}
