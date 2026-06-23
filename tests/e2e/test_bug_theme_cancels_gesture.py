"""E2E regression test for a theme change cancelling an in-flight gesture.

Regression (``App.tsx`` ``ViewerCanvas``): the window blur/keydown/keyup effect
depended on ``cancelActiveScenePointer`` -> ``drawRectSelectOverlay``, whose deps
are ``[theme, viewer]``. ``useMantineTheme()`` returns a new object identity
whenever the theme changes (e.g. ``configure_theme(brand_color=...)``), so the
effect tore down and re-subscribed -- and its cleanup *calls*
``cancelActiveScenePointer()``, aborting any in-flight scene-pointer gesture and
clearing the rubber-band overlay.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser

from .utils import JS_GESTURE, canvas_center


def test_theme_change_does_not_cancel_active_rect_select(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    @viser_server.scene.on_rect_select()
    def _(event: viser.SceneRectSelectEvent) -> None:
        del event

    viser_page.wait_for_timeout(400)
    cx, cy = canvas_center(viser_page)

    # Engage a rect-select gesture.
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()
    viser_page.mouse.move(cx + 30, cy + 30)
    assert viser_page.evaluate(JS_GESTURE)["kind"] == "scene-rect-select"

    # Push a theme change from the server while the gesture is in flight.
    viser_server.gui.configure_theme(brand_color=(255, 0, 0))
    viser_page.wait_for_timeout(500)

    gesture = viser_page.evaluate(JS_GESTURE)
    viser_page.mouse.up()
    assert gesture["kind"] == "scene-rect-select", (
        "A server-pushed theme change cancelled the in-flight rect-select "
        f"gesture (kind={gesture['kind']!r})."
    )
