"""E2E test for the dock's one-gesture rule under MULTI-TOUCH (spec §4: "One
active gesture at a time; extra pointers are ignored").

Pre-fix, resize surfaces (docked dividers, region resizer, window grips) kept
per-surface gesture refs instead of the dock-wide gesture slot, so while a
divider resize was live via one touch point, a SECOND touch on a floating
window's grip could arm and start a concurrent window move drag -- two live
gestures fighting over the shared singletons (cursor, text-selection
suppression, hint element). The fix routes every resize surface through
``exclusiveDragGesture`` on the shared slot, so the second press is ignored.

Playwright's high-level API cannot hold two concurrent touch points, so raw
CDP ``Input.dispatchTouchEvent`` is used (the context is created with
``has_touch=True`` so touch emulation is on). Chromium synthesizes
pointerevents (pointerType "touch") from these, which is what the dock's
pointer handlers consume; the divider and grip both set ``touch-action:
none``, so the browser cannot steal the touches for scrolling.

The scenario: a two-leaf docked column on the right (divider between the
leaves) plus a floating window. Touch 1 drags the divider (resize progresses);
touch 2 lands on the floating window's grip and moves substantially -- the
window must NOT move while the resize keeps tracking touch 1. After releasing
both, no cursor/userSelect state may be stuck and a plain single-touch window
drag must work.
"""

from __future__ import annotations

from typing import Generator

import pytest
from playwright.sync_api import Browser, BrowserContext, Page

from .dock_helpers import (
    dock_layout,
    open_playground,
    raf_alive,
    right_cols,
    set_layout,
    stack,
    window,
)

_WINDOW_SELECTOR = '[data-floating-window="t-w-console"]'
_GRIP_SELECTOR = f"{_WINDOW_SELECTOR} [data-dock-griphandle]"


@pytest.fixture(scope="module")
def touch_context(browser: Browser) -> Generator[BrowserContext, None, None]:
    """Like conftest's dock_context, but with touch emulation enabled so CDP
    Input.dispatchTouchEvent synthesizes real touch pointerevents."""
    ctx = browser.new_context(reduced_motion="reduce", has_touch=True)
    yield ctx
    ctx.close()


class _Touches:
    """Multi-touch driver over CDP Input.dispatchTouchEvent.

    Tracks the set of active touch points; every dispatch lists ALL active
    points (the protocol's contract: touchPoints is the current state of the
    touch device, and Chromium diffs against the previous dispatch to emit
    per-point press/move/release events). Only one point changes per call, so
    each dispatch is a single well-formed touch transition.
    """

    def __init__(self, page: Page) -> None:
        self._cdp = page.context.new_cdp_session(page)
        self._points: dict[int, tuple[float, float]] = {}

    def _send(self, type_: str) -> None:
        self._cdp.send(
            "Input.dispatchTouchEvent",
            {
                "type": type_,
                "touchPoints": [
                    {"x": x, "y": y, "id": pid} for pid, (x, y) in self._points.items()
                ],
            },
        )

    def start(self, pid: int, x: float, y: float) -> None:
        self._points[pid] = (x, y)
        self._send("touchStart")

    def move(self, pid: int, x: float, y: float) -> None:
        self._points[pid] = (x, y)
        self._send("touchMove")

    def end(self, pid: int) -> None:
        del self._points[pid]
        self._send("touchEnd")


def _win_rect(page: Page) -> dict:
    return page.eval_on_selector(
        _WINDOW_SELECTOR,
        "e => { const r = e.getBoundingClientRect();"
        " return { x: r.x, y: r.y, w: r.width, h: r.height }; }",
    )


def _grip_center(page: Page) -> tuple[float, float]:
    box = page.eval_on_selector(
        _GRIP_SELECTOR,
        "e => { const r = e.getBoundingClientRect();"
        " return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }",
    )
    return box["x"], box["y"]


def _top_leaf_height(page: Page) -> int:
    cols = right_cols(page)
    assert len(cols) == 2, f"expected the injected 2-leaf right column: {cols}"
    return cols[0]["h"]


def test_second_touch_cannot_start_window_drag_during_divider_resize(
    touch_context: BrowserContext, vite_server: int
) -> None:
    page = open_playground(touch_context, vite_server, 1280, 800)
    try:
        if not raf_alive(page):
            pytest.skip("rAF not ticking; resize flushes can never land")

        # Arrange: two leaves stacked in one docked right column (a live
        # divider between them) + a floating window clear of the region.
        set_layout(
            page,
            dock_layout(
                docked_right=stack("controls", "inspector"),
                floating=[window("console", x=340, y=120, width=280)],
            ),
        )
        cols = right_cols(page)
        assert len(cols) == 2, f"injected right column wrong: {cols}"
        top = cols[0]
        div_x = top["x"] + top["w"] / 2
        div_y = top["y"] + top["h"] + 3  # center of the ~7px divider

        touches = _Touches(page)

        # Touch 1: press the divider and drag DOWN -- the resize is live.
        h_start = _top_leaf_height(page)
        touches.start(1, div_x, div_y)
        for dy in (8, 20, 32, 44):
            touches.move(1, div_x, div_y + dy)
        page.wait_for_timeout(150)  # let the rAF-throttled flush land
        h_mid = _top_leaf_height(page)
        assert h_mid - h_start >= 25, (
            f"touch divider resize did not progress: {h_start} -> {h_mid}"
        )

        # Touch 2 (concurrent): press the floating window's grip and move it
        # far past the drag threshold. Spec §4: extra pointers are ignored --
        # the window must not move.
        before = _win_rect(page)
        gx, gy = _grip_center(page)
        touches.start(2, gx, gy)
        for step in (0.25, 0.5, 0.75, 1.0):
            touches.move(2, gx + 140 * step, gy + 110 * step)
        page.wait_for_timeout(150)
        during = _win_rect(page)
        assert (
            abs(during["x"] - before["x"]) <= 2 and abs(during["y"] - before["y"]) <= 2
        ), (
            "second touch moved the floating window during a divider resize "
            f"(one-gesture rule, spec 4): {before} -> {during}"
        )

        # The FIRST gesture is still the live one: further motion of touch 1
        # keeps resizing (the second press neither hijacked nor cancelled it).
        for dy in (56, 68, 80):
            touches.move(1, div_x, div_y + dy)
        page.wait_for_timeout(150)
        h_late = _top_leaf_height(page)
        assert h_late - h_mid >= 20, (
            f"divider resize stopped tracking after the second touch: "
            f"{h_mid} -> {h_late}"
        )

        # Release both (ignored finger first, then the gesture's).
        touches.end(2)
        touches.end(1)
        page.wait_for_timeout(150)

        # Window still where it was; no gesture-teardown state stuck on body.
        after = _win_rect(page)
        assert (
            abs(after["x"] - before["x"]) <= 2 and abs(after["y"] - before["y"]) <= 2
        ), f"window jumped on release: {before} -> {after}"
        body_style = page.evaluate(
            "() => ({ userSelect: document.body.style.userSelect,"
            " cursor: document.body.style.cursor })"
        )
        assert body_style["userSelect"] == "", (
            f"text-selection suppression stuck after release: {body_style}"
        )
        assert body_style["cursor"] != "grabbing", (
            f"grabbing cursor stuck after release: {body_style}"
        )

        # Layout is coherent: a plain single-touch drag of the window works.
        gx2, gy2 = _grip_center(page)
        touches.start(1, gx2, gy2)
        for step in (0.25, 0.5, 0.75, 1.0):
            touches.move(1, gx2 + 100 * step, gy2 + 60 * step)
        touches.end(1)
        page.wait_for_timeout(200)
        moved = _win_rect(page)
        assert moved["x"] - after["x"] >= 50, (
            f"single-touch window drag no longer works after the multi-touch "
            f"episode: {after} -> {moved}"
        )
    finally:
        page.close()
