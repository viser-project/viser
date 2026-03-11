"""E2E tests for advanced scene objects: meshes, frustums, line segments, etc."""

from __future__ import annotations

import math

import numpy as np
from playwright.sync_api import Page

import viser

from .utils import (
    JS_GET_MESH_CHILD_COUNT,
    wait_for_scene_node,
    wait_for_scene_node_hidden,
    wait_for_scene_node_removed,
    wait_for_scene_node_visible,
)

# --- Mesh rendering ---


def test_mesh_simple_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A simple mesh with vertices and faces should appear in the scene graph."""
    vertices = np.array(
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.5, 1.0, 0.0]], dtype=np.float32
    )
    faces = np.array([[0, 1, 2]], dtype=np.uint32)

    viser_server.scene.add_mesh_simple(
        "/test_mesh",
        vertices=vertices,
        faces=faces,
        color=(200, 100, 50),
    )

    wait_for_scene_node(viser_page, "/test_mesh")

    mesh_count = viser_page.evaluate(JS_GET_MESH_CHILD_COUNT, "/test_mesh")
    assert mesh_count > 0, f"Expected mesh children, got {mesh_count}"


def test_mesh_simple_wireframe(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A wireframe mesh should appear in the scene graph."""
    vertices = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], dtype=np.float32)
    faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.uint32)

    viser_server.scene.add_mesh_simple(
        "/test_wireframe_mesh",
        vertices=vertices,
        faces=faces,
        wireframe=True,
        color=(0, 255, 0),
    )

    wait_for_scene_node(viser_page, "/test_wireframe_mesh")


def test_mesh_simple_remove(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a mesh should remove it from the scene graph."""
    vertices = np.array([[0, 0, 0], [1, 0, 0], [0.5, 1, 0]], dtype=np.float32)
    faces = np.array([[0, 1, 2]], dtype=np.uint32)

    handle = viser_server.scene.add_mesh_simple(
        "/removable_mesh",
        vertices=vertices,
        faces=faces,
    )

    wait_for_scene_node(viser_page, "/removable_mesh")
    handle.remove()
    wait_for_scene_node_removed(viser_page, "/removable_mesh")


# --- Camera frustum ---


def test_camera_frustum_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A camera frustum should appear in the scene graph."""
    viser_server.scene.add_camera_frustum(
        "/test_frustum",
        fov=math.radians(60),
        aspect=1.5,
        scale=0.5,
        color=(255, 200, 0),
        position=(0.0, 0.0, 1.0),
    )

    wait_for_scene_node(viser_page, "/test_frustum")


def test_camera_frustum_visibility(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Toggling visibility on a camera frustum should update the Three.js object."""
    handle = viser_server.scene.add_camera_frustum(
        "/vis_frustum",
        fov=math.radians(45),
        aspect=1.0,
        scale=0.3,
    )

    wait_for_scene_node(viser_page, "/vis_frustum")

    handle.visible = False
    wait_for_scene_node_hidden(viser_page, "/vis_frustum")

    handle.visible = True
    wait_for_scene_node_visible(viser_page, "/vis_frustum")


# --- Line segments ---


def test_line_segments_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Line segments should appear in the scene graph."""
    points = np.array(
        [
            [[0, 0, 0], [1, 0, 0]],
            [[0, 0, 0], [0, 1, 0]],
            [[0, 0, 0], [0, 0, 1]],
        ],
        dtype=np.float32,
    )
    colors = np.array(
        [
            [[255, 0, 0], [255, 0, 0]],
            [[0, 255, 0], [0, 255, 0]],
            [[0, 0, 255], [0, 0, 255]],
        ],
        dtype=np.uint8,
    )

    viser_server.scene.add_line_segments(
        "/test_lines",
        points=points,
        colors=colors,
        line_width=2.0,
    )

    wait_for_scene_node(viser_page, "/test_lines")


def test_line_segments_single_color(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Line segments with a single color tuple should render."""
    points = np.array(
        [[[0, 0, 0], [1, 1, 1]], [[1, 1, 1], [2, 0, 0]]],
        dtype=np.float32,
    )

    viser_server.scene.add_line_segments(
        "/test_lines_single_color",
        points=points,
        colors=(255, 128, 0),
    )

    wait_for_scene_node(viser_page, "/test_lines_single_color")


# --- Transform controls ---


def test_transform_controls_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Transform controls should appear in the scene graph."""
    viser_server.scene.add_transform_controls(
        "/test_transform",
        scale=0.5,
        position=(0.0, 0.0, 0.0),
    )

    wait_for_scene_node(viser_page, "/test_transform")


def test_transform_controls_with_options(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Transform controls with specific options should appear in the scene graph."""
    viser_server.scene.add_transform_controls(
        "/test_transform_opts",
        scale=0.3,
        disable_rotations=True,
        active_axes=(True, True, False),
        position=(1.0, 0.0, 0.0),
    )

    wait_for_scene_node(viser_page, "/test_transform_opts")


def test_transform_controls_remove(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing transform controls should remove them from the scene graph."""
    handle = viser_server.scene.add_transform_controls(
        "/removable_transform",
        scale=0.5,
    )

    wait_for_scene_node(viser_page, "/removable_transform")
    handle.remove()
    wait_for_scene_node_removed(viser_page, "/removable_transform")


# --- Spline Catmull-Rom ---


def test_spline_catmull_rom_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A Catmull-Rom spline should appear in the scene graph."""
    points = np.array(
        [[0, 0, 0], [1, 1, 0], [2, 0, 0], [3, 1, 0]],
        dtype=np.float32,
    )

    viser_server.scene.add_spline_catmull_rom(
        "/test_spline",
        points=points,
        tension=0.5,
        line_width=2.0,
        color=(255, 0, 128),
    )

    wait_for_scene_node(viser_page, "/test_spline")


# --- Batched axes ---


def test_batched_axes_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Batched axes should appear in the scene graph."""
    wxyzs = np.array(
        [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]],
        dtype=np.float32,
    )
    positions = np.array(
        [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        dtype=np.float32,
    )

    viser_server.scene.add_batched_axes(
        "/test_batched_axes",
        batched_wxyzs=wxyzs,
        batched_positions=positions,
        axes_length=0.3,
        axes_radius=0.01,
    )

    wait_for_scene_node(viser_page, "/test_batched_axes")
