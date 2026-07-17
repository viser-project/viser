"""E2E tests for the floating control panel: dragging, docking, undocking,
resizing, and cleanup when the control layout is switched away from floating.

The default control layout is "floating", so most of these tests use the
default page. The panel, its drag handle, and its resize grips are tagged with
``data-testid`` attributes in ``FloatingPanel.tsx``; the panel also exposes its
dock state via ``data-dock-side`` (``"none" | "left" | "right"``)."""

from __future__ import annotations

from playwright.sync_api import FloatRect, Page, ViewportSize, expect

import viser

# Wide enough to stay above the mobile breakpoint (xs = 36em = 576px), so the
# floating layout -- not the bottom sheet -- is used.
_VIEWPORT: ViewportSize = {"width": 1280, "height": 720}


def _bbox(page: Page, testid: str) -> FloatRect:
    box = page.get_by_test_id(testid).bounding_box()
    assert box is not None, f"no bounding box for {testid!r}"
    return box


def _panel_box(page: Page) -> FloatRect:
    return _bbox(page, "floating-panel")


def _canvas_box(page: Page) -> FloatRect:
    box = page.locator("canvas").first.bounding_box()
    assert box is not None, "no canvas bounding box"
    return box


def _dock_side(page: Page) -> str | None:
    return page.get_by_test_id("floating-panel").get_attribute("data-dock-side")


def _center(box: FloatRect) -> tuple[float, float]:
    return (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


def _drag(
    page: Page,
    start: tuple[float, float],
    end: tuple[float, float],
    steps: int = 25,
) -> None:
    """Press at ``start``, move to ``end``, release. Settles for a couple of
    animation frames so the rAF-coalesced position/state updates land."""
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(*end, steps=steps)
    page.mouse.up()
    page.wait_for_timeout(300)


def _drag_handle_to(page: Page, end: tuple[float, float], steps: int = 25) -> None:
    _drag(page, _center(_bbox(page, "floating-panel-handle")), end, steps=steps)


def test_floating_panel_default_placement(viser_page: Page) -> None:
    """By default the panel floats (no dock) in the upper-right corner."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    expect(viser_page.get_by_test_id("floating-panel")).to_be_visible()
    assert _dock_side(viser_page) == "none"

    panel = _panel_box(viser_page)
    # Right-anchored: its right edge sits near the viewport's right edge...
    assert panel["x"] + panel["width"] > _VIEWPORT["width"] * 0.6
    assert _VIEWPORT["width"] - (panel["x"] + panel["width"]) < 60
    # ...and it does not fill the viewport height (that's the docked look).
    assert panel["height"] < _VIEWPORT["height"] * 0.9


def test_drag_moves_floating_panel(viser_page: Page) -> None:
    """Dragging the handle (away from any edge) repositions the panel without
    docking it."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    before = _panel_box(viser_page)
    start = _center(_bbox(viser_page, "floating-panel-handle"))
    # Move well clear of both edges so no dock is offered.
    _drag_handle_to(viser_page, (start[0] - 250, start[1] + 150))

    assert _dock_side(viser_page) == "none"
    after = _panel_box(viser_page)
    assert after["x"] < before["x"] - 150
    assert after["y"] > before["y"] + 80


def test_drag_to_left_edge_docks(viser_page: Page) -> None:
    """Dragging the handle to the left edge docks the panel there: it pins to
    the edge, fills the height, and the canvas insets to reserve its column."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    start = _center(_bbox(viser_page, "floating-panel-handle"))
    _drag_handle_to(viser_page, (20, start[1]))

    assert _dock_side(viser_page) == "left"
    panel = _panel_box(viser_page)
    # D54: docked panels sit a small edge gutter (REGION_EDGE_GAP_PX = 3px)
    # inside the screen edge.
    assert panel["x"] < 8
    assert panel["height"] > _VIEWPORT["height"] * 0.9

    # The canvas is inset on the left by (about) the panel's width.
    canvas = _canvas_box(viser_page)
    assert abs(canvas["x"] - panel["width"]) < 30


def test_drag_to_right_edge_docks(viser_page: Page) -> None:
    """Dragging the handle to the right edge docks the panel on the right."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    start = _center(_bbox(viser_page, "floating-panel-handle"))
    _drag_handle_to(viser_page, (_VIEWPORT["width"] - 20, start[1]))

    assert _dock_side(viser_page) == "right"
    panel = _panel_box(viser_page)
    assert panel["x"] + panel["width"] > _VIEWPORT["width"] - 8  # D54 gutter
    assert panel["height"] > _VIEWPORT["height"] * 0.9

    # The canvas is inset on the right: its left edge stays at 0.
    canvas = _canvas_box(viser_page)
    assert canvas["x"] < 5
    assert canvas["width"] < _VIEWPORT["width"] - panel["width"] + 30


def test_undock_by_dragging_to_center(viser_page: Page) -> None:
    """A docked panel undocks (in place) when dragged back toward the center.

    Docks to the right rather than the left so the handle ends up clear of the
    top-left notifications layer, which would otherwise intercept the grab."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    # Dock right first.
    start = _center(_bbox(viser_page, "floating-panel-handle"))
    _drag_handle_to(viser_page, (_VIEWPORT["width"] - 20, start[1]))
    assert _dock_side(viser_page) == "right"

    # Drag the (now top-right) handle toward the middle of the viewport.
    _drag_handle_to(viser_page, (_VIEWPORT["width"] / 2, _VIEWPORT["height"] / 2))

    assert _dock_side(viser_page) == "none"
    panel = _panel_box(viser_page)
    # Back to a floating panel: no longer full height, and the canvas is no
    # longer inset.
    assert panel["height"] < _VIEWPORT["height"] * 0.9
    assert _canvas_box(viser_page)["x"] < 5


def test_resize_right_grip_widens_panel(viser_page: Page) -> None:
    """Dragging the right resize grip outward increases the panel width."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    before = _panel_box(viser_page)
    grip = _center(_bbox(viser_page, "floating-panel-resize-right"))
    _drag(viser_page, grip, (grip[0] + 120, grip[1]))

    after = _panel_box(viser_page)
    assert after["width"] > before["width"] + 80
    assert _dock_side(viser_page) == "none"


def test_resize_left_grip_keeps_right_edge_pinned(viser_page: Page) -> None:
    """Dragging the left grip outward widens the panel while its right edge
    stays put (the right-anchored resize that avoids jitter)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    before = _panel_box(viser_page)
    right_before = before["x"] + before["width"]
    grip = _center(_bbox(viser_page, "floating-panel-resize-left"))
    _drag(viser_page, grip, (grip[0] - 120, grip[1]))

    after = _panel_box(viser_page)
    assert after["width"] > before["width"] + 80
    assert abs((after["x"] + after["width"]) - right_before) < 12


def _wait_for_client(server: viser.ViserServer) -> viser.ClientHandle:
    """Return the first connected client, polling briefly for it to register."""
    import time

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        clients = server.get_clients()
        if clients:
            return next(iter(clients.values()))
        time.sleep(0.05)
    raise RuntimeError("no client connected within timeout")


def test_notification_offset_clear_of_left_dock(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """A notification raised while the panel is docked on the left must be
    pushed right so it sits over the canvas, not on top of the GUI."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    # Dock the panel to the left.
    start = _center(_bbox(viser_page, "floating-panel-handle"))
    _drag_handle_to(viser_page, (20, start[1]))
    assert _dock_side(viser_page) == "left"
    panel = _panel_box(viser_page)

    # Raise a (non-auto-closing) notification from the server.
    client = _wait_for_client(viser_server)
    client.add_notification(
        "Docked test", "Should clear the GUI", auto_close_seconds=None
    )

    notification = viser_page.locator(".mantine-Notification-root").first
    expect(notification).to_be_visible(timeout=5_000)
    note = notification.bounding_box()
    assert note is not None

    # The notification's left edge starts at or past the docked panel's right
    # edge -- i.e. it doesn't horizontally overlap the GUI.
    panel_right = panel["x"] + panel["width"]
    assert note["x"] >= panel_right - 2, (
        f"notification (x={note['x']}) overlaps the left-docked panel "
        f"(right edge {panel_right})"
    )


def test_deprecated_control_layout_docks_right(
    viser_page: Page, viser_server: viser.ViserServer
) -> None:
    """The deprecated ``control_layout="fixed"`` / ``"collapsible"`` now docks the
    control panel to the right edge (via the new `main_panel` placement path),
    instead of switching to the old sidebar layout. The floating panel stays
    mounted on the dock surface; the canvas insets on the right."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    # Start undocked (default top-right float).
    assert _dock_side(viser_page) == "none"

    # The deprecated setting translates to main_panel.dock_right().
    viser_server.gui.configure_theme(control_layout="fixed")
    viser_page.wait_for_timeout(500)

    # Panel stays mounted and is now docked to the right edge.
    expect(viser_page.get_by_test_id("floating-panel")).to_be_visible()
    assert _dock_side(viser_page) == "right"
    panel = _panel_box(viser_page)
    assert panel["x"] + panel["width"] > _VIEWPORT["width"] - 8  # D54 gutter
    assert panel["height"] > _VIEWPORT["height"] * 0.9
    # Canvas insets on the right (left edge stays at 0).
    assert _canvas_box(viser_page)["x"] < 5


def test_minimize_floating_keeps_face_bar_geometry(viser_page: Page) -> None:
    """D33 constancy pin, FLOATING: a header click (no motion) minimizes the
    single-group floating control panel to its FACE bar -- the header kept
    in place. The bar keeps the header's exact outer height (the compact
    toggle sits at the same header inset) and the window's width; clicking
    again expands it back. (Since D32 the header-click minimize exists ONLY
    on a single-group floating window; the docked flow is the chevron --
    see the companion test.)"""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)
    assert _dock_side(viser_page) == "none"
    wide = _panel_box(viser_page)["width"]

    # Measure the HEADER box, not the testid (the connection-status row is
    # the header's content box while expanded but stretches to fill the bar
    # while minimized -- the constant thing is the header's outer height).
    expanded_h = viser_page.eval_on_selector(
        "[data-dock-unmergeable-header]",
        "e => e.getBoundingClientRect().height",
    )
    handle = viser_page.get_by_test_id("floating-panel-handle")
    handle.click()
    viser_page.wait_for_timeout(400)
    handle = viser_page.get_by_test_id("floating-panel-handle")
    expect(handle).to_be_visible()
    bar = handle.bounding_box()
    assert bar is not None and abs(bar["height"] - expanded_h) <= 2, (
        f"minimized face bar must keep the header height "
        f"(expanded {expanded_h}), got {bar}"
    )
    assert bar["width"] > wide - 30, (
        f"the bar keeps the window's width (P8/D17/D20), got {bar}"
    )

    # Clicking the bar expands it back to the full panel.
    handle.click()
    viser_page.wait_for_timeout(400)
    restored = _panel_box(viser_page)
    assert restored["width"] > wide - 30
    assert restored["height"] > bar["height"] + 40, (
        f"expand should restore the panel body ({bar['height']} -> "
        f"{restored['height']})"
    )


def test_docked_collapse_via_chevron_keeps_handle(viser_page: Page) -> None:
    """Docked, the control panel has NO header-click minimize (D32): its
    collapse affordance is the region chevron, which renders the 36px rail.
    The floating-panel-handle testid follows to the rail cell, and clicking
    it expands the panel again (a lone rail cell's background backs the
    expand, P9)."""
    viser_page.set_viewport_size(_VIEWPORT)
    viser_page.wait_for_timeout(300)

    # Dock to the right edge.
    _drag_handle_to(viser_page, (_VIEWPORT["width"] - 8, 300))
    assert _dock_side(viser_page) == "right"
    wide = _panel_box(viser_page)["width"]

    # A header click must NOT minimize while docked (drag-only surface).
    viser_page.get_by_test_id("floating-panel-handle").click()
    viser_page.wait_for_timeout(300)
    assert viser_page.locator("[data-dock-group][data-dock-collapsed]").count() == 0, (
        "a docked header click must not minimize (D32)"
    )

    # The chevron collapses the region to its rail; the handle testid moves
    # to the rail cell.
    chevron = viser_page.locator("[data-dock-region-collapse='right']")
    expect(chevron).to_have_count(1)
    chevron.click()
    viser_page.wait_for_timeout(400)
    expect(viser_page.locator("[data-dock-rail-root]")).to_have_count(1)
    handle = viser_page.get_by_test_id("floating-panel-handle")
    expect(handle).to_be_visible()
    strip = handle.bounding_box()
    assert strip is not None and strip["width"] < 60, (
        f"the docked collapsed form is the ~36px rail cell, got {strip}"
    )

    # Clicking the rail cell expands the panel back to a wide docked panel.
    handle.click()
    viser_page.wait_for_timeout(400)
    restored = _panel_box(viser_page)["width"]
    assert restored > wide - 30, (
        f"expand should restore the docked width ({wide} -> {restored})"
    )
