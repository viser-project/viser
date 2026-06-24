// Tests for applyPanelPlacement: the server-authored placement of standalone
// panels (Python `server.gui.add_panel()`), covering edge / split / float
// placement, width/height, expand-by-default, multi-pane grouping, repositioning.

import { describe, expect, it, vi } from "vitest";
import {
  applyPanelPlacement,
  findGroupLocation,
  findPaneGroup,
  moveWindow,
  PanelPlacement,
  releaseAnchor,
  removePane,
  resizeWindow,
  resizeWindowHeight,
  resolveRequestedFloatPosition,
  tearOutPane,
} from "./layoutOps";
import { emptyLayout, DockLayout, pinnedPxOf } from "./types";

const BOUNDS_1000 = {
  width: 1000,
  height: 800,
  leftInset: 0,
  rightInset: 0,
};

const EMPTY: PanelPlacement = {
  position: null,
  width: null,
  height: null,
};

/** anchorGroupOf that resolves a uuid to the group currently holding the pane
 * of the same name (for tests where the anchor's pane id == its uuid). */
const anchorByPane = (layout: DockLayout) => (uuid: string) =>
  findPaneGroup(layout, uuid);

describe("applyPanelPlacement", () => {
  it("docks a single-pane panel to the right edge", () => {
    const out = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { ...EMPTY, position: { kind: "edge", edge: "right" } },
      () => null,
    );
    const gid = findPaneGroup(out, "p");
    expect(gid).not.toBeNull();
    const loc = findGroupLocation(out, gid!);
    expect(loc).toEqual({ kind: "docked", edge: "right", nodeId: expect.any(String) });
  });

  it("docks to the left edge", () => {
    const out = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { ...EMPTY, position: { kind: "edge", edge: "left" } },
      () => null,
    );
    const loc = findGroupLocation(out, findPaneGroup(out, "p")!);
    expect(loc?.kind).toBe("docked");
    expect((loc as { edge: string }).edge).toBe("left");
  });

  it("floats a panel at explicit coordinates and size", () => {
    const out = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { position: { kind: "float", x: 42, y: 84 }, width: 350, height: 250 },
      () => null,
    );
    expect(out.floating).toHaveLength(1);
    const win = out.floating[0];
    expect(win.x).toBe(42);
    expect(win.y).toBe(84);
    expect(win.width).toBe(350);
    expect(win.height).toEqual({ mode: "pinned", px: 250 });
  });

  it("offsets a float's x by the canvas left inset (canvas-relative coords)", () => {
    // float(x=40) with a 300px left-docked region should land at 340 (clear of
    // the dock), not 40 (under it). y is unaffected (no top dock).
    const out = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { position: { kind: "float", x: 40, y: 20 }, width: null, height: null },
      () => null,
      {
        canvasBounds: {
          width: 1280,
          height: 800,
          leftInset: 300,
          rightInset: 0,
        },
      },
    );
    expect(out.floating[0].x).toBe(340);
    expect(out.floating[0].y).toBe(20);
    // The anchor (canvas-relative request) is stored for later re-resolution.
    expect(out.floating[0].anchor?.x).toBe(40);
    expect(out.floating[0].anchor?.y).toBe(20);
  });

  it("resolves a negative x as a gap from the canvas RIGHT edge", () => {
    // float(x=-15) in a 1000px-wide canvas (no insets) with a 240px window:
    // right edge 15px from the right boundary -> left edge at 1000-240-15 = 745.
    const out = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { position: { kind: "float", x: -15, y: 15 }, width: 240, height: null },
      () => null,
      { canvasBounds: { width: 1000, height: 800, leftInset: 0, rightInset: 0 } },
    );
    expect(out.floating[0].x).toBe(745);
    expect(out.floating[0].y).toBe(15);
    expect(out.floating[0].anchor?.x).toBe(-15);
  });

  it("resolves a negative y as a gap from the canvas BOTTOM edge", () => {
    // float(y=-15) with an explicit 200px-tall window in an 800px canvas:
    // bottom edge 15px from the bottom -> top at 800-200-15 = 585.
    const out = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { position: { kind: "float", x: 15, y: -15 }, width: 240, height: 200 },
      () => null,
      { canvasBounds: { width: 1000, height: 800, leftInset: 0, rightInset: 0 } },
    );
    expect(out.floating[0].y).toBe(585);
  });

  it("floats at default geometry when x/y/size are null", () => {
    const out = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { ...EMPTY, position: { kind: "float", x: null, y: null } },
      () => null,
    );
    expect(out.floating).toHaveLength(1);
    // Defaults are finite, positive.
    expect(out.floating[0].width).toBeGreaterThan(0);
  });

  it("groups multiple panes into one panel group", () => {
    const out = applyPanelPlacement(
      emptyLayout(),
      ["a", "b", "c"],
      { ...EMPTY, position: { kind: "edge", edge: "right" } },
      () => null,
    );
    const gid = findPaneGroup(out, "a");
    expect(gid).not.toBeNull();
    // All three panes share the one group.
    expect(findPaneGroup(out, "b")).toBe(gid);
    expect(findPaneGroup(out, "c")).toBe(gid);
    expect(out.groups[gid!].paneIds).toEqual(["a", "b", "c"]);
  });

  it("splits above a docked anchor panel (column split)", () => {
    // First dock the anchor.
    let layout = applyPanelPlacement(
      emptyLayout(),
      ["anchor"],
      { ...EMPTY, position: { kind: "edge", edge: "right" } },
      () => null,
    );
    // Then dock the new panel above it.
    layout = applyPanelPlacement(
      layout,
      ["p"],
      { ...EMPTY, position: { kind: "split", anchor_uuid: "anchor", side: "above" } },
      anchorByPane(layout),
    );
    const right = layout.docked.right;
    expect(right?.type).toBe("split");
    expect((right as { dir: string }).dir).toBe("column");
    // The new panel's group is the FIRST child (above).
    const firstChild = (right as { children: { type: string; group?: string }[] })
      .children[0];
    expect(firstChild.type).toBe("leaf");
    expect(firstChild.group).toBe(findPaneGroup(layout, "p"));
  });

  it("splits below a docked anchor (new panel is the second child)", () => {
    let layout = applyPanelPlacement(
      emptyLayout(),
      ["anchor"],
      { ...EMPTY, position: { kind: "edge", edge: "right" } },
      () => null,
    );
    layout = applyPanelPlacement(
      layout,
      ["p"],
      { ...EMPTY, position: { kind: "split", anchor_uuid: "anchor", side: "below" } },
      anchorByPane(layout),
    );
    const right = layout.docked.right as { dir: string; children: { group?: string }[] };
    expect(right.dir).toBe("column");
    expect(right.children[1].group).toBe(findPaneGroup(layout, "p"));
  });

  it("falls back to right edge (with a warning) when the split anchor is not docked", () => {
    // Anchor doesn't exist / not placed -> anchorGroupOf returns null.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = applyPanelPlacement(
        emptyLayout(),
        ["p"],
        { ...EMPTY, position: { kind: "split", anchor_uuid: "missing", side: "above" } },
        () => null,
      );
      const loc = findGroupLocation(out, findPaneGroup(out, "p")!);
      expect(loc?.kind).toBe("docked");
      expect((loc as { edge: string }).edge).toBe("right");
      // The silent-fallback footgun is surfaced.
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("missing");
    } finally {
      warn.mockRestore();
    }
  });

  it("sets region width when docked", () => {
    const out = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { ...EMPTY, position: { kind: "edge", edge: "left" }, width: 420 },
      () => null,
    );
    expect(out.regionWidth?.left).toBe(420);
  });

  it("sets window width and height when floating", () => {
    const out = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { position: { kind: "float", x: 0, y: 0 }, width: 480, height: 360 },
      () => null,
    );
    expect(out.floating[0].width).toBe(480);
    expect(out.floating[0].height).toEqual({ mode: "pinned", px: 360 });
  });

  it("ignores height on a docked panel (docked cells size to weights)", () => {
    // set_height is floating-only; on a docked panel it must be a no-op.
    const out = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { ...EMPTY, position: { kind: "edge", edge: "right" }, height: 400 },
      () => null,
    );
    const gid = findPaneGroup(out, "p")!;
    const loc = findGroupLocation(out, gid);
    expect(loc?.kind).toBe("docked");
    // No floating window was created, and nothing carries the 400px height.
    expect(out.floating).toHaveLength(0);
  });

  it("starts the group collapsed when expandByDefault is false (one-shot)", () => {
    const out = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { ...EMPTY, position: { kind: "edge", edge: "right" } },
      () => null,
      { expandByDefault: false },
    );
    const gid = findPaneGroup(out, "p")!;
    expect(out.groups[gid].collapsed).toBe(true);
  });

  it("expandByDefault is a one-shot create hint -- not re-applied on reuse", () => {
    // Create collapsed, then a later apply (user expanded it in between) must
    // NOT re-collapse it: the hint only applies when the group is first created.
    let layout = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { ...EMPTY, position: { kind: "edge", edge: "right" } },
      () => null,
      { expandByDefault: false },
    );
    const gid = findPaneGroup(layout, "p")!;
    expect(layout.groups[gid].collapsed).toBe(true);
    // Simulate the user expanding it.
    layout.groups[gid].collapsed = false;
    // A subsequent placement apply with expandByDefault:false again...
    layout = applyPanelPlacement(
      layout,
      ["p"],
      { ...EMPTY, position: { kind: "edge", edge: "left" } },
      () => null,
      { expandByDefault: false },
    );
    // ...must leave the user's expanded state alone (one-shot, not re-asserted).
    expect(layout.groups[findPaneGroup(layout, "p")!].collapsed).toBe(false);
  });

  it("repositions an already-placed panel (float -> dock right)", () => {
    let layout = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { ...EMPTY, position: { kind: "float", x: 10, y: 10 } },
      () => null,
    );
    expect(layout.floating).toHaveLength(1);
    layout = applyPanelPlacement(
      layout,
      ["p"],
      { ...EMPTY, position: { kind: "edge", edge: "right" } },
      () => null,
    );
    // No longer floating; now docked.
    expect(layout.floating).toHaveLength(0);
    const loc = findGroupLocation(layout, findPaneGroup(layout, "p")!);
    expect(loc?.kind).toBe("docked");
  });

  it("is a no-op for an empty pane list", () => {
    const input = emptyLayout();
    const out = applyPanelPlacement(input, [], EMPTY, () => null);
    expect(out).toBe(input);
  });

  it("regathers panes the user scattered into separate windows (order + activeId)", () => {
    // Panel [a,b] docked, then the user tears each pane into its own floating
    // window; a later placement command must re-assemble them into one group.
    // Exercises ensurePanelGroup's one-by-one movePaneInPlace gather loop.
    let layout = applyPanelPlacement(
      emptyLayout(),
      ["a", "b"],
      { ...EMPTY, position: { kind: "edge", edge: "right" } },
      () => null,
    );
    const gid = findPaneGroup(layout, "a")!;
    // Tear b out, then a (a now floats wholesale as its group's only pane).
    layout = tearOutPane(layout, gid, "b", 100, 100, 240).layout;
    layout = tearOutPane(layout, findPaneGroup(layout, "a")!, "a", 200, 200, 240)
      .layout;
    expect(findPaneGroup(layout, "a")).not.toBe(findPaneGroup(layout, "b"));
    // Re-place: both panes regather into one docked group, in server order.
    layout = applyPanelPlacement(
      layout,
      ["a", "b"],
      { ...EMPTY, position: { kind: "edge", edge: "right" } },
      () => null,
    );
    const finalGid = findPaneGroup(layout, "a")!;
    expect(findPaneGroup(layout, "b")).toBe(finalGid);
    expect(layout.groups[finalGid].paneIds.sort()).toEqual(["a", "b"]);
    // activeId stays valid (a member of the regathered group).
    expect(layout.groups[finalGid].paneIds).toContain(
      layout.groups[finalGid].activeId,
    );
    expect(findGroupLocation(layout, finalGid)?.kind).toBe("docked");
    // No leftover empty groups / orphaned windows from the torn-out panes.
    expect(layout.floating).toHaveLength(0);
  });

  it("re-creates + re-places the group after a FULL pane swap (zero overlap)", () => {
    // Server replaces ALL tab containers at once (e.g. remove every tab, add new
    // ones). The old group can't be found by the new panes; re-applying placement
    // must re-create the group and place it (not orphan the panel). This backs the
    // ControlPanelDock membership effect's orphan-recovery fallback.
    let layout = applyPanelPlacement(
      emptyLayout(),
      ["a", "b"],
      { ...EMPTY, position: { kind: "edge", edge: "right" } },
      () => null,
    );
    expect(findPaneGroup(layout, "a")).not.toBeNull();
    layout = applyPanelPlacement(
      layout,
      ["c", "d"], // entirely new panes
      { ...EMPTY, position: { kind: "edge", edge: "right" } },
      () => null,
    );
    const gid = findPaneGroup(layout, "c");
    expect(gid).not.toBeNull();
    expect(layout.groups[gid!].paneIds).toEqual(["c", "d"]);
    expect(findGroupLocation(layout, gid!)?.kind).toBe("docked");
    // The new panes form their OWN group, not co-located with the stale old one
    // (the old group is torn down separately by the dock registry reconciliation
    // when the server drops those tab containers).
    expect(findPaneGroup(layout, "a")).not.toBe(gid);
  });

  it("floats an unplaced panel at the default when no position is given", () => {
    // A bare add_panel() with no placement verb: the empty placement should
    // still make the panel visible (floated) rather than an orphaned group.
    const out = applyPanelPlacement(emptyLayout(), ["p"], EMPTY, () => null);
    const gid = findPaneGroup(out, "p");
    expect(gid).not.toBeNull();
    expect(findGroupLocation(out, gid!)?.kind).toBe("floating");
  });

  it("does NOT auto-float an unplaced panel when floatIfUnplaced=false", () => {
    // The control panel path: a no-position placement must not place it (it's
    // floated separately).
    const out = applyPanelPlacement(emptyLayout(), ["p"], EMPTY, () => null, {
      floatIfUnplaced: false,
    });
    const gid = findPaneGroup(out, "p");
    expect(gid).not.toBeNull();
    expect(findGroupLocation(out, gid!)).toBeNull();
  });

  it("does not yank an already-placed panel on a no-position update", () => {
    // Dock right first, then send an empty placement: it must stay docked, not
    // jump to a floating default.
    let layout = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { ...EMPTY, position: { kind: "edge", edge: "right" } },
      () => null,
    );
    layout = applyPanelPlacement(layout, ["p"], EMPTY, () => null);
    expect(findGroupLocation(layout, findPaneGroup(layout, "p")!)?.kind).toBe(
      "docked",
    );
  });
});

describe("requested float coordinates", () => {
  const place = (x: number, y: number, width: number, height: number | null) =>
    applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { position: { kind: "float", x, y }, width, height },
      () => null,
      { canvasBounds: BOUNDS_1000 },
    );

  it("resizeWindow/resizeWindowHeight preserve requested coords (server sizing)", () => {
    // Server set_width/set_height go through these ops; they must NOT release the
    // anchor (only a USER gesture does, via releaseAnchor). So a
    // right-anchored panel stays anchored across a server resize.
    let layout = place(15, 15, 240, 200);
    const win = layout.floating[0];
    layout = resizeWindow(layout, win.id, 320);
    expect(layout.floating[0].anchor?.x).toBe(15);
    expect(layout.floating[0].width).toBe(320);
    layout = resizeWindowHeight(layout, win.id, 250);
    expect(layout.floating[0].anchor?.y).toBe(15);
  });

  it("releaseAnchor drops the anchor (user takes manual control)", () => {
    // The gesture layer calls this on any user resize/drag so the window stops
    // re-resolving against the canvas edges.
    let layout = place(-15, 15, 240, null);
    expect(layout.floating[0].anchor?.x).toBe(-15);
    layout = releaseAnchor(layout, layout.floating[0].id);
    expect(layout.floating[0].anchor).toBeUndefined();
    // No-op when there's nothing to release (returns same layout reference).
    const again = releaseAnchor(layout, layout.floating[0].id);
    expect(again).toBe(layout);
  });

  it("clears requestedX/Y when the user drags (moveWindow)", () => {
    let layout = place(-15, 15, 240, null);
    const win = layout.floating[0];
    expect(win.anchor?.x).toBe(-15);
    layout = moveWindow(layout, win.id, 400, 300);
    expect(layout.floating[0].anchor).toBeUndefined();
    expect(layout.floating[0].x).toBe(400);
  });
});

describe("resolveRequestedFloatPosition", () => {
  it("resolves positive coords as gaps from left/top", () => {
    expect(
      resolveRequestedFloatPosition(40, 20, 240, 100, BOUNDS_1000),
    ).toEqual({ x: 40, y: 20 });
  });

  it("resolves negative coords as gaps from right/bottom", () => {
    // x:-15 -> right edge 15px from the 1000px right boundary -> x=1000-240-15.
    // y:-15 -> bottom edge 15px from 800 -> y=800-100-15.
    expect(
      resolveRequestedFloatPosition(-15, -15, 240, 100, BOUNDS_1000),
    ).toEqual({ x: 745, y: 685 });
  });

  it("accounts for docked insets on a positive x", () => {
    expect(
      resolveRequestedFloatPosition(40, 20, 240, 100, {
        width: 1000,
        height: 800,
        leftInset: 300,
        rightInset: 0,
      }),
    ).toEqual({ x: 340, y: 20 });
  });

  it("falls back to near edge for negative coords when canvas is UNMEASURED", () => {
    // width/height 0 (first apply before layout): a negative coord can't resolve
    // against a missing far edge, so fall back to left/top (NOT off-screen).
    const r = resolveRequestedFloatPosition(-15, -15, 240, 100, {
      width: 0,
      height: 0,
      leftInset: 0,
      rightInset: 0,
    });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it("clamps a window wider than the canvas to the near edge", () => {
    const r = resolveRequestedFloatPosition(-15, 15, 2000, 100, BOUNDS_1000);
    expect(r.x).toBe(0); // pinned to canvas left rather than off-screen
  });
});

describe("removing a panel removes its tabs even when borrowed elsewhere", () => {
  it("removePane drops a tab from whatever group it was dragged into", () => {
    // Panel A (a1, a2) docked right; panel B (b1) floated.
    let layout = applyPanelPlacement(
      emptyLayout(),
      ["a1", "a2"],
      { position: { kind: "edge", edge: "right" }, width: null, height: null },
      () => null,
      { canvasBounds: BOUNDS_1000 },
    );
    layout = applyPanelPlacement(
      layout,
      ["b1"],
      { position: { kind: "float", x: 40, y: 40 }, width: 240, height: null },
      () => null,
      { canvasBounds: BOUNDS_1000 },
    );
    // User "borrows" a2 by tearing it out into its own floating window (the
    // relocated end-state we care about).
    const a2Group = findPaneGroup(layout, "a2")!;
    const torn = tearOutPane(layout, a2Group, "a2", 0, 0, 240);
    layout = torn.layout;
    // a2 is now in its own window, NOT in A's docked group.
    const aGroup = findPaneGroup(layout, "a1")!;
    expect(layout.groups[aGroup].paneIds).toEqual(["a1"]);
    expect(findPaneGroup(layout, "a2")).not.toBe(aGroup);

    // Now the server removes panel A -> removePane for BOTH a1 and a2, wherever
    // they live. a2 is in a different window now; it must still be removed.
    layout = removePane(layout, "a1");
    layout = removePane(layout, "a2");
    expect(findPaneGroup(layout, "a1")).toBeNull();
    expect(findPaneGroup(layout, "a2")).toBeNull();
    // B is untouched.
    expect(findPaneGroup(layout, "b1")).not.toBeNull();
  });

  it("removePane on a multi-tab borrower leaves the borrower's own tabs intact", () => {
    // A's tab a2 snapped into B's group [b1] -> B group = [b1, a2]. Removing a2
    // (because A was removed) must leave b1.
    let layout = applyPanelPlacement(
      emptyLayout(),
      ["b1"],
      { position: { kind: "float", x: 40, y: 40 }, width: 240, height: null },
      () => null,
      { canvasBounds: BOUNDS_1000 },
    );
    // Put a2 into B's group directly (simulate the borrow end-state).
    const bGroup = findPaneGroup(layout, "b1")!;
    layout = {
      ...layout,
      groups: {
        ...layout.groups,
        [bGroup]: {
          ...layout.groups[bGroup],
          paneIds: [...layout.groups[bGroup].paneIds, "a2"],
        },
      },
    };
    expect(layout.groups[bGroup].paneIds).toEqual(["b1", "a2"]);
    layout = removePane(layout, "a2");
    // a2 gone, b1 stays, group survives.
    expect(layout.groups[bGroup].paneIds).toEqual(["b1"]);
    expect(findPaneGroup(layout, "b1")).toBe(bGroup);
  });
});

describe("resizeWindowHeight pin / un-pin (auto-height)", () => {
  const floatWin = () =>
    applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { position: { kind: "float", x: 40, y: 40 }, width: 240, height: null },
      () => null,
      { canvasBounds: BOUNDS_1000 },
    );

  it("a freshly floated window is auto-height (no height pinned)", () => {
    expect(floatWin().floating[0].height).toEqual({ mode: "auto" });
  });

  it("pins an explicit height", () => {
    const base = floatWin();
    const layout = resizeWindowHeight(base, base.floating[0].id, 320);
    expect(layout.floating[0].height).toEqual({ mode: "pinned", px: 320 });
  });

  it("reverts to auto-height when height is set to undefined", () => {
    let layout = floatWin();
    const id = layout.floating[0].id;
    layout = resizeWindowHeight(layout, id, 320);
    expect(layout.floating[0].height).toEqual({ mode: "pinned", px: 320 });
    // Drag back down to content -> un-pin.
    layout = resizeWindowHeight(layout, id, undefined);
    expect(layout.floating[0].height).toEqual({ mode: "auto" });
  });
});

describe("placement re-gathers tabs dragged out of the panel", () => {
  it("a placement command pulls a torn-out tab back, with no duplicate", () => {
    // Panel [a, b] docked right. User tears tab b out to its own float.
    let layout = applyPanelPlacement(
      emptyLayout(),
      ["a", "b"],
      { position: { kind: "edge", edge: "right" }, width: null, height: null },
      () => null,
      { canvasBounds: BOUNDS_1000 },
    );
    const homeGroup = findPaneGroup(layout, "a")!;
    layout = tearOutPane(layout, homeGroup, "b", 40, 40, 240).layout;
    // b is now in a DIFFERENT group from a.
    expect(findPaneGroup(layout, "b")).not.toBe(findPaneGroup(layout, "a"));
    const groupsWithB = Object.values(layout.groups).filter((g) =>
      g.paneIds.includes("b"),
    ).length;
    expect(groupsWithB).toBe(1);

    // Server re-places the panel -> both tabs re-assembled into ONE group, b's
    // torn-out window collapsed, no duplicate.
    layout = applyPanelPlacement(
      layout,
      ["a", "b"],
      { position: { kind: "float", x: 100, y: 100 }, width: 260, height: null },
      () => null,
      { canvasBounds: BOUNDS_1000 },
    );
    const gA = findPaneGroup(layout, "a");
    const gB = findPaneGroup(layout, "b");
    expect(gA).toBe(gB); // same group
    expect(layout.groups[gA!].paneIds.sort()).toEqual(["a", "b"]);
    // b appears in exactly one group (no duplicate left in the torn-out window).
    expect(
      Object.values(layout.groups).filter((g) => g.paneIds.includes("b")).length,
    ).toBe(1);
    // The panel is floating; exactly one floating window holds the group.
    expect(findGroupLocation(layout, gA!)?.kind).toBe("floating");
    expect(
      layout.floating.filter((w) => w.stack.includes(gA!)).length,
    ).toBe(1);
  });
});

describe("re-placing an already-floating panel reuses its window", () => {
  const BOUNDS = { width: 1000, height: 800, leftInset: 0, rightInset: 0 };
  const floatP = (l: DockLayout, height: number | null) =>
    applyPanelPlacement(
      l,
      ["p"],
      { position: { kind: "float", x: 80, y: 80 }, width: 240, height },
      () => null,
      { canvasBounds: BOUNDS },
    );

  it("set_height keeps the SAME window id (no churn) and pins the height", () => {
    let layout = floatP(emptyLayout(), null);
    expect(layout.floating).toHaveLength(1);
    const id = layout.floating[0].id;
    expect(pinnedPxOf(layout.floating[0].height)).toBeUndefined();

    // set_height(450): same position+width, now a height.
    layout = floatP(layout, 450);
    expect(layout.floating).toHaveLength(1);
    expect(layout.floating[0].id).toBe(id); // window reused, not recreated
    expect(pinnedPxOf(layout.floating[0].height)).toBe(450);
    expect(layout.floating[0].x).toBe(80);
  });

  it("a size-only re-placement does NOT move a user-dragged panel", () => {
    let layout = floatP(emptyLayout(), null);
    const id = layout.floating[0].id;
    // User drags it elsewhere (moveWindow clears the anchor -> user-owned).
    layout = moveWindow(layout, id, 500, 400);
    expect(layout.floating[0].anchor).toBeUndefined();
    expect(layout.floating[0].x).toBe(500);

    // Server set_height re-runs placement (position still float 80,80). The
    // user's position must be preserved, not yanked back to the anchor.
    layout = floatP(layout, 450);
    expect(layout.floating[0].id).toBe(id);
    expect(pinnedPxOf(layout.floating[0].height)).toBe(450);
    expect(layout.floating[0].x).toBe(500);
    expect(layout.floating[0].y).toBe(400);
  });
});
