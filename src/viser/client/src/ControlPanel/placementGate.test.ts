// Unit tests for the per-axis placement gate -- the single decision point for
// whether a stored server placement axis is (re)applied to a panel. The
// scenarios mirror the real bugs this replaced:
// - THE yank: dock_right -> user drags to float -> set_width must apply ONLY
//   the width axis (the stale position must not re-dock the panel).
// - Server restart: counters reset, but the runId changes -> fresh command.
// - Cross-scope: `client.gui` has its own runId/counter sequence -> its
//   commands are not swallowed by the server scope's higher counters.

import { describe, expect, it } from "vitest";
import type { PanelLayoutEntry, PanelPlacementState } from "./GuiState";
import { gatePlacement } from "./placementGate";
import { applyPanelPlacement, findPaneGroup } from "../dock/layoutOps";
import { emptyLayout } from "../dock/types";

const RUN_A = "runAAAAA";
const RUN_B = "runBBBBB";

const DOCK_RIGHT = { kind: "edge", edge: "right" } as const;

function entry(axes: Partial<PanelPlacementState>): PanelPlacementState {
  return axes;
}

describe("gatePlacement", () => {
  it("untouched panel: every present axis applies", () => {
    const g = gatePlacement(
      entry({
        position: { value: DOCK_RIGHT, counter: 1, runId: RUN_A },
        width: { value: 400, counter: 2, runId: RUN_A },
      }),
      undefined,
      true,
    );
    expect(g.anyFresh).toBe(true);
    expect(g.placement.position).toEqual(DOCK_RIGHT);
    expect(g.placement.width).toBe(400);
    expect(g.applied).toEqual({
      position: { counter: 1, runId: RUN_A },
      width: { counter: 2, runId: RUN_A },
    });
  });

  it("THE yank: touched panel, later set_width -> width applies, stale position does NOT", () => {
    // dock_right (counter 1) was applied; user then dragged the panel away.
    const tracking = {
      applied: { position: { counter: 1, runId: RUN_A } },
      userTouched: true,
    };
    // set_width arrives (counter 2). The store still holds the old position.
    const g = gatePlacement(
      entry({
        position: { value: DOCK_RIGHT, counter: 1, runId: RUN_A },
        width: { value: 400, counter: 2, runId: RUN_A },
      }),
      tracking,
      true,
    );
    expect(g.anyFresh).toBe(true);
    expect(g.placement.position).toBeNull(); // no re-dock
    expect(g.placement.width).toBe(400);
    expect(g.applied).toEqual({ width: { counter: 2, runId: RUN_A } });
  });

  it("replay (same counters, same run) on a touched panel applies nothing", () => {
    const tracking = {
      applied: {
        position: { counter: 1, runId: RUN_A },
        width: { counter: 2, runId: RUN_A },
      },
      userTouched: true,
    };
    const g = gatePlacement(
      entry({
        position: { value: DOCK_RIGHT, counter: 1, runId: RUN_A },
        width: { value: 400, counter: 2, runId: RUN_A },
      }),
      tracking,
      true,
    );
    expect(g.anyFresh).toBe(false);
    expect(g.placement.position).toBeNull();
    expect(g.placement.width).toBeNull();
  });

  it("server re-assert (same run, higher counter) applies to a touched panel", () => {
    const tracking = {
      applied: { position: { counter: 1, runId: RUN_A } },
      userTouched: true,
    };
    const g = gatePlacement(
      entry({ position: { value: DOCK_RIGHT, counter: 3, runId: RUN_A } }),
      tracking,
      true,
    );
    expect(g.placement.position).toEqual(DOCK_RIGHT);
  });

  it("restarted server / other scope (different runId, LOWER counter) applies", () => {
    const tracking = {
      applied: { position: { counter: 5, runId: RUN_A } },
      userTouched: true,
    };
    const g = gatePlacement(
      entry({ position: { value: DOCK_RIGHT, counter: 1, runId: RUN_B } }),
      tracking,
      true,
    );
    expect(g.placement.position).toEqual(DOCK_RIGHT);
    expect(g.applied).toEqual({ position: { counter: 1, runId: RUN_B } });
  });

  it("an UNPLACED panel applies everything (can't yank what isn't placed)", () => {
    const tracking = {
      applied: { position: { counter: 1, runId: RUN_A } },
      userTouched: true,
    };
    const g = gatePlacement(
      entry({ position: { value: DOCK_RIGHT, counter: 1, runId: RUN_A } }),
      tracking,
      false,
    );
    expect(g.placement.position).toEqual(DOCK_RIGHT);
  });

  it("no entry at all: nothing fresh, all axes null", () => {
    const g = gatePlacement(undefined, undefined, true);
    expect(g.anyFresh).toBe(false);
    expect(g.placement).toEqual({
      position: null,
      width: null,
      height: null,
    });
  });
});

// The gate -> applyPanelPlacement chain as the placement coordinator drives it
// (two passes = two server messages), pinning that a later `set_height` /
// `set_width` actually lands on the floating window model. This is the joint
// the coordinator exercises per pass; keep it covered end to end so a gating
// or bundle-shape change can't silently stop pinning window geometry.
describe("gate -> apply sequence: float then set_height/set_width", () => {
  const PANE = "pane-a";
  const BOUNDS = { width: 1280, height: 800, leftInset: 0, rightInset: 0 };

  it("live: float applies first, set_height(300) pins on the next pass", () => {
    // Pass 1: only the position axis is stored (panel.float(x=..., y=...)).
    const entry1 = entry({
      position: {
        value: { kind: "float", x: 120, y: 120 },
        counter: 1,
        runId: RUN_A,
      },
    });
    const g1 = gatePlacement(entry1, undefined, false);
    let layout = applyPanelPlacement(
      emptyLayout(),
      [PANE],
      g1.placement,
      () => null,
      { canvasBounds: BOUNDS },
    );
    expect(layout.floating).toHaveLength(1);
    expect(layout.floating[0].height).toEqual({ mode: "auto" });

    // Pass 2: set_height(300) merged its axis; the panel is now placed and its
    // position axis already applied (recorded in tracking).
    const tracking: PanelLayoutEntry = {
      applied: g1.applied,
      userTouched: false,
    };
    const entry2 = entry({
      ...entry1,
      height: { value: 300, counter: 2, runId: RUN_A },
    });
    const placed = findPaneGroup(layout, PANE) !== null;
    expect(placed).toBe(true);
    const g2 = gatePlacement(entry2, tracking, placed);
    expect(g2.anyFresh).toBe(true);
    layout = applyPanelPlacement(layout, [PANE], g2.placement, () => null, {
      canvasBounds: BOUNDS,
    });
    expect(layout.floating).toHaveLength(1);
    expect(layout.floating[0].height).toEqual({ mode: "pinned", px: 300 });
  });

  it("live: set_width(360) after float resizes the window", () => {
    const entry1 = entry({
      position: {
        value: { kind: "float", x: 120, y: 120 },
        counter: 1,
        runId: RUN_A,
      },
    });
    const g1 = gatePlacement(entry1, undefined, false);
    let layout = applyPanelPlacement(
      emptyLayout(),
      [PANE],
      g1.placement,
      () => null,
      { canvasBounds: BOUNDS },
    );
    const tracking: PanelLayoutEntry = {
      applied: g1.applied,
      userTouched: false,
    };
    const entry2 = entry({
      ...entry1,
      width: { value: 360, counter: 2, runId: RUN_A },
    });
    const g2 = gatePlacement(entry2, tracking, true);
    layout = applyPanelPlacement(layout, [PANE], g2.placement, () => null, {
      canvasBounds: BOUNDS,
    });
    expect(layout.floating).toHaveLength(1);
    expect(layout.floating[0].width).toBe(360);
  });

  it("replay: float + set_height stored before the first pass pin in one apply", () => {
    const both = entry({
      position: {
        value: { kind: "float", x: 120, y: 120 },
        counter: 1,
        runId: RUN_A,
      },
      height: { value: 300, counter: 2, runId: RUN_A },
    });
    const g = gatePlacement(both, undefined, false);
    const layout = applyPanelPlacement(
      emptyLayout(),
      [PANE],
      g.placement,
      () => null,
      { canvasBounds: BOUNDS },
    );
    expect(layout.floating).toHaveLength(1);
    expect(layout.floating[0].height).toEqual({ mode: "pinned", px: 300 });
  });
});
