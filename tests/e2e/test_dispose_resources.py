"""E2E tests for GPU resource disposal when scene objects are removed.

Uses window.__viserTestpoints.rendererInfo to check:
- renderer.info.memory.geometries  (GPU-uploaded buffer geometries)
- renderer.info.memory.textures    (GPU-uploaded textures)
- renderer.info.programs.length    (compiled shader programs)

Strategy: run multiple add/remove cycles and verify that GPU resource counts
do not grow monotonically (which would indicate a leak).

Tests marked "leak" are expected to FAIL on the current codebase because
disposal logic is missing. Tests marked "regression" verify existing correct
disposal and should PASS.
"""

from __future__ import annotations

import numpy as np
from playwright.sync_api import Page

import viser

from .utils import wait_for_scene_node, wait_for_scene_node_removed

# ---------------------------------------------------------------------------
# JS helpers
# ---------------------------------------------------------------------------

JS_GET_MEMORY_INFO = """
() => {
    const tp = window.__viserTestpoints;
    if (!tp || !tp.rendererInfo) return null;
    return {
        geometries: tp.rendererInfo.memory.geometries,
        textures: tp.rendererInfo.memory.textures,
        programs: tp.rendererInfo.programs ? tp.rendererInfo.programs.length : -1,
    };
}
"""


def _get_memory(page: Page) -> dict:
    """Read current GPU memory counts from the renderer."""
    info = page.evaluate(JS_GET_MEMORY_INFO)
    assert info is not None, "window.__viserTestpoints.rendererInfo not available"
    return info


# ---------------------------------------------------------------------------
# Leak tests — these should FAIL on HEAD (missing disposal)
# ---------------------------------------------------------------------------


def test_camera_frustum_filled_geometry_dispose(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a filled camera frustum should free its BufferGeometry.

    BUG: CameraFrustumVariants.tsx creates a BufferGeometry in useMemo
    but never calls dispose() on it. Repeated add/remove cycles leak
    one geometry each time.
    """
    # Let the scene fully initialize.
    viser_page.wait_for_timeout(2000)

    counts = []
    for i in range(3):
        handle = viser_server.scene.add_camera_frustum(
            "/test_frustum_dispose",
            fov=1.0,
            aspect=1.5,
            scale=0.3,
            color=(255, 0, 0),
            variant="filled",
        )
        wait_for_scene_node(viser_page, "/test_frustum_dispose")
        viser_page.wait_for_timeout(500)

        handle.remove()
        wait_for_scene_node_removed(viser_page, "/test_frustum_dispose")
        viser_page.wait_for_timeout(500)

        counts.append(_get_memory(viser_page)["geometries"])

    assert counts[-1] <= counts[0], (
        f"Geometry count grew across add/remove cycles (leak). Counts: {counts}"
    )


def test_grid_material_dispose(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a grid should dispose its custom ShaderMaterial.

    BUG: Grid.tsx creates a ShaderMaterial in useMemo but never calls
    dispose() on unmount. The compiled shader program is never freed.
    """
    viser_page.wait_for_timeout(2000)

    counts = []
    for i in range(3):
        handle = viser_server.scene.add_grid(
            "/test_grid_mat_dispose",
            width=4.0,
            height=4.0,
            plane="xy",
        )
        wait_for_scene_node(viser_page, "/test_grid_mat_dispose")
        viser_page.wait_for_timeout(500)

        handle.remove()
        wait_for_scene_node_removed(viser_page, "/test_grid_mat_dispose")
        viser_page.wait_for_timeout(500)

        counts.append(_get_memory(viser_page)["programs"])

    assert counts[-1] <= counts[0], (
        f"Program count grew across add/remove cycles (leak). Counts: {counts}"
    )


# ---------------------------------------------------------------------------
# Regression tests — these should PASS on HEAD (disposal works)
# ---------------------------------------------------------------------------


def test_line_segments_geometry_dispose(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing line segments should free LineSegmentsGeometry."""
    viser_page.wait_for_timeout(2000)

    points = np.array(
        [
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
            [[0.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        ],
        dtype=np.float32,
    )
    colors = np.array([255, 0, 0], dtype=np.uint8)

    counts = []
    for i in range(3):
        handle = viser_server.scene.add_line_segments(
            "/test_lines_dispose",
            points=points,
            colors=colors,
            line_width=2.0,
        )
        wait_for_scene_node(viser_page, "/test_lines_dispose")
        viser_page.wait_for_timeout(500)

        handle.remove()
        wait_for_scene_node_removed(viser_page, "/test_lines_dispose")
        viser_page.wait_for_timeout(500)

        counts.append(_get_memory(viser_page)["geometries"])

    assert counts[-1] <= counts[0], (
        f"Line geometry leaked across add/remove cycles. Counts: {counts}"
    )


def test_mesh_simple_geometry_dispose(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a simple mesh should free its BufferGeometry."""
    viser_page.wait_for_timeout(2000)

    vertices = np.array(
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.5, 1.0, 0.0]], dtype=np.float32
    )
    faces = np.array([0, 1, 2], dtype=np.uint32)

    counts = []
    for i in range(3):
        handle = viser_server.scene.add_mesh_simple(
            "/test_mesh_dispose",
            vertices=vertices,
            faces=faces,
            color=(128, 128, 255),
        )
        wait_for_scene_node(viser_page, "/test_mesh_dispose")
        viser_page.wait_for_timeout(500)

        handle.remove()
        wait_for_scene_node_removed(viser_page, "/test_mesh_dispose")
        viser_page.wait_for_timeout(500)

        counts.append(_get_memory(viser_page)["geometries"])

    assert counts[-1] <= counts[0], (
        f"Mesh geometry leaked across add/remove cycles. Counts: {counts}"
    )


def test_point_cloud_geometry_dispose(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a point cloud should free its BufferGeometry."""
    viser_page.wait_for_timeout(2000)

    rng = np.random.default_rng(42)
    points = rng.standard_normal((100, 3)).astype(np.float32) * 0.5
    colors = np.clip((points * 128 + 128), 0, 255).astype(np.uint8)

    counts = []
    for i in range(3):
        handle = viser_server.scene.add_point_cloud(
            "/test_points_dispose",
            points=points,
            colors=colors,
            point_size=0.03,
        )
        wait_for_scene_node(viser_page, "/test_points_dispose")
        viser_page.wait_for_timeout(500)

        handle.remove()
        wait_for_scene_node_removed(viser_page, "/test_points_dispose")
        viser_page.wait_for_timeout(500)

        counts.append(_get_memory(viser_page)["geometries"])

    assert counts[-1] <= counts[0], (
        f"Point cloud geometry leaked across add/remove cycles. Counts: {counts}"
    )
