import { globalStyle, style } from "@vanilla-extract/css";

/** Marker class for a panel body's ScrollArea. */
export const dockBodyScroll = style({});

// Pin the ScrollArea's content wrapper to the viewport width. Mantine's
// default (min-width: min-content) lets fixed-pixel content -- e.g. a plot
// canvas that sizes itself from a measure of this very wrapper -- ratchet the
// wrapper wider in a measure->resize feedback loop, churning the content
// width on every panel/container resize. (The `styles` prop can't express
// this: it applies inline styles, and the wrapper div is an unnamed Radix
// child of the viewport.)
globalStyle(`${dockBodyScroll} .mantine-ScrollArea-viewport > div`, {
  display: "block",
  minWidth: "100%",
  maxWidth: "100%",
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
