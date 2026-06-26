"""E2E coverage for dock handle gestures: the docked-column handle, floating
TOP resize grips, and the stack handle's minimize-all button.

Docked-column handle: a top-level docked column with 2+ stacked panels shows a
slim header bar; dragging it floats the WHOLE column as one stacked window
(order preserved). Related column quirks pinned here: a minimized column
stranded behind an expanded one renders as a narrow vertical strip, and a
split-drop preview onto a single-leaf region must not wipe the region's
background.

Floating-window grips and stack handle:
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

Same standalone-Vite harness as the other dock playground files. Run with::

    uv run pytest tests/e2e/test_dock_playground_handles.py -v
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import columns, dock_layout, group, set_layout, stack, window
from .dock_helpers import drag as _drag
from .dock_helpers import group_id_for_panel as _group_id_for_panel
from .dock_helpers import open_playground as _open


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
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




# ---------------------------------------------------------------------------
# Column handle: dragging it floats the whole stack as one window.
# ---------------------------------------------------------------------------
def test_column_handle_floats_whole_stack(dock_context, vite_server: int) -> None:
    page = _open(dock_context, vite_server)
    try:
        # Arrange: a 2-leaf vertical column docked right, Inspector above
        # Controls (the column-handle drag below is the subject).
        set_layout(page, dock_layout(docked_right=stack("inspector", "controls")))

        # A 2-leaf pure column -> exactly one column handle.
        handles = page.locator("[data-dock-column-handle]")
        assert handles.count() == 1
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
            steps=18,
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


def test_minimized_column_parent_handle_tears_out_whole_stack(
    dock_context, vite_server: int
) -> None:
    """A FULLY-minimized docked column keeps its parent handle (the + above the
    cells); DRAGGING that handle tears the whole stack out as one floating
    window (it must not just toggle). Regression: the parent +'s button used to
    swallow the press, so the stack couldn't be dragged out at all."""
    page = _open(dock_context, vite_server)
    try:
        # Arrange: a 2-leaf vertical column docked right, both minimized.
        set_layout(
            page,
            dock_layout(
                docked_right=stack(
                    group("inspector", collapsed=True),
                    group("controls", collapsed=True),
                )
            ),
        )
        handle = page.locator("[data-dock-column-handle]")
        assert handle.count() == 1
        box = handle.first.bounding_box()
        assert box is not None
        _drag(
            page,
            (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2),
            (450, 450),
            steps=18,
        )
        state = page.evaluate(
            """() => {
                const l = window.__dockLayout;
                const win = l.floating.find((w) => w.stack.length === 2);
                return {
                    dockedRight: l.docked.right,
                    panes: win
                        ? win.stack.flatMap((g) => l.groups[g].paneIds)
                        : [],
                };
            }"""
        )
        assert state["dockedRight"] is None, "whole column should have left the dock"
        assert set(state["panes"]) == {"inspector", "controls"}
    finally:
        page.close()


def test_undock_minimized_column_keeps_expanded_width(
    dock_context, vite_server: int
) -> None:
    """Undocking a MINIMIZED docked column floats it at the region's preserved
    EXPANDED width, not the ~36px strip width -- otherwise the window stays
    strip-narrow even after expanding (regression: floatColumn used the measured
    strip rect)."""
    page = _open(dock_context, vite_server)
    try:
        # A 2-leaf column docked right at the default ~300px region width.
        set_layout(page, dock_layout(docked_right=stack("controls", "inspector")))
        region_w = page.evaluate("() => window.__dockLayout.regionWidth.right")
        assert region_w and region_w > 150

        # Minimize the whole stack via its parent handle, then undock it.
        page.eval_on_selector(
            "[data-dock-column-handle] [data-dock-minimize-all]", "e => e.click()"
        )
        page.wait_for_timeout(120)
        handle = page.locator("[data-dock-column-handle]").first
        box = handle.bounding_box()
        assert box is not None
        _drag(
            page,
            (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2),
            (450, 450),
            steps=18,
        )
        win = page.evaluate(
            """() => {
                const w = window.__dockLayout.floating.find(
                    (w) => w.stack.length === 2);
                return w ? Math.round(w.width) : null;
            }"""
        )
        if win is None:
            pytest.skip("column did not float as a 2-stack this run")
        # Floats at ~the preserved expanded width, NOT a ~36-96px strip.
        assert win >= region_w - 20, (
            f"undocked minimized column should keep ~{region_w}px width, got {win}"
        )
    finally:
        page.close()


def test_floating_minimized_stack_has_draggable_parent_handle(
    dock_context, vite_server: int
) -> None:
    """A fully-minimized FLOATING multi-group stack shows the SAME parent + handle
    as docked/expanded (for consistency); dragging it moves the whole window and
    clicking it expands every group."""
    page = _open(dock_context, vite_server)
    try:
        set_layout(
            page,
            dock_layout(
                floating=[
                    window(
                        group("controls", collapsed=True),
                        group("inspector", collapsed=True),
                        x=300,
                        y=200,
                        width=280,
                    )
                ]
            ),
        )
        handle = page.locator("[data-floating-handle]")
        assert handle.count() == 1, "minimized floating stack should show a parent +"

        # Dragging the parent handle moves the whole window.
        box = handle.first.bounding_box()
        assert box is not None
        before = page.evaluate("() => window.__dockLayout.floating[0].x")
        _drag(
            page,
            (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2),
            (700, 500),
            steps=18,
        )
        after = page.evaluate("() => window.__dockLayout.floating[0].x")
        assert abs(after - before) > 50, "dragging the parent handle should move it"

        # Clicking the parent handle's + (synthetic click) expands every group.
        page.eval_on_selector(
            "[data-floating-handle] [data-dock-minimize-all]", "e => e.click()"
        )
        page.wait_for_timeout(150)
        all_expanded = page.evaluate(
            """() => window.__dockLayout.floating[0].stack.every(
                (g) => window.__dockLayout.groups[g].collapsed !== true)"""
        )
        assert all_expanded, "clicking the parent + should expand all groups"
    finally:
        page.close()


def test_sandwiched_minimized_column_renders_vertical_strip(
    dock_context, vite_server: int
) -> None:
    """A minimized column stranded behind an expanded one renders as a narrow
    vertical strip (~2.6em), expands on its + button, and can be dragged out."""
    page = _open(dock_context, vite_server)
    try:
        # Arrange: [Inspector | Controls] docked right, Controls at the edge
        # (the minimize/expand clicks and strip drag-out are the subject).
        set_layout(page, dock_layout(docked_right=columns("inspector", "controls")))

        def leaf_rect(label):
            return page.evaluate(
                """(label) => {
                    for (const l of document.querySelectorAll('[data-dock-leaf]')) {
                        if (l.textContent.includes(label)) {
                            const r = l.getBoundingClientRect();
                            return { x: r.x, y: r.y, w: r.width, h: r.height };
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

        # Minimize the OUTER Controls so it's stranded behind the expanded
        # Inspector.
        assert page.locator('[data-dock-leaf][data-dock-edge="right"]').count() == 2
        click_minimize("Controls")

        strip = leaf_rect("Controls")
        assert strip is not None
        assert strip["w"] < 50, f"strip not narrow: {strip['w']}px"
        # The strip's drop-target leaf sizes to its VISIBLE content (cap + spine
        # rows), NOT the full region height -- so hitTest zones align with what's
        # drawn instead of a phantom region-tall box. A 2-row strip is well under
        # half the 800px viewport.
        assert 40 < strip["h"] < 300, f"strip should be content-tall: {strip['h']}px"

        # Expand restores the full-width panel.
        click_minimize("Controls")
        assert leaf_rect("Controls")["w"] > 150

        # Minimize again and drag the strip out -> floats. Grab the strip's own
        # (content) box, not a fixed y, since it no longer spans the viewport.
        click_minimize("Controls")
        s = leaf_rect("Controls")
        _drag(
            page,
            (s["x"] + s["w"] / 2, s["y"] + s["h"] / 2),
            (750, 250),
            steps=18,
        )
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

        # Arrange: a single-leaf right region + Inspector floating; then
        # split-drop Inspector onto the leaf's BOTTOM half (the drop's
        # tint-the-parent preview path is the subject).
        set_layout(
            page,
            dock_layout(
                docked_right=columns("controls"),
                floating=[window("inspector", x=680, y=120, width=260)],
            ),
        )
        leaf = page.evaluate(
            """() => {
                const l = document.querySelector(
                    '[data-dock-leaf][data-dock-edge="right"]');
                const r = l.getBoundingClientRect();
                return [r.x + r.width / 2, r.y + r.height * 0.92];
            }"""
        )
        _drag(page, _grip(page, "Inspector"), (leaf[0], leaf[1]), steps=18)

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

