"""get_render() capture correctness, across transport formats.

The client-side capture path is latency-optimized: a request that arrives
alone captures in the same frame it is processed (after the SceneTree pose
appliers), a request that arrives alongside scene updates waits exactly one
frame for React to commit them, and JPEG/PNG encoding happens off the
message-handling critical path. These tests pin the contract those
optimizations must preserve: a frame returned by get_render() reflects every
scene update made before the call, and both transport formats return sane
pixels.
"""

from __future__ import annotations

import time
from typing import Generator

import numpy as np
import pytest
from playwright.sync_api import Browser

import viser
import viser._client_autobuild

from .utils import (
    center_mean,
    connect_client,
    find_free_port,
    wait_for_server_ready,
)


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


def test_get_render_reflects_prior_scene_updates(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    """A capture requested immediately after a scene mutation must show that
    mutation. This exercises the "commit_wait" path (update + request race
    down two different server buffers and the client needs a React commit
    before capturing) repeatedly, alternating colors so ANY stale frame
    fails the dominant-channel check."""
    client, page, context = connect_client(own_server, browser)
    try:
        # A box that fills the view center from the default camera pose.
        box = own_server.scene.add_box(
            "/box", color=(255, 0, 0), dimensions=(2.0, 2.0, 2.0)
        )
        colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255)] * 2
        for i, color in enumerate(colors):
            box.color = color
            img = client.get_render(
                height=96, width=128, transport_format="png", timeout=30.0
            )
            center = center_mean(img)
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
    client, page, context = connect_client(own_server, browser)
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
                client.get_render(height=h, width=w, transport_format="png", timeout=30)
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
                height=h, width=w, transport_format="png", timeout=30.0
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
    """Both transport formats return correctly-shaped arrays of the same
    scene: JPEG (H, W, 3) on white, PNG (H, W, 4) on transparent -- agreeing
    on the center pixels, with corner pixels showing each format's
    background convention, and repeated solo captures (the same-frame fast
    path) staying stable. The default is JPEG."""
    client, page, context = connect_client(own_server, browser)
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
            cur = center_mean(
                client.get_render(height=h, width=w, transport_format="png", timeout=30)
            )
            if prev is not None and np.allclose(cur, prev, atol=2.0):
                break
            prev = cur
            time.sleep(0.1)
        jpeg = client.get_render(height=h, width=w, transport_format="jpeg", timeout=30)
        png = client.get_render(height=h, width=w, transport_format="png", timeout=30)
        assert jpeg.shape == (h, w, 3) and jpeg.dtype == np.uint8
        assert png.shape == (h, w, 4) and png.dtype == np.uint8
        # The formats agree where the box is fully opaque (background pixels
        # legitimately differ: white for JPEG, transparent for PNG).
        mask = png[:, :, 3] == 255
        assert mask.mean() > 0.02, "no opaque pixels to compare"
        assert np.allclose(
            jpeg[mask].mean(axis=0), png[mask][:, :3].mean(axis=0), atol=12.0
        ), f"jpeg {jpeg[mask].mean(axis=0)} != png {png[mask][:, :3].mean(axis=0)}"
        # Background conventions at an off-scene corner.
        assert int(png[0, 0, 3]) == 0
        assert np.all(jpeg[0, 0] >= 245)

        # The default is JPEG: same shape and white background.
        default = client.get_render(height=h, width=w, timeout=30)
        assert default.shape == (h, w, 3) and default.dtype == np.uint8
        assert np.all(default[0, 0] >= 245)
        assert np.allclose(
            default[mask].mean(axis=0), jpeg[mask].mean(axis=0), atol=12.0
        )

        # Back-to-back solo captures (no interleaved scene updates) take the
        # same-frame capture path; they must stay correct and identical-ish.
        again = client.get_render(height=h, width=w, transport_format="png", timeout=30)
        assert np.allclose(center_mean(again), center_mean(png), atol=3.0)
    finally:
        page.close()  # type: ignore[attr-defined]
        context.close()  # type: ignore[attr-defined]


def test_get_render_does_not_leak_capture_state_into_splat_view(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    """Capturing must not corrupt the INTERACTIVE Gaussian splat view. The
    capture path calls the splat updateCamera with its virtual camera
    (uniforms, group transforms, blocking sort) and only restores the
    sorted-index attribute itself; it relies on running BEFORE the splat
    per-frame hook (priority -100), which re-applies interactive-camera
    state in the same frame. At a later priority, the frame's visible
    render draws the viewport with the capture's splat uniforms -- observed
    here as the capture's viewport size leaking across a frame boundary
    into the splat material (an in-page rAF probe can only ever see it if
    the same-frame repair did not happen)."""
    client, page, context = connect_client(own_server, browser)
    try:
        rng = np.random.default_rng(0)
        n = 2000
        own_server.scene.add_gaussian_splats(
            "/splats",
            centers=rng.normal(size=(n, 3)).astype(np.float32),
            covariances=np.tile(np.eye(3, dtype=np.float32) * 0.005, (n, 1, 1)),
            rgbs=rng.integers(0, 255, (n, 3), dtype=np.uint8),
            opacities=rng.uniform(0.5, 1.0, (n, 1)).astype(np.float32),
        )
        time.sleep(4.0)  # Splat sorter + WASM warmup.
        page.evaluate(  # type: ignore[attr-defined]
            """
            () => {
              window.__viewportSamples = new Set();
              const sample = () => {
                const scene = window.__viserMutable && window.__viserMutable.scene;
                if (scene) {
                  scene.traverse((obj) => {
                    const u = obj.material && obj.material.uniforms;
                    if (u && u.viewport && Array.isArray(u.viewport.value)) {
                      window.__viewportSamples.add(u.viewport.value.join('x'));
                    }
                  });
                }
                requestAnimationFrame(sample);
              };
              requestAnimationFrame(sample);
            }
            """
        )
        for _ in range(10):
            img = client.get_render(
                height=96, width=128, transport_format="jpeg", timeout=60.0
            )
            assert img.shape == (96, 128, 3)
        time.sleep(0.5)
        samples = page.evaluate(  # type: ignore[attr-defined]
            "() => Array.from(window.__viewportSamples)"
        )
        assert "128x96" not in samples, (
            f"capture-sized splat viewport leaked into the interactive view "
            f"(observed uniform values: {sorted(samples)})"
        )
        # Sanity: the probe did observe the interactive viewport (i.e., it
        # actually sampled splat material state).
        assert len(samples) > 0
    finally:
        page.close()  # type: ignore[attr-defined]
        context.close()  # type: ignore[attr-defined]


def test_get_render_survives_hidden_unmounted_node_pose_update(
    own_server: viser.ViserServer, browser: Browser
) -> None:
    """A pose update to a HIDDEN unmountWhenInvisible node (transform
    controls, 3D GUI, ...) must not break capture. When such a node is
    hidden, React unmounts it and its ref callback writes null into
    nodeRefFromName (whose type only admits undefined); a later pose update
    marks the pose "needsUpdate", which SceneTree's own applier skips while
    the ref is null. The capture hook's defensive pose sweep must skip it
    too -- an undefined-only guard let the null through to a TypeError,
    failing the whole capture with a spurious "could not capture a frame"
    RuntimeError on a healthy client."""
    client, page, context = connect_client(own_server, browser)
    try:
        tc = own_server.scene.add_transform_controls("/gizmo")
        time.sleep(1.0)  # Mount.
        tc.visible = False
        time.sleep(0.8)  # Unmount; ref callback nulls the map entry.
        tc.position = (1.0, 0.0, 0.0)  # Pose pending while the ref is null.
        time.sleep(0.3)
        img = client.get_render(height=64, width=64, timeout=30.0)
        assert img.shape == (64, 64, 3)
    finally:
        page.close()  # type: ignore[attr-defined]
        context.close()  # type: ignore[attr-defined]
