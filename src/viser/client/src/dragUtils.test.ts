import { describe, it, expect } from "vitest";
import {
  pointerButtonFromNative,
  keyModifierFromEvent,
  matchesModifierFilter,
  matchesDragBinding,
  anyBindingMatches,
  hasCmdCtrl,
  motionExceedsThreshold,
  planModifierTransition,
  MOTION_THRESHOLD_PX,
} from "./dragUtils";

describe("pointerButtonFromNative", () => {
  it("maps native button codes", () => {
    expect(pointerButtonFromNative(0)).toBe("left");
    expect(pointerButtonFromNative(1)).toBe("middle");
    expect(pointerButtonFromNative(2)).toBe("right");
  });
  it("returns null for unknown buttons", () => {
    expect(pointerButtonFromNative(3)).toBeNull();
  });
});

describe("keyModifierFromEvent", () => {
  const ev = (overrides: Partial<Record<string, boolean>> = {}) => ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  });
  it("returns null when no modifiers are held", () => {
    expect(keyModifierFromEvent(ev())).toBeNull();
  });
  it("collapses ctrl and meta to cmd/ctrl", () => {
    expect(keyModifierFromEvent(ev({ ctrlKey: true }))).toBe("cmd/ctrl");
    expect(keyModifierFromEvent(ev({ metaKey: true }))).toBe("cmd/ctrl");
  });
  it("emits modifiers in canonical cmd/ctrl -> alt -> shift order", () => {
    expect(
      keyModifierFromEvent(ev({ shiftKey: true, altKey: true, ctrlKey: true })),
    ).toBe("cmd/ctrl+alt+shift");
    expect(keyModifierFromEvent(ev({ shiftKey: true, altKey: true }))).toBe(
      "alt+shift",
    );
  });
});

describe("matchesModifierFilter", () => {
  it("is exact equality, including null", () => {
    expect(matchesModifierFilter(null, null)).toBe(true);
    expect(matchesModifierFilter("alt", "alt")).toBe(true);
    expect(matchesModifierFilter("alt", null)).toBe(false);
    expect(matchesModifierFilter(null, "alt")).toBe(false);
  });
});

describe("matchesDragBinding / anyBindingMatches", () => {
  it("requires both button and modifier to match", () => {
    const binding = { button: "left" as const, modifier: "shift" as const };
    expect(
      matchesDragBinding(binding, { button: "left", modifier: "shift" }),
    ).toBe(true);
    expect(
      matchesDragBinding(binding, { button: "right", modifier: "shift" }),
    ).toBe(false);
    expect(
      matchesDragBinding(binding, { button: "left", modifier: null }),
    ).toBe(false);
  });
  it("anyBindingMatches returns true if any binding matches", () => {
    const bindings = [
      { button: "left" as const, modifier: null },
      { button: "right" as const, modifier: "alt" as const },
    ];
    expect(
      anyBindingMatches(bindings, { button: "right", modifier: "alt" }),
    ).toBe(true);
    expect(
      anyBindingMatches(bindings, { button: "middle", modifier: null }),
    ).toBe(false);
  });
});

describe("hasCmdCtrl", () => {
  it("is true only for cmd/ctrl-prefixed modifiers", () => {
    expect(hasCmdCtrl("cmd/ctrl")).toBe(true);
    expect(hasCmdCtrl("cmd/ctrl+shift")).toBe(true);
    expect(hasCmdCtrl("alt")).toBe(false);
    expect(hasCmdCtrl(null)).toBe(false);
  });
});

describe("planModifierTransition", () => {
  // mjviser-style setup: two bound combos on the left button, used to
  // switch the drag plane mid-gesture.
  const bindings = [
    { button: "left" as const, modifier: "cmd/ctrl" as const },
    { button: "left" as const, modifier: "cmd/ctrl+shift" as const },
  ];

  it("is a no-op when the modifier is unchanged", () => {
    expect(
      planModifierTransition("cmd/ctrl", "cmd/ctrl", bindings, "left", true),
    ).toBeNull();
    // Even when nothing is held and nothing changes.
    expect(planModifierTransition(null, null, bindings, "left", false)).toBeNull();
  });

  it("ends the old segment and starts a new one between two bound combos", () => {
    expect(
      planModifierTransition("cmd/ctrl", "cmd/ctrl+shift", bindings, "left", true),
    ).toEqual({ emitEnd: true, emitStart: true });
  });

  it("ends the segment and goes dormant when the new combo is unbound", () => {
    // ctrl is bound, shift-only is not -- releasing ctrl mid-drag drops
    // into a dormant gap rather than starting a spurious segment.
    expect(
      planModifierTransition("cmd/ctrl", "shift", bindings, "left", true),
    ).toEqual({ emitEnd: true, emitStart: false });
  });

  it("starts a fresh segment when re-entering a bound combo from dormant", () => {
    // Already dormant (segmentActive=false): no end to emit, just the
    // new start.
    expect(
      planModifierTransition("shift", "cmd/ctrl", bindings, "left", false),
    ).toEqual({ emitEnd: false, emitStart: true });
  });

  it("stays dormant when moving between two unbound combos", () => {
    expect(
      planModifierTransition("shift", "alt", bindings, "left", false),
    ).toEqual({ emitEnd: false, emitStart: false });
  });

  it("respects the button when matching the new combo", () => {
    // The same modifier on a button with no binding is unbound.
    expect(
      planModifierTransition(null, "cmd/ctrl", bindings, "right", false),
    ).toEqual({ emitEnd: false, emitStart: false });
  });
});

describe("motionExceedsThreshold", () => {
  it("is false for movement at or under the threshold (L-infinity)", () => {
    expect(motionExceedsThreshold([0, 0], [0, 0])).toBe(false);
    expect(
      motionExceedsThreshold(
        [0, 0],
        [MOTION_THRESHOLD_PX, MOTION_THRESHOLD_PX],
      ),
    ).toBe(false);
  });
  it("is true when either axis exceeds the threshold", () => {
    expect(motionExceedsThreshold([0, 0], [MOTION_THRESHOLD_PX + 1, 0])).toBe(
      true,
    );
    expect(
      motionExceedsThreshold([10, 10], [10, 10 + MOTION_THRESHOLD_PX + 1]),
    ).toBe(true);
  });
});
