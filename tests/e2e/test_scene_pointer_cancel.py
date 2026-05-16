"""E2E coverage for unified scene-pointer cancellation paths.

`pointercancel`, `lostpointercapture`, window `blur`, and canvas
unmount all route through one idempotent cleanup so no single dropped
event class can strand the gesture mid-flight (off-canvas release
leaks).

Tests assert via `window.__viserPointer.getGesture()` and
`window.__viserMutable.cameraControl.enabled`.
"""

from __future__ import annotations

from playwright.sync_api import Page

import viser

from .utils import JS_CAMERA_ENABLED, JS_GESTURE, canvas_center


def _setup_rect_select(viser_server: viser.ViserServer) -> None:
    """Register a rect-select callback so a pointerdown engages a
    canvas-level scene-pointer gesture (and acquires the camera
    lease)."""

    @viser_server.scene.on_rect_select()
    def _(event: viser.SceneRectSelectEvent) -> None:
        del event


def test_pointercancel_clears_scene_pointer_state(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A synthetic ``pointercancel`` after pointerdown drops the
    gesture: the InputManager returns to ``idle`` and the camera
    lease is released."""
    _setup_rect_select(viser_server)
    viser_page.wait_for_timeout(300)
    cx, cy = canvas_center(viser_page)

    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()

    g = viser_page.evaluate(JS_GESTURE)
    assert g["kind"] == "scene-rect-select"
    assert viser_page.evaluate(JS_CAMERA_ENABLED) is False

    viser_page.evaluate(
        """
        () => {
            const canvas = window.__viserMutable.canvas;
            canvas.dispatchEvent(new PointerEvent("pointercancel", {
                pointerId: 1,
                bubbles: true,
                cancelable: true,
            }));
        }
        """
    )

    g_after = viser_page.evaluate(JS_GESTURE)
    assert g_after["kind"] == "idle"
    assert viser_page.evaluate(JS_CAMERA_ENABLED) is True
    # Clean up the dangling pointerup so subsequent tests don't see
    # a held button.
    viser_page.mouse.up()


def test_blur_clears_scene_pointer_state(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Tab/devtools blur -- via a window 'blur' event -- routes
    through the same cancellation path."""
    _setup_rect_select(viser_server)
    viser_page.wait_for_timeout(300)
    cx, cy = canvas_center(viser_page)

    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()
    g = viser_page.evaluate(JS_GESTURE)
    assert g["kind"] == "scene-rect-select"

    viser_page.evaluate("window.dispatchEvent(new Event('blur'))")

    g_after = viser_page.evaluate(JS_GESTURE)
    assert g_after["kind"] == "idle"
    assert viser_page.evaluate(JS_CAMERA_ENABLED) is True
    viser_page.mouse.up()


def test_stray_pointerup_with_other_id_is_ignored(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A pointerup with a different ``pointerId`` than the active
    gesture's must not tear it down (multi-touch defense)."""
    _setup_rect_select(viser_server)
    viser_page.wait_for_timeout(300)
    cx, cy = canvas_center(viser_page)

    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()

    g = viser_page.evaluate(JS_GESTURE)
    assert g["kind"] == "scene-rect-select"
    active_id = g["pointerId"]
    assert isinstance(active_id, int)

    # Synthetic pointerup with a different id.
    viser_page.evaluate(
        """
        (activeId) => {
            const canvas = window.__viserMutable.canvas;
            canvas.dispatchEvent(new PointerEvent("pointerup", {
                pointerId: activeId + 999,
                bubbles: true,
                cancelable: true,
            }));
        }
        """,
        active_id,
    )

    g_after = viser_page.evaluate(JS_GESTURE)
    assert g_after["kind"] == "scene-rect-select", (
        f"stray pointerup with other id ended the gesture; got {g_after}"
    )
    viser_page.mouse.up()


def test_active_pointer_id_recorded_on_pointerdown(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """When a scene-pointer gesture engages, the InputManager records
    the pointer id on the gesture struct."""
    _setup_rect_select(viser_server)
    viser_page.wait_for_timeout(300)
    cx, cy = canvas_center(viser_page)

    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()

    g = viser_page.evaluate(JS_GESTURE)
    assert g["kind"] == "scene-rect-select"
    assert isinstance(g["pointerId"], int)
    viser_page.mouse.up()
