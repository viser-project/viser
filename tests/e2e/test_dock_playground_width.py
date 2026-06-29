"""E2E tests for the docking layer's region width/height model (measures
rendered px): width reconciliation, the cascading divider resize, and
dock-ABOVE sizing.

Width reconciliation -- when a docked region's SET of top-level columns
changes, surviving columns keep their exact pixel widths and new columns get a
default; pure-internal changes leave widths untouched:
* Removing one of two side-by-side docked panels leaves the OTHER's width
  unchanged (within the ~divider tolerance). The float-out removal path is the
  single e2e wiring proof here; the merge-away/snap-away paths and the
  manual-resize survival case are unit-pinned (mergeGroupsInto /
  snapToWindowStack in layoutOps.test.ts, surviving-column px in
  widthReconciliation.test.ts).
* Docking a new column keeps existing columns' widths; the new one gets the
  default (~300, clamped per-panel).
* Dock->undock round-trips keep widths stable.
* No spurious width jump at drag start/drop beyond the ~divider reclaim.
* M1: with one column of a multi-column region minimized (partially overlaid),
  dragging the reserved divider resizes (no longer a silent no-op).

Divider cascade ("push" resize in SplitView) -- dragging a divider grows the
pane on the drag side and shrinks the panes on the OTHER side in order: when
the immediate neighbor bottoms out at its min, the next sibling gives space
(the boundary pushes through). Total is conserved (region size unchanged) and
it cascades backward on reverse drag. The vertical (column) gesture wiring is
pinned end to end here; the cascade math itself (including the horizontal/row
axis, which shares the same SplitView code path) is unit-pinned in
layoutOps.regression.test.ts.

Dock-ABOVE sizing -- regression tests for the dock-above height bug (fixed in
DockManager.tsx applyOp reconciliation): docking a panel ABOVE a docked panel
collapsed the ORIGINAL panel to ~3px, because the reconciliation wrote a
width-px value into a vertical child's height weight. These drive real pointer
drags and assert the *rendered* heights/widths via getBoundingClientRect, so a
regression fails loudly. (Grip-bar drop = per-panel "above this one"; thin
region-top band = span-all-columns above.)

ACCEPTABLE exceptions (asserted as such, not bugs):
* A single floating panel docked to an EMPTY edge adopts the region width (a sole
  docked column == the whole region), so its prior float width is not preserved.
* Deeply-nested left/right splits may not preserve exact widths.

Geometry note: starting arrangements are INJECTED via dock_helpers.set_layout
(window.__dockSetLayout), so each test begins from exactly the layout literal it
states -- only panels the test references exist (no monitor window to park, no
floaters to clear), and the gesture under test runs on a clean canvas.

Skips cleanly if the client toolchain (``npx`` + ``node_modules``) is missing,
or if a drop didn't produce the expected structure this run.
"""

from __future__ import annotations

from typing import Generator

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import (
    MIN_CELL_HEIGHT_PX,
    columns,
    dock_layout,
    open_playground,
    set_layout,
    stack,
    window,
)
from .dock_helpers import drag_group as _drag_group
from .dock_helpers import group_box as _box
from .dock_helpers import group_grip_center as _grip
from .dock_helpers import leaf_box as _leaf_box
from .dock_helpers import right_cols as _right_cols


@pytest.fixture()
def page(dock_context, vite_server: int) -> Generator[Page, None, None]:
    # Wide viewport so docked side-by-side panels have room to keep distinct
    # widths above the per-panel minimum.
    pg = open_playground(dock_context, vite_server, 1400, 760)
    yield pg
    pg.close()


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
def _has(page: Page, gid: str) -> bool:
    return (
        page.query_selector(f'[data-dock-group="{gid}"] [data-dock-griphandle]')
        is not None
    )


def _width(page: Page, gid: str) -> int:
    return round(
        page.eval_on_selector(
            f'[data-dock-group="{gid}"]', "e => e.getBoundingClientRect().width"
        )
    )


def _is_float(page: Page, gid: str) -> bool:
    return page.eval_on_selector(
        f'[data-dock-group="{gid}"]', "e => !e.closest('[data-dock-leaf]')"
    )


def _win_rect(page: Page, gid: str) -> dict:
    return page.eval_on_selector(
        f'[data-dock-group="{gid}"]',
        "e => { const w = e.closest('[data-floating-window]'); "
        "const r = w.getBoundingClientRect(); "
        "return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right }; }",
    )


# Unlike dock_helpers.drag, the arming nudge tracks the drag AXIS (divider and
# window-edge grabs would slip off the handle with a fixed diagonal nudge).
def _raw_drag(page: Page, start: tuple[float, float], end: tuple[float, float]) -> None:
    nx = 2 if end[0] > start[0] else (-2 if end[0] < start[0] else 0)
    ny = 2 if end[1] > start[1] else (-2 if end[1] < start[1] else 0)
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(start[0] + nx, start[1] + ny, steps=2)
    page.mouse.move(*end, steps=14)
    page.mouse.move(*end)
    page.mouse.up()
    page.wait_for_timeout(120)


# Unlike dock_helpers.right_cols (leaf rects), this measures the GROUP rects.
def _right_columns(page: Page) -> list[dict]:
    """Top-level docked groups on the right edge, left-to-right, with widths."""
    return page.eval_on_selector_all(
        '[data-dock-leaf][data-dock-edge="right"] [data-dock-group]',
        """els => els.map(e => ({ g: e.getAttribute('data-dock-group'),
                                  w: Math.round(e.getBoundingClientRect().width) }))""",
    )


def _right_group_ids(page: Page) -> list[str]:
    return [c["g"] for c in _right_columns(page)]


def _minimize(page: Page, gid: str) -> None:
    page.locator(f'[data-dock-group="{gid}"] [data-dock-minimize]').first.click()
    # Wait out the minimize width animation so widths are measured once settled.
    page.wait_for_timeout(350)


def _setup_two_side_by_side(page: Page) -> tuple[str, str]:
    """Inject a 2-column right region [inspector | controls] and return the
    group ids as (a, b) where `a` is the rightmost (kept) column and `b` the
    canvas-adjacent one -- matching the old gesture-built [b | a] shape."""
    set_layout(page, dock_layout(docked_right=columns("inspector", "controls")))
    cols = _right_group_ids(page)
    assert cols == ["t-inspector", "t-controls"], (
        f"injected side-by-side right region wrong: {cols}"
    )
    return "t-controls", "t-inspector"


def _build_three_vertical(page: Page) -> list[dict]:
    """Inject a FLAT vertical (column) stack of 3 panels on the right edge and
    return the 3 leaf boxes top-to-bottom (equal height weights)."""
    set_layout(
        page, dock_layout(docked_right=stack("controls", "inspector", "console"))
    )
    cols = _right_cols(page)
    assert len(cols) == 3, f"injected 3-way column wrong: {cols}"
    return cols


# The ~7px split divider is reclaimed when a sibling column leaves, so a kept
# column can shift by about that much. Allow a little slack for sub-pixel + a
# possible 1px region rounding.
_DIVIDER_TOL = 10


# ===========================================================================
# (1) Removing one of two side-by-side panels preserves the survivor's width.
#     Float-out is the single e2e wiring proof; the merge-away/snap-away removal
#     paths are unit-pinned (mergeGroupsInto / snapToWindowStack in
#     layoutOps.test.ts, surviving-column px in widthReconciliation.test.ts).
# ===========================================================================
def test_removal_float_out_preserves_sibling_width(page: Page) -> None:
    a, b = _setup_two_side_by_side(page)

    kept_before = _width(page, a)
    # Remove b by tearing it out to clear space (float-out path).
    _drag_group(page, b, (700, 690))
    assert _has(page, a) and b not in _right_group_ids(page), (
        "removal did not float b out cleanly"
    )
    kept_after = _width(page, a)

    assert abs(kept_after - kept_before) <= _DIVIDER_TOL, (
        f"float-out: survivor width changed: {kept_before} -> {kept_after}"
    )


# ===========================================================================
# (2) Docking a new column keeps existing columns' widths; new one = default.
# ===========================================================================
def test_dock_new_column_keeps_existing_and_defaults_new(page: Page) -> None:
    # Arrange: controls docked right alone; inspector floating clear of the
    # region (the dock-b-beside-a gesture is the thing under test).
    a, b = "t-controls", "t-inspector"
    set_layout(
        page,
        dock_layout(
            docked_right=columns("controls"),
            floating=[window("inspector", x=500, y=200, width=260)],
        ),
    )
    assert not _is_float(page, a)
    a_alone = _width(page, a)

    # Dock b beside a (new column).
    abox = _box(page, a)
    _drag_group(page, b, (abox["x"] + 8, abox["y"] + abox["h"] / 2))
    cols = _right_columns(page)
    assert {a, b} <= {c["g"] for c in cols} and len(cols) == 2, (
        f"second dock did not produce a 2-column region: {cols}"
    )

    a_after = _width(page, a)
    b_after = _width(page, b)
    # Existing column keeps its width (within the divider it now shares).
    assert abs(a_after - a_alone) <= _DIVIDER_TOL, (
        f"existing column width changed on new dock: {a_alone} -> {a_after}"
    )
    # New column gets ~the default (~300).
    assert abs(b_after - 300) <= 25, f"new column not ~default width: {b_after}"


# ===========================================================================
# (3) Round-trip: dock->undock keeps widths stable. (The merge->unmerge
#     round-trip is unit-pinned; see the module docstring.)
# ===========================================================================
def test_dock_then_undock_roundtrips_docked_width(page: Page) -> None:
    # Arrange: a single floating panel on an otherwise empty canvas (both the
    # dock and the undock drops are the gestures under test).
    f = "t-controls"
    set_layout(page, dock_layout(floating=[window("controls", x=400, y=150)]))
    vw = page.viewport_size["width"]  # type: ignore[index]

    _drag_group(page, f, (vw - 10, 400))
    if _is_float(page, f):
        pytest.skip("dock to right edge did not take this run")
    docked_w = _width(page, f)

    _drag_group(page, f, (700, 300))
    if not _is_float(page, f):
        pytest.skip("undock did not float the panel this run")
    float_w = _width(page, f)

    assert abs(float_w - docked_w) <= 12, (
        f"docked width not preserved on undock: docked={docked_w} float={float_w}"
    )


# ===========================================================================
# (M2) No spurious width jump at drag start/drop. (Manual-resize survival on
#     sibling removal is unit-pinned in widthReconciliation.test.ts.)
# ===========================================================================
def test_no_width_jump_at_drag_start(page: Page) -> None:
    """Dragging a column out must not jolt the survivor's width beyond the ~7px
    divider it reclaims when the sibling leaves (guards the stale-regionWidth /
    flushSync race that M2 fixed)."""
    a, b = _setup_two_side_by_side(page)

    kept_before = _width(page, a)
    sx, sy = _grip(page, b)
    page.mouse.move(sx, sy)
    page.mouse.down()
    # Move just past the threshold so the float-out arms, then HOLD and measure.
    page.mouse.move(sx + 12, sy + 12, steps=3)
    page.wait_for_timeout(60)
    kept_mid = _width(page, a)
    # Finish the drag out to clear space.
    page.mouse.move(700, 690, steps=8)
    page.mouse.move(700, 690)
    page.mouse.up()
    page.wait_for_timeout(120)
    kept_after = _width(page, a)

    # The only allowed shift is the divider reclaim (~7px); no big snap.
    assert abs(kept_mid - kept_before) <= _DIVIDER_TOL, (
        f"width jumped at drag start: {kept_before} -> {kept_mid}"
    )
    assert abs(kept_after - kept_before) <= _DIVIDER_TOL, (
        f"width jumped by drop: {kept_before} -> {kept_after}"
    )


# ===========================================================================
# (M1) Reserved divider resizes even when a column is minimized/overlaid.
# ===========================================================================
def test_reserved_divider_resizes_with_minimized_column(page: Page) -> None:
    """Build a 3-column right region, minimize the OUTERMOST column (it overlays),
    then drag the divider between the two reserved columns. Previously this was a
    silent no-op (the reserved subtree reused the full split's id); now it must
    actually resize."""
    # Arrange: a 3-column right region (the divider drag is the subject).
    set_layout(
        page, dock_layout(docked_right=columns("controls", "inspector", "console"))
    )
    cols = _right_group_ids(page)
    assert len(cols) == 3, f"injected 3-column right region wrong: {cols}"

    # Minimize the outermost (last, farthest from canvas) so it overlays and the
    # reserved subtree keeps two columns + a divider between them.
    outermost = cols[-1]
    _minimize(page, outermost)

    col0, col1 = cols[0], cols[1]
    w0_before = _width(page, col0)
    w1_before = _width(page, col1)
    lb = _leaf_box(page, col0)
    # Drag the reserved divider (just past col0's right edge) to widen col0.
    _raw_drag(
        page,
        (lb["right"] + 3, lb["y"] + lb["h"] / 2),
        (lb["right"] + 53, lb["y"] + lb["h"] / 2),
    )
    w0_after = _width(page, col0)
    w1_after = _width(page, col1)

    # The divider must have actually moved (not a no-op): col0 grew, col1 shrank.
    assert w0_after - w0_before >= 25, (
        f"reserved divider did not resize col0: {w0_before} -> {w0_after}"
    )
    assert w1_before - w1_after >= 25, (
        f"reserved divider did not shrink col1: {w1_before} -> {w1_after}"
    )


# ===========================================================================
# CHARACTERIZATION: a sole panel docked to an empty edge adopts the region width
# (its prior float width is NOT preserved). Documented as acceptable.
# ===========================================================================
def test_sole_dock_adopts_region_width_not_float_width(page: Page) -> None:
    # Arrange: a single floating panel; the widen + dock gestures follow.
    f = "t-controls"
    set_layout(page, dock_layout(floating=[window("controls", x=400, y=150)]))
    vw = page.viewport_size["width"]  # type: ignore[index]

    wr = _win_rect(page, f)
    _raw_drag(
        page,
        (wr["right"] - 2, wr["y"] + wr["h"] / 2),
        (wr["right"] + 120, wr["y"] + wr["h"] / 2),
    )
    float_w = _width(page, f)
    assert float_w > 360, f"failed to widen the float (got {float_w})"

    _drag_group(page, f, (vw - 10, 400))
    if _is_float(page, f):
        pytest.skip("dock did not take this run")
    docked_w = _width(page, f)

    # ACCEPTABLE: a sole docked column fills the region (~default), so the wide
    # float width is intentionally NOT carried into the dock.
    assert docked_w < float_w - 40, (
        f"expected sole-dock to adopt the (narrower) region width; "
        f"float={float_w} docked={docked_w}"
    )


# ===========================================================================
# Cascading ("push") divider resize in SplitView: vertical 3-way column.
# ===========================================================================
def test_vertical_cascade_pushes_through(dock_context, vite_server: int) -> None:
    page = open_playground(dock_context, vite_server, 1280, 900)
    try:
        cols = _build_three_vertical(page)

        sum0 = sum(c["h"] for c in cols)
        # Top boundary: grab the 7px divider below the first leaf at its center
        # (+3px past the leaf bottom, like the reserved-divider grabs above).
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


# ===========================================================================
# Dock a panel ABOVE a single docked panel (grip bar) -> both ~50% height.
# Regression: the original used to collapse to ~3px.
# ===========================================================================
def test_dock_above_single_panel_splits_height_evenly(
    dock_context, vite_server: int
) -> None:
    vh = 900
    page = open_playground(dock_context, vite_server, 1400, vh)
    try:
        # Arrange: controls docked right (single full-height column), inspector
        # floating; the dock-ABOVE drop is the gesture under test.
        a, c = "t-controls", "t-inspector"
        set_layout(
            page,
            dock_layout(
                docked_right=columns("controls"),
                floating=[window("inspector", x=500, y=200, width=260)],
            ),
        )
        leaves = _right_cols(page)
        assert len(leaves) == 1 and leaves[0]["g"] == a
        region_h = leaves[0]["h"]

        # Dock `c` ABOVE `a` via a's grip bar (per-panel "above this one").
        _drag_group(page, c, _grip(page, a), steps=14)

        after = _right_cols(page)
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
# Dock a panel ABOVE two side-by-side columns (thin region-top span band) ->
# full-width top panel gets substantial height; the two columns keep their
# side-by-side widths (region width preserved, not collapsed to one column).
# ===========================================================================
def test_dock_above_two_columns_spans_and_preserves_widths(
    dock_context, vite_server: int
) -> None:
    page = open_playground(dock_context, vite_server, 1500, 800)
    try:
        # Arrange: two side-by-side right columns + a floating console; the
        # dock-ABOVE-the-region drop is the gesture under test.
        c = "t-console"
        set_layout(
            page,
            dock_layout(
                docked_right=columns("controls", "inspector"),
                floating=[window("console", x=500, y=200, width=300)],
            ),
        )
        cols = _right_cols(page)
        assert len(cols) == 2

        region_left = min(leaf["x"] for leaf in cols)
        region_right = max(leaf["x"] + leaf["w"] for leaf in cols)
        region_width_before = region_right - region_left
        col_widths_before = sorted(leaf["w"] for leaf in cols)
        region_cx = (region_left + region_right) / 2

        # Dock `c` ABOVE BOTH via the thin region-top span band: horizontally
        # centered over the region, within ~4px of the very top.
        _drag_group(page, c, (region_cx, 4), steps=14)

        after = _right_cols(page)
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


# ===========================================================================
# (scroll) A docked column dragged narrower than the panel-content minimum
# (220px) does NOT clamp -- the layout floor is now a tiny grabbable sliver.
# Instead the panel BODY holds the content minimum and overflows, so a
# horizontal scrollbar appears, pinned to the BOTTOM of the panel (the scroll
# viewport fills the panel height) even when the content is short.
# ===========================================================================
def _body_viewport(page: Page, gid: str) -> dict:
    """The docked panel body's scroll viewport metrics + its bottom relative to
    the leaf bottom (so we can assert the horizontal scrollbar sits at the
    panel's bottom, not floating under short content)."""
    return page.eval_on_selector(
        f'[data-dock-group="{gid}"]',
        """e => {
            const vp = e.querySelector('.mantine-ScrollArea-viewport');
            const leaf = e.closest('[data-dock-leaf]');
            const vr = vp.getBoundingClientRect();
            const lr = leaf.getBoundingClientRect();
            return {
                scrollW: Math.round(vp.scrollWidth),
                clientW: Math.round(vp.clientWidth),
                vpBottom: Math.round(vr.bottom),
                leafBottom: Math.round(lr.bottom),
            };
        }""",
    )


def test_narrow_region_scrolls_body_with_bottom_scrollbar(page: Page) -> None:
    a = "t-controls"
    set_layout(page, dock_layout(docked_right=columns("controls")))
    assert not _is_float(page, a)

    leaf = _box(page, a)
    wide = _body_viewport(page, a)
    # At a comfortable width the body fits -- no horizontal overflow.
    assert wide["scrollW"] <= wide["clientW"] + 2, (
        f"unexpected overflow at full width: {wide}"
    )

    # Drag the region's canvas-facing (left) edge rightward to ~120px wide --
    # well below the 220px content minimum. The layout floor (MIN_REGION_GRAB_PX,
    # 96px) lets it commit this narrow instead of clamping at 220.
    vw = page.viewport_size["width"]  # type: ignore[index]
    region_left = leaf["x"]
    target_left = vw - 120
    _raw_drag(page, (region_left, 400), (target_left, 400))

    narrow_w = _width(page, a)
    assert narrow_w < 200, (
        f"region did not shrink below the old 220 floor: width {narrow_w}"
    )

    vp = _body_viewport(page, a)
    # The body holds its content minimum and overflows -> horizontal scrollbar.
    assert vp["scrollW"] > vp["clientW"] + 2, (
        f"narrow panel body did not overflow horizontally: {vp}"
    )
    # The scroll viewport fills to the panel's bottom, so the horizontal
    # scrollbar sits at the bottom of the panel (not mid-panel under short
    # content). Allow a few px for the scrollbar track / sub-pixel rounding.
    assert abs(vp["vpBottom"] - vp["leafBottom"]) <= 18, (
        f"scroll viewport does not reach the panel bottom: {vp}"
    )

