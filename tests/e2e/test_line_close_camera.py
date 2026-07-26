"""Regression test for fat-line rendering when the camera is very close.

Under the reversed depth buffer (App.tsx), three-stdlib LineMaterial's
``trimSegment`` near-plane estimate evaluates to -far/2 instead of -near, so
any line segment crossing the camera plane gets extrapolated hundreds of
units away from the camera: the part of the line sweeping past the camera
vanishes. viser's own <Line> carried a local patch (#720), but drei's <Line>
-- used for camera frustums, splines, and internally by PivotControls --
constructs its own LineMaterial and was still broken. The patch now applies
to every LineMaterial via patchLineMaterialReversedDepth.ts; this test
exercises the drei code path through the built client.
"""

from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image
from playwright.sync_api import Page

import viser

from .utils import wait_for_scene_node


def test_spline_passing_camera_renders(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A straight spline passing just beside the camera must sweep across the
    screen toward the viewport edge, not vanish near the camera."""
    # drei's CatmullRomLine (unlike add_line_segments) renders through drei's
    # <Line>, whose LineMaterial viser code never touches directly.
    viser_server.scene.add_spline_catmull_rom(
        "/spline",
        points=np.array(
            [[-5.0, 0.0, 0.0], [-2.0, 0.0, 0.0], [2.0, 0.0, 0.0], [5.0, 0.0, 0.0]]
        ),
        color=(255, 0, 0),
        line_width=6.0,
    )
    viser_server.scene.world_axes.visible = False
    wait_for_scene_node(viser_page, "/spline")
    viser_page.wait_for_timeout(300)

    client = list(viser_server.get_clients().values())[0]
    # Camera right next to the line (~0.02 to the side), looking along it, and
    # offset along x so the curve chunk crossing the camera plane has its
    # forward endpoint well in front of the camera (a chunk boundary exactly
    # at the camera plane would mask the trimSegment bug).
    client.camera.position = (0.25, -0.02, 0.007)
    client.camera.look_at = (3.25, 0.0, 0.0)
    viser_page.wait_for_timeout(400)

    canvas = viser_page.locator("canvas").first
    img = np.array(Image.open(BytesIO(canvas.screenshot())).convert("RGB")).astype(int)
    red = (
        (img[:, :, 0] > 150)
        & (img[:, :, 0] > img[:, :, 1] + 60)
        & (img[:, :, 0] > img[:, :, 2] + 60)
    )
    # The section of line sweeping past the camera projects into the
    # mid-height left third of the canvas (a region free of the control
    # panel, the software-WebGL notification, and the viser logo). With the
    # trimSegment bug this region is empty (measured 0 vs ~2000 pixels).
    left_mid = int(red[200:500, 0:300].sum())
    assert left_mid > 500, f"line sweep toward viewport edge missing: {left_mid=}"
