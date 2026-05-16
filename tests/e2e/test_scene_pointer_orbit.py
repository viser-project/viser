"""E2E tests for scene-pointer callbacks coexisting with camera orbit.

Regression coverage for the fix in ``ViewerCanvas.handlePointerDown``:
camera controls must NOT be disabled at pointerdown when only click
filters are active. The 3-pixel motion check at pointerup already
disambiguates click vs drag, so:

  - Stationary press with click-only filter -> click fires; camera
    didn't move because there was no motion.
  - Press+drag with click-only filter -> camera orbits (no click sent).
  - Rect-select filter still disables orbit at pointerdown so the
    rubber-band rectangle can be drawn without the camera moving.
"""

from __future__ import annotations

import threading

from playwright.sync_api import Page

import viser

from .utils import canvas_center, wait_for_connection

JS_CAMERA_POSITION = """
() => {
    const camera = window.__viserMutable?.camera;
    return camera ? camera.position.toArray() : null;
}
"""

JS_CAMERA_CONTROL_ENABLED = """
() => {
    const cc = window.__viserMutable?.cameraControl;
    return cc ? cc.enabled : null;
}
"""


def _positions_differ(a: list[float], b: list[float], eps: float = 1e-3) -> bool:
    return any(abs(x - y) > eps for x, y in zip(a, b))


# Off-axis camera pose used by every test in this file. Viser's default up
# direction is +Z, so a position on the +Z axis (e.g. (0, 0, 4)) parks the
# camera at the spherical-orbit pole -- azimuthal mouse drag rotates around
# the up axis without moving the camera, and the orbit asserts below would
# false-negative even though camera-controls IS receiving the input.
_OFF_POLE_POSITION = (3.0, 3.0, 3.0)


def test_scene_on_click_does_not_disable_orbit(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Plain left-drag with only ``scene.on_click()`` registered must
    still orbit the camera. Pre-fix, ``handlePointerDown`` disabled
    camera controls whenever any click filter matched -- so registering
    a no-modifier click handler broke orbit for the entire canvas."""
    viser_server.initial_camera.position = _OFF_POLE_POSITION
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    click_fired = threading.Event()

    @viser_server.scene.on_click()
    def _(event: viser.SceneClickEvent) -> None:
        del event
        click_fired.set()

    viser_page.wait_for_timeout(500)
    cx, cy = canvas_center(viser_page)

    initial = viser_page.evaluate(JS_CAMERA_POSITION)
    assert initial is not None

    # Plain left drag (no modifier).
    viser_page.mouse.move(cx - 80, cy)
    viser_page.mouse.down()
    viser_page.mouse.move(cx + 80, cy + 30, steps=12)
    viser_page.mouse.up()

    # Camera-controls applies damping; allow time for the orbit to
    # propagate to the camera.position the test reads.
    viser_page.wait_for_timeout(400)
    final = viser_page.evaluate(JS_CAMERA_POSITION)
    assert final is not None
    assert _positions_differ(initial, final), (
        f"camera did not orbit on plain left-drag (initial={initial}, "
        f"final={final}); on_click() should not disable camera controls"
    )

    # And because the gesture moved >3px, the click callback must NOT
    # have fired -- a drag is not a click.
    assert not click_fired.is_set(), (
        "click fired for a press+drag gesture; the 3-pixel motion gate "
        "in handlePointerUp should have suppressed it"
    )


def test_scene_on_click_stationary_press_still_fires_click(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """With orbit no longer disabled at pointerdown, a stationary
    press-release must still send the click message. The click path
    goes through ``handlePointerUp``'s no-motion branch -- which
    doesn't depend on whether camera controls were disabled."""
    viser_server.initial_camera.position = _OFF_POLE_POSITION
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    click_fired = threading.Event()

    @viser_server.scene.on_click()
    def _(event: viser.SceneClickEvent) -> None:
        del event
        click_fired.set()

    viser_page.wait_for_timeout(500)
    cx, cy = canvas_center(viser_page)

    initial = viser_page.evaluate(JS_CAMERA_POSITION)
    assert initial is not None

    viser_page.mouse.click(cx, cy)
    assert click_fired.wait(timeout=5.0), (
        "click did not fire for stationary press-release"
    )

    viser_page.wait_for_timeout(200)
    final = viser_page.evaluate(JS_CAMERA_POSITION)
    assert final is not None
    # No motion -> camera-controls had nothing to orbit toward.
    assert not _positions_differ(initial, final), (
        f"camera moved on a stationary click (initial={initial}, "
        f"final={final}) -- this would only happen if pointerdown is "
        "kicking camera-controls into a state it can't recover from"
    )


def test_scene_on_rect_select_still_disables_orbit(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """``on_rect_select()`` must still suppress orbit at pointerdown
    so the rubber-band rectangle can be drawn cleanly. This is the
    pre-existing behavior the fix preserves: orbit-suppression is
    conditional on rect-select, not on click."""
    viser_server.initial_camera.position = _OFF_POLE_POSITION
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    rect_fired = threading.Event()

    @viser_server.scene.on_rect_select()
    def _(event: viser.SceneRectSelectEvent) -> None:
        del event
        rect_fired.set()

    viser_page.wait_for_timeout(500)
    cx, cy = canvas_center(viser_page)

    initial = viser_page.evaluate(JS_CAMERA_POSITION)
    assert initial is not None

    viser_page.mouse.move(cx - 80, cy - 30)
    viser_page.mouse.down()
    viser_page.mouse.move(cx + 80, cy + 30, steps=12)
    viser_page.mouse.up()

    assert rect_fired.wait(timeout=5.0), "rect-select did not fire"

    viser_page.wait_for_timeout(400)
    final = viser_page.evaluate(JS_CAMERA_POSITION)
    assert final is not None
    assert not _positions_differ(initial, final), (
        f"camera orbited during a rect-select gesture (initial={initial}, "
        f"final={final}); rect-select must hold the camera still while "
        "the rubber-band rectangle is drawn"
    )


def test_scene_click_and_rect_select_coexist(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """When both ``on_click()`` and ``on_rect_select(modifier="shift")``
    are registered, the gesture's modifier picks which behavior wins:

      - Plain drag: only the click filter matches; orbit allowed.
      - Shift drag: rect-select matches; orbit suppressed.

    This catches a pre-fix bug where any matching filter (click
    included) disabled orbit -- a plain drag with both filters
    registered would have stayed put even though only click was active.
    """
    viser_server.initial_camera.position = _OFF_POLE_POSITION
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    click_fired = threading.Event()
    rect_fired = threading.Event()

    @viser_server.scene.on_click()
    def _click(event: viser.SceneClickEvent) -> None:
        del event
        click_fired.set()

    @viser_server.scene.on_rect_select(modifier="shift")
    def _rect(event: viser.SceneRectSelectEvent) -> None:
        del event
        rect_fired.set()

    del _click, _rect

    viser_page.wait_for_timeout(500)
    cx, cy = canvas_center(viser_page)

    # --- Plain drag: should orbit, not fire either callback. ---
    initial = viser_page.evaluate(JS_CAMERA_POSITION)
    assert initial is not None

    viser_page.mouse.move(cx - 80, cy)
    viser_page.mouse.down()
    viser_page.mouse.move(cx + 80, cy + 30, steps=12)
    viser_page.mouse.up()
    viser_page.wait_for_timeout(400)

    after_plain_drag = viser_page.evaluate(JS_CAMERA_POSITION)
    assert after_plain_drag is not None
    assert _positions_differ(initial, after_plain_drag), (
        "plain drag did not orbit even though only click filter matched"
    )
    assert not click_fired.is_set(), "plain drag (>3px) fired the click handler"
    assert not rect_fired.is_set(), (
        "plain drag fired the shift-only rect-select handler"
    )

    # --- Shift drag: should fire rect-select; should NOT orbit. ---
    before_shift = viser_page.evaluate(JS_CAMERA_POSITION)
    assert before_shift is not None

    viser_page.keyboard.down("Shift")
    try:
        viser_page.mouse.move(cx - 80, cy - 30)
        viser_page.mouse.down()
        viser_page.mouse.move(cx + 80, cy + 30, steps=12)
        viser_page.mouse.up()
    finally:
        viser_page.keyboard.up("Shift")

    assert rect_fired.wait(timeout=5.0), "shift-drag did not fire rect-select"
    viser_page.wait_for_timeout(400)
    after_shift = viser_page.evaluate(JS_CAMERA_POSITION)
    assert after_shift is not None
    assert not _positions_differ(before_shift, after_shift), (
        "camera orbited during shift+drag rect-select; rect-select must "
        "still suppress orbit"
    )


def test_modifier_filtered_click_does_not_block_plain_orbit(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """An ``on_click(modifier="cmd/ctrl")`` filter should not affect
    plain (no modifier) gestures at all -- the active-filter set for a
    plain pointerdown is empty, so the early-return at the top of
    ``handlePointerDown`` keeps the gesture in camera-controls' hands.

    Sibling sanity check to the click-disables-orbit regression: makes
    sure the modifier-gating early-return path (which the fix didn't
    touch) still works."""
    viser_server.initial_camera.position = _OFF_POLE_POSITION
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    cmd_click_fired = threading.Event()

    @viser_server.scene.on_click(modifier="cmd/ctrl")
    def _(event: viser.SceneClickEvent) -> None:
        del event
        cmd_click_fired.set()

    viser_page.wait_for_timeout(500)
    cx, cy = canvas_center(viser_page)

    initial = viser_page.evaluate(JS_CAMERA_POSITION)
    assert initial is not None

    viser_page.mouse.move(cx - 80, cy)
    viser_page.mouse.down()
    viser_page.mouse.move(cx + 80, cy + 30, steps=12)
    viser_page.mouse.up()
    viser_page.wait_for_timeout(400)

    final = viser_page.evaluate(JS_CAMERA_POSITION)
    assert final is not None
    assert _positions_differ(initial, final), (
        "plain drag failed to orbit while a cmd/ctrl-only click filter "
        "was registered; the no-active-filter early-return regressed"
    )
    assert not cmd_click_fired.is_set(), (
        "cmd/ctrl click handler fired on a plain (no modifier) drag"
    )


def test_camera_control_enabled_after_click_only_pointerdown(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """White-box check: after a pointerdown that matches only a click
    filter, ``cameraControl.enabled`` must remain ``true``. Catches
    the bug at its source -- the orbit/no-orbit asserts in the other
    tests are downstream of this flag, so failure here pinpoints the
    regression to ``handlePointerDown`` rather than to the camera-
    controls integration or the lerp timing."""
    viser_server.initial_camera.position = _OFF_POLE_POSITION
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    @viser_server.scene.on_click()
    def _(event: viser.SceneClickEvent) -> None:
        del event

    wait_for_connection(page, viser_server.get_port())
    page.wait_for_function(
        "() => window.__viserMutable?.cameraControl != null", timeout=10_000
    )
    cx, cy = canvas_center(page)

    page.mouse.move(cx, cy)
    page.mouse.down()
    try:
        # Read mid-gesture: pre-fix, this would be False.
        enabled_during = page.evaluate(JS_CAMERA_CONTROL_ENABLED)
        assert enabled_during is True, (
            f"cameraControl.enabled={enabled_during} during a click-only "
            "pointerdown; the fix in handlePointerDown should leave it "
            "enabled when only click (no rect-select) is active"
        )
    finally:
        page.mouse.up()


def test_camera_control_disabled_during_rect_select_drag(
    page: Page,
    viser_server: viser.ViserServer,
) -> None:
    """White-box counterpart: ``cameraControl.enabled`` must be ``false``
    while a matching rect-select gesture is in flight. Confirms the
    fix didn't over-broaden -- rect-select still steals the gesture
    from the camera, which is required for the rubber-band rectangle
    to render against a stationary background."""
    viser_server.initial_camera.position = _OFF_POLE_POSITION
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    @viser_server.scene.on_rect_select()
    def _(event: viser.SceneRectSelectEvent) -> None:
        del event

    wait_for_connection(page, viser_server.get_port())
    page.wait_for_function(
        "() => window.__viserMutable?.cameraControl != null", timeout=10_000
    )
    cx, cy = canvas_center(page)

    page.mouse.move(cx - 40, cy - 40)
    page.mouse.down()
    try:
        enabled_during = page.evaluate(JS_CAMERA_CONTROL_ENABLED)
        assert enabled_during is False, (
            f"cameraControl.enabled={enabled_during} during a rect-select "
            "pointerdown; rect-select must disable orbit so the "
            "rubber-band rectangle draws against a still scene"
        )
    finally:
        page.mouse.up()
