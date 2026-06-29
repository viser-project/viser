// Tests for cappedWindowHeight: a pinned floating-window height is capped to the
// container (contents scroll when the browser shrinks below the saved height),
// floored to stay usable in a tiny container -- but NEVER inflated above the
// pinned height (a small panel in a tiny container shrinks, doesn't overhang).

import { describe, expect, it } from "vitest";
import { cappedWindowHeight } from "./layoutOps";
import { MIN_WINDOW_HEIGHT_PX } from "./types";

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
