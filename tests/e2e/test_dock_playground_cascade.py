"""E2E coverage for the cascading ("push") divider resize in SplitView.

Dragging a divider grows the pane on the drag side and shrinks the panes on the
OTHER side in order: when the immediate neighbor bottoms out at its min, the next
sibling gives space (the boundary pushes through). Total is conserved (region
size unchanged) and it cascades backward on reverse drag. This module pins the
vertical (column) gesture wiring end to end; the cascade math itself (including
the horizontal/row axis, which shares the same SplitView code path) is
unit-pinned in layoutOps.regression.test.ts.

To build a FLAT 3-way split (so panels 2 and 3 are siblings in one split node --
required for a real cascade), we dock one panel to the right edge, then drop each
next panel on the outermost leaf's bottom split band; normalizeTree flattens the
same-axis nesting into a single flat split. The drops aim 40px above the leaf's
bottom edge to stay inside the split band (SPLIT_BAND_V_MAX_PX = 70 in
hitTest.ts); dropping deeper than that center-merges instead of splitting.
"""

from __future__ import annotations

from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import MIN_CELL_HEIGHT_PX
from .dock_helpers import drag_group as _drag_group
from .dock_helpers import floating_group_ids as _floating_ids
from .dock_helpers import group_box as _gbox
from .dock_helpers import open_playground as _open
from .dock_helpers import right_cols as _right_cols


def _raw_drag(page: Page, start: tuple[float, float], end: tuple[float, float]) -> None:
    # Unlike dock_helpers.drag, the arming nudge tracks the drag AXIS (divider
    # grabs would slip off the handle with a fixed diagonal nudge).
    nx = 2 if end[0] > start[0] else (-2 if end[0] < start[0] else 0)
    ny = 2 if end[1] > start[1] else (-2 if end[1] < start[1] else 0)
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(start[0] + nx, start[1] + ny, steps=2)
    page.mouse.move(*end, steps=14)
    page.mouse.move(*end)
    page.mouse.up()
    page.wait_for_timeout(120)


def _build_three_vertical(page: Page) -> list[dict]:
    """Dock 3 panels as a FLAT vertical (column) stack on the right edge. Returns
    the 3 leaf boxes top-to-bottom; asserts at each stage (the drops below form
    the structure deterministically)."""
    ids = _floating_ids(page)
    assert len(ids) >= 3, f"need 3 draggable floaters, got {len(ids)}"
    a, b, c = ids[0], ids[1], ids[2]
    vw = page.viewport_size["width"]  # type: ignore[index]
    _drag_group(page, a, (vw - 10, 400))
    ab = _gbox(page, a)
    # Drop b on a's bottom split band (within SPLIT_BAND_V_MAX_PX = 70 of the
    # bottom edge) -> column[a, b].
    _drag_group(page, b, (ab["x"] + ab["w"] / 2, ab["y"] + ab["h"] - 40))
    cols = _right_cols(page)
    assert len(cols) == 2, f"drop below a did not form a 2-way column: {cols}"
    low = cols[-1]
    lb = _gbox(page, low["g"])
    # Drop c on the lower leaf's bottom band -> flattens to column[a, b, c].
    _drag_group(page, c, (lb["x"] + lb["w"] / 2, lb["y"] + lb["h"] - 40))
    assert len(_right_cols(page)) == 3, "drop below b did not form a 3-way column"
    # The drops animate flex-grow over 200ms (SplitView's collapse/expand
    # transition); wait for the geometry to settle before measuring, or the
    # computed divider position would drift out from under the grab point.
    page.wait_for_timeout(300)
    cols = _right_cols(page)
    assert len(cols) == 3, f"3-way column did not survive settling: {cols}"
    return cols


def test_vertical_cascade_pushes_through(dock_context, vite_server: int) -> None:
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        cols = _build_three_vertical(page)

        sum0 = sum(c["h"] for c in cols)
        # Top boundary: grab the 7px divider below the first leaf at its center
        # (+3px past the leaf bottom, like the width module's divider grabs).
        cx = cols[0]["x"] + cols[0]["w"] / 2
        top_boundary_y = cols[0]["y"] + cols[0]["h"] + 3

        # Drag the 1|2 boundary DOWN by a large amount.
        _raw_drag(page, (cx, top_boundary_y), (cx, top_boundary_y + 300))
        after = _right_cols(page)
        assert len(after) == 3
        p1, p2, p3 = after

        # Panel 1 grew; panel 2 floored at its min height; panel 3 shrank to
        # absorb the remainder (the 2|3 boundary moved down too); sum conserved.
        assert p1["h"] > cols[0]["h"] + 40, (
            f"panel1 did not grow: {cols[0]['h']} -> {p1['h']}"
        )
        assert p2["h"] <= MIN_CELL_HEIGHT_PX + 12, (
            f"panel2 did not floor at min: {p2['h']}"
        )
        assert p3["h"] < cols[2]["h"] - 40, (
            f"panel3 did not shrink (push-through failed): {cols[2]['h']} -> {p3['h']}"
        )
        assert abs(sum(c["h"] for c in after) - sum0) <= 6, (
            f"total height changed: {sum0} -> {sum(c['h'] for c in after)}"
        )

        # Drag the SAME (now-lower) boundary back UP by a large amount. Panel 1
        # is topmost, so on reverse it just floors at its own min; the pane below
        # reclaims the freed space; total stays conserved. The drag delta must
        # exceed panel1's grown height minus its min for it to fully floor, so we
        # over-drag well past that.
        cur = _right_cols(page)
        cx2 = cur[0]["x"] + cur[0]["w"] / 2
        boundary2 = cur[0]["y"] + cur[0]["h"] + 3
        _raw_drag(page, (cx2, boundary2), (cx2, boundary2 - (cur[0]["h"] + 120)))
        up = _right_cols(page)
        assert len(up) == 3
        assert up[0]["h"] <= MIN_CELL_HEIGHT_PX + 12, (
            f"panel1 did not floor at min on reverse drag: {up[0]['h']}"
        )
        assert up[1]["h"] > p2["h"] + 40, "panel2 did not reclaim space on reverse drag"
        assert abs(sum(c["h"] for c in up) - sum0) <= 6, (
            "total height changed on reverse drag"
        )
    finally:
        page.close()
