// Unit tests for the per-axis placement gate -- the single decision point for
// whether a stored server placement axis is (re)applied to a panel. The
// scenarios mirror the real bugs this replaced:
// - THE yank: dock_right -> user drags to float -> set_width must apply ONLY
//   the width axis (the stale position must not re-dock the panel).
// - Server restart: counters reset, but the runId changes -> fresh command.
// - Cross-scope: `client.gui` has its own runId/counter sequence -> its
//   commands are not swallowed by the server scope's higher counters.

import { describe, expect, it } from "vitest";
import type { AppliedAxes, PanelPlacementState } from "./GuiState";
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
  it("no prior applies (fresh tracking): every present axis applies", () => {
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
      position: { [RUN_A]: 1 },
      width: { [RUN_A]: 2 },
    });
  });

  it("THE yank: later set_width -> width applies, stale position does NOT (no touch bit needed, D52)", () => {
    // dock_right (counter 1) was applied; user then dragged the panel away.
    const tracking: AppliedAxes = { position: { [RUN_A]: 1 } };
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
    expect(g.applied).toEqual({ width: { [RUN_A]: 2 } });
  });

  it("replay (same counters, same run) on a placed panel applies nothing", () => {
    const tracking: AppliedAxes = {
      position: { [RUN_A]: 1 },
      width: { [RUN_A]: 2 },
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
    // Gated-off width is ABSENT (undefined) -- null would be a fresh clear.
    expect(g.placement.width).toBeUndefined();
  });

  it("server re-assert (same run, higher counter) applies", () => {
    const tracking: AppliedAxes = { position: { [RUN_A]: 1 } };
    const g = gatePlacement(
      entry({ position: { value: DOCK_RIGHT, counter: 3, runId: RUN_A } }),
      tracking,
      true,
    );
    expect(g.placement.position).toEqual(DOCK_RIGHT);
  });

  it("restarted server / other scope (different runId, LOWER counter) applies", () => {
    const tracking: AppliedAxes = { position: { [RUN_A]: 5 } };
    const g = gatePlacement(
      entry({ position: { value: DOCK_RIGHT, counter: 1, runId: RUN_B } }),
      tracking,
      true,
    );
    expect(g.placement.position).toEqual(DOCK_RIGHT);
    expect(g.applied).toEqual({ position: { [RUN_B]: 1 } });
  });

  it("scan regression (P3): a reconnect replay of an OLD run's command is stale even when the last apply came from another scope", () => {
    // server.gui (RUN_A) docked the panel; client.gui (RUN_B) later floated
    // it; the user then dragged it. A reconnect replays only the broadcast
    // buffer -- RUN_A's old position. With single-stamp tracking this read as
    // "different runId from last-applied -> fresh" and yanked the panel; the
    // per-run high-water map keeps RUN_A's mark and rejects it.
    const tracking: AppliedAxes = { position: { [RUN_A]: 5, [RUN_B]: 2 } };
    const g = gatePlacement(
      entry({ position: { value: DOCK_RIGHT, counter: 5, runId: RUN_A } }),
      tracking,
      true,
    );
    expect(g.anyFresh).toBe(false);
    expect(g.placement.position).toBeNull();
    // A genuinely NEW command from either run still applies.
    const g2 = gatePlacement(
      entry({ position: { value: DOCK_RIGHT, counter: 6, runId: RUN_A } }),
      tracking,
      true,
    );
    expect(g2.placement.position).toEqual(DOCK_RIGHT);
  });

  it("re-review regression (D52): a new message on ONE axis does not re-free another axis's already-applied command", () => {
    // A.minimize() (counter 5) applied; B.expand() (counter 6) then expanded
    // the shared column; A.set_width(444) (counter 7) arrives. The old
    // "untouched panel re-applies every present axis" arm re-freed A's stale
    // collapse and re-collapsed the column B had just expanded.
    const tracking: AppliedAxes = { collapsed: { [RUN_A]: 5 } };
    const g = gatePlacement(
      entry({
        collapsed: { value: true, counter: 5, runId: RUN_A },
        width: { value: 444, counter: 7, runId: RUN_A },
      }),
      tracking,
      true,
    );
    expect(g.placement.width).toBe(444);
    expect(g.placement.collapsed).toBeNull(); // at its high-water: stale
    expect(g.applied).toEqual({ width: { [RUN_A]: 7 } });
  });

  it("an UNPLACED panel applies everything (can't yank what isn't placed)", () => {
    const tracking: AppliedAxes = { position: { [RUN_A]: 1 } };
    const g = gatePlacement(
      entry({ position: { value: DOCK_RIGHT, counter: 1, runId: RUN_A } }),
      tracking,
      false,
    );
    expect(g.placement.position).toEqual(DOCK_RIGHT);
  });

  it("no entry at all: nothing fresh, every axis absent", () => {
    const g = gatePlacement(undefined, undefined, true);
    expect(g.anyFresh).toBe(false);
    expect(g.placement.position).toBeNull();
    expect(g.placement.collapsed).toBeNull();
    // Width/height are tri-state: absent is undefined, NOT null (null would
    // read as a fresh clear-to-default command downstream).
    expect(g.placement.width).toBeUndefined();
    expect(g.placement.height).toBeUndefined();
  });

  // gui.reset() sends width/height None ("clear the override"); the gate must
  // pass the null VALUE through as a command, not conflate it with a
  // gated-off axis -- the `?? null` regression left reset windows pinned
  // forever. Table-driven over BOTH axes so neither can silently regress.
  it.each([
    { axis: "height" as const, other: "width" as const },
    { axis: "width" as const, other: "height" as const },
  ])(
    "a FRESH $axis clear (stored value null) survives as null",
    ({ axis, other }) => {
      const g = gatePlacement(
        entry({ [axis]: { value: null, counter: 3, runId: RUN_A } }),
        undefined,
        true,
      );
      expect(g.anyFresh).toBe(true);
      expect(g.placement[axis]).toBeNull(); // fresh clear -> revert to default
      expect(g.placement[other]).toBeUndefined(); // absent axis -> untouched
      expect(g.applied).toEqual({ [axis]: { [RUN_A]: 3 } });
    },
  );
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
    const tracking: AppliedAxes = g1.applied;
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
    const tracking: AppliedAxes = g1.applied;
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
