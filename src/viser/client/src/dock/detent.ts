// The content-height detent ("magnet"), shared by the floating window's
// height grips and BOTH height dividers (floating stack, docked column
// stack) -- see spec section 6 and D56. HEIGHT only by adjudication: width
// dividers have no semantic width target (panel width is a reading
// preference, not a "natural" size), and a detent without meaning is just
// stickiness.
//
// snapToDetent is pure math (unit-pinned in detent.test.ts); the DOM
// measurement helper lives beside it so every consumer computes "natural
// content height" with the same formula.

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
