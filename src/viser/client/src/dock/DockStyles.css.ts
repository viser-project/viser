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
