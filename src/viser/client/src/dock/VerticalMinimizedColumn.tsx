// A fully-minimized docked column rendered as a narrow vertical strip: one
// cell per leaf, with an upright icon and a rotated (book-spine) title.
// Click expands; drag floats the group (the same click-vs-drag gesture as the
// unmergeable header). Renders every fully-minimized docked column: stranded
// inside a row split or spanning a whole region root.

import { Box, Paper } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import React from "react";
import { useDock } from "./DockContext";
import { gripBarBg, focusRing } from "./DockStyles.css";
import { focusPaneTab, tabListKeyDown } from "./gestures";
import { GripPill, HandleIconButton, StackHandleBar } from "./handles";
import { startCollapsedGroupPress } from "./collapsedPress";
import { DockColumn, DockEdge, DockRegion, NodeId, TabGroup } from "./types";
import { collectLeaves, expandStack } from "./layoutOps";

export function VerticalMinimizedColumn({
  column,
  edge,
}: {
  column: DockColumn;
  edge: DockEdge;
}) {
  const dock = useDock();
  const leaves = collectLeaves(column);
  return (
    <Paper
      radius={0}
      style={{
        flexGrow: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        // Scroll vertically when there are more cells/rows than fit (a short
        // viewport with many minimized tabs); never scroll horizontally (the
        // strip is intentionally narrow). Keeps every tab reachable instead of
        // clipping the lower ones.
        overflowX: "hidden",
        overflowY: "auto",
        backgroundColor: "var(--mantine-color-body)",
      }}
    >
      {leaves.map(({ id, group }, i) => {
        const g = dock.groups[group];
        if (g === undefined) return null;
        return (
          <React.Fragment key={id}>
            {i > 0 && (
              <Box
                style={{
                  height: 1,
                  flexShrink: 0,
                  backgroundColor: "var(--mantine-color-default-border)",
                  opacity: 0.5,
                }}
              />
            )}
            <VerticalMinimizedCell
              nodeId={id}
              edge={edge}
              group={g}
              inStack={leaves.length > 1}
            />
          </React.Fragment>
        );
      })}
    </Paper>
  );
}

/** The ALL-MINIMIZED region rendered as ONE packed rail (spec 3.2): every
 * leaf across every band, top to bottom, as contiguous cells -- the band
 * structure stays in the MODEL (expanding restores it), but visually the
 * region is a single 36px rail so the canvas gets its width back. Without
 * this, each band would strand its content-tall cell inside a proportional
 * band slot, fragmenting the rail with dead gaps.
 *
 * The narrow StackHandleBar on top is the rail's parent handle: drag floats
 * the WHOLE region as one window; the motionless click / `+` expands every
 * group (P9: the rail's one expand-all signifier). */
export function RegionMinimizedRail({
  region,
  edge,
}: {
  region: DockRegion;
  edge: DockEdge;
}) {
  const dock = useDock();
  const leaves = region.rows.flatMap((r) =>
    r.columns.flatMap((c) => collectLeaves(c)),
  );
  const groupIds = leaves.map((l) => l.group);
  const expandAll = () =>
    dock.api.apply((l) => expandStack(l, groupIds));
  return (
    <Box
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <StackHandleBar
        attrs={{ "data-dock-region-rail": edge }}
        onPointerDown={(event) =>
          dock.startRegionDrag(event, edge, { onClick: expandAll })
        }
        collapsed
        narrow
        onToggle={expandAll}
      />
      <Paper
        radius={0}
        style={{
          flexGrow: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflowX: "hidden",
          overflowY: "auto",
          backgroundColor: "var(--mantine-color-body)",
        }}
      >
        {leaves.map(({ id, group }, i) => {
          const g = dock.groups[group];
          if (g === undefined) return null;
          return (
            <React.Fragment key={id}>
              {i > 0 && (
                <Box
                  style={{
                    height: 1,
                    flexShrink: 0,
                    backgroundColor: "var(--mantine-color-default-border)",
                    opacity: 0.5,
                  }}
                />
              )}
              <VerticalMinimizedCell
                nodeId={id}
                edge={edge}
                group={g}
                // inStack: the parent handle owns the ONE expand-all + (P9);
                // expanding a single band is the spine ROW's click
                // (expand-to-tab), so per-cell + caps would be a third
                // signifier for actions the rows already own.
                inStack={leaves.length > 1}
              />
            </React.Fragment>
          );
        })}
      </Paper>
    </Box>
  );
}

/** One fully-minimized group rendered as a narrow vertical strip cell: an
 * upright + cap and one book-spine row per tab. Used both for DOCKED minimized
 * columns (pass nodeId/edge so the cell becomes a 5-way docked drop target) and
 * for a minimized FLOATING window (no nodeId/edge -- the floating window is
 * already a drop target via its own [data-floating-window] scan). The
 * click/drag gestures are identical in both contexts: the dock context resolves
 * group.id's current location, so startGroupDrag moves/tears the floating
 * window and startTabTearOut tears a single pane out of either. */
export function VerticalMinimizedCell({
  nodeId,
  edge,
  group,
  inStack = false,
}: {
  /** Docked only: the leaf's node id + region edge, emitted as
   * data-dock-leaf/-edge so collectTargets offers the cell as a docked drop
   * target. Omitted for a floating cell. */
  nodeId?: NodeId;
  edge?: DockEdge;
  group: TabGroup;
  /** True when this cell is one of 2+ in a minimized stack. Then minimize/
   * expand is owned by the parent stack handle, so the cell's cap is a plain
   * drag-grip bar (no +) -- matching an expanded stacked panel's grip. A LONE
   * minimized cell keeps its own + expand button. */
  inStack?: boolean;
}) {
  const dock = useDock();
  const docked = nodeId !== undefined && edge !== undefined;
  const inner = (
      <Box
        data-dock-group={group.id}
        data-dock-collapsed="true"
        onPointerDown={(event) =>
          // Pressing a tab ROW tears out only that pane; pressing the cap/empty
          // area drags the whole group (still minimized). A LONE cell toggles
          // expand on a no-motion click (its cap is the + button); a STACKED
          // cell passes no onClick -- minimize/expand is owned by the parent
          // stack handle. (Shared with the minimized-band chip.)
          startCollapsedGroupPress(
            dock,
            event,
            group.id,
            inStack ? undefined : () => dock.toggleCollapsed(group.id),
          )
        }
        style={{
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          cursor: "grab",
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          overflow: "hidden",
          opacity: dock.draggingGroupId === group.id ? 0.4 : 1,
        }}
      >
        {/* Gray cap. For a LONE minimized cell it holds the + expand button (the
        + IS the handle: drag-through tears out the panel, a motionless click
        expands in place). For a cell in a 2+ STACK, minimize/expand is owned by
        the PARENT stack handle, so the cap is just a drag-grip pill -- no + --
        matching an expanded stacked panel's grip bar. */}
        <Box
          className={gripBarBg}
          style={{
            flexShrink: 0,
            width: "100%",
            ...(inStack
              ? {
                  height: "1em",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }
              : {}),
          }}
        >
          {inStack ? (
            // Smaller + more subtle than a full grip pill: the cell is just a
            // label in a minimized stack, and the parent handle is the primary
            // drag/expand affordance.
            <GripPill width="0.9em" opacity={0.35} />
          ) : (
            <HandleIconButton
              attrs={{ "data-dock-minimize": "true" }}
              label="Expand panel"
              title="Expand"
              expanded={false}
              onActivate={() => dock.toggleCollapsed(group.id)}
              dragThrough
              // Static placement filling the cap (not bar-anchored).
              placement={{ width: "100%", height: "1.7em" }}
            >
              <IconPlus size={12} />
            </HandleIconButton>
          )}
        </Box>
        {/* One row PER TAB: upright icon + rotated (book-spine) label. Each row
        is its own tab control -- click, or keyboard (Enter/Space to expand to
        it, Up/Down to move focus between rows) -- so a multi-tab minimized panel
        shows ALL its tabs instead of one arbitrary icon plus a confusing joined
        label. The whole cell remains draggable for tear-out (handled by the
        cell's onPointerDown above). role="tablist"/"tab" + keyboard support keep
        the strip accessible, mirroring the expanded tab strip. */}
        <Box
          role="tablist"
          aria-orientation="vertical"
          // Breathing room above (between the + handle cap and the labels) AND
          // below the labels, so the spine titles sit centered in the strip
          // rather than crammed against the bottom edge.
          style={{ width: "100%", marginTop: "0.6em", marginBottom: "0.6em" }}
        >
          {group.paneIds.map((paneId) => {
            const spec = dock.panes[paneId];
            const active = paneId === group.activeId;
            // Up/Down move focus between rows; Enter/Space expand to this tab.
            // No onMove: arrowing through a minimized strip shouldn't expand it
            // (that's what Enter/Space + click do).
            const onKeyDown = tabListKeyDown({
              paneId,
              paneIds: group.paneIds,
              prevKey: "ArrowUp",
              nextKey: "ArrowDown",
              onActivate: (id) => {
                dock.expandToTab(group.id, id);
                // Keyboard expand unmounts this row; land focus on the
                // expanded strip's tab instead of dropping it to <body>.
                focusPaneTab(id);
              },
            });
            return (
              <Box
                key={paneId}
                data-dock-tab={paneId}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                className={focusRing}
                title={spec?.title ?? paneId}
                onKeyDown={onKeyDown}
                style={{
                  // Keep each row at its content height (icon + capped label);
                  // the strip scrolls when rows overflow rather than squashing.
                  flexShrink: 0,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  width: "100%",
                  paddingTop: "0.35em",
                  paddingBottom: "0.6em",
                  cursor: "pointer",
                  // All rows read uniformly as dimmed wayfinding chrome -- a
                  // minimized strip is a label/affordance, not content, so an
                  // active-tab highlight here just distracts. (aria-selected
                  // still marks the logical active tab for assistive tech.)
                  color: "var(--mantine-color-dimmed)",
                  opacity: 0.85,
                }}
              >
                {spec?.icon !== undefined && (
                  // Icons don't read rotated -- keep them upright.
                  <Box
                    style={{
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      marginBottom: "0.3em",
                    }}
                  >
                    {spec.icon}
                  </Box>
                )}
                {/* Book-spine orientation (top-to-bottom, rotated clockwise):
                the portable vertical-text form (sideways-lr isn't Safari-OK).
                maxHeight caps the spine so a long title ELLIPSIZES into a tidy
                fixed length (in vertical-rl, the run length is the box's height,
                so without a cap a long label would stretch the whole strip). */}
                <Box
                  style={{
                    writingMode: "vertical-rl",
                    textOrientation: "mixed",
                    fontSize: "0.85em",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minHeight: 0,
                    maxHeight: "14em",
                  }}
                >
                  {spec?.title ?? paneId}
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>
  );
  // Docked: wrap in a data-dock-leaf/-edge Box so collectTargets offers the cell
  // as a docked drop target (hitTest's collapsed branch then gives it the 5-way
  // drop zones). Floating: no wrapper attrs -- the floating window is already a
  // drop target via the [data-floating-window] scan, and the cell must fill the
  // window's width.
  return docked ? (
    <Box
      data-dock-leaf={nodeId}
      data-dock-edge={edge}
      // Size to content (flexGrow:0, flexShrink:0): the cell's bounding rect must
      // equal its VISIBLE strip, or hitTest computes drop zones/hints against a
      // region-tall box (phantom "bottom split" far below the rows, merge
      // highlight over empty canvas). The column's Paper scrolls (overflowY) when
      // the cells don't all fit, rather than stretching them.
      style={{
        flexGrow: 0,
        flexShrink: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        width: "100%",
      }}
    >
      {inner}
    </Box>
  ) : (
    inner
  );
}
