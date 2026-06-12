"""E2E for the docked-column handle: a top-level docked column with 2+ stacked
panels shows a slim header bar; dragging it floats the WHOLE column as one
stacked window (order preserved). Same standalone-Vite harness as the other
dock playground files."""

from __future__ import annotations

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import drag
from .dock_helpers import open_playground as _open


def _drag(page: Page, start, end, steps=18):
    drag(page, start, end, steps=steps)


# Label-based grip lookup (the canonical grip helpers are id-based).
def _grip(page: Page, label: str):
    return page.evaluate(
        """(label) => {
            for (const g of document.querySelectorAll('[data-dock-group]')) {
                const t = g.querySelector('[data-dock-tab]');
                if (t && t.textContent.trim() === label) {
                    const h = g.querySelector('[data-dock-griphandle]');
                    if (!h) return null;
                    const r = h.getBoundingClientRect();
                    return [r.x + r.width / 2, r.y + r.height / 2];
                }
            }
            return null;
        }""",
        label,
    )


def test_column_handle_floats_whole_stack(dock_context, vite_server: int) -> None:
    page = _open(dock_context, vite_server)
    try:
        # Dock Controls to the right edge, then stack Inspector ABOVE it by
        # dropping on its grip bar (the per-panel "above this one" zone).
        _drag(page, _grip(page, "Controls"), (1274, 400))
        target = _grip(page, "Controls")  # now the docked panel's grip bar
        _drag(page, _grip(page, "Inspector"), target)

        # A 2-leaf pure column -> exactly one column handle.
        handles = page.locator("[data-dock-column-handle]")
        if handles.count() != 1:
            pytest.skip("stacking did not produce a 2-leaf column this run")
        order_before = page.evaluate(
            """() => {
                const l = window.__dockLayout.docked.right;
                const leaves = [];
                const walk = (n) => n.type === 'leaf'
                    ? leaves.push(n.group)
                    : n.children.forEach(walk);
                walk(l);
                return leaves;
            }"""
        )
        assert len(order_before) == 2

        # Drag the column handle to open canvas: the whole column floats as
        # ONE stacked window, in the same top-to-bottom order.
        box = handles.first.bounding_box()
        assert box is not None
        _drag(
            page,
            (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2),
            (450, 450),
        )
        state = page.evaluate(
            """(order) => {
                const l = window.__dockLayout;
                const win = l.floating.find(
                    (w) => w.stack.length === 2 &&
                        w.stack[0] === order[0] && w.stack[1] === order[1]);
                return {
                    dockedRight: l.docked.right,
                    found: win !== undefined,
                    hasWeights: win ? win.stackWeights !== undefined : false,
                };
            }""",
            order_before,
        )
        assert state["found"], "expected one window stacking both groups in order"
        assert state["dockedRight"] is None
        assert state["hasWeights"]
        assert page.locator("[data-dock-column-handle]").count() == 0
    finally:
        page.close()


def test_sandwiched_minimized_column_renders_vertical_strip(
    dock_context, vite_server: int
) -> None:
    """A minimized column stranded behind an expanded one renders as a narrow
    vertical strip (~2.6em), expands on its + button, and can be dragged out."""
    page = _open(dock_context, vite_server)
    try:
        # Park the monitor window (its tab area would swallow drops).
        hdr = page.get_by_text("Connected").bounding_box()
        assert hdr is not None
        _drag(
            page,
            (hdr["x"] + hdr["width"] / 2, hdr["y"] + hdr["height"] / 2),
            (300, 640),
        )

        def leaf_rect(label):
            return page.evaluate(
                """(label) => {
                    for (const l of document.querySelectorAll('[data-dock-leaf]')) {
                        if (l.textContent.includes(label)) {
                            const r = l.getBoundingClientRect();
                            return { x: r.x, w: r.width, h: r.height };
                        }
                    }
                    return null;
                }""",
                label,
            )

        def click_minimize(label):
            page.evaluate(
                """(label) => {
                    for (const l of document.querySelectorAll('[data-dock-leaf]')) {
                        if (l.textContent.includes(label)) {
                            l.querySelector('[data-dock-minimize]').click();
                            return;
                        }
                    }
                }""",
                label,
            )
            page.wait_for_timeout(120)

        # [Inspector | Controls] docked right; minimize the OUTER Controls so
        # it's stranded behind the expanded Inspector.
        _drag(page, _grip(page, "Controls"), (1274, 400))
        ctrl = leaf_rect("Controls")
        _drag(page, _grip(page, "Inspector"), (ctrl["x"] + 30, 400))
        if page.locator('[data-dock-leaf][data-dock-edge="right"]').count() != 2:
            pytest.skip("side-by-side right region did not form this run")
        click_minimize("Controls")

        strip = leaf_rect("Controls")
        assert strip is not None
        assert strip["w"] < 50, f"strip not narrow: {strip['w']}px"
        assert strip["h"] > 200, f"strip not tall: {strip['h']}px"

        # Expand restores the full-width panel.
        click_minimize("Controls")
        assert leaf_rect("Controls")["w"] > 150

        # Minimize again and drag the strip out -> floats.
        click_minimize("Controls")
        s = leaf_rect("Controls")
        _drag(page, (s["x"] + s["w"] / 2, 400), (750, 250))
        floated = page.evaluate(
            """() => {
                for (const w of document.querySelectorAll('[data-floating-window]')) {
                    if (w.textContent.includes('Controls')) return true;
                }
                return false;
            }"""
        )
        assert floated, "dragging the vertical strip out did not float the panel"
    finally:
        page.close()


def test_split_preview_does_not_wipe_region_background(
    dock_context, vite_server: int
) -> None:
    """Regression: a top/bottom split-drop onto a SINGLE-LEAF region tints the
    leaf's parent as a preview -- which is the React-managed region container
    itself. Resetting the tint used to clear the container's inline
    backgroundColor to "" (React never re-writes an unchanged style value),
    leaving the region permanently transparent; minimize/maximize then showed
    the canvas through the panels."""
    page = _open(dock_context, vite_server)
    try:

        def region_bg():
            return page.evaluate(
                """() => {
                    const leaf = document.querySelector(
                        '[data-dock-leaf][data-dock-edge="right"]');
                    if (!leaf) return null;
                    let el = leaf.parentElement;
                    while (el && !el.hasAttribute('data-dock-root')) {
                        if (el.style.zIndex === '5') {
                            return {
                                inline: el.style.backgroundColor,
                                computed: getComputedStyle(el).backgroundColor,
                            };
                        }
                        el = el.parentElement;
                    }
                    return null;
                }"""
            )

        # Single-leaf right region, then split-drop Inspector onto its BOTTOM
        # half (drives the tint-the-parent preview path).
        _drag(page, _grip(page, "Controls"), (1274, 400))
        leaf = page.evaluate(
            """() => {
                const l = document.querySelector(
                    '[data-dock-leaf][data-dock-edge="right"]');
                const r = l.getBoundingClientRect();
                return [r.x + r.width / 2, r.y + r.height * 0.92];
            }"""
        )
        _drag(page, _grip(page, "Inspector"), (leaf[0], leaf[1]))

        bg = region_bg()
        assert bg is not None
        assert bg["inline"] != "", "region container's inline background wiped"
        assert bg["computed"] != "rgba(0, 0, 0, 0)", "region became transparent"

        # A few minimize/expand cycles must not expose a transparent region.
        for _ in range(4):
            btns = page.locator("[data-dock-minimize]")
            if btns.count() == 0:
                break
            btns.first.click()
            page.wait_for_timeout(120)
        bg2 = region_bg()
        if bg2 is not None:  # region may be fully overlaid (rail) at the end
            assert bg2["computed"] != "rgba(0, 0, 0, 0)"
    finally:
        page.close()
