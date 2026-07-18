"""E2E tests for Gaussian splat spherical harmonics rendering.

Verifies that splats with spherical harmonics coefficients are view-dependent:
a degree-1 coefficient along +X makes the splats red-dominant when viewed from
+X and red-suppressed when viewed from -X. Also verifies that plain RGB splats
keep their color when composited with a spherical harmonics group (the
renderer promotes them to DC-only harmonics internally).
"""

from __future__ import annotations

from io import BytesIO

import numpy as np
import pytest
from PIL import Image
from playwright.sync_api import Page

import viser

from .utils import wait_for_scene_node

SH_C0 = 0.28209479177387814
SH_C1 = 0.4886025119029199


def _canvas_mean_color(page: Page) -> np.ndarray:
    """Mean RGB of non-background canvas pixels (background is near-white)."""
    canvas = page.locator("canvas").first
    screenshot = canvas.screenshot()
    img = np.array(Image.open(BytesIO(screenshot)).convert("RGB")).astype(np.float64)
    non_background = img.min(axis=2) < 220
    assert non_background.sum() > 500, "Expected the splats to cover some pixels"
    return img[non_background].mean(axis=0)


def _look_from(client: viser.ClientHandle, position: tuple) -> None:
    client.camera.position = position
    client.camera.look_at = (0.0, 0.0, 0.0)


@pytest.mark.parametrize("sh_degree", [1, 3])
def test_gaussian_splat_sh_view_dependent_color(
    viser_server: viser.ViserServer,
    viser_page: Page,
    sh_degree: int,
) -> None:
    """Colors computed from spherical harmonics must change with view direction."""
    num_gaussians = 100

    # Gray DC term, and a red coefficient on a basis function that is odd in
    # x, so the red channel flips as the camera moves from +X to -X while
    # green/blue stay at 0.5.
    #
    # Degree 1 uses coefficient 3, whose basis is `-SH_C1 * x`. Degree 3 uses
    # coefficient 15 (the last one, exercising the texture fetch of all six
    # RGBA32UI texels), whose basis is `-0.59 * x * (x^2 - 3 y^2)`; along the
    # X axis both evaluate to -/+ their constant for view direction +/-X.
    num_coeffs = (sh_degree + 1) ** 2
    sh_coeffs = np.zeros((num_gaussians, num_coeffs, 3), dtype=np.float32)
    if sh_degree == 1:
        sh_coeffs[:, 3, 0] = 0.5 / SH_C1
    else:
        sh_coeffs[:, 15, 0] = 0.5 / 0.5900435899266435

    viser_server.scene.add_gaussian_splats(
        "/sh_splat",
        centers=np.zeros((num_gaussians, 3), dtype=np.float32),
        rgbs=np.full((num_gaussians, 3), 0.5, dtype=np.float32),
        opacities=np.ones((num_gaussians, 1), dtype=np.float32),
        covariances=np.tile(np.eye(3, dtype=np.float32), (num_gaussians, 1, 1)),
        sh_coeffs=sh_coeffs,
    )

    wait_for_scene_node(viser_page, "/sh_splat")
    # Give time for WASM init + sort + rendering.
    viser_page.wait_for_timeout(3000)

    clients = viser_server.get_clients()
    assert len(clients) == 1
    client = next(iter(clients.values()))

    _look_from(client, (8.0, 0.0, 0.0))
    viser_page.wait_for_timeout(1500)
    color_from_pos_x = _canvas_mean_color(viser_page)

    _look_from(client, (-8.0, 0.0, 0.0))
    viser_page.wait_for_timeout(1500)
    color_from_neg_x = _canvas_mean_color(viser_page)

    # Red must dominate from +X and vanish from -X; green/blue barely move.
    assert color_from_pos_x[0] - color_from_neg_x[0] > 100, (
        f"Expected strong view-dependent red channel, got "
        f"{color_from_pos_x=} vs {color_from_neg_x=}"
    )
    for channel in (1, 2):
        assert abs(color_from_pos_x[channel] - color_from_neg_x[channel]) < 40, (
            f"Channel {channel} should be view-independent, got "
            f"{color_from_pos_x=} vs {color_from_neg_x=}"
        )


def test_gaussian_splat_sh_mixed_with_rgb_group(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Plain RGB splats keep their color when a SH group is also present."""
    num_gaussians = 100

    # Green splats without spherical harmonics...
    viser_server.scene.add_gaussian_splats(
        "/rgb_splat",
        centers=np.zeros((num_gaussians, 3), dtype=np.float32),
        rgbs=np.tile(np.array([[0.0, 1.0, 0.0]], dtype=np.float32), (num_gaussians, 1)),
        opacities=np.ones((num_gaussians, 1), dtype=np.float32),
        covariances=np.tile(np.eye(3, dtype=np.float32), (num_gaussians, 1, 1)),
    )
    # ...composited with a degree-1 SH group far off to the side, which forces
    # the whole scene through the spherical harmonics shader path.
    sh_coeffs = np.zeros((num_gaussians, 4, 3), dtype=np.float32)
    sh_coeffs[:, 0, :] = 0.5 / SH_C0  # White DC term.
    viser_server.scene.add_gaussian_splats(
        "/sh_splat",
        centers=np.full((num_gaussians, 3), 50.0, dtype=np.float32),
        rgbs=np.full((num_gaussians, 3), 0.5, dtype=np.float32),
        opacities=np.ones((num_gaussians, 1), dtype=np.float32),
        covariances=np.tile(np.eye(3, dtype=np.float32), (num_gaussians, 1, 1)),
        sh_coeffs=sh_coeffs,
    )

    wait_for_scene_node(viser_page, "/rgb_splat")
    wait_for_scene_node(viser_page, "/sh_splat")
    viser_page.wait_for_timeout(3000)

    canvas = viser_page.locator("canvas").first
    img = np.array(
        Image.open(BytesIO(canvas.screenshot())).convert("RGB")
    ).astype(np.float64)
    green_mask = (
        (img[:, :, 1] > 150) & (img[:, :, 0] < 100) & (img[:, :, 2] < 100)
    )
    assert green_mask.sum() > 1000, (
        f"RGB-only splats should still render green when mixed with a "
        f"spherical harmonics group; found {green_mask.sum()} green pixels"
    )
