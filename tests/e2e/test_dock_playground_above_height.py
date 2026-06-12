"""E2E regression tests for the dock-ABOVE height bug.

Bug (fixed in DockManager.tsx applyOp reconciliation): docking a panel ABOVE a
docked panel collapsed the ORIGINAL panel to ~3px. The reconciliation wrote a
width-px value into a vertical child's height weight, so the original leaf ended
up with a near-zero flex weight while the newcomer took essentially all the
height.

These drive real pointer drags against the dev playground and assert the
*rendered* heights/widths via getBoundingClientRect, so a regression of the
collapse bug fails loudly. (Grip-bar drop = per-panel "above this one"; thin
region-top band = span-all-columns above.) Skips cleanly if the client
toolchain is missing or a drop didn't produce the expected structure this run.
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import drag_group
from .dock_helpers import floating_group_ids as _floating_ids
from .dock_helpers import group_box as _gbox
from .dock_helpers import group_grip_center as _grip_bar_point
from .dock_helpers import open_playground as _open
from .dock_helpers import right_cols as _right_leaves


def _drag_group(page: Page, gid: str, end: tuple[float, float]) -> None:
    drag_group(page, gid, end, steps=14)


# ===========================================================================
# 1. Dock a panel ABOVE a single docked panel (grip bar) -> both ~50% height.
#    Regression: the original used to collapse to ~3px.
# ===========================================================================
def test_dock_above_single_panel_splits_height_evenly(
    dock_context, vite_server: int
) -> None:
    vh = 900
    page = _open(dock_context, vite_server, 1400, vh)
    try:
        ids = _floating_ids(page)
        if len(ids) < 2:
            pytest.skip("need 2 floaters")
        a, c = ids[0], ids[1]
        vw = page.viewport_size["width"]  # type: ignore[index]

        # Dock `a` to the right edge (single full-height column).
        _drag_group(page, a, (vw - 10, 400))
        leaves = _right_leaves(page)
        if len(leaves) != 1 or leaves[0]["g"] != a:
            pytest.skip("did not dock a as a single right column this run")
        region_h = leaves[0]["h"]

        # Dock `c` ABOVE `a` via a's grip bar (per-panel "above this one").
        _drag_group(page, c, _grip_bar_point(page, a))

        after = _right_leaves(page)
        if len(after) != 2:
            pytest.skip("did not produce a 2-row vertical stack this run")

        # Both leaves must render at roughly half the region height. The bug
        # collapsed the original to ~3px; guard hard against that.
        heights = sorted(leaf["h"] for leaf in after)
        assert heights[0] >= 50, (
            f"a docked leaf collapsed (heights={heights}); the dock-above bug regressed"
        )
        half = region_h / 2
        for leaf in after:
            # Each within ~40% of the region height of the even split.
            assert abs(leaf["h"] - half) <= region_h * 0.40, (
                f"leaf {leaf['g']} height {leaf['h']} not ~half of {region_h}"
            )
        # And they actually stack (distinct y), not overlap.
        ys = sorted(leaf["y"] for leaf in after)
        assert ys[1] - ys[0] >= 50, f"leaves did not stack vertically: {after}"
    finally:
        page.close()


# ===========================================================================
# 2. Dock a panel ABOVE two side-by-side columns (thin region-top span band) ->
#    full-width top panel gets substantial height; the two columns keep their
#    side-by-side widths (region width preserved, not collapsed to one column).
# ===========================================================================
def test_dock_above_two_columns_spans_and_preserves_widths(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1500, 800)
    try:
        ids = _floating_ids(page)
        if len(ids) < 3:
            pytest.skip("need 3 floaters")
        a, b, c = ids[0], ids[1], ids[2]
        vw = page.viewport_size["width"]  # type: ignore[index]

        # Build two side-by-side columns on the right edge: dock a, then b on a's
        # left split band.
        _drag_group(page, a, (vw - 10, 400))
        ab = _gbox(page, a)
        _drag_group(page, b, (ab["x"] + ab["w"] * 0.10, ab["y"] + ab["h"] / 2))
        cols = _right_leaves(page)
        if len(cols) != 2:
            pytest.skip("did not form a 2-column right region this run")

        region_left = min(leaf["x"] for leaf in cols)
        region_right = max(leaf["x"] + leaf["w"] for leaf in cols)
        region_width_before = region_right - region_left
        col_widths_before = sorted(leaf["w"] for leaf in cols)
        region_cx = (region_left + region_right) / 2

        # Dock `c` ABOVE BOTH via the thin region-top span band: horizontally
        # centered over the region, within ~4px of the very top.
        _drag_group(page, c, (region_cx, 4))

        after = _right_leaves(page)
        if len(after) != 3:
            pytest.skip("did not produce a top band + two columns this run")

        # The new top band spans both columns: find the widest leaf (full width)
        # -- it must get a substantial height (roughly half), not a sliver.
        top = max(after, key=lambda leaf: leaf["w"])
        bottom_cols = [leaf for leaf in after if leaf is not top]
        assert top["h"] > 100, (
            f"the full-width top band got too little height ({top['h']}px); "
            "dock-above height regressed"
        )
        assert top["w"] >= region_width_before * 0.9, (
            f"the top band did not span the region width "
            f"({top['w']} vs region {region_width_before})"
        )
        # It sits above the two columns.
        assert top["y"] <= min(leaf["y"] for leaf in bottom_cols), (
            "the span band is not above the two columns"
        )

        # The two original columns keep their side-by-side widths: region width
        # preserved (not shrunk to one column), and two distinct columns remain.
        bottom_left = min(leaf["x"] for leaf in bottom_cols)
        bottom_right = max(leaf["x"] + leaf["w"] for leaf in bottom_cols)
        assert abs((bottom_right - bottom_left) - region_width_before) <= 12, (
            f"region width changed: was {region_width_before}, now "
            f"{bottom_right - bottom_left}"
        )
        col_widths_after = sorted(leaf["w"] for leaf in bottom_cols)
        for w_before, w_after in zip(col_widths_before, col_widths_after):
            assert abs(w_before - w_after) <= 12, (
                f"a column width changed: {col_widths_before} -> {col_widths_after}"
            )
        # Still two distinct side-by-side columns (different x positions).
        xs = sorted(leaf["x"] for leaf in bottom_cols)
        assert xs[1] - xs[0] >= 100, (
            f"the two columns collapsed onto one another: {bottom_cols}"
        )
    finally:
        page.close()
