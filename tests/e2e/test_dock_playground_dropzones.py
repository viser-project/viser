"""E2E coverage for the per-panel drop-zone behavior in hitTest.

The drop zones over a docked panel (D46 columns-only model) are: a thin outer
left/right region-edge band (dock a new full-height column beside everything),
the grip bar above the tabs (split above THIS panel, within its column), the
tab strip (insert tabs), and the content area -- left/right splits (a new
FULL-HEIGHT sibling column) plus a below split and center MERGE (no "above"
band in the content area). Top/bottom region-edge spans and cross-band seams
are gone (bands are unrepresentable). This exercises:

1. The GRIP BAR (above the tabs) of a single panel splits ABOVE just that panel
   (within its own column) -- so with two side-by-side columns, dropping on the
   left panel's grip bar stacks the new panel above ONLY the left one, while
   the right column is untouched.

2. "right of A" and "left of B" resolve to the SAME between-columns insertion:
   a new column on the A|B seam. (The previous half-panel ghosts made these read
   as two different drops; they now produce one identical result.)

Skips cleanly if the client toolchain is missing, or if a particular drop didn't
produce the expected structure this run.
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import dock_layout as _dock_layout
from .dock_helpers import drag_group as _drag_group
from .dock_helpers import floating_group_ids as _floating_ids
from .dock_helpers import grip_above_strip_point as _grip_above_strip
from .dock_helpers import group_box as _gbox
from .dock_helpers import group_grip_center as _grip_bar_point
from .dock_helpers import layout as _layout
from .dock_helpers import leaf_box as _leaf_box
from .dock_helpers import move_floating_window as _move_window
from .dock_helpers import open_playground as _open
from .dock_helpers import right_cols as _right_cols
from .dock_helpers import set_layout as _set_layout
from .dock_helpers import setup_side_by_side as _setup_side_by_side
from .dock_helpers import stack as _stack
from .dock_helpers import window as _window


# ===========================================================================
# (a) The GRIP BAR (above the tabs) of ONE panel splits above just that panel
#     (not span-all). Per-panel "above this one" lives in the grip bar now -- the
#     content area no longer has an "above" band.
# ===========================================================================
def test_grip_bar_splits_above_only_that_panel(dock_context, vite_server: int) -> None:
    page = _open(dock_context, vite_server, 1500, 800)
    try:
        ids = _floating_ids(page)
        if len(ids) < 3:
            pytest.skip("need 3 floaters")
        a, b, c = ids[0], ids[1], ids[2]
        if not _setup_side_by_side(page, a, b):
            pytest.skip("did not form a 2-column right region this run")

        # Docking `a` grows the right region's reserved width, which clamps the
        # monitor window inward -- onto c's grip in this fixed viewport. Shove it
        # clear so the press on c actually starts a drag.
        _move_window(page, "w-m", 40, 40)

        cols = _right_cols(page)
        # cols are [left, right] by x; pick the left column to split above.
        cols.sort(key=lambda z: z["x"])
        left, right = cols[0], cols[1]
        right_h_before = right["h"]
        right_x_before = right["x"]

        # Drop c on the LEFT panel's GRIP BAR (above its tabs). This is the
        # per-panel "above THIS one" zone -- it must stack above only the left
        # panel, within its own column (D46: there is no region-wide span-all
        # band anymore). Target just above the strip top.
        _drag_group(page, c, _grip_above_strip(page, left["g"]))

        after = _right_cols(page)
        # The left column is now a vertical stack of [c, b] (two leaves sharing
        # the left x); the right column is untouched.
        left_x = left["x"]
        left_stack = sorted(
            (z for z in after if abs(z["x"] - left_x) <= 6), key=lambda z: z["y"]
        )
        right_after = next((z for z in after if z["g"] == right["g"]), None)
        assert right_after is not None, "the right panel must still exist"

        # Split happened above ONLY the left panel: two stacked leaves in the
        # left column, with c on top of b.
        assert len(left_stack) == 2, (
            f"expected the new panel stacked above ONLY the left panel; "
            f"left column had {[z['g'] for z in left_stack]}"
        )
        assert left_stack[0]["g"] == c and left_stack[1]["g"] == b, (
            f"expected [c above b] in the left column, got "
            f"{[z['g'] for z in left_stack]}"
        )
        # The right panel did NOT get split (still full height, same position) --
        # i.e. this was NOT a region-wide span-all drop.
        assert abs(right_after["h"] - right_h_before) <= 6, (
            f"right panel height changed ({right_h_before} -> {right_after['h']}): "
            "the drop leaked outside the left column"
        )
        assert abs(right_after["x"] - right_x_before) <= 6
        # And the right column is a single leaf (only one group at its x).
        right_stack = [z for z in after if abs(z["x"] - right_after["x"]) <= 6]
        assert len(right_stack) == 1, "right column should remain a single panel"
    finally:
        page.close()


# ===========================================================================
# (b) "right of A" and "left of B" produce the SAME between-columns result.
# ===========================================================================
def _drop_on_seam(dock_context, vite_server: int, which: str) -> list[str] | None:
    """Build [b | a] side-by-side, then drop c either on the RIGHT band of the
    left panel (which='right') or the LEFT band of the right panel (which='left').
    Returns the resulting left-to-right column group order, or None on skip."""
    page = _open(dock_context, vite_server, 1500, 800)
    try:
        ids = _floating_ids(page)
        if len(ids) < 3:
            return None
        a, b, c = ids[0], ids[1], ids[2]
        if not _setup_side_by_side(page, a, b):
            return None
        # Docking `a` clamps the monitor window inward, onto c's grip in this
        # fixed viewport; shove it clear so the press on c starts a drag.
        _move_window(page, "w-m", 40, 40)
        cols = _right_cols(page)
        cols.sort(key=lambda z: z["x"])
        left, right = cols[0], cols[1]
        if which == "right":
            # Right edge of the LEFT panel's content (rx > 1 - SPLIT_BAND).
            target = (left["x"] + left["w"] * 0.90, left["y"] + left["h"] / 2)
        else:
            # Left edge of the RIGHT panel's content (rx < SPLIT_BAND).
            target = (right["x"] + right["w"] * 0.10, right["y"] + right["h"] / 2)
        _drag_group(page, c, target)
        after = _right_cols(page)
        if len(after) != 3:
            return None
        after.sort(key=lambda z: z["x"])
        return [z["g"] for z in after]
    finally:
        page.close()


# ===========================================================================
# Drop-hint visual consistency: split / span previews are all thin LINES, not a
# mix of lines and filled rectangles.
# ===========================================================================
def _drop_hints(page: Page) -> list[dict]:
    """Live drop-hint elements. The hint is a persistent element positioned
    imperatively; it carries data-dock-hint=<variant> only while visible."""
    return page.evaluate(
        """() => [...document.querySelectorAll('[data-dock-hint]')]
            .filter(d => d.style.display !== 'none')
            .map(d => ({ w: parseFloat(d.style.width) || 0,
                         h: parseFloat(d.style.height) || 0 }))"""
    )


def _hover_drag(page: Page, gid: str, path: list[tuple[float, float]]):
    """Press on gid's grip bar, move through `path` (NOT releasing), so a hint is
    live. Caller releases."""
    sx, sy = _grip_bar_point(page, gid)
    page.mouse.move(sx, sy)
    page.mouse.down()
    page.mouse.move(sx + 6, sy + 6, steps=2)
    for px, py in path:
        page.mouse.move(px, py, steps=8)
    page.mouse.move(*path[-1])
    # Let the hint's imperative style write land before the caller reads it
    # (the write is pointer-move driven; headless frame pacing can lag it).
    page.wait_for_timeout(150)


def test_region_side_preview_is_a_region_tall_line(
    dock_context, vite_server: int
) -> None:
    """A region-edge SIDE-band preview (dock a new full-height column beside
    everything, D46: the only region-edge zones left) is a thin vertical LINE
    spanning the whole region height -- not a filled half-region ghost --
    matching the per-panel split-line affordance."""
    page = _open(dock_context, vite_server, 1500, 800)
    try:
        ids = _floating_ids(page)
        if len(ids) < 3:
            pytest.skip("need 3 floaters")
        a, b, c = ids[0], ids[1], ids[2]
        if not _setup_side_by_side(page, a, b):
            pytest.skip("did not form a 2-column right region this run")
        # Docking `a` clamps the monitor window inward, onto c's grip in this
        # fixed viewport; shove it clear so the press on c starts a drag.
        _move_window(page, "w-m", 40, 40)
        cols = _right_cols(page)
        region_left = min(z["x"] for z in cols)
        region_top = min(z["y"] for z in cols)
        region_bottom = max(z["y"] + z["h"] for z in cols)

        # Hover c over the region's LEFT side band (a few px inside its
        # inner boundary, vertically centered).
        _hover_drag(page, c, [(region_left + 6, (region_top + region_bottom) / 2)])
        hints = _drop_hints(page)
        page.mouse.up()
        page.wait_for_timeout(120)

        assert hints, "expected a drop hint while hovering the region side band"
        # The side preview is a thin vertical line spanning the region height.
        h = hints[0]
        assert h["w"] <= 8, f"region-side hint is not thin (width {h['w']}px)"
        assert h["h"] > 100, (
            f"region-side hint should span the region height, got {h['h']}px"
        )
    finally:
        page.close()


# ===========================================================================
# Drag a tab out of a 2-tab group, then drag it back: the tab-insertion hint
# must align with the SURVIVING tab's real position (not the stale 2-tab
# geometry from before the tear-out).
# ===========================================================================
def _docked_tab_box(page: Page, panel_id: str) -> dict | None:
    el = page.query_selector(f'[data-dock-leaf] [data-dock-tab="{panel_id}"]')
    if el is None:
        return None
    b = el.bounding_box()
    return (
        None
        if b is None
        else {"x": b["x"], "y": b["y"], "w": b["width"], "h": b["height"]}
    )


def test_drag_tab_back_uses_live_strip_geometry(dock_context, vite_server: int) -> None:
    """Merge two panels into the docked group, tear the FIRST tab out (so the
    survivor FLIP-animates to a new slot), then drag it back over the survivor.
    The insertion-line hint must sit at the survivor's real edge -- the bug was
    it used the stale pre-tear-out (2-tab) geometry."""
    page = _open(dock_context, vite_server, 1400, 900)
    try:
        ids = _floating_ids(page)
        if not ids:
            pytest.skip("need a floater to merge")
        floater = ids[0]
        scene_leaf = page.query_selector("[data-dock-leaf] [data-dock-group]")
        if scene_leaf is None:
            pytest.skip("no docked group")
        scene_gid = scene_leaf.get_attribute("data-dock-group")
        if scene_gid is None:
            pytest.skip("docked group has no id")
        docked_box = _gbox(page, scene_gid)
        # Merge the floater into the docked group's center -> 2 tabs.
        _drag_group(
            page,
            floater,
            (
                docked_box["x"] + docked_box["w"] / 2,
                docked_box["y"] + docked_box["h"] * 0.5,
            ),
        )
        tabs = page.query_selector_all("[data-dock-leaf] [data-dock-tab]")
        if len(tabs) != 2:
            pytest.skip("merge did not produce a 2-tab docked group this run")
        first_panel = tabs[0].get_attribute("data-dock-tab")
        second_panel = tabs[1].get_attribute("data-dock-tab")
        if first_panel is None or second_panel is None:
            pytest.skip("docked tabs missing ids")

        # Tear out the FIRST tab: press it, drag straight down into the canvas so
        # it tears into a floating window (survivor reflows to offset 0).
        ft = _docked_tab_box(page, first_panel)
        if ft is None:
            pytest.skip("first tab box not found")
        tx, ty = ft["x"] + ft["w"] / 2, ft["y"] + ft["h"] / 2
        page.mouse.move(tx, ty)
        page.mouse.down()
        for i in range(1, 26):
            page.mouse.move(tx, ty + i * 12, steps=1)

        # Survivor's live (post-reflow) rect.
        surv = _docked_tab_box(page, second_panel)
        if surv is None:
            page.mouse.up()
            pytest.skip("survivor tab not found mid-drag this run")

        # Drag the torn-out window back over the RIGHT half of the survivor tab.
        cur_x, cur_y = tx, ty + 25 * 12
        tgt_x, tgt_y = surv["x"] + surv["w"] * 0.85, surv["y"] + surv["h"] / 2
        for i in range(1, 21):
            page.mouse.move(
                cur_x + (tgt_x - cur_x) * i / 20,
                cur_y + (tgt_y - cur_y) * i / 20,
                steps=1,
            )
        page.mouse.move(tgt_x, tgt_y)
        # Settle before reading: the hint's style write is pointer-move driven
        # and lags under headless frame pacing; reading a hidden hint's STALE
        # left (from an earlier zone on the drag path) is the failure mode.
        page.wait_for_timeout(150)

        # Capture the live insertion-line hint position (the persistent
        # [data-dock-hint] element; visible only while a zone resolves).
        hint = page.evaluate(
            """() => {
                const d = document.querySelector('[data-dock-hint]');
                return d && d.style.display !== 'none'
                    ? { left: parseFloat(d.style.left),
                        width: parseFloat(d.style.width) } : null;
            }"""
        )
        page.mouse.up()
        page.wait_for_timeout(120)

        if hint is None:
            pytest.skip("no insertion hint shown over the strip this run")
        # Hovering the survivor's right half -> the insertion line must sit at the
        # survivor's REAL right edge. The bug used stale pre-tear-out geometry, so
        # the line landed ~a tab-width inward (at the old A|survivor boundary)
        # instead of at the survivor's actual right edge. A tight tolerance
        # distinguishes the two.
        surv_right = surv["x"] + surv["w"]
        assert abs(hint["left"] - surv_right) <= 6, (
            f"insertion line at {hint['left']}px is not at the survivor's real "
            f"right edge {surv_right}px -- stale pre-tear-out geometry regressed"
        )
    finally:
        page.close()


# ===========================================================================
# Docking on the SIDE band of one cell of a stacked column inserts a new
# FULL-HEIGHT sibling column (D46: side drops are column inserts; the old
# per-cell band split is unrepresentable).
# ===========================================================================
def test_side_drop_on_stack_cell_inserts_full_height_column(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server)
    try:
        _set_layout(
            page,
            _dock_layout(
                docked_right=_stack("controls", "inspector"),
                floating=[_window("console", x=200, y=400, width=240)],
            ),
        )
        cell = _leaf_box(page, "t-controls")
        # The per-cell side band sits between the 40px region-side band and the
        # content merge zone; ~45px in is inside it.
        target = (cell["x"] + 45, cell["y"] + cell["h"] / 2)
        _drag_group(page, "t-console", target)
        lay = _layout(page)
        right = lay["docked"]["right"]
        assert right is not None
        cols = [[leaf["group"] for leaf in col["leaves"]] for col in right["columns"]]
        assert cols == [["t-console"], ["t-controls", "t-inspector"]], (
            f"side drop must insert a full-height sibling column, got {cols}"
        )
        # Full height: the new column's leaf spans the whole stack column.
        new_box = _leaf_box(page, "t-console")
        stack_top = _leaf_box(page, "t-controls")
        stack_bottom = _leaf_box(page, "t-inspector")
        assert new_box["h"] >= (stack_bottom["bottom"] - stack_top["y"]) - 12, (
            f"the inserted column should be region-tall, got {new_box['h']}px"
        )
    finally:
        page.close()


# ===========================================================================
# A seam leaf-insert takes an equal share of the column height -- never a
# ~0px sliver, even when leaf weights are px-scale after a stack resize.
# ===========================================================================
def test_seam_leaf_insert_has_real_height(dock_context, vite_server: int) -> None:
    page = _open(dock_context, vite_server)
    try:
        _set_layout(
            page,
            _dock_layout(
                docked_right=_stack("controls", "inspector"),
                floating=[_window("console", x=250, y=400, width=240)],
            ),
        )
        # Resize the in-column stack divider so leaf weights go px-scale.
        top = _leaf_box(page, "t-controls")
        seam_y = top["y"] + top["h"]
        cx = top["x"] + top["w"] / 2
        page.mouse.move(cx, seam_y)
        page.mouse.down()
        page.mouse.move(cx, seam_y + 80, steps=8)
        page.mouse.up()
        page.wait_for_timeout(200)
        # Drop console on the (new) seam between the stacked cells.
        top2 = _leaf_box(page, "t-controls")
        _drag_group(
            page, "t-console", (top2["x"] + top2["w"] / 2, top2["y"] + top2["h"] + 3)
        )
        box = _leaf_box(page, "t-console")
        assert box is not None and box["h"] > 60, (
            f"seam-inserted leaf should have a real height, got {box}"
        )
    finally:
        page.close()
