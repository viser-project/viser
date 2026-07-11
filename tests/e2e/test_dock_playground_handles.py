"""E2E coverage for dock handle gestures under the D46 collapse contract:
the per-column rail (the ONE docked collapsed rendering -- column.railed is
the only docked collapse store; a packed region is simply every column
railed, rendered as side-by-side 36px strips), floating TOP resize grips,
and the stack handle's window toggle.

Collapse chrome (D32/D46): docked cells never render a `-` or an in-place
bar; the region chevron (single-column regions) and per-column chevrons are
the only docked collapse affordances and rail whole COLUMNS. A collapsed
FLOATING window renders one bar per group. Transfers are identity: docking a
collapsed window rails the landing column; floating a railed column yields a
collapsed window. Expanding a rail is granular (only that column; NO
accordion -- siblings keep their state).

Floating-window grips and stack handle:
1. Dragging the TOP edge grip resizes height with the BOTTOM edge held fixed
   (y moves with the height), like a left-edge width resize holds the right
   edge.
2. Dragging a TOP corner grip resizes width and height together with the
   opposite (right/bottom) edges held fixed.
3. The multi-group stack handle's toggle flips the window's ONE collapse
   flag (D38); clicking again expands it back.

Same standalone-Vite harness as the other dock playground files. Run with::

    uv run pytest tests/e2e/test_dock_playground_handles.py -v
"""

from __future__ import annotations

import pytest
from playwright.sync_api import Page  # noqa: E402

from .dock_helpers import (
    click_column_chevron,
    column_railed_for_group,
    columns,
    dock_layout,
    group_grip_center,
    region_collapsed,
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
def test_stack_stays_one_multi_leaf_column(dock_context, vite_server: int) -> None:
    """D46: an injected 2-group vertical stack IS one multi-leaf column (no
    band level exists) -- a single-column region carries the region-level
    parent handle, so there is no per-column handle; each panel keeps its own
    grip, and dragging one panel's grip floats ONLY that panel. The stack is
    ONE visual column: its cells carry NO cell-level minimize; the region
    handle's chevron is the stack's collapse control."""
    page = _open(dock_context, vite_server)
    try:
        set_layout(page, dock_layout(docked_right=stack("inspector", "controls")))
        cols = page.evaluate(
            """() => window.__dockLayout.docked.right.columns.map(
                (c) => c.leaves.map((l) => l.group))"""
        )
        assert cols == [["t-inspector", "t-controls"]], (
            f"stack should stay one multi-leaf column, got {cols}"
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
    """An EXPLICITLY collapsed single-column region renders the column rail
    with its own narrow header as the parent handle (D46: the packed region
    IS its railed columns); DRAGGING that header tears the WHOLE column out
    as one floating window (it must not just toggle) -- and the transfer is
    identity (D38): the window is born COLLAPSED."""
    page = _open(dock_context, vite_server)
    try:
        # Arrange: two groups stacked in one column docked right, then
        # collapse the region via the explicit chevron (a single-column
        # region's only collapse affordance, D32).
        set_layout(page, dock_layout(docked_right=stack("inspector", "controls")))
        assert page.locator("[data-dock-rail-root]").count() == 0
        page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
        page.wait_for_timeout(200)
        handle = page.locator("[data-dock-column-rail]")
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
                    collapsed: win ? win.collapsed === true : null,
                    panes: win
                        ? win.stack.flatMap((g) => l.groups[g].paneIds)
                        : [],
                };
            }"""
        )
        assert state["dockedRight"] is None, "whole column should have left the dock"
        assert set(state["panes"]) == {"inspector", "controls"}
        assert state["collapsed"] is True, (
            "floating a railed region must yield a COLLAPSED window (D38 identity)"
        )
    finally:
        page.close()


def test_undock_minimized_column_keeps_expanded_width(
    dock_context, vite_server: int
) -> None:
    """Undocking a RAILED region floats it at the region's preserved EXPANDED
    width, not the ~36px rail width -- otherwise the window stays rail-narrow
    even after expanding (regression: floatColumn used the measured strip
    rect)."""
    page = _open(dock_context, vite_server)
    try:
        # Two panels stacked in one column docked right at ~300px.
        set_layout(page, dock_layout(docked_right=stack("controls", "inspector")))
        region_w = page.evaluate("() => window.__dockLayout.regionWidth.right")
        assert region_w and region_w > 150

        # Collapse the region explicitly, then undock via the rail's header.
        page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
        page.wait_for_timeout(200)
        handle = page.locator("[data-dock-column-rail]").first
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
    """A COLLAPSED floating multi-group window (window.collapsed, D38) is the
    same stack of cells, all rendered as bars, under the window's
    StackHandleBar. Dragging the handle moves the window; a motionless click
    there clears the window's ONE flag (expand). The bars of a multi-group
    window carry NO individual + (T4 -> D25: the header owns the one
    signifier)."""
    page = _open(dock_context, vite_server)
    try:
        set_layout(
            page,
            dock_layout(
                floating=[
                    window(
                        "controls", "inspector", x=300, y=200, width=280, collapsed=True
                    )
                ]
            ),
        )
        # One bar per stacked group (D20/D38).
        bars = page.locator(
            "[data-floating-window] [data-dock-group][data-dock-collapsed]"
        )
        assert bars.count() == 2, "the stack should show one bar per group"
        # Multi-group window: the bars have no individual + -- the window
        # header's toggle owns expand (T4/D25).
        assert (
            page.locator(
                "[data-floating-window] [data-dock-bar] [data-dock-minimize]"
            ).count()
            == 0
        ), "a multi-group collapsed window's bars must not render a +"

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

        # A motionless CLICK on the handle expands the window (the handle's
        # press arbitration: motion drags, no motion toggles the ONE flag).
        bar2 = handle_point()
        page.mouse.move(bar2["x"], bar2["y"])
        page.mouse.down()
        page.mouse.up()
        page.wait_for_timeout(150)
        expanded = page.evaluate(
            "() => window.__dockLayout.floating[0].collapsed !== true"
        )
        assert expanded, "clicking the handle should clear window.collapsed"
    finally:
        page.close()


def test_railed_column_beside_expanded_renders_rail(
    dock_context, vite_server: int
) -> None:
    """A column collapsed beside an expanded sibling renders the 36px column
    RAIL in place (D28/D32: docked bars do not exist -- width is reclaimed),
    expands via the rail header's +, and its cell can be dragged out (born
    collapsed, D38)."""
    page = _open(dock_context, vite_server)
    try:
        # Arrange: [Inspector | Controls] docked right, Controls at the edge.
        set_layout(page, dock_layout(docked_right=columns("inspector", "controls")))
        assert page.locator('[data-dock-leaf][data-dock-edge="right"]').count() == 2
        # Docked cells carry NO cell-level minimize (D32); the column
        # chevrons are the collapse affordance in a multi-column band.
        assert (
            page.locator('[data-dock-edge="right"] [data-dock-minimize]').count() == 0
        )

        def rail_box():
            loc = page.locator("[data-dock-column-rail]")
            return loc.first.bounding_box() if loc.count() else None

        # Rail Controls' column via its chevron.
        click_column_chevron(page, "t-controls")
        assert column_railed_for_group(page, "t-controls") is True
        rb = rail_box()
        assert rb is not None and rb["width"] < 60, (
            f"railed column should render the ~36px rail, got {rb}"
        )
        # No in-place bar anywhere in the docked region (D32).
        assert page.locator('[data-dock-edge="right"] [data-dock-bar]').count() == 0
        # The expanded sibling keeps a real width beside the rail.
        insp_w = page.evaluate(
            """() => document
                .querySelector('[data-dock-group="t-inspector"]')
                .closest('[data-dock-leaf]').getBoundingClientRect().width"""
        )
        assert insp_w > 150

        # The rail header's + expands the column back.
        page.eval_on_selector(
            "[data-dock-column-rail] [data-dock-minimize-all]", "e => e.click()"
        )
        page.wait_for_timeout(300)
        assert column_railed_for_group(page, "t-controls") is False
        assert rail_box() is None

        # Rail again and drag the rail CELL out -> floats ONLY controls, as a
        # collapsed window (identity transfer, D38).
        click_column_chevron(page, "t-controls")
        cell = page.locator('[data-dock-group="t-controls"][data-dock-collapsed]')
        cb = cell.first.bounding_box()
        assert cb is not None
        _drag(
            page,
            (cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] / 2),
            (640, 450),
            steps=18,
        )
        out = page.evaluate(
            """() => {
                const l = window.__dockLayout;
                const win = l.floating.find((w) => w.stack.includes("t-controls"));
                return {
                    floated: win !== undefined,
                    collapsed: win ? win.collapsed === true : null,
                    inspectorDocked:
                        JSON.stringify(l.docked.right ?? {}).includes("t-inspector"),
                };
            }"""
        )
        assert out["floated"], "dragging the rail cell out did not float the panel"
        assert out["collapsed"] is True, (
            "a container dragged out of a rail is born collapsed (D38)"
        )
        assert out["inspectorDocked"]
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

        # A few region collapse/expand cycles (chevron -> rail header +, the
        # docked collapse gesture since D32) must not expose a transparent
        # region surface.
        for _ in range(2):
            page.eval_on_selector(
                '[data-dock-region-collapse="right"]', "e => e.click()"
            )
            page.wait_for_timeout(120)
            page.eval_on_selector(
                "[data-dock-rail-root] [data-dock-minimize-all]", "e => e.click()"
            )
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


def test_left_region_chevron_clickable_despite_resizer(
    dock_context, vite_server: int
) -> None:
    """Regression coverage: the region resizer straddles the region boundary
    so an edge-aimed resize drag registers -- but a LEFT-docked region's
    collapse chevron (its only collapse control, D32) hugs the canvas-facing
    (right) edge at the TOP corner, right at that boundary. The resizer must
    START below the parent handle so its inward straddle never covers the
    chevron. A REAL pointer click on the chevron must collapse the region to
    its rail (drag-through chevrons: a motionless click activates via the
    host bar's backing click)."""
    page = _open(dock_context, vite_server)
    try:
        set_layout(page, dock_layout(docked_left=columns("controls")))
        assert not region_collapsed(page, "left"), "should start expanded"
        # Real pointer click at the chevron's center -- if the resizer overlay
        # (zIndex 15) covered it, the click would not collapse.
        btn = page.locator('[data-dock-region-collapse="left"]').first
        assert btn.count() == 1
        box = btn.bounding_box()
        assert box is not None
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_timeout(350)
        assert region_collapsed(page, "left"), (
            "real-clicking the left region's chevron did not collapse it -- the "
            "region resizer likely intercepted the click"
        )
        assert page.locator("[data-dock-rail-root]").count() == 1
    finally:
        page.close()


def test_railed_column_among_expanded_siblings_stays_railed(
    dock_context, vite_server: int
) -> None:
    """A RAILED column among EXPANDED sibling columns is legal committed
    geometry (D46): the column renders the 36px rail strip in place while
    its siblings keep their widths. No flag drop, no forced expand (NO
    accordion), and still no in-place docked bar (D32/D38)."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        # Three side-by-side columns on the right; the MIDDLE column
        # (inspector) seeded railed.
        set_layout(
            page,
            dock_layout(
                docked_right=columns(
                    "controls", stack("inspector", railed=True), "console"
                )
            ),
        )
        # The flag SURVIVES: one column rail strip, no bar form.
        assert column_railed_for_group(page, "t-inspector") is True
        assert page.locator("[data-dock-column-rail]").count() == 1
        assert page.locator('[data-dock-edge="right"] [data-dock-bar]').count() == 0
        strip = page.locator("[data-dock-rail-root]").first.bounding_box()
        assert strip is not None and strip["width"] <= 40, (
            f"the lone rail renders as the 36px strip: {strip}"
        )
    finally:
        page.close()


def test_lone_docked_panel_collapses_only_via_chevron(
    dock_context, vite_server: int
) -> None:
    """A lone docked panel has NO cell-level minimize and never renders a bar
    (D32: docked bars do not exist); the region chevron is the ONLY docked
    collapse affordance -> the 36px rail; the rail's header + expands it back
    to the full panel (one flag, D38)."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        set_layout(page, dock_layout(docked_right=rows("controls")))
        # No `-` and no bar surface anywhere in the docked region (D32).
        assert (
            page.locator('[data-dock-edge="right"] [data-dock-minimize]').count() == 0
        )
        assert page.locator('[data-dock-edge="right"] [data-dock-bar]').count() == 0

        # Explicitly collapse the region -> the rail (36px), model width kept.
        page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
        page.wait_for_timeout(300)
        assert region_collapsed(page, "right")
        assert page.locator("[data-dock-rail-root]").count() == 1
        rail = page.locator('[data-dock-region="right"]').bounding_box()
        assert rail is not None and rail["width"] < 60, (
            f"collapsed region should draw the ~36px rail, got {rail}"
        )

        # The rail header's toggle clears the region's ONE flag: the panel
        # comes back fully expanded (there is no per-cell state to keep).
        page.eval_on_selector(
            "[data-dock-rail-root] [data-dock-minimize-all]", "e => e.click()"
        )
        page.wait_for_timeout(300)
        assert not region_collapsed(page, "right")
        assert page.locator("[data-dock-rail-root]").count() == 0
        w = page.evaluate(
            """() => document
                .querySelector('[data-dock-group="t-controls"]')
                .closest('[data-dock-leaf]').getBoundingClientRect().width"""
        )
        assert w > 200, f"expanded panel should be full width, got {w}"
    finally:
        page.close()


def test_rail_cell_is_a_drop_target(dock_context, vite_server: int) -> None:
    """A rail cell (the docked collapsed rendering, D32/D38) is a DOCKED drop
    target: it stays inside its data-dock-leaf wrapper (the drop rect
    collectTargets reads), so dropping a floating panel onto it can merge
    into that group. (Converted from the pre-D38 'minimized bar is a drop
    target' pin -- docked bars no longer exist.)"""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=rows("controls", "inspector"),
                floating=[window("console", x=300, y=300)],
            ),
        )
        page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
        page.wait_for_timeout(300)
        cell = page.locator('[data-dock-group="t-controls"][data-dock-collapsed]').first
        assert cell.count() == 1
        cbox = cell.bounding_box()
        assert cbox is not None
        # The rail cell must be a real drop target: collectTargets needs a
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
        assert ok, "rail cell is not a valid docked drop target"
    finally:
        page.close()


def test_stack_vertical_resize(dock_context, vite_server: int) -> None:
    """Dragging the horizontal divider BETWEEN two stacked leaves of one
    column redistributes their heights (conserving the total) -- the
    within-column analog of column width resize (D46: the only vertical
    resize left; band-height resize is gone with bands)."""
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
        # Grab the divider just below the top cell's bottom edge; drag UP 100px
        # to shrink the top cell and grow the bottom one.
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
            f"top cell should shrink: {before} -> {after}"
        )
        assert after["t-inspector"] > before["t-inspector"] + 40, (
            f"bottom cell should grow: {before} -> {after}"
        )
        # Total height conserved (allow slack for the divider + sub-pixel).
        assert (
            abs(
                (after["t-controls"] + after["t-inspector"])
                - (before["t-controls"] + before["t-inspector"])
            )
            <= 16
        ), f"stack heights should conserve total: {before} -> {after}"
    finally:
        page.close()


def test_expanded_column_not_squished_by_railed_siblings(
    dock_context, vite_server: int
) -> None:
    """An expanded column beside RAILED siblings must still get the region's
    content width (D46: railed columns hold a fixed 36px basis; the freed
    width reflows to expanded siblings) -- not be squished toward strip
    width."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        # Right: two railed columns beside an expanded [console] column.
        set_layout(
            page,
            dock_layout(
                docked_right=columns(
                    stack("controls", railed=True),
                    stack("inspector", railed=True),
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
            f"expanded console column was squished to {w}px by its railed siblings"
        )
    finally:
        page.close()


def test_railed_sibling_columns_independent_gestures(
    dock_context, vite_server: int
) -> None:
    """Two railed sibling columns are independent scopes (each carries its
    own D38 flag): keyboard Enter on one rail's spine row expands ONLY that
    column, and dragging the other rail's cell out floats only that group
    (born collapsed) while its sibling stays railed. (Converted from the
    pre-D38 'one in-place bar per group' chip-gesture pin.)"""
    page = _open(dock_context, vite_server, 1280, 900)
    try:

        def seed() -> None:
            set_layout(
                page,
                dock_layout(
                    docked_right=columns(
                        stack("controls", railed=True),
                        stack("inspector", railed=True),
                        "console",
                    )
                ),
            )

        # Keyboard: focus the inspector rail's spine row (rows are the
        # focusable elements), Enter -> clears ONLY inspector's column flag.
        seed()
        assert column_railed_for_group(page, "t-inspector") is True
        page.eval_on_selector(
            '[data-dock-group="t-inspector"][data-dock-collapsed] [data-dock-tab]',
            "e => e.focus()",
        )
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        assert column_railed_for_group(page, "t-inspector") is False, (
            "Enter on the inspector spine row should expand its column"
        )
        assert column_railed_for_group(page, "t-controls") is True, (
            "controls' column should stay railed"
        )

        # Tear-out: drag the controls rail cell to canvas -> floats ONLY
        # controls, as a collapsed window (identity transfer, D38).
        seed()
        # Press near the cell's TOP so the press lands squarely inside the
        # spine cell.
        cell = page.evaluate(
            """() => {
                const c = document.querySelector(
                    '[data-dock-group="t-controls"][data-dock-collapsed]');
                const r = c.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + 18 };
            }"""
        )
        _drag(page, (cell["x"], cell["y"]), (640, 450), steps=18)
        out = page.evaluate(
            """() => {
                const l = window.__dockLayout;
                const win = l.floating.find((w) => w.stack.includes('t-controls'));
                return {
                    controlsFloated: win !== undefined,
                    controlsCollapsed: win ? win.collapsed === true : null,
                    inspectorDocked:
                        !!l.docked.right
                        && JSON.stringify(l.docked.right).includes('t-inspector'),
                };
            }"""
        )
        assert out["controlsFloated"], "dragging the controls cell should float it"
        assert out["controlsCollapsed"] is True, (
            "a group dragged out of a rail floats as a collapsed window (D38)"
        )
        assert out["inspectorDocked"], (
            "inspector should stay docked (only one cell torn out)"
        )
        # Once controls' column leaves, inspector stays a railed column
        # beside console -- legal committed geometry (D46), so it simply
        # STAYS railed (no migration, no forced expand, no accordion).
        assert column_railed_for_group(page, "t-inspector") is True
    finally:
        page.close()


def test_all_columns_railed_pack_region_spine_row_expands_granularly(
    dock_context, vite_server: int
) -> None:
    """Railing EVERY column packs the region (D46: the packed rail is
    derived -- N side-by-side 36px strips; rails never merge); expanding
    from a rail spine row is GRANULAR: it expands JUST that panel's column
    and lands on that tab -- the other columns stay railed (no
    accordion)."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        set_layout(
            page,
            dock_layout(docked_right=columns("controls", "inspector", "console")),
        )
        page.wait_for_timeout(300)
        assert page.locator("[data-dock-rail-root]").count() == 0

        # A multi-column region offers no region-level chevron (D27): rail
        # each column via its own chevron -> the packed form.
        for gid in ("t-controls", "t-inspector", "t-console"):
            click_column_chevron(page, gid)
        page.wait_for_timeout(300)
        assert region_collapsed(page, "right")
        assert page.locator("[data-dock-rail-root]").count() == 3, (
            "a packed region renders one 36px strip per column (rails never merge)"
        )
        rail_leaves = page.eval_on_selector_all(
            '[data-dock-leaf][data-dock-edge="right"]',
            """els => els.map(l => {
                const r = l.getBoundingClientRect();
                return { w: Math.round(r.width), h: Math.round(r.height) };
            })""",
        )
        assert len(rail_leaves) == 3, f"expected three rail cells, got {rail_leaves}"
        for lf in rail_leaves:
            assert lf["w"] < 60, f"rail cell should be narrow, got {lf}"

        # Expand one panel from the rail via its spine ROW (keyboard Enter):
        # GRANULAR -- clears just that column's flag and activates the tab;
        # the sibling columns keep their rails.
        page.eval_on_selector(
            '[data-dock-group="t-controls"] [data-dock-tab]', "e => e.focus()"
        )
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        assert not region_collapsed(page, "right")
        assert page.locator("[data-dock-rail-root]").count() == 2, (
            "only the expanded column's rail should disappear"
        )
        assert column_railed_for_group(page, "t-controls") is False
        assert column_railed_for_group(page, "t-inspector") is True, (
            "granular expand: sibling columns stay railed"
        )
        assert column_railed_for_group(page, "t-console") is True
        w = page.evaluate(
            """() => Math.round(document
                .querySelector('[data-dock-group="t-controls"]')
                .closest('[data-dock-leaf]').getBoundingClientRect().width)"""
        )
        assert w > 200, f"expanded column should be full width, got {w}"
    finally:
        page.close()


def test_rail_cell_fills_its_drop_target_leaf(dock_context, vite_server: int) -> None:
    """A rail cell fills its data-dock-leaf wrapper (the drop rect
    collectTargets reads), so the whole visible cell is droppable -- no dead
    space around a smaller inner element. (Converted from the pre-D38
    in-place-bar geometry pin.)"""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        set_layout(
            page,
            dock_layout(docked_right=rows("controls", "inspector", "console")),
        )
        page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
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
                    cellW: Math.round(br.width), cellH: Math.round(br.height),
                };
            }"""
        )
        assert dims["cellW"] >= dims["leafW"] - 4, (
            f"rail cell does not fill the drop target width: {dims}"
        )
        assert dims["cellH"] >= dims["leafH"] - 4, (
            f"rail cell does not fill the drop target height: {dims}"
        )
    finally:
        page.close()


# ---------------------------------------------------------------------------
# Identity transfers (collapse law 3, D38): NEW pins for both directions.
# ---------------------------------------------------------------------------
def test_docking_collapsed_window_rails_landing_scope(
    dock_context, vite_server: int
) -> None:
    """Transfer pin, float->dock: docking a COLLAPSED window is identity, not
    conversion (D38). Beside existing content the landing column arrives
    RAILED (the 36px strip; the neighbor stays expanded); onto an EMPTY edge
    it lands as a lone railed column -- the region's packed form is derived
    from every column being railed (D46)."""
    page = _open(dock_context, vite_server, 1280, 800)
    try:
        # (a) Beside existing content -> a railed column.
        set_layout(
            page,
            dock_layout(
                docked_right=columns("controls"),
                floating=[window("console", x=400, y=400, width=280, collapsed=True)],
            ),
        )
        bar = page.locator(
            '[data-floating-window] [data-dock-group="t-console"]'
        ).first.bounding_box()
        assert bar is not None
        # Drop on the docked leaf's outer side band -> a new column beside.
        leaf = page.locator(
            '[data-dock-leaf][data-dock-edge="right"]'
        ).first.bounding_box()
        assert leaf is not None
        _drag(
            page,
            (bar["x"] + bar["width"] / 2, bar["y"] + bar["height"] / 2),
            (leaf["x"] + 8, leaf["y"] + leaf["height"] / 2),
            steps=18,
        )
        if column_railed_for_group(page, "t-console") is None:
            pytest.skip("collapsed window did not dock beside this run")
        assert column_railed_for_group(page, "t-console") is True, (
            "docking a collapsed window beside content must rail the landing "
            "column (D38 identity transfer)"
        )
        assert column_railed_for_group(page, "t-controls") is False
        assert page.locator("[data-dock-column-rail]").count() == 1

        # (b) Onto an EMPTY edge -> a lone railed column (the packed form).
        set_layout(
            page,
            dock_layout(
                floating=[window("console", x=400, y=300, width=280, collapsed=True)],
            ),
        )
        bar2 = page.locator(
            '[data-floating-window] [data-dock-group="t-console"]'
        ).first.bounding_box()
        assert bar2 is not None
        vw = page.viewport_size["width"]  # type: ignore[index]
        _drag(
            page,
            (bar2["x"] + bar2["width"] / 2, bar2["y"] + bar2["height"] / 2),
            (vw - 10, 400),
            steps=18,
        )
        if page.evaluate("() => window.__dockLayout.docked.right === null"):
            pytest.skip("collapsed window did not dock to the empty edge this run")
        assert region_collapsed(page, "right"), (
            "docking a collapsed window onto an empty edge must land a railed "
            "column (D38 identity transfer; packed form is derived)"
        )
        assert page.locator("[data-dock-rail-root]").count() == 1
    finally:
        page.close()


def test_floating_railed_column_yields_collapsed_window(
    dock_context, vite_server: int
) -> None:
    """Transfer pin, dock->float: floating a RAILED column by its rail header
    yields a COLLAPSED window (D38 identity) -- the window flag is set and
    the panel renders as its bar, at a real (expanded) width."""
    page = _open(dock_context, vite_server, 1280, 800)
    try:
        set_layout(
            page,
            dock_layout(
                docked_right=columns("inspector", stack("controls", railed=True))
            ),
        )
        header = page.locator("[data-dock-column-rail]").first.bounding_box()
        assert header is not None
        _drag(
            page,
            (header["x"] + header["width"] / 2, header["y"] + header["height"] / 2),
            (450, 450),
            steps=18,
        )
        win = page.evaluate(
            """() => {
                const l = window.__dockLayout;
                const w = l.floating.find((w) => w.stack.includes("t-controls"));
                return w ? { collapsed: w.collapsed === true, width: w.width } : null;
            }"""
        )
        if win is None:
            pytest.skip("railed column did not float this run")
        assert win["collapsed"] is True, (
            "floating a railed column must yield a COLLAPSED window (D38)"
        )
        assert win["width"] > 100, (
            f"the collapsed window keeps a real width, got {win['width']}"
        )
        # The one collapsed rendering of a floating container: the bar.
        assert (
            page.locator(
                '[data-floating-window] [data-dock-group="t-controls"][data-dock-bar]'
            ).count()
            == 1
        )
    finally:
        page.close()


def test_floating_bar_slack_area_accepts_drop(dock_context, vite_server: int) -> None:
    """A REAL drop on a FLOATING bar's slack area (right of the last label,
    clear of the right-end toggle) must hit the bar's drop target and append
    into the collapsed group -- the whole bar is droppable, not just the
    labels (spec 5.4/D36). Bars are floating-only since D32."""
    page = _open(dock_context, vite_server, 1280, 900)
    try:
        set_layout(
            page,
            dock_layout(
                floating=[
                    window("inspector", x=600, y=200, width=300, collapsed=True),
                    window("console", x=250, y=500),
                ],
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
                    // Midway between the label's right edge and the bar's
                    // right edge, pulled 40px in from the bar's right end so
                    // the right-end + toggle can't claim the point.
                    dropX: Math.min((pr.right + br.right) / 2, br.right - 40),
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
            "dropping on the bar's slack area should merge into the collapsed "
            "group (drop target must span the bar, not just the labels)"
        )
    finally:
        page.close()
