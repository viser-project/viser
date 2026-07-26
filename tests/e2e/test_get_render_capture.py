"""get_render() capture correctness, across transport formats.

The client-side capture path is latency-optimized: a request that arrives
alone captures in the same frame it is processed (after the SceneTree pose
appliers), a request that arrives alongside scene updates waits exactly one
frame for React to commit them, JPEG/PNG encoding happens off the
message-handling critical path, and the "raw" transport skips image
encoding entirely. These tests pin the contract those optimizations must
preserve: a frame returned by get_render() reflects every scene update made
before the call, and every transport format returns sane pixels.
"""

from __future__ import annotations

import time
from typing import Generator

import numpy as np
import pytest
from playwright.sync_api import Browser

import viser
import viser._client_autobuild

from .utils import find_free_port, wait_for_connection, wait_for_server_ready


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


def _connect_client(
    own_server: viser.ViserServer, browser: Browser
) -> tuple[viser.ClientHandle, object, object]:
    captured: list[viser.ClientHandle] = []
    own_server.on_client_connect(lambda client: captured.append(client))
    context = browser.new_context()
    page = context.new_page()
    wait_for_connection(page, own_server.get_port())
    deadline = time.monotonic() + 10
    while not captured and time.monotonic() < deadline:
        time.sleep(0.05)
    assert captured, "client never connected"
    client = captured[0]
    # Wait for the first camera update so get_render() can read camera state.
    while client.camera._state.update_timestamp == 0.0 and (
        time.monotonic() < deadline
    ):
        time.sleep(0.05)
    assert client.camera._state.update_timestamp != 0.0, "camera never synced"
    return client, page, context


def _center_mean(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    return img[
        h // 2 - h // 8 : h // 2 + h // 8,
        w // 2 - w // 8 : w // 2 + w // 8,
        :3,
    ].mean(axis=(0, 1))


def test_get_render_reflects_prior_scene_updates(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    """A capture requested immediately after a scene mutation must show that
    mutation. This exercises the "commit_wait" path (update + request race
    down two different server buffers and the client needs a React commit
    before capturing) repeatedly, alternating colors so ANY stale frame
    fails the dominant-channel check."""
    client, page, context = _connect_client(own_server, browser)
    try:
        # A box that fills the view center from the default camera pose.
        box = own_server.scene.add_box(
            "/box", color=(255, 0, 0), dimensions=(2.0, 2.0, 2.0)
        )
        colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255)] * 2
        for i, color in enumerate(colors):
            box.color = color
            img = client.get_render(
                height=96, width=128, transport_format="raw", timeout=30.0
            )
            center = _center_mean(img)
            expected_channel = int(np.argmax(color))
            assert int(np.argmax(center)) == expected_channel, (
                f"iteration {i}: set color {color} but captured center "
                f"{center} -- get_render() returned a stale frame"
            )
    finally:
        page.close()  # type: ignore[attr-defined]
        context.close()  # type: ignore[attr-defined]


def test_get_render_transport_formats_agree(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    """All three transport formats return correctly-shaped arrays of the same
    scene: JPEG (H, W, 3), PNG and raw (H, W, 4) -- with raw and PNG (both
    lossless, same render path) agreeing on the center pixels, and repeated
    solo captures (the same-frame fast path) staying stable."""
    client, page, context = _connect_client(own_server, browser)
    try:
        own_server.scene.add_box(
            "/box", color=(0, 120, 255), dimensions=(2.0, 2.0, 2.0)
        )
        h, w = 96, 128
        jpeg = client.get_render(height=h, width=w, transport_format="jpeg", timeout=30)
        png = client.get_render(height=h, width=w, transport_format="png", timeout=30)
        raw = client.get_render(height=h, width=w, transport_format="raw", timeout=30)
        assert jpeg.shape == (h, w, 3) and jpeg.dtype == np.uint8
        assert png.shape == (h, w, 4) and png.dtype == np.uint8
        assert raw.shape == (h, w, 4) and raw.dtype == np.uint8
        # Lossless formats agree on the (fully opaque) box at the center.
        assert np.allclose(_center_mean(png), _center_mean(raw), atol=3.0), (
            f"png center {_center_mean(png)} != raw center {_center_mean(raw)}"
        )
        assert np.allclose(_center_mean(jpeg), _center_mean(raw), atol=12.0)
        # The center is opaque in the alpha formats.
        assert int(raw[h // 2, w // 2, 3]) == 255
        assert int(png[h // 2, w // 2, 3]) == 255

        # Back-to-back solo captures (no interleaved scene updates) take the
        # same-frame capture path; they must stay correct and identical-ish.
        again = client.get_render(height=h, width=w, transport_format="raw", timeout=30)
        assert np.allclose(_center_mean(again), _center_mean(raw), atol=3.0)
    finally:
        page.close()  # type: ignore[attr-defined]
        context.close()  # type: ignore[attr-defined]
