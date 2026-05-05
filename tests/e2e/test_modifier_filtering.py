"""E2E tests for modifier-filtered click and scene-pointer callbacks.

Exercises the wire round-trip from a real browser keyboard+mouse
sequence to the registered server-side callback. Verifies that the
modifier filter is honored on both ends:
- Matching modifier -> callback fires.
- Non-matching modifier -> callback does NOT fire (and for rect-select,
  the selection rectangle is NOT drawn).
"""

from __future__ import annotations

import threading

from playwright.sync_api import Page, expect

import viser

from .utils import wait_for_scene_node


def _canvas_center(viser_page: Page) -> tuple[float, float]:
    canvas = viser_page.locator("canvas").first
    box = canvas.bounding_box()
    assert box is not None, "Canvas bounding box not found"
    return (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


def test_node_on_click_modifier_filter_fires_only_on_match(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Two on_click callbacks on the same box: plain (modifier=None)
    and Cmd/Ctrl-click (modifier="cmd/ctrl"). The plain callback must
    fire only when no modifiers are held; the Cmd/Ctrl-click callback
    must fire only when Cmd or Ctrl is held."""
    plain_fired = threading.Event()
    cmd_fired = threading.Event()

    box = viser_server.scene.add_box(
        "/test_box",
        dimensions=(5.0, 5.0, 5.0),
        position=(0.0, 0.0, 0.0),
        color=(255, 0, 0),
    )

    @box.on_click  # modifier=None -> "no modifiers held"
    def _plain(event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        del event
        plain_fired.set()

    @box.on_click(modifier="cmd/ctrl")
    def _cmd(event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        del event
        cmd_fired.set()

    wait_for_scene_node(viser_page, "/test_box")
    cx, cy = _canvas_center(viser_page)

    # Plain click: only `_plain` fires.
    plain_fired.clear()
    cmd_fired.clear()
    viser_page.mouse.click(cx, cy)
    assert plain_fired.wait(timeout=5.0), "Plain on_click did not fire"
    assert not cmd_fired.is_set(), "Cmd-modifier on_click fired on plain click"

    # Ctrl-click: only `_cmd` fires (Mantine's "cmd/ctrl" maps to either).
    plain_fired.clear()
    cmd_fired.clear()
    viser_page.keyboard.down("Control")
    viser_page.mouse.click(cx, cy)
    viser_page.keyboard.up("Control")
    assert cmd_fired.wait(timeout=5.0), "Cmd/Ctrl on_click did not fire"
    assert not plain_fired.is_set(), "Plain on_click fired on ctrl-click"


def test_rect_select_does_not_fire_without_matching_modifier(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Register on_rect_select(modifier="shift"). A
    plain click+drag (no shift) must NOT fire the callback. The
    rectangle drawing and the callback dispatch share the same client-
    side gating, so if the callback doesn't fire neither does the
    drawing."""
    fired = threading.Event()

    @viser_server.scene.on_rect_select(modifier="shift")
    def _on_rect(event: viser.SceneRectSelectEvent) -> None:
        del event
        fired.set()

    viser_page.wait_for_timeout(500)
    cx, cy = _canvas_center(viser_page)

    # Plain drag (no shift) should NOT fire -- neither rectangle
    # drawn nor message dispatched.
    viser_page.mouse.move(cx - 30, cy - 30)
    viser_page.mouse.down()
    viser_page.mouse.move(cx + 30, cy + 30)
    viser_page.mouse.up()
    assert not fired.wait(timeout=1.0), (
        "rect-select callback fired on plain drag (modifier=shift not held)"
    )


def test_pointer_event_plain_click_fires_with_no_modifier_filter(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """``on_click()`` (modifier=None) fires for a plain
    click on empty canvas -- verifies the wire round-trip for scene-
    level pointer events with the new filter-list message format."""
    fired = threading.Event()

    @viser_server.scene.on_click()
    def _on_click(event: viser.SceneClickEvent) -> None:
        del event
        fired.set()

    viser_page.wait_for_timeout(500)
    cx, cy = _canvas_center(viser_page)
    viser_page.mouse.click(cx, cy)
    assert fired.wait(timeout=5.0), "on_click() did not fire"
    expect(viser_page.locator("canvas").first).to_be_visible()


def test_rect_select_fires_with_matching_modifier(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Holding shift while drag-selecting fires the
    ``modifier="shift"`` callback."""
    fired = threading.Event()

    @viser_server.scene.on_rect_select(modifier="shift")
    def _on_rect(event: viser.SceneRectSelectEvent) -> None:
        del event
        fired.set()

    viser_page.wait_for_timeout(500)
    cx, cy = _canvas_center(viser_page)

    viser_page.keyboard.down("Shift")
    try:
        viser_page.mouse.move(cx - 30, cy - 30)
        viser_page.mouse.down()
        viser_page.mouse.move(cx + 30, cy + 30)
        viser_page.mouse.up()
    finally:
        viser_page.keyboard.up("Shift")
    assert fired.wait(timeout=5.0), "rect-select did not fire on shift-drag"
