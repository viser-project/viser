import { describe, expect, it } from "vitest";
import { shouldShowPlaybackScenePanel } from "./SearchParamsUtils";

describe("shouldShowPlaybackScenePanel", () => {
  it("defaults to visible", () => {
    expect(shouldShowPlaybackScenePanel("", undefined)).toBe(true);
    expect(
      shouldShowPlaybackScenePanel(
        "?playbackPath=./recording.viser",
        undefined,
      ),
    ).toBe(true);
  });

  it("hides when the hideSceneTree URL param is present", () => {
    expect(shouldShowPlaybackScenePanel("?hideSceneTree", undefined)).toBe(
      false,
    );
    // Presence-based, like ?darkMode: any value (even empty) hides.
    expect(
      shouldShowPlaybackScenePanel(
        "?playbackPath=./recording.viser&hideSceneTree",
        undefined,
      ),
    ).toBe(false);
    expect(shouldShowPlaybackScenePanel("?hideSceneTree=1", undefined)).toBe(
      false,
    );
  });

  it("respects the embed config opt-out", () => {
    expect(shouldShowPlaybackScenePanel("", { showSceneTree: false })).toBe(
      false,
    );
    expect(shouldShowPlaybackScenePanel("", { showSceneTree: true })).toBe(
      true,
    );
    // Configs written before the option existed have no showSceneTree key.
    expect(shouldShowPlaybackScenePanel("", {})).toBe(true);
  });
});
