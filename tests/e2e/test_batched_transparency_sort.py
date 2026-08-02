"""Regression test for per-instance depth sorting of transparent batched meshes.

Three.js depth-sorts objects, not instances: every instance of a batched mesh
shares a single draw call, so a transparent batch used to composite in buffer
order. With the default ``depthWrite: true`` that means a nearer instance drawn
first depth-rejects the farther instances behind it, which disappear from the
blend entirely (viser-project/viser#752). ``BatchedMeshBase`` now turns on
InstancedMesh2's per-instance sort for blending materials.
"""

from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image
from playwright.sync_api import Page

import viser

from .utils import wait_for_scene_node

# Unit cube centered on the origin, counter-clockwise winding (outward normals).
_H = 0.5
CUBE_VERTICES = np.array(
    [
        [-_H, -_H, -_H],
        [+_H, -_H, -_H],
        [+_H, +_H, -_H],
        [-_H, +_H, -_H],
        [-_H, -_H, +_H],
        [+_H, -_H, +_H],
        [+_H, +_H, +_H],
        [-_H, +_H, +_H],
    ],
    dtype=np.float32,
)
CUBE_FACES = np.array(
    [
        [0, 2, 1],
        [0, 3, 2],  # -Z.
        [4, 5, 6],
        [4, 6, 7],  # +Z.
        [0, 1, 5],
        [0, 5, 4],  # -Y.
        [3, 7, 6],
        [3, 6, 2],  # +Y.
        [0, 4, 7],
        [0, 7, 3],  # -X.
        [1, 2, 6],
        [1, 6, 5],  # +X.
    ],
    dtype=np.uint32,
)


def test_transparent_batched_instances_are_depth_sorted(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A far blue instance behind a near red one must show through the blend.

    Both instances live in one batch, with the near one first in the buffer --
    the exact order that hides the far instance when instances aren't sorted.
    """
    # Opaque black backdrop, so "did blue get drawn" is a question about the
    # blue channel alone and not about whatever the page background is.
    viser_server.scene.add_box(
        "/backdrop",
        color=(0, 0, 0),
        dimensions=(0.02, 8.0, 8.0),
        position=(-3.0, 0.0, 0.0),
        cast_shadow=False,
        receive_shadow=False,
    )
    viser_server.scene.add_batched_meshes_simple(
        "/cubes",
        vertices=CUBE_VERTICES,
        faces=CUBE_FACES,
        # Instance 0 is nearest the camera: buffer order is front-to-back,
        # which is the order that breaks without sorting.
        batched_positions=np.array([[1.2, 0.0, 0.0], [0.0, 0.0, 0.0]], np.float32),
        batched_wxyzs=np.array([[1.0, 0.0, 0.0, 0.0]] * 2, np.float32),
        batched_colors=np.array([[255, 0, 0], [0, 0, 255]], np.uint8),
        opacity=0.5,
        flat_shading=True,
        side="front",
        cast_shadow=False,
        receive_shadow=False,
        lod="off",
    )
    viser_server.scene.world_axes.visible = False
    wait_for_scene_node(viser_page, "/cubes")

    client = list(viser_server.get_clients().values())[0]
    # Look straight down -x, so the near cube fully covers the far one.
    client.camera.position = (4.0, 0.0, 0.0)
    client.camera.look_at = (0.0, 0.0, 0.0)
    viser_page.wait_for_timeout(600)

    canvas = viser_page.locator("canvas").first
    img = np.array(Image.open(BytesIO(canvas.screenshot())).convert("RGB")).astype(int)
    h, w = img.shape[:2]

    # Locate the near cube by its red silhouette along the middle scanline,
    # rather than hard-coding pixel columns. The GUI panels overlay the canvas
    # in this screenshot, but they're neutral-colored and fail the R-vs-G test.
    row = img[h // 2]
    red = (row[:, 0] > 60) & (row[:, 0] > row[:, 1] + 40)
    columns = np.flatnonzero(red)
    assert columns.size > 40, f"near cube not found on the middle scanline: {red.sum()}"
    left, right = int(columns[0]), int(columns[-1])
    span = right - left + 1

    # The near cube subtends a wider angle than the far one, so its silhouette
    # is a red margin ringing a center where the two overlap. Both bands sample
    # the same red surface at the same opacity: the only difference is whether
    # the far blue instance made it into the blend underneath.
    def band(x0: int, x1: int) -> np.ndarray:
        return img[h // 2 - 10 : h // 2 + 10, x0:x1].reshape(-1, 3)

    overlap = band(left + (span * 35) // 100, left + (span * 65) // 100)
    # Inset a few pixels from each silhouette edge to skip antialiasing.
    margin = np.concatenate(
        [
            band(left + 3, left + max(span // 10, 6)),
            band(right - max(span // 10, 6), right - 3),
        ]
    )

    # Red is the near instance's own contribution: it must match across bands,
    # confirming both sample the same surface under the same lighting.
    assert abs(overlap[:, 0].mean() - margin[:, 0].mean()) < 15, (
        f"bands don't sample the same surface: {overlap.mean(axis=0)} vs "
        f"{margin.mean(axis=0)}"
    )
    # Blue is what the far instance contributes. Unsorted, the near instance
    # draws first and depth-rejects the far one, leaving the two bands
    # identical (measured 22 vs 22); sorted, the far instance blends through
    # (measured 75 vs 22).
    blue_gain = overlap[:, 2].mean() - margin[:, 2].mean()
    assert blue_gain > 25, (
        f"far transparent instance missing from the blend: {blue_gain=}, "
        f"overlap={overlap.mean(axis=0)}, margin={margin.mean(axis=0)}"
    )
