// Pins for the mobile sheet's collapse arbitration (MobilePanelSection).
// Third-review regression: desktop and mobile do NOT share collapse state, so
// they must not share an applied watermark either -- a command consumed by
// one surface must still apply to the other.

import { describe, expect, it } from "vitest";
import {
  mobileSectionAfterAxis,
  mobileSectionsFromPlacement,
} from "./mobileSection";

const RUN_A = "runAAAAA";

describe("mobileSectionAfterAxis", () => {
  it("re-review regression: a command consumed by the DESKTOP dock still applies to a freshly mounted mobile section", () => {
    // panel.expand() (counter 5) applied while the desktop dock was mounted;
    // the viewport then shrinks and the sheet section mounts with no mobile
    // state. The section's own watermark is empty -- the desktop's record
    // must not starve it -- so the expand applies and the section opens.
    const next = mobileSectionAfterAxis(undefined, {
      value: false, // expand()
      counter: 5,
      runId: RUN_A,
    });
    expect(next).toEqual({
      expanded: true,
      collapsedApplied: { [RUN_A]: 5 },
    });
  });

  it("a reconnect replay of the section's own applied command is stale (user taps survive)", () => {
    // expand() c5 applied here; the user tapped the section closed; a
    // reconnect replays c5. The section's surviving watermark rejects it --
    // and because the EXPANDED state also lives in the store, the remounted
    // section keeps the user's tap instead of resetting to the default.
    const applied = mobileSectionAfterAxis(undefined, {
      value: false,
      counter: 5,
      runId: RUN_A,
    })!;
    const afterTap = { ...applied, expanded: false }; // user tapped closed
    expect(
      mobileSectionAfterAxis(afterTap, {
        value: false,
        counter: 5,
        runId: RUN_A,
      }),
    ).toBeNull();
  });

  it("a genuinely newer command overrides a user tap", () => {
    const applied = mobileSectionAfterAxis(undefined, {
      value: false,
      counter: 5,
      runId: RUN_A,
    })!;
    const afterTap = { ...applied, expanded: false };
    const next = mobileSectionAfterAxis(afterTap, {
      value: false,
      counter: 6,
      runId: RUN_A,
    });
    expect(next?.expanded).toBe(true);
    expect(next?.collapsedApplied).toEqual({ [RUN_A]: 6 });
  });
});

describe("mobileSectionsFromPlacement (resetPanelLayout)", () => {
  it("fourth-review regression: reset restores the server's stored collapse on mobile, discarding taps and watermarks", () => {
    // Server expand() (c5) applied on mobile; the user tapped the section
    // closed. Reset Panel Layout must return the section to the layout the
    // server set -- expanded -- not preserve the tap behind a surviving
    // watermark (the mobile effect can't do this: it re-runs on axis
    // CHANGES, and reset re-applies axes without changing them).
    const rebuilt = mobileSectionsFromPlacement({
      p1: { collapsed: { value: false, counter: 5, runId: RUN_A } },
      p2: {}, // no stored collapse command -> sheet default (no entry)
    });
    expect(rebuilt).toEqual({
      p1: { expanded: true, collapsedApplied: { [RUN_A]: 5 } },
    });
  });
});
