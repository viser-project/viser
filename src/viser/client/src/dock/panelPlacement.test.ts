// Tests for applyPanelPlacement: the server-authored placement of standalone
// panels (Python `server.gui.add_panel()`), covering edge / split / float
// placement, width/height, expand-by-default, multi-pane grouping, repositioning.

import { describe, expect, it, vi } from "vitest";
import {
  applyPanelPlacement,
  findGroupLocation,
  findPaneGroup,
  PanelPlacement,
} from "./layoutOps";
import { emptyLayout, DockLayout } from "./types";

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
    expect(win.height).toBe(250);
  });

  it("offsets a float's x by the canvas left inset (canvas-relative coords)", () => {
    // float(x=40) with a 300px left-docked region should land at 340 (clear of
    // the dock), not 40 (under it). y is unaffected (no top dock).
    const out = applyPanelPlacement(
      emptyLayout(),
      ["p"],
      { position: { kind: "float", x: 40, y: 20 }, width: null, height: null },
      () => null,
      { canvasLeftPx: 300 },
    );
    expect(out.floating[0].x).toBe(340);
    expect(out.floating[0].y).toBe(20);
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
    expect(out.floating[0].height).toBe(360);
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
