"""E2E tests for scene objects rendering in the Three.js scene graph."""

from __future__ import annotations

import numpy as np
from playwright.sync_api import Page, expect

import viser

from .utils import (
    JS_GET_MESH_CHILD_COUNT,
    JS_GET_SCENE_CHILD_NAMES,
    wait_for_scene_node,
    wait_for_scene_node_hidden,
    wait_for_scene_node_removed,
    wait_for_scene_node_visible,
)


def test_canvas_exists(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """The Three.js canvas should be present after connection."""
    canvas = viser_page.locator("canvas")
    expect(canvas.first).to_be_visible(timeout=5_000)


def test_icosphere_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """An icosphere added on the server should appear in the scene graph."""
    viser_server.scene.add_icosphere(
        "/test_sphere",
        radius=0.5,
        color=(255, 0, 0),
        position=(0.0, 0.0, 0.5),
    )

    wait_for_scene_node(viser_page, "/test_sphere")

    mesh_count = viser_page.evaluate(JS_GET_MESH_CHILD_COUNT, "/test_sphere")
    assert mesh_count > 0, f"Expected mesh children, got {mesh_count}"


def test_box_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A box added on the server should appear in the scene graph."""
    viser_server.scene.add_box(
        "/test_box",
        color=(0, 255, 0),
        dimensions=(1.0, 0.5, 0.3),
        position=(1.0, 0.0, 0.0),
    )

    wait_for_scene_node(viser_page, "/test_box")

    mesh_count = viser_page.evaluate(JS_GET_MESH_CHILD_COUNT, "/test_box")
    assert mesh_count > 0


def test_frame_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A coordinate frame should appear in the scene graph."""
    viser_server.scene.add_frame(
        "/test_frame",
        show_axes=True,
        axes_length=0.5,
        axes_radius=0.02,
        position=(0.0, 1.0, 0.0),
    )

    wait_for_scene_node(viser_page, "/test_frame")


def test_label_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A label added on the server should appear in the scene graph."""
    viser_server.scene.add_label(
        "/test_label",
        text="Hello Label",
        position=(0.0, 0.0, 1.0),
    )

    wait_for_scene_node(viser_page, "/test_label")


def test_multiple_scene_objects(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Multiple scene objects should coexist in the scene graph."""
    viser_server.scene.add_icosphere("/multi/sphere", radius=0.3, position=(0, 0, 0))
    viser_server.scene.add_box(
        "/multi/box", dimensions=(0.5, 0.5, 0.5), position=(1, 0, 0)
    )
    viser_server.scene.add_frame("/multi/frame", show_axes=True, position=(0, 1, 0))
    viser_server.scene.add_label("/multi/label", text="Multi", position=(0, 0, 1))

    expected = ["/multi/sphere", "/multi/box", "/multi/frame", "/multi/label"]
    for name in expected:
        wait_for_scene_node(viser_page, name)

    names = viser_page.evaluate(JS_GET_SCENE_CHILD_NAMES)
    for name in expected:
        assert name in names, f"Node {name} not found in scene. Got: {names}"


def test_scene_node_remove(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Removing a scene node on the server should remove it from the scene graph."""
    handle = viser_server.scene.add_icosphere(
        "/removable_sphere",
        radius=0.3,
        position=(0, 0, 0),
    )

    wait_for_scene_node(viser_page, "/removable_sphere")
    handle.remove()
    wait_for_scene_node_removed(viser_page, "/removable_sphere")


def test_scene_node_visibility(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Toggling visibility on a scene node should update the Three.js object."""
    handle = viser_server.scene.add_icosphere(
        "/vis_sphere",
        radius=0.3,
        position=(0, 0, 0),
    )

    wait_for_scene_node(viser_page, "/vis_sphere")

    handle.visible = False
    wait_for_scene_node_hidden(viser_page, "/vis_sphere")

    handle.visible = True
    wait_for_scene_node_visible(viser_page, "/vis_sphere")


def test_hierarchical_scene_nodes(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """Scene nodes with parent/child paths should form a hierarchy."""
    viser_server.scene.add_frame("/parent", show_axes=True, position=(0, 0, 0))
    viser_server.scene.add_icosphere(
        "/parent/child_sphere", radius=0.2, position=(1, 0, 0)
    )

    wait_for_scene_node(viser_page, "/parent")
    wait_for_scene_node(viser_page, "/parent/child_sphere")

    names = viser_page.evaluate(JS_GET_SCENE_CHILD_NAMES)
    assert "/parent" in names
    assert "/parent/child_sphere" in names


def test_point_cloud_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A point cloud should appear in the scene graph."""
    rng = np.random.default_rng(42)
    points = rng.standard_normal((100, 3)).astype(np.float32) * 0.5
    colors = np.clip((points * 128 + 128), 0, 255).astype(np.uint8)

    viser_server.scene.add_point_cloud(
        "/test_points",
        points=points,
        colors=colors,
        point_size=0.03,
    )

    wait_for_scene_node(viser_page, "/test_points")


def test_grid_in_scene(
    viser_server: viser.ViserServer,
    viser_page: Page,
) -> None:
    """A grid should appear in the scene graph."""
    viser_server.scene.add_grid(
        "/test_grid",
        width=4.0,
        height=4.0,
        plane="xy",
    )

    wait_for_scene_node(viser_page, "/test_grid")
