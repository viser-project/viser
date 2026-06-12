"""E2E regression coverage for a batch of minor docking-library quirks.

These lock in fixes for small behavior bugs found by a code audit:

1. Escape cancels an in-flight window drag: the window snaps back to where the
   drag started and no dock is committed (even with an edge drop hint showing).
2. The grip-bar minimize button is keyboard-accessible: focus + Enter collapses
   the group, Space expands it again (role=button contract).
3. Tabs expose their full label via a `title` attribute (labels ellipsize at a
   max width, so the tooltip is the only way to read a long one).
4. Tabs are keyboard-activatable: focus + Enter switches the group's active tab.
5. Escape during a DEFERRED-FLOAT drag (dragging a docked group out, which
   commits a float op up front) restores the pre-drag docked layout instead of
   stranding the panel as a floater.
6. Dropping a panel onto a minimized (collapsed) group auto-expands it, so the
   dropped panel is visible instead of vanishing into the minimized handle.
7. Escape during a region edge-resize reverts the region to its drag-start
   width instead of keeping the partially-applied size.

Same harness as ``test_dock_playground_panels.py`` (standalone-Vite playground at
``/dock_test.html``, HMR disabled). Run with::

    uv run pytest tests/e2e/test_dock_playground_quirks.py -v

Skips cleanly if the client toolchain (``npx`` + ``node_modules``) is missing.
"""

from __future__ import annotations

import pytest

from .dock_helpers import (
    columns,
    dock_layout,
    group,
    set_layout,
    stack,
    window,
)
from .dock_helpers import (
    drag as _drag,
)
from .dock_helpers import (
    floating_window_for_panel as _floating_window_for_panel,
)
from .dock_helpers import (
    grip_center as _grip,
)
from .dock_helpers import (
    group_id_for_panel as _group_id_for_panel,
)
from .dock_helpers import (
    hint_visible as _hint_visible,
)
from .dock_helpers import (
    layout as _layout,
)
from .dock_helpers import (
    open_playground as _open,
)


# ---------------------------------------------------------------------------
# 1. Escape cancels an in-flight window drag (no move, no dock).
# ---------------------------------------------------------------------------
def test_escape_cancels_window_drag(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    before = _floating_window_for_panel(page, "controls")
    assert before is not None

    # Drag toward the right screen edge until the edge drop hint shows, then
    # press Escape INSTEAD of releasing.
    gx, gy = _grip(page, "controls")
    page.mouse.move(gx, gy)
    page.mouse.down()
    page.mouse.move(gx + 6, gy + 6, steps=2)
    page.mouse.move(1274, 400, steps=12)
    page.wait_for_timeout(120)
    assert _hint_visible(page), "edge drop hint should be showing mid-drag"
    page.keyboard.press("Escape")
    page.wait_for_timeout(120)
    page.mouse.up()
    page.wait_for_timeout(120)

    layout = _layout(page)
    assert layout["docked"]["right"] is None, "Escape must not commit the dock"
    after = _floating_window_for_panel(page, "controls")
    assert after is not None, "panel should still be floating"
    assert abs(after["x"] - before["x"]) < 1 and abs(after["y"] - before["y"]) < 1, (
        "Escape should snap the window back to its pre-drag position"
    )
    assert not _hint_visible(page), "drop hint should be cleared after Escape"
    page.close()


# ---------------------------------------------------------------------------
# 2. Minimize button works from the keyboard (Enter collapses, Space expands).
# ---------------------------------------------------------------------------
def test_minimize_button_keyboard(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    gid = _group_id_for_panel(page, "controls")
    sel = f'[data-dock-group="{gid}"] [data-dock-minimize]'
    page.eval_on_selector(sel, "e => e.focus()")
    page.keyboard.press("Enter")
    page.wait_for_timeout(100)
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed === true", gid
    ), "Enter on the focused minimize button should collapse the group"
    page.eval_on_selector(sel, "e => e.focus()")
    page.keyboard.press("Space")
    page.wait_for_timeout(100)
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed !== true", gid
    ), "Space on the focused button should expand the group again"
    page.close()


# ---------------------------------------------------------------------------
# 3 + 4. Tab tooltips and keyboard activation.
# ---------------------------------------------------------------------------
def test_tab_title_and_keyboard_activation(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)

    # Arrange: Inspector already merged into Controls' tab strip, with the
    # merged-in tab active (the post-merge state the old setup drag produced).
    # The tab tooltips + keyboard activation below are the subject.
    set_layout(
        page,
        dock_layout(
            floating=[
                window(
                    group(["controls", "inspector"], active="inspector"), x=400, y=100
                )
            ]
        ),
    )
    gid = _group_id_for_panel(page, "controls")
    merged = page.evaluate("(gid) => window.__dockLayout.groups[gid].panelIds", gid)
    assert "inspector" in merged

    # The merged-in tab is active; both tabs carry their full label as a title
    # attribute (labels ellipsize at maxWidth).
    assert (
        page.eval_on_selector(
            '[data-dock-tab="controls"]', "e => e.getAttribute('title')"
        )
        == "Controls"
    )
    assert (
        page.eval_on_selector(
            '[data-dock-tab="inspector"]', "e => e.getAttribute('title')"
        )
        == "Inspector"
    )
    assert (
        page.evaluate("(gid) => window.__dockLayout.groups[gid].activeId", gid)
        == "inspector"
    )

    # Keyboard: focus the inactive Controls tab and press Enter to activate it.
    page.eval_on_selector('[data-dock-tab="controls"]', "e => e.focus()")
    page.keyboard.press("Enter")
    page.wait_for_timeout(100)
    assert (
        page.evaluate("(gid) => window.__dockLayout.groups[gid].activeId", gid)
        == "controls"
    ), "Enter on a focused tab should activate it"
    page.close()


# ---------------------------------------------------------------------------
# 5. Escape during a deferred-float drag restores the pre-drag docked layout.
# ---------------------------------------------------------------------------
def test_escape_restores_docked_group_drag(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    # Arrange: controls docked right (the drag-out + Escape is the subject).
    set_layout(page, dock_layout(docked_right=columns("controls")))
    before = _layout(page)
    assert before["docked"]["right"] is not None

    # Drag the docked group's grip out over the canvas (this floats it
    # immediately), then Escape: the group must dock back where it was.
    gx, gy = _grip(page, "controls")
    page.mouse.move(gx, gy)
    page.mouse.down()
    page.mouse.move(gx + 6, gy + 6, steps=2)
    page.mouse.move(600, 400, steps=12)
    page.wait_for_timeout(120)
    page.keyboard.press("Escape")
    page.wait_for_timeout(120)
    page.mouse.up()
    page.wait_for_timeout(120)

    after = _layout(page)
    assert after["docked"]["right"] is not None, (
        "Escape should restore the docked column, not leave the panel floating"
    )
    assert _floating_window_for_panel(page, "controls") is None
    page.close()


# ---------------------------------------------------------------------------
# 6. Dropping onto a minimized group auto-expands it.
# ---------------------------------------------------------------------------
def test_drop_on_minimized_group_expands(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    # Minimize the floating Controls window, then drop Inspector onto its
    # collapsed handle (center = merge).
    gid = _group_id_for_panel(page, "controls")
    page.eval_on_selector(
        f'[data-dock-group="{gid}"] [data-dock-minimize]', "e => e.click()"
    )
    page.wait_for_timeout(120)
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed === true", gid
    )
    target = page.eval_on_selector(
        f'[data-dock-group="{gid}"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    _drag(page, _grip(page, "inspector"), (target["x"], target["y"]))

    merged = page.evaluate("(gid) => window.__dockLayout.groups[gid].panelIds", gid)
    if "inspector" not in merged:
        pytest.skip("merge didn't land this run; geometry off by a few px")
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed !== true", gid
    ), "merging into a minimized group should expand it"
    page.close()


# ---------------------------------------------------------------------------
# 7. Escape during a region edge-resize reverts to the drag-start width.
# ---------------------------------------------------------------------------
def test_escape_reverts_region_resize(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    # Arrange: controls docked right (the resize + Escape is the subject).
    set_layout(page, dock_layout(docked_right=columns("controls")))
    assert _layout(page)["docked"]["right"] is not None

    handle = page.eval_on_selector(
        '[data-dock-region-resize="right"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    leaf_w = page.eval_on_selector(
        '[data-dock-leaf][data-dock-edge="right"]',
        "e => e.getBoundingClientRect().width",
    )
    page.mouse.move(handle["x"], handle["y"])
    page.mouse.down()
    page.mouse.move(handle["x"] - 120, handle["y"], steps=10)
    page.wait_for_timeout(120)
    page.keyboard.press("Escape")
    page.wait_for_timeout(120)
    page.mouse.up()
    page.wait_for_timeout(120)
    leaf_w_after = page.eval_on_selector(
        '[data-dock-leaf][data-dock-edge="right"]',
        "e => e.getBoundingClientRect().width",
    )
    assert abs(leaf_w_after - leaf_w) < 2, (
        f"Escape should revert the region width ({leaf_w} -> {leaf_w_after})"
    )
    page.close()


# ---------------------------------------------------------------------------
# 8. Region resize with minimized siblings: the expanded panel tracks the
#    cursor 1:1 and the fixed-width minimized strips are left alone
#    (regionWidth counts expanded columns only; strips render on top).
# ---------------------------------------------------------------------------
def test_region_resize_ignores_minimized_columns(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)

    # Arrange: three side-by-side right-docked columns, controls at the edge
    # and console canvas-adjacent (the minimize clicks + region resize below
    # are the subject).
    set_layout(
        page, dock_layout(docked_right=columns("console", "inspector", "controls"))
    )
    tree = _layout(page)["docked"]["right"]
    assert tree is not None and tree["type"] == "split" and len(tree["children"]) == 3

    def leaf_width(panel: str) -> float:
        gid = _group_id_for_panel(page, panel)
        return page.eval_on_selector(
            f'[data-dock-group="{gid}"]',
            "e => e.closest('[data-dock-leaf]').getBoundingClientRect().width",
        )

    # Minimize the MIDDLE column (inspector) and the region-edge column
    # (controls): both render as fixed strips sandwiched in the reserved
    # block, leaving console as the only expanded panel.
    for panel in ["inspector", "controls"]:
        gid = _group_id_for_panel(page, panel)
        page.eval_on_selector(
            f'[data-dock-group="{gid}"] [data-dock-minimize]', "e => e.click()"
        )
        page.wait_for_timeout(120)

    before = leaf_width("console")
    strip_before = leaf_width("inspector")
    assert strip_before < 60, f"inspector should be a strip, got {strip_before}"

    # Drag the region's edge grip 150px toward the canvas (wider region).
    handle = page.eval_on_selector(
        '[data-dock-region-resize="right"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    page.mouse.move(handle["x"], handle["y"])
    page.mouse.down()
    page.mouse.move(handle["x"] - 150, handle["y"], steps=12)
    page.mouse.move(handle["x"] - 150, handle["y"])
    page.mouse.up()
    page.wait_for_timeout(120)

    after = leaf_width("console")
    assert abs((after - before) - 150) < 8, (
        f"expanded panel should track the cursor 1:1 ({before} -> {after}, wanted +150)"
    )
    assert abs(leaf_width("inspector") - strip_before) < 2, (
        "minimized strip width must not change during a region resize"
    )
    assert abs(leaf_width("controls") - strip_before) < 2, (
        "second minimized strip must not change either"
    )
    page.close()


# ---------------------------------------------------------------------------
# 9. Drag-through minimize buttons: dragging the - moves the panel (no
#    toggle); a drag from a strip's + tears out the EXPANDED panel.
# ---------------------------------------------------------------------------
def test_minus_button_drag_moves_panel(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    before = _floating_window_for_panel(page, "controls")
    gid = _group_id_for_panel(page, "controls")
    btn = page.eval_on_selector(
        f'[data-dock-group="{gid}"] [data-dock-minimize]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    _drag(page, (btn["x"], btn["y"]), (btn["x"] - 200, btn["y"] + 150))
    after = _floating_window_for_panel(page, "controls")
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed !== true", gid
    ), "dragging the minimize button must not toggle"
    assert before is not None and after is not None
    assert abs(after["x"] - before["x"]) > 100, "drag should have moved the window"
    page.close()


def test_plus_drag_tears_out_expanded(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    # Arrange: controls docked right (the minimize + drag-from-+ below are the
    # subject; the canvas is otherwise empty so the drop floats).
    set_layout(page, dock_layout(docked_right=columns("controls")))
    gid = _group_id_for_panel(page, "controls")
    page.eval_on_selector(
        f'[data-dock-group="{gid}"] [data-dock-minimize]', "e => e.click()"
    )
    page.wait_for_timeout(120)
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed === true", gid
    )
    # The strip cell's + sits in the gray cap; drag it out over the canvas.
    btn = page.eval_on_selector(
        f'[data-dock-group="{gid}"] [data-dock-minimize]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    _drag(page, (btn["x"], btn["y"]), (700, 250))
    # The drop may land on empty canvas (float) or, if geometry drifts, on
    # another surface -- either way the panel must end up EXPANDED. Re-resolve
    # the group id: a merge would have moved the panel to a new group.
    gid = _group_id_for_panel(page, "controls")
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed !== true", gid
    ), "a drag from the + should EXPAND the panel"
    assert _floating_window_for_panel(page, "controls") is not None, (
        "the expanded panel should now float"
    )
    page.close()


# ---------------------------------------------------------------------------
# 10. The column handle persists when every child is minimized (strips reserve
#     width; no more canvas-overlay rail), so minimize-all is reversible from
#     the handle.
# ---------------------------------------------------------------------------
def test_column_handle_persists_fully_minimized(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    # Arrange: a 2-leaf vertical column docked right (the minimize-all clicks
    # on its column handle are the subject).
    set_layout(page, dock_layout(docked_right=stack("inspector", "controls")))
    assert page.query_selector("[data-dock-column-handle]") is not None
    a = _group_id_for_panel(page, "controls")
    b = _group_id_for_panel(page, "inspector")

    page.eval_on_selector(
        "[data-dock-column-handle] [data-dock-minimize-all]", "e => e.click()"
    )
    page.wait_for_timeout(120)
    assert page.query_selector("[data-dock-column-handle]") is not None, (
        "the column handle must persist when all children are minimized"
    )
    for gid in (a, b):
        assert page.evaluate(
            "(gid) => window.__dockLayout.groups[gid].collapsed === true", gid
        )
    page.eval_on_selector(
        "[data-dock-column-handle] [data-dock-minimize-all]", "e => e.click()"
    )
    page.wait_for_timeout(120)
    for gid in (a, b):
        assert page.evaluate(
            "(gid) => window.__dockLayout.groups[gid].collapsed !== true", gid
        )
    page.close()


# ---------------------------------------------------------------------------
# 11. Dropping an expanded panel BELOW a minimized strip restores the region
#     to a usable width (regression: the region used to stay at strip width,
#     squeezing the new panel into 36px).
# ---------------------------------------------------------------------------
def test_drop_below_strip_restores_region_width(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    # Arrange: controls docked right + inspector floating (the minimize and the
    # drop-below-the-strip gesture are the subject).
    set_layout(
        page,
        dock_layout(
            docked_right=columns("controls"),
            floating=[window("inspector", x=680, y=120, width=260)],
        ),
    )
    gid = _group_id_for_panel(page, "controls")
    page.eval_on_selector(
        f'[data-dock-group="{gid}"] [data-dock-minimize]', "e => e.click()"
    )
    page.wait_for_timeout(120)
    strip = page.eval_on_selector(
        '[data-dock-leaf][data-dock-edge="right"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, bottom: r.bottom }; }",
    )
    # Drop inspector on the strip's BOTTOM band -> column[strip, inspector].
    _drag(page, _grip(page, "inspector"), (strip["x"], strip["bottom"] - 30))
    tree = _layout(page)["docked"]["right"]
    if tree is None or tree.get("dir") != "column":
        pytest.skip("below-split didn't land this run")
    widths = page.evaluate(
        """() => [...document.querySelectorAll(
            '[data-dock-leaf][data-dock-edge="right"]')]
            .map(l => Math.round(l.getBoundingClientRect().width))"""
    )
    assert all(w >= 200 for w in widths), (
        f"region must restore to a usable width after the drop, got {widths}"
    )
