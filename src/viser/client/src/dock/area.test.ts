// Unit coverage for nested dockable AREAS as first-class participants in the
// dock model. An area is a flat TabGroup (in layout.groups) referenced from
// layout.areas. Unlike an ordinary group, its backing group is a fixed fixture:
// panels move in / out of it, but the group itself is never floated or removed
// (it persists empty as a drop affordance). These tests pin that contract:
//   (a) tearOutPanel on the area's group never floats the area group -- it always
//       splits the torn panel into a NEW floating group and leaves the area group
//       in place (possibly empty), still referenced by layout.areas;
//   (b) tearing one of several area panels keeps activeId valid;
//   (c) findGroupLocation reports {kind:"area"};
//   (d) mergeGroupsInto / insertTabsInto into the area group flatten a multi-group
//       set into the area's panelIds.

import { describe, it, expect } from "vitest";
import { DockLayout, GroupId, emptyLayout } from "./types";
import {
  areaForGroup,
  isAreaGroup,
  findGroupLocation,
  tearOutPanel,
  mergeGroupsInto,
  insertTabsInto,
} from "./layoutOps";

const AREA_GID = "area-grp";
const AREA_ID = "area-1";

/** A layout with one area (backed by AREA_GID, holding `panels`) plus any extra
 * plain groups passed in. The area's group lives ONLY in layout.areas + groups,
 * never docked or floating. */
function areaLayout(panels: string[], extra: Record<GroupId, string[]> = {}): DockLayout {
  const l = emptyLayout();
  l.groups[AREA_GID] = {
    id: AREA_GID,
    panelIds: [...panels],
    activeId: panels[0],
  };
  for (const [gid, ps] of Object.entries(extra)) {
    l.groups[gid] = { id: gid, panelIds: [...ps], activeId: ps[0] };
  }
  l.areas = { [AREA_ID]: { id: AREA_ID, group: AREA_GID } };
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
// (a) tearOutPanel on the area's group with a SINGLE panel does NOT float the
//     area group: a new floating group is created for the torn panel and the
//     area's group still exists (now empty) and is still referenced by
//     layout.areas.
// ===========================================================================
describe("(a) tearOutPanel on a single-panel area group", () => {
  it("never floats the area group; splits the panel into a NEW floating group", () => {
    const l = areaLayout(["layers"]);
    const out = tearOutPanel(l, AREA_GID, "layers", 100, 100, 280);

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
    expect(out.layout.groups[AREA_GID].panelIds).toEqual([]);

    // The torn panel lives in a NEW floating group, in a new floating window.
    const floated = out.layout.groups[out.floatingGroupId];
    expect(floated.panelIds).toEqual(["layers"]);
    const win = out.layout.floating.find((w) => w.id === out.windowId)!;
    expect(win.stack).toEqual([out.floatingGroupId]);

    // The area group is NOT in any floating stack (it was never floated).
    expect(
      out.layout.floating.some((w) => w.stack.includes(AREA_GID)),
    ).toBe(false);
  });
});

// ===========================================================================
// (b) Tearing one of several area panels keeps activeId valid.
// ===========================================================================
describe("(b) tearOutPanel from a multi-panel area keeps activeId valid", () => {
  it("removes the torn panel and leaves a valid activeId among the survivors", () => {
    const l = areaLayout(["props", "history", "outline"]);
    // Tear the currently-active first panel so activeId must be re-pointed.
    expect(l.groups[AREA_GID].activeId).toBe("props");
    const out = tearOutPanel(l, AREA_GID, "props", 50, 50, 260);

    const area = out.layout.groups[AREA_GID];
    expect(area.panelIds).toEqual(["history", "outline"]);
    // activeId is still a member of the surviving panelIds (and not the torn one).
    expect(area.activeId).not.toBe("props");
    expect(area.panelIds).toContain(area.activeId);

    // Torn panel floated on its own.
    expect(out.layout.groups[out.floatingGroupId].panelIds).toEqual(["props"]);
  });

  it("tearing a NON-active middle panel preserves the existing activeId", () => {
    const l = areaLayout(["props", "history", "outline"]);
    // Make "outline" active; tearing the non-active "history" should not change it.
    l.groups[AREA_GID].activeId = "outline";
    const out = tearOutPanel(l, AREA_GID, "history", 50, 50, 260);
    const area = out.layout.groups[AREA_GID];
    expect(area.panelIds).toEqual(["props", "outline"]);
    expect(area.activeId).toBe("outline");
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
//     set into the area's panelIds (a snapped stack collapses to a row of tabs).
// ===========================================================================
describe("(d) merge / insert into the area group flattens to tabs", () => {
  it("mergeGroupsInto appends every source panel into the area's tabs", () => {
    const l = areaLayout(["layers"], {
      g1: ["controls"],
      g2: ["inspector", "console"],
    });
    const out = mergeGroupsInto(l, AREA_GID, ["g1", "g2"]);
    // All source panels flattened into the area's panelIds, in order, appended.
    expect(out.groups[AREA_GID].panelIds).toEqual([
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

  it("insertTabsInto places the flattened panels at the given index", () => {
    const l = areaLayout(["a", "b"], { g1: ["x", "y"] });
    const out = insertTabsInto(l, AREA_GID, ["g1"], 1);
    // Inserted between a and b.
    expect(out.groups[AREA_GID].panelIds).toEqual(["a", "x", "y", "b"]);
    expect(out.groups["g1"]).toBeUndefined();
  });

  it("merging into an EMPTY area group fills it from the sources", () => {
    // Start the area empty (as it would be after tearing out its last panel),
    // then merge a stack in -- it collapses into the area's tabs.
    const l = areaLayout([], { g1: ["x"], g2: ["y", "z"] });
    // Empty-area activeId is a stale string; that's fine (render guards on
    // panelIds.length), but the merge should still flatten correctly.
    const out = mergeGroupsInto(l, AREA_GID, ["g1", "g2"]);
    expect(out.groups[AREA_GID].panelIds).toEqual(["x", "y", "z"]);
    expect(out.groups[AREA_GID].activeId).toBe("y"); // last source's active
  });
});
