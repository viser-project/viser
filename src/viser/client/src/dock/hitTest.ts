// D#/P#/section citations refer to ./dock-ux-spec.md (the normative spec,
// in this directory).
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
  SPLIT_DIVIDER_PX,
  WindowId,
} from "./types";

import { DEFAULT_REGION_PX } from "./types";
// Screen-edge zone width (only active on an empty edge).
const EDGE_ZONE_PX = 48;
// Wider band at a region's left/right edges -> full-height column beside all.
const REGION_SIDE_PX = 40;
// Thin left/right side band (pixels) on a minimized vertical strip: small so the
// two edges don't swallow a ~36px strip's whole width, leaving the middle free
// for its tab-insert / merge zones while the true edges still dock a column.
const MINIMIZED_SIDE_BAND_PX = 8;
// Horizontal inset for a minimized strip's tab-insertion line, so it reads as a
// marker between rows rather than a full-width rule against the strip's borders.
const INSERT_LINE_INSET_PX = 4;
// Thin top/bottom edge band (px) on a content-sized minimized strip: a drop in
// this band stacks a new cell above/below, while the + cap just inside the top
// edge stays a merge target (capped to a third of the cell so a short strip
// keeps a merge zone). P11 floor: no zone under 8px.
const MINIMIZED_EDGE_BAND_PX = 8;
// A floating bar's snap band (spec 5.4): capped at a third of the bar height
// so all three zones stay >= the 8px P11 floor (a flat 10px would leave a
// sub-8px middle on a 26px bar). Bars are floating-only (D32/D38: docked
// collapse renders as the rail), so there is no docked-bar variant.
const BAR_SNAP_BAND_PX = 10;
// Rendered thickness (px) of an insertion-line hint -- the thin bar drawn for
// every "insert here" drop (per-panel split, region-edge column insert).
const LINE_PX = 3;
// Band fraction (of the content area) for a per-panel left/right split, capped
// in pixels so it doesn't balloon on a wide panel. Sized so center-merge is
// roughly the middle third (spec D1): splits are the casual-drop default,
// merging requires clearer aim.
const SPLIT_BAND = 0.3;
const SPLIT_BAND_H_MAX_PX = 120;
// Above/below splits: same D1 rebalance, slightly narrower than the sides.
const SPLIT_BAND_V = 0.25;
const SPLIT_BAND_V_MAX_PX = 100;
// Max vertical gap between two stacked docked panels still treated as one seam
// (the divider). Slightly above SPLIT_DIVIDER_PX for sub-px layout slack; small
// enough that two genuinely separated panels aren't fused.
const SEAM_GAP_MAX_PX = SPLIT_DIVIDER_PX + 3;

/** Where a drop will land, resolved from the pointer during a drag.
 * - edge: dock as a new outer column on an empty screen edge.
 * - regionEdge: dock a full-height column at a region's outer/inner side
 *   (D46: columns are the only horizontal partition; top/bottom full-width
 *   band drops are unrepresentable and their zones are gone).
 * - split: split a docked leaf's cell along one side.
 * - merge: append into an existing group's tab strip.
 * - insertTab: insert into an existing group's tabs at a specific index.
 * - snap: insert into a floating window's vertical stack at a specific index. */
export type DropResult =
  | { kind: "edge"; edge: DockEdge }
  | {
      kind: "regionEdge";
      edge: DockEdge;
      side: "left" | "right";
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
  /** Optional smaller rect used for hit detection only (which target the pointer
   * is over), while `rect` still drives the visual hint. Lets a full-bleed area
   * keep a full-width merge highlight while leaving an inset frame around it that
   * falls through to the host panel's edge zones. Defaults to `rect`. */
  hitRect?: DOMRect;
  /** Hosting floating window id (floating cells and window-hosted areas);
   * undefined for docked targets and docked-hosted areas. Pairs with
   * DropTargets.windows for the owning-window mask. */
  winId?: string;
  stripRect: DOMRect | null;
  tabs: { paneId: PaneId; rect: DOMRect }[];
  ctx: GroupContext;
  /** True when the group is minimized (only its handle shows). Such a target
   * has no content area, so its whole bar is treated as a 5-way drop zone.
   * Optional so existing target literals (e.g. in tests) stay valid. */
  collapsed?: boolean;
  /** True when a collapsed group renders as a horizontal bar -- a collapsed
   * floating window's cell (D38) -- rather than a vertical rail cell (the
   * only docked collapsed form, D32). Bars lay their tab labels out
   * horizontally, so the collapsed branch uses X-based label insertion and
   * the floating snap bands instead of the rail's Y-based rows. */
  bar?: boolean;
  /** True when the group holds an unmergeable panel: nothing may be merged or
   * inserted into it, so its content area is merge-suppressed (drops there fall
   * back to a split / no-op) and its label is a header rather than a tab. */
  unmergeable?: boolean;
}

export interface DropTargets {
  groups: GroupTarget[];
  /** Floating windows' full paper rects, back-to-front (same z order as the
   * floating group targets). A window's chrome (header, stack dividers,
   * paddings) has no group rect, and those slivers must not let the pointer
   * fall through to whatever is painted underneath the window (3.5): the
   * frontmost window containing the pointer owns it. Optional: without it
   * (unit-test fixtures), resolution falls back to cell rects only. */
  windows?: { windowId: string; rect: DOMRect }[];
}

/** Visual hint, in container-relative px.
 * - line: a thin insertion bar marking a boundary -- used for all "insert here"
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
 * so its frame falls through to the host panel's edge zones -- but the area's
 * tab strip spans the area's full width, with the first/last tabs flush at the
 * left/right edges. So the strip band must use the full width: otherwise the
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
    // Pick the row first (the row containing y, else the nearest row), then the
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
  // Inserting before a row's leftmost tab puts the line at the tab's left
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

/** Vertical analog of tabInsertion for a minimized strip's stacked spine-label
 * rows: pick the nearest row by Y and return the insert index plus a horizontal
 * insertion line (between rows / above the first / below the last). Lets a drop
 * land at a specific position in a minimized tab set, mirroring how dropping
 * between expanded horizontal tabs works. */
export const verticalTabInsertion = (
  tabs: { rect: DOMRect }[],
  y: number,
): {
  index: number;
  lineLeft: number;
  lineTop: number;
  lineWidth: number;
} | null => {
  if (tabs.length === 0) return null;
  let best = 0;
  let bestDy = Infinity;
  let after = false;
  tabs.forEach((t, i) => {
    const r = t.rect;
    const dy = y - (r.top + r.height / 2);
    if (Math.abs(dy) < bestDy) {
      bestDy = Math.abs(dy);
      best = i;
      after = dy > 0;
    }
  });
  const r = tabs[best].rect;
  // Inset the horizontal line from both strip edges so it reads as an insertion
  // marker, not a full-width rule hugging the ~36px strip's borders (mirrors the
  // horizontal path, which nudges its line in from the leftmost tab edge).
  return {
    index: after ? best + 1 : best,
    lineLeft: r.left + INSERT_LINE_INSET_PX,
    lineTop: after ? r.bottom : r.top,
    lineWidth: Math.max(2, r.width - 2 * INSERT_LINE_INSET_PX),
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
    /** True when the dragged stack contains an unmergeable panel. Such a stack
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

  // 1. Screen edge zones, for a truly empty edge (docked[edge] === null). A
  // minimized region does not read as empty here: its rail/strips reserve real
  // width, and their cells carry their own drop zones -- the region-edge bands
  // below (kept full-height for a minimized region) handle "dock beside".
  const edgeReadsEmpty = (edge: DockEdge): boolean =>
    layout.docked[edge] === null;
  // No inner-side bound on either check: during a captured drag the pointer
  // can leave the container, and slamming past either screen edge should still
  // dock there (the right check has always accepted cx > width; keep the left
  // symmetric by accepting cx < 0).
  if (cx < EDGE_ZONE_PX && edgeReadsEmpty("left")) {
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

  // A region-edge side band spans the whole region height, including the strip
  // of a panel that sits flush at the region's left/right. But a drop directly
  // over a panel's tab strip is a more specific intent -- "insert at this tab
  // position" -- than the region-wide "dock a column beside everything".
  // Without this, the leftmost tab of a docked panel always sits inside the
  // 40px left region-side band, so dropping there docks a new column (or wrong
  // index) instead of inserting at index 0. So: if the pointer is over a tab strip
  // where a tab-insert would actually resolve (a mergeable docked/floating
  // group, the drag itself is mergeable, and the pointer maps to a tab), let
  // section 3 handle it and skip the region-edge bands. Outermost region-edge
  // docking is unaffected: the content area, grip bar, and screen edges are
  // not strips, so they still hit the region bands.
  const overInsertableStrip = (): boolean => {
    if (draggingUnmergeable) return false;
    for (const t of targets.groups) {
      if (
        t.stripRect === null ||
        t.unmergeable === true ||
        t.collapsed === true ||
        t.ctx.kind === "area"
      )
        continue;
      if (
        inside(t.stripRect, clientX, clientY) &&
        tabInsertion(t.tabs, clientX, clientY) !== null
      )
        return true;
    }
    return false;
  };
  // A floating window visually covering a region-edge band spot claims the
  // pointer first (3.5 back-to-front): a drop there should target the float,
  // not dock a column through it into the region underneath. Window paper
  // rects cover the whole window incl. chrome (header, dividers) -- cell
  // rects alone left slivers where the suppression blinked off mid-drag.
  const owningWindow = (() => {
    let win: { windowId: string; rect: DOMRect } | null = null;
    for (const w of targets.windows ?? []) {
      if (inside(w.rect, clientX, clientY)) win = w; // last match = topmost
    }
    return win;
  })();
  const overFloatingTarget = (): boolean => {
    if (owningWindow !== null) return true;
    for (const t of targets.groups) {
      if (t.ctx.kind !== "floating") continue;
      if (hitsTarget(t, clientX, clientY)) return true;
    }
    return false;
  };
  const skipRegionEdges = overInsertableStrip() || overFloatingTarget();

  // Is the pointer over a collapsed strip cell of the given docked edge? Such a
  // cell owns its own (short, content-tall) drop zones -- tab-insert / merge /
  // stack -- so the region-wide "dock beside" band must yield to it there. Used
  // to let a sole minimized strip's empty region area below/around it still dock
  // a full-height sibling column without the band eating the strip's own zones.
  const overCollapsedCell = (edge: DockEdge): boolean => {
    for (const t of targets.groups) {
      if (
        t.collapsed === true &&
        t.ctx.kind === "docked" &&
        t.ctx.edge === edge &&
        inside(t.rect, clientX, clientY)
      )
        return true;
    }
    return false;
  };

  // A vertical insertion line for a docked left/right split: centered on
  // `lineX` (the landing seam, client coords), clamped on-screen. A side
  // drop inserts a full-height column (D46), so the line is region-tall --
  // a cell-tall line would promise a narrower landing than the drop
  // delivers (P1).
  const dockedSideSplitHint = (lineX: number): DropHint => {
    const t = LINE_PX;
    const left = clamp(lineX - t / 2, crect.left, crect.left + crect.width - t);
    return rel(
      { left, top: crect.top, width: t, height: crect.height },
      "line",
    );
  };

  // 2. Region edges -> dock a full-height column beside everything in the
  // region. Checked before per-panel zones so an outermost panel's edge means
  // "beside everything" rather than "split just this one"; an interior panel is
  // past these bands, so its own split wins. Each is suppressed when the edge
  // is a single leaf (then it would be identical to the per-panel split).
  for (const edge of skipRegionEdges ? [] : (["left", "right"] as DockEdge[])) {
    const tree = layout.docked[edge];
    if (tree === null) continue;
    const w = regionWidth[edge];
    const regionLeft = edge === "left" ? 0 : crect.width - w;
    const regionRight = regionLeft + w;
    if (cx < regionLeft || cx > regionRight) continue;
    // Insertion-line hint thickness for the side-band hints.
    const t = LINE_PX;
    // Cap each left/right side band at a third of the region width so the two
    // bands leave the middle third for the per-panel zones underneath. A
    // fully-minimized region renders as a ~36px strip -- narrower than
    // REGION_SIDE_PX (40) -- and an uncapped (or half-width) band would cover the
    // whole strip, so a drop always resolved to "dock a new column beside" and
    // never reached the strip cell's own tab/stack zones (merge + above/below).
    // With the third-cap the strip's middle falls through to those cell zones
    // while its outer/inner thirds still dock a sibling column.
    const sideBand = Math.min(REGION_SIDE_PX, w / 3);

    // Side bands only (D46): columns are the region's sole horizontal
    // partition, so there are no cross-band seams and no top/bottom
    // full-width band drops -- vertical intent is the cells' own
    // above/below zones. The bands yield to any collapsed docked cell
    // under the pointer: a 40px side band would fully shadow a 36px rail
    // (its side slivers, tab rows and merge cap), and the rail's outer
    // sliver already docks a column beside it (sweep invariant: every
    // target reachable). This yield also covers packed regions whole --
    // their strips tile the full region, so dock-beside there is entirely
    // the rails' own slivers (edge case 13).
    if (overCollapsedCell(edge)) continue;
    // Hints are a line spanning the whole region: a new column lands
    // beside everything, full height (P1).
    if (cx - regionLeft < sideBand && !edgeIsSingleLeaf(tree)) {
      return {
        result: { kind: "regionEdge", edge, side: "left" },
        hint: {
          left: regionLeft,
          width: t,
          top: 0,
          height: crect.height,
          variant: "line",
        },
      };
    }
    if (regionRight - cx < sideBand && !edgeIsSingleLeaf(tree)) {
      return {
        result: { kind: "regionEdge", edge, side: "right" },
        hint: {
          left: regionRight - t,
          width: t,
          top: 0,
          height: crect.height,
          variant: "line",
        },
      };
    }
  }

  // 3. The group frame the pointer is over. targets.groups is ordered
  // back-to-front (docked behind, then floating ascending z), so we take the
  // last match -- the topmost target -- rather than the first (which would be
  // the one painted underneath). When a floating window's paper contains the
  // pointer, only that window's targets (cells + its hosted areas) are
  // eligible: a pointer on its header or divider gap must not resolve to an
  // occluded docked panel or a lower window's cell (3.5).
  const eligible = (t: GroupTarget): boolean =>
    owningWindow === null || t.winId === owningWindow.windowId;
  let g: GroupTarget | undefined;
  for (const t of targets.groups) {
    if (eligible(t) && hitsTarget(t, clientX, clientY)) g = t;
  }

  // The visual seam between two vertically stacked docked panels [A above B] is
  // split across three slivers that all mean the same thing -- "insert a leaf
  // between A and B": A's content bottom band (3c, region "bottom"), the
  // ~SPLIT_DIVIDER_PX divider gap (a target-less strip), and B's grip bar (3a,
  // region "top"). To make the hint feel like one stable target we (1) snap the
  // line for both bands to the gap center so it doesn't jump A.bottom<->B.top,
  // and (2) treat the divider gap itself as part of the seam so there is no
  // dead null frame as the pointer crosses it.
  //
  // dockedSeamSibling: given a docked group `g` and which side ("top"/"bottom")
  // a split would land on, find the immediately adjacent docked sibling across
  // a small vertical gap (same edge, horizontally overlapping). Returns the
  // sibling and the gap-center y, or null when `g` is at the region's outer edge
  // (single panel / region boundary), where the existing r.top/r.bottom +
  // on-screen clamp behavior must be preserved.
  const dockedSeamSibling = (
    self: GroupTarget,
    side: "top" | "bottom",
  ): { gapCenter: number } | null => {
    if (self.ctx.kind !== "docked") return null;
    const edge = self.ctx.edge;
    const sr = self.rect;
    const selfBoundary = side === "top" ? sr.top : sr.bottom;
    let best: { gapCenter: number; gap: number } | null = null;
    for (const t of targets.groups) {
      if (t === self || t.ctx.kind !== "docked" || t.ctx.edge !== edge)
        continue;
      const tr = t.rect;
      // Must horizontally overlap (same column) to be a vertical neighbor.
      if (tr.right <= sr.left || tr.left >= sr.right) continue;
      // The neighbor sits on the relevant side, just across the divider gap.
      const otherBoundary = side === "top" ? tr.bottom : tr.top;
      const gap = side === "top" ? sr.top - tr.bottom : tr.top - sr.bottom;
      // Only an immediately-adjacent panel across a small gap counts (skip far
      // panels / overlaps). The divider is SPLIT_DIVIDER_PX; allow a little slack.
      if (gap < -1 || gap > SEAM_GAP_MAX_PX) continue;
      if (best === null || gap < best.gap)
        best = { gapCenter: (selfBoundary + otherBoundary) / 2, gap };
    }
    return best;
  };

  if (g === undefined) {
    // Divider dead-spot recovery: the pointer is over the ~SPLIT_DIVIDER_PX gap
    // between two stacked docked panels (the divider has no group target). Map
    // it to the seam split it sits in the middle of, so the hint stays stable
    // and gap-free instead of blinking to null. Skipped when a floating
    // window owns the pointer (its own seam recovery below handles gaps).
    let seam: { lower: GroupTarget; gapCenter: number } | null = null;
    if (owningWindow === null) {
      for (const t of targets.groups) {
        if (t.ctx.kind !== "docked") continue;
        const sib = dockedSeamSibling(t, "top");
        if (sib === null) continue;
        const tr = t.rect;
        // `t` is the lower panel of the pair; the gap is just above it. Confirm
        // the pointer is in that gap (and horizontally within the column).
        if (
          clientX >= tr.left &&
          clientX <= tr.right &&
          clientY < tr.top &&
          clientY >= sib.gapCenter - SEAM_GAP_MAX_PX
        ) {
          if (seam === null || sib.gapCenter > seam.gapCenter)
            seam = { lower: t, gapCenter: sib.gapCenter };
        }
      }
    }
    if (seam !== null && seam.lower.ctx.kind === "docked") {
      const t = LINE_PX;
      return {
        result: {
          kind: "split",
          edge: seam.lower.ctx.edge,
          nodeId: seam.lower.ctx.nodeId,
          region: "top",
        },
        hint: rel(
          {
            left: seam.lower.rect.left,
            top: seam.gapCenter - t / 2,
            width: seam.lower.rect.width,
            height: t,
          },
          "line",
        ),
      };
    }
    // Vertical divider dead spot -- the left/right analog of the seam above
    // (spec 5.5: divider gaps are never dead): the pointer sits in the
    // ~SPLIT_DIVIDER_PX gap between two side-by-side docked columns (the
    // divider has no target; between two railed columns the gap is a full
    // dead stripe without this). Map it to the column insert at that seam:
    // the gap's left half splits right of the left cell, the right half
    // splits left of the right cell -- the same landing either way, and
    // left/right mirror-symmetric.
    if (owningWindow === null) {
      // Per side, prefer a cell containing clientY; when none does (the
      // pointer sits at a T-junction -- the column gap crossing one side's
      // horizontal cell seam), fall back to that side's nearest cell by
      // y-distance, bounded by the seam gap (spec 5.5: divider gaps are
      // never dead in either axis; without the fallback the ~7x7px pocket
      // where the two gaps cross resolved to null).
      let leftT: GroupTarget | null = null;
      let leftKey: [number, number] = [Infinity, -Infinity];
      let rightT: GroupTarget | null = null;
      let rightKey: [number, number] = [Infinity, Infinity];
      for (const t of targets.groups) {
        if (t.ctx.kind !== "docked") continue;
        const tr = t.rect;
        const yDist =
          clientY < tr.top
            ? tr.top - clientY
            : clientY > tr.bottom
              ? clientY - tr.bottom
              : 0;
        if (yDist > SEAM_GAP_MAX_PX) continue;
        if (
          tr.right <= clientX &&
          (yDist < leftKey[0] ||
            (yDist === leftKey[0] && tr.right > leftKey[1]))
        ) {
          leftT = t;
          leftKey = [yDist, tr.right];
        }
        if (
          tr.left >= clientX &&
          (yDist < rightKey[0] ||
            (yDist === rightKey[0] && tr.left < rightKey[1]))
        ) {
          rightT = t;
          rightKey = [yDist, tr.left];
        }
      }
      if (
        leftT !== null &&
        rightT !== null &&
        leftT.ctx.kind === "docked" &&
        rightT.ctx.kind === "docked" &&
        leftT.ctx.edge === rightT.ctx.edge
      ) {
        const gap = rightT.rect.left - leftT.rect.right;
        if (gap >= -1 && gap <= SEAM_GAP_MAX_PX) {
          const gapCenter = (leftT.rect.right + rightT.rect.left) / 2;
          const [tgt, region] =
            clientX <= gapCenter
              ? ([leftT, "right"] as const)
              : ([rightT, "left"] as const);
          if (tgt.ctx.kind === "docked") {
            return {
              result: {
                kind: "split",
                edge: tgt.ctx.edge,
                nodeId: tgt.ctx.nodeId,
                region,
              },
              hint: dockedSideSplitHint(gapCenter),
            };
          }
        }
      }
    }
    // Floating-stack divider dead spot: the pointer sits on the divider gap
    // between two stacked cells of a floating window. Same recovery as the
    // docked seam above -- map it to the snap at that index instead of
    // blinking to null (a release there would float a new window at the
    // pointer). Targets are back-to-front, so the last match is topmost.
    let fseam: {
      windowId: string;
      index: number;
      left: number;
      width: number;
      gapCenter: number;
    } | null = null;
    // Stack cells by (window, index): the only cell that can share a seam
    // with a given lower cell is its model-adjacent upper neighbor (index-1
    // in the same window), so one lookup replaces a pairwise scan.
    const cellAbove = new Map<string, GroupTarget>();
    for (const t of targets.groups) {
      if (t.ctx.kind === "floating")
        cellAbove.set(`${t.ctx.windowId}:${t.ctx.index}`, t);
    }
    for (const lower of targets.groups) {
      if (lower.ctx.kind !== "floating" || lower.ctx.index === 0) continue;
      // Scope to the owning window when known: a front window's header over
      // a back window's seam must not snap into the back window.
      if (owningWindow !== null && lower.ctx.windowId !== owningWindow.windowId)
        continue;
      const upper = cellAbove.get(
        `${lower.ctx.windowId}:${lower.ctx.index - 1}`,
      );
      if (upper === undefined) continue;
      const gap = lower.rect.top - upper.rect.bottom;
      if (gap < -1 || gap > SEAM_GAP_MAX_PX) continue;
      // Targets are back-to-front, so the last match (topmost) wins.
      if (
        clientX >= lower.rect.left &&
        clientX <= lower.rect.right &&
        clientY >= upper.rect.bottom &&
        clientY <= lower.rect.top
      ) {
        fseam = {
          windowId: lower.ctx.windowId,
          index: lower.ctx.index,
          left: lower.rect.left,
          width: lower.rect.width,
          gapCenter: (upper.rect.bottom + lower.rect.top) / 2,
        };
      }
    }
    if (fseam !== null) {
      return {
        result: { kind: "snap", windowId: fseam.windowId, index: fseam.index },
        hint: rel(
          {
            left: fseam.left,
            top: fseam.gapCenter - LINE_PX / 2,
            width: fseam.width,
            height: LINE_PX,
          },
          "line",
        ),
      };
    }
    return null;
  }
  // Capture the narrowed target as a const: `g` is a mutated `let`, so the
  // undefined-guard above doesn't narrow it inside the closures below -- the
  // old `g!` assertions there would have compiled (and crashed) if the guard
  // ever moved after them.
  const gt = g;
  const r = gt.rect;
  const strip = gt.stripRect;

  // A per-panel split previews as a thin insertion line at the boundary where
  // the new panel will go -- so "right of A" and "left of B" draw the same line
  // on the A|B seam (one coherent "insert a column here").
  const splitLine = (region: "top" | "bottom" | "left" | "right"): DropHint => {
    const t = LINE_PX;
    // Center the line on the seam, then clamp it fully inside the container so it
    // stays visible. A panel docked at the region's outer edge sits flush with the
    // screen edge, so a seam-centered line there would otherwise be half-clipped;
    // a seam between two stacked/side-by-side panes is mid-region, so no clamp
    // applies and "right of A" / "left of B" still draw the same line.
    if (region === "top" || region === "bottom") {
      // When this split lands on a seam shared with an adjacent stacked sibling
      // (a divider gap between two docked panels), draw the line at the gap
      // center so "below A" and "above B" coincide instead of jumping the
      // ~SPLIT_DIVIDER_PX divider width. With no sibling (region's outer edge),
      // fall back to the panel boundary + on-screen clamp.
      const seam =
        gt.ctx.kind === "docked" ? dockedSeamSibling(gt, region) : null;
      const edgeY = region === "top" ? r.top : r.bottom;
      const raw = (seam !== null ? seam.gapCenter : edgeY) - t / 2;
      const top = clamp(raw, crect.top, crect.top + crect.height - t);
      return rel({ left: r.left, top, width: r.width, height: t }, "line");
    }
    // Vertical extent = the drop's true extent: a docked side drop lands a
    // full-height column (D46), so the line is region-tall.
    const lineX = region === "left" ? r.left : r.right;
    if (gt.ctx.kind === "docked") {
      return dockedSideSplitHint(lineX);
    }
    const left = clamp(lineX - t / 2, crect.left, crect.left + crect.width - t);
    return rel({ left, top: r.top, width: t, height: r.height }, "line");
  };

  // An unmergeable group never participates in a merge, from either side: a
  // drop over an unmergeable target's center is a no-op (return null) rather
  // than appending a tab, and a dragged stack holding an unmergeable panel
  // can't become tabs anywhere. Edge splits and floating snaps still apply.
  const mergeResult = (): { result: DropResult; hint: DropHint } | null =>
    gt.unmergeable || draggingUnmergeable
      ? null
      : {
          result: { kind: "merge", targetGroupId: gt.groupId },
          hint: rel(r, "merge"),
        };

  // 3-area. A nested dockable area is a flat tab group -- the only drops are
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
          result: {
            kind: "insertTab",
            targetGroupId: g.groupId,
            index: ins.index,
          },
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
    return {
      result: { kind: "merge", targetGroupId: g.groupId },
      hint: rel(r, "merge"),
    };
  }

  // 3z. A minimized target renders as a narrow vertical strip (a + cap atop a
  // column of spine-label rows). It is a drop target the same way an expanded
  // panel is, just rotated 90 degrees:
  //   - thin outer/inner side bands  -> dock a new column beside it (docked) /
  //   - over a spine-label row       -> insert at that tab position (begin /
  //                                     between / end), like dropping between
  //                                     expanded horizontal tabs
  //   - thin top/bottom bands        -> stack a new cell above/below (docked) /
  //                                     snap above/below (floating)
  //   - anything else (the + cap)    -> merge (append a tab)
  if (g.collapsed) {
    const rx = (clientX - r.left) / r.width;
    // Thin pixel side bands so on a ~36px strip the two edges don't swallow the
    // whole width -- the middle stays free for the tab/split zones.
    const H = Math.min(0.3, MINIMIZED_SIDE_BAND_PX / Math.max(r.width, 1));
    // The content-sized cell reads top-to-bottom like a rotated expanded panel:
    //   - thin top/bottom edge bands   -> stack a new cell above/below (docked)
    //                                     / snap above/below (floating)
    //   - over a spine-label row       -> insert at that tab position
    //   - everything else (the + cap)  -> merge (append a tab)
    // The edge bands are thin pixel strips at the cell's very top/bottom, so the
    // + cap (just inside the top edge) stays a merge target rather than being
    // swallowed by an "above" zone. Insertion is suppressed for an unmergeable
    // drag (can't become tabs) or an unmergeable target.
    const canInsert =
      !draggingUnmergeable && !g.unmergeable && g.tabs.length > 0;
    // Top/bottom edge bands: rail cells keep thin 8px stack-above/below
    // zones; a floating bar (the only bar form, D32/D38) gets the wider
    // min(10px, height/3) snap band (spec 5.4).
    const edgeBand =
      g.bar === true
        ? Math.min(BAR_SNAP_BAND_PX, r.height / 3)
        : Math.min(MINIMIZED_EDGE_BAND_PX, r.height / 3);
    const inTopEdge = clientY < r.top + edgeBand;
    const inBottomEdge = clientY > r.bottom - edgeBand;
    // Tab insertion matches the segment's orientation: rail cells stack rows
    // vertically (Y-based, horizontal line); bars lay labels out
    // horizontally (2D nearest-tab, vertical line) -- spec D9.
    const insertResult = () => {
      if (!canInsert || inTopEdge || inBottomEdge) return null;
      if (g.bar === true) {
        // Spec 5.4 (D36): insertion aims at the bar's visible tab labels --
        // per-label rects via the same 2D nearest-tab as expanded strips --
        // and a drop right of the last label appends (merge). Without that
        // bound the whole bar width resolved to insert-around-the-nearest
        // label, making append unreachable.
        const last = g.tabs[g.tabs.length - 1];
        if (last !== undefined && clientX > last.rect.right + 8) return null;
        const ins = tabInsertion(g.tabs, clientX, clientY);
        return ins === null
          ? null
          : {
              result: {
                kind: "insertTab" as const,
                targetGroupId: g.groupId,
                index: ins.index,
              },
              hint: rel(
                {
                  left: ins.lineLeft - 1,
                  top: ins.lineTop,
                  width: 2,
                  height: ins.lineHeight,
                },
                "line" as const,
              ),
            };
      }
      const ins = verticalTabInsertion(g.tabs, clientY);
      return ins === null
        ? null
        : {
            result: {
              kind: "insertTab" as const,
              targetGroupId: g.groupId,
              index: ins.index,
            },
            hint: rel(
              {
                left: ins.lineLeft,
                top: ins.lineTop - 1,
                width: ins.lineWidth,
                height: 2,
              },
              "line" as const,
            ),
          };
    };
    if (g.ctx.kind === "docked") {
      const e = g.ctx.edge;
      const n = g.ctx.nodeId;
      if (rx < H)
        return {
          result: { kind: "split", edge: e, nodeId: n, region: "left" },
          hint: splitLine("left"),
        };
      if (rx > 1 - H)
        return {
          result: { kind: "split", edge: e, nodeId: n, region: "right" },
          hint: splitLine("right"),
        };
      if (inTopEdge)
        return {
          result: { kind: "split", edge: e, nodeId: n, region: "top" },
          hint: splitLine("top"),
        };
      // A rail's droppable rect can extend past its spine content: the
      // strip's empty tail below the rows belongs to the last cell (the
      // scanner sizes it to the rail root), and the only honest drop there
      // is "stack a new cell below this one". The hint sits at the
      // content's true bottom edge -- where the new cell actually lands --
      // not at the strip's far bottom.
      const lastTab = g.tabs[g.tabs.length - 1];
      const contentBottom =
        lastTab === undefined
          ? r.bottom
          : Math.min(r.bottom, lastTab.rect.bottom + MINIMIZED_EDGE_BAND_PX);
      if (inBottomEdge || clientY > contentBottom) {
        const hint =
          r.bottom - contentBottom > MINIMIZED_EDGE_BAND_PX
            ? rel(
                {
                  left: r.left,
                  top: contentBottom - LINE_PX / 2,
                  width: r.width,
                  height: LINE_PX,
                },
                "line",
              )
            : splitLine("bottom"); // content-tall cell: seam-aware line.
        return {
          result: { kind: "split", edge: e, nodeId: n, region: "bottom" },
          hint,
        };
      }
      return insertResult() ?? mergeResult();
    }
    // Floating minimized: thin edge bands snap a new cell above/below; rows
    // insert at a tab position; the rest merges (no docked region to split into).
    if (inTopEdge)
      return {
        result: { kind: "snap", windowId: g.ctx.windowId, index: g.ctx.index },
        hint: rel(
          { left: r.left, top: r.top - 2, width: r.width, height: 4 },
          "line",
        ),
      };
    if (inBottomEdge)
      return {
        result: {
          kind: "snap",
          windowId: g.ctx.windowId,
          index: g.ctx.index + 1,
        },
        hint: rel(
          { left: r.left, top: r.bottom - 2, width: r.width, height: 4 },
          "line",
        ),
      };
    return insertResult() ?? mergeResult();
  }

  // 3a. Above the tab strip -> split above this panel (docked) / snap above
  // (floating). D46: vertical intent is always per-cell (no region-wide
  // top band exists). This is the ONLY dock-above claim on a mergeable
  // cell (D48: the old content-top band is gone; the body below the strip
  // merges).
  //
  // An unmergeable group has no grip bar; its full-width header sits flush at
  // the panel top, so there is nothing "above the strip" -- the header itself
  // plays the grip bar's role and is the above/snap-above zone. (It can't be a
  // tab-insert target anyway, and without this a lone unmergeable docked panel
  // offers no way to dock above at all: vertical drops live only on the cell
  // itself -- there is no region-wide top band, D46.)
  if (
    strip !== null &&
    (clientY < strip.top || (g.unmergeable === true && clientY <= strip.bottom))
  ) {
    if (g.ctx.kind === "docked") {
      return {
        result: {
          kind: "split",
          edge: g.ctx.edge,
          nodeId: g.ctx.nodeId,
          region: "top",
        },
        hint: splitLine("top"),
      };
    }
    return {
      result: { kind: "snap", windowId: g.ctx.windowId, index: g.ctx.index },
      hint: rel(
        { left: r.left, top: r.top - 2, width: r.width, height: 4 },
        "line",
      ),
    };
  }

  // 3b. Over the tab strip -> insert at a specific tab position. An unmergeable
  // group has no tab strip (its label is a full-width header), so skip this --
  // a drop over its header falls through to the content split/merge logic.
  // Likewise skipped when the dragged stack is unmergeable (it can't be tabs).
  if (
    strip !== null &&
    clientY <= strip.bottom &&
    !g.unmergeable &&
    !draggingUnmergeable
  ) {
    const ins = tabInsertion(g.tabs, clientX, clientY);
    if (ins !== null) {
      return {
        result: {
          kind: "insertTab",
          targetGroupId: g.groupId,
          index: ins.index,
        },
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
  const vBand =
    ch > 0 ? Math.min(SPLIT_BAND_V, SPLIT_BAND_V_MAX_PX / ch) : SPLIT_BAND_V;
  const hBand =
    r.width > 0
      ? Math.min(SPLIT_BAND, SPLIT_BAND_H_MAX_PX / r.width)
      : SPLIT_BAND;
  if (g.ctx.kind === "docked") {
    // Content area: bottom/left/right split this panel; everything else
    // merges. There is deliberately NO content-top band for mergeable
    // pairs (D48): dock-above belongs to the grip bar alone. The old top
    // band re-claimed "above" just below the tab strip, making the strip
    // an island inside above-intent -- and the above-split's shrink
    // preview displaced the strip while the user aimed at it.
    // Overshooting the strip now lands in merge (same outcome family as
    // the strip's own insert), so the aim is forgiving in the direction
    // people actually miss.
    //
    // MERGE-SUPPRESSED pairs (unmergeable target, or the dragged stack
    // holds an unmergeable panel) keep the pre-D48 top band: their merge
    // is null, so "overshoot lands in merge" cannot hold -- the zone
    // would be a no-drop hole (P5) -- and no strip island exists on
    // these paths (the strip insert is suppressed too, so there is
    // nothing below the grip bar to aim at).
    const mergeSuppressed = gt.unmergeable || draggingUnmergeable;
    let region: "top" | "bottom" | "left" | "right" | null = null;
    if (mergeSuppressed && ry < vBand) region = "top";
    else if (ry > 1 - vBand) region = "bottom";
    else if (rx < hBand) region = "left";
    else if (rx > 1 - hBand) region = "right";
    if (region !== null) {
      return {
        result: {
          kind: "split",
          edge: g.ctx.edge,
          nodeId: g.ctx.nodeId,
          region,
        },
        hint: splitLine(region),
      };
    }
  } else if (ry > 1 - vBand) {
    return {
      result: {
        kind: "snap",
        windowId: g.ctx.windowId,
        index: g.ctx.index + 1,
      },
      hint: rel(
        { left: r.left, top: r.bottom - 2, width: r.width, height: 4 },
        "line",
      ),
    };
  }

  return mergeResult();
}
