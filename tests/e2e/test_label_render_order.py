"""Label draw-order regressions (issue #767).

Labels are drawn as batched SDF text over a white background quad, with
explicit renderOrders: background below Gaussian splats, glyphs above both.
Under a reversed depth buffer, three r185 reverses its sorted render lists,
which inverted every renderOrder in the viewer: the background quad painted
over the glyphs, washing labels out to a uniform ~217 gray (issue #767), and
splat clouds painted over label text. The client compensates in
ReversedDepthSort.ts; these tests pin the visible contract so a future three
bump (or a change to the label renderOrders) that reorders the draws fails
loudly instead of shipping washed-out labels again.

Each test asserts on both render surfaces, because they regress
independently: stock three r185 inverts the live viewport (get_render()'s
fresh camera skips the flip and stays correct), while the compensating sort
without camera priming does the reverse -- live correct, captures inverted.
"""

from __future__ import annotations

import numpy as np
from playwright.sync_api import Browser

import viser

from .utils import connect_client


def _dark_pixels(rgb: np.ndarray) -> int:
    """Count near-black pixels in an RGB array.

    Label glyphs render at full opacity in near-black, though antialiasing
    leaves many of their pixels mid-gray. The threshold only has to separate
    real glyphs from the failure modes, and both failure modes have hard
    floors well above it: glyphs behind the 85%-white background quad can get
    no darker than ~217 gray (summed RGB 651), and glyphs behind the test's
    0.9-opacity white splats no darker than ~230 (sum 688).
    """
    return int((rgb[..., :3].astype(np.float64).sum(axis=2) < 550.0).sum())


# Region of the live viewport where the scene-center label renders, chosen to
# exclude the control panel (top right) and the software-WebGL toast (top
# left), both of which contain dark UI text of their own.
_LIVE_CLIP = {"x": 260, "y": 200, "width": 440, "height": 220}


def _live_dark_pixels(page) -> int:  # type: ignore[no-untyped-def]
    """Near-black pixel count in the live canvas around the scene center."""
    import io

    from PIL import Image

    shot = page.screenshot(clip=_LIVE_CLIP)
    rgb = np.asarray(Image.open(io.BytesIO(shot)).convert("RGB"))
    return _dark_pixels(rgb)


def _capture_dark_pixels(client: viser.ClientHandle) -> int:
    """Near-black pixel count in a get_render() capture, over white."""
    # Capture at the e2e viewport size: screen-space label sizing is computed
    # per-frame from the live viewport height, so a capture at a much smaller
    # size renders the glyphs proportionally undersized.
    img = client.get_render(height=600, width=960, transport_format="png", timeout=30.0)
    rgb = img[..., :3].astype(np.float64)
    alpha = img[..., 3:4].astype(np.float64) / 255.0
    return _dark_pixels((rgb * alpha + 255.0 * (1.0 - alpha)).astype(np.uint8))


def _assert_glyphs_dark_on_both_surfaces(
    client: viser.ClientHandle,
    page,  # type: ignore[no-untyped-def]
    context_msg: str,
    deadline_s: float = 20.0,
) -> None:
    """Assert dark glyph pixels on the live canvas AND in a capture.

    The two surfaces regress independently: the live canvas inverts when the
    render-list sort mishandles renderOrder for the long-lived viewport camera
    (issue #767), while get_render() captures invert when the compensating
    sort is applied to a fresh camera whose reversedDepth flag is not yet set.

    Label glyphs stream in over frames (LabelRenderer rasterizes them under
    a per-frame budget), so early frames can legitimately predate the glyphs;
    polling until the deadline separates "not rendered yet" from "rendered in
    the wrong order", which never darkens no matter how long we wait.
    """
    import time

    live, captured = 0, 0
    deadline = time.monotonic() + deadline_s
    while time.monotonic() < deadline:
        live = _live_dark_pixels(page)
        captured = _capture_dark_pixels(client)
        if live > 20 and captured > 20:
            return
        time.sleep(0.25)
    assert live > 20, (
        f"only {live} near-black pixels on the live canvas {context_msg} -- "
        "label glyphs are washed out in the viewport (issue #767)"
    )
    assert captured > 20, (
        f"only {captured} near-black pixels in a get_render() capture "
        f"{context_msg} -- label glyphs are washed out in captures"
    )


def test_label_glyphs_render_dark(
    viser_server: viser.ViserServer, browser: Browser
) -> None:
    """A captured label must contain near-black glyph pixels.

    This is issue #767's symptom distilled: with the draw order inverted, the
    white background quad paints over the glyphs and no pixel in the frame
    is darker than ~217 gray, so the count below drops to zero."""
    client, page, context = connect_client(viser_server, browser)
    try:
        viser_server.scene.add_label(
            "/label", "Label", position=(0.0, 0.0, 0.0), font_screen_scale=2.0
        )
        client.camera.position = (0.0, -4.0, 0.0)
        client.camera.look_at = (0.0, 0.0, 0.0)
        _assert_glyphs_dark_on_both_surfaces(
            client, page, "in a frame containing a label"
        )
    finally:
        page.close()  # type: ignore[attr-defined]
        context.close()  # type: ignore[attr-defined]


def test_label_glyphs_render_above_splats(
    viser_server: viser.ViserServer, browser: Browser
) -> None:
    """Label text must composite over a co-located Gaussian splat cloud.

    Splats and label glyphs are both late-drawn transparents; their relative
    order is pinned by renderOrder (splats 10000, label text above). If that
    ordering regresses -- an inverted sort, or a renderOrder collision decided
    by the projected-z tie again -- the cloud paints over the glyphs and the
    dark-pixel count collapses."""
    client, page, context = connect_client(viser_server, browser)
    try:
        # A dense white splat blob centered on the label's position, so glyphs
        # keep their contrast against it if (and only if) they draw on top.
        rng = np.random.default_rng(0)
        n = 2000
        centers = rng.normal(0.0, 0.4, (n, 3)).astype(np.float32)
        covariances = np.tile(np.eye(3, dtype=np.float32) * 0.01, (n, 1, 1))
        viser_server.scene.add_gaussian_splats(
            "/splats",
            centers=centers,
            covariances=covariances,
            rgbs=np.full((n, 3), 255, dtype=np.uint8),
            opacities=np.full((n, 1), 0.9, dtype=np.float32),
        )
        viser_server.scene.add_label(
            "/label", "Label", position=(0.0, 0.0, 0.0), font_screen_scale=2.0
        )
        client.camera.position = (0.0, -4.0, 0.0)
        client.camera.look_at = (0.0, 0.0, 0.0)
        _assert_glyphs_dark_on_both_surfaces(
            client, page, "with a splat cloud at the label's position"
        )
    finally:
        page.close()  # type: ignore[attr-defined]
        context.close()  # type: ignore[attr-defined]
