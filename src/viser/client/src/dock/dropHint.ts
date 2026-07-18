// The drop-hint painter. DockManager renders one persistent, absolutely
// positioned element (styled with HINT_BASE_STYLE) and hands its ref to the
// drag controller, which paints every hint through paintDropHint here.
//
// The hint is driven imperatively (style mutations on that persistent element)
// rather than via state: it updates on every pointer move during a drag, and
// routing that through setState would re-render the entire dock subtree -- all
// panes and their contents -- once per frame. With the hint (and the window
// transform, tab glue, and leaf preview, which were already imperative) off
// the React path, a drag does no React work per move at all.

import React from "react";
import { DropHint } from "./hitTest";

/** Base style for the drop-hint element. A module constant, so React's style
 * diff never touches the imperative mutations across re-renders. The hint per
 * variant: a tinted highlight (tab merge), a solid zone (edge dock), or a thin
 * insertion bar (split / tab-position / stack drops). */
export const HINT_BASE_STYLE: React.CSSProperties = {
  position: "absolute",
  display: "none",
  pointerEvents: "none",
  zIndex: 1000,
  boxSizing: "border-box",
};

const HINT_VARIANT_STYLES: Record<
  DropHint["variant"],
  { backgroundColor: string; borderRadius: string; opacity: string }
> = {
  merge: {
    backgroundColor: "var(--mantine-primary-color-light)",
    borderRadius: "6px",
    opacity: "0.75",
  },
  fill: {
    backgroundColor: "var(--mantine-primary-color-light)",
    borderRadius: "0",
    opacity: "0.8",
  },
  line: {
    backgroundColor: "var(--mantine-primary-color-filled)",
    borderRadius: "0",
    opacity: "1",
  },
};

/** Show `hint` on the hint element `el` (position + variant styles +
 * data-dock-hint attribute), or hide it for null. No-op when the element
 * hasn't mounted yet. */
export function paintDropHint(
  el: HTMLDivElement | null,
  hint: DropHint | null,
): void {
  if (el === null) return;
  if (hint === null) {
    el.style.display = "none";
    el.removeAttribute("data-dock-hint");
    return;
  }
  const variant = HINT_VARIANT_STYLES[hint.variant];
  el.style.display = "block";
  el.style.left = `${hint.left}px`;
  el.style.top = `${hint.top}px`;
  el.style.width = `${hint.width}px`;
  el.style.height = `${hint.height}px`;
  el.style.backgroundColor = variant.backgroundColor;
  el.style.borderRadius = variant.borderRadius;
  el.style.opacity = variant.opacity;
  el.setAttribute("data-dock-hint", hint.variant);
}
