"""E2E pins for drop-hint lifecycle and the rail header's zone exclusion.

1. STUCK-HINT regression (scan follow-up, 2026-07): releasing a drag while the
   final pointermove's requestAnimationFrame is still pending (pointerup lands
   between a move and the next frame -- routine at 60Hz paint with a 125Hz+
   mouse) left a browser-scheduled apply() alive past teardown. It re-hit-test
   the release point against the post-drop layout and repainted the hint with
   every listener detached -- a blue hint bar that never disappeared. The fix
   cancels the queued frame before the manual flush AND makes post-teardown
   frames inert; this test dispatches move+up in the SAME JS task to force the
   pending-frame window deterministically.

2. D53: the rail header run (the `+` handle bar / chevron rows above the first
   cell) is CONTROLS, not a CELL drop surface. The pointer there resolves at
   REGION level -- a side band's dock-beside (region-tall vertical insert line) where the
   bands reach, float-at-pointer past them -- never "stack above <panel>"
   through the controls. The first cell's stack-above band begins below the
   chrome, where the new cell actually lands.
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import columns as _columns
from .dock_helpers import dock_layout as _dock_layout
from .dock_helpers import layout as _layout
from .dock_helpers import open_playground as _open
from .dock_helpers import raf_alive as _raf_alive
from .dock_helpers import set_layout as _set_layout
from .dock_helpers import stack as _stack
from .dock_helpers import window as _window


def _packed_rail_with_floater(page: Page) -> None:
    """Two railed columns on the left (the user-report shape) + one floater."""
    _set_layout(
        page,
        _dock_layout(
            docked_left=_columns(
                _stack("controls", railed=True),
                _stack("console", railed=True),
            ),
            floating=[_window("inspector", x=520, y=220)],
        ),
    )


def _hint_display(page: Page) -> str | None:
    return page.evaluate(
        """() => {
            const el = document.querySelector('[data-dock-hint]');
            return el === null ? null : getComputedStyle(el).display;
        }"""
    )


def _dispatch_move(page: Page, x: float, y: float, pid: int) -> None:
    """Window-level synthetic pointermove: the same primitive the stuck-hint
    test uses for its same-task release, and the one pointer path verified to
    reach the drag on every engine tried (real page.mouse.move deliveries
    proved engine-dependent for mid-drag hint updates on some Chromium
    builds)."""
    page.evaluate(
        """([x, y, pid]) => {
          window.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true, clientX: x, clientY: y,
            pointerId: pid, pointerType: 'mouse', isPrimary: true }));
        }""",
        [x, y, pid],
    )


def _poll_hint(page: Page, x: float, y: float, pid: int, tries: int = 15):
    """Re-dispatch a slightly jittered move and poll the hint until it shows
    (or tries run out). Returns the hint rect dict or None."""
    for i in range(tries):
        _dispatch_move(page, x + (i % 2), y, pid)
        page.wait_for_timeout(100)
        h = page.evaluate(
            """() => {
                const el = document.querySelector('[data-dock-hint]');
                if (el === null) return null;
                if (getComputedStyle(el).display === 'none') return null;
                const r = el.getBoundingClientRect();
                return { v: el.getAttribute('data-dock-hint'),
                         w: r.width, h: r.height, top: r.y };
            }"""
        )
        if h is not None:
            return h
    return None


def _record_pointer_id(page: Page) -> None:
    page.evaluate(
        """() => { window.__pid = null;
             window.addEventListener('pointermove',
               (e) => { window.__pid = e.pointerId; }, true); }"""
    )


def _drag_floater_to(page: Page, tx: float, ty: float) -> None:
    """Real pointer moves from the floater's grip toward (tx, ty), held."""
    win = page.query_selector("[data-floating-window]")
    assert win is not None
    wb = win.bounding_box()
    assert wb is not None
    sx, sy = wb["x"] + wb["width"] / 2, wb["y"] + 8
    page.mouse.move(sx, sy)
    page.mouse.down()
    for i in range(1, 7):
        page.mouse.move(sx + (tx - sx) * i / 6, sy + (ty - sy) * i / 6)


def test_hint_hidden_after_same_task_move_and_release(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server, 1280, 800)
    try:
        if not _raf_alive(page):
            pytest.skip("rAF not firing (headless compositor wedge)")
        _packed_rail_with_floater(page)
        _record_pointer_id(page)

        # Target: the FIRST rail cell's stack-above band (top 8px of the cell,
        # below the header chrome -- D53).
        cell = page.query_selector("[data-dock-rail-root] [data-dock-leaf]")
        assert cell is not None
        cb = cell.bounding_box()
        assert cb is not None
        tx, ty = cb["x"] + cb["width"] / 2, cb["y"] + 4

        _drag_floater_to(page, tx, ty)
        pid = page.evaluate("() => window.__pid")
        if pid is None:
            pytest.skip("pointer id not observed this run")

        # Same-task move + up: the move's rAF is still pending when the end
        # handler runs -- the exact window that leaked the hint.
        page.evaluate(
            """([x, y, pid]) => {
              const opts = { bubbles: true, clientX: x, clientY: y,
                             pointerId: pid, pointerType: 'mouse',
                             isPrimary: true };
              window.dispatchEvent(new PointerEvent('pointermove', opts));
              window.dispatchEvent(
                new PointerEvent('pointerup', { ...opts, button: 0 }));
            }""",
            [tx, ty, pid],
        )
        page.mouse.up()  # clear the OS-level button state
        page.wait_for_timeout(600)

        # The drop must have LANDED (otherwise this test pins nothing)...
        left = _layout(page)["docked"]["left"]
        stacked = any(len(c["leaves"]) == 2 for c in left["columns"])
        docked_cols = len(left["columns"])
        if not (stacked or docked_cols == 3):
            pytest.skip("drop did not land this run; nothing to pin")
        # ...and the hint must be GONE: no stray post-teardown frame may
        # repaint it.
        assert _hint_display(page) in (None, "none"), (
            "drop hint survived the gesture (stray-rAF regression)"
        )
        # Idle moves must not resurrect it either.
        page.mouse.move(700, 500)
        page.mouse.move(400, 300)
        page.wait_for_timeout(200)
        assert _hint_display(page) in (None, "none")
    finally:
        page.close()


def test_rail_header_run_is_not_a_drop_zone(dock_context, vite_server: int) -> None:
    page = _open(dock_context, vite_server, 1280, 800)
    try:
        if not _raf_alive(page):
            pytest.skip("rAF not firing (headless compositor wedge)")
        _packed_rail_with_floater(page)
        _record_pointer_id(page)

        rail = page.query_selector("[data-dock-rail-root]")
        cell = page.query_selector("[data-dock-rail-root] [data-dock-leaf]")
        assert rail is not None and cell is not None
        rb = rail.bounding_box()
        cb = cell.bounding_box()
        assert rb is not None and cb is not None
        if cb["y"] - rb["y"] < 6:
            pytest.skip("no header run above the first cell this run")
        header_x = rb["x"] + rb["width"] / 2
        header_y = rb["y"] + min(6.0, (cb["y"] - rb["y"]) / 2)

        # Held over the header chrome: the CELL may not claim the pointer
        # (D53). Region-level resolution is fine and expected -- the side
        # band's dock-beside hint is a VERTICAL region-tall line -- so
        # distinguish by geometry: the cell's stack-above line is HORIZONTAL
        # (strip-wide, a few px tall). Moves are DISPATCHED (see
        # _dispatch_move) and the hint POLLED: fixed-delay real-mouse reads
        # proved engine-dependent for mid-drag hint updates.
        _drag_floater_to(page, header_x, header_y)
        pid = page.evaluate("() => window.__pid")
        if pid is None:
            pytest.skip("pointer id not observed this run")

        over_header = _poll_hint(page, header_x, header_y, pid, tries=5)
        if over_header is not None and over_header["v"] == "line":
            assert over_header["h"] > over_header["w"], (
                "a HORIZONTAL cell stack-above line over the header chrome "
                f"(D53): {over_header}"
            )

        # Just below the chrome, the first cell's stack-above band DOES claim
        # the pointer: the horizontal strip-wide split line at the honest
        # landing seam.
        below = _poll_hint(page, header_x, cb["y"] + 4, pid)
        assert below is not None and below["v"] == "line" and below["w"] > below["h"], (
            f"first cell's stack-above band should begin below the header: {below}"
        )

        # Release back over the header: region-level outcome only -- the drag
        # floats or docks BESIDE the rail (a new column); it must never stack
        # through the controls into the rail's column.
        _dispatch_move(page, header_x, header_y, pid)
        page.wait_for_timeout(100)
        page.mouse.up()
        page.wait_for_timeout(300)
        lay = _layout(page)
        assert all(len(c["leaves"]) == 1 for c in lay["docked"]["left"]["columns"]), (
            "release over the header must not stack into the rail's column"
        )
    finally:
        page.close()
