"""E2E regression test for the multi-slider ignoring mid-drag state changes.

Regression (``components/MultiSliderComponent.tsx``): the drag ``mousemove`` /
``mouseup`` listeners are attached imperatively on ``document`` inside the
mousedown handlers, with removal living only inside their own ``mouseup``. There
is no effect-based cleanup, and the move closure captures ``disabled`` from the
mousedown render. As a result:

- If ``disabled`` flips to true mid-drag (server sets ``handle.disabled``), the
  drag keeps mutating the value and pushing updates to the server.
- If the component unmounts mid-drag, the ``document`` listeners leak.

This test covers the first, cleanly observable case.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser


def test_multislider_drag_stops_when_disabled_mid_drag(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    # Wide gaps so the middle thumb has room to keep moving right.
    handle = viser_server.gui.add_multi_slider(
        "M", min=0, max=10, step=1, initial_value=(0, 3, 10)
    )
    viser_page.wait_for_timeout(800)

    # Grab the middle thumb and start dragging it.
    thumb = viser_page.locator(".multi-slider-thumb").nth(1)
    thumb.wait_for(state="visible", timeout=5_000)
    box = thumb.bounding_box()
    assert box is not None
    start_x = box["x"] + box["width"] / 2
    y = box["y"] + box["height"] / 2

    viser_page.mouse.move(start_x, y)
    viser_page.mouse.down()
    # Drag right a bit; the value should change while enabled.
    viser_page.mouse.move(start_x + 20, y)
    viser_page.wait_for_timeout(200)
    assert handle.value[1] != 3, "drag should change the value while enabled"

    # Disable the slider from the server *during* the drag.
    handle.disabled = True
    viser_page.wait_for_timeout(200)
    value_when_disabled = handle.value

    # Keep dragging further right (there is room to move). A disabled control
    # must not keep updating.
    viser_page.mouse.move(start_x + 90, y)
    viser_page.wait_for_timeout(200)
    viser_page.mouse.up()

    assert handle.value == value_when_disabled, (
        "Multi-slider kept updating after it was disabled mid-drag: "
        f"{value_when_disabled} -> {handle.value}"
    )
