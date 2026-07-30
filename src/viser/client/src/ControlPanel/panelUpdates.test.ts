// Pins the equality function used by PanelsFallback's `state.panels`
// selector. Regression: shallowObjectKeysEqual compares KEY SETS only, but
// updatePanel replaces the panel object for the updated uuid without changing
// the key set -- so prop updates (visible/order/tab metadata) never reached
// the mobile sheet. The selector must use value-level shallowObjectEqual.

import { describe, expect, it } from "vitest";
import {
  shallowObjectEqual,
  shallowObjectKeysEqual,
} from "../utils/shallowObjectKeysEqual";
import { createStore } from "../store";
import { panelsSelectorEquality } from "./panelsEquality";
import controlPanelSource from "./ControlPanel.tsx?raw";

describe("panels selector equality", () => {
  it("shallowObjectKeysEqual misses same-key value changes (the old bug)", () => {
    // Same key set, different value: the keys-only compare reports "equal",
    // which is exactly why panel prop updates were swallowed.
    expect(shallowObjectKeysEqual({ a: 1 }, { a: 2 })).toBe(true);
  });

  it("shallowObjectEqual detects same-key value changes", () => {
    expect(shallowObjectEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowObjectEqual({ a: 1 }, { a: 1 })).toBe(true);
  });

  it("a subscriber using shallowObjectEqual sees an updatePanel-style change", () => {
    type Panel = { uuid: string; props: { visible: boolean; order: number } };
    const panelA: Panel = { uuid: "a", props: { visible: true, order: 0 } };
    const store = createStore({
      panels: { a: panelA } as Record<string, Panel>,
    });

    // Mirror the useStore snapshot logic (selector + equality cache) without
    // React: on each notification, keep the cached slice iff equalityFn says
    // it's unchanged.
    const track = (equalityFn: (a: any, b: any) => boolean) => {
      let cached = store.get().panels;
      const seen: Record<string, Panel>[] = [];
      store.subscribe(() => {
        const next = store.get().panels;
        if (!equalityFn(cached, next)) {
          cached = next;
          seen.push(next);
        }
      });
      return seen;
    };
    const seenByKeys = track(shallowObjectKeysEqual);
    const seenByValues = track(shallowObjectEqual);

    // updatePanel-style change: replace the panel object for one uuid,
    // keeping the key set identical (GuiState.updatePanel).
    store.set((state) => ({
      panels: {
        ...state.panels,
        a: { ...panelA, props: { ...panelA.props, visible: false } },
      },
    }));

    expect(seenByKeys).toHaveLength(0); // the old bug: update invisible
    expect(seenByValues).toHaveLength(1);
    expect(seenByValues[0].a.props.visible).toBe(false);
  });

  // The tests above pin the UTILITIES; these two pin the WIRING. Without
  // them, reverting the component to the keys-only comparator would leave
  // this whole suite green while the mobile-sheet regression returns.
  it("panelsSelectorEquality is the value-level comparator", () => {
    expect(panelsSelectorEquality).toBe(shallowObjectEqual);
  });

  it("PanelsFallback's panels selector subscribes with panelsSelectorEquality", () => {
    // Source-level pin (the component renders a Mantine tree, so a render
    // test would drag in far more than this assertion needs): the selector
    // must pass the pinned comparator, and the component must not import a
    // comparator directly.
    expect(controlPanelSource).toMatch(
      /useGui\(\s*\(state\) => state\.panels,\s*panelsSelectorEquality,?\s*\)/,
    );
    expect(controlPanelSource).not.toContain("shallowObjectKeysEqual");
  });
});
