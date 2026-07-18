// The content-height detent ("magnet"), shared by the floating window's
// height grips and BOTH height dividers (floating stack, docked column
// stack) -- see spec section 6 and D56. HEIGHT only by adjudication: width
// dividers have no semantic width target (panel width is a reading
// preference, not a "natural" size), and a detent without meaning is just
// stickiness.
//
// snapToDetent and flankDetentDeltas are pure math (unit-pinned in
// detent.test.ts); the DOM measurement helper and the divider rule's cue
// style live beside them so every consumer computes "natural content
// height" -- and draws the snap signifier -- with the same formula.

import type { CSSProperties } from "react";

/** Snap `value` onto the nearest detent within `bandPx` of it.
 *
 * Returns the snapped value plus whether a detent was hit -- the `snapped`
 * flag drives the visual cue (grip highlight / divider rule tint). Out of
 * band, `value` passes through unchanged. When two detents are both in band
 * the NEAREST wins; on an exact tie the earlier-listed detent wins. The band
 * check is inclusive (distance == bandPx snaps), matching the window grip's
 * original `<=` magnet. */
export function snapToDetent(
  value: number,
  detents: readonly number[],
  bandPx: number,
): { value: number; snapped: boolean } {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const d of detents) {
    const dist = Math.abs(value - d);
    if (dist <= bandPx && dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best === null
    ? { value, snapped: false }
    : { value: best, snapped: true };
}

/** The cursor DELTAS at which a height divider's flanking cells land exactly
 * at their natural content heights, in the divider's normalized drag scale.
 *
 * Both height dividers feed cascadeResize sizes renormalized over the
 * container box height (divider chrome included), so a rendered-px content
 * target converts by `scale` (container / rendered total) before
 * differencing against the flank's normalized start size (`n0Above` /
 * `n0Below`); snapping the DELTA then lands the flank exactly at content
 * once the render divides the scale back out. A flank whose content height
 * sits below `minPx` gets no detent: cascadeResize clamps at the cell
 * floor, so that landing is unreachable and offering it would light the
 * cue on a snap that cannot happen. A `null` content height (unmeasurable
 * cell) is skipped the same way. */
export function flankDetentDeltas(args: {
  scale: number;
  n0Above: number;
  n0Below: number;
  contentAbove: number | null;
  contentBelow: number | null;
  minPx: number;
}): number[] {
  const deltas: number[] = [];
  if (args.contentAbove !== null && args.contentAbove >= args.minPx)
    deltas.push(args.scale * args.contentAbove - args.n0Above);
  if (args.contentBelow !== null && args.contentBelow >= args.minPx)
    deltas.push(args.n0Below - args.scale * args.contentBelow);
  return deltas;
}

/** The height-divider rule's drawn style, including the snap cue (D56):
 * a 1px hairline at rest; while the drag is magnetized to a content-height
 * detent, the SAME 2px primary bar the window grip's snappedToContent cue
 * uses -- one snap signifier, one weight. `horizontal` is the rule's long
 * axis; `restOpacity` dims inert (non-resizable) dividers so they don't
 * read as live handles. */
export function dividerRuleStyle(
  snapped: boolean,
  opts: { horizontal: boolean; restOpacity: number },
): CSSProperties {
  const thickness = snapped ? "2px" : "1px";
  return {
    width: opts.horizontal ? "100%" : thickness,
    height: opts.horizontal ? thickness : "100%",
    backgroundColor: snapped
      ? "var(--mantine-primary-color-filled)"
      : "var(--mantine-color-default-border)",
    opacity: snapped ? 1 : opts.restOpacity,
  };
}

/** `el`'s NATURAL content height: what it would auto-size to, INVARIANT of
 * its current rendered height. For each scroll viewport inside `el`, the
 * chrome around it (el - viewport client) plus the viewport's CONTENT
 * wrapper height. We use the `.mantine-ScrollArea-content` wrapper's
 * offsetHeight, NOT the viewport's scrollHeight: when the element is TALLER
 * than its content the viewport stretches and scrollHeight collapses to
 * clientHeight (== the current height), so scrollHeight would wrongly report
 * "content == current height" and the detent would fire everywhere. The
 * content wrapper keeps its true height regardless.
 *
 * Scope-agnostic: the floating window passes its whole paper (the detent is
 * the window's auto height); the height dividers pass ONE flanking cell.
 *
 * TOP-LEVEL viewports only: a scroll area NESTED inside another one (a real
 * shape -- GUI TabGroup hosts a DockArea inside the panel body's own
 * ScrollArea) already sits inside the outer viewport's content wrapper, so
 * its own client/content delta is part of the outer content's offsetHeight.
 * Summing it as well would count that delta twice and pull the detent away
 * from the true auto height. A viewport whose enclosing viewport lies
 * OUTSIDE `el` still counts: within the measured scope it is top-level. */
export function measureNaturalHeight(el: HTMLElement): number {
  let contentSum = 0;
  let clientSum = 0;
  el.querySelectorAll(".mantine-ScrollArea-viewport").forEach((v) => {
    const outer = v.parentElement?.closest(".mantine-ScrollArea-viewport");
    if (outer != null && el.contains(outer)) return; // nested: already counted
    const content = v.querySelector<HTMLElement>(".mantine-ScrollArea-content");
    contentSum += content?.offsetHeight ?? (v as HTMLElement).scrollHeight;
    clientSum += (v as HTMLElement).clientHeight;
  });
  return el.offsetHeight - clientSum + contentSum;
}
