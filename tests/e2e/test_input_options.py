"""E2E tests for input options used by apps that bring their own keyboard /
drag handling (e.g. MuJoCo viewers):

- ``server.scene.configure_keyboard_camera_controls(False)`` frees WASDQE/arrows.
- A bound command hotkey takes precedence over keyboard camera movement.
- Physical-key hotkey matching (Shift+digit, punctuation, F-keys).
- ``on_drag(..., show_arrow=False)`` suppresses the built-in drag arrow.
"""

from __future__ import annotations

import threading
import time

import pytest
from playwright.sync_api import Page, expect

import viser

from .utils import (
    find_gui_input,
    wait_for_connection,
    wait_for_mesh_children,
    wait_for_scene_node,
)

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


def _sync(page: Page, server: viser.ViserServer, tag: str) -> None:
    """Block until every message queued so far has reached the client:
    messages are delivered in order, so once a GUI element queued *after*
    them renders, they have been applied."""
    server.gui.add_markdown(f"sync-{tag}")
    expect(page.get_by_text(f"sync-{tag}")).to_be_visible(timeout=5_000)


def _wait_until_still(page: Page) -> list[float]:
    """Wait for camera motion (e.g. smoothed rotation easing out) to settle,
    then return the position. Exact-zero drift assertions are only valid
    from a resting camera."""
    page.wait_for_function(
        """() => new Promise((resolve) => {
            const pos = () => window.__viserMutable.camera.position.toArray();
            const a = pos();
            setTimeout(() => {
                const b = pos();
                resolve(a.every((v, i) => v === b[i]));
            }, 250);
        })""",
        timeout=10_000,
        polling=100,
    )
    return page.evaluate(JS_CAMERA_POSITION)


# "The camera moved" threshold. Disabled/bound cases assert exactly zero
# drift, so any clearly non-zero motion distinguishes them; magnitude
# depends on frame rate under load (0.4 s of W moved ~0.05 on a starved
# runner vs ~0.8 normally), so don't assert speed.
MOVED = 1e-3


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
    assert _moved(before, after) > MOVED, (before, after)


def test_keyboard_camera_controls_can_be_disabled(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    _wait_for_camera(viser_page)
    viser_server.scene.configure_keyboard_camera_controls(False)
    _sync(viser_page, viser_server, "disabled")
    # Confirm none of the movement keys drift.
    before = _wait_until_still(viser_page)
    for key in ["w", "a", "s", "d", "q", "e", "ArrowLeft", "ArrowUp"]:
        _hold(viser_page, key, 0.15)
    after = viser_page.evaluate(JS_CAMERA_POSITION)
    assert _moved(before, after) < 1e-6, (before, after)

    # Re-enabling restores movement.
    viser_server.scene.configure_keyboard_camera_controls(True)
    _sync(viser_page, viser_server, "enabled")
    _hold(viser_page, "w", 0.4)
    final = viser_page.evaluate(JS_CAMERA_POSITION)
    assert _moved(after, final) > MOVED, (after, final)


def test_bound_hotkey_does_not_move_camera(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """With keyboard controls left ON, a key bound as a command hotkey fires
    the command and does not also drive the camera."""
    _wait_for_camera(viser_page)
    fired = threading.Event()
    handle = viser_server.gui.add_command("Step", hotkey="arrowright")
    handle.on_trigger(lambda _: fired.set())
    # The command must be bound client-side before the first press: an
    # unbound ArrowRight rotates the camera (correctly), and the smoothed
    # rotation would still be easing out when ``before`` is sampled.
    _sync(viser_page, viser_server, "bound")
    viser_page.keyboard.press("ArrowRight")
    assert fired.wait(timeout=5.0), "bound hotkey did not fire"

    before = _wait_until_still(viser_page)
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
        ("F6", "f6", None),
        ("F7", "f7", None),
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
    # Generous: scene load is slow with many parallel software-GL browsers.
    wait_for_scene_node(page, "/drag_box", timeout=30_000)
    wait_for_mesh_children(page, "/drag_box", timeout=30_000)
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


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_disabling_mid_hold_stops_camera(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Disabling keyboard controls while a movement key is held must drop the
    held key: the camera stops even though no keyup has arrived yet."""
    start = _wait_for_camera(viser_page)
    viser_page.keyboard.down("w")
    try:
        viser_page.wait_for_function(
            f"""() => {{
                const p = window.__viserMutable.camera.position.toArray();
                const s = {start};
                return Math.hypot(p[0]-s[0], p[1]-s[1], p[2]-s[2]) > {MOVED};
            }}""",
            timeout=10_000,
        )
        viser_server.scene.configure_keyboard_camera_controls(False)
        _sync(viser_page, viser_server, "disabled-mid-hold")
        # Times out (fails) if W is still driving the camera.
        before = _wait_until_still(viser_page)
        viser_page.wait_for_timeout(400)
        after = viser_page.evaluate(JS_CAMERA_POSITION)
        assert _moved(before, after) < 1e-6, (before, after)
    finally:
        viser_page.keyboard.up("w")


def test_hotkey_ignored_while_typing(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Keys typed into a text input go to the input, not to hotkeys."""
    fired = threading.Event()
    viser_server.gui.add_text("Name", initial_value="")
    viser_server.gui.add_command("Act", hotkey="A").on_trigger(lambda _: fired.set())
    _sync(viser_page, viser_server, "typing")

    text = find_gui_input(viser_page, "Name")
    text.click()
    viser_page.keyboard.type("aaa")
    expect(text).to_have_value("aaa")
    assert not fired.wait(timeout=0.5), "hotkey fired while typing in an input"

    # Outside the input, the same key fires.
    viser_page.evaluate("() => document.activeElement.blur()")
    assert _press_until(viser_page, "a", fired)


def test_disabled_command_hotkey_does_not_fire(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A disabled command's hotkey neither fires nor swallows the key: with
    a disabled command on W, W still drives the camera. (The server also
    ignores triggers for disabled commands, so the camera check is what
    pins the client-side filter.)"""
    fired = threading.Event()
    handle = viser_server.gui.add_command("Off", hotkey="W", disabled=True)
    handle.on_trigger(lambda _: fired.set())
    before = _wait_for_camera(viser_page)
    _sync(viser_page, viser_server, "disabled-cmd")
    _hold(viser_page, "w", 0.4)
    after = viser_page.evaluate(JS_CAMERA_POSITION)
    assert not fired.is_set(), "disabled command's hotkey fired"
    assert _moved(before, after) > MOVED, "disabled hotkey swallowed the key"

    handle.disabled = False
    assert _press_until(viser_page, "w", fired)


def test_palette_displays_function_keys_uppercase(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """``hotkey="f6"`` is lowercase on the wire but shown as "F6"."""
    viser_server.gui.add_command("Cycle frames", hotkey="f6")
    _sync(viser_page, viser_server, "palette")
    search = viser_page.locator("input.mantine-Spotlight-search")
    for _ in range(50):
        viser_page.keyboard.press("Control+K")
        if search.is_visible():
            break
        viser_page.wait_for_timeout(100)
    action = viser_page.locator(
        "button.mantine-Spotlight-action", has_text="Cycle frames"
    )
    expect(action).to_contain_text("F6", timeout=5_000)
    expect(action).not_to_contain_text("f6")


def test_drag_arrow_follows_binding_mid_drag(
    viser_server: viser.ViserServer, page: Page
) -> None:
    """The arrow setting tracks the binding that owns the current segment:
    plain drag (show_arrow=False) -> Shift (True) shows it -> Shift+Alt
    (unbound, dormant) keeps it -> back to plain hides it again."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)
    box = viser_server.scene.add_box(
        "/drag_box", dimensions=(4.0, 4.0, 0.2), color=(255, 120, 0)
    )
    updates = threading.Event()

    def on_update(event: viser.SceneNodeDragEvent) -> None:
        if event.phase == "update":
            updates.set()

    box.on_drag("left", show_arrow=False)(on_update)
    box.on_drag("left", modifier="shift", show_arrow=True)(on_update)

    wait_for_connection(page, viser_server.get_port())
    wait_for_scene_node(page, "/drag_box", timeout=30_000)
    wait_for_mesh_children(page, "/drag_box", timeout=30_000)
    canvas_box = page.locator("canvas").first.bounding_box()
    assert canvas_box is not None
    cx = canvas_box["x"] + canvas_box["width"] / 2
    cy = canvas_box["y"] + canvas_box["height"] / 2

    def wiggle(dx: float) -> None:
        # Pointer motion renders frames, which is where the arrow updates.
        page.mouse.move(cx + dx, cy + 40, steps=4)

    def expect_arrow(visible: bool) -> None:
        page.wait_for_function(
            f"() => ({JS_HAS_VISIBLE_DRAG_ARROW})() === {str(visible).lower()}",
            timeout=5_000,
        )

    page.mouse.move(cx, cy)
    page.mouse.down()
    try:
        page.mouse.move(cx + 120, cy + 40, steps=12)
        assert updates.wait(timeout=5.0), "drag never produced an update"
        wiggle(130)
        expect_arrow(False)

        page.keyboard.down("Shift")
        wiggle(140)
        expect_arrow(True)

        # Shift+Alt has no binding: the drag goes dormant and keeps the
        # previous segment's setting instead of flickering.
        page.keyboard.down("Alt")
        wiggle(150)
        page.wait_for_timeout(300)
        wiggle(160)
        expect_arrow(True)

        page.keyboard.up("Alt")
        page.keyboard.up("Shift")
        wiggle(170)
        expect_arrow(False)
    finally:
        page.keyboard.up("Alt")
        page.keyboard.up("Shift")
        page.mouse.up()
