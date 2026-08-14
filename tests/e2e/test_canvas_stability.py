"""E2E tests for canvas/camera stability under layout and bound changes.

1. Crossing the mobile breakpoint must NOT remount the WebGL canvas or reset
   the camera: the dock surface now stays mounted as a passthrough container
   and toggles its panes instead of swapping the element wrapping the canvas
   (regression: rotating a phone or resizing across ~576px recreated the
   WebGL context and snapped the camera to its initial pose).

2. A camera legitimately placed beyond the configured max orbit distance
   (large-coordinate scenes under the 1e4 default) must not be TELEPORTED to
   the bound by the first scroll tick: the effective bound ratchets to the
   current distance while outside the configured one.
"""

from __future__ import annotations

import time

import numpy as np
from playwright.sync_api import Page

import viser


def _wait_for(predicate, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def _sole_client(server: viser.ViserServer) -> viser.ClientHandle:
    assert _wait_for(lambda: len(server.get_clients()) == 1)
    return next(iter(server.get_clients().values()))


def test_mobile_breakpoint_crossing_preserves_canvas_and_camera(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    viser_server.scene.add_box("/box", dimensions=(1, 1, 1), color=(255, 0, 0))
    client = _sole_client(viser_server)

    # Move the camera off its initial pose, and wait for the client echo.
    client.camera.position = (3.0, 3.0, 3.0)
    client.camera.look_at = (0.0, 0.0, 0.0)
    assert _wait_for(
        lambda: np.allclose(client.camera.position, (3.0, 3.0, 3.0), atol=0.3)
    )

    viser_page.evaluate("window.__canvasBefore = document.querySelector('canvas')")

    # Cross to mobile and back (phone rotation / window resize).
    viser_page.set_viewport_size({"width": 390, "height": 844})
    viser_page.wait_for_timeout(700)
    viser_page.set_viewport_size({"width": 1280, "height": 720})
    viser_page.wait_for_timeout(700)

    assert viser_page.evaluate(
        "window.__canvasBefore === document.querySelector('canvas')"
    ), "canvas element was remounted across the mobile breakpoint"
    assert np.allclose(client.camera.position, (3.0, 3.0, 3.0), atol=0.5), (
        f"camera reset across the breakpoint: {client.camera.position}"
    )


def test_camera_beyond_max_orbit_distance_does_not_snap_on_scroll(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    viser_server.scene.add_box("/box", dimensions=(1, 1, 1), color=(255, 0, 0))
    client = _sole_client(viser_server)

    # Park the camera far beyond the 1e4 default bound, as a large-coordinate
    # scene would.
    far = 5.0e4
    client.camera.position = (0.0, far, far)
    client.camera.look_at = (0.0, 0.0, 0.0)
    start_dist = float(np.linalg.norm(np.array([0.0, far, far])))
    assert _wait_for(
        lambda: (
            abs(float(np.linalg.norm(client.camera.position)) - start_dist)
            < start_dist * 0.05
        )
    )

    # One scroll tick inward. Pre-fix this teleported to distance 1e4.
    viser_page.mouse.move(640, 360)
    viser_page.mouse.wheel(0, -120)
    viser_page.wait_for_timeout(800)

    dist = float(np.linalg.norm(client.camera.position))
    assert dist < start_dist, "scroll-in did not move the camera"
    assert dist > start_dist * 0.5, (
        f"camera teleported toward the max-orbit bound: {dist:.0f} "
        f"(started at {start_dist:.0f})"
    )

    # Scrolling outward must still be blocked at the ratcheted bound: the
    # camera cannot walk further out than where the server parked it.
    before_out = float(np.linalg.norm(client.camera.position))
    viser_page.mouse.wheel(0, 120)
    viser_page.wait_for_timeout(800)
    after_out = float(np.linalg.norm(client.camera.position))
    assert after_out <= before_out * 1.05, (
        f"zoom-out escaped the ratcheted bound: {after_out:.0f} from {before_out:.0f}"
    )
