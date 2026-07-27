"""get_render() capture correctness, across transport formats.

The client-side capture path is latency-optimized: a request that arrives
alone captures in the same frame it is processed (after the SceneTree pose
appliers), a request that arrives alongside scene updates waits exactly one
frame for React to commit them, JPEG/PNG encoding happens off the
message-handling critical path, and the deflate_rgb/deflate_rgba transports skip
image encoding entirely. These tests pin the contract those optimizations must
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
                height=96, width=128, transport_format="deflate_rgba", timeout=30.0
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


def test_get_render_reflects_fresh_node_poses(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    """A capture requested immediately after ADDING a node at a pose must show
    the node at that pose. This is the narrowest window of the same-frame
    capture path: a fresh mount's pose transitions "waitForMakeObject" ->
    "needsUpdate" via a passive React effect, which -- unlike the store
    commit itself -- is not synchronously flushed with the sync-lane render.
    The capture hook's defensive pose sweep plus the one-frame commit wait
    must cover it; a capture of the box at the default pose (origin) or the
    previous box's position fails the centroid side check."""
    client, page, context = _connect_client(own_server, browser)
    try:
        h, w = 96, 128

        def centroid_x(img: np.ndarray) -> float:
            xs = np.nonzero(img[:, :, 3] > 128)[1]
            return float(xs.mean()) if len(xs) else float("nan")

        # Ground truth: let each position fully settle, then capture.
        truth = {}
        for x in (-1.5, 1.5):
            own_server.scene.add_box(
                "/truth", color=(255, 0, 0), dimensions=(1, 1, 1), position=(x, 0, 0)
            )
            time.sleep(1.0)
            truth[x] = centroid_x(
                client.get_render(
                    height=h, width=w, transport_format="deflate_rgba", timeout=30
                )
            )
        own_server.scene.remove_by_name("/truth")
        time.sleep(0.5)
        mid = (truth[-1.5] + truth[1.5]) / 2
        assert abs(truth[-1.5] - truth[1.5]) > 15, (
            f"positions not distinguishable from the default camera: {truth}"
        )

        # Rapid add-at-pose -> capture cycles, alternating sides, each with a
        # FRESH node name (a true first mount) and the previous node removed.
        for i in range(12):
            x = -1.5 if i % 2 == 0 else 1.5
            if i > 0:
                own_server.scene.remove_by_name(f"/fresh_{i - 1}")
            own_server.scene.add_box(
                f"/fresh_{i}",
                color=(255, 0, 0),
                dimensions=(1, 1, 1),
                position=(x, 0, 0),
            )
            img = client.get_render(
                height=h, width=w, transport_format="deflate_rgba", timeout=30.0
            )
            cx = centroid_x(img)
            assert np.isfinite(cx) and (cx < mid) == (truth[x] < mid), (
                f"iteration {i}: box added at x={x} but captured centroid "
                f"{cx:.1f}px (expected side of {mid:.1f}) -- capture ran "
                "before the fresh node's pose was applied"
            )
    finally:
        page.close()  # type: ignore[attr-defined]
        context.close()  # type: ignore[attr-defined]


def test_get_render_transport_formats_agree(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    """All transport formats return correctly-shaped arrays of the same
    scene: JPEG and deflate_rgb (H, W, 3) on white; PNG and deflate_rgba (H, W, 4)
    on transparent -- with the lossless formats agreeing on the center
    pixels, corner pixels showing each format's background convention, and
    repeated solo captures (the same-frame fast path) staying stable."""
    client, page, context = _connect_client(own_server, browser)
    try:
        own_server.scene.add_box(
            "/box", color=(0, 120, 255), dimensions=(2.0, 2.0, 2.0)
        )
        h, w = 96, 128
        # The environment lighting loads asynchronously after connect, so
        # captures taken before/after it lands have different shading (that's
        # true for a capture at any speed, and not what this test is about).
        # Stabilize first: capture until two consecutive frames agree.
        prev = None
        for _ in range(40):
            cur = _center_mean(
                client.get_render(
                    height=h, width=w, transport_format="deflate_rgba", timeout=30
                )
            )
            if prev is not None and np.allclose(cur, prev, atol=2.0):
                break
            prev = cur
            time.sleep(0.1)
        jpeg = client.get_render(height=h, width=w, transport_format="jpeg", timeout=30)
        png = client.get_render(height=h, width=w, transport_format="png", timeout=30)
        raw = client.get_render(
            height=h, width=w, transport_format="deflate_rgba", timeout=30
        )
        rgb = client.get_render(
            height=h, width=w, transport_format="deflate_rgb", timeout=30
        )
        assert jpeg.shape == (h, w, 3) and jpeg.dtype == np.uint8
        assert png.shape == (h, w, 4) and png.dtype == np.uint8
        assert raw.shape == (h, w, 4) and raw.dtype == np.uint8
        assert rgb.shape == (h, w, 3) and rgb.dtype == np.uint8
        # Same-background formats agree on the full center region...
        assert np.allclose(_center_mean(png), _center_mean(raw), atol=3.0), (
            f"png center {_center_mean(png)} != raw center {_center_mean(raw)}"
        )
        assert np.allclose(_center_mean(jpeg), _center_mean(rgb), atol=12.0)
        # ...while rgb-vs-rgba are compared only where the box is fully
        # opaque: background pixels legitimately differ (white vs
        # transparent), and the center window can catch some.
        mask = raw[:, :, 3] == 255
        assert mask.mean() > 0.02, "no opaque pixels to compare"
        assert np.allclose(
            rgb[mask].mean(axis=0), raw[mask][:, :3].mean(axis=0), atol=3.0
        ), f"rgb {rgb[mask].mean(axis=0)} != rgba {raw[mask][:, :3].mean(axis=0)}"
        # The center is opaque in the alpha formats.
        assert int(raw[h // 2, w // 2, 3]) == 255
        assert int(png[h // 2, w // 2, 3]) == 255
        # Background conventions: the corner is off-scene from the default
        # camera -- transparent for the RGBA formats, white for the RGB ones.
        assert int(raw[0, 0, 3]) == 0 and int(png[0, 0, 3]) == 0
        assert np.all(rgb[0, 0] >= 250) and np.all(jpeg[0, 0] >= 245)

        # The default (deflate_rgb) returns (H, W, 3) on white, pixel-exact
        # against an explicit deflate_rgb capture.
        default = client.get_render(height=h, width=w, timeout=30)
        assert default.shape == (h, w, 3) and default.dtype == np.uint8
        assert np.all(default[0, 0] >= 250)
        assert np.allclose(default[mask].mean(axis=0), rgb[mask].mean(axis=0), atol=2.0)

        # Back-to-back solo captures (no interleaved scene updates) take the
        # same-frame capture path; they must stay correct and identical-ish.
        again = client.get_render(
            height=h, width=w, transport_format="deflate_rgba", timeout=30
        )
        assert np.allclose(_center_mean(again), _center_mean(raw), atol=3.0)
    finally:
        page.close()  # type: ignore[attr-defined]
        context.close()  # type: ignore[attr-defined]
