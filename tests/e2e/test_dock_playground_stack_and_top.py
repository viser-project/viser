"""E2E coverage for floating-window TOP resize grips and the stack handle's
minimize-all button.

1. Dragging the TOP edge grip resizes height with the BOTTOM edge held fixed
   (y moves with the height), like a left-edge width resize holds the right
   edge.
2. Dragging a TOP corner grip resizes width and height together with the
   opposite (right/bottom) edges held fixed.
3. The multi-group stack handle's minimize-all button collapses every child
   group; clicking again expands them back.
4. A mixed min/max arrangement round-trips: children minimized individually
   BEFORE the parent minimize stay minimized after the parent expand (only
   the ones the parent minimized are restored).

Same harness as ``test_dock_playground_quirks.py``. Run with::

    uv run pytest tests/e2e/test_dock_playground_stack_and_top.py -v
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import (
    collapsed as _collapsed,
)
from .dock_helpers import (
    grip_center as _grip,
)
from .dock_helpers import (
    group_id_for_panel as _group_id_for_panel,
)
from .dock_helpers import (
    open_playground as _open,
)


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
def _window_box(page: Page, panel_id: str) -> dict:
    gid = _group_id_for_panel(page, panel_id)
    return page.evaluate(
        """(gid) => {
            const el = document
                .querySelector(`[data-dock-group="${gid}"]`)
                .closest('[data-floating-window]');
            const r = el.getBoundingClientRect();
            return { id: el.getAttribute('data-floating-window'),
                     x: r.x, y: r.y, w: r.width, h: r.height,
                     right: r.right, bottom: r.bottom };
        }""",
        gid,
    )


def _resize_grip(page: Page, window_id: str, edge: str) -> tuple[float, float]:
    box = page.eval_on_selector(
        f'[data-floating-window="{window_id}"] [data-dock-resize="{edge}"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    return box["x"], box["y"]


def _drag(page: Page, start: tuple[float, float], end: tuple[float, float]) -> None:
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(start[0] + 3, start[1] + 3, steps=2)
    page.mouse.move(*end, steps=12)
    page.mouse.move(*end)
    page.mouse.up()
    page.wait_for_timeout(120)


def _make_stack(page: Page) -> str | None:
    """Snap inspector onto controls' grip -> one stacked window. Returns the
    window id (from the [data-floating-handle] header), or None on a miss."""
    _drag(page, _grip(page, "inspector"), _grip(page, "controls"))
    handle = page.query_selector("[data-floating-handle]")
    if handle is None:
        return None
    return handle.get_attribute("data-floating-handle")


# ---------------------------------------------------------------------------
# 1. Top edge resize: bottom fixed, y moves.
# ---------------------------------------------------------------------------
def test_top_edge_resize_keeps_bottom_fixed(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    before = _window_box(page, "controls")
    gx, gy = _resize_grip(page, before["id"], "top")
    # Drag the top edge DOWN 60px: height shrinks, bottom edge stays put.
    _drag(page, (gx, gy), (gx, gy + 60))
    after = _window_box(page, "controls")
    assert abs(after["bottom"] - before["bottom"]) < 2, "bottom edge must stay fixed"
    assert abs((before["h"] - after["h"]) - 60) < 6, (
        f"height should shrink by ~60 ({before['h']} -> {after['h']})"
    )
    assert abs((after["y"] - before["y"]) - 60) < 6, "top edge should move down ~60"
    page.close()


# ---------------------------------------------------------------------------
# 2. Top-left corner: right + bottom fixed, width/height change together.
# ---------------------------------------------------------------------------
def test_top_left_corner_resize(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    before = _window_box(page, "controls")
    gx, gy = _resize_grip(page, before["id"], "top-left")
    # Drag left 50 (wider) and down 30 (shorter).
    _drag(page, (gx, gy), (gx - 50, gy + 30))
    after = _window_box(page, "controls")
    assert abs(after["right"] - before["right"]) < 2, "right edge must stay fixed"
    assert abs(after["bottom"] - before["bottom"]) < 2, "bottom edge must stay fixed"
    assert abs((after["w"] - before["w"]) - 50) < 6, "width should grow ~50"
    assert abs((before["h"] - after["h"]) - 30) < 6, "height should shrink ~30"
    page.close()


# ---------------------------------------------------------------------------
# 3. Stack handle minimize-all toggles every child group.
# ---------------------------------------------------------------------------
def test_stack_minimize_all_and_expand_all(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    win_id = _make_stack(page)
    if win_id is None:
        pytest.skip("stack snap didn't land this run")
    a = _group_id_for_panel(page, "controls")
    b = _group_id_for_panel(page, "inspector")

    page.eval_on_selector(
        f'[data-floating-handle="{win_id}"] [data-dock-minimize-all]',
        "e => e.click()",
    )
    page.wait_for_timeout(120)
    assert _collapsed(page, a) and _collapsed(page, b), (
        "minimize-all should collapse every group in the stack"
    )

    page.eval_on_selector(
        f'[data-floating-handle="{win_id}"] [data-dock-minimize-all]',
        "e => e.click()",
    )
    page.wait_for_timeout(120)
    assert not _collapsed(page, a) and not _collapsed(page, b), (
        "expand-all should restore both groups (all were expanded before)"
    )
    page.close()


# ---------------------------------------------------------------------------
# 4. Mixed arrangement round-trips through parent minimize/expand.
# ---------------------------------------------------------------------------
def test_stack_minimize_restores_previous_mix(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    win_id = _make_stack(page)
    if win_id is None:
        pytest.skip("stack snap didn't land this run")
    a = _group_id_for_panel(page, "controls")
    b = _group_id_for_panel(page, "inspector")

    # Minimize inspector INDIVIDUALLY first -> mix is [controls: max, inspector: min].
    page.eval_on_selector(
        f'[data-dock-group="{b}"] [data-dock-minimize]', "e => e.click()"
    )
    page.wait_for_timeout(120)
    assert _collapsed(page, b) and not _collapsed(page, a)

    # Parent minimize-all -> both minimized; parent expand -> the previous mix
    # comes back (controls expands, inspector STAYS minimized).
    page.eval_on_selector(
        f'[data-floating-handle="{win_id}"] [data-dock-minimize-all]',
        "e => e.click()",
    )
    page.wait_for_timeout(120)
    assert _collapsed(page, a) and _collapsed(page, b)
    page.eval_on_selector(
        f'[data-floating-handle="{win_id}"] [data-dock-minimize-all]',
        "e => e.click()",
    )
    page.wait_for_timeout(120)
    assert not _collapsed(page, a), "controls was expanded before; must restore"
    assert _collapsed(page, b), "inspector was minimized by the USER; must stay"
    page.close()
