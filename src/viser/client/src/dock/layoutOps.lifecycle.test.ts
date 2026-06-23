// Panel lifecycle ops: panes appear/disappear at runtime (e.g. server-driven
// GUI tabs). These tests pin the add/remove contract the sync layer relies on:
// idempotence, no duplicates, and correct collapse of whatever empties out.

import { describe, it, expect } from "vitest";
import { DockLayout, emptyLayout } from "./types";
import {
  addFloatingPane,
  addPaneToArea,
  ensureArea,
  floatColumn,
  floatGroup,
  removePane,
  setAreaTabOrder,
  tearOutPane,
} from "./layoutOps";
import { group } from "./testUtils";

function areaLayout(): DockLayout {
  const l = emptyLayout();
  l.groups["g-area"] = {
    id: "g-area",
    paneIds: ["tab1", "tab2"],
    activeId: "tab1",
  };
  l.areas = { "area-1": { id: "area-1", group: "g-area" } };
  return l;
}

describe("ensureArea", () => {
  it("creates an empty backing group for a new area", () => {
    const out = ensureArea(emptyLayout(), "area-x");
    const area = out.areas!["area-x"];
    expect(area).toBeDefined();
    expect(out.groups[area.group].paneIds).toEqual([]);
  });

  it("is a no-op (same reference) when the area already exists", () => {
    const l = areaLayout();
    expect(ensureArea(l, "area-1")).toBe(l);
  });
});

describe("addPaneToArea", () => {
  it("appends to an existing area and keeps the current active tab", () => {
    const out = addPaneToArea(areaLayout(), "area-1", "tab3");
    expect(out.groups["g-area"].paneIds).toEqual(["tab1", "tab2", "tab3"]);
    expect(out.groups["g-area"].activeId).toBe("tab1");
  });

  it("inserts at an index", () => {
    const out = addPaneToArea(areaLayout(), "area-1", "tab0", 0);
    expect(out.groups["g-area"].paneIds).toEqual(["tab0", "tab1", "tab2"]);
  });

  it("creates the area on demand and activates the first panel", () => {
    const out = addPaneToArea(emptyLayout(), "area-new", "p1");
    const gid = out.areas!["area-new"].group;
    expect(out.groups[gid].paneIds).toEqual(["p1"]);
    expect(out.groups[gid].activeId).toBe("p1");
  });

  it("is a no-op when the panel is already placed elsewhere (dragged out)", () => {
    // tab2 torn out of the area into a floating window; the server later
    // re-sends the tab list -- re-adding must not duplicate it in the area.
    const torn = tearOutPane(areaLayout(), "g-area", "tab2", 10, 10, 260).layout;
    const out = addPaneToArea(torn, "area-1", "tab2");
    expect(out).toBe(torn);
    expect(out.groups["g-area"].paneIds).toEqual(["tab1"]);
  });
});

describe("addFloatingPane", () => {
  it("creates a single-panel floating window", () => {
    const { layout: out, windowId } = addFloatingPane(
      emptyLayout(),
      "p1",
      40,
      50,
      300,
      420,
    );
    expect(windowId).not.toBeNull();
    const win = out.floating.find((w) => w.id === windowId)!;
    expect(win).toMatchObject({ x: 40, y: 50, width: 300, height: 420 });
    expect(out.groups[win.stack[0]].paneIds).toEqual(["p1"]);
  });

  it("is a no-op when the panel is already placed", () => {
    const l = areaLayout();
    const { layout: out, windowId } = addFloatingPane(l, "tab1", 0, 0, 300);
    expect(out).toBe(l);
    expect(windowId).toBeNull();
  });
});

describe("removePane", () => {
  it("removes from a multi-panel group and fixes the active tab", () => {
    const out = removePane(areaLayout(), "tab1");
    expect(out.groups["g-area"].paneIds).toEqual(["tab2"]);
    expect(out.groups["g-area"].activeId).toBe("tab2");
  });

  it("leaves an emptied AREA group in place as a drop affordance", () => {
    let l: DockLayout = areaLayout();
    l = removePane(l, "tab1");
    l = removePane(l, "tab2");
    expect(l.groups["g-area"].paneIds).toEqual([]);
    expect(l.areas!["area-1"].group).toBe("g-area");
  });

  it("collapses a floating window whose only panel is removed", () => {
    const { layout: l } = addFloatingPane(emptyLayout(), "p1", 0, 0, 300);
    const out = removePane(l, "p1");
    expect(out.floating).toEqual([]);
    expect(Object.keys(out.groups)).toEqual([]);
  });

  it("collapses a docked leaf whose only panel is removed", () => {
    const l = emptyLayout();
    l.groups["g1"] = { id: "g1", paneIds: ["p1"], activeId: "p1" };
    l.docked.left = { type: "leaf", id: "L1", group: "g1", weight: 1 };
    const out = removePane(l, "p1");
    expect(out.docked.left).toBeNull();
    expect(out.groups["g1"]).toBeUndefined();
  });

  it("removes a panel the user dragged OUT of its area (window collapses)", () => {
    // Tab torn out into its own window, then its tab is removed server-side:
    // the floating window must disappear, and the area must be untouched.
    const torn = tearOutPane(areaLayout(), "g-area", "tab2", 10, 10, 260);
    const out = removePane(torn.layout, "tab2");
    expect(out.floating).toEqual([]);
    expect(out.groups[torn.floatingGroupId]).toBeUndefined();
    expect(out.groups["g-area"].paneIds).toEqual(["tab1"]);
    expect(out.areas!["area-1"].group).toBe("g-area");
  });

  it("is a no-op (same reference) for an unplaced panel", () => {
    const l = areaLayout();
    expect(removePane(l, "nope")).toBe(l);
  });
});

describe("sync-layer round trip", () => {
  it("add tabs -> user floats one -> server removes both -> area drains clean", () => {
    let l: DockLayout = emptyLayout();
    l = addPaneToArea(l, "area-1", "t1");
    l = addPaneToArea(l, "area-1", "t2");
    const gid = l.areas!["area-1"].group;
    expect(l.groups[gid].paneIds).toEqual(["t1", "t2"]);

    // User floats t2 out of the area.
    l = tearOutPane(l, gid, "t2", 100, 100, 280).layout;
    expect(l.groups[gid].paneIds).toEqual(["t1"]);
    expect(l.floating).toHaveLength(1);

    // Server removes both tabs. The drained area group persists as a drop
    // affordance (areas are fixed fixtures; only their panes come and go).
    l = removePane(l, "t1");
    l = removePane(l, "t2");
    expect(l.floating).toEqual([]);
    expect(l.groups[gid].paneIds).toEqual([]);
    expect(l.areas!["area-1"].group).toBe(gid);
  });

  it("floatGroup on an area's backing group is a guarded no-op", () => {
    let l: DockLayout = emptyLayout();
    l = addPaneToArea(l, "area-1", "t1");
    l = addPaneToArea(l, "area-1", "t2");
    const gid = l.areas!["area-1"].group;
    // The area group is a fixed fixture: floating it would reference it from
    // a second place while it stays in its area (a duplicated group).
    const res = floatGroup(l, gid, 0, 0, 300);
    expect(res.layout).toBe(l);
    expect(res.windowId).toBeNull();
  });
});

describe("setAreaTabOrder", () => {
  it("reorders area tabs to the server order, ignoring dragged-out panes", () => {
    let l: DockLayout = emptyLayout();
    l = addPaneToArea(l, "area-1", "t1");
    l = addPaneToArea(l, "area-1", "t2");
    l = addPaneToArea(l, "area-1", "t3");
    const gid = l.areas!["area-1"].group;
    // User floats t2 out; server then reorders to [t3, t2, t1].
    l = tearOutPane(l, gid, "t2", 0, 0, 260).layout;
    const out = setAreaTabOrder(l, "area-1", ["t3", "t2", "t1"]);
    expect(out.groups[gid].paneIds).toEqual(["t3", "t1"]); // t2 stays floated
    expect(setAreaTabOrder(out, "area-1", ["t3", "t2", "t1"])).toBe(out); // idempotent
  });

  it("is a no-op for an unknown area", () => {
    const l = emptyLayout();
    expect(setAreaTabOrder(l, "area-x", ["a"])).toBe(l);
  });
});

describe("floatColumn", () => {
  function colLayout(): DockLayout {
    const l = emptyLayout();
    l.groups["a"] = group("a");
    l.groups["b"] = group("b");
    l.groups["x"] = group("x");
    l.docked.left = {
      type: "split",
      id: "ROW",
      dir: "row",
      weight: 1,
      children: [
        { type: "leaf", id: "Lx", group: "x", weight: 1 },
        {
          type: "split",
          id: "COL",
          dir: "column",
          weight: 1,
          children: [
            { type: "leaf", id: "La", group: "a", weight: 2 },
            { type: "leaf", id: "Lb", group: "b", weight: 1 },
          ],
        },
      ],
    };
    return l;
  }

  it("floats the column as a stacked window, preserving order and weights", () => {
    const { layout: out, windowId } = floatColumn(
      colLayout(),
      "left",
      "COL",
      10,
      20,
      300,
      400,
    );
    expect(windowId).not.toBeNull();
    const win = out.floating.find((w) => w.id === windowId)!;
    expect(win.stack).toEqual(["a", "b"]);
    expect(win.stackWeights).toEqual({ a: 2, b: 1 });
    expect(win).toMatchObject({ x: 10, y: 20, width: 300, height: 400 });
    // The row collapsed to the surviving leaf.
    expect(out.docked.left).toMatchObject({ type: "leaf", group: "x" });
  });

  it("floating the LAST column empties the region", () => {
    const l = colLayout();
    // Remove the sibling leaf so the column is the whole region.
    l.docked.left = (l.docked.left as any).children[1];
    const { layout: out, windowId } = floatColumn(l, "left", "COL", 0, 0, 300);
    expect(windowId).not.toBeNull();
    expect(out.docked.left).toBeNull();
    expect(out.floating[0].stack).toEqual(["a", "b"]);
    expect(out.floating[0].height).toBeUndefined(); // height optional
  });

  it("preserves a collapsed group's state in the floated stack", () => {
    const l = colLayout();
    l.groups["b"].collapsed = true;
    const { layout: out } = floatColumn(l, "left", "COL", 0, 0, 300);
    expect(out.groups["b"].collapsed).toBe(true);
  });

  it("guards: unknown node, wrong edge, leaf node, impure column -> no-op", () => {
    const l = colLayout();
    expect(floatColumn(l, "left", "nope", 0, 0, 300)).toEqual({
      layout: l,
      windowId: null,
    });
    expect(floatColumn(l, "right", "COL", 0, 0, 300).windowId).toBeNull();
    expect(floatColumn(l, "left", "La", 0, 0, 300).windowId).toBeNull();
    // Impure: column containing a nested row.
    const impure = colLayout();
    (impure.docked.left as any).children[1].children[1] = {
      type: "split",
      id: "NEST",
      dir: "row",
      weight: 1,
      children: [
        { type: "leaf", id: "Lb", group: "b", weight: 1 },
        { type: "leaf", id: "Lx2", group: "x", weight: 1 },
      ],
    };
    expect(floatColumn(impure, "left", "COL", 0, 0, 300).windowId).toBeNull();
  });

  it("is pure: the input layout is untouched on success", () => {
    const l = colLayout();
    const before = structuredClone(l);
    floatColumn(l, "left", "COL", 0, 0, 300);
    expect(l).toEqual(before);
  });
});
