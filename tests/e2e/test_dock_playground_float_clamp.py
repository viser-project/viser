"""Playground (Python-free) coverage for floating-window clamping when the docked
insets change -- the behavior reported as "dock a panel to the right while a float
is over the canvas; the float should shift to stay clear".

These drive the standalone-Vite dock playground via ``window.__dockSetLayout`` (no
ViserServer, no Python panel API), so they exercise the pure client rendering /
DockManager inset-clamp logic directly. Same harness as the other
``test_dock_playground_*`` modules.
"""

from __future__ import annotations

from playwright.sync_api import Page

from .dock_helpers import columns, dock_layout, set_layout, window
from .dock_helpers import open_playground as _open


def _fbox(page: Page, window_id: str) -> dict:
    """Bounding box of a floating window by its layout id."""
    return page.eval_on_selector(
        f'[data-floating-window="{window_id}"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x, y: r.y, w: r.width, right: r.right }; }",
    )


def test_float_shifts_left_when_right_region_grows(
    dock_context, vite_server: int
) -> None:
    """A float near the right edge of the canvas is pulled left when a second
    panel docks to the right (the right region grows, shrinking the canvas)."""
    page = _open(dock_context, vite_server, 1280, 800)
    try:
        # One right-docked panel + a float near the right side of the canvas.
        set_layout(
            page,
            dock_layout(
                docked_right=columns("controls"),
                floating=[window("inspector", x=600, y=80, width=240)],
            ),
        )
        before = _fbox(page, "t-w-inspector")
        assert before["x"] == 600, before

        # Dock a SECOND panel to the right -> wider right region, narrower canvas.
        set_layout(
            page,
            dock_layout(
                docked_right=columns("controls", "console"),
                floating=[window("inspector", x=600, y=80, width=240)],
            ),
        )
        after = _fbox(page, "t-w-inspector")
        # The float shifted left to stay clear of the (now wider) right region.
        assert after["x"] < before["x"] - 20, (
            f"float should shift left when the right region grows: "
            f"{before['x']} -> {after['x']}"
        )
        # And its right edge no longer intrudes into the docked region: the
        # right-edge leaves start to the right of the float.
        right_leaf = page.eval_on_selector(
            "[data-dock-leaf][data-dock-edge='right']",
            "e => e.getBoundingClientRect().x",
        )
        assert after["right"] <= right_leaf + 2, (
            f"float right edge {after['right']} overlaps the docked region "
            f"starting at {right_leaf}"
        )
    finally:
        page.close()


def test_float_not_moved_when_comfortably_inside_canvas(
    dock_context, vite_server: int
) -> None:
    """A float well inside the canvas is left alone when a right panel docks
    (we only PULL floats in when they'd intrude, never nudge ones that fit)."""
    page = _open(dock_context, vite_server, 1280, 800)
    try:
        set_layout(
            page,
            dock_layout(floating=[window("inspector", x=120, y=80, width=240)]),
        )
        before = _fbox(page, "t-w-inspector")
        set_layout(
            page,
            dock_layout(
                docked_right=columns("controls"),
                floating=[window("inspector", x=120, y=80, width=240)],
            ),
        )
        after = _fbox(page, "t-w-inspector")
        assert after["x"] == before["x"], (
            f"a float comfortably inside the canvas must not move: "
            f"{before['x']} -> {after['x']}"
        )
    finally:
        page.close()


def test_float_shifts_right_when_left_region_grows(
    dock_context, vite_server: int
) -> None:
    """Symmetric: a float near the left edge is pushed right when a panel docks
    to the left (the canvas left boundary moves inward)."""
    page = _open(dock_context, vite_server, 1280, 800)
    try:
        set_layout(
            page,
            dock_layout(floating=[window("inspector", x=20, y=80, width=240)]),
        )
        before = _fbox(page, "t-w-inspector")
        assert before["x"] == 20, before
        set_layout(
            page,
            dock_layout(
                docked_left=columns("controls"),
                floating=[window("inspector", x=20, y=80, width=240)],
            ),
        )
        after = _fbox(page, "t-w-inspector")
        # Pulled right so its left edge clears the left-docked region.
        assert after["x"] > before["x"] + 20, (
            f"float should shift right when the left region grows: "
            f"{before['x']} -> {after['x']}"
        )
    finally:
        page.close()
