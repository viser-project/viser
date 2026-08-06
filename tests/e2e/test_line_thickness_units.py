"""World- vs screen-space line widths (``thickness_units``).

With ``thickness_units="world"`` (the default), a line's width is a fixed
size in scene units, so its on-screen width scales inversely with camera
distance. With ``"screen"``, the width is a fixed pixel count regardless of
distance (the pre-``thickness_units`` behavior).

Both tests render two vertical segments at camera distances 2 and 4 and
measure their projected pixel widths: world units must give a ~2x width
ratio, screen units a ~1x ratio.
"""

from __future__ import annotations

import math
from io import BytesIO
from typing import Literal

import numpy as np
from PIL import Image
from playwright.sync_api import Page

import viser

from .utils import wait_for_scene_node

# Vertical segments (world +z is the camera's up direction here), one at
# distance 2 and one at distance 4, offset sideways so they don't overlap
# on screen. With the camera at the origin looking down +x, each projects
# to an exactly vertical pixel column.
_NEAR = np.array([[[2.0, 0.8, -1.0], [2.0, 0.8, 1.0]]])
_FAR = np.array([[[4.0, -1.6, -1.0], [4.0, -1.6, 1.0]]])


def _measure_widths(
    viser_server: viser.ViserServer,
    viser_page: Page,
    thickness: float,
    thickness_units: Literal["screen", "world"],
) -> tuple[float, float]:
    """Render the two-segment scene; return (near, far) pixel widths."""
    viser_server.scene.add_line_segments(
        "/near",
        points=_NEAR,
        colors=(0, 255, 0),
        thickness=thickness,
        thickness_units=thickness_units,
    )
    viser_server.scene.add_line_segments(
        "/far",
        points=_FAR,
        colors=(0, 0, 255),
        thickness=thickness,
        thickness_units=thickness_units,
    )
    viser_server.scene.world_axes.visible = False
    wait_for_scene_node(viser_page, "/near")
    wait_for_scene_node(viser_page, "/far")
    viser_page.wait_for_timeout(300)

    client = list(viser_server.get_clients().values())[0]
    client.camera.position = (0.0, 0.0, 0.0)
    client.camera.look_at = (1.0, 0.0, 0.0)
    client.camera.fov = math.radians(75.0)
    viser_page.wait_for_timeout(400)

    canvas = viser_page.locator("canvas").first
    img = np.array(Image.open(BytesIO(canvas.screenshot())).convert("RGB")).astype(int)
    green = (
        (img[:, :, 1] > 150)
        & (img[:, :, 1] > img[:, :, 0] + 60)
        & (img[:, :, 1] > img[:, :, 2] + 60)
    )
    blue = (
        (img[:, :, 2] > 150)
        & (img[:, :, 2] > img[:, :, 0] + 60)
        & (img[:, :, 2] > img[:, :, 1] + 60)
    )
    # Both segments are vertical pixel columns spanning the mid-height rows;
    # the per-row pixel count is the projected line width. Median over rows
    # for robustness to antialiased ends.
    rows = slice(250, 350)
    near_width = float(np.median(green[rows].sum(axis=1)))
    far_width = float(np.median(blue[rows].sum(axis=1)))
    return near_width, far_width


def test_world_units_width_scales_with_distance(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """World-space width: on-screen width halves when distance doubles."""
    near, far = _measure_widths(
        viser_server, viser_page, thickness=0.2, thickness_units="world"
    )
    # Expected: 0.2 world units at distance 2 with fov 75deg on a 600px-tall
    # canvas is ~39px; ~20px at distance 4.
    assert far > 8, f"far line missing or too thin: {far=}"
    assert 1.6 < near / far < 2.5, f"expected ~2x width ratio: {near=}, {far=}"


def test_screen_units_width_constant_with_distance(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Screen-space width: on-screen width is distance-independent."""
    near, far = _measure_widths(
        viser_server, viser_page, thickness=10.0, thickness_units="screen"
    )
    assert 6 <= near <= 15, f"near line width off: {near=}"
    assert 6 <= far <= 15, f"far line width off: {far=}"
    assert 0.7 < near / far < 1.4, f"expected ~1x width ratio: {near=}, {far=}"
