// Unit tests for the per-axis placement gate -- the single decision point for
// whether a stored server placement axis is (re)applied to a panel. The
// scenarios mirror the real bugs this replaced:
// - THE yank: dock_right -> user drags to float -> set_width must apply ONLY
//   the width axis (the stale position must not re-dock the panel).
// - Server restart: counters reset, but the runId changes -> fresh command.
// - Cross-scope: `client.gui` has its own runId/counter sequence -> its
//   commands are not swallowed by the server scope's higher counters.

import { describe, expect, it } from "vitest";
import type { PanelPlacementState } from "./GuiState";
import { gatePlacement } from "./placementGate";

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
