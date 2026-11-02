"""E2E tests for input options used by apps that bring their own keyboard /
drag handling (e.g. MuJoCo viewers):

- ``server.scene.set_keyboard_camera_controls(False)`` frees WASDQE/arrows.
- A bound command hotkey takes precedence over keyboard camera movement.
- Physical-key hotkey matching (Shift+digit, punctuation, F-keys).
- ``on_drag(..., show_arrow=False)`` suppresses the built-in drag arrow.
"""

from __future__ import annotations

import threading
import time

import pytest
from playwright.sync_api import Page

import viser

from .utils import wait_for_connection, wait_for_mesh_children, wait_for_scene_node

JS_CAMERA_POSITION = """
() => {
    const cam = window.__viserMutable.camera;
    return cam === null ? null : cam.position.toArray();
}
"""

JS_HAS_VISIBLE_DRAG_ARROW = """
() => {
    let visible = false;
    window.__viserMutable.scene.traverse((o) => {
        if (o.type === "ArrowHelper" && o.visible) visible = true;
    });
    return visible;
}
"""


def _wait_for_camera(page: Page) -> list[float]:
    page.wait_for_function(
        "() => window.__viserMutable && window.__viserMutable.cameraControl != null"
        " && window.__viserMutable.camera != null",
        timeout=10_000,
    )
    return page.evaluate(JS_CAMERA_POSITION)


def _hold(page: Page, key: str, seconds: float) -> None:
    page.keyboard.down(key)
    page.wait_for_timeout(int(seconds * 1000))
    page.keyboard.up(key)


def _moved(a: list[float], b: list[float]) -> float:
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5


def _press_until(
    page: Page, key: str, event: threading.Event, timeout: float = 5.0
) -> bool:
    """Re-press until the callback fires: hotkeys register client-side only
    once the command reaches the browser."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        page.keyboard.press(key)
        if event.wait(timeout=0.2):
            return True
    return False


def test_keyboard_camera_controls_enabled_by_default(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    before = _wait_for_camera(viser_page)
    _hold(viser_page, "w", 0.4)
    after = viser_page.evaluate(JS_CAMERA_POSITION)
    assert _moved(before, after) > 0.1, (before, after)


def test_keyboard_camera_controls_can_be_disabled(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    _wait_for_camera(viser_page)
    viser_server.scene.set_keyboard_camera_controls(False)
    # Let the message land; then confirm none of the movement keys drift.
    viser_page.wait_for_timeout(300)
    before = viser_page.evaluate(JS_CAMERA_POSITION)
    for key in ["w", "a", "s", "d", "q", "e", "ArrowLeft", "ArrowUp"]:
        _hold(viser_page, key, 0.15)
    after = viser_page.evaluate(JS_CAMERA_POSITION)
    assert _moved(before, after) < 1e-6, (before, after)

    # Re-enabling restores movement.
    viser_server.scene.set_keyboard_camera_controls(True)
    viser_page.wait_for_timeout(300)
    _hold(viser_page, "w", 0.4)
    final = viser_page.evaluate(JS_CAMERA_POSITION)
    assert _moved(after, final) > 0.1, (after, final)


def test_bound_hotkey_does_not_move_camera(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """With keyboard controls left ON, a key bound as a command hotkey fires
    the command and does not also drive the camera."""
    _wait_for_camera(viser_page)
    fired = threading.Event()
    handle = viser_server.gui.add_command("Step", hotkey="arrowright")
    handle.on_trigger(lambda _: fired.set())
    assert _press_until(viser_page, "ArrowRight", fired)

    before = viser_page.evaluate(JS_CAMERA_POSITION)
    _hold(viser_page, "ArrowRight", 0.4)
    after = viser_page.evaluate(JS_CAMERA_POSITION)
    assert _moved(before, after) < 1e-6, (before, after)


@pytest.mark.parametrize(
    "press, hotkey, modifier",
    [
        # Shift+1 types "!" -- must still match "1" + shift.
        ("Shift+Digit1", "1", "shift"),
        ("Shift+Digit0", "0", "shift"),
        ("BracketLeft", "[", None),
        ("BracketRight", "]", None),
        ("Minus", "-", None),
        ("Equal", "=", None),
        # Shift+= types "+".
        ("Shift+Equal", "=", "shift"),
        ("F6", "F6", None),
        ("F7", "F7", None),
        # Option/Alt+letter (types "å" etc. on macOS).
        ("Alt+KeyA", "A", "alt"),
    ],
)
def test_physical_key_hotkeys(
    viser_server: viser.ViserServer,
    viser_page: Page,
    press: str,
    hotkey: str,
    modifier: str | None,
) -> None:
    fired = threading.Event()
    handle = viser_server.gui.add_command(
        "Target",
        hotkey=hotkey,  # type: ignore[arg-type]
        modifier=modifier,  # type: ignore[arg-type]
    )
    handle.on_trigger(lambda _: fired.set())
    assert _press_until(viser_page, press, fired), f"{press} did not fire"


def test_shift_digit_does_not_fire_unmodified_binding(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    plain = threading.Event()
    shifted = threading.Event()
    viser_server.gui.add_command("Plain", hotkey="1").on_trigger(lambda _: plain.set())
    viser_server.gui.add_command("Shifted", hotkey="1", modifier="shift").on_trigger(
        lambda _: shifted.set()
    )
    assert _press_until(viser_page, "Shift+Digit1", shifted)
    assert not plain.wait(timeout=0.3)


def _drag_box(page: Page, server: viser.ViserServer, show_arrow: bool) -> bool:
    """Drag a box and return whether the built-in arrow was ever visible."""
    server.initial_camera.position = (0.0, 0.0, 4.0)
    server.initial_camera.look_at = (0.0, 0.0, 0.0)
    box = server.scene.add_box(
        "/drag_box", dimensions=(4.0, 4.0, 0.2), color=(255, 120, 0)
    )
    updates = threading.Event()

    def on_drag(event: viser.SceneNodeDragEvent) -> None:
        if event.phase == "update":
            updates.set()

    box.on_drag("left", show_arrow=show_arrow)(on_drag)

    wait_for_connection(page, server.get_port())
    wait_for_scene_node(page, "/drag_box")
    wait_for_mesh_children(page, "/drag_box")
    canvas_box = page.locator("canvas").first.bounding_box()
    assert canvas_box is not None
    cx = canvas_box["x"] + canvas_box["width"] / 2
    cy = canvas_box["y"] + canvas_box["height"] / 2

    page.evaluate(
        f"""() => {{
            window.__arrowSeen = false;
            const tick = () => {{
                if (({JS_HAS_VISIBLE_DRAG_ARROW})()) window.__arrowSeen = true;
                window.__arrowTick = requestAnimationFrame(tick);
            }};
            tick();
        }}"""
    )
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 120, cy + 40, steps=12)
    assert updates.wait(timeout=5.0), "drag never produced an update"
    page.wait_for_timeout(200)
    page.mouse.up()
    return page.evaluate(
        "() => { cancelAnimationFrame(window.__arrowTick); return window.__arrowSeen; }"
    )


def test_drag_arrow_shown_by_default(
    viser_server: viser.ViserServer, page: Page
) -> None:
    assert _drag_box(page, viser_server, show_arrow=True)


def test_drag_arrow_hidden_with_show_arrow_false(
    viser_server: viser.ViserServer, page: Page
) -> None:
    assert not _drag_box(page, viser_server, show_arrow=False)
