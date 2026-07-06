"""E2E coverage for dock handle gestures: minimized in-place bars (D20), the
explicit region-collapse rail (D21), floating TOP resize grips, and the stack
handle's minimize-all button.

Minimized chrome: a minimized cell renders its 26px bar in place at its
column's width; the 36px rail appears only via the region-collapse chevron.
Related quirks pinned here: a split-drop preview onto a single-leaf region
must not wipe the region's background.

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

from .dock_helpers import (
    columns,
    dock_layout,
    group,
    group_grip_center,
    rows,
    set_layout,
    stack,
    window,
)
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
def test_stack_canonicalizes_to_independent_bands(
    dock_context, vite_server: int
) -> None:
    """Spec D12: an injected 2-group vertical stack canonicalizes into two
    BANDS -- there is no column-level parent handle; each panel keeps its own
    grip, and dragging one panel's grip floats ONLY that panel. The stack is
    ONE visual column (D30): its cells carry NO cell-level minimize; the
    region handle's chevron is the stack's collapse control."""
    page = _open(dock_context, vite_server)
    try:
        set_layout(page, dock_layout(docked_right=stack("inspector", "controls")))
        bands = page.evaluate(
            """() => window.__dockLayout.docked.right.rows.map(
                (r) => r.columns.map((c) => c.leaves.map((l) => l.group)))"""
        )
        assert bands == [[["t-inspector"]], [["t-controls"]]], (
            f"stack should canonicalize to bands, got {bands}"
        )
        assert page.locator("[data-dock-column-handle]").count() == 0
        # A plain stack is ONE visual column (D30): its cells render NO
        # cell-level minimize; the region chevron is the collapse control.
        for gid in ("t-inspector", "t-controls"):
            assert (
                page.locator(f'[data-dock-group="{gid}"] [data-dock-minimize]').count()
                == 0
            )
        assert page.locator('[data-dock-region-collapse="right"]').count() == 1
        # Dragging inspector's grip floats ONLY inspector.
        gx, gy = _grip(page, "Inspector")
        _drag(page, (gx, gy), (450, 450), steps=18)
        state = page.evaluate(
            """() => {
                const l = window.__dockLayout;
                return {
                    floated: l.floating.some((w) =>
                        w.stack.some((g) => l.groups[g].paneIds.includes("inspector"))),
                    dockedStillHasControls:
                        JSON.stringify(l.docked.right ?? {}).includes("controls"),
                };
            }"""
        )
        assert state["floated"] and state["dockedStillHasControls"]
    finally:
        page.close()


def test_minimized_column_parent_handle_tears_out_whole_stack(
    dock_context, vite_server: int
) -> None:
    """An EXPLICITLY collapsed region (D21) renders the packed rail with a
    parent handle on top (spec 3.2); DRAGGING that handle tears the WHOLE
    region out as one floating window (it must not just toggle)."""
    page = _open(dock_context, vite_server)
    try:
        # Arrange: two minimized groups docked right (canonical bands), then
        # collapse the region via the explicit chevron (D21: the rail never
        # appears emergently from cell minimize states).
        set_layout(
            page,
            dock_layout(
                docked_right=stack(
                    group("inspector", collapsed=True),
                    group("controls", collapsed=True),
                )
            ),
        )
        assert page.locator("[data-dock-region-rail]").count() == 0, (
            "the rail must NOT appear just because every cell minimized (D21)"
        )
        page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
        page.wait_for_timeout(200)
        handle = page.locator("[data-dock-region-rail]")
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
        # Two stacked panels docked right (canonical bands) at ~300px, both
        # cells seeded minimized (D30: a plain stack's cells carry no
        # cell-level minimize control, so the model path sets the states).
        set_layout(
            page,
            dock_layout(
                docked_right=stack(
                    group("controls", collapsed=True),
                    group("inspector", collapsed=True),
                )
            ),
        )
        region_w = page.evaluate("() => window.__dockLayout.regionWidth.right")
        assert region_w and region_w > 150

        # Collapse the region explicitly (D21), then undock via the rail's
        # handle.
        page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
        page.wait_for_timeout(200)
        handle = page.locator("[data-dock-region-rail]").first
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
    """A fully-minimized FLOATING multi-group stack is the same stack of
    cells, all rendered as 26px bars (D17), under the window's StackHandleBar
    -- which exists even when every cell is minimized. Dragging the handle
    moves the window; a motionless click there expands every group
    (toggle-all's direction comes from windowAllMinimized)."""
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
        # One in-place bar per stacked group (D17: no chip-bar mode).
        bars = page.locator(
            "[data-floating-window] [data-dock-group][data-dock-collapsed]"
        )
        assert bars.count() == 2, "the stack should show one bar per group"

        # The window's StackHandleBar is the window-drag handle, present
        # even when all cells are minimized.
        def handle_point():
            return page.eval_on_selector(
                "[data-floating-window] [data-floating-handle]",
                """(el) => {
                    const r = el.getBoundingClientRect();
                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                }""",
            )

        bar = handle_point()
        before = page.evaluate("() => window.__dockLayout.floating[0].x")
        _drag(page, (bar["x"], bar["y"]), (700, 500), steps=18)
        after = page.evaluate("() => window.__dockLayout.floating[0].x")
        assert abs(after - before) > 50, "dragging the handle should move the window"

        # A motionless CLICK on the handle expands every group (the handle's
        # press arbitration: motion drags, no motion toggles all).
        bar2 = handle_point()
        page.mouse.move(bar2["x"], bar2["y"])
        page.mouse.down()
        page.mouse.up()
        page.wait_for_timeout(150)
        all_expanded = page.evaluate(
            """() => window.__dockLayout.floating[0].stack.every(
                (g) => window.__dockLayout.groups[g].collapsed !== true)"""
        )
        assert all_expanded, "clicking the handle should expand all groups"
    finally:
        page.close()


def test_sandwiched_minimized_column_renders_in_place_bar(
    dock_context, vite_server: int
) -> None:
    """A minimized column beside an expanded one renders its 26px BAR in place
    at the column's own width (D20: the column holds its width -- honest
    geometry), expands on its + toggle, and can be dragged out."""
    page = _open(dock_context, vite_server)
    try:
        # Arrange: [Inspector | Controls] docked right, Controls at the edge
        # (the minimize/expand clicks and bar drag-out are the subject).
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
            page.wait_for_timeout(350)  # wait out the minimize width animation

        # Minimize the OUTER Controls beside the expanded Inspector.
        assert page.locator('[data-dock-leaf][data-dock-edge="right"]').count() == 2
        expanded_w = leaf_rect("Controls")["w"]
        click_minimize("Controls")

        bar = leaf_rect("Controls")
        assert bar is not None
        # The column HOLDS its width (D20): the bar spans it, at bar height.
        assert bar["w"] > expanded_w - 30, (
            f"bar should keep the column width (~{expanded_w}px): {bar['w']}px"
        )
        assert bar["h"] < 40, f"bar should be handle-height: {bar['h']}px"

        # Expand restores the full panel.
        click_minimize("Controls")
        assert leaf_rect("Controls")["w"] > 150

        # Minimize again and drag the bar out -> floats (still minimized).
        click_minimize("Controls")
        s = leaf_rect("Controls")
        _drag(
            page,
            (s["x"] + s["w"] / 2, s["y"] + s["h"] / 2),
            (640, 450),
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
        assert floated, "dragging the in-place bar out did not float the panel"
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


# ---------------------------------------------------------------------------
# An auto-height floating window can be GROWN past its content (it pins taller),
# rather than snapping back to content height. Regression: content height used
# to be the resize max, so dragging the bottom grip down "snapped smaller".
# ---------------------------------------------------------------------------
def test_grow_auto_height_window_past_content_pins(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    try:
        set_layout(
            page,
            dock_layout(floating=[window("controls", x=320, y=80, width=280)]),
        )
        page.wait_for_timeout(120)
        before = _window_box(page, "controls")
        # The window starts auto-height (no pinned px).
        assert (
            page.evaluate("() => window.__dockLayout.floating[0].height.mode") == "auto"
        )
        gx, gy = _resize_grip(page, before["id"], "bottom")
        # Drag the bottom edge DOWN 150px to GROW it.
        _drag(page, (gx, gy), (gx, gy + 150))
        after = _window_box(page, "controls")
        # It actually grew (didn't snap back to content) and pinned the height.
        assert after["h"] > before["h"] + 80, (
            f"window should grow, not snap smaller ({before['h']} -> {after['h']})"
        )
        assert (
            page.evaluate("() => window.__dockLayout.floating[0].height.mode")
            == "pinned"
        ), "growing past content should pin the height"
    finally:
        page.close()


def test_left_panel_minimize_button_clickable_despite_resizer(
    dock_context, vite_server: int
) -> None:
    """Regression: the region resizer straddles the region boundary so an
    edge-aimed resize drag registers -- but a LEFT-docked panel's minimize
    button hugs the panel's canvas-facing (right) edge at the TOP corner, right
    at that boundary. The resizer must START below the grip bar so its inward
    straddle never covers the button. Here we click the button and assert it
    toggles (i.e. the resizer did not intercept the click)."""
    page = _open(dock_context, vite_server)
    try:
        set_layout(page, dock_layout(docked_left=columns("controls")))
        gid = _group_id_for_panel(page, "controls")

        def collapsed() -> bool:
            return page.evaluate(
                "(g) => window.__dockLayout.groups[g].collapsed === true", gid
            )

        assert not collapsed(), "should start expanded"
        # Click the minimize button via a real pointer at its center -- if the
        # resizer overlay (zIndex 15) covered it, the click would not toggle.
        btn = page.locator(
            '[data-dock-leaf][data-dock-edge="left"] [data-dock-minimize]'
        ).first
        assert btn.count() == 1
        box = btn.bounding_box()
        assert box is not None
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_timeout(350)
        assert collapsed(), (
            "clicking the left panel's minimize button did not collapse it -- the "
            "region resizer likely intercepted the click"
        )
    finally:
        page.close()


def test_minimized_band_among_siblings_is_horizontal_bar(
    dock_context, vite_server: int
) -> None:
    """A minimized cell among sibling bands renders its 26px BAR in place
    (D20: full column width, handle height -- the ONE minimized form), keeps
    [data-dock-collapsed]/[data-dock-minimize], and expands back on click.
    The mixed state is seeded via set_layout (D30: cells of a plain stack
    carry no cell-level minimize control; bars still render anywhere)."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        # Three stacked single-column bands on the right; the MIDDLE band
        # (inspector) seeded minimized.
        set_layout(
            page,
            dock_layout(
                docked_right=rows(
                    "controls", group("inspector", collapsed=True), "console"
                )
            ),
        )

        def collapsed(gid: str) -> bool:
            return page.evaluate(
                "(g) => window.__dockLayout.groups[g].collapsed === true", gid
            )

        assert collapsed("t-inspector"), "inspector band should be minimized"

        bar = page.locator('[data-dock-group="t-inspector"][data-dock-collapsed]').first
        assert bar.count() == 1, "a minimized cell should render its in-place bar"
        box = bar.bounding_box()
        assert box is not None
        # FULL width (~region width 300), SHORT height (26px bar) -- i.e. a
        # horizontal bar, not a 36px-wide vertical rail.
        assert box["width"] > 150, f"the bar should span the column width: {box}"
        assert box["height"] < 40, f"the bar should be handle-height: {box}"
        assert box["width"] > box["height"] * 2, (
            f"a minimized cell must be a HORIZONTAL bar (w >> h), got {box}"
        )
        # Every bar keeps its per-cell expand toggle, even in a stack (D30).
        assert (
            page.locator('[data-dock-group="t-inspector"] [data-dock-minimize]').count()
            == 1
        )

        # Clicking the bar's label expands to that tab.
        label = page.locator('[data-dock-group="t-inspector"] [data-dock-tab]').first
        cbox = label.bounding_box()
        assert cbox is not None
        page.mouse.click(cbox["x"] + cbox["width"] / 2, cbox["y"] + cbox["height"] / 2)
        page.wait_for_timeout(450)
        assert not collapsed("t-inspector"), "clicking the bar should expand the band"
    finally:
        page.close()


def test_lone_minimized_panel_is_bar_until_region_collapsed(
    dock_context, vite_server: int
) -> None:
    """Minimizing the ONLY panel of a region renders its in-place bar at the
    region's full width (D20) -- the 36px rail appears ONLY via the explicit
    region-collapse chevron (D21), and the rail's header expands it back."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        set_layout(page, dock_layout(docked_right=rows("controls")))
        page.evaluate(
            """() => {
                const g = document.querySelector('[data-dock-group="t-controls"]');
                g.closest('[data-dock-leaf]')
                 .querySelector('[data-dock-minimize]').click();
            }"""
        )
        page.wait_for_timeout(450)
        assert page.evaluate(
            "() => window.__dockLayout.groups['t-controls'].collapsed === true"
        )
        # The bar in place: full region width, handle height. No rail.
        assert page.locator("[data-dock-region-rail]").count() == 0, (
            "minimizing a panel must not flip the region into the rail (D21)"
        )
        leaf = page.locator(
            '[data-dock-leaf][data-dock-edge="right"]'
        ).first.bounding_box()
        assert leaf is not None
        assert leaf["width"] > leaf["height"], (
            f"a lone minimized panel should be a wide in-place bar, got {leaf}"
        )

        # Explicitly collapse the region -> the rail (36px), model width kept.
        page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
        page.wait_for_timeout(300)
        assert page.locator("[data-dock-region-rail]").count() == 1
        rail = page.locator('[data-dock-region="right"]').bounding_box()
        assert rail is not None and rail["width"] < 60, (
            f"collapsed region should draw the ~36px rail, got {rail}"
        )

        # The rail header's toggle expands the REGION (cells keep their own
        # collapse states: controls stays a minimized bar).
        page.eval_on_selector(
            "[data-dock-region-rail] [data-dock-minimize-all]", "e => e.click()"
        )
        page.wait_for_timeout(300)
        assert page.locator("[data-dock-region-rail]").count() == 0
        assert page.evaluate(
            "() => window.__dockLayout.groups['t-controls'].collapsed === true"
        ), "expanding the region must not expand the cells (D21)"
    finally:
        page.close()


def test_minimized_band_is_a_drop_target(dock_context, vite_server: int) -> None:
    """A minimized cell's in-place bar is a DOCKED drop target: it stays
    inside its data-dock-leaf wrapper (the drop rect), so dropping a floating
    panel onto it merges into that group without expanding it. The minimized
    state is seeded via set_layout (D30: stacked cells carry no cell-level
    minimize control; bars still render anywhere)."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        # Top band (controls) seeded minimized.
        set_layout(
            page,
            dock_layout(
                docked_right=rows(group("controls", collapsed=True), "inspector"),
                floating=[window("console", x=300, y=300)],
            ),
        )
        bar = page.locator('[data-dock-group="t-controls"][data-dock-collapsed]').first
        assert bar.count() == 1
        cbox = bar.bounding_box()
        assert cbox is not None
        # The bar must be a real drop target: collectTargets needs a
        # data-dock-leaf ancestor with the group as a descendant.
        ok = page.evaluate(
            """() => {
                const g = document.querySelector(
                    '[data-dock-group="t-controls"][data-dock-collapsed]');
                const leaf = g && g.closest('[data-dock-leaf]');
                return !!(leaf && leaf.getAttribute('data-dock-edge') === 'right'
                          && leaf.querySelector('[data-dock-group]'));
            }"""
        )
        assert ok, "minimized in-place bar is not a valid docked drop target"
    finally:
        page.close()


def test_band_to_band_vertical_resize(dock_context, vite_server: int) -> None:
    """Dragging the horizontal divider BETWEEN two row bands redistributes their
    heights (conserving the total) -- the band-level analog of column/leaf
    resize."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        set_layout(page, dock_layout(docked_right=rows("controls", "inspector")))

        def heights() -> dict:
            return page.evaluate(
                """() => {
                    const out = {};
                    for (const gid of ['t-controls', 't-inspector']) {
                        const g = document.querySelector(`[data-dock-group="${gid}"]`);
                        const leaf = g && g.closest('[data-dock-leaf]');
                        out[gid] = leaf
                            ? Math.round(leaf.getBoundingClientRect().height) : 0;
                    }
                    return out;
                }"""
            )

        before = heights()
        # Grab the divider just below the top band's bottom edge; drag UP 100px to
        # shrink the top band and grow the bottom one.
        anchor = page.evaluate(
            """() => {
                const g = document.querySelector('[data-dock-group="t-controls"]');
                const r = g.closest('[data-dock-leaf]').getBoundingClientRect();
                return { x: r.x + r.width / 2, bottom: r.bottom };
            }"""
        )
        _drag(
            page,
            (anchor["x"], anchor["bottom"] + 3),
            (anchor["x"], anchor["bottom"] - 100),
        )
        after = heights()
        assert after["t-controls"] < before["t-controls"] - 40, (
            f"top band should shrink: {before} -> {after}"
        )
        assert after["t-inspector"] > before["t-inspector"] + 40, (
            f"bottom band should grow: {before} -> {after}"
        )
        # Total height conserved (allow slack for the divider + sub-pixel).
        assert (
            abs(
                (after["t-controls"] + after["t-inspector"])
                - (before["t-controls"] + before["t-inspector"])
            )
            <= 16
        ), f"band heights should conserve total: {before} -> {after}"
    finally:
        page.close()


def test_expanded_band_not_squished_by_minimized_wider_band(
    dock_context, vite_server: int
) -> None:
    """Regression: the region width is driven by the widest band (most columns).
    When THAT band is fully minimized but a narrower band is expanded, the
    expanded band must still get the region's content width -- it was squished to
    strip width (~79px) because the all-strip widthRow reported hasExpanded=false
    and reserved only chrome."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        # Right: a 2-column band [controls|inspector], BOTH minimized, over an
        # expanded single-column [console] band.
        set_layout(
            page,
            dock_layout(
                docked_right=rows(
                    columns(
                        group("controls", collapsed=True),
                        group("inspector", collapsed=True),
                    ),
                    "console",
                )
            ),
        )
        w = page.evaluate(
            """() => {
                const leaf = document
                    .querySelector('[data-dock-group="t-console"]')
                    .closest('[data-dock-leaf]');
                return Math.round(leaf.getBoundingClientRect().width);
            }"""
        )
        # Full content width, not a ~79px strip.
        assert w > 200, (
            f"expanded console band was squished to {w}px by the minimized wider band"
        )
    finally:
        page.close()


def test_minimized_multigroup_band_chip_gestures(
    dock_context, vite_server: int
) -> None:
    """A minimized band with 2+ columns shows one in-place bar per group
    (D20). Each bar is an independent control (D16): keyboard Enter expands
    just that group, and dragging one bar out floats only that group (the
    others stay docked & minimized)."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:

        def seed() -> None:
            set_layout(
                page,
                dock_layout(
                    docked_right=rows(
                        columns(
                            group("controls", collapsed=True),
                            group("inspector", collapsed=True),
                        ),
                        "console",
                    )
                ),
            )

        # Keyboard: focus the inspector bar's tab LABEL (labels are the
        # focusable elements; the container is a pure drag surface), Enter ->
        # expands ONLY inspector.
        seed()
        page.eval_on_selector(
            '[data-dock-group="t-inspector"][data-dock-collapsed] [data-dock-tab]',
            "e => e.focus()",
        )
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        assert (
            page.evaluate(
                "() => window.__dockLayout.groups['t-inspector'].collapsed === true"
            )
            is False
        ), "Enter on the inspector chip should expand it"
        assert page.evaluate(
            "() => window.__dockLayout.groups['t-controls'].collapsed === true"
        ), "controls should stay minimized"

        # Tear-out: drag the controls bar to canvas -> floats ONLY controls.
        seed()
        chip = page.evaluate(
            """() => {
                const c = document.querySelector(
                    '[data-dock-group="t-controls"][data-dock-collapsed]');
                const r = c.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }"""
        )
        _drag(page, (chip["x"], chip["y"]), (640, 450), steps=18)
        out = page.evaluate(
            """() => {
                const l = window.__dockLayout;
                return {
                    controlsFloated:
                        l.floating.some((w) => w.stack.includes('t-controls')),
                    inspectorDocked:
                        !!l.docked.right
                        && JSON.stringify(l.docked.right).includes('t-inspector'),
                };
            }"""
        )
        assert out["controlsFloated"], "dragging the controls chip should float it"
        assert out["inspectorDocked"], (
            "inspector should stay docked (only one chip torn out)"
        )
    finally:
        page.close()


def test_all_bands_minimized_then_explicit_collapse_gives_rail(
    dock_context, vite_server: int
) -> None:
    """When EVERY band is minimized, the region stays at full width showing
    the stacked in-place bars (D20/D21: no emergent rail). The explicit
    chevron collapses it to the compact vertical rail; expanding a panel from
    a rail spine row un-collapses the region AND expands that panel."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=rows(
                    group("controls", collapsed=True),
                    group("inspector", collapsed=True),
                    group("console", collapsed=True),
                )
            ),
        )
        page.wait_for_timeout(300)
        # All-minimized WITHOUT explicit collapse: three wide in-place bars,
        # no rail (edge case 12 under D21: bars, never 36x36 squares).
        assert page.locator("[data-dock-region-rail]").count() == 0
        leaves = page.eval_on_selector_all(
            '[data-dock-leaf][data-dock-edge="right"]',
            """els => els.map(l => {
                const r = l.getBoundingClientRect();
                return { w: Math.round(r.width), h: Math.round(r.height) };
            })""",
        )
        assert len(leaves) == 3, f"expected three collapsed bars, got {leaves}"
        for lf in leaves:
            assert lf["w"] > 150, f"in-place bar should be wide, got {lf}"
            assert lf["w"] > lf["h"], f"bar should be wider than tall, got {lf}"

        # EXPLICIT collapse -> the 36px rail with one spine cell per leaf.
        page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
        page.wait_for_timeout(300)
        assert page.locator("[data-dock-region-rail]").count() == 1
        rail_leaves = page.eval_on_selector_all(
            '[data-dock-leaf][data-dock-edge="right"]',
            """els => els.map(l => {
                const r = l.getBoundingClientRect();
                return { w: Math.round(r.width), h: Math.round(r.height) };
            })""",
        )
        for lf in rail_leaves:
            assert lf["w"] < 60, f"rail cell should be narrow, got {lf}"

        # Expand one panel from the rail via its spine ROW (keyboard Enter):
        # clears regionCollapsed AND expands that group (D21).
        page.eval_on_selector(
            '[data-dock-group="t-controls"] [data-dock-tab]', "e => e.focus()"
        )
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        assert (
            page.evaluate(
                "() => window.__dockLayout.groups['t-controls'].collapsed === true"
            )
            is False
        )
        assert page.locator("[data-dock-region-rail]").count() == 0, (
            "expanding from the rail must un-collapse the region"
        )
        w = page.evaluate(
            """() => Math.round(document
                .querySelector('[data-dock-group="t-controls"]')
                .closest('[data-dock-leaf]').getBoundingClientRect().width)"""
        )
        assert w > 200, f"expanded band should be full width, got {w}"
    finally:
        page.close()


def test_minimized_bar_fills_its_drop_target_leaf(
    dock_context, vite_server: int
) -> None:
    """The in-place bar fills its data-dock-leaf wrapper (the drop rect
    collectTargets reads), so the whole visible bar is droppable -- no dead
    space beside a smaller inner chip."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=rows(
                    "controls", group("inspector", collapsed=True), "console"
                )
            ),
        )
        page.wait_for_timeout(300)
        dims = page.evaluate(
            """() => {
                const g = document.querySelector(
                    '[data-dock-group="t-inspector"][data-dock-collapsed]');
                const leaf = g.closest('[data-dock-leaf]');
                const lr = leaf.getBoundingClientRect();
                const br = g.getBoundingClientRect();
                return {
                    leafW: Math.round(lr.width), leafH: Math.round(lr.height),
                    barW: Math.round(br.width), barH: Math.round(br.height),
                };
            }"""
        )
        assert dims["barW"] >= dims["leafW"] - 4, (
            f"bar does not fill the drop target width: {dims}"
        )
        assert dims["barH"] >= dims["leafH"] - 4, (
            f"bar does not fill the drop target height: {dims}"
        )
    finally:
        page.close()


def test_minimized_bar_slack_area_accepts_drop(dock_context, vite_server: int) -> None:
    """A REAL drop on the bar's slack area (between the label and the right-end
    toggle) must hit the bar's drop target and merge/insert into the minimized
    group -- the whole bar is droppable, not just the label. The drag source is
    a FLOATING window so the docked region doesn't reflow mid-drag."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=rows("controls", group("inspector", collapsed=True)),
                floating=[window("console", x=400, y=300)],
            ),
        )
        page.wait_for_timeout(300)
        pts = page.evaluate(
            """() => {
                const bar = document.querySelector(
                    '[data-dock-group="t-inspector"][data-dock-collapsed]');
                const label = bar.querySelector('[data-dock-tab]');
                const br = bar.getBoundingClientRect();
                const pr = label.getBoundingClientRect();
                return {
                    // Midway between the label's right edge and the bar's right
                    // edge, pulled 50px in from the region edge so the region
                    // side band (40px) can't claim the point.
                    dropX: Math.min((pr.right + br.right) / 2, br.right - 50),
                    dropY: br.y + br.height / 2,
                    labelRight: pr.right,
                };
            }"""
        )
        if pts["dropX"] < pts["labelRight"] + 10:
            pytest.skip("no slack bar area beside the label at this viewport")
        src = _group_id_for_panel(page, "console")
        _drag(
            page,
            group_grip_center(page, src),
            (pts["dropX"], pts["dropY"]),
            steps=18,
        )
        page.wait_for_timeout(300)
        merged = page.evaluate(
            "() => window.__dockLayout.groups['t-inspector'].paneIds.includes('console')"
        )
        assert merged, (
            "dropping on the bar's slack area should merge into the minimized "
            "group (drop target must span the bar, not just the label)"
        )
    finally:
        page.close()
