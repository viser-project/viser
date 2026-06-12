"""E2E width-preservation tests for the docking layer (measures rendered px).

Verifies the centralized width-reconciliation model: when a docked region's SET
of top-level columns changes, surviving columns keep their exact pixel widths and
new columns get a default; pure-internal changes leave widths untouched.

Characterized behavior (see individual tests):
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

ACCEPTABLE exceptions (asserted as such, not bugs):
* A single floating panel docked to an EMPTY edge adopts the region width (a sole
  docked column == the whole region), so its prior float width is not preserved.
* Deeply-nested left/right splits may not preserve exact widths.

Geometry note: the playground starts with floating panels clustered upper-center
and a docked panel on the left, so "empty canvas" drop points are scarce. These
tests park unused floaters at the bottom to clear a clean drop area, and park
the seeded unmergeable monitor window (x 900-1200, y 60-440) out of the way
before docking side-by-side: its full-bleed area would otherwise merge away the
panel dropped on it.

Skips cleanly if the client toolchain (``npx`` + ``node_modules``) is missing.
"""

from __future__ import annotations

from typing import Generator

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import drag_group as _drag_group
from .dock_helpers import floating_group_ids, open_playground
from .dock_helpers import group_box as _box
from .dock_helpers import group_grip_center as _grip
from .dock_helpers import leaf_box as _leaf_box
from .dock_helpers import park_monitor as _park_monitor


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
def _floating_ids(page: Page) -> list[str]:
    return floating_group_ids(page, require_grip=True)


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


# Unlike dock_helpers.drag, arms with a small HORIZONTAL nudge (used for
# divider/edge grabs, where a diagonal nudge could slip off the handle).
def _raw_drag(page: Page, start: tuple[float, float], end: tuple[float, float]) -> None:
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(start[0] + 4, start[1], steps=2)
    page.mouse.move(*end, steps=10)
    page.mouse.move(*end)
    page.mouse.up()
    page.wait_for_timeout(120)


def _park_others(page: Page, keep: str) -> None:
    """Move every floating group except `keep` to the bottom strip, clearing the
    canvas center so undock drops land in free space."""
    others = [g for g in _floating_ids(page) if g != keep]
    for i, g in enumerate(others):
        _drag_group(page, g, (120 + i * 70, 700))


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
    page.wait_for_timeout(120)


def _setup_two_side_by_side(page: Page, a: str, b: str) -> None:
    """Dock `a` to the right edge, then `b` to a's LEFT band -> side-by-side
    [b | a]. Parks the unmergeable monitor window FIRST: b's drop point (8px
    inside a's left edge, mid-height) would otherwise land inside the monitor
    (x 900-1200, y 60-440), whose full-bleed area merges b away. Asserts the
    2-column right region formed (deterministic after parking). (Differs from
    dock_helpers.setup_side_by_side: drops b 8px inside a's edge, not at 10%.)"""
    _park_monitor(page)
    vw = page.viewport_size["width"]  # type: ignore[index]
    _drag_group(page, a, (vw - 10, 400))
    ab = _box(page, a)
    _drag_group(page, b, (ab["x"] + 8, ab["y"] + ab["h"] / 2))
    cols = _right_group_ids(page)
    assert a in cols and b in cols and len(cols) == 2, (
        f"side-by-side right region did not form: {cols}"
    )


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
    ids = _floating_ids(page)
    assert len(ids) >= 2
    a, b = ids[0], ids[1]
    _setup_two_side_by_side(page, a, b)

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
    ids = _floating_ids(page)
    assert len(ids) >= 2
    a, b = ids[0], ids[1]
    # Park the monitor first: b's drop point below would land inside it and
    # merge b away instead of forming a new column.
    _park_monitor(page)
    vw = page.viewport_size["width"]  # type: ignore[index]

    _drag_group(page, a, (vw - 10, 400))
    assert not _is_float(page, a), "first dock did not take"
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
    ids = _floating_ids(page)
    f = ids[0]
    _park_others(page, f)
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
    ids = _floating_ids(page)
    assert len(ids) >= 2
    a, b = ids[0], ids[1]
    _setup_two_side_by_side(page, a, b)

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
    ids = _floating_ids(page)
    assert len(ids) >= 3
    a, b, c = ids[0], ids[1], ids[2]
    # Park the monitor first: the b/c drop points below would land inside it
    # and merge the panels away instead of forming new columns.
    _park_monitor(page)
    vw = page.viewport_size["width"]  # type: ignore[index]

    _drag_group(page, a, (vw - 10, 400))
    abox = _box(page, a)
    _drag_group(page, b, (abox["x"] + 8, abox["y"] + abox["h"] / 2))
    abox = _box(page, a)
    _drag_group(page, c, (abox["x"] + 8, abox["y"] + abox["h"] / 2))
    cols = _right_group_ids(page)
    assert len(cols) == 3, f"did not produce a 3-column right region: {cols}"

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
    ids = _floating_ids(page)
    f = ids[0]
    _park_others(page, f)
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
