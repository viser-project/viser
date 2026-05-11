"""E2E tests for the per-node tap-vs-drag rule.

A node with BOTH ``on_click`` and ``on_drag_*`` bound on the same input
must:

  - Fire ``on_click`` (and NOT ``drag_start``/``drag_end``) when the
    user releases without moving past ``MOTION_THRESHOLD_PX``.
  - Fire ``drag_start`` / ``drag_update`` / ``drag_end`` (and NOT
    ``on_click``) when the user moves past threshold before
    releasing.
  - Hold ``cameraControl.enabled = false`` for the entire duration of
    the candidate gesture (between pointerdown and either resolution
    point), so the first 3 px of motion don't trickle into the camera
    as a tiny orbit.
  - Release the camera-control lease on every termination path
    (click dispatch, drag promotion, pointercancel).

This covers the SceneTree ``pendingDrag`` / ``pendingDragCameraLease``
backport that ships ahead of the full InputManager migration. After
step 8 of the migration the runtime ownership moves into the
InputManager but the externally-observable contract is the same;
these tests should keep passing.

Drag-only nodes (``draggable=true, clickable=false``) and click-only
nodes are covered by ``test_scene_node_drag.py`` and the existing
SceneTree click path.
"""

from __future__ import annotations

import threading
import time

from playwright.sync_api import Page

import viser

from .utils import (
    JS_CAMERA_ENABLED,
    JS_LEASE_REASONS,
    canvas_center,
    wait_for_scene_node,
)


def _add_click_and_drag_box(
    server: viser.ViserServer,
) -> tuple[
    viser.BoxHandle,
    threading.Event,
    threading.Event,
    threading.Event,
    threading.Event,
    dict[str, int],
]:
    """Create a large box bound for both click and drag on plain
    left, no modifier. Returns the handle plus event flags + counters
    the test asserts on."""
    box = server.scene.add_box(
        "/cd_box",
        dimensions=(4.0, 4.0, 0.2),
        color=(120, 230, 60),
    )
    click_evt = threading.Event()
    drag_start_evt = threading.Event()
    drag_update_evt = threading.Event()
    drag_end_evt = threading.Event()
    counters = {"click": 0, "start": 0, "update": 0, "end": 0}
    lock = threading.Lock()

    @box.on_click
    def _(event: viser.SceneNodePointerEvent[viser.BoxHandle]) -> None:
        del event
        with lock:
            counters["click"] += 1
        click_evt.set()

    @box.on_drag_start("left")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        with lock:
            counters["start"] += 1
        drag_start_evt.set()

    @box.on_drag_update("left")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        with lock:
            counters["update"] += 1
        drag_update_evt.set()

    @box.on_drag_end("left")
    def _(event: viser.SceneNodeDragEvent[viser.BoxHandle]) -> None:
        del event
        with lock:
            counters["end"] += 1
        drag_end_evt.set()

    return (box, click_evt, drag_start_evt, drag_update_evt, drag_end_evt, counters)


def test_stationary_tap_fires_click_not_drag(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A press-and-release on a click+drag node with NO motion fires
    ``on_click`` exactly once and never fires ``drag_start``."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)
    _, click_evt, drag_start_evt, _, _, counters = _add_click_and_drag_box(viser_server)
    wait_for_scene_node(viser_page, "/cd_box")

    cx, cy = canvas_center(viser_page)
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()
    viser_page.mouse.up()

    assert click_evt.wait(2.0), "click handler did not fire on stationary tap"
    # Give any racing drag_start a chance to (incorrectly) fire.
    time.sleep(0.2)
    assert not drag_start_evt.is_set(), (
        "drag_start fired on stationary tap; tap-vs-drag rule regressed"
    )
    assert counters["click"] == 1
    assert counters["start"] == 0
    assert counters["end"] == 0


def test_drag_past_threshold_fires_drag_not_click(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A press that moves past the motion threshold before release
    fires ``drag_start`` / ``drag_end`` and never fires
    ``on_click``."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)
    (
        _,
        click_evt,
        drag_start_evt,
        _,
        drag_end_evt,
        counters,
    ) = _add_click_and_drag_box(viser_server)
    wait_for_scene_node(viser_page, "/cd_box")

    cx, cy = canvas_center(viser_page)
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()
    viser_page.mouse.move(cx + 80, cy + 40, steps=12)
    viser_page.mouse.up()

    assert drag_start_evt.wait(2.0), "drag_start did not fire on threshold drag"
    assert drag_end_evt.wait(2.0), "drag_end did not fire on release"
    # Give any racing click a chance to (incorrectly) fire.
    time.sleep(0.2)
    assert not click_evt.is_set(), (
        "click fired in addition to drag; tap and drag should be mutually exclusive"
    )
    assert counters["click"] == 0
    assert counters["start"] == 1
    assert counters["end"] == 1


def test_camera_disabled_during_candidate(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """Between pointerdown and resolution, the click+drag candidate
    holds a camera-control lease, so ``cameraControl.enabled`` is
    ``false`` and the first 3 px of motion don't trickle into the
    camera as orbit."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    _add_click_and_drag_box(viser_server)
    wait_for_scene_node(viser_page, "/cd_box")

    cx, cy = canvas_center(viser_page)
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()

    # During the candidate window: camera is disabled and the
    # lease reason is the click-or-drag candidate.
    enabled_during = viser_page.evaluate(JS_CAMERA_ENABLED)
    leases_during = viser_page.evaluate(JS_LEASE_REASONS)
    assert enabled_during is False, (
        f"camera should be disabled during click+drag candidate; got {enabled_during}"
    )
    assert "node-click-or-drag-candidate" in leases_during, (
        f"expected click-or-drag candidate lease; got {leases_during}"
    )

    viser_page.mouse.up()
    # On stationary release, click fires and the lease is released.
    time.sleep(0.2)
    enabled_after = viser_page.evaluate(JS_CAMERA_ENABLED)
    leases_after = viser_page.evaluate(JS_LEASE_REASONS)
    assert enabled_after is True
    assert "node-click-or-drag-candidate" not in leases_after


def test_camera_re_enables_after_drag(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """After a drag promotes from the candidate, the candidate's lease
    is released and ``DragLayer``'s drag-lifetime lease takes over.
    On drag end, the drag lease is released and camera returns to
    ``enabled=true``."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    _add_click_and_drag_box(viser_server)
    wait_for_scene_node(viser_page, "/cd_box")

    cx, cy = canvas_center(viser_page)
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()
    viser_page.mouse.move(cx + 80, cy + 40, steps=12)

    # Mid-drag: camera should still be disabled, but now via
    # the node-drag lease (DragLayer's), not the candidate.
    enabled_mid = viser_page.evaluate(JS_CAMERA_ENABLED)
    leases_mid = viser_page.evaluate(JS_LEASE_REASONS)
    assert enabled_mid is False
    assert "node-drag" in leases_mid, (
        f"expected node-drag lease mid-drag; got {leases_mid}"
    )
    # Candidate lease must have been dropped after promotion.
    assert "node-click-or-drag-candidate" not in leases_mid, (
        f"candidate lease leaked into drag; got {leases_mid}"
    )

    viser_page.mouse.up()
    time.sleep(0.2)
    enabled_after = viser_page.evaluate(JS_CAMERA_ENABLED)
    leases_after = viser_page.evaluate(JS_LEASE_REASONS)
    assert enabled_after is True
    assert leases_after == [], f"leases not fully released; got {leases_after}"


def test_pointercancel_during_candidate_releases_lease(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A ``pointercancel`` while a click+drag candidate is in flight
    drops the pending state and releases the candidate lease, with no
    click and no drag dispatched."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    _, click_evt, drag_start_evt, _, _, counters = _add_click_and_drag_box(viser_server)
    wait_for_scene_node(viser_page, "/cd_box")

    cx, cy = canvas_center(viser_page)
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()

    # Synthetic pointercancel on the canvas (simulates touch palm
    # rejection / OS takeover).
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
    time.sleep(0.2)

    enabled = viser_page.evaluate(JS_CAMERA_ENABLED)
    leases = viser_page.evaluate(JS_LEASE_REASONS)
    assert enabled is True
    assert leases == [], f"candidate lease leaked through cancel; got {leases}"
    assert counters["click"] == 0
    assert counters["start"] == 0
    assert not click_evt.is_set()
    assert not drag_start_evt.is_set()
    # Clean up the still-held mouse button.
    viser_page.mouse.up()


def test_separate_tap_after_drag_does_not_double_fire(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A drag press followed by a separate tap press: drag dispatches
    only on the first press and click dispatches only on the second.
    Counters ratchet independently — tapping after dragging never
    fires ``on_click`` *during* the drag, and dragging after tapping
    never fires ``drag_start`` *during* the tap."""
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    _, _, _, _, _, counters = _add_click_and_drag_box(viser_server)
    wait_for_scene_node(viser_page, "/cd_box")

    cx, cy = canvas_center(viser_page)

    # First press: drag.
    viser_page.mouse.move(cx, cy)
    viser_page.mouse.down()
    viser_page.mouse.move(cx + 80, cy + 40, steps=12)
    viser_page.mouse.up()
    time.sleep(0.2)

    # Second press: stationary tap.
    viser_page.mouse.move(cx - 20, cy - 20)
    viser_page.mouse.down()
    viser_page.mouse.up()
    time.sleep(0.3)

    assert counters["start"] == 1, (
        f"expected exactly 1 drag_start across 2 presses; got {counters}"
    )
    assert counters["end"] == 1
    assert counters["click"] == 1, (
        f"expected exactly 1 click across 2 presses; got {counters}"
    )


def test_rapid_second_pointerdown_does_not_leak_lease(
    viser_server: viser.ViserServer, viser_page: Page
) -> None:
    """A second ``pointerdown`` event arriving on the SAME
    clickable+draggable node before the first releases must release
    the previous candidate lease (and tear down the previous window
    listeners) before installing the new candidate. Without the fix
    the ``state.pendingDragTeardown`` slot is overwritten and the
    previous press's three window listeners + camera lease leak
    indefinitely.

    Trigger via two synthetic pointerdowns with different pointer
    ids -- the second one classifies the same way (click+drag
    candidate) and would overwrite the first's state. After both
    eventually release, ``leaseReasonsList()`` must be empty.
    """
    viser_server.initial_camera.position = (0.0, 0.0, 4.0)
    _add_click_and_drag_box(viser_server)
    wait_for_scene_node(viser_page, "/cd_box")

    cx, cy = canvas_center(viser_page)

    # Synthetic pointer #1 begins; candidate lease acquired.
    viser_page.evaluate(
        """
        ([cx, cy]) => {
            const canvas = window.__viserMutable.canvas;
            canvas.dispatchEvent(new PointerEvent("pointerdown", {
                pointerId: 101, button: 0, buttons: 1,
                clientX: cx, clientY: cy,
                bubbles: true, cancelable: true,
            }));
        }
        """,
        [cx, cy],
    )
    time.sleep(0.05)
    leases_first = viser_page.evaluate(
        "() => window.__viserMutable.cameraControlOwner.leaseReasonsList()"
    )

    # Synthetic pointer #2 begins on the same node before #1 releases.
    # The fix releases #1's lease before installing #2's. Without the
    # fix, both leases would be held simultaneously.
    viser_page.evaluate(
        """
        ([cx, cy]) => {
            const canvas = window.__viserMutable.canvas;
            canvas.dispatchEvent(new PointerEvent("pointerdown", {
                pointerId: 102, button: 0, buttons: 1,
                clientX: cx, clientY: cy,
                bubbles: true, cancelable: true,
            }));
        }
        """,
        [cx, cy],
    )
    time.sleep(0.05)
    leases_after_second = viser_page.evaluate(
        "() => window.__viserMutable.cameraControlOwner.leaseReasonsList()"
    )

    # Release pointer #2.
    viser_page.evaluate(
        """
        ([cx, cy]) => {
            const canvas = window.__viserMutable.canvas;
            canvas.dispatchEvent(new PointerEvent("pointerup", {
                pointerId: 102, button: 0, buttons: 0,
                clientX: cx, clientY: cy,
                bubbles: true, cancelable: true,
            }));
        }
        """,
        [cx, cy],
    )
    time.sleep(0.2)
    leases_final = viser_page.evaluate(
        "() => window.__viserMutable.cameraControlOwner.leaseReasonsList()"
    )

    # After pointer #1: exactly one candidate lease.
    assert leases_first.count("node-click-or-drag-candidate") == 1, (
        f"expected one candidate lease after pointer #1; got {leases_first}"
    )
    # After pointer #2: STILL exactly one (the first was released by
    # the fix). Pre-fix this would be two.
    assert leases_after_second.count("node-click-or-drag-candidate") == 1, (
        f"second pointerdown must release the previous candidate "
        f"lease; got {leases_after_second}"
    )
    # After release: zero leases.
    assert leases_final == [], f"final leases not empty: {leases_final}"
