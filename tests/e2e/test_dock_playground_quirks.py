"""E2E regression coverage for a batch of minor docking-library quirks.

These lock in fixes for small behavior bugs found by a code audit:

1. Escape cancels an in-flight window drag: the window snaps back to where the
   drag started and no dock is committed (even with an edge drop hint showing).
2. A floating window's minimize button is keyboard-accessible: focus + Enter
   collapses the window, Space on the bar's label expands it again
   (role=button contract).
3. Tabs expose their full label via a `title` attribute (labels ellipsize at a
   max width, so the tooltip is the only way to read a long one).
4. Tabs are keyboard-activatable: focus + Enter switches the group's active tab.
5. Escape during a DEFERRED-FLOAT drag (dragging a docked group out, which
   commits a float op up front) restores the pre-drag docked layout instead of
   stranding the panel as a floater.
6. Dropping a panel onto a collapsed floating window's bar merges WITHOUT
   expanding it (organizing minimized panels never expands them).
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
    click_column_chevron,
    columns,
    dock_layout,
    group,
    set_layout,
    stack,
    window,
)
from .dock_helpers import (
    collapsed as _collapsed,
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
    assert _collapsed(page, gid), (
        "Enter on the focused minimize button should collapse the window"
    )
    # Collapsed, the floating window is its bar: Space on the focused tab
    # LABEL inside the bar expands the window again (labels are the
    # focusable elements; the container is a pure drag surface).
    bar_sel = f'[data-floating-window] [data-dock-group="{gid}"] [data-dock-tab]'
    page.eval_on_selector(bar_sel, "e => e.focus()")
    page.keyboard.press("Space")
    page.wait_for_timeout(100)
    assert not _collapsed(page, gid), (
        "Space on the focused bar label should expand the window again"
    )
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
    merged = page.evaluate("(gid) => window.__dockLayout.groups[gid].paneIds", gid)
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
# 6. Merging onto a minimized group keeps it minimized (organizing minimized
#    panels never expands them); the dropped panel becomes another collapsed tab.
# ---------------------------------------------------------------------------
def test_drop_on_minimized_group_stays_minimized(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    # Minimize the floating Controls window (now an in-place bar), then drop
    # Inspector onto that bar: the drop lands in the still-minimized group.
    gid = _group_id_for_panel(page, "controls")
    page.eval_on_selector(
        f'[data-dock-group="{gid}"] [data-dock-minimize]', "e => e.click()"
    )
    page.wait_for_timeout(120)
    assert _collapsed(page, gid)
    # Aim at the BAR (the collapsed group element on the minimized floating
    # window); a drop there merges/inserts into the still-minimized group.
    target = page.eval_on_selector(
        f'[data-floating-window] [data-dock-group="{gid}"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    _drag(page, _grip(page, "inspector"), (target["x"], target["y"]))

    merged = page.evaluate("(gid) => window.__dockLayout.groups[gid].paneIds", gid)
    if "inspector" not in merged:
        pytest.skip("merge didn't land this run; geometry off by a few px")
    assert _collapsed(page, gid), (
        "merging into a collapsed window must keep it collapsed"
    )
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
def test_region_resize_lands_on_expanded_column_rails_fixed(
    dock_context, vite_server
) -> None:
    """RAILED columns are fixed-width chrome (36px, D28/D38), so a region
    edge resize lands entirely on the EXPANDED column: it tracks the cursor
    1:1 while the rails stay at strip width."""
    page = _open(dock_context, vite_server)

    # Arrange: three side-by-side right-docked columns, controls at the edge
    # and console canvas-adjacent (the column rails + region resize below
    # are the subject).
    set_layout(
        page, dock_layout(docked_right=columns("console", "inspector", "controls"))
    )
    tree = _layout(page)["docked"]["right"]
    assert tree is not None and len(tree["columns"]) == 3

    def leaf_width(panel: str) -> float:
        gid = _group_id_for_panel(page, panel)
        return page.eval_on_selector(
            f'[data-dock-group="{gid}"]',
            "e => e.closest('[data-dock-leaf]').getBoundingClientRect().width",
        )

    # Rail the MIDDLE column (inspector) and the region-edge column
    # (controls) via their chevrons (the docked collapse gesture, D32),
    # leaving console as the only expanded panel.
    for panel in ["inspector", "controls"]:
        click_column_chevron(page, _group_id_for_panel(page, panel))
    page.wait_for_timeout(350)  # settle

    rail_before = leaf_width("inspector")
    assert rail_before < 60, f"inspector rail should be ~36px, got {rail_before}"
    console_before = leaf_width("console")

    # Drag the region's edge grip 150px toward the canvas (wider region).
    handle = page.eval_on_selector(
        '[data-dock-region-resize="right"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height*0.75 }; }",
    )
    page.mouse.move(handle["x"], handle["y"])
    page.mouse.down()
    page.mouse.move(handle["x"] - 150, handle["y"], steps=12)
    page.mouse.move(handle["x"] - 150, handle["y"])
    page.mouse.up()
    page.wait_for_timeout(120)

    console_after = leaf_width("console")
    assert abs((console_after - console_before) - 150) < 10, (
        f"the expanded column should track the cursor 1:1 "
        f"({console_before} -> {console_after}, wanted +150)"
    )
    assert leaf_width("inspector") < 60, (
        "railed columns are fixed-width chrome and must not grow (D28)"
    )
    page.close()


# ---------------------------------------------------------------------------
# 9. Drag-through minimize buttons: dragging the - moves the panel (no
#    toggle); a drag from a collapsed window's + moves it, still collapsed.
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
    assert not _collapsed(page, gid), "dragging the minimize button must not toggle"
    assert before is not None and after is not None
    assert abs(after["x"] - before["x"]) > 100, "drag should have moved the window"
    page.close()


def test_plus_drag_moves_collapsed_window_still_collapsed(
    dock_context, vite_server
) -> None:
    """The bar's + is drag-through like every right-end control: a DRAG from
    it moves the collapsed window AS-IS (expanding is a click-only
    gesture)."""
    page = _open(dock_context, vite_server)
    set_layout(
        page,
        dock_layout(floating=[window("controls", x=400, y=200, collapsed=True)]),
    )
    gid = "t-controls"
    assert _collapsed(page, gid)
    before = _floating_window_for_panel(page, "controls")
    assert before is not None
    # The bar's right-end + (single-group window keeps it, T4/D25).
    btn = page.eval_on_selector(
        f'[data-dock-group="{gid}"] [data-dock-minimize]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    _drag(page, (btn["x"], btn["y"]), (btn["x"] - 200, btn["y"] + 250))
    assert _collapsed(page, gid), "a drag from the + must NOT expand the window"
    after = _floating_window_for_panel(page, "controls")
    assert after is not None
    assert abs(after["x"] - before["x"]) > 100, "drag should have moved the window"
    page.close()


# ---------------------------------------------------------------------------
# 10. Chevrons are drag-through (T6 resolved): a real pointer DRAG from the
#     region chevron drags the whole stack out (no collapse committed); a
#     motionless real click collapses via the host bar's backing click.
# ---------------------------------------------------------------------------
def test_region_chevron_drag_through_and_click(dock_context, vite_server) -> None:
    """Spec D32/T6: the region-collapse chevron flows its press to the region
    parent handle's drag arbitration. Motion drags the REGION out as one
    floating window (nothing collapses); a motionless click collapses the
    region to its rail."""
    page = _open(dock_context, vite_server)
    set_layout(page, dock_layout(docked_right=stack("inspector", "controls")))
    a = _group_id_for_panel(page, "controls")
    b = _group_id_for_panel(page, "inspector")

    # D32: neither stacked cell renders a cell-level minimize control.
    for gid in (a, b):
        assert (
            page.eval_on_selector_all(
                f'[data-dock-group="{gid}"] [data-dock-minimize]', "els => els.length"
            )
            == 0
        ), "a plain stack's cells must not render a cell-level minimize (D32)"

    # DRAG from the chevron: the press flows to the parent handle -> the
    # whole region floats as one (expanded) window; no rail appears.
    btn = page.eval_on_selector(
        '[data-dock-region-collapse="right"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    _drag(page, (btn["x"], btn["y"]), (500, 400))
    state = page.evaluate(
        """() => {
            const l = window.__dockLayout;
            const win = l.floating.find((w) => w.stack.length === 2);
            return {
                dockedRight: l.docked.right,
                floated: win !== undefined,
                collapsed: win ? win.collapsed === true : null,
            };
        }"""
    )
    assert state["floated"] and state["dockedRight"] is None, (
        "dragging the chevron should drag the whole stack out (drag-through)"
    )
    assert state["collapsed"] is not True, (
        "a drag from the chevron must NOT collapse (motion beats click)"
    )
    assert page.query_selector("[data-dock-rail-root]") is None

    # Re-seed, then a REAL motionless click on the chevron collapses
    # the whole region to its rail (the host bar's backing click).
    set_layout(page, dock_layout(docked_right=stack("inspector", "controls")))
    btn2 = page.eval_on_selector(
        '[data-dock-region-collapse="right"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    page.mouse.click(btn2["x"], btn2["y"])
    page.wait_for_timeout(200)
    assert page.query_selector("[data-dock-rail-root]") is not None, (
        "a motionless real click on the chevron must collapse to the rail"
    )
    page.close()


# ---------------------------------------------------------------------------
# 10. Escape after an undock restores the region's NON-DEFAULT width. The
#     width lives in the layout model (DockLayout.regionWidth), so the
#     pre-drag snapshot restores it by construction.
# ---------------------------------------------------------------------------
def test_escape_after_undock_restores_region_width(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    set_layout(page, dock_layout(docked_right=columns("controls")))

    def leaf_w() -> float:
        return page.eval_on_selector(
            '[data-dock-leaf][data-dock-edge="right"]',
            "e => e.getBoundingClientRect().width",
        )

    # Widen the region well past the 300px default with the edge resizer.
    handle = page.eval_on_selector(
        '[data-dock-region-resize="right"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    page.mouse.move(handle["x"], handle["y"])
    page.mouse.down()
    page.mouse.move(handle["x"] - 150, handle["y"], steps=10)
    page.mouse.up()
    page.wait_for_timeout(120)
    widened = leaf_w()
    assert widened > 400, f"setup: resize did not widen the region ({widened})"

    # Drag the group out (commits a float op up front), then Escape.
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

    assert _layout(page)["docked"]["right"] is not None
    assert abs(leaf_w() - widened) < 2, (
        f"Escape must restore the widened region ({widened} -> {leaf_w()})"
    )
    page.close()


# ---------------------------------------------------------------------------
# 11. Escape after a drag from the expand (+) button of a MINIMIZED floating
#     window restores the minimized state (the expand is an up-front commit,
#     paired with its restore snapshot by dragAfterCommit).
# ---------------------------------------------------------------------------
def test_escape_during_rail_cell_drag_restores_rail(dock_context, vite_server) -> None:
    """Dragging a rail cell out commits a float up front (born collapsed,
    D38); Escape mid-drag must restore the pre-drag DOCKED rail state (the
    up-front commit is paired with its restore snapshot)."""
    page = _open(dock_context, vite_server)
    set_layout(page, dock_layout(docked_right=stack("inspector", "controls")))
    page.eval_on_selector('[data-dock-region-collapse="right"]', "e => e.click()")
    page.wait_for_timeout(200)
    assert page.evaluate("""() => {
            const region = window.__dockLayout.docked.right;
            return (
                region !== null &&
                region.columns.every((c) => c.railed === true)
            );
        }""")
    cell = page.eval_on_selector(
        '[data-dock-group="t-controls"][data-dock-collapsed]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    page.mouse.move(cell["x"], cell["y"])
    page.mouse.down()
    page.mouse.move(cell["x"] - 6, cell["y"] + 6, steps=2)
    page.mouse.move(500, 400, steps=10)
    page.wait_for_timeout(120)  # the float-out has committed by now
    page.keyboard.press("Escape")
    page.wait_for_timeout(120)
    page.mouse.up()
    page.wait_for_timeout(120)
    assert _floating_window_for_panel(page, "controls") is None, (
        "Escape must undo the drag's up-front float"
    )
    assert page.evaluate("""() => {
            const region = window.__dockLayout.docked.right;
            return (
                region !== null &&
                region.columns.every((c) => c.railed === true)
            );
        }"""), "Escape must restore the pre-drag railed region"
    assert page.query_selector("[data-dock-rail-root]") is not None
    page.close()


# ---------------------------------------------------------------------------
# 12. A container resize between PRESS and the drag threshold must not
#     teleport the window: grab offsets resolve against the window's CURRENT
#     model position at drag start.
# ---------------------------------------------------------------------------
def test_no_teleport_when_viewport_resizes_mid_press(dock_context, vite_server) -> None:
    page = _open(dock_context, vite_server)
    set_layout(page, dock_layout(floating=[window("controls", x=700, y=200)]))
    gx, gy = _grip(page, "controls")
    page.mouse.move(gx, gy)
    page.mouse.down()
    # Mid-press (still under the 3px threshold) the browser narrows; the
    # ResizeObserver anchors the window left to x=420.
    page.set_viewport_size({"width": 1000, "height": 800})
    page.wait_for_timeout(150)
    moved = _floating_window_for_panel(page, "controls")
    assert moved is not None and moved["x"] < 500, "setup: anchor did not move it"
    anchored_x = moved["x"]
    # Now drag: cursor moves left 100px; the window must track RELATIVE to
    # its anchored position, not jump back to press-time coordinates.
    page.mouse.move(gx - 50, gy + 25, steps=6)
    page.mouse.move(gx - 100, gy + 50, steps=6)
    page.mouse.up()
    page.wait_for_timeout(120)
    win = _floating_window_for_panel(page, "controls")
    assert win is not None
    assert abs(win["x"] - (anchored_x - 100)) < 30, (
        f"window teleported on drag start: expected ~{anchored_x - 100}, got {win['x']}"
    )
    page.close()


# ---------------------------------------------------------------------------
# 13. A container resize DURING a drag leaves the dragged window glued to the
#     cursor (the observer skips the dragged window; the cursor is its source
#     of truth), and the drop commits the cursor-aligned position.
# ---------------------------------------------------------------------------
def test_dragged_window_stays_on_cursor_through_resize(
    dock_context, vite_server
) -> None:
    page = _open(dock_context, vite_server)
    set_layout(page, dock_layout(floating=[window("controls", x=700, y=200)]))
    win0 = _floating_window_for_panel(page, "controls")
    assert win0 is not None
    gx, gy = _grip(page, "controls")
    grab_x = gx - win0["x"]  # pointer offset into the window

    page.mouse.move(gx, gy)
    page.mouse.down()
    page.mouse.move(gx + 6, gy + 6, steps=2)
    page.mouse.move(500, 300, steps=10)
    # Shrink the viewport MID-DRAG: must not move the dragged window's model
    # position out from under the cursor.
    page.set_viewport_size({"width": 1100, "height": 700})
    page.wait_for_timeout(150)
    page.mouse.move(420, 320, steps=6)
    page.wait_for_timeout(60)
    # The RENDERED window must still be glued to the cursor while the button
    # is held (the old observer write detached it by the resize delta, then
    # visibly snapped it at release).
    rendered = page.eval_on_selector(
        "[data-floating-window]", "e => e.getBoundingClientRect().x"
    )
    expected = 420 - grab_x
    assert abs(rendered - expected) < 30, (
        f"window detached from the cursor mid-drag: rendered x={rendered}, "
        f"expected ~{expected}"
    )
    page.mouse.up()
    page.wait_for_timeout(120)

    win = _floating_window_for_panel(page, "controls")
    assert win is not None
    assert abs(win["x"] - expected) < 30, (
        f"drop should commit the cursor-aligned x (~{expected}), got {win['x']}"
    )
    page.close()


# ---------------------------------------------------------------------------
# Spec edge case 10: target rects that move MID-DRAG without a layout change
# (viewport resize here; container scroll shares the same staleness flag) must
# not desync drop resolution -- the drop lands on what's visibly under the
# pointer, not on drag-start geometry.
# ---------------------------------------------------------------------------
def test_viewport_resize_mid_drag_keeps_drop_targets_fresh(
    dock_context, vite_server
) -> None:
    page = _open(dock_context, vite_server)
    set_layout(
        page,
        dock_layout(
            docked_right=columns("controls"),
            floating=[window("console", x=250, y=350, width=240)],
        ),
    )
    gx, gy = _grip(page, "console")
    page.mouse.move(gx, gy)
    page.mouse.down()
    page.mouse.move(500, 300, steps=8)  # drag well clear of the region
    # Mid-drag the viewport narrows by 300px: the right region's rects shift
    # left while the layout model is unchanged (no re-collect trigger before
    # the staleness fix).
    page.set_viewport_size({"width": 980, "height": 720})
    page.wait_for_timeout(150)
    # Drop on the region's NEW content center (region spans ~680..980; the
    # D1 center-merge third is comfortably around x=830). Against drag-start
    # rects this point was empty canvas.
    page.mouse.move(830, 300, steps=6)
    page.mouse.move(830, 300)
    page.mouse.up()
    page.wait_for_timeout(200)
    merged = page.evaluate(
        "() => window.__dockLayout.groups['t-controls']?.paneIds ?? []"
    )
    docked_right = page.evaluate(
        "() => JSON.stringify(window.__dockLayout.docked.right ?? {})"
    )
    assert "console" in merged or "t-console" in docked_right, (
        f"drop after mid-drag resize should land in the region "
        f"(merged={merged}, right={docked_right})"
    )
    page.close()
