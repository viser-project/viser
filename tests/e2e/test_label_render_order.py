"""Label draw-order regressions (issue #767).

Labels are drawn as batched SDF text over a white background quad, with
explicit renderOrders: Gaussian splats first, then the background, then the
glyphs, so a whole label composites over a splat cloud. Under a reversed
depth buffer, three r185 reversed its sorted render lists, which inverted
every renderOrder in the viewer: the background quad painted over the
glyphs, washing labels out to a uniform ~217 gray (issue #767), and splat
clouds painted over label text. three r186 fixed the sort; these tests pin
the visible contract so a future three bump (or a change to the label
renderOrders) that reorders the draws fails loudly instead of shipping
washed-out labels again.

Each test asserts on both render surfaces, because they can regress
independently: the r185 bug inverted the live viewport but left get_render()
captures correct, since a capture renders through a fresh camera that r185's
list flip did not yet apply to.
"""

from __future__ import annotations

import io
import time
from typing import Callable

import numpy as np
from PIL import Image
from playwright.sync_api import Browser, FloatRect, Page

import viser

from .utils import connect_client

# Every scene below puts the label at the origin with the camera looking
# straight at it, so the label projects to the center of the viewport. Both
# surfaces are measured in regions centered there and sized from the page's
# own viewport (connect_client opens its context at Playwright's default size,
# not conftest's viser_page size), and captures are requested at that same
# size: screen-space label sizing is computed per frame from the live viewport
# height, so a capture at a different size renders the glyphs and quad
# proportionally off.


def _viewport(page: Page) -> tuple[int, int]:
    """(width, height) of the page's viewport, which the canvas fills."""
    size = page.viewport_size
    assert size is not None
    return size["width"], size["height"]


def _centered_clip(page: Page, width: int, height: int) -> FloatRect:
    """A screenshot clip of the given size, centered on the label."""
    vw, vh = _viewport(page)
    return {
        "x": (vw - width) // 2,
        "y": (vh - height) // 2,
        "width": width,
        "height": height,
    }


def _slice(clip: FloatRect) -> tuple[slice, slice]:
    """The numpy (rows, cols) slice covering `clip` in a viewport-sized frame."""
    x, y = int(clip["x"]), int(clip["y"])
    return (
        slice(y, y + int(clip["height"])),
        slice(x, x + int(clip["width"])),
    )


# Region around the label, sized to exclude the control panel (top right) and
# the software-WebGL toast (top left), both of which contain dark UI text of
# their own.
_LABEL_REGION = (440, 220)

# A tight region around the label, sized to stay inside the dense core of the
# splat cloud in the background test, so page white never counts as "quad".
_CORE_REGION = (200, 100)


def _dark_pixels(rgb: np.ndarray) -> int:
    """Count near-black pixels in an RGB array.

    Label glyphs render at full opacity in near-black, though antialiasing
    leaves many of their pixels mid-gray. The threshold only has to separate
    real glyphs from the failure modes, and both failure modes have hard
    floors well above it: glyphs behind the 85%-white background quad can get
    no darker than ~217 gray (summed RGB 651), and glyphs behind the test's
    0.9-opacity white splats no darker than ~230 (sum 688).
    """
    return int((rgb[..., :3].sum(axis=2, dtype=np.int32) < 550).sum())


def _quad_pixels_over_cloud(rgb: np.ndarray) -> int:
    """Count label-background pixels showing over a black splat cloud.

    The label background is white at 85% alpha, so over a black splat cloud it
    lands near 217 gray; the dense cloud core behind it is under ~40. Glyph
    pixels are dark on both surfaces, so a bright count isolates the quad.

    Until the cloud has streamed in, the region is page white and every pixel
    is bright, which must not count as the quad being drawn above the cloud:
    the count is zero unless most of the region is covered by dark splats.
    """
    channels = rgb[..., :3]
    cloud_present = (channels.max(axis=2) < 60).mean() > 0.5
    return int((channels.min(axis=2) > 170).sum()) if cloud_present else 0


def _live_rgb(page: Page, region: tuple[int, int]) -> np.ndarray:
    """RGB pixels of a label-centered region of the live canvas."""
    shot = page.screenshot(clip=_centered_clip(page, *region))
    return np.asarray(Image.open(io.BytesIO(shot)).convert("RGB"))


def _capture_rgb(
    client: viser.ClientHandle, page: Page, region: tuple[int, int] | None = None
) -> np.ndarray:
    """RGB pixels of a viewport-sized get_render() capture composited over
    white, optionally cropped to a label-centered region.

    Crops before compositing, so a small region does not pay for a full-frame
    float conversion on every poll.
    """
    vw, vh = _viewport(page)
    img = client.get_render(height=vh, width=vw, transport_format="png", timeout=30.0)
    if region is not None:
        img = img[_slice(_centered_clip(page, *region))]
    rgb = img[..., :3].astype(np.float64)
    alpha = img[..., 3:4].astype(np.float64) / 255.0
    return (rgb * alpha + 255.0 * (1.0 - alpha)).astype(np.uint8)


def _assert_on_both_surfaces(
    client: viser.ClientHandle,
    page: Page,
    *,
    live: Callable[[Page], int],
    capture: Callable[[viser.ClientHandle], int],
    threshold: int,
    pixels: str,
    symptom: str,
    deadline_s: float = 20.0,
) -> None:
    """Assert a pixel count exceeds `threshold` on the live canvas AND in a
    capture.

    Label glyphs stream in over frames (LabelRenderer rasterizes them under a
    per-frame budget), so early frames can legitimately predate the glyphs;
    polling until the deadline separates "not rendered yet" from "rendered in
    the wrong order", which never clears the threshold no matter how long we
    wait. Each surface is measured only until it passes: a capture is a full
    server round trip and an off-screen render, so re-measuring a surface that
    already passed while the other catches up is pure cost.
    """
    live_count, captured_count = 0, 0
    deadline = time.monotonic() + deadline_s
    while True:
        if live_count <= threshold:
            live_count = live(page)
        if captured_count <= threshold:
            captured_count = capture(client)
        if live_count > threshold and captured_count > threshold:
            return
        if time.monotonic() >= deadline:
            break
        time.sleep(0.25)
    assert live_count > threshold, (
        f"only {live_count} {pixels} on the live canvas -- {symptom} in the viewport"
    )
    assert captured_count > threshold, (
        f"only {captured_count} {pixels} in a get_render() capture -- "
        f"{symptom} in captures"
    )


def _live_dark_pixels(page: Page) -> int:
    """Near-black pixel count in the live canvas around the label."""
    return _dark_pixels(_live_rgb(page, _LABEL_REGION))


def _capture_dark_pixels(client: viser.ClientHandle, page: Page) -> int:
    """Near-black pixel count in a whole get_render() capture, over white."""
    return _dark_pixels(_capture_rgb(client, page))


def _assert_glyphs_dark_on_both_surfaces(
    client: viser.ClientHandle, page: Page, context_msg: str
) -> None:
    """Assert dark glyph pixels on the live canvas AND in a capture.

    The two surfaces can regress independently: the live canvas inverts when
    the render-list sort mishandles renderOrder for the long-lived viewport
    camera (issue #767), while get_render() captures render through a fresh
    camera per request and can disagree with the viewport.
    """
    _assert_on_both_surfaces(
        client,
        page,
        live=_live_dark_pixels,
        capture=lambda client: _capture_dark_pixels(client, page),
        threshold=20,
        pixels=f"near-black pixels {context_msg}",
        symptom="label glyphs are washed out (issue #767)",
    )


def _add_splat_cloud_and_label(
    server: viser.ViserServer,
    client: viser.ClientHandle,
    *,
    n: int,
    sigma: float,
    variance: float,
    rgb: int,
) -> None:
    """A splat cloud centered on a label at the origin, viewed head-on."""
    rng = np.random.default_rng(0)
    server.scene.add_gaussian_splats(
        "/splats",
        centers=rng.normal(0.0, sigma, (n, 3)).astype(np.float32),
        covariances=np.tile(np.eye(3, dtype=np.float32) * variance, (n, 1, 1)),
        rgbs=np.full((n, 3), rgb, dtype=np.uint8),
        opacities=np.full((n, 1), 0.9, dtype=np.float32),
    )
    server.scene.add_label(
        "/label", "Label", position=(0.0, 0.0, 0.0), font_screen_scale=2.0
    )
    client.camera.position = (0.0, -4.0, 0.0)
    client.camera.look_at = (0.0, 0.0, 0.0)


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
    order is pinned by renderOrder (splats first, label layers above). If that
    ordering regresses -- an inverted sort, or a renderOrder collision decided
    by the projected-z tie again -- the cloud paints over the glyphs and the
    dark-pixel count collapses."""
    client, page, context = connect_client(viser_server, browser)
    try:
        # A dense white splat blob centered on the label's position, so glyphs
        # keep their contrast against it if (and only if) they draw on top.
        _add_splat_cloud_and_label(
            viser_server, client, n=2000, sigma=0.4, variance=0.01, rgb=255
        )
        _assert_glyphs_dark_on_both_surfaces(
            client, page, "with a splat cloud at the label's position"
        )
    finally:
        page.close()  # type: ignore[attr-defined]
        context.close()  # type: ignore[attr-defined]


def test_label_background_renders_above_splats(
    viser_server: viser.ViserServer, browser: Browser
) -> None:
    """The label background quad must composite over a co-located splat cloud.

    Both label layers draw above splats (see renderOrders.ts on the client),
    so a label stays legible inside a cloud instead of the cloud punching
    through its background. A dense black cloud makes the quad the only
    bright thing near the label: if the background sinks back below the
    splats, the bright count in the core region collapses to zero."""
    client, page, context = connect_client(viser_server, browser)
    try:
        _add_splat_cloud_and_label(
            viser_server, client, n=3000, sigma=0.8, variance=0.03, rgb=0
        )
        # The quad is ~100x30 px at font_screen_scale=2, so it covers ~15% of
        # the core region once the cloud is in; the regression leaves ~0%.
        _assert_on_both_surfaces(
            client,
            page,
            live=lambda page: _quad_pixels_over_cloud(_live_rgb(page, _CORE_REGION)),
            capture=lambda client: _quad_pixels_over_cloud(
                _capture_rgb(client, page, _CORE_REGION)
            ),
            threshold=(_CORE_REGION[0] * _CORE_REGION[1]) // 50,
            pixels="bright pixels around the label",
            symptom="the label background is drawn below the splat cloud",
        )
    finally:
        page.close()  # type: ignore[attr-defined]
        context.close()  # type: ignore[attr-defined]
