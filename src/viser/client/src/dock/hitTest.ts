// Pure drop-zone hit-testing for the docking surface.
//
// Given the current layout, region widths, container geometry, and the drop
// targets' rects (collected from the DOM by DockManager), this resolves which
// drop a pointer position maps to, plus the geometry of the visual hint. It is
// intentionally DOM-free so it can be unit tested with synthetic rects.

import { edgeIsSingleLeaf } from "./layoutOps";
import {
  AreaId,
  clamp,
  DockEdge,
  DockLayout,
  DropRegion,
  GroupId,
  NodeId,
  PaneId,
  WindowId,
} from "./types";

// Re-exported for existing consumers; the constant lives in types.ts now that
// the region width is part of the layout MODEL (DockLayout.regionWidth).
export { DEFAULT_REGION_PX } from "./types";
import { DEFAULT_REGION_PX } from "./types";
// Screen-edge zone width (only active on an empty edge).
const EDGE_ZONE_PX = 48;
// Thin band at a docked region's outer top/bottom edge -> full-span row above/
// below ALL columns. Kept thin so it doesn't shadow the topmost panes' grip
// bars (where per-panel "above this one" lives); it sits at the screen edge for
// left/right regions, so it's still easy to hit by slamming the cursor up/down.
const REGION_EDGE_PX = 8;
// Wider band at a region's left/right edges -> full-height column beside all.
const REGION_SIDE_PX = 40;
// Band fraction (of the content area) for a per-panel left/right split, capped
// in pixels so it doesn't balloon on a wide panel.
const SPLIT_BAND = 0.22;
const SPLIT_BAND_H_MAX_PX = 70;
// Above/below splits use a smaller band, also capped in pixels so it doesn't
// balloon on a tall panel -- the bulk of the content area stays "merge".
const SPLIT_BAND_V = 0.15;
const SPLIT_BAND_V_MAX_PX = 70;

/** Where a drop will land, resolved from the pointer during a drag.
 * - edge: dock as a new outer column on an empty screen edge.
 * - regionEdge: dock a full-span band beside everything in a region.
 * - split: split a docked leaf's cell along one side.
 * - merge: append into an existing group's tab strip.
 * - insertTab: insert into an existing group's tabs at a specific index.
 * - snap: insert into a floating window's vertical stack at a specific index. */
export type DropResult =
  | { kind: "edge"; edge: DockEdge }
  | {
      kind: "regionEdge";
      edge: DockEdge;
      side: "top" | "bottom" | "left" | "right";
    }
  | {
      kind: "split";
      edge: DockEdge;
      nodeId: NodeId;
      region: Exclude<DropRegion, "center">;
    }
  | { kind: "merge"; targetGroupId: GroupId }
  | { kind: "insertTab"; targetGroupId: GroupId; index: number }
  | { kind: "snap"; windowId: WindowId; index: number };

/** Context telling whether a group sits in a docked leaf (supports splits) or a
 * floating window stack (supports snapping at an index). */
export type GroupContext =
  | { kind: "docked"; nodeId: NodeId; edge: DockEdge }
  | { kind: "floating"; windowId: WindowId; index: number }
  | { kind: "area"; areaId: AreaId };

/** A group's geometry captured once at drag start, with its strip and tab rects
 * for tab-position and split/snap targeting. */
export interface GroupTarget {
  groupId: GroupId;
  rect: DOMRect;
  /** Optional smaller rect used for HIT detection only (which target the pointer
   * is over), while `rect` still drives the visual hint. Lets a full-bleed area
   * keep a full-width merge highlight while leaving an inset frame around it that
   * falls through to the host panel's edge zones. Defaults to `rect`. */
  hitRect?: DOMRect;
  stripRect: DOMRect | null;
  tabs: { paneId: PaneId; rect: DOMRect }[];
  ctx: GroupContext;
  /** True when the group is minimized (only its handle shows). Such a target
   * has no content area, so its whole bar is treated as a 5-way drop zone.
   * Optional so existing target literals (e.g. in tests) stay valid. */
  collapsed?: boolean;
  /** True when the group holds an unmergeable panel: nothing may be merged or
   * inserted into it, so its content area is merge-suppressed (drops there fall
   * back to a split / no-op) and its label is a header rather than a tab. */
  unmergeable?: boolean;
}

export interface DropTargets {
  groups: GroupTarget[];
}

/** Visual hint, in container-relative px.
 * - line: a thin insertion bar marking a boundary -- used for ALL "insert here"
 *   drops (per-panel splits, region-edge spans, tab/stack insertions) so they
 *   read consistently.
 * - merge: highlight over a whole group (tab merge).
 * - fill: a solid translucent zone (dock onto an empty screen edge). */
export interface DropHint {
  left: number;
  top: number;
  width: number;
  height: number;
  variant: "merge" | "fill" | "line";
}

/** Container geometry the pointer is resolved against (a DOMRect works). */
export interface ContainerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const inside = (r: DOMRect, x: number, y: number) =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

/** Whether a pointer hits a drop target.
 *
 * Normally just `inside(hitRect ?? rect)`. The one wrinkle is a nested area's
 * inset `hitRect`: a full-bleed area's body is inset on the left/right/bottom
 * so its frame falls through to the HOST panel's edge zones -- but the area's
 * tab STRIP spans the area's full width, with the first/last tabs flush at the
 * left/right edges. So the strip band must use the FULL width: otherwise the
 * horizontal inset slices the leftmost/rightmost tabs' insert zones at the top
 * corners and they become undroppable (the drop falls through to the host).
 * The body keeps the inset. */
export const hitsTarget = (t: GroupTarget, x: number, y: number): boolean => {
  if (
    t.hitRect !== undefined &&
    t.ctx.kind === "area" &&
    t.stripRect !== null &&
    y >= t.stripRect.top &&
    y <= t.stripRect.bottom &&
    x >= t.rect.left &&
    x <= t.rect.right
  ) {
    return true;
  }
  return inside(t.hitRect ?? t.rect, x, y);
};

/** Resolve a tab insertion for a pointer over a strip. Uses the nearest tab
 * (2D), not just horizontal position, so it works when the tabs wrap onto
 * multiple rows. Returns the insert index plus the insertion line's geometry
 * (in client coords), anchored to the matched tab's own row. */
export const tabInsertion = (
  tabs: { rect: DOMRect }[],
  x: number,
  y: number,
): {
  index: number;
  lineLeft: number;
  lineTop: number;
  lineHeight: number;
} | null => {
  if (tabs.length === 0) return null;
  let best = 0;
  let bestKey = Infinity;
  let after = false;
  tabs.forEach((t, i) => {
    const r = t.rect;
    const dx = x - (r.left + r.width / 2);
    const dy = Math.abs(y - (r.top + r.height / 2));
    // Pick the ROW first (the row containing y, else the nearest row), THEN the
    // nearest tab within that row by horizontal position. A symmetric 2D
    // distance would let a far-right point in a short lower row snap to a tab in
    // the longer row above it (the wrapped-strip "can't hit the second row" bug).
    const inRow = y >= r.top && y <= r.bottom ? 0 : 1;
    const key = inRow * 1e9 + dy * 1e4 + Math.abs(dx);
    if (key < bestKey) {
      bestKey = key;
      best = i;
      after = dx > 0;
    }
  });
  const r = tabs[best].rect;
  const lineHeight = r.height * 0.55;
  // Inserting BEFORE a row's leftmost tab puts the line at the tab's left
  // edge -- which is the strip's (and panel's) flush left border, so the 2px
  // line would hang half off the panel. Nudge it inward so it stays visible.
  let lineLeft = after ? r.right : r.left;
  if (!after) {
    const sharesRow = (o: DOMRect) => o.top < r.bottom && o.bottom > r.top;
    const isRowLeftmost = !tabs.some(
      (t, i) => i !== best && sharesRow(t.rect) && t.rect.left < r.left,
    );
    if (isRowLeftmost) lineLeft = r.left + 3;
  }
  return {
    index: after ? best + 1 : best,
    lineLeft,
    lineTop: r.top + (r.height - lineHeight) / 2,
    lineHeight,
  };
};

/** Resolve the drop result + visual hint for a pointer position. Hints are
 * sized to the true post-drop geometry (respecting the min panel width) so they
 * preview the result without reflowing real panes. */
export function hitTest(
  layout: DockLayout,
  regionWidth: Record<DockEdge, number>,
  container: ContainerRect,
  targets: DropTargets,
  clientX: number,
  clientY: number,
  opts?: {
    /** True when the DRAGGED stack contains an unmergeable panel. Such a stack
     * can dock, split, and snap, but can never become tabs in another group --
     * so merge/insertTab results (and their hints) are suppressed here, where
     * all other drop policy lives, instead of being vetoed after the fact. */
    draggingUnmergeable?: boolean;
  },
): { result: DropResult; hint: DropHint } | null {
  const draggingUnmergeable = opts?.draggingUnmergeable === true;
  const crect = container;
  const cx = clientX - crect.left;
  const rel = (
    r: { left: number; top: number; width: number; height: number },
    variant: DropHint["variant"],
  ): DropHint => ({
    left: r.left - crect.left,
    top: r.top - crect.top,
    width: r.width,
    height: r.height,
    variant,
  });

  // 1. Screen edge zones, for an edge that READS as empty: either truly empty,
  // or holding only fully-minimized columns (those render as a compact overlay
  // rail floating over the canvas, so the screen edge still looks free --
  // dropping there docks a new outer column, just like docking next to
  // nothing). An edge with expanded content instead offers its region-edge
  // bands below, which dock a new outer column with grow-preserve.
  const edgeReadsEmpty = (edge: DockEdge): boolean =>
    layout.docked[edge] === null;
  const cy = clientY - crect.top;
  if (cx >= 0 && cx < EDGE_ZONE_PX && edgeReadsEmpty("left")) {
    return {
      result: { kind: "edge", edge: "left" },
      hint: {
        left: 0,
        top: 0,
        width: DEFAULT_REGION_PX,
        height: crect.height,
        variant: "fill",
      },
    };
  }
  if (crect.width - cx < EDGE_ZONE_PX && edgeReadsEmpty("right")) {
    return {
      result: { kind: "edge", edge: "right" },
      hint: {
        left: crect.width - DEFAULT_REGION_PX,
        top: 0,
        width: DEFAULT_REGION_PX,
        height: crect.height,
        variant: "fill",
      },
    };
  }

  // 2. Region edges -> dock a full-span band beside everything in the region.
  // Checked before per-panel zones so an outermost panel's edge means "span
  // all" rather than "split just this one"; an interior panel is past these
  // bands, so its own split wins. Each is suppressed when the edge is a single
  // full-span leaf (then it would be identical to the per-panel split).
  for (const edge of ["left", "right"] as DockEdge[]) {
    const tree = layout.docked[edge];
    if (tree === null) continue;
    const w = regionWidth[edge];
    const regionLeft = edge === "left" ? 0 : crect.width - w;
    const regionRight = regionLeft + w;
    if (cx < regionLeft || cx > regionRight) continue;
    // A region-edge span previews as a thin LINE along the edge it docks against,
    // spanning the whole region -- the same insertion-line affordance as a
    // per-panel split, just region-wide. (Previously a translucent half-region
    // "ghost" rectangle, which read inconsistently next to the per-panel lines.)
    const t = 3;

    // Top / bottom: full-width line above/below everything.
    if (cy < REGION_EDGE_PX && !edgeIsSingleLeaf(tree, "top")) {
      return {
        result: { kind: "regionEdge", edge, side: "top" },
        hint: { left: regionLeft, top: 0, width: w, height: t, variant: "line" },
      };
    }
    if (crect.height - cy < REGION_EDGE_PX && !edgeIsSingleLeaf(tree, "bottom")) {
      return {
        result: { kind: "regionEdge", edge, side: "bottom" },
        hint: {
          left: regionLeft,
          top: crect.height - t,
          width: w,
          height: t,
          variant: "line",
        },
      };
    }
    // Left / right (inner *and* outer): full-height line beside all rows.
    if (cx - regionLeft < REGION_SIDE_PX && !edgeIsSingleLeaf(tree, "left")) {
      return {
        result: { kind: "regionEdge", edge, side: "left" },
        hint: { left: regionLeft, top: 0, width: t, height: crect.height, variant: "line" },
      };
    }
    if (regionRight - cx < REGION_SIDE_PX && !edgeIsSingleLeaf(tree, "right")) {
      return {
        result: { kind: "regionEdge", edge, side: "right" },
        hint: {
          left: regionRight - t,
          top: 0,
          width: t,
          height: crect.height,
          variant: "line",
        },
      };
    }
  }

  // 3. The group frame the pointer is over. targets.groups is ordered
  // back-to-front (docked behind, then floating ascending z), so we take the
  // LAST match -- the topmost target -- rather than the first (which would be
  // the one painted underneath).
  let g: GroupTarget | undefined;
  for (const t of targets.groups) {
    if (hitsTarget(t, clientX, clientY)) g = t;
  }
  if (g === undefined) return null;
  const r = g.rect;
  const strip = g.stripRect;

  // A per-panel split previews as a thin insertion LINE at the boundary where
  // the new panel will go -- so "right of A" and "left of B" draw the same line
  // on the A|B seam (one coherent "insert a column here"), and per-panel splits
  // read differently from the region-edge "span all" ghosts.
  const splitLine = (region: "top" | "bottom" | "left" | "right"): DropHint => {
    const t = 3;
    // Center the line on the seam, then clamp it fully inside the container so it
    // stays visible. A panel docked at the region's outer edge sits flush with the
    // screen edge, so a seam-centered line there would otherwise be half-clipped;
    // a seam between two stacked/side-by-side panes is mid-region, so no clamp
    // applies and "right of A" / "left of B" still draw the same line.
    if (region === "top" || region === "bottom") {
      const raw = (region === "top" ? r.top : r.bottom) - t / 2;
      const top = clamp(raw, crect.top, crect.top + crect.height - t);
      return rel({ left: r.left, top, width: r.width, height: t }, "line");
    }
    const raw = (region === "left" ? r.left : r.right) - t / 2;
    const left = clamp(raw, crect.left, crect.left + crect.width - t);
    return rel({ left, top: r.top, width: t, height: r.height }, "line");
  };

  // An unmergeable group never participates in a merge, from EITHER side: a
  // drop over an unmergeable target's center is a no-op (return null) rather
  // than appending a tab, and a dragged stack holding an unmergeable panel
  // can't become tabs anywhere. Edge splits and floating snaps still apply.
  const mergeResult = (): { result: DropResult; hint: DropHint } | null =>
    g!.unmergeable || draggingUnmergeable
      ? null
      : { result: { kind: "merge", targetGroupId: g!.groupId }, hint: rel(r, "merge") };

  // 3-area. A nested dockable area is a FLAT tab group -- the only drops are
  // insert-at-a-tab-position (over its strip) or merge/append (anywhere else,
  // including an empty area, which has no strip). No split bands, no snap, no
  // above-strip split; dropping a multi-group stack flattens into tabs via the
  // same merge op. Always returns, so `g.ctx` narrows to docked|floating below.
  if (g.ctx.kind === "area") {
    if (draggingUnmergeable) return null; // tabs-only target; nothing to offer.
    if (strip !== null && clientY >= strip.top && clientY <= strip.bottom) {
      const ins = tabInsertion(g.tabs, clientX, clientY);
      if (ins !== null) {
        return {
          result: { kind: "insertTab", targetGroupId: g.groupId, index: ins.index },
          hint: rel(
            { left: ins.lineLeft - 1, top: ins.lineTop, width: 2, height: ins.lineHeight },
            "line",
          ),
        };
      }
    }
    return { result: { kind: "merge", targetGroupId: g.groupId }, hint: rel(r, "merge") };
  }

  // 3z. A minimized target has no content area, so its whole bar is a 5-way
  // drop zone: edges split (docked) / snap (floating), center merges.
  if (g.collapsed) {
    const rx = (clientX - r.left) / r.width;
    const ry = (clientY - r.top) / r.height;
    // Pixel-cap the vertical zones: a minimized VERTICAL strip is narrow but
    // region-tall, and 30% of that height would be a huge "split above/below"
    // band. (A no-op for the short horizontal handle bars, where the cap
    // exceeds 30%.)
    const V = Math.min(0.3, SPLIT_BAND_V_MAX_PX / Math.max(r.height, 1));
    const H = 0.3;
    if (g.ctx.kind === "docked") {
      const e = g.ctx.edge;
      const n = g.ctx.nodeId;
      if (ry < V) return { result: { kind: "split", edge: e, nodeId: n, region: "top" }, hint: splitLine("top") };
      if (ry > 1 - V) return { result: { kind: "split", edge: e, nodeId: n, region: "bottom" }, hint: splitLine("bottom") };
      if (rx < H) return { result: { kind: "split", edge: e, nodeId: n, region: "left" }, hint: splitLine("left") };
      if (rx > 1 - H) return { result: { kind: "split", edge: e, nodeId: n, region: "right" }, hint: splitLine("right") };
      return mergeResult();
    }
    // Floating minimized: snap above/below; left/right & center merge.
    if (ry < V)
      return {
        result: { kind: "snap", windowId: g.ctx.windowId, index: g.ctx.index },
        hint: rel({ left: r.left, top: r.top - 2, width: r.width, height: 4 }, "line"),
      };
    if (ry > 1 - V)
      return {
        result: { kind: "snap", windowId: g.ctx.windowId, index: g.ctx.index + 1 },
        hint: rel({ left: r.left, top: r.bottom - 2, width: r.width, height: 4 }, "line"),
      };
    return mergeResult();
  }

  // 3a. Above the tab strip -> dock above (docked) / snap above (floating).
  // For docked panes this is "span all above" territory at the very top (the
  // region-edge zone, checked earlier, usually wins for a multi-column row);
  // per-panel "above THIS one" lives in the content top band (3c).
  //
  // An UNMERGEABLE group has no grip bar; its full-width header sits flush at
  // the panel top, so there is nothing "above the strip" -- the header itself
  // plays the grip bar's role and IS the above/snap-above zone. (It can't be a
  // tab-insert target anyway, and without this a lone unmergeable docked panel
  // offers no way to dock above at all: the region's top band is suppressed as
  // redundant for single-leaf regions.)
  if (
    strip !== null &&
    (clientY < strip.top || (g.unmergeable === true && clientY <= strip.bottom))
  ) {
    if (g.ctx.kind === "docked") {
      return {
        result: { kind: "split", edge: g.ctx.edge, nodeId: g.ctx.nodeId, region: "top" },
        hint: splitLine("top"),
      };
    }
    return {
      result: { kind: "snap", windowId: g.ctx.windowId, index: g.ctx.index },
      hint: rel({ left: r.left, top: r.top - 2, width: r.width, height: 4 }, "line"),
    };
  }

  // 3b. Over the tab strip -> insert at a specific tab position. An unmergeable
  // group has no tab strip (its label is a full-width header), so skip this --
  // a drop over its header falls through to the content split/merge logic.
  // Likewise skipped when the DRAGGED stack is unmergeable (it can't be tabs).
  if (
    strip !== null &&
    clientY <= strip.bottom &&
    !g.unmergeable &&
    !draggingUnmergeable
  ) {
    const ins = tabInsertion(g.tabs, clientX, clientY);
    if (ins !== null) {
      return {
        result: { kind: "insertTab", targetGroupId: g.groupId, index: ins.index },
        hint: rel(
          {
            left: ins.lineLeft - 1,
            top: ins.lineTop,
            width: 2,
            height: ins.lineHeight,
          },
          "line",
        ),
      };
    }
  }

  // 3c. Content area: split bands (docked) / snap-below band (floating);
  // otherwise merge (append a tab).
  const contentTop = strip !== null ? strip.bottom : r.top;
  const ch = r.bottom - contentTop;
  const rx = (clientX - r.left) / r.width;
  const ry = ch > 0 ? (clientY - contentTop) / ch : 0;

  // Above/below get a narrower band (smaller fraction, pixel-capped) so the
  // merge zone dominates the content area; left/right use the wider fraction,
  // also pixel-capped so the band doesn't balloon on a wide panel (a docked
  // control panel can be 320-384px wide -- 22% of that reads as "most of the
  // way in" rather than "near the edge").
  const vBand = ch > 0 ? Math.min(SPLIT_BAND_V, SPLIT_BAND_V_MAX_PX / ch) : SPLIT_BAND_V;
  const hBand =
    r.width > 0 ? Math.min(SPLIT_BAND, SPLIT_BAND_H_MAX_PX / r.width) : SPLIT_BAND;
  if (g.ctx.kind === "docked") {
    // Content area splits THIS panel: left/right/below; center merges. "Above
    // this panel" is NOT here -- it lives in the grip bar above the tabs (3a),
    // so "above" always reads as physically above the tabs, never below them.
    let region: "bottom" | "left" | "right" | null = null;
    if (ry > 1 - vBand) region = "bottom";
    else if (rx < hBand) region = "left";
    else if (rx > 1 - hBand) region = "right";
    if (region !== null) {
      return {
        result: { kind: "split", edge: g.ctx.edge, nodeId: g.ctx.nodeId, region },
        hint: splitLine(region),
      };
    }
  } else if (ry > 1 - vBand) {
    return {
      result: { kind: "snap", windowId: g.ctx.windowId, index: g.ctx.index + 1 },
      hint: rel({ left: r.left, top: r.bottom - 2, width: r.width, height: 4 }, "line"),
    };
  }

  return mergeResult();
}
