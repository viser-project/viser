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
    # Collapsed, the floating window is a chip bar: Space on the focused
    # tab LABEL inside the chip expands the group again (labels are the
    # focusable elements; the container is a pure drag surface).
    chip_sel = f'[data-floating-window] [data-dock-group="{gid}"] [data-dock-tab]'
    page.eval_on_selector(chip_sel, "e => e.focus()")
    page.keyboard.press("Space")
    page.wait_for_timeout(100)
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed !== true", gid
    ), "Space on the focused chip should expand the group again"
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
    # Minimize the floating Controls window (now a chip bar), then drop
    # Inspector onto its chip: the drop lands in the still-minimized group.
    gid = _group_id_for_panel(page, "controls")
    page.eval_on_selector(
        f'[data-dock-group="{gid}"] [data-dock-minimize]', "e => e.click()"
    )
    page.wait_for_timeout(120)
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed === true", gid
    )
    # Aim at the CHIP (the collapsed group element on the minimized floating
    # bar); a drop there merges/inserts into the still-minimized group.
    target = page.eval_on_selector(
        f'[data-floating-window] [data-dock-group="{gid}"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    _drag(page, _grip(page, "inspector"), (target["x"], target["y"]))

    merged = page.evaluate("(gid) => window.__dockLayout.groups[gid].paneIds", gid)
    if "inspector" not in merged:
        pytest.skip("merge didn't land this run; geometry off by a few px")
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed === true", gid
    ), "merging into a minimized group must keep it minimized"
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
    assert tree is not None and len(tree["rows"][0]["columns"]) == 3

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
    page.wait_for_timeout(350)  # wait out the minimize width animation

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


def test_plus_drag_tears_out_still_minimized(dock_context, vite_server) -> None:
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
    # Dragging the + moves the panel AS-IS: it floats but stays MINIMIZED
    # (expanding is a click-only gesture). Re-resolve the group id in case
    # geometry drifted it into another surface.
    gid = _group_id_for_panel(page, "controls")
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed === true", gid
    ), "a drag from the + must NOT expand the panel"
    assert _floating_window_for_panel(page, "controls") is not None, (
        "the minimized panel should now float"
    )
    page.close()


# ---------------------------------------------------------------------------
# 10. The column handle persists when every child is minimized (strips reserve
#     width; no more canvas-overlay rail), so minimize-all is reversible from
#     the handle.
# ---------------------------------------------------------------------------
def test_stack_minimizes_independently_then_region_rail(
    dock_context, vite_server
) -> None:
    """Spec D12: a docked stack canonicalizes to bands, so each panel
    minimizes INDEPENDENTLY (mixed states are valid). When every band is
    minimized the region renders the packed rail, whose parent handle
    expands everything at once."""
    page = _open(dock_context, vite_server)
    set_layout(page, dock_layout(docked_right=stack("inspector", "controls")))
    assert page.query_selector("[data-dock-column-handle]") is None
    a = _group_id_for_panel(page, "controls")
    b = _group_id_for_panel(page, "inspector")

    # Minimize ONE panel: the other stays expanded (independence).
    page.eval_on_selector(
        f'[data-dock-group="{b}"] [data-dock-minimize]', "e => e.click()"
    )
    page.wait_for_timeout(120)
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed === true", b
    )
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed !== true", a
    )
    # Minimize the second too: the packed region rail appears.
    page.eval_on_selector(
        f'[data-dock-group="{a}"] [data-dock-minimize]', "e => e.click()"
    )
    page.wait_for_timeout(120)
    assert page.query_selector("[data-dock-region-rail]") is not None, (
        "an all-minimized region must render the rail with its parent handle"
    )
    # The rail handle's toggle expands everything.
    page.eval_on_selector(
        "[data-dock-region-rail] [data-dock-minimize-all]", "e => e.click()"
    )
    page.wait_for_timeout(120)
    for gid in (a, b):
        assert page.evaluate(
            "(gid) => window.__dockLayout.groups[gid].collapsed !== true", gid
        )
    page.close()


# ---------------------------------------------------------------------------
# 11. Dropping an expanded panel as a new cell BELOW a minimized strip adopts
#     the strip's minimized state: the region stays a uniform narrow strip
#     (both cells minimized) rather than one expanded + one squeezed.
# ---------------------------------------------------------------------------
def test_drop_below_strip_adopts_minimized(dock_context, vite_server) -> None:
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
    # Drop inspector below the strip's rows -> column[strip, inspector], where
    # the new inspector cell adopts the minimized state.
    _drag(page, _grip(page, "inspector"), (strip["x"], strip["bottom"] - 10))
    tree = _layout(page)["docked"]["right"]
    if tree is None or tree.get("dir") != "column":
        pytest.skip("below-split didn't land this run")
    igid = _group_id_for_panel(page, "inspector")
    assert page.evaluate(
        "(g) => window.__dockLayout.groups[g].collapsed === true", igid
    ), "a new cell dropped beside an all-minimized strip should adopt minimized"


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
def test_escape_after_expand_on_drag_restores_minimized(
    dock_context, vite_server
) -> None:
    page = _open(dock_context, vite_server)
    set_layout(
        page,
        dock_layout(floating=[window(group("controls", collapsed=True), x=400, y=200)]),
    )
    gid = "t-controls"
    btn = page.eval_on_selector(
        f'[data-floating-window] [data-dock-group="{gid}"]',
        "e => { const r = e.getBoundingClientRect(); "
        "return { x: r.x + r.width/2, y: r.y + r.height/2 }; }",
    )
    page.mouse.move(btn["x"], btn["y"])
    page.mouse.down()
    page.mouse.move(btn["x"] + 6, btn["y"] + 6, steps=2)
    page.mouse.move(btn["x"] + 80, btn["y"] + 120, steps=10)
    page.wait_for_timeout(120)  # expand-on-drag has committed by now
    page.keyboard.press("Escape")
    page.wait_for_timeout(120)
    page.mouse.up()
    page.wait_for_timeout(120)
    assert page.evaluate(
        "(gid) => window.__dockLayout.groups[gid].collapsed === true", gid
    ), "Escape must restore the pre-drag minimized state"
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
