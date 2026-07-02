// Unit tests for panel stable identity: explicit server-provided keys are used
// directly (identity as an INPUT); keyless panels fall back to the
// label+order inference; the two namespaces cannot collide by construction.

import { describe, expect, it } from "vitest";
import type { GuiPanelMessage } from "../WebsocketMessages";
import { computePaneToStableKey } from "./panelIdentity";

function panel(opts: {
  labels: string[];
  order: number;
  key?: string;
}): GuiPanelMessage {
  return {
    type: "GuiPanelMessage",
    uuid: "ignored",
    props: {
      _tab_labels: opts.labels,
      _tab_icons_html: opts.labels.map(() => null),
      _tab_container_ids: opts.labels.map((_, i) => `c${i}`),
      _stable_key: opts.key ?? null,
      order: opts.order,
      visible: true,
    },
  } as GuiPanelMessage;
}

describe("computePaneToStableKey", () => {
  it("explicit keys are used directly and survive tab renames", () => {
    const before = computePaneToStableKey({
      a: panel({ labels: ["Stats"], order: 0, key: "stats" }),
    });
    const after = computePaneToStableKey({
      a: panel({ labels: ["Renamed", "Extra"], order: 0, key: "stats" }),
    });
    expect(before.get("a")).toBe(after.get("a")); // identity is the key
  });

  it("keyless panels infer from labels, numbered by creation order", () => {
    const keys = computePaneToStableKey({
      first: panel({ labels: ["Twin"], order: 1 }),
      second: panel({ labels: ["Twin"], order: 2 }),
      other: panel({ labels: ["Other"], order: 3 }),
    });
    expect(keys.get("first")).not.toBe(keys.get("second")); // numbered
    expect(keys.get("first")).not.toBe(keys.get("other"));
    // Order (not object insertion) breaks the tie.
    const swapped = computePaneToStableKey({
      second: panel({ labels: ["Twin"], order: 2 }),
      first: panel({ labels: ["Twin"], order: 1 }),
    });
    expect(swapped.get("first")).toBe(keys.get("first"));
  });

  it("an explicit key can never collide with an inferred identity", () => {
    // A keyless panel whose labels spell out an inferred-looking string vs. an
    // explicit key with the same content: distinct namespaces by construction.
    const keys = computePaneToStableKey({
      explicit: panel({ labels: ["X"], order: 0, key: "X#0" }),
      inferred: panel({ labels: ["X#0"], order: 1 }),
    });
    expect(keys.get("explicit")).not.toBe(keys.get("inferred"));
  });
});
