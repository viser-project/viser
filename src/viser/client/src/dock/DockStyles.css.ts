import { globalStyle, style } from "@vanilla-extract/css";

import { MIN_PANEL_WIDTH_PX } from "./types";

/** Marker class for a panel body's ScrollArea. */
export const dockBodyScroll = style({});

// Size the ScrollArea's content wrapper to `max(100%, MIN_PANEL_WIDTH_PX)`:
// it fills the viewport when the panel is at least the content minimum, but
// holds that minimum and OVERFLOWS (the viewport then shows a horizontal
// scrollbar) once the region is dragged narrower -- the panel body never
// squeezes below MIN_PANEL_WIDTH_PX. The floor is a FIXED pixel constant, not
// Mantine's default `min-content`: min-content lets fixed-pixel content -- e.g.
// a plot canvas that sizes itself from a measure of this very wrapper -- ratchet
// the wrapper wider in a measure->resize feedback loop; a constant floor keeps
// the measured width stable. (The `styles` prop can't express this: it applies
// inline styles, and the wrapper div is an unnamed Radix child of the viewport.)
globalStyle(`${dockBodyScroll} .mantine-ScrollArea-viewport > div`, {
  display: "block",
  minWidth: `max(100%, ${MIN_PANEL_WIDTH_PX}px)`,
});

/** Grip bar background: one step lighter than --mantine-color-default-border
 * in both schemes, so the handle reads as a subtle affordance rather than a
 * heavy divider. */
export const gripBarBg = style({});
globalStyle(`:where([data-mantine-color-scheme="light"]) ${gripBarBg}`, {
  backgroundColor: "var(--mantine-color-gray-2)",
});
globalStyle(`:where([data-mantine-color-scheme="dark"]) ${gripBarBg}`, {
  backgroundColor: "var(--mantine-color-dark-5)",
});

/** Minimize/expand motion (P4 as amended): PURE presentation. The model
 * commits instantly; this class only eases the cell/band wrappers' flex
 * properties between their committed values. Three off-switches keep it
 * honest: prefers-reduced-motion (instant), an ancestor's
 * [data-dock-resizing] (divider drags write weights per frame -- easing
 * would rubber-band the cells behind the cursor), and nothing else -- no
 * timers, no transition-gated logic anywhere. */
export const collapseAnim = style({
  transition:
    "flex-grow 160ms ease, flex-basis 160ms ease, min-height 160ms ease",
  "@media": {
    "(prefers-reduced-motion: reduce)": {
      transition: "none",
    },
  },
  selectors: {
    "[data-dock-resizing] &": {
      transition: "none",
    },
  },
});

/** Visible keyboard-focus ring for the dock's focusable non-native controls
 * (tabs, minimize/expand buttons). Drawn INSIDE the element (negative offset)
 * so overflow:hidden ancestors -- tab strips, grip bars -- can't clip it. Only
 * on :focus-visible, so pointer clicks don't flash a ring. */
export const focusRing = style({
  selectors: {
    "&:focus-visible": {
      outline: "2px solid var(--mantine-primary-color-filled)",
      outlineOffset: "-2px",
    },
  },
});

/** Bottom rule under an unmergeable panel's custom title header. Matches the
 * original FloatingPanel's `<Divider />` exactly: gray-3 in light mode (one
 * step LIGHTER than --mantine-color-default-border) and dark-4 in dark mode. */
export const headerRule = style({});
globalStyle(
  `:where([data-mantine-color-scheme="light"]) ${headerRule}`,
  { borderBottom: "1px solid var(--mantine-color-gray-3)" },
);
globalStyle(
  `:where([data-mantine-color-scheme="dark"]) ${headerRule}`,
  { borderBottom: "1px solid var(--mantine-color-dark-4)" },
);

/** Top rule above a DOCKED+STACKED unmergeable header. Same gray as headerRule
 * (gray-3 light / dark-4 dark), just on the top edge, so it matches the bottom
 * rule between docked panels. */
export const headerRuleTop = style({});
globalStyle(
  `:where([data-mantine-color-scheme="light"]) ${headerRuleTop}`,
  { borderTop: "1px solid var(--mantine-color-gray-3)" },
);
globalStyle(
  `:where([data-mantine-color-scheme="dark"]) ${headerRuleTop}`,
  { borderTop: "1px solid var(--mantine-color-dark-4)" },
);

/** Wayfinding text -- the ONE style for every minimized-surface label (bar
 * segments, spine rows): theme text at chrome emphasis. Spec P3 ("chrome is
 * quiet") + P13 (labels are the header's tabs, restyled). Sizing (0.85em)
 * matches the expanded tab strip so minimized labels are literal cousins of
 * tabs, not a second typography. */
export const wayfindingText = style({
  color: "var(--mantine-color-dimmed)",
  opacity: 0.85,
  fontWeight: 500,
  fontSize: "0.85em",
});
