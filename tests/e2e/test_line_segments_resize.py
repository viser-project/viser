"""Regression test for resizing add_line_segments truncating the draw.

See https://github.com/nerfstudio-project/viser/issues/719.
"""

from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image
from playwright.sync_api import Page

import viser

from .utils import wait_for_scene_node


def _count_red_pixels(page: Page) -> int:
    canvas = page.locator("canvas").first
    img = np.array(Image.open(BytesIO(canvas.screenshot())).convert("RGB"))
    return int(
        ((img[:, :, 0] > 200) & (img[:, :, 1] < 80) & (img[:, :, 2] < 80)).sum()
    )


def _segments_along_x(half_extent: float, num_points: int) -> np.ndarray:
    pts = np.linspace(
        [-half_extent, 0.0, 0.0], [half_extent, 0.0, 0.0], num=num_points
    )
    return np.stack([pts[:-1], pts[1:]], axis=1)


def test_line_segments_resize_rerender(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    viser_server.initial_camera.position = (0.0, -6.0, 0.0)
    viser_server.initial_camera.look_at = (0.0, 0.0, 0.0)

    short_half_extent = 0.4
    long_half_extent = 2.5
    short_num_pts = 3
    long_num_pts = 60

    def push(half_extent: float, num_pts: int) -> None:
        viser_server.scene.add_line_segments(
            "/regression_line",
            points=_segments_along_x(half_extent, num_pts),
            colors=(255, 0, 0),
            line_width=8.0,
        )

    push(short_half_extent, short_num_pts)
    wait_for_scene_node(viser_page, "/regression_line")
    viser_page.wait_for_timeout(200)
    short_baseline = _count_red_pixels(viser_page)

    push(long_half_extent, long_num_pts)
    viser_page.wait_for_timeout(100)
    long_baseline = _count_red_pixels(viser_page)
    assert long_baseline > short_baseline * 3, (
        f"short={short_baseline}, long={long_baseline}"
    )

    # Bounce back to short, then long again with a different buffer size.
    # Pre-fix this short->long transition under-rendered.
    long_threshold = long_baseline // 2
    for i in range(2):
        push(short_half_extent, short_num_pts + (i % 2))
        viser_page.wait_for_timeout(100)
        push(long_half_extent, long_num_pts + (i + 1) * 4)
        viser_page.wait_for_timeout(100)
        long_count = _count_red_pixels(viser_page)
        assert long_count >= long_threshold, (
            f"iter {i}: red_pixels={long_count}, threshold={long_threshold}, "
            f"long_baseline={long_baseline}, short_baseline={short_baseline}"
        )
