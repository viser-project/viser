"""Pixel-level verification of cross-scope shadowing, via get_render().

The store-level halves of these behaviors are covered by
``test_cross_scope_handles.py`` (frontend state) and
``tests/test_scene_scopes.py`` (server state); here we verify the actually
rendered pixels: a shadowing client variant is what that client SEES, other
clients keep seeing the broadcast variant, un-shadowing reveals the
broadcast variant's LATEST state, and scope-local cascade leaves a client
child visibly on screen after its broadcast parent is removed.

Conventions follow ``test_get_render_capture.py``: a box big enough to fill
the view center from the default camera pose, pure-channel colors, and
dominant-channel assertions on the center patch.
"""

from __future__ import annotations

import time
from typing import Generator

import numpy as np
import pytest
from playwright.sync_api import Browser

import viser
import viser._client_autobuild

from .utils import center_mean, connect_client, find_free_port, wait_for_server_ready

RED = (255, 0, 0)
GREEN = (0, 255, 0)
BLUE = (0, 0, 255)


@pytest.fixture()
def own_server() -> Generator[viser.ViserServer, None, None]:
    viser._client_autobuild.ensure_client_is_built = lambda: None
    server: viser.ViserServer | None = None
    for attempt in range(3):
        try:
            server = viser.ViserServer(port=find_free_port(), verbose=False)
            break
        except OSError:
            if attempt == 2:
                raise
    assert server is not None
    wait_for_server_ready(server.get_port())
    yield server
    server.stop()


def _capture_center(client: viser.ClientHandle) -> np.ndarray:
    img = client.get_render(height=96, width=128, timeout=30.0)
    return center_mean(img)


def _assert_dominant(
    client: viser.ClientHandle, color: tuple[int, int, int], label: str
) -> None:
    """The center patch's dominant channel must match `color`. Captures can
    race the ~1-frame shadow remount, so retry briefly before failing. Every
    capture is evaluated BEFORE the deadline check: a single software-WebGL
    capture can exceed the whole retry budget under load, and a passing
    frame must not be discarded just because it arrived late."""
    deadline = time.monotonic() + 10.0
    while True:
        center = _capture_center(client)
        if int(np.argmax(center)) == int(np.argmax(color)) and center.max() > 60:
            return
        if time.monotonic() > deadline:
            raise AssertionError(
                f"{label}: expected dominant {color}, captured {center}"
            )
        time.sleep(0.2)


def test_shadowing_pixels_round_trip(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    """RED server box -> GREEN client variant shadows it -> server recolors
    its hidden variant BLUE (display unchanged) -> un-shadow reveals BLUE."""
    client, page, context = connect_client(own_server, browser)
    try:
        server_box = own_server.scene.add_box(
            "/box", color=RED, dimensions=(2.0, 2.0, 2.0)
        )
        _assert_dominant(client, RED, "baseline server box")

        client_box = client.scene.add_box(
            "/box", color=GREEN, dimensions=(2.0, 2.0, 2.0)
        )
        _assert_dominant(client, GREEN, "client variant shadows")

        # Server updates its shadowed variant; this client's view must not
        # change.
        server_box.color = BLUE
        time.sleep(0.5)
        _assert_dominant(client, GREEN, "shadowed server update hidden")

        # Un-shadow: the server variant reappears with its LATEST color.
        client_box.remove()
        _assert_dominant(client, BLUE, "un-shadow reveals latest state")
    finally:
        page.close()
        context.close()


def test_two_clients_see_their_own_variant(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    """A shadowing variant is per-client: the shadowing client sees GREEN
    while a second client keeps seeing the server's RED."""
    client1, page1, context1 = connect_client(own_server, browser)
    client2, page2, context2 = connect_client(own_server, browser)
    assert client1.client_id != client2.client_id
    try:
        own_server.scene.add_box("/box", color=RED, dimensions=(2.0, 2.0, 2.0))
        _assert_dominant(client1, RED, "client1 baseline")
        _assert_dominant(client2, RED, "client2 baseline")

        client1.scene.add_box("/box", color=GREEN, dimensions=(2.0, 2.0, 2.0))
        _assert_dominant(client1, GREEN, "client1 sees own variant")
        _assert_dominant(client2, RED, "client2 unaffected")
    finally:
        page1.close()
        context1.close()
        page2.close()
        context2.close()


def test_scope_local_cascade_child_stays_on_screen(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    """A client child under a broadcast parent remains VISIBLE (not just in
    the store) after the parent is removed, then disappears when its own
    scope removes it."""
    client, page, context = connect_client(own_server, browser)
    try:
        parent = own_server.scene.add_frame("/parent", show_axes=False)
        child = client.scene.add_box(
            "/parent/child", color=GREEN, dimensions=(2.0, 2.0, 2.0)
        )
        _assert_dominant(client, GREEN, "child visible under broadcast parent")

        parent.remove()
        time.sleep(0.5)
        _assert_dominant(client, GREEN, "child survives broadcast cascade")

        child.remove()
        # Background: all channels bright (white-ish), nothing green-dominant
        # at high saturation.
        deadline = time.monotonic() + 5.0
        center = _capture_center(client)
        while time.monotonic() < deadline and not np.all(center > 200):
            time.sleep(0.2)
            center = _capture_center(client)
        assert np.all(center > 200), (
            f"child still visible after its own removal: center {center}"
        )
    finally:
        page.close()
        context.close()
