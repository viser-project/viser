import { globalStyle, style } from "@vanilla-extract/css";

export const htmlIconWrapper = style({
  height: "1em",
  width: "1em",
  position: "relative",
});

globalStyle(`${htmlIconWrapper} svg`, {
  height: "auto",
  width: "1em",
  position: "absolute",
  top: "50%",
  transform: "translateY(-50%)",
});

// Class for sliders with default min/max marks. We use this for aestheticn
// its; global styles are used to shift the min/max mark labels to stay closer
// within the bounds of the slider.
export const sliderDefaultMarks = style({});

globalStyle(
  `${sliderDefaultMarks} .mantine-Slider-markWrapper:first-of-type div:nth-of-type(2)`,
  {
    transform: "translate(-0.1rem, 0.03rem) !important",
  },
);

globalStyle(
  `${sliderDefaultMarks} .mantine-Slider-markWrapper:last-of-type div:nth-of-type(2)`,
  {
    transform: "translate(-85%, 0.03rem) !important",
  },
);

// Style for filled slider marks - use primary color to match the active segment.
globalStyle(".mantine-Slider-mark[data-filled]:not([data-disabled])", {
  background: "var(--mantine-primary-color-filled)",
  borderColor: "var(--mantine-primary-color-filled)",
});

// Style for filled slider marks when disabled - use separate rules for light/dark.
globalStyle(".mantine-Slider-mark[data-filled][data-disabled]", {
  background: "var(--mantine-color-gray-5)",
  borderColor: "var(--mantine-color-gray-5)",
});

// Dark mode styles for filled marks when disabled.
globalStyle(
  '[data-mantine-color-scheme="dark"] .mantine-Slider-mark[data-filled][data-disabled]',
  {
    background: "var(--mantine-color-dark-3)",
    borderColor: "var(--mantine-color-dark-3)",
  },
);

// Tab group: when tabs wrap onto multiple rows, the default Mantine underline
// (drawn via ::before on the list) only appears below the last row. Replace
// it with a per-tab strategy: each tab gets its own bottom border, plus a
// pseudo-element that projects the gray line to the right so the underline
// fills the full width of every row (including past the last tab).
export const tabGroupWrap = style({});

globalStyle(`${tabGroupWrap} .mantine-Tabs-list`, {
  // Clip the rightward-projecting stripes so they don't escape the panel.
  overflowX: "clip",
});

globalStyle(`${tabGroupWrap} .mantine-Tabs-list::before`, {
  display: "none",
});

globalStyle(`${tabGroupWrap} .mantine-Tabs-tab:not([data-active])`, {
  borderBottomColor: "var(--tab-border-color)",
});

globalStyle(`${tabGroupWrap} .mantine-Tabs-tab`, {
  backgroundColor: "transparent",
});

globalStyle(`${tabGroupWrap} .mantine-Tabs-tab:hover`, {
  backgroundColor: "transparent",
  // Use the same theme color as the active-tab underline. Icons rendered via
  // `currentColor` will pick this up automatically.
  color: "var(--tabs-color)",
});

globalStyle(`${tabGroupWrap} .mantine-Tabs-tab::after`, {
  content: "''",
  position: "absolute",
  left: "100%",
  // Match the per-tab border-bottom thickness (2px in the default Mantine
  // variant) so the projected stripe lines up with the under-tab border.
  bottom: "calc(-1 * var(--tabs-list-border-width))",
  width: "200vw",
  height: "var(--tabs-list-border-width)",
  backgroundColor: "var(--tab-border-color)",
  pointerEvents: "none",
});
