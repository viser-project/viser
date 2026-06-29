// Recursive renderer for a docked region's split tree. Leaves render a tab
// group; splits arrange their children along one axis with draggable dividers
// that redistribute flex weight between adjacent children.

import { Box, Paper } from "@mantine/core";
import React from "react";
import { useDock } from "./DockContext";
import { dragGesture, prefersReducedMotion } from "./gestures";
import {
  cascadeResize,
  expandStack,
  isColumnMinimized,
  isPureColumn,
  minimizeStack,
  setNodeWeights,
} from "./layoutOps";
import { StackHandleBar } from "./handles";
import { TabGroupFrame } from "./TabGroupFrame";
import { VerticalMinimizedColumn } from "./VerticalMinimizedColumn";
import {
  DOCK_ANIM_MS,
  DockEdge,
  DockNode,
  DockSplit,
  MIN_REGION_GRAB_PX,
  MINIMIZED_STRIP_PX,
  SPLIT_DIVIDER_PX,
} from "./types";

// Minimum height for a stacked (column) cell; row cells use the per-panel width.
const MIN_CELL_HEIGHT_PX = 50;

// Pointer grab width for a split divider. The divider only DRAWS a 1px rule (and
// reserves SPLIT_DIVIDER_PX of layout), but an invisible overlay widens the grab
// zone to this so it's comfortable to hit without thickening the seam.
const DIVIDER_GRAB_PX = 12;

/** Dispatches to a leaf or split renderer. Kept hook-free so the leaf/split
 * branches don't violate the Rules of Hooks when a node changes type.
 * Memoized: with a stable dock context, region-width / container-height
 * re-renders of the manager skip the whole docked tree (its props only change
 * identity when the layout itself changes). */
export const SplitView = React.memo(function SplitView({
  node,
  edge,
  topLevel = false,
}: {
  node: DockNode;
  edge: DockEdge;
  /** True only for a region's root (set by DockManager). A top-level pure
   * column gets a slim float-the-column handle; a top-level ROW passes the
   * flag to its children so its column children get handles. Never true
   * deeper (a normalized tree has no row directly inside a row). */
  topLevel?: boolean;
}) {
  const groups = useDock().groups;
  // A region root that is a SINGLE fully-minimized column renders as the
  // narrow vertical strip (a fully-minimized top-level ROW needs no special
  // case: each of its columns hits the collapsedInRow branch below). A pure
  // column keeps its handle above the strip, so minimize-all stays reversible
  // from the handle's expand button.
  // A fully-minimized PURE COLUMN renders as a vertical strip with a ColumnShell
  // float/expand handle above it -- at ANY depth, not just the region root, so a
  // minimized 2+ stack nested beside/under other panels keeps a way to expand
  // (its stacked cells have no individual +; the parent handle owns expand).
  if (
    node.type === "split" &&
    node.dir === "column" &&
    isPureColumn(node) &&
    isColumnMinimized(node, groups)
  ) {
    return (
      <ColumnShell node={node} edge={edge}>
        <VerticalMinimizedColumn node={node} edge={edge} />
      </ColumnShell>
    );
  }
  // A minimized region ROOT that is a single leaf/column renders as the bare
  // strip (no parent handle needed -- a lone leaf has its own + cap).
  if (
    topLevel &&
    isColumnMinimized(node, groups) &&
    (node.type === "leaf" || node.dir === "column")
  ) {
    return <VerticalMinimizedColumn node={node} edge={edge} />;
  }
  if (node.type === "leaf") {
    return <DockLeafView node={node} edge={edge} />;
  }
  if (topLevel && isPureColumn(node)) {
    return (
      <ColumnShell node={node} edge={edge}>
        <SplitNode node={node} edge={edge} />
      </ColumnShell>
    );
  }
  return (
    <SplitNode
      node={node}
      edge={edge}
      topLevel={topLevel && node.dir === "row"}
    />
  );
});

/** A top-level pure column's chrome: the float-the-column handle above its body
 * (the body is the caller's `children` -- a SplitNode when expanded, or a
 * VerticalMinimizedColumn when fully minimized). Both top-level pure-column
 * render paths share this shell. */
function ColumnShell({
  node,
  edge,
  children,
}: {
  node: DockSplit;
  edge: DockEdge;
  children: React.ReactNode;
}) {
  return (
    <Box
      data-dock-column={node.id}
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <ColumnHandle node={node} edge={edge} />
      <Box style={{ flexGrow: 1, minHeight: 0, minWidth: 0, display: "flex" }}>
        {children}
      </Box>
    </Box>
  );
}

/** Slim header at the top of a top-level PURE column (2+ stacked leaves):
 * dragging it floats the WHOLE column as one stacked window, then drags it.
 * Mirrors the floating multi-stack window header (FloatingWindowView),
 * including the minimize-all button (which collapses the whole column to a
 * vertical strip; the handle's + or the cells expand panes back out). */
function ColumnHandle({ node, edge }: { node: DockSplit; edge: DockEdge }) {
  const dock = useDock();
  // Pure column: every child is a leaf (the isPureColumn render gate).
  const groupIds = node.children.flatMap((c) =>
    c.type === "leaf" ? [c.group] : [],
  );
  const minimized = isColumnMinimized(node, dock.groups);
  const toggle = () =>
    dock.api.apply((l) =>
      minimized ? expandStack(l, groupIds) : minimizeStack(l, groupIds),
    );
  return (
    <StackHandleBar
      attrs={{ "data-dock-column-handle": node.id }}
      // A motionless press toggles minimize-all (the + button is dragThrough,
      // so its press arms this gesture); motion drags the whole column out.
      onPointerDown={(event) =>
        dock.startColumnDrag(event, edge, node.id, { onClick: toggle })
      }
      collapsed={minimized}
      // A fully-minimized column renders as a ~36px strip: no room for the
      // pill, the button fills the bar instead.
      narrow={minimized}
      onToggle={toggle}
    />
  );
}

function SplitNode({
  node,
  edge,
  topLevel = false,
}: {
  node: DockSplit;
  edge: DockEdge;
  topLevel?: boolean;
}) {
  const isRow = node.dir === "row";
  const dock = useDock();
  const groups = dock.groups;
  const resizing = dock.resizing;
  const containerRef = React.useRef<HTMLDivElement>(null);

  return (
    <Box
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: isRow ? "row" : "column",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {node.children.map((child, index) => {
        // A fully-minimized child in a vertical stack collapses to just its
        // handle(s) (content height -> 0), so its siblings expand to fill. Its
        // weight is preserved in the model and restored when expanded. Uses
        // isColumnMinimized (not a leaf-only `collapsed` check) so a minimized
        // nested SUBTREE -- e.g. a whole row of minimized columns -- also
        // collapses its height instead of holding a full-height empty band.
        const collapsedInColumn = !isRow && isColumnMinimized(child, groups);
        // A fully-minimized column stranded inside a row (a minimized column
        // behind an expanded one -- it can't float over the canvas) shrinks to
        // a compact handle width instead of holding a full-width empty box.
        // Its weight is preserved and restored on expand.
        const collapsedInRow = isRow && isColumnMinimized(child, groups);
        return (
        <React.Fragment key={child.id}>
          <Box
            style={{
              flexGrow: collapsedInColumn || collapsedInRow ? 0 : child.weight,
              flexShrink: collapsedInColumn || collapsedInRow ? 0 : 1,
              flexBasis: collapsedInColumn
                ? "auto"
                : collapsedInRow
                  ? MINIMIZED_STRIP_PX
                  : 0,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              // Animate collapse/expand: transitioning flex-grow + flex-basis
              // lets the cell shrink to its handle (vertically in a column, to a
              // narrow strip horizontally in a row) while its siblings grow
              // smoothly, matching the content's <Collapse>. Suppressed during an
              // active divider drag (a resize must track the cursor 1:1) and
              // under reduced-motion.
              transition:
                resizing || prefersReducedMotion()
                  ? undefined
                  : `flex-grow ${DOCK_ANIM_MS}ms ease, flex-basis ${DOCK_ANIM_MS}ms ease`,
            }}
          >
            {/* Always recurse into SplitView (even for a minimized column in a
            row): its own gates render a minimized pure column wrapped in
            ColumnShell, so the parent float-the-column handle stays present --
            instead of a bare VerticalMinimizedColumn that drops the handle. The
            cell's flex-basis above already shrinks it to the strip width. */}
            <SplitView node={child} edge={edge} topLevel={topLevel} />

          </Box>
          {index < node.children.length - 1 &&
            (() => {
              // The divider can resize only if there's a non-collapsed cell on
              // BOTH sides of it -- a divider between (or beside) only minimized
              // strips can't move anything, so it shows no resize cursor / drag.
              // A cell is "collapsed" (excluded from resize) when its whole
              // subtree is minimized -- a leaf, a column, OR a nested row of
              // minimized columns. isColumnMinimized covers all of them on
              // either axis, so the divider beside an all-minimized nested split
              // correctly shows no resize cursor.
              const isCollapsed = (c: DockNode) => isColumnMinimized(c, groups);
              const leftResizable = node.children
                .slice(0, index + 1)
                .some((c) => !isCollapsed(c));
              const rightResizable = node.children
                .slice(index + 1)
                .some((c) => !isCollapsed(c));
              return (
            <SplitDivider
              dir={node.dir}
              resizable={leftResizable && rightResizable}
              containerRef={containerRef}
              onResize={(deltaPx, containerPx) => {
                // Cells rendered at a fixed compact size are excluded from the
                // cascade (they neither give nor take space, and their weight is
                // preserved): a collapsed leaf in a column stack (handle height),
                // or a fully-minimized column in a row (handle width).
                const collapsed = node.children.map((c) =>
                  isColumnMinimized(c, groups),
                );
                const next = cascadeResize({
                  weights: node.children.map((c) => c.weight),
                  collapsed,
                  containerPx,
                  dividerIndex: index,
                  deltaPx,
                  minCell:
                    node.dir === "row" ? MIN_REGION_GRAB_PX : MIN_CELL_HEIGHT_PX,
                  // No per-panel width/height cap -- a cell may grow as far as
                  // its siblings' min widths allow (total is conserved).
                  maxCell: Infinity,
                });
                if (next === null) return;
                // Write new weights by node id. Expanded cells get their resized
                // PX size. A collapsed cell isn't resized, but its weight is its
                // RESTORE size, and the resize just put its siblings on a px
                // scale -- so we must rescale the collapsed cell's preserved
                // weight onto the same px basis (keeping its proportion), or on
                // expand it would render at a now-tiny flex-unit weight next to
                // px-magnitude siblings and collapse to ~0 height (off-screen).
                const totalAll =
                  node.children.reduce((s, c) => s + c.weight, 0) || 1;
                const byId: Record<string, number> = {};
                node.children.forEach((c, i) => {
                  byId[c.id] = collapsed[i]
                    ? (c.weight / totalAll) * containerPx
                    : next[i];
                });
                dock.api.apply((l) => setNodeWeights(l, edge, byId));
              }}
              onCancel={() => {
                // This closure is the one captured at drag start, so
                // node.children still holds the PRE-DRAG weights: writing them
                // back reverts every per-frame resize.
                const byId: Record<string, number> = {};
                node.children.forEach((c) => {
                  byId[c.id] = c.weight;
                });
                dock.api.apply((l) => setNodeWeights(l, edge, byId));
              }}
            />
              );
            })()}
        </React.Fragment>
        );
      })}
    </Box>
  );
}

function DockLeafView({ node, edge }: { node: DockNode; edge: DockEdge }) {
  if (node.type !== "leaf") return null;
  // No border (the top border in particular reads as ugly against the canvas);
  // panes are separated from the canvas by the region's shadow and from each
  // other by the split dividers.
  return (
    <Paper
      data-dock-leaf={node.id}
      data-dock-edge={edge}
      radius={0}
      style={{
        flexGrow: 1,
        minWidth: 0,
        minHeight: 0,
        // Column flex so the group inside controls its own HEIGHT via flexGrow
        // (a row parent would make flexGrow control width). This lets a docked
        // group's collapse animate as a smooth height change (TabGroupFrame puts
        // a flex transition on the group when filling).
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        backgroundColor: "var(--mantine-color-body)",
      }}
    >
      <DockLeafFrame groupId={node.group} />
    </Paper>
  );
}

// Resolve the leaf's group from the manager-provided groups map (via context)
// so split leaves don't need the group prop-drilled through the tree.
function DockLeafFrame({ groupId }: { groupId: string }) {
  const group = useDock().groups[groupId];
  if (group === undefined) return null;
  // Docked leaves can be resized narrower than the panel-content minimum, so
  // their body shows a persistent horizontal scrollbar pinned to the bottom.
  return <TabGroupFrame group={group} stripDragsGroup persistentScrollbar />;
}

/** Draggable divider between two split children. Reports the pointer delta
 * along the split axis plus the container's size, so the parent can convert it
 * into new flex weights. */
function SplitDivider({
  dir,
  resizable,
  containerRef,
  onResize,
  onCancel,
}: {
  dir: "row" | "column";
  /** False when both sides of the divider are minimized strips: nothing can
   * resize, so it shows no resize cursor and ignores drags. */
  resizable: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
  onResize: (deltaPx: number, containerPx: number) => void;
  /** Revert whatever per-frame onResize calls applied (Escape mid-drag). */
  onCancel: () => void;
}) {
  const isRow = dir === "row";
  const { setResizing } = useDock();
  // Cancel the in-flight gesture if the divider unmounts mid-drag (its split
  // can be restructured by another client), so the window listeners can't fire
  // after unmount and the shared `resizing` flag can't stick true.
  const activeDrag = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => activeDrag.current?.(), []);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!resizable) return; // nothing to resize between minimized strips
    if (activeDrag.current !== null) return; // one drag per divider
    event.stopPropagation();
    const container = containerRef.current;
    if (container === null) return;
    const rect = container.getBoundingClientRect();
    const containerPx = isRow ? rect.width : rect.height;
    const start = isRow ? event.clientX : event.clientY;
    // Suppress the column collapse/expand transition while dragging so the
    // resize tracks the cursor 1:1 (a column split would otherwise ease 200ms
    // behind every frame, which reads as a sluggish/broken resize).
    setResizing(true);

    let latest = start;
    activeDrag.current = dragGesture({
      grip: event.currentTarget,
      pointerId: event.pointerId,
      update: (e) => {
        latest = isRow ? e.clientX : e.clientY;
      },
      flush: () => onResize(latest - start, containerPx),
      onEnd: (cancelled) => {
        activeDrag.current = null;
        setResizing(false);
        if (cancelled) onCancel();
      },
    });
  };

  // Hit area wider than the divider's layout footprint: the outer box keeps its
  // SPLIT_DIVIDER_PX so the panels don't shift, while an absolutely-positioned
  // overlay extends the grab zone to ~DIVIDER_GRAB_PX (centered, overhanging the
  // adjacent panels' edges by a few px) -- only when resizable. The thin 1px rule
  // is still all that's drawn.
  const overhang = resizable
    ? Math.max(0, (DIVIDER_GRAB_PX - SPLIT_DIVIDER_PX) / 2)
    : 0;
  return (
    <Box
      onPointerDown={onPointerDown}
      style={{
        position: "relative",
        flexShrink: 0,
        [isRow ? "width" : "height"]: SPLIT_DIVIDER_PX,
        cursor: !resizable ? "default" : isRow ? "ew-resize" : "ns-resize",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        touchAction: "none",
        zIndex: 2,
      }}
    >
      {/* Invisible grab overlay (wider than the drawn rule), so the divider is
      easy to grab without thickening the seam. */}
      {resizable && (
        <Box
          style={{
            position: "absolute",
            [isRow ? "top" : "left"]: 0,
            [isRow ? "bottom" : "right"]: 0,
            [isRow ? "left" : "top"]: -overhang,
            [isRow ? "width" : "height"]: SPLIT_DIVIDER_PX + 2 * overhang,
          }}
        />
      )}
      <Box
        style={{
          [isRow ? "width" : "height"]: "1px",
          [isRow ? "height" : "width"]: "100%",
          backgroundColor: "var(--mantine-color-default-border)",
          opacity: 0.5,
        }}
      />
    </Box>
  );
}
