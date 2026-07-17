"""E2E coverage for the content-height detent on HEIGHT dividers (spec 6 /
D56): dragging a docked-stack or floating-stack divider magnetizes a flanking
cell onto its natural content height within the 12px band, the divider's rule
lights up (``data-dock-divider-snapped``), and the FLOATING stack divider
carries the semantic inverse of pin-on-first-drag -- releasing with EVERY
cell of the stack at its content height reverts the window to AUTO height.

Two pins:

1. Floating unpin arm: a 2-cell auto stack is pinned by a first divider drag
   (offsetting both cells from content), then a second drag lands the divider
   back within the band of the all-at-content position -> the snap puts both
   cells exactly at content, and the release commits the window back to
   ``height.mode === "auto"``.
2. Docked exact landing: dragging the column-stack divider until the top cell
   is within the band of its measured content height shows the snapped
   attribute mid-drag, and the released cell rect height equals the content
   height (sub-pixel, not just "within the band" -- the snap is exact).

Width dividers are deliberately OUT of scope (D56: no semantic width target
exists); no width assertions here by design.

Geometry note: starting arrangements are INJECTED via dock_helpers.set_layout
(window.__dockSetLayout), so each test begins from exactly the layout literal
it states. Skips cleanly if the client toolchain is missing, if
requestAnimationFrame never ticks (divider commits and the snap cue are
rAF-throttled -- on a wedged headless compositor the feature is unobservable,
which is an environment fact, not a detent failure), if a divider is not
rendered, or if the playground panes' rendered/content geometry does not
support the gesture this run (e.g. an auto cell capped below its content).
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import (
    dock_layout,
    leaf_box,
    set_layout,
    stack,
    window,
)
from .dock_helpers import open_playground as _open
from .dock_helpers import raf_alive as _raf_alive

# The magnetic band around a content-height detent (types.ts,
# CONTENT_SNAP_BAND_PX).
SNAP_BAND_PX = 12


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
# Natural content height of the element holding group `gid` (the floating
# CELL, or the docked LEAF via closest) -- the same formula as
# detent.ts:measureNaturalHeight: per TOP-LEVEL scroll viewport (a nested
# scroll area lives inside the outer content wrapper and is already counted;
# summing it too would double its overflow delta), the chrome around it plus
# the content wrapper's true height.
_NATURAL_JS = """(el) => {
    let contentSum = 0, clientSum = 0;
    el.querySelectorAll('.mantine-ScrollArea-viewport').forEach((v) => {
        const outer = v.parentElement
            && v.parentElement.closest('.mantine-ScrollArea-viewport');
        if (outer && el.contains(outer)) return;
        const c = v.querySelector('.mantine-ScrollArea-content');
        contentSum += c ? c.offsetHeight : v.scrollHeight;
        clientSum += v.clientHeight;
    });
    return el.offsetHeight - clientSum + contentSum;
}"""


def _cell_natural(page: Page, gid: str) -> float:
    return page.eval_on_selector(f'[data-dock-group="{gid}"]', _NATURAL_JS)


def _leaf_natural(page: Page, gid: str) -> float:
    return page.eval_on_selector(
        f'[data-dock-group="{gid}"]',
        f"e => ({_NATURAL_JS})(e.closest('[data-dock-leaf]'))",
    )


def _cell_h(page: Page, gid: str) -> float:
    return page.eval_on_selector(
        f'[data-dock-group="{gid}"]', "e => e.getBoundingClientRect().height"
    )


def _height_mode(page: Page) -> str:
    return page.evaluate("() => window.__dockLayout.floating[0].height.mode")


def _divider_center(page: Page, selector: str) -> tuple[float, float] | None:
    el = page.query_selector(selector)
    if el is None:
        return None
    box = el.bounding_box()
    if box is None:
        return None
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def _drag_divider(
    page: Page, start: tuple[float, float], dy: float, check_snap: bool = False
) -> bool:
    """Vertical divider drag by `dy` with an axis-tracking arming nudge (a
    diagonal nudge would slip off the seam). When `check_snap`, POLLS the
    ``data-dock-divider-snapped`` attribute at the held end position before
    releasing -- the flush is rAF-throttled, so a single fixed-delay read
    races the paint on slow engines."""
    ny = 2 if dy > 0 else -2
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(start[0], start[1] + ny, steps=2)
    page.mouse.move(start[0], start[1] + dy, steps=12)
    page.mouse.move(start[0], start[1] + dy)
    snapped = False
    if check_snap:
        for _ in range(10):
            page.wait_for_timeout(100)
            if page.query_selector('[data-dock-divider-snapped="true"]') is not None:
                snapped = True
                break
    page.mouse.up()
    page.wait_for_timeout(150)
    return snapped


# ===========================================================================
# 1. Floating stack: releasing the divider with every cell at its content
#    height reverts the window to AUTO (the inverse of pin-on-first-drag).
# ===========================================================================
def test_floating_divider_release_at_all_content_unpins(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server)
    try:
        if not _raf_alive(page):
            pytest.skip("rAF not firing (headless compositor wedge)")
        # A 2-cell auto-height stack; both panes' content fits under the
        # multi-group per-cell cap, so the auto rendering IS content height.
        set_layout(
            page,
            dock_layout(
                floating=[window("inspector", "controls", x=380, y=60, width=300)]
            ),
        )
        top_gid, bot_gid = "t-inspector", "t-controls"
        assert _height_mode(page) == "auto"
        content = {g: _cell_natural(page, g) for g in (top_gid, bot_gid)}
        for g in (top_gid, bot_gid):
            if abs(_cell_h(page, g) - content[g]) > 3:
                pytest.skip(f"auto cell {g} not at content this run (cap engaged?)")
        if content[top_gid] < 95:
            pytest.skip("top cell too short to shrink 40px this run")

        # First drag: UP 40px -> pins the window (auto has no divider total)
        # and offsets both cells from their content heights. 40px is well
        # outside the 12px band, so the all-at-content detents at delta 0
        # cannot recapture the release.
        d = _divider_center(page, "[data-floating-divider]")
        if d is None:
            pytest.skip("no floating divider rendered this run")
        _drag_divider(page, d, -40)
        assert _height_mode(page) == "pinned", (
            "a stack-divider drag on an auto window must pin first"
        )
        off_top = _cell_h(page, top_gid) - content[top_gid]
        if not (-55 < off_top < -25):
            pytest.skip(f"pin drag landed unexpectedly (top offset {off_top:.1f})")

        # Second drag: back DOWN to within the band of the all-at-content
        # position (deliberately ~5px short of exact). The detent snaps both
        # flanks onto content, and the release commits the window to AUTO.
        d2 = _divider_center(page, "[data-floating-divider]")
        assert d2 is not None
        dy = (content[top_gid] - _cell_h(page, top_gid)) + 5
        snapped = _drag_divider(page, d2, dy, check_snap=True)
        assert snapped, "the divider should report the snap cue inside the band"
        page.wait_for_function(
            '() => window.__dockLayout.floating[0].height.mode === "auto"',
            polling=50,
        )
        # And the cells really sit at content again (auto tracks content).
        for g in (top_gid, bot_gid):
            assert abs(_cell_h(page, g) - content[g]) <= 3, (
                f"cell {g} should be back at content height after the unpin"
            )
    finally:
        page.close()


# ===========================================================================
# 2. Docked stack: a divider released within the band lands the flanking cell
#    EXACTLY at its content height (the snap is exact, not merely in-band),
#    and the snapped attribute shows while magnetized.
# ===========================================================================
def test_docked_divider_snaps_exactly_to_content_height(
    dock_context, vite_server: int
) -> None:
    page = _open(dock_context, vite_server)
    try:
        if not _raf_alive(page):
            pytest.skip("rAF not firing (headless compositor wedge)")
        # A 2-leaf column on the right edge; the viewport-tall cells sit well
        # above their content, so the detent is a real drag away.
        set_layout(page, dock_layout(docked_right=stack("inspector", "console")))
        top_gid, bot_gid = "t-inspector", "t-console"
        content_top = _leaf_natural(page, top_gid)
        h0 = leaf_box(page, top_gid)["h"]
        bot_h0 = leaf_box(page, bot_gid)["h"]
        delta = content_top - h0
        if abs(delta) < 25:
            pytest.skip("top cell already near content; no detent drag this run")
        if content_top < 55:
            pytest.skip("top cell content below the cell floor this run")
        if delta > 0 and bot_h0 - 55 < delta:
            pytest.skip("bottom cell too short to give the needed space this run")

        d = _divider_center(
            page, '[data-dock-divider="column"][data-dock-divider-resizable="true"]'
        )
        if d is None:
            pytest.skip("no resizable column divider rendered this run")
        # No snapped attribute at rest.
        assert page.query_selector("[data-dock-divider-snapped]") is None

        # Drag to 6px SHORT of the exact content position (inside the band):
        # the magnet must close the gap, exactly.
        off = -6 if delta < 0 else 6
        snapped = _drag_divider(page, d, delta + off, check_snap=True)
        assert snapped, "the divider should expose data-dock-divider-snapped in-band"

        h1 = leaf_box(page, top_gid)["h"]
        assert abs(h1 - content_top) <= 1.5, (
            f"released in the band, the cell must land EXACTLY at content "
            f"({h1:.2f} vs content {content_top:.2f}; started {h0:.2f})"
        )
        # The cue is gesture-scoped: gone after release.
        assert page.query_selector("[data-dock-divider-snapped]") is None
    finally:
        page.close()
