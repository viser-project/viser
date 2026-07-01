// Unit coverage for nested dockable AREAS as first-class participants in the
// dock model. An area is a flat TabGroup (in layout.groups) referenced from
// layout.areas. Unlike an ordinary group, its backing group is a fixed fixture:
// panes move in / out of it, but the group itself is never floated or removed
// (it persists empty as a drop affordance). These tests pin that contract:
//   (a) tearOutPane on the area's group never floats the area group -- it always
//       splits the torn panel into a NEW floating group and leaves the area group
//       in place (possibly empty), still referenced by layout.areas;
//   (b) tearing one of several area panes keeps activeId valid;
//   (c) findGroupLocation reports {kind:"area"};
//   (d) mergeGroupsInto / insertTabsInto into the area group flatten a multi-group
//       set into the area's paneIds.

import { describe, it, expect } from "vitest";
import { DockLayout, GroupId, emptyLayout } from "./types";
import {
  areaForGroup,
  isAreaGroup,
  findGroupLocation,
  tearOutPane,
  mergeGroupsInto,
  insertTabsInto,
} from "./layoutOps";

const AREA_GID = "area-grp";
const AREA_ID = "area-1";

/** A layout with one area (backed by AREA_GID, holding `panes`) plus any extra
 * plain groups passed in. The area's group lives ONLY in layout.areas + groups,
 * never docked or floating. */
function areaLayout(panes: string[], extra: Record<GroupId, string[]> = {}): DockLayout {
  const l = emptyLayout();
  l.groups[AREA_GID] = {
    id: AREA_GID,
    paneIds: [...panes],
    activeId: panes[0],
  };
  for (const [gid, ps] of Object.entries(extra)) {
    l.groups[gid] = { id: gid, paneIds: [...ps], activeId: ps[0] };
  }
  l.areas = { [AREA_ID]: { group: AREA_GID } };
  return l;
}

// ===========================================================================
// Sanity: the area helpers identify the backing group.
// ===========================================================================
describe("area helpers", () => {
  it("areaForGroup / isAreaGroup recognize the backing group only", () => {
    const l = areaLayout(["layers"], { other: ["x"] });
    expect(areaForGroup(l, AREA_GID)).toBe(AREA_ID);
    expect(isAreaGroup(l, AREA_GID)).toBe(true);
    // A plain group is not an area.
    expect(areaForGroup(l, "other")).toBeNull();
    expect(isAreaGroup(l, "other")).toBe(false);
    // A layout with no areas at all (areas undefined) is handled gracefully.
    const bare = emptyLayout();
    delete bare.areas;
    expect(areaForGroup(bare, "anything")).toBeNull();
    expect(isAreaGroup(bare, "anything")).toBe(false);
  });
});

// ===========================================================================
// (a) tearOutPane on the area's group with a SINGLE panel does NOT float the
//     area group: a new floating group is created for the torn panel and the
//     area's group still exists (now empty) and is still referenced by
//     layout.areas.
// ===========================================================================
describe("(a) tearOutPane on a single-panel area group", () => {
  it("never floats the area group; splits the panel into a NEW floating group", () => {
    const l = areaLayout(["layers"]);
    const out = tearOutPane(l, AREA_GID, "layers", 100, 100, 280);

    // The area group must NOT itself have floated. It must be a fresh group id.
    expect(out.floatingGroupId).not.toBe(AREA_GID);

    // The area group still exists and is still referenced by layout.areas...
    expect(out.layout.groups[AREA_GID]).toBeDefined();
    expect(areaForGroup(out.layout, AREA_GID)).toBe(AREA_ID);
    expect(findGroupLocation(out.layout, AREA_GID)).toEqual({
      kind: "area",
      areaId: AREA_ID,
    });
    // ...but it is now empty (the torn panel left it).
    expect(out.layout.groups[AREA_GID].paneIds).toEqual([]);

    // The torn panel lives in a NEW floating group, in a new floating window.
    const floated = out.layout.groups[out.floatingGroupId!];
    expect(floated.paneIds).toEqual(["layers"]);
    const win = out.layout.floating.find((w) => w.id === out.windowId)!;
    expect(win.stack).toEqual([out.floatingGroupId]);

    // The area group is NOT in any floating stack (it was never floated).
    expect(
      out.layout.floating.some((w) => w.stack.includes(AREA_GID)),
    ).toBe(false);
  });
});

// ===========================================================================
// (b) Tearing one of several area panes keeps activeId valid.
// ===========================================================================
describe("(b) tearOutPane from a multi-panel area keeps activeId valid", () => {
  it("removes the torn panel and leaves a valid activeId among the survivors", () => {
    const l = areaLayout(["props", "history", "outline"]);
    // Tear the currently-active first panel so activeId must be re-pointed.
    expect(l.groups[AREA_GID].activeId).toBe("props");
    const out = tearOutPane(l, AREA_GID, "props", 50, 50, 260);

    const area = out.layout.groups[AREA_GID];
    expect(area.paneIds).toEqual(["history", "outline"]);
    // activeId is still a member of the surviving paneIds (and not the torn one).
    expect(area.activeId).not.toBe("props");
    expect(area.paneIds).toContain(area.activeId);

    // Torn panel floated on its own.
    expect(out.layout.groups[out.floatingGroupId!].paneIds).toEqual(["props"]);
  });

  it("tearing a NON-active middle panel preserves the existing activeId", () => {
    const l = areaLayout(["props", "history", "outline"]);
    // Make "outline" active; tearing the non-active "history" should not change it.
    l.groups[AREA_GID].activeId = "outline";
    const out = tearOutPane(l, AREA_GID, "history", 50, 50, 260);
    const area = out.layout.groups[AREA_GID];
    expect(area.paneIds).toEqual(["props", "outline"]);
    expect(area.activeId).toBe("outline");
  });

  // Regression (fuzz seed=50021): tearing a pane the group does NOT hold must be
  // a no-op. The area group can legitimately empty out (every pane merged/torn
  // away while it persists as a drop affordance). A tear-out targeting a pane
  // that isn't there used to CONJURE it -- the split path wrapped the (absent /
  // undefined) paneId in a fresh floating group, materializing a phantom panel
  // and breaking conservation. Now it returns the layout untouched.
  it("tearing a pane the (empty) area group doesn't hold is a no-op", () => {
    const l = areaLayout([]); // emptied area, still a registered drop target
    expect(l.groups[AREA_GID].paneIds).toEqual([]);
    // The fuzzer's pick() over an empty paneIds array yields undefined; any
    // not-present paneId behaves the same.
    const out = tearOutPane(
      l,
      AREA_GID,
      undefined as unknown as string,
      0,
      0,
      260,
    );
    expect(out.windowId).toBeNull();
    expect(out.floatingGroupId).toBeNull();
    // Layout is returned by reference, fully unchanged: no phantom group, no
    // floating window, area group still empty and still registered.
    expect(out.layout).toBe(l);
    expect(Object.keys(out.layout.groups)).toEqual([AREA_GID]);
    expect(out.layout.floating).toEqual([]);
  });

  // The same guard protects a plain (non-area) multi-panel group: tearing a
  // pane it doesn't hold must not invent one.
  it("tearing a pane a plain group doesn't hold is a no-op", () => {
    const l = areaLayout(["x"], { plain: ["p0", "p1"] });
    const out = tearOutPane(l, "plain", "nope", 0, 0, 260);
    expect(out.windowId).toBeNull();
    expect(out.floatingGroupId).toBeNull();
    expect(out.layout).toBe(l);
  });
});

// ===========================================================================
// (c) findGroupLocation returns {kind:"area"}. (The detach-is-a-no-op behavior
//     on the area group is pinned by layoutOps.test.ts (dockToEdge area guard)
//     and layoutOps.lifecycle.test.ts (floatGroup).)
// ===========================================================================
describe("(c) findGroupLocation is area-aware", () => {
  it("findGroupLocation reports the area location", () => {
    const l = areaLayout(["layers"]);
    expect(findGroupLocation(l, AREA_GID)).toEqual({
      kind: "area",
      areaId: AREA_ID,
    });
  });
});

// ===========================================================================
// (d) mergeGroupsInto / insertTabsInto into the area group flatten a multi-group
//     set into the area's paneIds (a snapped stack collapses to a row of tabs).
// ===========================================================================
describe("(d) merge / insert into the area group flattens to tabs", () => {
  it("mergeGroupsInto appends every source panel into the area's tabs", () => {
    const l = areaLayout(["layers"], {
      g1: ["controls"],
      g2: ["inspector", "console"],
    });
    const out = mergeGroupsInto(l, AREA_GID, ["g1", "g2"]);
    // All source panes flattened into the area's paneIds, in order, appended.
    expect(out.groups[AREA_GID].paneIds).toEqual([
      "layers",
      "controls",
      "inspector",
      "console",
    ]);
    // Source groups consumed.
    expect(out.groups["g1"]).toBeUndefined();
    expect(out.groups["g2"]).toBeUndefined();
    // Still an area, still in layout.areas.
    expect(areaForGroup(out, AREA_GID)).toBe(AREA_ID);
  });

  it("insertTabsInto places the flattened panes at the given index", () => {
    const l = areaLayout(["a", "b"], { g1: ["x", "y"] });
    const out = insertTabsInto(l, AREA_GID, ["g1"], 1);
    // Inserted between a and b.
    expect(out.groups[AREA_GID].paneIds).toEqual(["a", "x", "y", "b"]);
    expect(out.groups["g1"]).toBeUndefined();
  });

  it("merging into an EMPTY area group fills it from the sources", () => {
    // Start the area empty (as it would be after tearing out its last panel),
    // then merge a stack in -- it collapses into the area's tabs.
    const l = areaLayout([], { g1: ["x"], g2: ["y", "z"] });
    // Empty-area activeId is a stale string; that's fine (render guards on
    // paneIds.length), but the merge should still flatten correctly.
    const out = mergeGroupsInto(l, AREA_GID, ["g1", "g2"]);
    expect(out.groups[AREA_GID].paneIds).toEqual(["x", "y", "z"]);
    expect(out.groups[AREA_GID].activeId).toBe("y"); // last source's active
  });
});
