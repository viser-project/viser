// Tests for cappedWindowHeight: a pinned floating-window height is capped to the
// container (contents scroll when the browser shrinks below the saved height),
// floored to stay usable in a tiny container -- but NEVER inflated above the
// pinned height (a small panel in a tiny container shrinks, doesn't overhang).
// Plus collapsedWindowHeightCss (D34's numeric collapse endpoint) and the
// D33 header/face-bar constancy constant.

import { describe, expect, it } from "vitest";
import { cappedWindowHeight } from "./layoutOps";
import {
  collapsedWindowHeightCss,
  FACE_BAR_EM,
  FACE_BAR_HEIGHT_EM,
  HEADER_PAD_EM,
  MIN_WINDOW_HEIGHT_PX,
  MINIMIZED_BAR_PX,
  PaneSpec,
  SPLIT_DIVIDER_PX,
  STACK_HANDLE_EM,
  TabGroup,
} from "./types";

describe("cappedWindowHeight", () => {
  it("returns the pinned height when it fits the container", () => {
    expect(cappedWindowHeight(300, 800)).toBe(300);
  });

  it("caps to (container - 8) when the container is smaller than pinned", () => {
    expect(cappedWindowHeight(700, 400)).toBe(392);
  });

  it("floors at MIN_WINDOW_HEIGHT_PX for a tall window in a tiny container", () => {
    // container-8 is tiny, but a 300px window stays usable at the floor, scrolling.
    expect(cappedWindowHeight(300, 40)).toBe(MIN_WINDOW_HEIGHT_PX);
  });

  it("does NOT inflate a small window above its pinned height (the bug)", () => {
    // A pinned height BELOW the floor in a tiny container: the result must never
    // exceed the pinned height (the window shrinks, doesn't overhang).
    const pinned = MIN_WINDOW_HEIGHT_PX - 10;
    expect(cappedWindowHeight(pinned, 40)).toBeLessThanOrEqual(pinned);
  });

  it("a small window in a comfortable container keeps its pinned height", () => {
    expect(cappedWindowHeight(90, 800)).toBe(90);
  });

  it("returns the pinned height when the container is unmeasured (0)", () => {
    expect(cappedWindowHeight(300, 0)).toBe(300);
  });
});

// D34: a collapsed window's height is a DETERMINISTIC calc() over its chrome
// (header + bars + dividers) -- the honest numeric endpoint the height
// transition eases to, with no DOM measurement.
describe("collapsedWindowHeightCss", () => {
  const g = (id: string, panes: string[]): TabGroup => ({
    id,
    paneIds: panes,
    activeId: panes[0] ?? null,
  });
  const pane = (id: string): PaneSpec => ({
    id,
    title: id,
    render: () => null,
  });

  it("single plain group: one bar, no header, no dividers", () => {
    const panes = { p: pane("p") };
    expect(collapsedWindowHeightCss([g("a", ["p"])], panes)).toBe(
      `calc(0em + ${MINIMIZED_BAR_PX}px)`,
    );
  });

  it("single FACE group: the header-height bar, in em (D19/D33)", () => {
    const panes = { p: { ...pane("p"), minimizedFace: "x" } };
    expect(collapsedWindowHeightCss([g("a", ["p"])], panes)).toBe(
      `calc(${FACE_BAR_HEIGHT_EM}em + 0px)`,
    );
  });

  it("multi-group stack: header + bars + dividers", () => {
    const panes = { p: pane("p"), q: { ...pane("q"), minimizedFace: "x" } };
    expect(
      collapsedWindowHeightCss([g("a", ["p"]), g("b", ["q"])], panes),
    ).toBe(
      `calc(${STACK_HANDLE_EM + FACE_BAR_HEIGHT_EM}em + ${
        MINIMIZED_BAR_PX + SPLIT_DIVIDER_PX
      }px)`,
    );
  });

  it("a multi-pane group's bar is one plain bar (no face)", () => {
    const panes = { p: { ...pane("p"), minimizedFace: "x" }, q: pane("q") };
    // Face applies to single-pane groups only (hasMinimizedFace).
    expect(collapsedWindowHeightCss([g("a", ["p", "q"])], panes)).toBe(
      `calc(0em + ${MINIMIZED_BAR_PX}px)`,
    );
  });
});

// D33 constancy constants: the face bar reproduces the unmergeable header's
// geometry exactly, via shared constants (drift = a failing build, not a
// visual regression hunt).
describe("D33 constancy constants", () => {
  it("FACE_BAR_EM derives from the numeric em height", () => {
    expect(FACE_BAR_EM).toBe(`${FACE_BAR_HEIGHT_EM}em`);
  });
  it("the shared header/face-bar side padding is 0.75em", () => {
    expect(HEADER_PAD_EM).toBe(0.75);
  });
});
