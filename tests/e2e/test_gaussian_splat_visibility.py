"""E2E test for Gaussian splat visibility toggling.

Verifies that hiding a Gaussian splat node via `.visible = False` correctly
hides the splats (pixels change), and re-showing them works.
"""

from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image
from playwright.sync_api import Page

import viser

from .utils import (
    wait_for_scene_node,
    wait_for_scene_node_hidden,
    wait_for_scene_node_visible,
)


def _count_colored_pixels(page: Page, min_r: int = 200, max_gb: int = 100) -> int:
    """Count red pixels on the canvas (not the full page, to exclude UI chrome)."""
    canvas = page.locator("canvas").first
    screenshot = canvas.screenshot()
    img = np.array(Image.open(BytesIO(screenshot)).convert("RGB"))
    red_mask = (
        (img[:, :, 0] > min_r) & (img[:, :, 1] < max_gb) & (img[:, :, 2] < max_gb)
    )
    return int(red_mask.sum())


def test_gaussian_splat_visibility_pixel_check(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Test that toggling splat visibility actually changes rendered pixels."""
    # Create bright red splats at the origin.
    num_gaussians = 100
    gs_handle = viser_server.scene.add_gaussian_splats(
        "/test_splat",
        centers=np.zeros((num_gaussians, 3), dtype=np.float32),
        rgbs=np.tile(np.array([[1.0, 0.0, 0.0]], dtype=np.float32), (num_gaussians, 1)),
        opacities=np.ones((num_gaussians, 1), dtype=np.float32),
        covariances=np.tile(np.eye(3, dtype=np.float32) * 1.0, (num_gaussians, 1, 1)),
    )

    # Wait for node and give time for WASM init + sort + rendering.
    wait_for_scene_node(viser_page, "/test_splat")
    viser_page.wait_for_timeout(3000)

    # Splats should be rendering -- canvas should have red pixels.
    pixels_visible = _count_colored_pixels(viser_page)
    assert pixels_visible > 1000, (
        f"Expected red splat pixels but only found {pixels_visible}"
    )

    # Hide the splats.
    gs_handle.visible = False
    wait_for_scene_node_hidden(viser_page, "/test_splat")
    # Wait for the splat renderer's useFrame to detect the visibility change.
    viser_page.wait_for_timeout(1000)

    # Canvas should have no red pixels now.
    pixels_hidden = _count_colored_pixels(viser_page)
    assert pixels_hidden < 100, (
        f"Expected no red pixels after hiding splats but found {pixels_hidden}"
    )

    # Re-show.
    gs_handle.visible = True
    wait_for_scene_node_visible(viser_page, "/test_splat")
    viser_page.wait_for_timeout(1000)

    # Should have red pixels again.
    pixels_reshown = _count_colored_pixels(viser_page)
    assert pixels_reshown > 1000, (
        f"Expected red pixels after re-showing splats but only found {pixels_reshown}"
    )
